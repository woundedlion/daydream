// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * SegmentController — owns the segmented-POV worker pipeline.
 *
 * N Web Workers each load their own isolated WASM module instance and render a
 * quadrant of the canvas in parallel; results are composited into the display
 * buffer. The pipeline is one-frame deep: frame N-1's results are displayed
 * while frame N renders on the workers (frame time = max(segment times), not
 * sum).
 *
 * The host (daydream.js) owns the main-thread WASM engine and pixel view (both
 * reassignable), so those are injected as lazy getters:
 *   - resolutionPresets:  { name -> {w,h} } resolution table
 *   - appState:           pub/sub state (reads 'resolution' and 'effect')
 *   - getWasmEngine():    current main-thread HolosphereEngine (or null)
 *   - refreshPixelView(): re-fetch the (possibly detached) WASM pixel view
 *   - getMemoryView():    current Uint16Array view of the display buffer
 */
import { Daydream, SLOW_FRAME_MS } from "./driver.js";
import { compositeSegment } from "./segment_layout.js";

// Deadline for all workers to report 'ready'. A non-throwing WASM load failure
// fires no onerror and never sends 'ready', so this bound latches a fault instead
// of freezing black.
const INIT_WATCHDOG_MS = 20000;

// Deadline for the per-worker 'booted' ping (fetch+evaluate, not WASM instantiate).
const BOOT_WATCHDOG_MS = 4000;

/** @typedef {import('./worker_protocol.js').WorkerInboundMsg} WorkerInboundMsg */
/** @typedef {import('./worker_protocol.js').ControllerInboundMsg} ControllerInboundMsg */
/** @typedef {import('./worker_protocol.js').SegArenaMetrics} SegArenaMetrics */

/**
 * A composited frame result for one segment, kept across the one-frame pipeline.
 * `pixels` is the segment's RGB16 rectangle (quadW*quadH*3), null if absent.
 * @typedef {{
 *   pixels: Uint16Array | null,
 *   x0: number, x1: number, y0: number, y1: number,
 *   quadW: number, quadH: number,
 * }} FrameResult
 */

export class SegmentController {
  /**
   * Wire the controller to the host's reassignable engine/view via lazy getters.
   * @param {Object} deps - Host-injected dependencies.
   * @param {Object<string, {w:number, h:number}>} deps.resolutionPresets - Resolution table mapping a preset name to its pixel dimensions.
   * @param {Object} deps.appState - Pub/sub state; reads the 'resolution' and 'effect' keys.
   * @param {function(): (Object|null)} deps.getWasmEngine - Returns the current main-thread HolosphereEngine, or null when none is bound.
   * @param {Function} deps.refreshPixelView - Re-fetches the (possibly detached) WASM pixel view.
   * @param {function(): (Uint16Array|null)} deps.getMemoryView - Returns the current Uint16Array view of the display buffer.
   * @param {Document} [deps.statsDoc] - DOM document the stats overlay renders into; defaults to the global `document`.
   */
  constructor({ resolutionPresets, appState, getWasmEngine, refreshPixelView,
                getMemoryView, statsDoc = globalThis.document }) {
    this._resolutionPresets = resolutionPresets;
    this._appState = appState;
    this._getWasmEngine = getWasmEngine;
    this._refreshPixelView = refreshPixelView;
    this._getMemoryView = getMemoryView;
    this._doc = statsDoc;

    this.active = false;
    this.count = 4;
    this.showBoundaries = true;
    // Tracked so create() can carry it into a freshly-spawned pool.
    this._animationsPaused = false;

    /** @type {Worker[]} */
    this.workers = [];
    /** @type {Array<FrameResult | null>} */
    this.results = [];
    /** @type {number[]} */
    this.timings = [];        // ms per segment (worker-measured)
    /** @type {number[]} */
    this.renderUs = [];       // µs rasterization time per segment
    /** @type {Array<SegArenaMetrics | null>} */
    this.arenas = [];

    this.pending = 0;         // count of outstanding render responses
    this.frameStart = 0;
    this.wallTime = 0;        // dispatch -> last worker response (ms)
    /** @type {(() => void) | null} */
    this.frameResolve = null;
    this.ready = false;

    // Generation fence: renderGen bumps on every resolution change; renderParallel
    // snapshots it into inflightGen at dispatch. A frame whose snapshot no longer
    // matches renderGen was sized to a stale W/H and must be dropped (its x1/y1
    // index past the resized buffer).
    this.renderGen = 0;
    this.inflightGen = 0;

    this.renderInFlight = false;
    this.pendingFrame = false; // true when workers have new results to display
    this.frameComposited = false; // true only on ticks that blit a real composite

    // Fault latch: a worker trap fires onerror but never sends its 'frame', so
    // `pending` never reaches 0. Latch, settle the in-flight frame, stop dispatching.
    this.faulted = false;
    /** @type {{ segId: number, message: string } | null} */
    this.faultInfo = null;     // first fault this session

    /** @type {ReturnType<typeof setTimeout> | null} */
    this._initWatchdog = null;

    /** @type {ReturnType<typeof setTimeout> | null} */
    this._bootWatchdog = null;

    /** @type {HTMLTableElement | null} */
    this._statsTable = null;
    this._statsSegCount = 0;   // segment count the cached table was built for
    /** @type {{ rows: any[], maxTime: HTMLElement, wallTime: HTMLElement } | null} */
    this._statsCells = null;

    // Cached boundary-overlay seam coordinates, rebuilt only when renderGen bumps
    // (segment geometry is fixed within a generation).
    /** @type {number[]} */
    this._boundaryYs = [];
    /** @type {number[]} */
    this._boundaryXs = [];
    this._boundaryGen = -1;
  }

