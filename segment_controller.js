// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * SegmentController — owns the segmented-POV worker pipeline.
 *
 * N Web Workers each instantiate their own isolated WASM engine — from one
 * compilation shared with the pool — and render a segment rectangle of the
 * canvas in parallel; results are composited into the display buffer. The
 * pipeline is one-frame deep: frame N-1's results are displayed while frame N
 * renders on the workers (frame time = max(segment times), not sum).
 *
 * The host (daydream.js) owns the main-thread WASM engine and pixel view (both
 * reassignable), so those are injected as lazy getters:
 *   - resolutionPresets:  { name -> {w,h} } resolution table
 *   - appState:           pub/sub state (reads 'resolution' and 'effect')
 *   - driver:             Daydream renderer instance (live grid + display buffer)
 *   - getWasmEngine():    current main-thread HolosphereEngine (or null)
 *   - refreshPixelView(): re-fetch the (possibly detached) WASM pixel view
 *   - getMemoryView():    current Uint16Array view of the display buffer
 *   - repointDisplayAliases(view): re-point both display aliases at a view
 */
import {
  compositeSegment,
  computeSegmentRange,
  isValidSegmentCount,
  stampBoundaries,
} from "./segment_layout.js";
import { displayAliasesDiverged } from "./app_lifecycle.js";
import { FAULT_POOL, FAULT_RENDER, SegmentStatsView } from "./segment_stats_view.js";
import { PROTOCOL_VERSION } from "./worker_protocol.js";

export const SEGMENT_CONTROLLER_API_VERSION = 1;

// Deadline for all workers to report 'ready'. A non-throwing WASM load failure
// fires no onerror and never sends 'ready', so this bound latches a fault instead
// of freezing black.
export const INIT_WATCHDOG_MS = 20000;

// Deadline for the per-worker 'booted' ping (fetch+evaluate, not WASM
// instantiate). Sized for a cold-cache/throttled module+glue fetch; a slow WASM
// instantiate is separately bounded by INIT_WATCHDOG_MS.
export const BOOT_WATCHDOG_MS = 10000;

// Per-worker liveness deadline for a dispatched parallel render. A worker that
// accepts 'render' but hangs without throwing fires no onerror and never settles
// `pending`, freezing the pipeline; this bound latches a fault instead. It is
// re-armed on every distinct segment 'frame' while `pending > 0`, so it bounds the
// gap between reports rather than the whole render — a legitimately slow effect on
// a throttled GPU keeps extending it as segments land, and only a true stall (no
// segment reports for this long) faults. Absolute rather than a multiple of the
// display cadence: the fault is unrecoverable without a user-driven rebuild, and
// the widest gap it legitimately sees is the first frame after an effect switch
// (a cold effect build plus a full segment render of at most half of 288x144 on a
// throttled machine), so it is sized against a hung worker, not a slow one. Peer
// to the boot/init deadlines above.
export const RENDER_WATCHDOG_MS = 5000;

// Bounded auto-retry for a transient worker module-load failure: a bare, message-
// less error Event, which the browser fires when a `{type:'module'}` worker's
// import graph fails to fetch — typically a burst of cold concurrent fetches of the
// large WASM glue racing after the tab's keep-alive connection dropped during idle,
// not a deterministic worker throw. The pool rebuilds a few times with a short
// backoff (the refetch hits a re-warmed cache/connection) before latching a fault,
// so the sim self-heals instead of needing a manual segmented-mode toggle.
export const MAX_BOOT_RETRIES = 3;
export const BOOT_RETRY_DELAY_MS = 250;

// Bound on consecutive effect-switch rebuilds of a faulted pool. Effect switches
// can be timer-driven (the Test All ticker walks the list on an interval), so a
// deterministic fault would otherwise respawn the whole pool — one WASM module
// per segment — on every tick. Reset when a pool reaches ready; once spent, the
// restart paths are the user-driven ones the fault banner names: a resolution
// change or a segmented-mode toggle.
export const MAX_FAULTED_REBUILDS = 2;

// Minimum spacing between two actual warms. lil-gui fires onChange per drag
// step, so the segment-count slider calls warmModules() several times a second;
// each of those revalidates the whole module graph.
export const WARM_INTERVAL_MS = 10000;

let lastWarmAt = -Infinity;
// Resolved probe URL the stored warm covers. A warm of another module graph
// must not be served this one's promise, so the dedupe window is keyed on it.
/** @type {string | null} */
let lastWarmKey = null;
/** @type {Promise<void>} */
let lastWarm = Promise.resolve();

/**
 * The binary compiled once by warmModules, handed to every worker in its `init`
 * so the pool instantiates one compilation instead of N. A WebAssembly.Module is
 * structured-cloneable and carries no state: the binary declares its own memory
 * rather than importing one, so each instance still gets an isolated heap and a
 * private global arena. Null until a warm lands (and outside a web origin), and
 * the worker then falls back to fetching and compiling the binary itself.
 * @type {WebAssembly.Module | null}
 */
