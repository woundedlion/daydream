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

// Upper bound on how long a freshly-spawned worker pool may take to report all
// 'ready' messages before we treat the init as failed. A worker's init awaits a
// WASM fetch + instantiate; a non-throwing failure (a 404 that resolves to an
// HTML error page, a non-throwing abort) never fires worker.onerror and never
// sends 'ready', so without this bound `ready` would stay false forever and the
// segmented view would freeze black with no fault overlay. Generous enough to
// cover a cold cache loading every worker's module on a slow connection.
const INIT_WATCHDOG_MS = 20000;

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

    // Config
    this.active = false;
    this.count = 4;
    this.showBoundaries = true;
    // Mirror of the host's animations-paused state. Tracked (not just broadcast)
    // so create() can carry it into a freshly-spawned worker pool — otherwise a
    // pool re-created while paused (segment-count change, mode re-toggle) would
    // animate under a paused GUI.
    this._animationsPaused = false;

    // Per-segment data
    /** @type {Worker[]} */
    this.workers = [];        // Web Worker instances
    /** @type {Array<FrameResult | null>} */
    this.results = [];        // per-segment frame results
    /** @type {number[]} */
    this.timings = [];        // ms per segment (worker-measured)
    /** @type {number[]} */
    this.renderUs = [];       // µs rasterization time per segment
    /** @type {Array<SegArenaMetrics | null>} */
    this.arenas = [];         // per-segment arena metrics

    // Frame lifecycle
    this.pending = 0;         // count of outstanding render responses
    this.frameStart = 0;      // wall-clock start of parallel render
    this.wallTime = 0;        // dispatch -> last worker response (ms)
    /** @type {(() => void) | null} */
    this.frameResolve = null; // promise resolve for the current frame
    this.ready = false;       // true once all workers are initialized

    // Generation fence. renderGen bumps on every resolution change; renderParallel
    // snapshots it into inflightGen at dispatch. Worker frame responses carry the
    // bounds of the resolution they were rendered at, so a response whose snapshot
    // no longer matches renderGen references a stale W/H and must be dropped before
    // it reaches the compositor (otherwise its old x1/y1 index past the resized
    // display buffer). Counter-only; no per-pixel cost. No wrap guard is needed
    // (unlike the C++ wrap_t boundary checks): renderGen only increments on a
    // resolution change, and a JS Number represents every integer exactly up to
    // 2^53, so wrap is unreachable within any real session.
    this.renderGen = 0;
    this.inflightGen = 0;

    // Pipeline flags
    this.renderInFlight = false;
    this.pendingFrame = false; // true when workers have new results to display
    this.frameComposited = false; // true only on ticks that blit a real composite
                                  // over the cleared buffer (drives recorder gating)

    // Fault latch. A worker WASM trap / uncaught throw fires onerror but never
    // sends its 'frame', so `pending` would never reach 0 and the whole segmented
    // loop would deadlock-freeze. We latch the fault, settle the in-flight frame
    // to unblock the pipeline, and stop dispatching to a known-broken worker pool.
    this.faulted = false;
    /** @type {{ segId: number, message: string } | null} */
    this.faultInfo = null;     // first fault this session

    // Bounded init watchdog. Distinct from the deliberate no-timeout policy on
    // RENDER faults (which DO fire worker.onerror): this only covers the init
    // window, where a non-throwing WASM load failure produces no signal at all.
    // Armed in create(), cleared once all workers report 'ready' (or on
    // fault/destroy); if it fires first, it latches a fault and paints the
    // overlay instead of freezing black forever.
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._initWatchdog = null;

    // Stats-table DOM cache (populated lazily by _buildStatsTable, mutated in
    // place by updateStats). Declared here so all instance state is visible up
    // front; null until the first build / after a fault tears the table down.
    /** @type {HTMLTableElement | null} */
    this._statsTable = null;
    this._statsSegCount = 0;   // segment count the cached table was built for
    /** @type {{ rows: any[], maxTime: HTMLElement, wallTime: HTMLElement } | null} */
    this._statsCells = null;   // cached cell references updateStats writes to
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
      // The old pool is already destroyed above, so a silent return would leave
      // an active-but-empty controller rendering nothing. This is an invalid
      // config (an unknown resolution key), guarded upstream today — surface it
      // loudly rather than failing dark, matching the component's other guards.
      console.error(`[Segmented] create(${numSegments}) aborted: unknown`
        + ` resolution "${this._appState.get('resolution')}"; controller is now empty.`);
      return;
    }

    // Keep the segment count in sync with the pool we're about to build so
    // updateStats() and any other reader see the live size rather than a stale
    // value carried over from a previous create()/constructor default.
    this.count = numSegments;
    this.workers = [];
    this.results = new Array(numSegments).fill(null);
    this.timings = new Array(numSegments).fill(0);
    this.renderUs = new Array(numSegments).fill(0);
    this.arenas = new Array(numSegments).fill(null);
    this.ready = false;

    let readyCount = 0;

    // Snapshot the main engine's current param values so freshly-spawned (or
    // resized) workers build their effect with the user's tuned values, not the
    // effect defaults. Sent once in the init message; ongoing changes are still
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
            this._clearInitWatchdog();
            console.log(`[Segmented] All ${numSegments} workers ready`);
          }
        } else if (msg.type === 'effectReady') {
          // Worker finished loading effect, no action needed
        } else if (msg.type === 'frame') {
          // A late response from a worker that survived a fault must not run
          // the decrement below: _onWorkerFault already zeroed `pending` and
          // settled the in-flight frame, so decrementing here would drive
          // `pending` negative and quietly falsify its "outstanding responses"
          // invariant. The pool is halted until re-created, so the result is
          // moot — ignore the frame.
          if (this.faulted) return;
          // Drop results from a render dispatched before the last resolution
          // change: their x0..y1 reference the old W/H and would index past the
          // resized display buffer. Still settle the frame so the promise resolves.
          if (this.inflightGen === this.renderGen) {
            this.results[msg.segId] = {
              // msg.pixels arrives as a buffer the worker TRANSFERRED (see
              // segment_worker.js postMessage transfer list), so the controller
              // already owns it exclusively — and the worker allocates a fresh
              // buffer every render, so there's no aliasing across frames. Hold
              // the transferred view directly; a `new Uint16Array(msg.pixels)`
              // copy here would defeat the zero-copy transfer every frame.
              pixels: msg.pixels ?? null,
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

      // Surface worker faults loudly AND keep the pipeline from deadlocking. A
      // WASM trap or uncaught throw inside a segment worker otherwise vanishes
      // silently: the worker never sends its 'frame', so `pending` never reaches
      // 0, `frameResolve` never fires, `renderInFlight` stays true, and the
      // segmented view freezes forever with only a console line. We deliberately
      // do NOT auto-respawn or time out — a worker fault is a deterministic bug
      // to fix at the source, not to mask — but we settle the in-flight frame so
      // the render loop unblocks, latch the fault to stop re-dispatching into a
      // broken pool, and surface a visible UI state (see updateStats/tick).
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

    // Arm the init watchdog: if not every worker has reported 'ready' by the
    // deadline, a worker's WASM load failed without throwing (no onerror), so
    // latch a fault to surface the overlay rather than freeze black forever.
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
    // Don't let a pending watchdog hold a Node test process open; harmless and
    // absent in the browser, where Timeout has no unref().
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

  /**
   * Terminate all workers and reset per-segment, frame-lifecycle, and fault
   * state to empty. Clears the fault latch, so it doubles as the recovery reset
   * create() runs before rebuilding the pool.
   */
  destroy() {
    for (const w of this.workers) {
      // terminate() alone stops the worker and drops its handlers, but null them
      // first to match the dispose discipline elsewhere (and to release the
      // closures the handlers capture for the GC immediately).
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      w.terminate();
    }
    this._clearInitWatchdog();
    this.workers = [];
    this.results = [];
    this.timings = [];
    this.renderUs = [];
    this.arenas = [];
    this.ready = false;
    this.pending = 0;
    // Settle any in-flight render promise before dropping it (mirroring
    // _onWorkerFault) so it never leaks unresolved — a footgun for future
    // awaiters of renderParallel(). The current tick() .then only resets
    // already-reset state, so this is safe today.
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
    // A real fault during the init window supersedes the watchdog; cancel it so
    // it can't fire a second, redundant fault later.
    this._clearInitWatchdog();
    if (!this.faulted) {
      this.faulted = true;
      this.faultInfo = { segId, message };
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
    // A faulted pool is broken until re-created — broadcasting setResolution to
    // dead workers does nothing. When faulted (and active), rebuild the pool at
    // the new size instead: this is the recovery path _onWorkerFault's docstring
    // and the fault overlay's hint both promise for a resolution change.
    // create() reads the new size from appState (already updated when we run)
    // and runs destroy() first, which clears the fault latch.
    if (this.faulted && this.active) {
      this.create(this.count);
      return;
    }
    // Open a new generation: any render still in flight (or a settled result not
    // yet composited) was sized to the old W/H and must not reach the compositor.
    // Drop already-settled results and the pending-composite flag here; the
    // generation check in onmessage drops the in-flight ones as they arrive.
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
        // Measure wall time when the LAST worker responds
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
    // Safe to hold dst across the fill loop below: refreshPixelView() re-fetches
    // the view if a prior memory growth detached it, and in segment mode the main
    // engine never calls drawFrame() (only the workers render), so its WASM
    // linear memory cannot grow here. The fill loop itself makes no WASM calls,
    // so dst cannot detach mid-loop.
    this._refreshPixelView();
    const dst = this._getMemoryView();
    if (!dst) return 0;

    // No clear here: driver.render() already filled this same buffer with zero
    // immediately before invoking the adapter (Daydream.pixels === this view in
    // segment mode — the WASM memory can't grow here, see above), so we only
    // need to blit the quadrants over the pre-cleared background.
    //
    // That elision is load-bearing and structural, not incidental: it holds
    // only while the compositor's view (dst), the buffer driver.render() clears
    // (Daydream.pixels), and the displayed attribute (instanceColor.array) are
    // the one aliased wasmMemoryView. refreshPixelView() points all three at the
    // same view. Assert the part this module can reach — dst === Daydream.pixels
    // — so a future divergence fails loudly here instead of compositing onto an
    // uncleared, garbage background.
    if (dst !== Daydream.pixels) {
      throw new Error(
        "SegmentController.composite: display-buffer alias broken " +
        "(getMemoryView() !== Daydream.pixels) — the cleared background and the " +
        "composite target are different buffers; render()/refreshPixelView() " +
        "aliasing invariant violated");
    }

    const w = Daydream.W;
    const h = Daydream.H;

    // Copy each quadrant's pixel rectangle into the right position
    let blitted = 0;
    for (let s = 0; s < this.results.length; s++) {
      const r = this.results[s];
      if (!r || !r.pixels) continue;
      // A rectangle that doesn't fit the current display buffer must never reach
      // here: the generation fence drops stale-resolution results before they're
      // stored. If one slips through, the layout/fence math is broken — fail
      // loudly like the alias-break above rather than silently dropping a whole
      // segment (which paints a stale/garbage band with no diagnostic). Per-
      // result, not per-pixel — no hot-path cost.
      if (r.x0 < 0 || r.y0 < 0 || r.x1 > w || r.y1 > h) {
        throw new Error(
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is out of bounds for the ` +
          `${w}x${h} display buffer — the generation fence let a stale-resolution ` +
          `result through (layout/fence invariant violated)`);
      }

      // Composite this quad back into the canvas (compact -> canvas); see
      // blitSegmentRect for the contiguous-row fast path.
      blitSegmentRect(dst, r.pixels, w, r, false);
      blitted++;
    }

    // Draw segment boundary lines (cyan markers) on both X and Y splits
    if (this.showBoundaries) {
      // Collect unique Y and X boundaries
      const yBounds = new Set();
      const xBounds = new Set();
      for (const r of this.results) {
        if (!r) continue;
        // Y does NOT wrap (the sphere's poles cap the column), so y0 == 0 is the
        // top canvas edge — never an internal split — and is skipped.
        // X DOES wrap (the sphere is a cylinder in x), so x0 == 0 is collected
        // separately below: on its own it could be a same-segment wrap rather
        // than a boundary, so we only mark it once we know the layout is split.
        if (r.y0 > 0) yBounds.add(r.y0);
        if (r.x0 > 0) xBounds.add(r.x0);
      }
      // If the layout is split in x at all, the wrap seam at x == 0 (== x == w)
      // is a genuine boundary — it's where the last arm meets the first — and
      // must be marked too.
      if (xBounds.size > 0) xBounds.add(0);

      const plotCyan = (idx) => {
        dst[idx]     = 0;     // R
        dst[idx + 1] = 65535; // G (cyan)
        dst[idx + 2] = 65535; // B
      };

      // Horizontal boundary lines (full width)
      for (const boundaryY of yBounds) {
        if (boundaryY >= h) continue;
        const rowStart = boundaryY * w * 3;
        for (let x = 0; x < w; x++) plotCyan(rowStart + x * 3);
      }

      // Vertical boundary lines (full height)
      for (const boundaryX of xBounds) {
        if (boundaryX >= w) continue;
        for (let y = 0; y < h; y++) plotCyan((y * w + boundaryX) * 3);
      }
    }

    // Boundary markers are decoration, not content: report only the count of
    // actual segment blits so a frame that drew nothing but cyan lines over the
    // cleared buffer still counts as empty.
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

    // A worker fault froze the pipeline — make it visible instead of letting the
    // segmented view sit silently stale. Recovery is a resolution change / mode
    // toggle (re-creates the pool, clearing the latch).
    if (this.faulted) {
      const f = this.faultInfo;
      // Build via text nodes, not innerHTML: the worker fault message is
      // arbitrary error text and must never be parsed as markup.
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
      this._statsTable = null; // torn down — force a rebuild on recovery
      return;
    }

    const fmtKB = (x) => (x / 1024).toFixed(1);
    const numSegs = this.count;

    // Build the table once and mutate its cells' text in place. Rebuilding the
    // whole table via innerHTML every composited frame (~16 Hz steady state)
    // churned the DOM for values that mostly don't change shape. Rebuild only
    // when the segment count changes or the table was torn down (the fault
    // overlay above calls replaceChildren and nulls the cache).
    if (!this._statsTable || this._statsSegCount !== numSegs
        || this._statsTable.parentNode !== el) {
      this._buildStatsTable(numSegs, el);
    }

    const cells = this._statsCells;
    // Derive maxTime from the same numSegs span the per-row loop walks, rather
    // than reducing over the whole this.timings array: the two lengths are kept
    // in lockstep by create(), so reading both from numSegs removes the latent
    // drift where a stale tail entry in timings could outrank the live segments.
    // Seeded 0 (timings are durations) so an empty/sub-frame state reads 0, not
    // -Infinity.
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
    // A faulted pool is broken until re-created: keep the visible fault state up
    // and stop dispatching renders that would just deadlock again. Checked BEFORE
    // the ready guard: an init-phase fault (WASM fetch/instantiate failure) latches
    // `faulted` but leaves `readyCount` short of the segment count forever, so a
    // ready-first guard would return early every tick and the fault overlay would
    // never paint — segmented mode would freeze black with console-only diagnostics.
    if (this.faulted) {
      this.updateStats();
      return;
    }

    if (!(this.ready && this.workers.length > 0)) return;

    // 1. Apply the PREVIOUS frame's composite results synchronously. This runs
    //    AFTER driver.render() called pixels.fill(0), so it overwrites the clear.
    if (this.pendingFrame) {
      const blitted = this.composite();
      this.updateStats();
      this.pendingFrame = false;
      // Only mark a real frame if at least one segment rectangle was actually
      // blitted. A fully-fenced frame (every result dropped by the generation
      // fence) composites nothing, leaving the buffer at driver.render()'s
      // fill(0) — the recorder must not capture that black frame.
      this.frameComposited = blitted > 0;
    } else {
      // No new results: the buffer is still driver.render()'s fill(0) (the
      // workers haven't produced the first frame yet, or stalled). The recorder
      // must not capture this cleared/black frame.
      this.frameComposited = false;
    }

    // 2. Dispatch NEXT frame's parallel render (fire-and-forget). Results arrive
    //    async; pendingFrame is set when done.
    if (!this.renderInFlight) {
      this.renderInFlight = true;
      this.renderParallel().then(() => {
        this.pendingFrame = true;
        this.renderInFlight = false;
      });
    }
  }
}
