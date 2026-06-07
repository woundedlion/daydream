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
    this.workers = [];        // Web Worker instances
    this.results = [];        // per-segment frame results
    this.timings = [];        // ms per segment (worker-measured)
    this.renderUs = [];       // µs rasterization time per segment
    this.arenas = [];         // per-segment arena metrics

    // Frame lifecycle
    this.pending = 0;         // count of outstanding render responses
    this.frameStart = 0;      // wall-clock start of parallel render
    this.wallTime = 0;        // dispatch -> last worker response (ms)
    this.frameResolve = null; // promise resolve for the current frame
    this.ready = false;       // true once all workers are initialized

    // Pipeline flags (were a module global + a render-loop local)
    this.renderInFlight = false;
    this.pendingFrame = false; // true when workers have new results to display
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
        const msg = e.data;
        if (msg.type === 'ready') {
          readyCount++;
          if (readyCount === numSegments) {
            this.ready = true;
            console.log(`[Segmented] All ${numSegments} workers ready`);
          }
        } else if (msg.type === 'effectReady') {
          // Worker finished loading effect, no action needed
        } else if (msg.type === 'frame') {
          this.results[msg.segId] = {
            pixels: msg.pixels ? new Uint16Array(msg.pixels) : null,
            x0: msg.x0, x1: msg.x1,
            y0: msg.y0, y1: msg.y1,
            quadW: msg.quadW, quadH: msg.quadH,
          };
          this.timings[msg.segId] = msg.elapsed;
          this.renderUs[msg.segId] = msg.renderUs || 0;
          this.arenas[msg.segId] = msg.arenaMetrics;
          this.pending--;
          if (this.pending === 0 && this.frameResolve) {
            this.frameResolve();
            this.frameResolve = null;
          }
        }
      };

      worker.postMessage({
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
  }

  /** Tell all workers to set a new effect. */
  setEffect(name) {
    for (const w of this.workers) {
      w.postMessage({ type: 'setEffect', name });
    }
  }

  /** Tell all workers to set a parameter. */
  setParameter(name, value) {
    for (const w of this.workers) {
      w.postMessage({ type: 'setParameter', name, value });
    }
  }

  /** Tell all workers to update resolution. */
  setResolution(w, h) {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'setResolution', w, h });
    }
  }

  /**
   * Dispatch parallel render to all workers.
   * Returns a Promise that resolves when all workers have responded.
   */
  renderParallel() {
    return new Promise((resolve) => {
      this.pending = this.workers.length;
      this.frameStart = performance.now();
      this.frameResolve = () => {
        // Measure wall time when the LAST worker responds
        this.wallTime = performance.now() - this.frameStart;
        resolve();
      };
      for (const w of this.workers) {
        w.postMessage({ type: 'render' });
      }
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

    dst.fill(0);

    const w = Daydream.W;
    const h = Daydream.H;

    // Copy each quadrant's pixel rectangle into the right position
    for (let s = 0; s < this.results.length; s++) {
      const r = this.results[s];
      if (!r || !r.pixels) continue;

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

      // Horizontal boundary lines (full width)
      for (const boundaryY of yBounds) {
        if (boundaryY >= h) continue;
        const rowStart = boundaryY * w * 3;
        for (let x = 0; x < w; x++) {
          const idx = rowStart + x * 3;
          dst[idx]     = 0;     // R
          dst[idx + 1] = 65535; // G (cyan)
          dst[idx + 2] = 65535; // B
        }
      }

      // Vertical boundary lines (full height)
      for (const boundaryX of xBounds) {
        if (boundaryX >= w) continue;
        for (let y = 0; y < h; y++) {
          const idx = (y * w + boundaryX) * 3;
          dst[idx]     = 0;     // R
          dst[idx + 1] = 65535; // G (cyan)
          dst[idx + 2] = 65535; // B
        }
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