  /**
   * Post a protocol message to one worker, type-checked against the union the
   * worker accepts (`WorkerInboundMsg`).
   * @param {Worker} worker
   * @param {WorkerInboundMsg} msg
   */
  _post(worker, msg) {
    worker.postMessage(msg);
  }

  /**
   * Post the same protocol message to every worker.
   * @param {WorkerInboundMsg} msg
   */
  _broadcast(msg) {
    for (const w of this.workers) {
      this._post(w, msg);
    }
  }

  /**
   * (Re)build the worker pool at the current resolution: destroy any existing
   * pool, then spawn `numSegments` fresh workers, each loading its own WASM
   * module and initialized with this engine's tuned params and paused state.
   * Aborts loudly (leaving an empty controller) if the resolution key is unknown.
   * @param {number} numSegments
   */
  create(numSegments) {
    this.destroy();

    const res = this._resolutionPresets[this._appState.get('resolution')];
    if (!res) {
      console.error(`[Segmented] create(${numSegments}) aborted: unknown`
        + ` resolution "${this._appState.get('resolution')}"; controller is now empty.`);
      return;
    }

    this.count = numSegments;
    this.workers = [];
    this.results = new Array(numSegments).fill(null);
    this.timings = new Array(numSegments).fill(0);
    this.renderUs = new Array(numSegments).fill(0);
    this.arenas = new Array(numSegments).fill(null);
    this.ready = false;

    // Per-index boot/ready state so a watchdog fault names the segments that
    // never reported, not just a count.
    const booted = new Array(numSegments).fill(false);
    const readied = new Array(numSegments).fill(false);
    let readyCount = 0;
    let bootedCount = 0;
    const missing = (state) => {
      const out = [];
      for (let i = 0; i < numSegments; i++) if (!state[i]) out.push(i);
      return out;
    };

    const initialParams = this._snapshotParams();

    for (let i = 0; i < numSegments; i++) {
      const worker = new Worker('./segment_worker.js', { type: 'module' });

      worker.onmessage = (e) => {
        const msg = /** @type {ControllerInboundMsg} */ (e.data);
        if (msg.type === 'ready') {
          if (!readied[i]) { readied[i] = true; readyCount++; }
          if (readyCount === numSegments) {
            this.ready = true;
            this._clearBootWatchdog();
            this._clearInitWatchdog();
            console.log(`[Segmented] All ${numSegments} workers ready`);
          }
        } else if (msg.type === 'booted') {
          if (!booted[i]) { booted[i] = true; bootedCount++; }
          if (bootedCount === numSegments) this._clearBootWatchdog();
        } else if (msg.type === 'effectReady') {
          // no action needed
        } else if (msg.type === 'frame') {
          // A halted pool zeroed `pending`; ignore late frames so it can't go negative.
          if (this.faulted) return;
          if (msg.segId < 0 || msg.segId >= numSegments) {
            console.error(`[Segmented] frame from out-of-range segId ${msg.segId} `
              + `(expected 0..${numSegments - 1}); dropping`);
            return;
          }
          // Generation fence: keep only results from the current resolution; still
          // settle the frame either way.
          if (this.inflightGen === this.renderGen) {
            this.results[msg.segId] = {
              pixels: msg.pixels,
              x0: msg.x0, x1: msg.x1,
              y0: msg.y0, y1: msg.y1,
              quadW: msg.quadW, quadH: msg.quadH,
            };
            this.timings[msg.segId] = msg.elapsed;
            this.renderUs[msg.segId] = msg.renderUs || 0;
            this.arenas[msg.segId] = msg.arenaMetrics;
          }
          this.pending--;
          if (this.pending === 0 && this.frameResolve) {
            this.frameResolve();
            this.frameResolve = null;
          }
        }
      };

      worker.onerror = (e) => {
        console.error(`[Segmented] Worker seg ${i} error: ${e.message}`
          + ` (${e.filename}:${e.lineno}:${e.colno})`, e);
        this._onWorkerFault(i, e.message);
      };
      worker.onmessageerror = (e) => {
        console.error(`[Segmented] Worker seg ${i} message deserialization`
          + ` failed`, e);
        this._onWorkerFault(i, 'message deserialization failed');
      };

      this._post(worker, {
        type: 'init',
        segId: i,
        totalSegs: numSegments,
        w: res.w,
        h: res.h,
        effectName: this._appState.get('effect'),
        params: initialParams,
        paused: this._animationsPaused,
      });

      this.workers.push(worker);
    }

    this._clearBootWatchdog();
    this._bootWatchdog = setTimeout(() => {
      this._bootWatchdog = null;
      if (!this.ready && !this.faulted) {
        const stuck = missing(booted);
        this._onWorkerFault(stuck.length === 1 ? stuck[0] : -1,
          `worker module load timed out after ${BOOT_WATCHDOG_MS} ms `
          + `(${bootedCount}/${numSegments} booted; never booted: `
          + `${stuck.join(', ')}) — a worker module likely `
          + `failed to load (commonly a missing or renamed holosphere_wasm.js)`);
      }
    }, BOOT_WATCHDOG_MS);
    if (typeof this._bootWatchdog.unref === 'function') this._bootWatchdog.unref();

    this._clearInitWatchdog();
    this._initWatchdog = setTimeout(() => {
      this._initWatchdog = null;
      if (!this.ready && !this.faulted) {
        const stuck = missing(readied);
        this._onWorkerFault(stuck.length === 1 ? stuck[0] : -1,
          `worker init timed out after ${INIT_WATCHDOG_MS} ms `
          + `(${readyCount}/${numSegments} ready; never ready: ${stuck.join(', ')}) `
          + `— a WASM module likely failed to load without throwing`);
      }
    }, INIT_WATCHDOG_MS);
    // unref() exists under Node (keep the test process from hanging), not the browser.
    if (typeof this._initWatchdog.unref === 'function') this._initWatchdog.unref();

    console.log(`[Segmented] Spawning ${numSegments} workers...`);
  }

