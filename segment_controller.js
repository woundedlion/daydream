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
import { PROTOCOL_VERSION } from "./worker_protocol.js";

// Deadline for all workers to report 'ready'. A non-throwing WASM load failure
// fires no onerror and never sends 'ready', so this bound latches a fault instead
// of freezing black.
const INIT_WATCHDOG_MS = 20000;

// Deadline for the per-worker 'booted' ping (fetch+evaluate, not WASM
// instantiate). Sized for a cold-cache/throttled module+glue fetch; a slow WASM
// instantiate is separately bounded by INIT_WATCHDOG_MS.
const BOOT_WATCHDOG_MS = 10000;

// Per-worker liveness deadline for a dispatched parallel render. A worker that
// accepts 'render' but hangs without throwing fires no onerror and never settles
// `pending`, freezing the pipeline; this bound latches a fault instead. It is
// re-armed on every distinct segment 'frame' while `pending > 0`, so it bounds the
// gap between reports rather than the whole render — a legitimately slow effect on
// a throttled GPU keeps extending it as segments land, and only a true stall (no
// segment reports for this long) faults. Sized well above any legitimate frame
// (SLOW_FRAME_MS is the per-frame slow threshold).
const RENDER_WATCHDOG_MS = 8 * SLOW_FRAME_MS;

// Sentinel segIds for pool-wide faults with no single worker to blame: FAULT_POOL
// for a module-load/init timeout, FAULT_RENDER for a render-watchdog timeout. The
// overlay headline distinguishes them.
const FAULT_POOL = -1;
const FAULT_RENDER = -2;

// Bounded auto-retry for a transient worker module-load failure: a bare, message-
// less error Event, which the browser fires when a `{type:'module'}` worker's
// import graph fails to fetch — typically a burst of cold concurrent fetches of the
// large WASM glue racing after the tab's keep-alive connection dropped during idle,
// not a deterministic worker throw. The pool rebuilds a few times with a short
// backoff (the refetch hits a re-warmed cache/connection) before latching a fault,
// so the sim self-heals instead of needing a manual segmented-mode toggle.
export const MAX_BOOT_RETRIES = 3;
const BOOT_RETRY_DELAY_MS = 250;

/**
 * Best-effort prime of the worker module graph's HTTP cache and keep-alive
 * connection before a pool spawn, so the burst of cold concurrent worker fetches
 * after an idle period can't lose the race and abort one worker's load. Awaited on
 * the interactive enable path (the primary trigger); a no-op outside a web origin
 * (e.g. under the file://-based unit tests) and swallows all failures — the boot
 * auto-retry is the actual guarantee, this only lowers the odds.
 * @returns {Promise<void>}
 */
export function warmModules() {
  if (typeof fetch !== 'function') return Promise.resolve();
  let probe;
  try { probe = new URL('./holosphere_wasm.js', import.meta.url); }
  catch { return Promise.resolve(); }
  if (probe.protocol !== 'http:' && probe.protocol !== 'https:') return Promise.resolve();
  const urls = ['./segment_worker.js', './holosphere_wasm.js', './holosphere_wasm.wasm'];
  return Promise.allSettled(
    urls.map((u) => fetch(new URL(u, import.meta.url), { cache: 'force-cache' })),
  ).then(() => {});
}

/** @typedef {import('./worker_protocol.js').WorkerInboundMsg} WorkerInboundMsg */
/** @typedef {import('./worker_protocol.js').ControllerInboundMsg} ControllerInboundMsg */
/** @typedef {import('./worker_protocol.js').SegArenaMetrics} SegArenaMetrics */

