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
import { blitSegmentRect } from "./segment_layout.js";

// Deadline for all workers to report 'ready'. A non-throwing WASM load failure
// (404 resolving to an HTML page, non-throwing abort) fires no onerror and never
// sends 'ready', so without this bound the view freezes black with no overlay.
// Generous enough for a cold cache on a slow connection.
const INIT_WATCHDOG_MS = 20000;

// Deadline for the per-worker 'booted' ping (module body started, static imports
// resolved). Covers only fetch+evaluate, not the WASM instantiate, so it is far
// tighter than INIT_WATCHDOG_MS; a missing/renamed holosphere_wasm.js trips it.
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
   */
  constructor({ resolutionPresets, appState, getWasmEngine, refreshPixelView,
                getMemoryView }) {
    this._resolutionPresets = resolutionPresets;
    this._appState = appState;
    this._getWasmEngine = getWasmEngine;
    this._refreshPixelView = refreshPixelView;
    this._getMemoryView = getMemoryView;

    this.active = false;
    this.count = 4;
    this.showBoundaries = true;
    // Tracked (not just broadcast) so create() can carry it into a freshly-spawned
    // pool — otherwise a pool re-created while paused would animate under a paused GUI.
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

    // Generation fence. renderGen bumps on every resolution change; renderParallel
    // snapshots it into inflightGen at dispatch. A frame whose snapshot no longer
    // matches renderGen was sized to a stale W/H and must be dropped before the
    // compositor, or its old x1/y1 index past the resized buffer.
    this.renderGen = 0;
    this.inflightGen = 0;

    this.renderInFlight = false;
    this.pendingFrame = false; // true when workers have new results to display
    this.frameComposited = false; // true only on ticks that blit a real composite
                                  // (drives recorder gating)

    // Fault latch. A worker WASM trap / uncaught throw fires onerror but never
    // sends its 'frame', so `pending` never reaches 0 and the loop deadlock-freezes.
    // We latch, settle the in-flight frame, and stop dispatching.
    this.faulted = false;
    /** @type {{ segId: number, message: string } | null} */
    this.faultInfo = null;     // first fault this session

    // Init watchdog: covers the init window, where a non-throwing WASM load failure
    // fires no onerror. Cleared once all workers report 'ready'; if it fires first it
    // latches a fault rather than freezing black.
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._initWatchdog = null;

    // Boot watchdog: every worker pings 'booted' once its module body runs (static
    // imports, incl. the WASM glue, resolved). Not booted by BOOT_WATCHDOG_MS means
    // the module failed to load — usually a missing/renamed holosphere_wasm.js.
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._bootWatchdog = null;

    /** @type {HTMLTableElement | null} */
    this._statsTable = null;
    this._statsSegCount = 0;   // segment count the cached table was built for
    /** @type {{ rows: any[], maxTime: HTMLElement, wallTime: HTMLElement } | null} */
    this._statsCells = null;
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
      // The old pool is already destroyed, so a silent return would leave an
      // active-but-empty controller rendering nothing.
      console.error(`[Segmented] create(${numSegments}) aborted: unknown`
        + ` resolution "${this._appState.get('resolution')}"; controller is now empty.`);
      return;
    }

    // Keep count in sync with the pool so updateStats() and other readers see the
    // live size, not a stale value.
    this.count = numSegments;
    this.workers = [];
    this.results = new Array(numSegments).fill(null);
    this.timings = new Array(numSegments).fill(0);
    this.renderUs = new Array(numSegments).fill(0);
    this.arenas = new Array(numSegments).fill(null);
    this.ready = false;

    let readyCount = 0;
    let bootedCount = 0;

    // Snapshot the main engine's param values so fresh workers build their effect
    // with the user's tuned values, not effect defaults. Ongoing changes still
    // broadcast live via setParameter.
    const initialParams = this._snapshotParams();

    for (let i = 0; i < numSegments; i++) {
      const worker = new Worker('./segment_worker.js', { type: 'module' });

      worker.onmessage = (e) => {
        const msg = /** @type {ControllerInboundMsg} */ (e.data);
        if (msg.type === 'ready') {
          readyCount++;
          if (readyCount === numSegments) {
            this.ready = true;
            this._clearBootWatchdog();
            this._clearInitWatchdog();
            console.log(`[Segmented] All ${numSegments} workers ready`);
          }
        } else if (msg.type === 'booted') {
          // All booted rules out the missing/renamed-glue breakage; retire the boot
          // watchdog and let the init watchdog cover the WASM-instantiate phase.
          bootedCount++;
          if (bootedCount === numSegments) this._clearBootWatchdog();
        } else if (msg.type === 'effectReady') {
          // no action needed
        } else if (msg.type === 'frame') {
          // _onWorkerFault already zeroed `pending`; a late frame from a survived
          // fault would drive it negative. The pool is halted — ignore the frame.
          if (this.faulted) return;
          // segId out of [0, numSegments) is a protocol violation (the controller
          // assigns each segId). Drop without decrementing `pending`.
          if (msg.segId < 0 || msg.segId >= numSegments) {
            console.error(`[Segmented] frame from out-of-range segId ${msg.segId} `
              + `(expected 0..${numSegments - 1}); dropping`);
            return;
          }
          // Drop results from a render dispatched before the last resolution change
          // (their x0..y1 reference the old W/H). Still settle the frame.
          if (this.inflightGen === this.renderGen) {
            this.results[msg.segId] = {
              // msg.pixels was TRANSFERRED (fresh buffer per render), so the
              // controller owns it exclusively; hold the view directly rather than
              // copy, which would defeat the zero-copy transfer.
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

      // A WASM trap or uncaught throw never sends 'frame', so `pending` never reaches
      // 0 and the view freezes. Deliberately no auto-respawn/timeout — a fault is a
      // deterministic bug to fix at the source; settle the in-flight frame, latch the
      // fault, and surface a UI state (see updateStats/tick).
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

    // Any worker not booted by the deadline failed to load its module (commonly a
    // missing/renamed holosphere_wasm.js).
    this._clearBootWatchdog();
    this._bootWatchdog = setTimeout(() => {
      this._bootWatchdog = null;
      if (!this.ready && !this.faulted) {
        this._onWorkerFault(-1,
          `worker module load timed out after ${BOOT_WATCHDOG_MS} ms `
          + `(${bootedCount}/${numSegments} booted) — a worker module likely `
          + `failed to load (commonly a missing or renamed holosphere_wasm.js)`);
      }
    }, BOOT_WATCHDOG_MS);
    if (typeof this._bootWatchdog.unref === 'function') this._bootWatchdog.unref();

    // Not all workers 'ready' by the deadline means a WASM load failed without
    // throwing (no onerror); latch a fault to surface the overlay rather than freeze
    // black.
    this._clearInitWatchdog();
    this._initWatchdog = setTimeout(() => {
      this._initWatchdog = null;
      if (!this.ready && !this.faulted) {
        this._onWorkerFault(-1,
          `worker init timed out after ${INIT_WATCHDOG_MS} ms `
          + `(${readyCount}/${numSegments} ready) — a WASM module likely failed `
          + `to load without throwing`);
      }
    }, INIT_WATCHDOG_MS);
    // Don't let a pending watchdog hold a Node test process open (absent in the
    // browser, where Timeout has no unref()).
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
      // Null the handlers before terminate() to release their captured closures to
      // the GC immediately.
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
    // Settle any in-flight render promise before dropping it so it never leaks
    // unresolved.
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
    // A real fault supersedes the watchdogs; cancel both so they can't fire a
    // second, redundant fault later.
    this._clearBootWatchdog();
    this._clearInitWatchdog();
    if (!this.faulted) {
      this.faulted = true;
      this.faultInfo = { segId, message };
    } else {
      // Still surface a second fault so a cascade is visible, not coalesced.
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
    // A faulted pool is broken until re-created; never fall through to the
    // broadcast below.
    //   - faulted + active: rebuild at the new size (the documented recovery path).
    //     create() reads the new size from appState and runs destroy() first,
    //     which clears the fault latch.
    //   - faulted + inactive: nothing to rebuild; the next create() reads the size
    //     from appState, so the new W/H is not lost.
    if (this.faulted) {
      if (this.active) {
        this.create(this.count);
      }
      return;
    }
    // Open a new generation: any in-flight render (or settled-but-uncomposited
    // result) was sized to the old W/H. Drop settled results and the pending flag
    // here; onmessage's generation check drops in-flight ones as they arrive.
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
      this.inflightGen = this.renderGen; // tag this dispatch's resolution
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
    // Safe to hold dst across the loop: refreshPixelView() re-fetches a detached
    // view, and in segment mode the main engine never renders, so its WASM memory
    // can't grow here and dst can't detach mid-loop.
    this._refreshPixelView();
    const dst = this._getMemoryView();
    if (!dst) return 0;

    // No clear here: driver.render() already zero-filled this buffer, so we only blit
    // quadrants over it. That elision holds only while dst and the buffer
    // driver.render() clears are the same aliased view (Daydream.pixels) — assert it
    // so a future divergence fails loudly rather than compositing onto garbage.
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
      // The generation fence drops stale-resolution results before storing them, so
      // an out-of-bounds rect here means the layout/fence math is broken.
      if (r.x0 < 0 || r.y0 < 0 || r.x1 > w || r.y1 > h) {
        throw new Error(
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is out of bounds for the ` +
          `${w}x${h} display buffer — the generation fence let a stale-resolution ` +
          `result through (layout/fence invariant violated)`);
      }

      blitSegmentRect(dst, r.pixels, w, r, false);
      blitted++;
    }

    // Cyan boundary markers write into the same buffer the recorder captures, so
    // they are BAKED INTO recorded video; the GUI toggle removes them from both.
    if (this.showBoundaries) {
      const yBounds = new Set();
      const xBounds = new Set();
      for (const r of this.results) {
        if (!r) continue;
        // Y does NOT wrap: y0 == 0 is the top canvas edge, not an internal split.
        // X DOES wrap (cylinder): x0 == 0 could be a same-segment wrap, marked below
        // only once the layout is known to be split.
        if (r.y0 > 0) yBounds.add(r.y0);
        if (r.x0 > 0) xBounds.add(r.x0);
      }
      // If x is split at all, the wrap seam at x == 0 (== w) is a genuine boundary.
      if (xBounds.size > 0) xBounds.add(0);

      const plotCyan = (idx) => {
        dst[idx]     = 0;
        dst[idx + 1] = 65535;
        dst[idx + 2] = 65535;
      };

      for (const boundaryY of yBounds) {
        if (boundaryY >= h) continue;
        const rowStart = boundaryY * w * 3;
        for (let x = 0; x < w; x++) plotCyan(rowStart + x * 3);
      }

      for (const boundaryX of xBounds) {
        if (boundaryX >= w) continue;
        for (let y = 0; y < h; y++) plotCyan((y * w + boundaryX) * 3);
      }
    }

    // Report only real segment blits (not boundary markers) so a frame that drew
    // nothing but cyan lines over the cleared buffer still counts as empty.
    return blitted;
  }

  /** Update the per-segment stats overlay. */
  updateStats() {
    const el = document.getElementById('segment-stats');
    if (!el) return;

    const globalStatsDesktop = document.getElementById('global-stats-desktop');
    const globalStatsMobile = document.getElementById('stats-bar');

    if (!this.active) {
      el.style.display = 'none';
      if (globalStatsDesktop) globalStatsDesktop.style.display = '';
      if (globalStatsMobile) globalStatsMobile.style.display = '';
      return;
    }

    if (globalStatsDesktop) globalStatsDesktop.style.display = 'none';
    if (globalStatsMobile) globalStatsMobile.style.display = 'none';
    el.style.display = '';

    // A worker fault froze the pipeline — make it visible. Recovery is a resolution
    // change / mode toggle (re-creates the pool, clearing the latch).
    if (this.faulted) {
      const f = this.faultInfo;
      // Build via text nodes, not innerHTML: the fault message is arbitrary error
      // text and must never be parsed as markup.
      const box = document.createElement('div');
      box.style.cssText = 'color:#ff5252;padding:6px;font-size:0.85em';
      // segId < 0 is a pool-wide fault (e.g. the init watchdog), not one worker.
      const who = !f ? 'worker ?' : (f.segId < 0 ? 'pool init' : `worker ${f.segId}`);
      box.append(`⚠ Segment ${who} faulted — segmented render halted.`);
      box.appendChild(document.createElement('br'));
      const msg = document.createElement('span');
      msg.style.color = '#999';
      msg.textContent = (f && f.message) || 'see console';
      box.appendChild(msg);
      box.appendChild(document.createElement('br'));
      const hint = document.createElement('span');
      hint.style.color = '#999';
      hint.textContent = 'Change resolution or toggle segmented mode to restart.';
      box.appendChild(hint);
      el.replaceChildren(box);
      this._statsTable = null; // force a rebuild on recovery
      return;
    }

    const fmtKB = (x) => (x / 1024).toFixed(1);
    const numSegs = this.count;

    // Build the table once and mutate cell text in place. Rebuild only on a
    // segment-count change or after the fault overlay tore the table down.
    if (!this._statsTable || this._statsSegCount !== numSegs
        || this._statsTable.parentNode !== el) {
      this._buildStatsTable(numSegs, el);
    }

    const cells = this._statsCells;
    // Derive maxTime over the same numSegs span the row loop walks, not the whole
    // timings array, so a stale tail entry can't outrank the live segments.
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
    const table = document.createElement('table');
    const th = (text) => { const e = document.createElement('th'); e.textContent = text; return e; };
    const td = (text, className) => {
      const e = document.createElement('td');
      if (className) e.className = className;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const mkRow = (cells) => {
      const tr = document.createElement('tr');
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
    // Checked BEFORE the ready guard: an init-phase fault latches `faulted` but
    // leaves readyCount short forever, so a ready-first guard would return every tick
    // and the fault overlay would never paint.
    if (this.faulted) {
      // Composites nothing; clear the gate so the recorder doesn't keep capturing the
      // frozen black buffer as fresh content.
      this.frameComposited = false;
      this.updateStats();
      return;
    }

    if (!(this.ready && this.workers.length > 0)) return;

    // 1. Apply the PREVIOUS frame's composite synchronously. Runs AFTER
    //    driver.render() called pixels.fill(0), so it overwrites the clear.
    if (this.pendingFrame) {
      const blitted = this.composite();
      this.updateStats();
      this.pendingFrame = false;
      // A fully-fenced frame composites nothing, leaving the buffer black — only a
      // real frame if at least one rectangle was blitted.
      this.frameComposited = blitted > 0;
    } else {
      // Buffer is still driver.render()'s fill(0) (no first frame yet, or stalled).
      this.frameComposited = false;
    }

    // 2. Dispatch NEXT frame's parallel render (fire-and-forget).
    if (!this.renderInFlight) {
      this.renderInFlight = true;
      this.renderParallel().then(() => {
        // Only arm the compositor if this render's generation is still current. A
        // setResolution() mid-render bumps renderGen and clears pendingFrame; arming
        // unconditionally would re-set it and composite a black frame next tick.
        if (this.inflightGen === this.renderGen) {
          this.pendingFrame = true;
        }
        this.renderInFlight = false;
      });
    }
  }
}