  /** Cancel the init watchdog if one is pending. Idempotent. */
  _clearInitWatchdog() {
    if (this._initWatchdog !== null) {
      clearTimeout(this._initWatchdog);
      this._initWatchdog = null;
    }
  }

  /** Cancel the boot watchdog if one is pending. Idempotent. */
  _clearBootWatchdog() {
    if (this._bootWatchdog !== null) {
      clearTimeout(this._bootWatchdog);
      this._bootWatchdog = null;
    }
  }

  /**
   * Terminate all workers and reset per-segment, frame-lifecycle, and fault
   * state to empty. Clears the fault latch, so it doubles as the recovery reset
   * create() runs before rebuilding the pool.
   */
  destroy() {
    for (const w of this.workers) {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      w.terminate();
    }
    this._clearBootWatchdog();
    this._clearInitWatchdog();
    this.workers = [];
    this.results = [];
    this.timings = [];
    this.renderUs = [];
    this.arenas = [];
    this.ready = false;
    this.pending = 0;
    // Open a new generation before settling: the in-flight render's `.then`
    // resolves on a later microtask, after a fresh pool may exist; bumping here
    // fails its `inflightGen === renderGen` guard so it can't arm the new pool.
    this.renderGen++;
    // Settle any in-flight render promise so it never leaks unresolved.
    if (this.frameResolve) {
      const resolve = this.frameResolve;
      this.frameResolve = null;
      resolve();
    }
    this.renderInFlight = false;
    this.pendingFrame = false;
    this.faulted = false;
    this.faultInfo = null;
  }

