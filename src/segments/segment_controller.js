// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * SegmentController — owns the segmented-POV worker pipeline. Each Web Worker
 * runs its own WASM engine and renders one segment rectangle; results are
 * composited one frame deep (frame N-1 displays while frame N renders).
 */
import { callWorkbenchBinding } from '../engine/workbench_bindings.js';
import { acceptedParamValue, engineParamValue } from '../effects/param_sync.js';
import {
  isValidSegmentCount,
} from "./segment_layout.js";
import { SegmentCompositor } from "./segment_compositor.js";
import { isViewLive } from "../renderer/pixel_view.js";
import { pageWarmer } from "./module_warmer.js";
import { SegmentStatsView } from "../ui/segment_stats_view.js";
import { FAULT_POOL, FAULT_RENDER, PROTOCOL_VERSION } from "./worker_protocol.js";
import { errorDetail } from "../shared/banner.js";
import { SEGMENT_COUNT_MAX } from "./segment_policy.js";

export const SEGMENT_CONTROLLER_API_VERSION = 3;

// Deadline for all workers to report 'ready'; a non-throwing WASM load failure
// fires no onerror and never sends 'ready'.
export const INIT_WATCHDOG_MS = 20000;

// Deadline for the per-worker 'booted' ping (fetch+evaluate, not WASM
// instantiate).
export const BOOT_WATCHDOG_MS = 10000;

// Pool-wide render-liveness deadline: the longest gap between segment 'frame'
// reports while `pending > 0`, not the whole render.
export const RENDER_WATCHDOG_MS = 5000;

// Pre-ready pool rebuilds for a message-less worker error Event or a rejected
// shared module: at most MAX_BOOT_RETRIES, BOOT_RETRY_DELAY_MS apart.
export const MAX_BOOT_RETRIES = 3;
export const BOOT_RETRY_DELAY_MS = 250;

// Effect-switch rebuild budget resets at ready; resolution and mode changes can restart it.
export const MAX_FAULTED_REBUILDS = 2;

/**
 * Release a pending timer's hold on the Node event loop. No-op in browsers.
 * @param {ReturnType<typeof setTimeout>} timer - Handle returned by setTimeout.
 * @returns {void}
 */
function unrefTimer(timer) {
  const nodeTimer = /** @type {{unref?: () => void}} */ (
    /** @type {unknown} */ (timer));
  nodeTimer.unref?.();
}

/**
 * A controller field holding a pending setTimeout handle, or null.
 * @typedef {'initWatchdog'|'bootWatchdog'|'renderWatchdog'|'retryTimer'} TimerField
 */

/**
 * Every deadline the controller arms, cleared as a set on teardown and on fault.
 * @type {TimerField[]}
 */
const ALL_TIMERS = ['initWatchdog', 'bootWatchdog', 'renderWatchdog', 'retryTimer'];

/** @typedef {import('./worker_protocol.js').WorkerInboundMsg} WorkerInboundMsg */
/** @typedef {import('./worker_protocol.js').ControllerInboundMsg} ControllerInboundMsg */
/** @typedef {import('./worker_protocol.js').SegArenaMetrics} SegArenaMetrics */

/** @typedef {import('./segment_compositor.js').FrameResult} FrameResult */

export class SegmentController {
  /** Backing store for the `active` accessor pair. */
  #active = false;

  /** Backing store for the `showBoundaries` accessor pair. */
  #showBoundaries = false;

  /** @type {Array<FrameResult | null>} */
  #results = [];

  /**
   * Staging buffer workers fill during a generation; swapped into `#results`
   * once every segment has reported, so `#results` holds one whole generation.
   * @type {Array<FrameResult | null>}
   */
  #scratch = [];

  /** ms per segment (worker-measured). @type {number[]} */
  #timings = [];

  /** @type {Array<SegArenaMetrics | null>} */
  #arenas = [];

  /**
   * Per-segment clip disposition of the last reported frame: true when that
   * worker's effect reports needs_full_frame() || persists_pixels() and it
   * shaded the whole canvas instead of its band.
   * @type {boolean[]}
   */
  #fullFrames = [];

  /**
   * Per-segment divergence notices from the last reported frame (a parameter
   * or preset the worker's engine refused); null where the segment reported none.
   * @type {Array<string[] | null>}
   */
  #warnings = [];

  /** Count of outstanding render responses. */
  #pending = 0;

  /** Per-segId first-arrival flag, reset each dispatch. @type {boolean[]} */
  #frameSeen = [];

  #frameStart = 0;

  /** Dispatch -> last worker response (ms). */
  #wallTime = 0;

  /** @type {(() => void) | null} */
  #frameResolve = null;

  #ready = false;

  /**
   * Generation fence: bumped whenever in-flight results stop being publishable.
   * renderParallel snapshots it into #inflightGen at dispatch; a frame whose
   * snapshot no longer matches is dropped.
   */
  #renderGen = 0;

  #inflightGen = 0;

  #renderInFlight = false;

  /** True when workers have new results to display. */
  #pendingFrame = false;

  /** A newly blitted composite awaiting consumption by the render adapter. */
  #frameComposited = false;