/**
 * A composited frame result for one segment, kept across the one-frame pipeline.
 * `pixels` is the segment's RGB16 rectangle ((x1-x0)*(y1-y0)*3), null if absent.
 * @typedef {{
 *   pixels: Uint16Array | null,
 *   x0: number, x1: number, y0: number, y1: number,
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
   * @param {function(Uint16Array): void} [deps.repointDisplayAliases] - Re-points both display aliases (Three.js instanceColor + Daydream.pixels) at the given view; defaults to re-pointing Daydream.pixels only.
   * @param {Document} [deps.statsDoc] - DOM document the stats overlay renders into; defaults to the global `document`.
   */
  constructor({ resolutionPresets, appState, getWasmEngine, refreshPixelView,
                getMemoryView, repointDisplayAliases, statsDoc = globalThis.document }) {
    this.resolutionPresets = resolutionPresets;
    this.appState = appState;
    this.getWasmEngine = getWasmEngine;
    this.refreshPixelView = refreshPixelView;
    this.getMemoryView = getMemoryView;
    this.repointDisplayAliases =
      repointDisplayAliases || ((view) => { Daydream.pixels = view; });
    this.doc = statsDoc;

    this.active = false;
    this.count = 4;
    this.showBoundaries = true;
    // Tracked so create() can carry it into a freshly-spawned pool.
    this.animationsPaused = false;

    /** @type {Worker[]} */
    this.workers = [];
    /** @type {Array<FrameResult | null>} */
    this.results = [];
    /**
     * Staging buffer workers fill during a generation; swapped into `results`
     * only once every segment has reported, so `results` always holds one whole
     * generation and an overrun re-blit never composites a half-updated mix.
     * @type {Array<FrameResult | null>}
     */
    this.scratch = [];
    /** @type {number[]} */
    this.timings = [];        // ms per segment (worker-measured)
    /** @type {number[]} */
    this.renderUs = [];       // µs rasterization time per segment
    /** @type {Array<SegArenaMetrics | null>} */
    this.arenas = [];

    /** @type {number[] | null} */
    this.paramValues = null;  // segment 0's latest param values, for GUI sync

    this.pending = 0;         // count of outstanding render responses
    /** @type {boolean[]} */
    this.frameSeen = [];     // per-segId first-arrival flag, reset each dispatch
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
    this.aliasDivergenceLogged = false; // throttle the composite alias-divergence warning

    // Fault latch: a worker trap fires onerror but never sends its 'frame', so
    // `pending` never reaches 0. Latch, settle the in-flight frame, stop dispatching.
    this.faulted = false;
    /** @type {{ segId: number, message: string } | null} */
    this.faultInfo = null;     // first fault this session

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.initWatchdog = null;

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.bootWatchdog = null;

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.renderWatchdog = null;

    // Bounded transient-module-load recovery; see MAX_BOOT_RETRIES. bootAttempt is
    // this pool's retry index (0 for a user-driven create), carried into the next
    // create() by the retry path.
    this.bootAttempt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.retryTimer = null;

    /** @type {HTMLTableElement | null} */
    this.statsTable = null;
    this.statsSegCount = 0;   // segment count the cached table was built for
    /** @type {{ rows: any[], maxTime: HTMLElement, wallTime: HTMLElement } | null} */
    this.statsCells = null;

    // Cached boundary-overlay seam coordinates, rebuilt only when renderGen bumps
    // (segment geometry is fixed within a generation).
    /** @type {number[]} */
    this.boundaryYs = [];
    /** @type {number[]} */
    this.boundaryXs = [];
    this.boundaryGen = -1;
  }

  /**
   * Post a protocol message to one worker, type-checked against the union the
   * worker accepts (`WorkerInboundMsg`).
   * @param {Worker} worker
   * @param {WorkerInboundMsg} msg
   */
  post(worker, msg) {
    worker.postMessage(msg);
  }

  /**
   * Post the same protocol message to every worker.
   * @param {WorkerInboundMsg} msg
   */
  broadcast(msg) {
    for (const w of this.workers) {
      this.post(w, msg);
    }
  }

  /**
   * Segment 0's most recent post-frame parameter values (ordered to match the
   * effect's param list), or null before the first frame. The GUI reads these in
   * segmented mode since the main-thread engine is never stepped.
   * @returns {number[] | null}
   */
  getParamValues() {
    return this.paramValues;
  }

  /**
   * (Re)build the worker pool at the current resolution: destroy any existing
   * pool, then spawn `numSegments` fresh workers, each loading its own WASM
   * module and initialized with this engine's tuned params and paused state.
   * Aborts loudly (leaving an empty controller) if the resolution key is unknown.
   * @param {number} numSegments
   * @param {number} [bootAttempt] - Retry index; 0 for a user-driven spawn, bumped by the transient-module-load auto-retry.
   */
  create(numSegments, bootAttempt = 0) {
    this.destroy();
    this.bootAttempt = bootAttempt;

    const res = this.resolutionPresets[this.appState.get('resolution')];
    if (!res) {
      console.error(`[Segmented] create(${numSegments}) aborted: unknown`
        + ` resolution "${this.appState.get('resolution')}"; controller is now empty.`);
      return;
    }

    this.count = numSegments;
    this.workers = [];
    this.results = new Array(numSegments).fill(null);
    this.scratch = new Array(numSegments).fill(null);
    this.timings = new Array(numSegments).fill(0);
    this.renderUs = new Array(numSegments).fill(0);
    this.arenas = new Array(numSegments).fill(null);
    this.frameSeen = new Array(numSegments).fill(false);
    this.paramValues = null;
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

    const initialParams = this.snapshotParams();

    for (let i = 0; i < numSegments; i++) {
      const worker = new Worker(new URL('./segment_worker.js', import.meta.url),
        { type: 'module' });

      worker.onmessage = (e) => {
        const msg = /** @type {ControllerInboundMsg} */ (e.data);
        if (msg.type === 'ready') {
          if (!readied[i]) { readied[i] = true; readyCount++; }
          if (readyCount === numSegments) {
            this.ready = true;
            this.clearBootWatchdog();
            this.clearInitWatchdog();
            console.log(`[Segmented] All ${numSegments} workers ready`);
          }
        } else if (msg.type === 'booted') {
          if (msg.version !== PROTOCOL_VERSION) {
            this.onWorkerFault(i, `worker seg ${i} protocol version ${msg.version}`
              + ` != controller ${PROTOCOL_VERSION} (stale cached worker or glue)`);
            return;
          }
          if (!booted[i]) { booted[i] = true; bootedCount++; }
          if (bootedCount === numSegments) this.clearBootWatchdog();
        } else if (msg.type === 'initFailed') {
          this.onWorkerFault(i, `worker seg ${i} init failed: ${msg.reason}`);
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
            // Mirror segment 0's live params for GUI sync, inside the fence so a
            // stale-generation frame can't publish params against a new descriptor
            // list, and only on seg 0's first frame this generation so a doubled
            // 'frame' message can't re-publish.
            if (msg.segId === 0 && msg.paramValues && !this.frameSeen[0])
              this.paramValues = msg.paramValues;
            this.scratch[msg.segId] = {
              pixels: msg.pixels,
              x0: msg.x0, x1: msg.x1,
              y0: msg.y0, y1: msg.y1,
            };
            this.timings[msg.segId] = msg.elapsed;
            this.renderUs[msg.segId] = msg.renderUs || 0;
            this.arenas[msg.segId] = msg.arenaMetrics;
          }
          // Count distinct segments: a worker emitting two 'frame' messages in
          // one generation must not drop pending twice and resolve the barrier early.
          if (this.frameSeen[msg.segId]) return;
          this.frameSeen[msg.segId] = true;
          this.pending--;
          if (this.pending === 0 && this.frameResolve) {
            this.frameResolve();
            this.frameResolve = null;
          } else if (this.pending > 0) {
            this.armRenderWatchdog();
          }
        }
      };

      worker.onerror = (e) => {
        // A message-less error Event before the pool is ready is a module-graph
        // load failure (a plain Event, not an ErrorEvent) — transient, so rebuild
        // a bounded number of times before latching. A messaged error is a real
        // worker throw and still fails fast.
        if (!this.ready && (e == null || e.message == null)
            && this.bootAttempt < MAX_BOOT_RETRIES) {
          const next = this.bootAttempt + 1;
          console.warn(`[Segmented] seg ${i} module failed to load`
            + ` (attempt ${next}/${MAX_BOOT_RETRIES}); rebuilding pool`);
          this.clearBootWatchdog();
          this.clearInitWatchdog();
          this.clearRenderWatchdog();
          this.clearRetryTimer();
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.active) this.create(this.count, next);
          }, BOOT_RETRY_DELAY_MS);
          if (typeof this.retryTimer.unref === 'function') this.retryTimer.unref();
          return;
        }
        const detail = e?.message
          || `module load failed after ${MAX_BOOT_RETRIES} attempts`
             + ` (commonly a missing or renamed holosphere_wasm.js)`;
        console.error(`[Segmented] Worker seg ${i} error: ${detail}`
          + ` (${e?.filename}:${e?.lineno}:${e?.colno})`, e);
        this.onWorkerFault(i, detail);
      };
      worker.onmessageerror = (e) => {
        console.error(`[Segmented] Worker seg ${i} message deserialization`
          + ` failed`, e);
        this.onWorkerFault(i, 'message deserialization failed');
      };

      this.post(worker, {
        type: 'init',
        version: PROTOCOL_VERSION,
        segId: i,
        totalSegs: numSegments,
        w: res.w,
        h: res.h,
        effectName: this.appState.get('effect'),
        params: initialParams,
        paused: this.animationsPaused,
      });

      this.workers.push(worker);
    }

    this.clearBootWatchdog();
    this.bootWatchdog = setTimeout(() => {
      this.bootWatchdog = null;
      if (!this.ready && !this.faulted) {
        const stuck = missing(booted);
        this.onWorkerFault(stuck.length === 1 ? stuck[0] : FAULT_POOL,
          `worker module load timed out after ${BOOT_WATCHDOG_MS} ms `
          + `(${bootedCount}/${numSegments} booted; never booted: `
          + `${stuck.join(', ')}) — a worker module likely `
          + `failed to load (commonly a missing or renamed holosphere_wasm.js)`);
      }
    }, BOOT_WATCHDOG_MS);
    if (typeof this.bootWatchdog.unref === 'function') this.bootWatchdog.unref();

    this.clearInitWatchdog();
    this.initWatchdog = setTimeout(() => {
      this.initWatchdog = null;
      if (!this.ready && !this.faulted) {
        const stuck = missing(readied);
        this.onWorkerFault(stuck.length === 1 ? stuck[0] : FAULT_POOL,
          `worker init timed out after ${INIT_WATCHDOG_MS} ms `
          + `(${readyCount}/${numSegments} ready; never ready: ${stuck.join(', ')}) `
          + `— a WASM module likely failed to load without throwing`);
      }
    }, INIT_WATCHDOG_MS);
    // unref() exists under Node (keep the test process from hanging), not the browser.
    if (typeof this.initWatchdog.unref === 'function') this.initWatchdog.unref();

    console.log(`[Segmented] Spawning ${numSegments} workers...`);
  }

  /** Cancel the init watchdog if one is pending. Idempotent. */
  clearInitWatchdog() {
    if (this.initWatchdog !== null) {
      clearTimeout(this.initWatchdog);
      this.initWatchdog = null;
    }
  }

  /** Cancel the boot watchdog if one is pending. Idempotent. */
  clearBootWatchdog() {
    if (this.bootWatchdog !== null) {
      clearTimeout(this.bootWatchdog);
      this.bootWatchdog = null;
    }
  }

  /** Cancel a pending transient-module-load rebuild if one is scheduled. Idempotent. */
  clearRetryTimer() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** Cancel the render watchdog if one is pending. Idempotent. */
  clearRenderWatchdog() {
    if (this.renderWatchdog !== null) {
      clearTimeout(this.renderWatchdog);
      this.renderWatchdog = null;
    }
  }

  /**
   * (Re)arm the per-worker render-liveness deadline. Called at dispatch and on
   * every distinct segment 'frame' while `pending > 0`, so the deadline bounds the
   * gap between reports; a stall (no segment reports for RENDER_WATCHDOG_MS) faults.
   */
  armRenderWatchdog() {
    this.clearRenderWatchdog();
    this.renderWatchdog = setTimeout(() => {
      this.renderWatchdog = null;
      if (this.pending > 0 && !this.faulted) {
        this.onWorkerFault(FAULT_RENDER,
          `render stalled: no segment reported a frame for ${RENDER_WATCHDOG_MS} ms `
          + `(${this.workers.length - this.pending}/${this.workers.length} `
          + `segments responded) — a worker accepted 'render' but stopped progressing`);
      }
    }, RENDER_WATCHDOG_MS);
    if (typeof this.renderWatchdog.unref === 'function') this.renderWatchdog.unref();
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
    this.clearBootWatchdog();
    this.clearInitWatchdog();
    this.clearRenderWatchdog();
    this.clearRetryTimer();
    this.workers = [];
    this.results = [];
    this.scratch = [];
    this.timings = [];
    this.renderUs = [];
    this.arenas = [];
    this.frameSeen = [];
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
    this.aliasDivergenceLogged = false;
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
  onWorkerFault(segId, message) {
    this.clearBootWatchdog();
    this.clearInitWatchdog();
    this.clearRenderWatchdog();
    this.clearRetryTimer();
    if (!this.faulted) {
      // No auto-restart by design: stay latched until a user-driven resolution/mode
      // change rebuilds the pool, rather than retrying a deterministically-faulting render.
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
  snapshotParams() {
    const engine = this.getWasmEngine();
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
    // Drop the outgoing effect's values so getParamValues() returns null until
    // segment 0 reports the new effect's first frame; otherwise the synchronously
    // rebuilt GUI would bind the new effect's sliders to stale values by index.
    this.paramValues = null;
    // A fresh effect starts running; clear a stale pause so workers spawned for
    // the rebuilt pool don't init paused while the main sphere animates.
    this.animationsPaused = false;
    // A faulted pool is broken until re-created; rebuild (active) re-reads the
    // effect and params from appState rather than broadcasting to dead workers.
    if (this.faulted) {
      if (this.active) this.create(this.count);
      return;
    }
    // Bump the fence so an in-flight old-effect frame fails inflightGen ===
    // renderGen and can't republish its stale-ordered paramValues.
    this.renderGen++;
    // Drop settled/pending old-effect results too; otherwise a completed
    // old-effect frame composites once or re-blits via the overrun branch,
    // flashing the outgoing effect on switch.
    this.results.fill(null);
    this.pendingFrame = false;
    this.broadcast({ type: 'setEffect', name, params: this.snapshotParams() });
  }

  /**
   * Tell all workers to set a parameter.
   * @param {string} name
   * @param {number} value
   */
  setParameter(name, value) {
    if (this.faulted) {
      if (this.active) this.create(this.count);
      return;
    }
    this.broadcast({ type: 'setParameter', name, value });
  }

  /**
   * Tell all workers to pause/resume parameter-driving animations.
   * @param {boolean} paused
   */
  setAnimationsPaused(paused) {
    this.animationsPaused = paused;
    if (this.faulted) {
      if (this.active) this.create(this.count);
      return;
    }
    this.broadcast({ type: 'setAnimationsPaused', paused });
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
    // renderInFlight/pending are left intact: the outstanding old-generation
    // render still owns the in-flight latch and releases it via frameResolve;
    // tick() then dispatches the re-render at the new size. A render that never
    // replies is bounded by renderParallel's watchdog, so a resize during a hung
    // frame faults and recovers rather than wedging the pipeline.
    this.broadcast({ type: 'setResolution', w, h });
  }

  /**
   * Dispatch parallel render to all workers.
   * @returns {Promise<void>} Resolves when all workers have responded (last
   *   response measures wall time), or when the render watchdog latches a fault.
   */
  renderParallel() {
    return new Promise((resolve) => {
      this.inflightGen = this.renderGen;
      this.pending = this.workers.length;
      this.frameSeen.fill(false);
      // Clear the staging buffer so a slot left by a fenced-out prior generation
      // can't survive into this one's published frame.
      this.scratch.fill(null);
      // Clear per-segment stats so a segment fenced out (or silent) this frame
      // reports fresh 0/'-' rather than a prior generation's values.
      this.timings.fill(0);
      this.renderUs.fill(0);
      this.arenas.fill(null);
      this.frameStart = performance.now();
      this.frameResolve = () => {
        this.clearRenderWatchdog();
        this.wallTime = performance.now() - this.frameStart;
        resolve();
      };
      this.broadcast({ type: 'render' });

      this.armRenderWatchdog();
    });
  }

  /**
   * Composite segment results into the display buffer (quadrant model).
   * @returns {number} How many segment rectangles were actually blitted this
   *   call. 0 means either every result was null/empty (a fully-fenced frame),
   *   so the display buffer still holds only driver.render()'s fill(0), or the
   *   pre-pass rejected a segment (out-of-bounds/empty/inverted rect or a
   *   pixel-length mismatch) and latched a fault. The caller uses this to avoid
   *   marking a black buffer as a real composited frame.
   */
  composite() {
    this.refreshPixelView();
    const dst = this.getMemoryView();
    if (!dst) return 0;

    // No clear: driver.render() already zero-filled this buffer; we blit over it.
    // That elision holds only while dst aliases the buffer render() clears. On a
    // divergence, self-heal rather than fault the render loop (mirrors the
    // single-engine path): re-point both display aliases at the composite target.
    // driver.render() re-clears Daydream.pixels next frame, restoring the elision.
    if (dst !== Daydream.pixels) {
      if (!this.aliasDivergenceLogged) {
        console.error(
          "SegmentController.composite: display-buffer alias diverged " +
          "(getMemoryView() !== Daydream.pixels) — re-pointing the display " +
          "aliases at the composite target");
        this.aliasDivergenceLogged = true;
      }
      this.repointDisplayAliases(dst);
    }

    const w = Daydream.W;
    const h = Daydream.H;

    // Iterate the configured segment count (the same source updateStats reads),
    // not results.length, so the two can't drift after a teardown reset.
    const n = this.count;

    // Pre-pass: validate every result before blitting any, so a bad segment faults
    // cleanly (overlay + halt) like a worker fault rather than leaving a partial frame.
    for (let s = 0; s < n; s++) {
      const r = this.results[s];
      if (!r || !r.pixels) continue;
      if (r.x0 < 0 || r.y0 < 0 || r.x1 > w || r.y1 > h) {
        this.onWorkerFault(s,
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is out of bounds for the ` +
          `${w}x${h} display buffer — the generation fence let a stale-resolution ` +
          `result through (layout/fence invariant violated)`);
        return 0;
      }
      if (r.x1 <= r.x0 || r.y1 <= r.y0) {
        this.onWorkerFault(s,
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is empty/inverted — a zero or ` +
          `negative expectedLen would mask layout corruption (segment-rect ` +
          `invariant violated)`);
        return 0;
      }
      const expectedLen = (r.x1 - r.x0) * (r.y1 - r.y0) * 3;
      if (r.pixels.length !== expectedLen) {
        this.onWorkerFault(s,
          `SegmentController.composite: segment ${s} pixel buffer length ` +
          `${r.pixels.length} != expected ${expectedLen} for rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) — a rect/buffer mismatch would ` +
          `blit a truncated row (segment-result invariant violated)`);
        return 0;
      }
    }

    let blitted = 0;
    for (let s = 0; s < n; s++) {
      const r = this.results[s];
      if (!r || !r.pixels) continue;
      compositeSegment(dst, r.pixels, w, r);
      blitted++;
    }

    // Boundary markers write into the recorded buffer, so they are baked into video.
    // Skip on a fully generation-fenced frame (blitted === 0): the buffer is black
    // and stamping seams would show cyan lines on an otherwise-blank sphere.
    if (this.showBoundaries && blitted > 0) {
      if (this.boundaryGen !== this.renderGen) this.rebuildBoundaries();

      const plotCyan = (idx) => {
        dst[idx]     = 0;
        dst[idx + 1] = 65535;
        dst[idx + 2] = 65535;
      };

      for (const boundaryY of this.boundaryYs) {
        if (boundaryY >= h) continue;
        const rowStart = boundaryY * w * 3;
        for (let x = 0; x < w; x++) plotCyan(rowStart + x * 3);
      }

      for (const boundaryX of this.boundaryXs) {
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
  rebuildBoundaries() {
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
    this.boundaryYs = [...yBounds];
    this.boundaryXs = [...xBounds];
    this.boundaryGen = this.renderGen;
  }

  /** Update the per-segment stats overlay. */
  updateStats() {
    const el = this.doc.getElementById('segment-stats');
    if (!el) return;

    const globalStatsDesktop = this.doc.getElementById('global-stats-desktop');
    const globalStatsMobile = this.doc.getElementById('stats-bar');

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
      const box = this.doc.createElement('div');
      box.style.cssText = 'color:#ff5252;padding:6px;font-size:0.85em';
      // segId < 0 is a pool-wide fault, not one worker; FAULT_RENDER is a render
      // timeout, other negatives are pool init/module load.
      const who = !f ? 'worker ?'
        : f.segId === FAULT_RENDER ? 'render timeout'
        : f.segId < 0 ? 'pool init'
        : `worker ${f.segId}`;
      box.append(`⚠ Segment ${who} faulted — segmented render halted.`);
      box.appendChild(this.doc.createElement('br'));
      const msg = this.doc.createElement('span');
      msg.style.color = '#999';
      msg.textContent = (f && f.message) || 'see console';
      box.appendChild(msg);
      box.appendChild(this.doc.createElement('br'));
      const hint = this.doc.createElement('span');
      hint.style.color = '#999';
      hint.textContent = 'Change resolution or toggle segmented mode to restart.';
      box.appendChild(hint);
      el.replaceChildren(box);
      this.statsTable = null; // force a rebuild on recovery
      return;
    }

    const fmtKB = (x) => (x / 1024).toFixed(1);
    const numSegs = this.count;

    // Build the table once; rebuild only on a segment-count change or after the
    // fault overlay tore it down.
    if (!this.statsTable || this.statsSegCount !== numSegs
        || this.statsTable.parentNode !== el) {
      this.buildStatsTable(numSegs, el);
    }

    const cells = this.statsCells;
    // Derive maxTime over numSegs, not the whole timings array, so a stale tail
    // entry can't outrank the live segments.
    let maxTime = 0;
    for (let s = 0; s < numSegs; s++) {
      const r = this.results[s];
      const timing = this.timings[s] || 0;
      if (timing > maxTime) maxTime = timing;
      const c = cells.rows[s];

      c.range.textContent = this.frameSeen[s] && r ? `x[${r.x0}–${r.x1}] y[${r.y0}–${r.y1}]` : '?';
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
  buildStatsTable(numSegs, el) {
    const table = this.doc.createElement('table');
    const th = (text) => { const e = this.doc.createElement('th'); e.textContent = text; return e; };
    const td = (text, className) => {
      const e = this.doc.createElement('td');
      if (className) e.className = className;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const mkRow = (cells) => {
      const tr = this.doc.createElement('tr');
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
    this.statsTable = table;
    this.statsSegCount = numSegs;
    this.statsCells = { rows, maxTime, wallTime };
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
    } else if (this.results.some(r => r && r.pixels)) {
      // Render overran this tick: re-blit the last published frame over driver's
      // clear so the preview holds it instead of flashing black. `results` is only
      // ever swapped whole, so this composites one coherent generation. Not a new
      // frame, so frameComposited stays false — the recorder must not capture a
      // duplicate.
      this.composite();
      this.updateStats();
      this.frameComposited = false;
    } else {
      this.frameComposited = false;
    }

    // composite() can latch a fault via its bounds/length pre-pass; bail before
    // dispatching a render to the just-halted pool.
    if (this.faulted) return;

    if (!this.renderInFlight) {
      this.renderInFlight = true;
      this.renderParallel().then(() => {
        // Publish the fully-assembled generation only if it is still current: a
        // mid-render setResolution() bumps renderGen, and publishing anyway would
        // composite a black or stale-sized frame next tick. The swap makes the
        // completed staging buffer the live one atomically between ticks; the
        // old buffer becomes next generation's scratch.
        if (this.inflightGen === this.renderGen) {
          const done = this.scratch;
          this.scratch = this.results;
          this.results = done;
          this.pendingFrame = true;
        }
        this.renderInFlight = false;
      });
    }
  }
}