  /**
   * Latch a worker fault and break the render-loop deadlock. The faulting worker
   * will never send its 'frame', so we settle the in-flight frame here (resolve
   * its promise, zero `pending`) to release `renderInFlight`; `faulted` then stops
   * `tick()` from dispatching another doomed render. Recovery is by re-creating
   * the pool (resolution change / mode toggle), which clears the latch via
   * destroy(). Only the first fault per session is recorded for the UI.
   * @param {number} segId - Index of the worker segment that faulted.
   * @param {string} message - Human-readable fault message for the UI/console.
   */
  _onWorkerFault(segId, message) {
    this._clearBootWatchdog();
    this._clearInitWatchdog();
    if (!this.faulted) {
      this.faulted = true;
      this.faultInfo = { segId, message };
    } else {
      console.warn(`[Segmented] additional worker fault (seg ${segId}): ${message} `
        + `— first fault already latched, UI shows that one`);
    }
    this.pending = 0;
    this.renderInFlight = false;
    if (this.frameResolve) {
      const resolve = this.frameResolve;
      this.frameResolve = null;
      resolve();
    }
  }

  /**
   * Snapshot the main engine's current tuned parameter values, flattened for
   * structured-clone transport (bools encoded as 1/0). Empty when no engine is
   * bound. Shared by the init message (create) and the effect switch (setEffect),
   * which both need the worker to land on the user's values rather than defaults.
   * @returns {import('./worker_protocol.js').SegParam[]}
   */
  _snapshotParams() {
    const engine = this._getWasmEngine();
    if (!engine) return [];
    const defs = engine.getParameterDefinitions();
    /** @type {import('./worker_protocol.js').SegParam[]} */
    const params = [];
    for (let i = 0; i < defs.length; i++) {
      const p = defs[i];
      const v = (typeof p.value === 'boolean') ? (p.value ? 1.0 : 0.0) : p.value;
      params.push({ name: p.name, value: v });
    }
    return params;
  }

  /**
   * Tell all workers to set a new effect. The worker's engine.setEffect() rebuilds
   * the effect with defaults, so we carry the main engine's current tuned values
   * for the worker to re-apply AFTER the rebuild — the same setEffect-then-params
   * ordering the init path relies on. Without this the segmented view would drop
   * deep-linked / tuned values to defaults on every effect switch.
   * @param {string} name
   */
  setEffect(name) {
    this._broadcast({ type: 'setEffect', name, params: this._snapshotParams() });
  }

  /**
   * Tell all workers to set a parameter.
   * @param {string} name
   * @param {number} value
   */
  setParameter(name, value) {
    this._broadcast({ type: 'setParameter', name, value });
  }