  /**
   * Wire the controller to the host's reassignable engine/view via lazy getters.
   * @param {Object} deps - Host-injected dependencies.
   * @param {Object<string, {w:number, h:number}>} deps.resolutionPresets - Resolution table mapping a preset name to its pixel dimensions.
   * @param {{get: (key: string) => any}} deps.appState - Read-only view of the host's pub/sub state; reads the 'resolution' and 'effect' keys.
   * @param {{paused?: boolean, W: number, H: number, pixels: Uint16Array|null, dotMesh: {instanceColor: {array: Uint16Array|null, needsUpdate: boolean}}|null, invalidate: () => void}} deps.driver - Renderer instance owning the live pixel grid (W/H), the display buffer, and the dot mesh carrying the second display alias.
   * @param {() => (import('../../generated/holosphere_wasm.js').HolosphereEngine|null)} deps.getWasmEngine - Returns the current main-thread HolosphereEngine, or null when none is bound.
   * @param {() => unknown} deps.refreshPixelView - Re-fetches the (possibly detached) WASM pixel view, reporting `true` when it fetched a fresh one.
   * @param {() => (Uint16Array|null)} deps.getMemoryView - Returns the current Uint16Array view of the display buffer.
   * @param {(view: Uint16Array) => void} deps.repointDisplayAliases - Re-points BOTH display aliases (Three.js instanceColor.array + driver.pixels) at the given view.
   * @param {(view: Uint16Array) => boolean} deps.displayAliasesDiverged - Reports whether either display alias has stopped referencing the given view.
   * @param {(message: string) => void} [deps.onFault] - Reports the first fault since the pool was (re)built.
   * @param {Document} [deps.statsDoc] - DOM document the stats overlay renders into; defaults to the global `document`.
   * @param {import('./module_warmer.js').ModuleWarmer} [deps.moduleWarmer] - Warmer whose held compilation spawned workers reuse; defaults to the page's.
   * @throws {TypeError} When repointDisplayAliases or displayAliasesDiverged is
   *   not a function.
   */
  constructor({ resolutionPresets, appState, driver, getWasmEngine, refreshPixelView,
                getMemoryView, repointDisplayAliases, displayAliasesDiverged,
                statsDoc, moduleWarmer = pageWarmer, onFault = () => {} }) {
    if (typeof repointDisplayAliases !== 'function') {
      throw new TypeError('SegmentController: repointDisplayAliases is required '
        + 'and must be a function that re-points both display aliases');
    }
    if (typeof displayAliasesDiverged !== 'function') {
      throw new TypeError('SegmentController: displayAliasesDiverged is required '
        + 'and must be a function that reports on both display aliases');
    }
    this.resolutionPresets = resolutionPresets;
    this.appState = appState;
    this.driver = driver;
    this.getWasmEngine = getWasmEngine;
    this.compositor = new SegmentCompositor({
      driver, refreshPixelView, getMemoryView, repointDisplayAliases, displayAliasesDiverged,
      onFault: (segment, message) => this.onWorkerFault(segment, message),
    });
    this.moduleWarmer = moduleWarmer;
    this.onFault = onFault;
    /** @type {SegmentStatsView} */
    this.statsView = new SegmentStatsView(statsDoc);

    // Last legal segment count create() accepted, reused by a rebuild. Matches the
    // per-segment array lengths only while a pool stands.
    this.count = 4;
    // Carried into a freshly-spawned pool.
    this.animationsPaused = false;
    // Near-pole azimuthal decimation; per engine instance, so re-seeded into
    // every rebuilt pool.
    this.poleLod = 0;
    this.topCap = 0;
    this.bottomCap = 0;

    /** @type {Worker[]} */
    this.workers = [];
    /** @type {number[] | null} */
    this.paramValues = null;  // segment 0's latest param values, for GUI sync
    this.paramRevision = 0;
    this.presetRevision = 0;
    /** @type {number | null} */
    this.presetCount = null;
    /** @type {number | null} */
    this.presetIndex = null;

    // Fault latch: a trapped worker never sends its 'frame', so `pending` never
    // reaches 0.
    this.faulted = false;
    /** @type {{ segId: number, message: string } | null} */
    this.faultInfo = null;     // first fault since the pool was (re)built
    // Effect-switch rebuilds of a faulted pool since the last pool reached ready.
    // Survives destroy(), which every create() runs first.
    this.faultedRebuilds = 0;

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.initWatchdog = null;

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.bootWatchdog = null;

    /** @type {ReturnType<typeof setTimeout> | null} */
    this.renderWatchdog = null;

    // This pool's transient-module-load retry index (0 for a user-driven create).
    this.bootAttempt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.retryTimer = null;

  }

  /**
   * Whether a newly composited generation is awaiting capture consumption.
   * @returns {boolean}
   */
  get frameComposited() {
    return this.#frameComposited;
  }

  /** @returns {boolean} Whether a newly composited frame is owed a capture. */
  consumeCapture() {
    const pending = this.#frameComposited;
    this.#frameComposited = false;
    return pending;
  }

