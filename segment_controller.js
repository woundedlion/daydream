// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * SegmentController — owns the segmented-POV worker pipeline (#15).
 *
 * N Web Workers each load their own isolated WASM module instance and render a
 * quadrant of the canvas in parallel; results are composited into the display
 * buffer. The pipeline is one-frame deep: frame N-1's results are displayed
 * while frame N renders on the workers (frame time = max(segment times), not
 * sum). This is a faithful extraction of the loose module-global state and free
 * functions that previously lived in daydream.js.
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
    // display buffer). Counter-only; no per-pixel cost.
    this.renderGen = 0;
    this.inflightGen = 0;

    // Pipeline flags (were a module global + a render-loop local)
    this.renderInFlight = false;
    this.pendingFrame = false; // true when workers have new results to display

    // Fault latch. A worker WASM trap / uncaught throw fires onerror but never
    // sends its 'frame', so `pending` would never reach 0 and the whole segmented
    // loop would deadlock-freeze. We latch the fault, settle the in-flight frame
    // to unblock the pipeline, and stop dispatching to a known-broken worker pool.
    this.faulted = false;
    /** @type {{ segId: number, message: string } | null} */
    this.faultInfo = null;     // first fault this session
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

  create(numSegments) {
    this.destroy();

    const res = this._resolutionPresets[this._appState.get('resolution')];
    if (!res) return;

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
    // broadcast live via setParameter. Flattened to {name, value} (bools encoded
    // as 1/0) so it survives structured-clone postMessage.
    /** @type {import('./worker_protocol.js').SegParam[]} */
    let initialParams = [];
    const engine = this._getWasmEngine();
    if (engine) {
      const defs = engine.getParameterDefinitions();
      for (let i = 0; i < defs.length; i++) {
        const p = defs[i];
        const v = (typeof p.value === 'boolean') ? (p.value ? 1.0 : 0.0) : p.value;
        initialParams.push({ name: p.name, value: v });
      }
    }

    for (let i = 0; i < numSegments; i++) {
      const worker = new Worker('./segment_worker.js', { type: 'module' });

      worker.onmessage = (e) => {
        const msg = /** @type {ControllerInboundMsg} */ (e.data);
        if (msg.type === 'ready') {
          readyCount++;
          if (readyCount === numSegments) {
            this.ready = true;
            console.log(`[Segmented] All ${numSegments} workers ready`);
          }
        } else if (msg.type === 'effectReady') {
          // Worker finished loading effect, no action needed
        } else if (msg.type === 'frame') {
          // Drop results from a render dispatched before the last resolution
          // change: their x0..y1 reference the old W/H and would index past the
          // resized display buffer. Still settle the frame so the promise resolves.
          if (this.inflightGen === this.renderGen) {
            this.results[msg.segId] = {
              pixels: msg.pixels ? new Uint16Array(msg.pixels) : null,
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
      });

      this.workers.push(worker);
    }

    console.log(`[Segmented] Spawning ${numSegments} workers...`);
  }

  destroy() {
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
    this.results = [];
    this.timings = [];
    this.renderUs = [];
    this.arenas = [];
    this.ready = false;
    this.pending = 0;
    this.frameResolve = null;
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
   */
  _onWorkerFault(segId, message) {
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
   * Tell all workers to set a new effect.
   * @param {string} name
   */
  setEffect(name) {
    this._broadcast({ type: 'setEffect', name });
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
    this._broadcast({ type: 'setAnimationsPaused', paused });
  }

  /**
   * Tell all workers to update resolution.
   * @param {number} w
   * @param {number} h
   */
  setResolution(w, h) {
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
   * Returns a Promise that resolves when all workers have responded.
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

  /** Composite segment results into the display buffer (quadrant model). */
  composite() {
    // Safe to hold dst across the fill loop below: refreshPixelView() re-fetches
    // the view if a prior memory growth detached it, and in segment mode the main
    // engine never calls drawFrame() (only the workers render), so its WASM
    // linear memory cannot grow here. The fill loop itself makes no WASM calls,
    // so dst cannot detach mid-loop.
    this._refreshPixelView();
    const dst = this._getMemoryView();
    if (!dst) return;

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
    for (let s = 0; s < this.results.length; s++) {
      const r = this.results[s];
      if (!r || !r.pixels) continue;
      // Skip any rectangle that doesn't fit the current display buffer. The
      // generation fence should already have dropped stale-resolution results;
      // this is a final guard so a mismatched rect is never partially blitted
      // past the buffer (per-result, not per-pixel — no hot-path cost).
      if (r.x0 < 0 || r.y0 < 0 || r.x1 > w || r.y1 > h) continue;

      let srcIdx = 0;
      for (let y = r.y0; y < r.y1; y++) {
        const dstRowStart = y * w * 3;
        for (let x = r.x0; x < r.x1; x++) {
          const dstIdx = dstRowStart + x * 3;
          dst[dstIdx]     = r.pixels[srcIdx++];
          dst[dstIdx + 1] = r.pixels[srcIdx++];
          dst[dstIdx + 2] = r.pixels[srcIdx++];
        }
      }
    }

    // Draw segment boundary lines (cyan markers) on both X and Y splits
    if (this.showBoundaries) {
      // Collect unique Y and X boundaries
      const yBounds = new Set();
      const xBounds = new Set();
      for (const r of this.results) {
        if (!r) continue;
        if (r.y0 > 0) yBounds.add(r.y0);
        xBounds.add(r.x0);
      }

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
      el.innerHTML = `<div style="color:#ff5252;padding:6px;font-size:0.85em">`
        + `⚠ Segment worker ${f ? f.segId : '?'} faulted — segmented render halted.<br>`
        + `<span style="color:#999">${(f && f.message) || 'see console'}</span><br>`
        + `<span style="color:#999">Change resolution or toggle segmented mode to restart.</span>`
        + `</div>`;
      return;
    }

    const fmtKB = (x) => (x / 1024).toFixed(1);
    const numSegs = this.count;

    let rows = '';
    for (let s = 0; s < numSegs; s++) {
      const r = this.results[s];
      const timing = this.timings[s] || 0;
      const slowClass = timing > SLOW_FRAME_MS ? ' slow' : '';

      // Per-segment arena from worker
      const a = this.arenas[s];
      let arenaStr = '<td>-</td><td>-</td><td>-</td>';
      if (a) {
        arenaStr = `<td>${fmtKB(a.scratch_arena_a.high_water_mark)}</td>`
                 + `<td>${fmtKB(a.scratch_arena_b.high_water_mark)}</td>`
                 + `<td>${fmtKB(a.persistent_arena.usage)}</td>`;
      }

      const rangeStr = r
        ? `x[${r.x0}–${r.x1}] y[${r.y0}–${r.y1}]`
        : '?';

      const renderMs = (this.renderUs[s] || 0) / 1000; // µs → ms for display
      rows += `<tr>`
           + `<td class="seg-label">Seg ${s}</td>`
           + `<td style="color:#555;font-size:0.8em">${rangeStr}</td>`
           + `<td class="seg-time${slowClass}">${timing.toFixed(1)} ms</td>`
           + `<td class="seg-time">${renderMs.toFixed(1)} ms</td>`
           + arenaStr
           + `</tr>`;
    }

    const maxTime = Math.max(...this.timings);
    const wallClass = this.wallTime > SLOW_FRAME_MS ? ' slow' : '';

    el.innerHTML = `<table>`
      + `<tr><th></th><th>Range</th><th>Compute</th><th>Render</th><th>Scr A</th><th>Scr B</th><th>Persist</th></tr>`
      + rows
      + `<tr style="border-top:1px solid #333"><td class="seg-label">max</td><td></td>`
      + `<td class="seg-time">${maxTime.toFixed(1)} ms</td><td></td><td colspan="3"></td></tr>`
      + `<tr><td class="seg-label">wall</td><td></td>`
      + `<td class="seg-time${wallClass}">${this.wallTime.toFixed(1)} ms</td><td></td><td colspan="3"></td></tr>`
      + `</table>`;
  }

  /**
   * Render-loop step (segment mode active): apply the previous frame's composite
   * synchronously, then dispatch the next frame's parallel render fire-and-forget.
   * No-ops while workers are still spawning (matches the prior ready/length guard).
   */
  tick() {
    if (!(this.ready && this.workers.length > 0)) return;

    // A faulted pool is broken until re-created: keep the visible fault state up
    // and stop dispatching renders that would just deadlock again.
    if (this.faulted) {
      this.updateStats();
      return;
    }

    // 1. Apply the PREVIOUS frame's composite results synchronously. This runs
    //    AFTER driver.render() called pixels.fill(0), so it overwrites the clear.
    if (this.pendingFrame) {
      this.composite();
      this.updateStats();
      this.pendingFrame = false;
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