let sharedWasmModule = null;

/**
 * Render a thrown value as a fault message detail.
 * @param {unknown} error - The caught value.
 * @returns {string} `Name: message` for an Error, else its string form.
 */
function errorDetail(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Release a pending timer's hold on the Node event loop, so an unfired watchdog
 * cannot keep the unit-test process alive. No-op in browsers, where `unref` does
 * not exist and timers do not hold the page open.
 * @param {ReturnType<typeof setTimeout>} timer - Handle returned by setTimeout.
 * @returns {void}
 */
function unrefTimer(timer) {
  const nodeTimer = /** @type {{unref?: () => void}} */ (
    /** @type {unknown} */ (timer));
  nodeTimer.unref?.();
}

/**
 * Best-effort prime of the worker module graph's HTTP cache and keep-alive
 * connection before a pool spawn, so the burst of cold concurrent worker fetches
 * after an idle period can't lose the race and abort one worker's load. Awaited on
 * the interactive enable path (the primary trigger); a no-op outside a web origin
 * (e.g. under the file://-based unit tests) and swallows fetch failures — the boot
 * auto-retry is the actual guarantee, this only lowers the odds.
 * @details The artifacts are served unversioned, so freshness rests on
 * revalidation: `cache: 'no-cache'` re-fetches a rebuilt binary and costs a 304
 * for an unchanged one, where a reload always re-pulls all 1.8 MB. A call within
 * `minIntervalMs` of the last warm of the SAME base URL reuses that warm's
 * promise; another base URL describes another module graph and warms its own.
 *
 * The drained binary is also compiled here into `sharedWasmModule`, so the pool
 * spawn that follows spends one compilation of the 2 MB module rather than one
 * per worker. A compile failure is reported and leaves the previous module in
 * place; the workers then compile their own.
 * @param {{fetch?: typeof globalThis.fetch, baseUrl?: string|URL, minIntervalMs?: number}} [dependencies]
 * @returns {Promise<void>}
 */
export function warmModules({
  fetch: fetchResource = globalThis.fetch,
  baseUrl = import.meta.url,
  minIntervalMs = WARM_INTERVAL_MS,
} = {}) {
  if (typeof fetchResource !== 'function') return Promise.resolve();
  let probe;
  try { probe = new URL('./holosphere_wasm.js', baseUrl); }
  catch { return Promise.resolve(); }
  if (probe.protocol !== 'http:' && probe.protocol !== 'https:') return Promise.resolve();
  const now = Date.now();
  if (probe.href === lastWarmKey && now - lastWarmAt < minIntervalMs) return lastWarm;
  // fetch resolves at the headers; the body must be drained or nothing is cached.
  const drain = (/** @type {string} */ u) =>
    fetchResource(new URL(u, baseUrl), { cache: 'no-cache' }).then((r) => r.arrayBuffer());
  /** @type {Promise<void>} */
  let warm;
  try {
    const workerJs = drain('./segment_worker.js');
    const glueJs = drain('./holosphere_wasm.js');
    const binary = drain('./holosphere_wasm.wasm');
    warm = Promise.allSettled([
      workerJs,
      glueJs,
      binary,
      binary
        .then((bytes) => WebAssembly.compile(bytes).catch((err) => {
          // Reported here alone: the fetch rejections allSettled swallows are
          // a cold cache, but a binary the engine refuses is a broken artifact,
          // and its only other symptom is a slower spawn.
          console.warn('[Segmented] shared WASM compile failed; each worker '
            + 'will compile its own', err);
          return null;
        }))
        .then((compiled) => { if (compiled) sharedWasmModule = compiled; }),
    ]).then(() => {});
  } catch {
    // A fetch that throws synchronously warmed nothing, so the window stays
    // with the last warm that did: advancing it here would hand every caller
    // inside the window a promise already settled by an earlier module graph.
    return Promise.resolve();
  }
  // Stamped only once the promise it describes exists, for the same reason.
  lastWarmAt = now;
  lastWarmKey = probe.href;
  lastWarm = warm;
  return lastWarm;
}

// GUI ceiling on the worker pool, and the two lower ones a constrained device
// gets. Every pool member holds its own WASM instance — 17.5 MB of linear memory
// before growth — and the main thread holds one more, so an N-segment pool costs
// N+1 heaps.
const SEGMENT_COUNT_MAX = 8;
const SEGMENT_COUNT_CONSTRAINED = 4;
const SEGMENT_COUNT_MIN = 2;

/**
 * Largest segment count to offer on this device. The GUI builds its slider
 * against this rather than rejecting an oversized pool afterwards, since running
 * the tab out of memory is a crash no fault path can report.
 * @details `navigator.deviceMemory` is Chromium-only and reports whole GiB
 * capped at 8; where it is missing the mobile layout is what stands in for a
 * phone. The result is always even, so it satisfies isValidSegmentCount.
 * @param {Navigator | {deviceMemory?: number}} [nav] - Source of the device hint.
 * @param {boolean} [isMobile] - Whether the app is in its mobile layout.
 * @returns {number} An even count in [2, 8].
 */
export function maxSegmentCount(nav = globalThis.navigator, isMobile = false) {
  let cap = SEGMENT_COUNT_MAX;
  // deviceMemory is not in the DOM lib: it is a Chromium extension to Navigator.
  const gib = /** @type {{deviceMemory?: number} | undefined} */ (nav)?.deviceMemory;
  if (typeof gib === 'number' && gib > 0) {
    if (gib <= 2) cap = SEGMENT_COUNT_MIN;
    else if (gib <= 4) cap = SEGMENT_COUNT_CONSTRAINED;
  }
  if (isMobile) cap = Math.min(cap, SEGMENT_COUNT_CONSTRAINED);
  return Math.max(cap, SEGMENT_COUNT_MIN);
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
  /** Backing store for the `active` accessor pair. */
  #active = false;

  /**
   * Wire the controller to the host's reassignable engine/view via lazy getters.
   * @param {Object} deps - Host-injected dependencies.
   * @param {Object<string, {w:number, h:number}>} deps.resolutionPresets - Resolution table mapping a preset name to its pixel dimensions.
   * @param {{get: (key: string) => any}} deps.appState - Read-only view of the host's pub/sub state; reads the 'resolution' and 'effect' keys.
   * @param {{W: number, H: number, pixels: Uint16Array|null, dotMesh: {instanceColor: {array: Uint16Array|null, needsUpdate: boolean}}}} deps.driver - Renderer instance owning the live pixel grid (W/H), the display buffer the compositor blits into, and the dot mesh carrying the second display alias: composite() reads both aliases to detect a divergence, and the heal re-points them.
   * @param {() => (import('./holosphere_wasm.js').HolosphereEngine|null)} deps.getWasmEngine - Returns the current main-thread HolosphereEngine, or null when none is bound.
   * @param {() => unknown} deps.refreshPixelView - Re-fetches the (possibly detached) WASM pixel view.
   * @param {() => (Uint16Array|null)} deps.getMemoryView - Returns the current Uint16Array view of the display buffer.
   * @param {(view: Uint16Array) => void} deps.repointDisplayAliases - Re-points BOTH display aliases (Three.js instanceColor.array + driver.pixels) at the given view. Required: only the host knows the mesh, and an implementation that moves one alias leaves the composite in a buffer the GPU never reads.
   * @param {Document} [deps.statsDoc] - DOM document the stats overlay renders into; defaults to the global `document`.
   * @throws {TypeError} When repointDisplayAliases is not a function.
   */
  constructor({ resolutionPresets, appState, driver, getWasmEngine, refreshPixelView,
                getMemoryView, repointDisplayAliases, statsDoc }) {
    if (typeof repointDisplayAliases !== 'function') {
      throw new TypeError('SegmentController: repointDisplayAliases is required '
        + 'and must be a function that re-points both display aliases');
    }
    this.resolutionPresets = resolutionPresets;
    this.appState = appState;
    this.driver = driver;
    this.getWasmEngine = getWasmEngine;
    this.refreshPixelView = refreshPixelView;
    this.getMemoryView = getMemoryView;
    this.repointDisplayAliases = repointDisplayAliases;
    /** @type {SegmentStatsView} */
    this.statsView = new SegmentStatsView(statsDoc);

    // Live pool size, set only by create() so it always matches the length of the
    // per-segment arrays composite() and updateStats() index.
    this.count = 4;
    this.showBoundaries = false;
    // Tracked so create() can carry it into a freshly-spawned pool.
    this.animationsPaused = false;
    // Near-pole azimuthal decimation. Per-module-instance in the engine, so each
    // worker holds its own copy and a pool rebuilt mid-session must be re-seeded.
    this.poleLod = 0;

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
    /** @type {Array<SegArenaMetrics | null>} */
    this.arenas = [];
    /**
     * Per-segment clip disposition of the last reported frame: true when that
     * worker's effect reports needs_full_frame() and it shaded the whole canvas
     * instead of its band. The pool is only N-way parallel where this is false.
     * @type {boolean[]}
     */
    this.fullFrames = [];

    /** @type {number[] | null} */
    this.paramValues = null;  // segment 0's latest param values, for GUI sync
    this.paramRevision = 0;
    /** @type {Map<string, number>} */
    this.acceptedParams = new Map();
    /** @type {number | null} */
    this.presetCount = null;
    /** @type {number | null} */
    this.presetIndex = null;

    this.pending = 0;         // count of outstanding render responses
    /** @type {boolean[]} */
    this.frameSeen = [];     // per-segId first-arrival flag, reset each dispatch
    this.frameStart = 0;
    this.wallTime = 0;        // dispatch -> last worker response (ms)
    /** @type {(() => void) | null} */
    this.frameResolve = null;
    this.ready = false;

    // Generation fence: renderGen bumps wherever an in-flight frame's results stop
    // being publishable — a resolution change (sized to a stale W/H, its x1/y1
    // indexing past the resized buffer), an effect switch (outgoing effect), a
    // fault latch, and destroy(). renderParallel snapshots it into inflightGen at
    // dispatch; a frame whose snapshot no longer matches renderGen is dropped.
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
    // Effect-switch rebuilds of a faulted pool since the last pool reached ready.
    // Not cleared by destroy(): the faulted rebuild runs through create(), which
    // destroys first, so clearing it there would unbound the count.
    this.faultedRebuilds = 0;

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

    // Cached boundary-overlay seam coordinates, rebuilt only when renderGen bumps
    // (segment geometry is fixed within a generation).
    /** @type {number[]} */
    this.boundaryYs = [];
    /** @type {number[]} */
    this.boundaryXs = [];
    this.boundaryGen = -1;

    // Cached per-segment band rectangles composite()'s pre-pass validates
    // against, rebuilt only when the layout the cache key names moves.
    /** @type {import('./segment_layout.js').SegRange[] | null} */
    this.bands = null;
    this.bandGen = -1;
    this.bandCount = 0;
    this.bandW = 0;
    this.bandH = 0;
  }

  /**
   * Whether segmented mode is on. Host-owned: only the host (daydream.js)
   * writes it; the controller reads it to decide whether a pool should exist
   * (the transient boot retry, the faulted setEffect/setResolution rebuilds,
   * and ownsDisplay). It stays true across a fault so a user-driven
   * setEffect/setResolution can rebuild the latched pool.
   * @returns {boolean} True while segmented mode is on.
   */
  get active() {
    return this.#active;
  }

  /**
   * Turn segmented mode on or off.
   *
   * The write must land BEFORE the host awaits or tears anything down, in both
   * directions:
   * - Enable: set true, then await warmModules(); the spawn guard's post-await
   *   check reads this flag and its own epoch, and calls create() only if both
   *   still hold. A pool created while false never owns the display, and a
   *   transient worker boot failure is never retried (the retry timer re-creates
   *   only while active).
   * - Disable/teardown: set false, then destroy(). A warmModules() continuation
   *   already in flight reads the flag after its await, so it cannot spawn a pool
   *   into a torn-down host. The write also repaints the overlay, which is what
   *   hands the global stat bars back, so no caller has to remember to.
   *
   * @param {boolean} on - Whether segmented mode is on.
   * @throws {TypeError} When `on` is not a boolean. The flag reaches the spawn
   *   guard and ownsDisplay as a condition, where a truthy non-boolean would read
   *   as enabled and a pool would spawn behind a display the host still paints.
   */
  set active(on) {
    if (typeof on !== 'boolean') {
      throw new TypeError('SegmentController.active must be a boolean, got '
        + `${typeof on}`);
    }
    this.#active = on;
    if (!on) this.updateStats();
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
   * @details A postMessage that throws (an unclonable payload, a worker the agent
   * already tore down) latches a fault instead of escaping to the GUI handler that
   * triggered the broadcast, which would leave the pool half-updated and unreported.
   * A caller sequencing a second broadcast must gate it on the returned flag: the
   * fault has already terminated the pool, so the follow-up would post into dead
   * workers and report nothing.
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
   * effect's param list), or null before the first frame. The GUI reads these in
   * segmented mode since the main-thread engine is never stepped.
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
   * (Re)build the worker pool at the current resolution: destroy any existing
   * pool, then spawn `numSegments` fresh workers, each loading its own WASM
   * module and initialized with this engine's tuned params and paused state.
   * Latches a pool fault (leaving an empty controller) if the segment count is
   * not layout-legal or the resolution key is unknown.
   * @param {number} numSegments - Pool size; must satisfy segment_layout's
   *   isValidSegmentCount (a positive even integer).
   * @param {number} [bootAttempt] - Retry index; 0 for a user-driven spawn, bumped by the transient-module-load auto-retry.
   */
  create(numSegments, bootAttempt = 0) {
    this.destroy();
    this.bootAttempt = bootAttempt;

    // Ahead of the allocations and the spawn loop: a fractional count throws out
    // of `new Array`, and an illegal one is otherwise only caught by the layout
    // inside each worker — after N module fetches and N WASM instantiations.
    if (!isValidSegmentCount(numSegments)) {
      // `count` is left at the last legal size — it is the only one a rebuild
      // can spawn — and named here, since every recovery path (the faulted
      // setEffect/setResolution rebuilds and the boot retry) passes it back to
      // create() rather than the size that was asked for.
      this.onWorkerFault(FAULT_POOL,
        `invalid segment count ${numSegments}; must be a positive even integer `
        + `— no workers were spawned, and a rebuild will use ${this.count}`);
      return;
    }

    this.count = numSegments;
    this.workers = [];
    this.results = new Array(numSegments).fill(null);
    this.scratch = new Array(numSegments).fill(null);
    this.timings = new Array(numSegments).fill(0);
    this.arenas = new Array(numSegments).fill(null);
    this.fullFrames = new Array(numSegments).fill(false);
    this.frameSeen = new Array(numSegments).fill(false);
    this.paramValues = null;
    const mainEngine = this.getWasmEngine();
    this.presetCount = mainEngine?.getPresetCount?.() ?? null;
    this.presetIndex = mainEngine?.getPresetIndex?.() ?? null;
    this.ready = false;

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
    let readyCount = 0;
    let bootedCount = 0;
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

      worker.onmessage = (e) => {
        const msg = /** @type {ControllerInboundMsg} */ (e.data);
        if (msg.type === 'ready') {
          if (!readied[i]) { readied[i] = true; readyCount++; }
          if (readyCount === numSegments) {
            this.ready = true;
            // A live pool ends the faulted-rebuild run, so the next fault gets a
            // fresh budget.
            this.faultedRebuilds = 0;
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
        } else if (msg.type === 'engineRejected') {
          this.onWorkerFault(i, `worker seg ${i} engine rejected: ${msg.reason}`);
        } else if (msg.type === 'frame') {
          // A halted pool zeroed `pending`; ignore late frames so it can't go negative.
          if (this.faulted) return;
          // This handler belongs to worker `i`, so its frame must carry segId i.
          // The identity check subsumes a range check and rejects NaN/undefined,
          // which would otherwise index `scratch`/`frameSeen` by string key and
          // settle the barrier with a segment absent — publishing a torn frame
          // the recorder counts as real. Staging it is unsafe and dropping it
          // leaves `pending` short until the render watchdog reports a stall
          // that names neither this worker nor the id it sent, so the protocol
          // violation faults here with both.
          if (msg.segId !== i) {
            this.onWorkerFault(i, `worker seg ${i} reported a frame tagged segId `
              + `${String(msg.segId)}; a frame the pool cannot attribute is a `
              + 'protocol violation (stale cached worker or glue)');
            return;
          }
          // Count and stage only the first message from each segment.
          if (this.frameSeen[msg.segId]) return;
          // Generation fence: keep only results from the current resolution; still
          // settle the frame either way.
          if (this.inflightGen === this.renderGen) {
            // Mirror segment 0's live params for GUI sync, inside the fence so a
            // stale-generation frame can't publish params against a new descriptor
            // list.
            if (msg.segId === 0 && msg.paramValues
                && msg.paramRevision === this.paramRevision) {
              this.paramValues = msg.paramValues;
              this.presetCount = msg.presetCount ?? null;
              this.presetIndex = msg.presetIndex ?? null;
            }
            this.scratch[msg.segId] = {
              pixels: msg.pixels,
              x0: msg.x0, x1: msg.x1,
              y0: msg.y0, y1: msg.y1,
            };
            this.timings[msg.segId] = msg.elapsed;
            this.arenas[msg.segId] = msg.arenaMetrics;
            this.fullFrames[msg.segId] = msg.fullFrame === true;
          }
          this.frameSeen[msg.segId] = true;
          this.pending--;
          if (this.pending === 0 && this.frameResolve) {
            this.frameResolve();
            this.frameResolve = null;
          } else if (this.pending > 0) {
            this.armRenderWatchdog();
          }
        } else {
          // The `never` binding makes an unhandled ControllerInboundMsg member a
          // typecheck error rather than a runtime-only fault.
          /** @type {never} */
          const unhandled = msg;
          this.onWorkerFault(i, `worker seg ${i} sent unknown message type `
            + `${String((/** @type {{type?: unknown}} */ (unhandled)).type)}`);
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
          // Tear the failing pool down before the backoff window rather than
          // leaving its survivors instantiating WASM and able to re-enter this
          // path; create() re-destroying is idempotent.
          this.destroy();
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (this.active) this.create(this.count, next);
          }, BOOT_RETRY_DELAY_MS);
          unrefTimer(this.retryTimer);
          return;
        }
        const detail = e?.message
          || `module load failed after ${MAX_BOOT_RETRIES} attempts`
             + ` (commonly a missing or renamed holosphere_wasm.js, or a bare`
             + ` import specifier — a worker resolves its graph without the`
             + ` page's import map)`;
        console.error(`[Segmented] Worker seg ${i} error: ${detail}`
          + ` (${e?.filename}:${e?.lineno}:${e?.colno})`, e);
        this.onWorkerFault(i, detail);
      };
      worker.onmessageerror = (e) => {
        console.error(`[Segmented] Worker seg ${i} message deserialization`
          + ` failed`, e);
        this.onWorkerFault(i, 'message deserialization failed');
      };

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
          paramRevision: this.paramRevision,
          wasmModule: sharedWasmModule ?? undefined,
        });
      } catch (error) {
        this.abortWorkerStartup(i, 'initialization', error);
        return;
      }
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
    unrefTimer(this.bootWatchdog);

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
    unrefTimer(this.initWatchdog);

    console.log(`[Segmented] Spawning ${numSegments} workers...`);
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
    unrefTimer(this.renderWatchdog);
  }

  /**
   * Terminate every worker in the pool, leaving `workers` populated.
   * @details Handlers are detached before terminate() so a message already queued
   * from a surviving worker cannot run against the torn-down pool.
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
   * state to empty. Clears the fault latch, so it doubles as the recovery reset
   * create() runs before rebuilding the pool.
   */
  destroy() {
    this.terminateWorkers();
    this.clearBootWatchdog();
    this.clearInitWatchdog();
    this.clearRenderWatchdog();
    this.clearRetryTimer();
    this.workers = [];
    this.results = [];
    this.scratch = [];
    this.timings = [];
    this.arenas = [];
    this.fullFrames = [];
    this.frameSeen = [];
    this.ready = false;
    this.pending = 0;
    // tick() returns on the !ready guard while the pool respawns, so a stale
    // true here would keep captureReady() green over cleared black frames.
    this.frameComposited = false;
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
   * `tick()` from dispatching another doomed render. The pool is terminated here
   * so its per-worker WASM heaps are released rather than sitting idle until the
   * rebuild, and its handlers are detached so a message already queued from a
   * surviving worker cannot report progress under the fault overlay. `workers`
   * is left populated rather than cleared, so a fault message still reports
   * against the pool that was dispatched to; destroy() clears it on the rebuild.
   * Recovery is by re-creating the pool (effect switch / resolution change /
   * mode toggle), which clears the latch via destroy(); the effect-switch path is
   * bounded by MAX_FAULTED_REBUILDS. Only the first fault per session is recorded
   * for the UI.
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
    this.terminateWorkers();
    this.pending = 0;
    this.renderInFlight = false;
    // Open a new generation before settling: the in-flight render's `.then` would
    // otherwise pass its `inflightGen === renderGen` guard and publish the frame
    // the faulting worker never completed.
    this.renderGen++;
    if (this.frameResolve) {
      const resolve = this.frameResolve;
      this.frameResolve = null;
      resolve();
    }
    // tick() is unreachable while the host is paused and never ran at all for a
    // create()-time fault, so the overlay is painted here rather than left to it.
    this.updateStats();
  }

  /**
   * Snapshot the main engine's accepted and requested parameter values,
   * flattened for structured-clone transport (bools encoded as 1/0). Workers
   * restore the accepted render state first, then replay pending requests.
   * @returns {import('./worker_protocol.js').SegParam[]}
   */
  snapshotParams() {
    const engine = this.getWasmEngine();
    if (!engine) return [];
    const defs = engine.getParameterDefinitions();
    /** @type {Map<string, import('./worker_protocol.js').SegParam>} */
    const params = new Map();
    for (const [name, acceptedValue] of this.acceptedParams) {
      params.set(name, { name, acceptedValue });
    }
    for (let i = 0; i < defs.length; i++) {
      const p = defs[i];
      const requestedValue = /** @type {number|boolean|undefined} */ (p.requestedValue);
      const requested = requestedValue ?? p.value;
      const v = (typeof requested === 'boolean') ? (requested ? 1.0 : 0.0) : requested;
      const acceptedValue = /** @type {number|boolean|undefined} */ (p.acceptedValue);
      const accepted = acceptedValue ?? requested;
      const acceptedV = (typeof accepted === 'boolean')
        ? (accepted ? 1.0 : 0.0) : accepted;
      const entry = params.get(p.name) ?? { name: p.name };
      entry.value = v;
      entry.acceptedValue = acceptedV;
      params.set(p.name, entry);
    }
    return [...params.values()];
  }

  /**
   * Capture the rebuild state for the active effect. ShaderBall owns a complete
   * versioned snapshot; all other effects retain the parameter-list protocol.
   * @returns {{params?: import('./worker_protocol.js').SegParam[],
   *   fullConfigSnapshot?: import('./worker_protocol.js').FullConfigSnapshot}}
   */
  snapshotEffectState() {
    const engine = this.getWasmEngine();
    if (this.appState.get('effect') === 'ShaderBall'
        && typeof engine?.getFullConfigSnapshot === 'function') {
      const snapshot = engine.getFullConfigSnapshot();
      if (snapshot) return { fullConfigSnapshot: snapshot };
    }
    return { params: this.snapshotParams() };
  }

  /** @param {{name: string, value: number}[]} params */
  rememberAcceptedParams(params) {
    for (const parameter of params)
      this.acceptedParams.set(parameter.name, parameter.value);
  }

  resetAcceptedParams() {
    this.acceptedParams.clear();
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
    this.paramRevision++;
    const mainEngine = this.getWasmEngine();
    this.presetCount = mainEngine?.getPresetCount?.() ?? null;
    this.presetIndex = mainEngine?.getPresetIndex?.() ?? null;
    // A faulted pool is broken until re-created; rebuild (active) re-reads the
    // effect and params from appState rather than broadcasting to dead workers.
    // Bounded by MAX_FAULTED_REBUILDS: effect switches can arrive on a timer, and
    // a fault that reproduces on every rebuild would respawn the pool per switch.
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
    // Bump the fence so an in-flight old-effect frame fails inflightGen ===
    // renderGen and can't republish its stale-ordered paramValues.
    this.renderGen++;
    // Drop settled/pending old-effect results too; otherwise a completed
    // old-effect frame composites once or re-blits via the overrun branch,
    // flashing the outgoing effect on switch.
    this.results.fill(null);
    this.pendingFrame = false;
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
    // A faulted pool stays latched: this fires continuously during a slider drag,
    // so rebuilding here would respawn the pool per drag event. Recovery is a
    // resolution/effect change or a mode toggle.
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
    // Recorded before the fault gate so a later rebuild carries the slider value,
    // and the latch is held for the same reason setParameter holds it: this fires
    // continuously during a drag.
    this.poleLod = value;
    if (this.faulted) return;
    this.broadcast({ type: 'setPoleLod', value });
  }

  /**
   * Tell all workers to update resolution, then re-apply the current effect.
   * @details The resize tears the worker's effect down and the engine rejects a
   * clip with no effect, so the trailing setEffect is what restores both. Without
   * it every worker answers 'render' with a correctly-sized, unclipped black
   * frame — a state no fence, watchdog or composite check can detect.
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
    this.paramValues = null;
    this.paramRevision++;
    this.renderGen++;
    this.results.fill(null);
    this.pendingFrame = false;
    // renderInFlight/pending are left intact: the outstanding old-generation
    // render still owns the in-flight latch and releases it via frameResolve;
    // tick() then dispatches the re-render at the new size. A render that never
    // replies is bounded by renderParallel's watchdog, so a resize during a hung
    // frame faults and recovers rather than wedging the pipeline.
    if (!this.broadcast({ type: 'setResolution', w, h })) return;
    this.broadcast({
      type: 'setEffect',
      name: this.appState.get('effect'),
      ...this.snapshotEffectState(),
      paused: this.animationsPaused,
      presetIndex: this.presetIndex ?? undefined,
      paramRevision: this.paramRevision,
    });
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
      // Clear per-segment stats so a segment fenced out (or silent) this frame
      // reports fresh 0/'-' rather than a prior generation's values.
      this.timings.fill(0);
      this.arenas.fill(null);
      this.fullFrames.fill(false);
      this.frameStart = performance.now();
      this.frameResolve = () => {
        this.clearRenderWatchdog();
        this.wallTime = performance.now() - this.frameStart;
        resolve();
      };

      // Dispatched per worker rather than broadcast: each carries back its own
      // retired pixel buffer. `results` holds the live generation and is the only
      // buffer composite() reads, so a `scratch` slot here is two generations old
      // and unreferenced — transferring it away cannot detach a displayed frame.
      // Clearing each slot as it is consumed also keeps a slot left by a
      // fenced-out prior generation out of this one's published frame.
      for (let s = 0; s < this.workers.length; s++) {
        const retired = this.scratch[s];
        this.scratch[s] = null;
        const recycle = retired && retired.pixels && retired.pixels.length > 0
          ? retired.pixels : null;
        try {
          if (recycle) {
            this.post(this.workers[s], { type: 'render', recycle }, [recycle.buffer]);
          } else {
            this.post(this.workers[s], { type: 'render' });
          }
        } catch (error) {
          // Mid-dispatch: the un-posted workers never reply, so `pending` never
          // reaches 0 and no watchdog is armed yet. Fault, which settles the
          // promise and releases the in-flight latch.
          this.scratch.fill(null);
          this.onWorkerFault(s, `render dispatch to seg ${s} failed: `
            + errorDetail(error));
          return;
        }
      }

      this.armRenderWatchdog();
    });
  }

  /**
   * Composite segment results into the display buffer (segment-rectangle model).
   * @returns {number} How many segment rectangles were actually blitted this
   *   call. 0 means either every result was null/empty (a fully-fenced frame),
   *   so the display buffer still holds only driver.render()'s fill(0), or the
   *   pre-pass rejected a segment (out-of-bounds/empty/inverted rect, a
   *   pixel-length mismatch, or a rect that is not that segment's band of the
   *   current layout) and latched a fault. The caller uses this to avoid
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
    // driver.render() re-clears driver.pixels next frame, restoring the elision.
    if (displayAliasesDiverged(this.driver, dst)) {
      if (!this.aliasDivergenceLogged) {
        console.error(
          "SegmentController.composite: display-buffer alias diverged " +
          "from getMemoryView() — re-pointing the display aliases at the " +
          "composite target");
        this.aliasDivergenceLogged = true;
      }
      this.repointDisplayAliases(dst);
    }

    const w = this.driver.W;
    const h = this.driver.H;

    // Iterate the configured segment count (the same source updateStats reads),
    // not results.length, so the two can't drift after a teardown reset.
    const n = this.count;

    const bands = this.segmentBands(n, w, h);
    if (!bands) return 0;

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
      // A rect that is self-consistent but not this segment's band blits a
      // correctly-sized frame into another segment's rows; a worker that missed a
      // setResolution answers under the current generation, so neither the fence
      // nor the checks above see anything wrong.
      const band = bands[s];
      if (r.x0 !== band.x0 || r.x1 !== band.x1
          || r.y0 !== band.y0 || r.y1 !== band.y1) {
        this.onWorkerFault(s,
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is not its band ` +
          `[${band.x0},${band.y0})-[${band.x1},${band.y1}) of the ${n}-segment ` +
          `${w}x${h} layout — a stale-geometry frame would composite into the ` +
          `wrong rows (segment-layout invariant violated)`);
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
      stampBoundaries(dst, w, h, this.boundaryXs, this.boundaryYs);
    }

    return blitted;
  }

  /**
   * The `n` band rectangles of the current layout, cached across frames: segment
   * geometry is fixed within a generation, and renderGen bumps on every change
   * that can move it (resolution, teardown, and the create() a count change runs
   * through). The dimensions are in the key too, so a driver resize that reaches
   * composite() before the fence cannot be served a stale table.
   * @param {number} n - Segment count.
   * @param {number} w - Display buffer width.
   * @param {number} h - Display buffer height.
   * @returns {import('./segment_layout.js').SegRange[] | null} The bands, or
   *   null when the layout admits none, having latched a fault.
   */
  segmentBands(n, w, h) {
    if (this.bands && this.bandGen === this.renderGen && this.bandCount === n
        && this.bandW === w && this.bandH === h) {
      return this.bands;
    }
    const bands = new Array(n);
    for (let s = 0; s < n; s++) {
      try {
        bands[s] = computeSegmentRange(s, n, w, h);
      } catch (error) {
        this.onWorkerFault(s,
          `SegmentController.composite: no segment-${s} band exists for a ` +
          `${n}-segment ${w}x${h} display buffer — ${errorDetail(error)}`);
        return null;
      }
    }
    this.bands = bands;
    this.bandGen = this.renderGen;
    this.bandCount = n;
    this.bandW = w;
    this.bandH = h;
    return bands;
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

  /**
   * Repaint the per-segment stats overlay from this controller's published state.
   * @returns {void}
   */
  updateStats() {
    this.statsView.update(this);
  }

  /**
   * Whether `results` holds a published generation the overrun path can re-blit.
   * An indexed loop rather than Array.some: this runs on every tick a render
   * overruns.
   * @returns {boolean} True when at least one segment carries pixels.
   */
  hasPublishedFrame() {
    for (let s = 0; s < this.results.length; s++) {
      const r = this.results[s];
      if (r && r.pixels) return true;
    }
    return false;
  }

  /**
   * Whether the worker pool owns the display buffer: it is either rendering
   * (ready) or holding the fault overlay. False while a pool spawns, when the
   * host keeps painting with the main-thread engine instead of leaving the
   * driver's cleared buffer on screen for the whole warm + spawn window.
   * @returns {boolean}
   */
  get ownsDisplay() {
    return this.active && (this.ready || this.faulted);
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
      // Only a whole generation is a frame: a band left black by a missing slot
      // would otherwise be recorded as one.
      this.frameComposited = blitted === this.count;
    } else if (this.hasPublishedFrame()) {
      // Render overran this tick: re-blit the last published frame over driver's
      // clear so the preview holds it instead of flashing black. `results` is only
      // ever swapped whole, so this composites one coherent generation. Not a new
      // frame, so frameComposited stays false — the recorder must not capture a
      // duplicate. Stats are left showing the last landed generation: the next
      // render has already zeroed the per-segment arrays this tick.
      this.composite();
      this.frameComposited = false;
    } else {
      this.frameComposited = false;
    }

    // composite() can latch a fault via its bounds/length pre-pass; bail before
    // dispatching a render to the just-halted pool. The overrun branch skips the
    // updateStats() its sibling runs, so paint the overlay here rather than a
    // tick late.
    if (this.faulted) {
      this.updateStats();
      return;
    }

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
      }).catch((error) => {
        // A rejected chain would skip the `.then` above and strand renderInFlight
        // latched true with no watchdog armed, wedging the pipeline silently.
        this.onWorkerFault(FAULT_RENDER, `render failed: ${errorDetail(error)}`);
      });
    }
  }
}