  /**
   * The frame-lifecycle and fence state, for tests and diagnostics. The
   * per-segment arrays are the controller's own, refilled in place as segment
   * frames land, so a caller must read them synchronously and retain none.
   * @returns {{ready: boolean, pending: number, renderGen: number,
   *   inflightGen: number, renderInFlight: boolean, pendingFrame: boolean,
   *   frameComposited: boolean, frameSettled: boolean, wallTime: number,
   *   results: Array<FrameResult | null>, scratch: Array<FrameResult | null>,
   *   timings: number[], arenas: Array<SegArenaMetrics | null>,
   *   fullFrames: boolean[], warnings: Array<string[] | null>,
   *   frameSeen: boolean[]}}
   */
  get frameState() {
    return {
      ready: this.#ready,
      pending: this.#pending,
      renderGen: this.#renderGen,
      inflightGen: this.#inflightGen,
      renderInFlight: this.#renderInFlight,
      pendingFrame: this.#pendingFrame,
      frameComposited: this.#frameComposited,
      frameSettled: this.#frameResolve === null,
      wallTime: this.#wallTime,
      results: this.#results,
      scratch: this.#scratch,
      timings: this.#timings,
      arenas: this.#arenas,
      fullFrames: this.#fullFrames,
      warnings: this.#warnings,
      frameSeen: this.#frameSeen,
    };
  }

  /** @returns {boolean} Whether segment boundaries are drawn. */
  get showBoundaries() {
    return this.#showBoundaries;
  }