  /**
   * Tell all workers to pause/resume parameter-driving animations.
   * @param {boolean} paused
   */
  setAnimationsPaused(paused) {
    this._animationsPaused = paused;
    this._broadcast({ type: 'setAnimationsPaused', paused });
  }

  /**
   * Tell all workers to update resolution.
   * @param {number} w
   * @param {number} h
   */
  setResolution(w, h) {
    // A faulted pool is broken until re-created; recovery is a rebuild (active) or
    // the next create() (inactive), both of which re-read the size from appState.
    if (this.faulted) {
      if (this.active) {
        this.create(this.count);
      }
      return;
    }
    // Open a new generation: in-flight and settled results were sized to the old
    // W/H. Drop settled results here; onmessage's fence drops in-flight ones.
    this.renderGen++;
    this.results.fill(null);
    this.pendingFrame = false;
    this._broadcast({ type: 'setResolution', w, h });
  }

  /**
   * Dispatch parallel render to all workers.
   * @returns {Promise<void>} Resolves when all workers have responded (last response measures wall time).
   */
  renderParallel() {
    return new Promise((resolve) => {
      this.inflightGen = this.renderGen;
      this.pending = this.workers.length;
      this.frameStart = performance.now();
      this.frameResolve = () => {
        this.wallTime = performance.now() - this.frameStart;
        resolve();
      };
      this._broadcast({ type: 'render' });
    });
  }