  /**
   * Re-composite the published generation after changing the boundary overlay.
   * @param {boolean} show - Whether segment boundaries are drawn.
   */
  set showBoundaries(show) {
    const next = Boolean(show);
    if (next === this.#showBoundaries) return;
    this.#showBoundaries = next;
    // Outside segmented mode the pool owns no display buffer. A latched pool
    // keeps `ready`, so `faulted` is checked separately.
    if (this.active && this.#ready && !this.faulted && this.hasPublishedFrame()) {
      this.composite(this.#results);
      // No simulation tick stands behind this composite; Three re-uploads the
      // instance colours only on a version bump.
      const instanceColor = this.driver.dotMesh?.instanceColor;
      if (instanceColor && isViewLive(instanceColor.array))
        instanceColor.needsUpdate = true;
    }
    this.driver.invalidate();
  }

  /**
   * Whether segmented mode is on (host-written). Stays true across a fault so
   * a user-driven setEffect/setResolution can rebuild the latched pool.
   * @returns {boolean} True while segmented mode is on.
   */
  get active() {
    return this.#active;
  }

  /**
   * Turn segmented mode on or off. Write it before awaiting or tearing anything
   * down: true before awaiting warmModules(), false before destroy(), so an
   * in-flight warm continuation re-checks it after its await. Turning it off
   * repaints the stats overlay.
   * @param {boolean} on - Whether segmented mode is on.
   * @throws {TypeError} When `on` is not a boolean.
   */
  set active(on) {
    if (typeof on !== 'boolean') {
      throw new TypeError('SegmentController.active must be a boolean, got '
        + `${typeof on}`);
    }
    this.#active = on;
    if (!on) {
      this.faultedRebuilds = 0;
      this.updateStats();
    }
  }

  /**
   * Post a protocol message to one worker, type-checked against the union the
   * worker accepts (`WorkerInboundMsg`).
   * @param {Worker} worker
   * @param {WorkerInboundMsg} msg
   * @param {Transferable[]} [transfer] - Objects to hand ownership of to the worker (zero-copy).
   */
  post(worker, msg, transfer) {
    if (transfer) worker.postMessage(msg, transfer);
    else worker.postMessage(msg);
  }

  /**
   * Post the same protocol message to every worker.
   * @details A postMessage that throws latches a fault, terminating the pool.
   * @param {WorkerInboundMsg} msg
   * @returns {boolean} True when every worker accepted the message.
   */
  broadcast(msg) {
    for (let s = 0; s < this.workers.length; s++) {
      try {
        this.post(this.workers[s], msg);
      } catch (error) {
        this.onWorkerFault(s, `broadcast of '${msg.type}' to seg ${s} failed: `
          + errorDetail(error));
        return false;
      }
    }
    return true;
  }

  /**
   * Segment 0's most recent post-frame parameter values (ordered to match the
   * effect's param list), or null before the first frame.
   * @returns {number[] | null}
   */
  getParamValues() {
    return this.paramValues;
  }

  /**
   * Number of presets the current effect exposes, mirrored from segment 0's
   * frames (seeded from the main engine at pool creation), or null when no
   * engine has reported one.
   * @returns {number | null}
   */
  getPresetCount() {
    return this.presetCount;
  }

  /**
   * The preset the pool is currently on, mirrored from segment 0's frames
   * (seeded from the main engine at pool creation), or null when no engine has
   * reported one.
   * @returns {number | null}
   */
  getPresetIndex() {
    return this.presetIndex;
  }

  /**
   * Refresh preset metadata from the main engine.
   * @returns {void}
   */
  refreshPresetState() {
    const mainEngine = this.getWasmEngine();
    this.presetCount = mainEngine?.getPresetCount?.() ?? null;
    this.presetIndex = mainEngine?.getPresetIndex?.() ?? null;
  }

  /** @param {number} i @param {string} reason */
  #scheduleBootRetry(i, reason) {
    const next = this.bootAttempt + 1;
    console.warn(`[Segmented] seg ${i} ${reason}`
      + ` (attempt ${next}/${MAX_BOOT_RETRIES}); rebuilding pool`);
    this.destroy();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.active) this.create(this.count, next);
    }, BOOT_RETRY_DELAY_MS);
    unrefTimer(this.retryTimer);
  }

  /**
   * (Re)build the worker pool at the current resolution: destroy any existing
   * pool, then spawn `numSegments` workers, each instantiating WASM from the
   * warmer's shared compilation when held, initialized with this engine's tuned
   * params and paused state. Latches a pool fault (leaving an empty controller)
   * if the segment count is illegal or the resolution key is unknown.
   * @param {number} numSegments - Pool size; must satisfy segment_layout's
   *   isValidSegmentCount (a positive even integer) and be <= SEGMENT_COUNT_MAX.
   * @param {number} [bootAttempt] - Retry index; 0 for a user-driven spawn.
   */
  create(numSegments, bootAttempt = 0) {
    this.destroy();
    this.bootAttempt = bootAttempt;

    // Ahead of the allocations: a fractional count throws out of `new Array`.
    if (!isValidSegmentCount(numSegments) || numSegments > SEGMENT_COUNT_MAX) {
      // `count` stays at the last legal size, which a rebuild reuses.
      this.onWorkerFault(FAULT_POOL,
        `invalid segment count ${numSegments}; must be a positive even integer `
        + `no greater than ${SEGMENT_COUNT_MAX} `
        + `— no workers were spawned, and a rebuild will use ${this.count}`);
      return;
    }

    this.count = numSegments;
    this.workers = [];
    this.#results = new Array(numSegments).fill(null);
    this.#scratch = new Array(numSegments).fill(null);
    this.#timings = new Array(numSegments).fill(0);
    this.#arenas = new Array(numSegments).fill(null);
    this.#fullFrames = new Array(numSegments).fill(false);
    this.#warnings = new Array(numSegments).fill(null);
    this.#frameSeen = new Array(numSegments).fill(false);
    this.paramValues = null;
    this.refreshPresetState();
    this.animationsPaused = this.getWasmEngine()?.getAnimationsPaused?.() ?? this.animationsPaused;
    this.#ready = false;

    const res = this.resolutionPresets[this.appState.get('resolution')];
    if (!res) {
      this.onWorkerFault(FAULT_POOL,
        `unknown resolution "${this.appState.get('resolution')}"; `
        + 'no workers were spawned');
      return;
    }

    // Per-index boot/ready state so a watchdog fault names the segments that
    // never reported, not just a count.
    const booted = new Array(numSegments).fill(false);
    const readied = new Array(numSegments).fill(false);
    const pool = { booted, readied, numSegments, readyCount: 0, bootedCount: 0 };
    /**
     * @param {boolean[]} state - Per-index boot or ready flags.
     * @returns {number[]} Indices still false.
     */
    const missing = (state) => {
      const out = [];
      for (let i = 0; i < numSegments; i++) if (!state[i]) out.push(i);
      return out;
    };

    const initialState = this.snapshotEffectState();

    for (let i = 0; i < numSegments; i++) {
      let worker;
      try {
        worker = new Worker(new URL('./segment_worker.js', import.meta.url),
          { type: 'module' });
      } catch (error) {
        this.abortWorkerStartup(i, 'construction', error);
        return;
      }

      this.#installWorkerHandlers(worker, i, pool);

      this.workers.push(worker);
      try {
        this.post(worker, {
          type: 'init',
          version: PROTOCOL_VERSION,
          segId: i,
          totalSegs: numSegments,
          w: res.w,
          h: res.h,
          effectName: this.appState.get('effect'),
          ...initialState,
          paused: this.animationsPaused,
          presetIndex: this.presetIndex ?? undefined,
          poleLod: this.poleLod,
          topCap: this.topCap,
          bottomCap: this.bottomCap,
          paramRevision: this.paramRevision,
          wasmModule: this.moduleWarmer.module ?? undefined,
        });
      } catch (error) {
        this.abortWorkerStartup(i, 'initialization', error);
        return;
      }
    }

    this.clearTimers('bootWatchdog');
    this.bootWatchdog = setTimeout(() => {
      this.bootWatchdog = null;
      if (!this.#ready && !this.faulted) {
        const stuck = missing(booted);
        this.onWorkerFault(stuck.length === 1 ? stuck[0] : FAULT_POOL,
          `worker module load timed out after ${BOOT_WATCHDOG_MS} ms `
          + `(${pool.bootedCount}/${numSegments} booted; never booted: `
          + `${stuck.join(', ')}) — a worker module likely `
          + `failed to load (commonly a missing or renamed generated/holosphere_wasm.js)`);
      }
    }, BOOT_WATCHDOG_MS);
    unrefTimer(this.bootWatchdog);

    this.clearTimers('initWatchdog');
    this.initWatchdog = setTimeout(() => {
      this.initWatchdog = null;
      if (!this.#ready && !this.faulted) {
        const stuck = missing(readied);
        this.onWorkerFault(stuck.length === 1 ? stuck[0] : FAULT_POOL,
          `worker init timed out after ${INIT_WATCHDOG_MS} ms `
          + `(${pool.readyCount}/${numSegments} ready; never ready: ${stuck.join(', ')}) `
          + `— a WASM module likely failed to load without throwing`);
      }
    }, INIT_WATCHDOG_MS);
    unrefTimer(this.initWatchdog);

    console.log(`[Segmented] Spawning ${numSegments} workers...`);
  }

  /**
   * @param {Worker} worker
   * @param {number} i
   * @param {{booted: boolean[], readied: boolean[], readyCount: number,
   *   bootedCount: number, numSegments: number}} pool
   */
  #installWorkerHandlers(worker, i, pool) {
    const { booted, readied, numSegments } = pool;
    worker.onmessage = (e) => {
      const msg = /** @type {ControllerInboundMsg} */ (e.data);
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
        this.onWorkerFault(i, `worker seg ${i} sent an invalid message envelope`);
        return;
      }
      if (msg.type === 'ready') {
        if (!readied[i]) { readied[i] = true; pool.readyCount++; }
        if (pool.readyCount === numSegments) {
          this.#ready = true;
          // A live pool resets the faulted-rebuild budget.
          this.faultedRebuilds = 0;
          this.clearTimers('bootWatchdog', 'initWatchdog');
          console.log(`[Segmented] All ${numSegments} workers ready`);
        }
      } else if (msg.type === 'booted') {
        if (msg.version !== PROTOCOL_VERSION) {
          this.onWorkerFault(i, `worker seg ${i} protocol version ${msg.version}`
            + ` != controller ${PROTOCOL_VERSION} (stale cached worker or glue)`);
          return;
        }
        if (!booted[i]) { booted[i] = true; pool.bootedCount++; }
        if (pool.bootedCount === numSegments) this.clearTimers('bootWatchdog');
      } else if (msg.type === 'engineRejected') {
        if (msg.sharedModule) {
          this.moduleWarmer.discard();
          if (!this.#ready && this.bootAttempt < MAX_BOOT_RETRIES) {
            this.#scheduleBootRetry(i, `shared module rejected: ${msg.reason}`);
            return;
          }
        }
        this.onWorkerFault(i, `worker seg ${i} engine rejected: ${msg.reason}`);
      } else if (msg.type === 'frame') {
        this.#onSegmentFrame(i, msg);
      } else {
        // `never` makes an unhandled ControllerInboundMsg member a typecheck error.
        /** @type {never} */
        const unhandled = msg;
        this.onWorkerFault(i, `worker seg ${i} sent unknown message type `
          + `${String((/** @type {{type?: unknown}} */ (unhandled)).type)}`);
      }
    };

    worker.onerror = (e) => {
      e?.preventDefault?.();
      // A message-less error Event before ready is a transient module-graph load
      // failure, retried a bounded number of times; a messaged error fails fast.
      const message = typeof e?.message === 'string' && e.message
        ? e.message : null;
      if (!this.#ready && !message
          && this.bootAttempt < MAX_BOOT_RETRIES) {
        this.#scheduleBootRetry(i, 'module failed to load');
        return;
      }
      const detail = message || (this.#ready
        ? 'worker failed after the pool became ready without an error message'
        : `module load failed after ${MAX_BOOT_RETRIES + 1} attempts`
           + ` (commonly a missing or renamed generated/holosphere_wasm.js, or a bare`
           + ` import specifier — a worker resolves its graph without the`
           + ` page's import map)`);
      console.error(`[Segmented] Worker seg ${i} error: ${detail}`
        + ` (${e?.filename}:${e?.lineno}:${e?.colno})`, e);
      this.onWorkerFault(i, detail);
    };
    worker.onmessageerror = (e) => {
      console.error(`[Segmented] Worker seg ${i} message deserialization`
        + ` failed`, e);
      this.onWorkerFault(i, 'message deserialization failed');
    };
  }

  /** @param {number} i @param {Extract<ControllerInboundMsg, {type: "frame"}>} msg */
  #onSegmentFrame(i, msg) {
    // A halted pool zeroed `pending`; ignore late frames so it can't go negative.
    if (this.faulted) return;
    if (msg.segId !== i) {
      this.onWorkerFault(i, `worker seg ${i} reported a frame tagged segId `
        + `${String(msg.segId)}; a frame the pool cannot attribute is a `
        + 'protocol violation (stale cached worker or glue)');
      return;
    }
    // Count and stage only the first message from each segment.
    if (this.#frameSeen[msg.segId]) return;
    // Generation fence: keep only results from the current resolution; still
    // settle the frame either way.
    if (this.#inflightGen === this.#renderGen) {
      // Mirror segment 0's live params for GUI sync; fenced, since a stale
      // frame's params index the old descriptor list.
      if (msg.segId === 0) {
        this.presetCount = msg.presetCount ?? null;
        if (msg.paramRevision >= this.presetRevision)
          this.presetIndex = msg.presetIndex ?? null;
        if (msg.paramValues && msg.paramRevision === this.paramRevision)
          this.paramValues = msg.paramValues;
      }
      this.#scratch[msg.segId] = {
        pixels: msg.pixels,
        x0: msg.x0, x1: msg.x1,
        y0: msg.y0, y1: msg.y1,
      };
      this.#timings[msg.segId] = msg.elapsed;
      this.#arenas[msg.segId] = msg.arenaMetrics;
      this.#fullFrames[msg.segId] = msg.fullFrame === true;
      this.#warnings[msg.segId] = msg.warnings ?? null;
    }
    this.#frameSeen[msg.segId] = true;
    this.#pending--;
    if (this.#pending === 0 && this.#frameResolve) {
      this.#frameResolve();
      this.#frameResolve = null;
    } else if (this.#pending > 0) {
      this.armRenderWatchdog();
    }
  }

  /**
   * Latch a synchronous startup failure of worker `segId`; onWorkerFault
   * terminates and detaches the partially-created pool.
   * @param {number} segId - Segment whose startup threw.
   * @param {string} phase - Startup step named in the fault message, e.g. 'construction'.
   * @param {unknown} error - The caught value, rendered by errorDetail.
   * @returns {void}
   */
  abortWorkerStartup(segId, phase, error) {
    this.onWorkerFault(segId, `worker ${phase} failed: ${errorDetail(error)}`);
  }

  /**
   * Cancel whichever of the named deadlines are pending and clear their fields.
   * Idempotent.
   * @param {...TimerField} fields - Deadline fields to cancel.
   * @returns {void}
   */
  clearTimers(...fields) {
    for (const field of fields) {
      const timer = this[field];
      if (timer === null) continue;
      clearTimeout(timer);
      this[field] = null;
    }
  }

  /**
   * (Re)arm the pool-wide render-liveness deadline; a stall (no segment reports
   * for RENDER_WATCHDOG_MS) faults.
   */
  armRenderWatchdog() {
    this.clearTimers('renderWatchdog');
    this.renderWatchdog = setTimeout(() => {
      this.renderWatchdog = null;
      if (this.#pending > 0 && !this.faulted) {
        this.onWorkerFault(FAULT_RENDER,
          `render stalled: no segment reported a frame for ${RENDER_WATCHDOG_MS} ms `
          + `(${this.workers.length - this.#pending}/${this.workers.length} `
          + `segments responded) — a worker accepted 'render' but stopped progressing`);
      }
    }, RENDER_WATCHDOG_MS);
    unrefTimer(this.renderWatchdog);
  }

  /**
   * Terminate every worker in the pool, leaving `workers` populated.
   * @details Handlers are detached first so an already-queued message cannot run
   * against the torn-down pool.
   */
  terminateWorkers() {
    for (const w of this.workers) {
      w.onmessage = null;
      w.onerror = null;
      w.onmessageerror = null;
      w.terminate();
    }
  }

  /**
   * Terminate all workers and reset per-segment, frame-lifecycle, and fault
   * state to empty, clearing the fault latch.
   */
  destroy() {
    this.terminateWorkers();
    this.clearTimers(...ALL_TIMERS);
    this.workers = [];
    this.#results = [];
    this.#scratch = [];
    this.#timings = [];
    this.#arenas = [];
    this.#fullFrames = [];
    this.#warnings = [];
    this.#frameSeen = [];
    this.#ready = false;
    this.#pending = 0;
    // No capture is owed while the pool respawns.
    this.#frameComposited = false;
    // Bump before settling: the in-flight render's `.then` runs on a later
    // microtask, possibly after a fresh pool exists.
    this.#renderGen++;
    // Settle any in-flight render promise so it never leaks unresolved.
    if (this.#frameResolve) {
      const resolve = this.#frameResolve;
      this.#frameResolve = null;
      resolve();
    }
    this.#renderInFlight = false;
    this.#pendingFrame = false;
    this.faulted = false;
    this.faultInfo = null;
    this.compositor.reset();
  }

  /**
   * Release the pool and the warmer's held compilation, for page teardown;
   * destroy() alone keeps the warm compilation.
   */
  dispose() {
    this.destroy();
    this.moduleWarmer.discard();
  }

  /**
   * Latch a worker fault and break the render-loop deadlock: settle the
   * in-flight frame (resolve its promise, zero `pending`), stop `tick()`
   * dispatching, and terminate the pool with its handlers detached. `workers`
   * stays populated so the fault reports against the dispatched pool. Recovery
   * is a pool rebuild, which clears the latch. Only the first fault since the
   * pool was (re)built is recorded for the UI.
   * @param {number} segId - Index of the worker segment that faulted.
   * @param {string} message - Human-readable fault message for the UI/console.
   */
  onWorkerFault(segId, message) {
    this.clearTimers(...ALL_TIMERS);
    const firstFault = !this.faulted;
    if (!this.faulted) {
      this.faulted = true;
      this.faultInfo = { segId, message };
    } else {
      console.warn(`[Segmented] additional worker fault (seg ${segId}): ${message} `
        + `— first fault already latched, UI shows that one`);
    }
    this.terminateWorkers();
    this.#pending = 0;
    this.#renderInFlight = false;
    // Bump before settling so the in-flight `.then` cannot publish the
    // incomplete frame.
    this.#renderGen++;
    if (this.#frameResolve) {
      const resolve = this.#frameResolve;
      this.#frameResolve = null;
      resolve();
    }
    // A paused host need not tick, so paint the overlay here.
    this.updateStats();
    if (firstFault) this.onFault(message);
  }

  /**
   * Snapshot the main engine's accepted and requested parameter values,
   * flattened for structured-clone transport (bools encoded as 1/0). Workers
   * restore the accepted render state first, then replay pending requests.
   * Readonly params carry no writable state and are left out, and an accepted
   * value equal to the request is omitted so it replays as one write, not two.
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
      // Engine-written telemetry; setParameter refuses it as READONLY.
      if (p.readonly) continue;
      const requestedValue = /** @type {number|boolean|undefined} */ (p.requestedValue);
      const v = engineParamValue(requestedValue ?? p.value);
      const acceptedV = engineParamValue(acceptedParamValue(p));
      params.push(acceptedV === v
        ? { name: p.name, value: v }
        : { name: p.name, value: v, acceptedValue: acceptedV });
    }
    return params;
  }

  /**
   * Capture the active effect's versioned snapshot when available, otherwise
   * use the parameter-list protocol.
   * @returns {{params?: import('./worker_protocol.js').SegParam[],
   *   chainSnapshot?: import('./worker_protocol.js').ChainSnapshot}}
   */
  snapshotEffectState() {
    const engine = this.getWasmEngine();
    const snapshot = callWorkbenchBinding(engine, 'getShaderChainBindings', 'getSnapshot', []);
    if (snapshot) return { chainSnapshot: snapshot };
    return { params: this.snapshotParams() };
  }

  /**
   * Tell all workers to set a new effect, carrying the main engine's tuned
   * values for each worker to re-apply after its setEffect() resets defaults.
   * @param {string} name
   */
  setEffect(name) {
    // Null until segment 0 reports the new effect's first frame, so the rebuilt
    // GUI does not bind stale values by index.
    this.paramValues = null;
    this.paramRevision++;
    this.refreshPresetState();
    // A faulted pool is rebuilt (when active), bounded by MAX_FAULTED_REBUILDS
    // since effect switches can arrive on a timer.
    if (this.faulted) {
      if (!this.active) return;
      this.faultedRebuilds++;
      if (this.faultedRebuilds > MAX_FAULTED_REBUILDS) {
        if (this.faultedRebuilds === MAX_FAULTED_REBUILDS + 1) {
          console.warn(`[Segmented] pool faulted on ${MAX_FAULTED_REBUILDS} consecutive `
            + 'effect-switch rebuilds; change resolution or toggle segmented mode to restart');
        }
        return;
      }
      this.create(this.count);
      return;
    }
    // Fence in-flight old-effect frames and drop settled ones.
    this.#renderGen++;
    this.#results.fill(null);
    this.#pendingFrame = false;
    this.broadcast({
      type: 'setEffect',
      name,
      ...this.snapshotEffectState(),
      paused: this.animationsPaused,
      presetIndex: this.presetIndex ?? undefined,
      paramRevision: this.paramRevision,
    });
  }

  /**
   * Tell all workers to set a parameter.
   * @param {string} name
   * @param {number} value
   */
  setParameter(name, value) {
    this.paramValues = null;
    this.paramRevision++;
    // A faulted pool stays latched: this fires per slider-drag event.
    if (this.faulted) return;
    this.broadcast({
      type: 'setParameter', name, value,
      paramRevision: this.paramRevision,
    });
  }

  /**
   * Tell all workers to pause/resume parameter-driving animations.
   * @param {boolean} paused
   */
  setAnimationsPaused(paused) {
    // Recorded before the fault gate so a later rebuild carries the pause state.
    this.animationsPaused = paused;
    if (this.faulted) return;
    this.broadcast({ type: 'setAnimationsPaused', paused });
  }

  /**
   * Select a preset on every worker, latching it so a rebuild lands on it too.
   * @param {number} index
   * @returns {boolean} False when `index` is not an integer in range for the
   *   known preset count (nothing is latched or broadcast); true once accepted,
   *   including on a faulted pool, where it is latched but not broadcast.
   */
  selectPreset(index) {
    if (!Number.isInteger(index) || this.presetCount == null
        || index < 0 || index >= this.presetCount) return false;
    this.paramValues = null;
    this.paramRevision++;
    this.presetRevision = this.paramRevision;
    this.presetIndex = index;
    this.animationsPaused = true;
    if (this.faulted) return true;
    this.broadcast({ type: 'selectPreset', index,
      paramRevision: this.paramRevision });
    return true;
  }

  /**
   * Tell all workers to set the near-pole azimuthal decimation aggressiveness.
   * @param {number} value
   */
  setPoleLod(value) {
    // Recorded before the fault gate so a later rebuild carries it; a faulted
    // pool stays latched (this fires per drag event).
    this.poleLod = value;
    if (this.faulted) return;
    this.broadcast({ type: 'setPoleLod', value });
  }

  /**
   * Update worker geometry and discard frames rendered for the previous caps.
   * @param {number} topCap
   * @param {number} bottomCap
   * @returns {void}
   */
  setDisplayCaps(topCap, bottomCap) {
    this.topCap = topCap;
    this.bottomCap = bottomCap;
    if (this.faulted) return;
    this.paramValues = null;
    this.#renderGen++;
    this.#results.fill(null);
    this.#pendingFrame = false;
    this.broadcast({ type: 'setDisplayCaps', topCap, bottomCap });
    if (this.driver.paused) this.tick();
  }

  /**
   * Tell all workers to update resolution. Callers follow this with
   * setEffect(), which rebuilds a faulted pool.
   * @param {number} w
   * @param {number} h
   */
  setResolution(w, h) {
    if (this.faulted) {
      this.faultedRebuilds = 0;
      return;
    }
    // Fence old-resolution results into a prior generation.
    this.paramValues = null;
    this.paramRevision++;
    this.#renderGen++;
    this.#results.fill(null);
    this.#pendingFrame = false;
    // The outstanding render retains the latch until frameResolve or its watchdog.
    this.broadcast({ type: 'setResolution', w, h });
  }

  /**
   * Dispatch parallel render to all workers.
   * @returns {Promise<void>} Resolves when all workers have responded, the pool
   *   is empty, a fault is latched, or the pool is destroyed.
   */
  renderParallel() {
    return new Promise((resolve) => {
      this.#inflightGen = this.#renderGen;
      this.#pending = this.workers.length;
      this.#frameSeen.fill(false);
      // Clear per-segment stats so a segment fenced out (or silent) this frame
      // reports fresh 0/'-' rather than a prior generation's values.
      this.#timings.fill(0);
      this.#arenas.fill(null);
      this.#fullFrames.fill(false);
      this.#warnings.fill(null);
      this.#frameStart = performance.now();
      this.#frameResolve = () => {
        this.clearTimers('renderWatchdog');
        this.#wallTime = performance.now() - this.#frameStart;
        resolve();
      };

      // An empty pool never answers, so settle immediately.
      if (this.workers.length === 0) {
        this.#frameResolve();
        this.#frameResolve = null;
        return;
      }

      // Transfer only retired scratch buffers; live results remain attached.
      for (let s = 0; s < this.workers.length; s++) {
        const retired = this.#scratch[s];
        this.#scratch[s] = null;
        const recycle = retired && retired.pixels && retired.pixels.length > 0
          ? retired.pixels : null;
        try {
          if (recycle) {
            this.post(this.workers[s], { type: 'render', recycle }, [recycle.buffer]);
          } else {
            this.post(this.workers[s], { type: 'render' });
          }
        } catch (error) {
          // Un-posted workers never reply and no watchdog is armed yet; the
          // fault settles the promise.
          this.#scratch.fill(null);
          this.onWorkerFault(s, `render dispatch to seg ${s} failed: `
            + errorDetail(error));
          return;
        }
      }

      this.armRenderWatchdog();
    });
  }

  /** @param {Array<FrameResult|null>} results @returns {number} */
  composite(results) {
    return this.compositor.composite(results, this.count, this.showBoundaries);
  }

  /**
   * Repaint the per-segment stats overlay from this controller's published state.
   * @details The payload arrays are the controller's own, not copies; the view
   * must read them synchronously and retain none.
   * @returns {void}
   */
  updateStats() {
    this.statsView.update({
      active: this.active,
      ready: this.#ready,
      faulted: this.faulted,
      faultInfo: this.faultInfo,
      count: this.count,
      results: this.#results,
      timings: this.#timings,
      arenas: this.#arenas,
      fullFrames: this.#fullFrames,
      warnings: this.#warnings,
      frameSeen: this.#frameSeen,
      wallTime: this.#wallTime,
    });
  }

  /**
   * Whether `results` holds a published generation the overrun path can re-blit.
   * @returns {boolean} True when at least one segment carries pixels.
   */
  hasPublishedFrame() {
    for (let s = 0; s < this.#results.length; s++) {
      const r = this.#results[s];
      if (r && r.pixels) return true;
    }
    return false;
  }

  /**
   * Whether the worker pool owns the display buffer: it is either rendering
   * (ready) or holding the fault overlay. False while a pool spawns.
   * @returns {boolean}
   */
  get ownsDisplay() {
    return this.active && (this.#ready || this.faulted);
  }

  /**
   * Render-loop step (segment mode active): apply the previous frame's composite
   * synchronously, then dispatch the next frame's parallel render fire-and-forget.
   * No-ops while workers are still spawning.
   */
  tick() {
    // Before the ready guard: an init-phase fault never reaches ready.
    if (this.faulted) {
      this.#frameComposited = false;
      this.updateStats();
      return;
    }

    if (!(this.#ready && this.workers.length > 0)) return;

    // Apply the previous frame's composite synchronously, over driver.render()'s clear.
    if (this.#pendingFrame) {
      const blitted = this.composite(this.#results);
      this.updateStats();
      // Held when there was no display buffer to blit into: the assembled
      // generation is still in `results` and composites on a later tick.
      this.#pendingFrame = blitted < 0;
      // Only a whole generation counts as a frame.
      this.#frameComposited = blitted === this.count;
    } else if (this.hasPublishedFrame()) {
      // Replay the last published generation without recording it again or updating stats.
      this.composite(this.#results);
      this.#frameComposited = false;
    } else {
      this.#frameComposited = false;
    }

    // composite() can latch a fault; paint the overlay and skip dispatch.
    if (this.faulted) {
      this.updateStats();
      return;
    }

    if (!this.#renderInFlight) {
      this.#renderInFlight = true;
      const generation = this.#renderGen;
      this.renderParallel().then(() => {
        // Publish only the current generation; retire the previous live buffer into scratch.
        if (generation === this.#renderGen) {
          const done = this.#scratch;
          this.#scratch = this.#results;
          this.#results = done;
          this.#pendingFrame = true;
          if (this.driver.paused && this.active && !this.faulted) {
            const blitted = this.composite(this.#results);
            this.#pendingFrame = blitted < 0;
            this.#frameComposited = blitted === this.count;
            this.updateStats();
            const instanceColor = this.driver.dotMesh?.instanceColor;
            if (instanceColor && isViewLive(instanceColor.array))
              instanceColor.needsUpdate = true;
            this.driver.invalidate();
          }
        }
        this.#renderInFlight = false;
        if (generation !== this.#renderGen && this.driver.paused) this.tick();
      }).catch((error) => {
        // A rejection would otherwise strand renderInFlight with no watchdog armed.
        this.onWorkerFault(FAULT_RENDER, `render failed: ${errorDetail(error)}`);
      });
    }
  }
}