  /**
   * Composite segment results into the display buffer (quadrant model).
   * @returns {number} How many segment rectangles were actually blitted this
   *   call. 0 means every result was null/empty (a fully-fenced frame), so the
   *   display buffer still holds only driver.render()'s fill(0) — the caller
   *   uses this to avoid marking a black buffer as a real composited frame.
   */
  composite() {
    this._refreshPixelView();
    const dst = this._getMemoryView();
    if (!dst) return 0;

    // No clear: driver.render() already zero-filled this buffer; we blit over it.
    // That elision holds only while dst aliases the buffer render() clears.
    if (dst !== Daydream.pixels) {
      throw new Error(
        "SegmentController.composite: display-buffer alias broken " +
        "(getMemoryView() !== Daydream.pixels) — the cleared background and the " +
        "composite target are different buffers; render()/refreshPixelView() " +
        "aliasing invariant violated");
    }

    const w = Daydream.W;
    const h = Daydream.H;

    let blitted = 0;
    for (let s = 0; s < this.results.length; s++) {
      const r = this.results[s];
      if (!r || !r.pixels) continue;
      if (r.x0 < 0 || r.y0 < 0 || r.x1 > w || r.y1 > h) {
        throw new Error(
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is out of bounds for the ` +
          `${w}x${h} display buffer — the generation fence let a stale-resolution ` +
          `result through (layout/fence invariant violated)`);
      }

      const expectedLen = (r.x1 - r.x0) * (r.y1 - r.y0) * 3;
      if (r.pixels.length !== expectedLen) {
        throw new Error(
          `SegmentController.composite: segment ${s} pixel buffer length ` +
          `${r.pixels.length} != expected ${expectedLen} for rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) — a rect/buffer mismatch would ` +
          `blit a truncated row (segment-result invariant violated)`);
      }

      compositeSegment(dst, r.pixels, w, r);
      blitted++;
    }

    // Boundary markers write into the recorded buffer, so they are baked into video.
    // Skip on a fully generation-fenced frame (blitted === 0): the buffer is black
    // and stamping seams would show cyan lines on an otherwise-blank sphere.
    if (this.showBoundaries && blitted > 0) {
      if (this._boundaryGen !== this.renderGen) this._rebuildBoundaries();

      const plotCyan = (idx) => {
        dst[idx]     = 0;
        dst[idx + 1] = 65535;
        dst[idx + 2] = 65535;
      };

      for (const boundaryY of this._boundaryYs) {
        if (boundaryY >= h) continue;
        const rowStart = boundaryY * w * 3;
        for (let x = 0; x < w; x++) plotCyan(rowStart + x * 3);
      }

      for (const boundaryX of this._boundaryXs) {
        if (boundaryX >= w) continue;
        for (let y = 0; y < h; y++) plotCyan((y * w + boundaryX) * 3);
      }
    }

    return blitted;
  }

  /**
   * Recompute the cached boundary-overlay seam coordinates from the current
   * layout and stamp them with renderGen. Segment geometry is fixed within a
   * generation, so composite() reuses this cache until the next resolution bump.
   */
  _rebuildBoundaries() {
    const yBounds = new Set();
    const xBounds = new Set();
    for (const r of this.results) {
      if (!r) continue;
      // Y does not wrap (y0 == 0 is the top edge); X wraps on the cylinder, so
      // the x == 0 seam is added below only once the layout is split.
      if (r.y0 > 0) yBounds.add(r.y0);
      if (r.x0 > 0) xBounds.add(r.x0);
    }
    if (xBounds.size > 0) xBounds.add(0);
    this._boundaryYs = [...yBounds];
    this._boundaryXs = [...xBounds];
    this._boundaryGen = this.renderGen;
  }

  /** Update the per-segment stats overlay. */
  updateStats() {
    const el = this._doc.getElementById('segment-stats');
    if (!el) return;

    const globalStatsDesktop = this._doc.getElementById('global-stats-desktop');
    const globalStatsMobile = this._doc.getElementById('stats-bar');

    if (!this.active) {
      el.style.display = 'none';
      if (globalStatsDesktop) globalStatsDesktop.style.display = '';
      if (globalStatsMobile) globalStatsMobile.style.display = '';
      return;
    }

    if (globalStatsDesktop) globalStatsDesktop.style.display = 'none';
    if (globalStatsMobile) globalStatsMobile.style.display = 'none';
    el.style.display = '';

    if (this.faulted) {
      const f = this.faultInfo;
      // Build via text nodes, not innerHTML: the fault message is arbitrary text
      // and must never be parsed as markup.
      const box = this._doc.createElement('div');
      box.style.cssText = 'color:#ff5252;padding:6px;font-size:0.85em';
      // segId < 0 is a pool-wide fault (e.g. the init watchdog), not one worker.
      const who = !f ? 'worker ?' : (f.segId < 0 ? 'pool init' : `worker ${f.segId}`);
      box.append(`⚠ Segment ${who} faulted — segmented render halted.`);
      box.appendChild(this._doc.createElement('br'));
      const msg = this._doc.createElement('span');
      msg.style.color = '#999';
      msg.textContent = (f && f.message) || 'see console';
      box.appendChild(msg);
      box.appendChild(this._doc.createElement('br'));
      const hint = this._doc.createElement('span');
      hint.style.color = '#999';
      hint.textContent = 'Change resolution or toggle segmented mode to restart.';
      box.appendChild(hint);
      el.replaceChildren(box);
      this._statsTable = null; // force a rebuild on recovery
      return;
    }

    const fmtKB = (x) => (x / 1024).toFixed(1);
    const numSegs = this.count;

    // Build the table once; rebuild only on a segment-count change or after the
    // fault overlay tore it down.
    if (!this._statsTable || this._statsSegCount !== numSegs
        || this._statsTable.parentNode !== el) {
      this._buildStatsTable(numSegs, el);
    }

    const cells = this._statsCells;
    // Derive maxTime over numSegs, not the whole timings array, so a stale tail
    // entry can't outrank the live segments.
    let maxTime = 0;
    for (let s = 0; s < numSegs; s++) {
      const r = this.results[s];
      const timing = this.timings[s] || 0;
      if (timing > maxTime) maxTime = timing;
      const c = cells.rows[s];

      c.range.textContent = r ? `x[${r.x0}–${r.x1}] y[${r.y0}–${r.y1}]` : '?';
      c.compute.textContent = `${timing.toFixed(1)} ms`;
      c.compute.className = timing > SLOW_FRAME_MS ? 'seg-time slow' : 'seg-time';
      c.render.textContent = `${((this.renderUs[s] || 0) / 1000).toFixed(1)} ms`;

      const a = this.arenas[s];
      c.scrA.textContent = a ? fmtKB(a.scratch_arena_a.high_water_mark) : '-';
      c.scrB.textContent = a ? fmtKB(a.scratch_arena_b.high_water_mark) : '-';
      c.persist.textContent = a ? fmtKB(a.persistent_arena.usage) : '-';
    }

    cells.maxTime.textContent = `${maxTime.toFixed(1)} ms`;
    cells.wallTime.textContent = `${this.wallTime.toFixed(1)} ms`;
    cells.wallTime.className = this.wallTime > SLOW_FRAME_MS ? 'seg-time slow' : 'seg-time';
  }

  /**
   * (Re)build the stats-table DOM and cache references to the cells updateStats
   * mutates each frame, so the steady-state path is textContent writes rather
   * than an innerHTML re-parse.
   * @param {number} numSegs - Number of segment rows to build.
   * @param {HTMLElement} el - Container element the table is mounted into.
   */
  _buildStatsTable(numSegs, el) {
    const table = this._doc.createElement('table');
    const th = (text) => { const e = this._doc.createElement('th'); e.textContent = text; return e; };
    const td = (text, className) => {
      const e = this._doc.createElement('td');
      if (className) e.className = className;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const mkRow = (cells) => {
      const tr = this._doc.createElement('tr');
      for (const c of cells) tr.appendChild(c);
      table.appendChild(tr);
      return tr;
    };
    const spanCell = () => { const e = td(''); e.colSpan = 3; return e; };

    mkRow([th(''), th('Range'), th('Compute'), th('Render'),
           th('Scr A'), th('Scr B'), th('Persist')]);

    const rows = [];
    for (let s = 0; s < numSegs; s++) {
      const range = td('');
      range.style.cssText = 'color:#555;font-size:0.8em';
      const compute = td('', 'seg-time');
      const render = td('', 'seg-time');
      const scrA = td('-');
      const scrB = td('-');
      const persist = td('-');
      mkRow([td(`Seg ${s}`, 'seg-label'), range, compute, render, scrA, scrB, persist]);
      rows.push({ range, compute, render, scrA, scrB, persist });
    }

    const maxTime = td('', 'seg-time');
    const maxRow = mkRow([td('max', 'seg-label'), td(''), maxTime, td(''), spanCell()]);
    maxRow.style.borderTop = '1px solid #333';

    const wallTime = td('', 'seg-time');
    mkRow([td('wall', 'seg-label'), td(''), wallTime, td(''), spanCell()]);

    el.replaceChildren(table);
    this._statsTable = table;
    this._statsSegCount = numSegs;
    this._statsCells = { rows, maxTime, wallTime };
  }

  /**
   * Render-loop step (segment mode active): apply the previous frame's composite
   * synchronously, then dispatch the next frame's parallel render fire-and-forget.
   * No-ops while workers are still spawning.
   */
  tick() {
    // Checked before the ready guard: an init-phase fault latches `faulted` but
    // leaves readyCount short forever, so a ready-first guard would never paint the
    // fault overlay.
    if (this.faulted) {
      this.frameComposited = false;
      this.updateStats();
      return;
    }

    if (!(this.ready && this.workers.length > 0)) return;

    // Apply the previous frame's composite synchronously, over driver.render()'s clear.
    if (this.pendingFrame) {
      const blitted = this.composite();
      this.updateStats();
      this.pendingFrame = false;
      this.frameComposited = blitted > 0;
    } else {
      this.frameComposited = false;
    }

    if (!this.renderInFlight) {
      this.renderInFlight = true;
      this.renderParallel().then(() => {
        // Arm the compositor only if this render's generation is still current: a
        // mid-render setResolution() bumps renderGen, and arming anyway would
        // composite a black frame next tick.
        if (this.inflightGen === this.renderGen) {
          this.pendingFrame = true;
        }
        this.renderInFlight = false;
      });
    }
  }
}
