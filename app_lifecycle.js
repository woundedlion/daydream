/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The composition root's frame, timer, and teardown wiring: the display-buffer
 * aliases every renderer writes through, the per-frame adapter the driver calls,
 * the Test All walk, the shared notice element, the segmented pool's spawn epoch,
 * and the dispose path a page discard runs. Every collaborator is injected, so
 * the alias heal, the segmented/single-engine frame split, the spawn protocol,
 * the notice ownership, and the teardown order are unit-testable without
 * Three.js, a WASM engine, or a browser.
 */

import { errorDetail } from './tools/banner.js';

/**
 * The driver's display aliases: the Three.js instance-colour attribute and the
 * driver's own pixel handle, both of which must reference the WASM view.
 * @typedef {Object} DisplayDriver
 * @property {{instanceColor: {array: Uint16Array|null, needsUpdate: boolean}}} dotMesh
 * @property {Uint16Array|null} pixels
 */

/**
 * Re-point both display aliases (Three.js instanceColor + driver.pixels) so
 * source, displayed attribute, and driver.pixels all reference the same WASM
 * view. Shared by EngineHost.refresh(), the frame adapter's alias heal, and
 * SegmentController's composite heal.
 * @param {DisplayDriver} driver - The Daydream driver owning the dot mesh.
 * @param {Uint16Array} view - The WASM pixel view to alias.
 * @returns {void}
 */
export function repointDisplayAliases(driver, view) {
  driver.dotMesh.instanceColor.array = view;
  driver.dotMesh.instanceColor.needsUpdate = true;
  driver.pixels = view;
}

/**
 * Whether either display alias has stopped referencing the engine's pixel view.
 * @param {DisplayDriver} driver - The Daydream driver owning the dot mesh.
 * @param {Uint16Array} view - The view both aliases must reference.
 * @returns {boolean} True when at least one alias points elsewhere.
 */
export function displayAliasesDiverged(driver, view) {
  return driver.pixels !== view
    || driver.dotMesh.instanceColor.array !== view;
}

/**
 * Build the per-frame adapter the driver's render loop calls.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{engine: {drawFrame: () => void, getArenaMetrics: () => Object},
 *   refresh: () => boolean, view: () => Uint16Array|null}} deps.host - The EngineHost
 *   owning the main engine and its view.
 * @param {DisplayDriver} deps.driver - The Daydream driver.
 * @param {{ownsDisplay: boolean, active: boolean, frameComposited: boolean,
 *   tick: () => void, updateStats: () => void}} deps.segments - The SegmentController.
 * @param {(advanced: boolean) => void} deps.syncEffectGui - Mirrors engine params
 *   into the panel, told whether the simulation stepped this frame.
 * @param {(message: string) => void} [deps.logError] - Console sink for the
 *   once-per-page alias divergence report.
 * @returns {{drawFrame: () => void, sync: (advanced: boolean) => void,
 *   getArenaMetrics: () => Object|null, captureReady: () => boolean}} The adapter.
 */
export function createRenderAdapter({
  host,
  driver,
  segments,
  syncEffectGui,
  logError = (message) => console.error(message),
}) {
  let aliasDivergenceLogged = false;
  return {
    /**
     * Per-frame entry the driver calls: render (segmented or single-engine),
     * then republish the pixel view.
     * @returns {void}
     */
    drawFrame() {
      if (segments.ownsDisplay) {
        // Composite the previous frame (overwriting driver.render()'s cleared
        // buffer) and dispatch the next.
        segments.tick();
      } else {
        // A pool that is still spawning paints nothing; keep rendering here so
        // the sphere stays live, and report the spawn in the segment overlay.
        if (segments.active) segments.updateStats();
        host.engine.drawFrame();
        host.refresh();
        // All three aliases must point at the one WASM view; log once and
        // re-point rather than throw (throwing here halts the render loop).
        const view = host.view();
        if (view === null) return;
        if (displayAliasesDiverged(driver, view)) {
          if (!aliasDivergenceLogged) {
            logError(
              "drawFrame: display-buffer alias diverged after host.refresh() — " +
              "re-pointing driver.pixels / instanceColor.array at the WASM view");
            aliasDivergenceLogged = true;
          }
          repointDisplayAliases(driver, view);
        }
      }
    },
    /**
     * Mirror engine parameters into the effect panel.
     * @param {boolean} advanced - Whether the simulation stepped this frame.
     * @returns {void}
     */
    sync(advanced) {
      syncEffectGui(advanced);
    },
    /**
     * Report the engine's current arena allocation metrics for the driver's HUD.
     * @returns {?Object} The main engine's arena metrics, or null once the
     *   worker pool owns the display and the main engine is idle, where the HUD
     *   reads per-segment worker stats instead.
     */
    getArenaMetrics() {
      return segments.ownsDisplay ? null : host.engine.getArenaMetrics();
    },
    /**
     * Whether the buffer holds a real frame the recorder may capture this tick.
     * The single-engine path always renders the full canvas in drawFrame();
     * a pool that owns the display composites a frame late, so report false until
     * (and on any tick where) a composite has not landed — otherwise the recorder
     * captures the cleared (black) buffer left by driver.render()'s fill(0).
     * @returns {boolean} True when the displayed buffer is a real rendered frame.
     */
    captureReady() {
      return segments.ownsDisplay ? segments.frameComposited : true;
    }
  };
}

/**
 * Wire the page-discard teardown and register its pagehide listener.
 *
 * Order is the contract: the state subscription is released before the GUI and
 * scene teardown (a later set() would otherwise re-enter the apply path against
 * a disposed renderer), the engine host is released before driver.dispose()
 * drops the WebGL context the recorder captures its stream from, and the pool is
 * stranded before it is destroyed.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{addEventListener: Function, removeEventListener: Function}}
 *   deps.pageTarget - Where the page listeners live (the window).
 * @param {Array<[string, Function, {removeEventListener: Function}?]>}
 *   deps.listeners - Listeners the app installed, removed from their optional
 *   owner target or pageTarget on dispose.
 * @param {{dispose: Function}} deps.switches - The switch coordinator.
 * @param {() => void} deps.stopTimers - Stops the app's interval timers.
 * @param {{destroy: Function}} deps.effectGui - The effect panel controller.
 * @param {{dispose: Function}|null} [deps.shaderDocuments] - The workbench
 *   document controller, when this is the authoring route.
 * @param {{destroy: Function}} deps.globalGui - The global GUI root.
 * @param {{dispose: Function}} deps.host - The EngineHost owning engine,
 *   adapter, and recorder.
 * @param {{dispose: Function}} deps.urlSync - The URL writer.
 * @param {{dispose: Function}} deps.sidebar - The effect sidebar.
 * @param {{dispose: Function}} deps.driver - The Daydream driver.
 * @param {{active: boolean, dispose: Function}} deps.segments - The pool, released
 *   through dispose() so the page discard also drops the warmer's held
 *   compilation, which destroy() keeps for the next pool the page builds.
 * @param {() => void} deps.strandSegmentWork - Bumps the segmented epoch so an
 *   in-flight spawn continuation cannot land in a discarded page.
 * @param {() => void} deps.removeOverlay - Removes the app's canvas overlays.
 * @param {(message: string, error?: any) => void} [deps.logError] - Console sink
 *   for a step that threw.
 * @returns {{dispose: () => void, onPageHide: (e: {persisted?: boolean}) => void,
 *   disposed: () => boolean}}
 */
export function createAppTeardown({
  pageTarget,
  listeners,
  switches,
  stopTimers,
  effectGui,
  shaderDocuments = null,
  globalGui,
  host,
  urlSync,
  sidebar,
  driver,
  segments,
  strandSegmentWork,
  removeOverlay,
  logError = (...args) => console.error(...args),
}) {
  let appDisposed = false;

  /**
   * Run one release step. dispose() latches before the first step and runs once,
   * so a step that throws would otherwise strand every later release — the URL
   * debounce still armed on a dead page, the WebGL context (the browser caps
   * them near 16) still held, the worker pool still spawning — with no retry
   * left. Each step is independent of the others' success, so a failure is
   * reported and the rest still run.
   * @param {string} what - Names the step in the log line.
   * @param {() => void} step - The release to attempt.
   * @returns {void}
   */
  function release(what, step) {
    try {
      step();
    } catch (error) {
      logError(`Teardown: ${what} failed:`, error);
    }
  }

  /**
   * Release the listeners, timers, and worker pool the app owns so a page
   * discard leaves nothing firing into a dead scene. Symmetric with
   * Daydream.dispose() and EffectSidebar.dispose().
   * @returns {void}
   */
  function dispose() {
    if (appDisposed) return;
    appDisposed = true;
    for (const [type, handler, target = pageTarget] of listeners) {
      release(`removing the ${type} listener`,
        () => target.removeEventListener(type, handler));
    }
    release('removing the pagehide listener',
      () => pageTarget.removeEventListener("pagehide", onPageHide));
    release('the switch coordinator', () => switches.dispose());
    release('the app timers', stopTimers);
    release('the effect panel', () => effectGui.destroy());
    release('the shader document controller', () => shaderDocuments?.dispose());
    release('the global GUI', () => globalGui.destroy());
    release('the engine host', () => host.dispose());
    release('the URL writer', () => urlSync.dispose());
    release('the sidebar', () => sidebar.dispose());
    release('the driver', () => driver.dispose());
    // Strand any in-flight warmModules() continuation: its post-await guard reads
    // both, so without this it spawns a worker pool into the discarded page.
    release('clearing the segmented-mode flag', () => { segments.active = false; });
    release('stranding the segment spawn', strandSegmentWork);
    release('the segment pool', () => segments.dispose());
    release('the canvas overlays', removeOverlay);
  }

  /**
   * pagehide (not unload) so bfcache is respected: e.persisted is false only on
   * a real discard, true when merely frozen for back/forward cache.
   * @param {{persisted?: boolean}} e - The pagehide event.
   * @returns {void}
   */
  function onPageHide(e) {
    if (!e.persisted) dispose();
  }

  pageTarget.addEventListener("pagehide", onPageHide);

  return { dispose, onPageHide, disposed: () => appDisposed };
}

// Elements that own their keystrokes: a key landing inside one belongs to that
// control, not to the global shortcuts.
export const INTERACTIVE_KEY_TARGET =
  'input, textarea, select, button, [contenteditable], .lil-gui, .effect-sidebar';

/**
 * Build the window keydown handler for the global playback shortcuts.
 *
 * A key typed into a GUI control, the sidebar, or any text field is that
 * element's, so it never also drives the simulation. The target is only a node
 * for a key that landed in the document; anything else falls through to the
 * shortcuts.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {(e: KeyboardEvent) => void} deps.dispatch - Runs the shortcut.
 * @returns {(e: KeyboardEvent) => void} The handler.
 */
export function createGlobalKeydownHandler({ dispatch }) {
  return (e) => {
    const target = /** @type {Element|null} */ (e.target);
    if (typeof target?.closest === 'function'
        && target.closest(INTERACTIVE_KEY_TARGET)) return;
    dispatch(e);
  };
}

/**
 * Bind the Pole LOD control to an engine that does not exist yet.
 *
 * DeepLinkGUI replays a URL-hydrated control's onChange at registration, during
 * module evaluation, while the engine is still null — so the value's only
 * durable home is this state, and replay() is what carries it (deep-linked or
 * default) into the engine the module load builds.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => ?{setPoleLod: (v: number) => void}} deps.getEngine - Reads the
 *   main engine, null until the module load resolves.
 * @param {() => void} deps.onChange - Invalidates the scene after a change.
 * @returns {{state: {poleLod: number}, apply: (v: number) => void,
 *   replay: () => void}} The GUI-bound state object, the control's onChange
 *   sink, and the post-load replay.
 */
export function createPoleLodBinding({ getEngine, onChange }) {
  // Near-pole azimuthal shading decimation. 1.0 is the physically-neutral
  // setting: one shade per run of columns sharing an LED footprint. Higher
  // trades fidelity for render time; 0 disables.
  const state = { poleLod: 0 };
  return {
    state,
    apply(value) {
      state.poleLod = value;
      getEngine()?.setPoleLod(value);
      onChange();
    },
    replay() {
      getEngine()?.setPoleLod(state.poleLod);
    },
  };
}

/**
 * Build the recording settings the GUI binds to, over a recorder that does not
 * exist yet.
 *
 * The recorder is constructed only once the module load resolves and the canvas
 * exists, but the GUI mounts at module scope — so each setting holds its own
 * value behind an accessor, pushes it at every write, and replay() carries
 * whatever accumulated (deep-linked or default) into the recorder the load
 * builds. The recorder latches these at start(), so a write during a session is
 * reported rather than silently deferred to the next one.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => ?{isRecording: boolean}} deps.getRecorder - Reads the live
 *   recorder, null until the module load resolves.
 * @param {(message: string) => void} [deps.warn] - Sink for the mid-recording
 *   notice.
 * @returns {{settings: Object, define: (prop: string, initial: *, label: string,
 *   push: (recorder: Object, value: *) => void) => void, replay: () => void}}
 *   The GUI-bound settings object, the per-setting definer, and the post-load
 *   replay.
 */
export function createRecordingSettings({
  getRecorder,
  warn = (message) => console.warn(message),
}) {
  /** @type {Object} */
  const settings = {};
  /** @type {Array<() => void>} */
  const replays = [];
  return {
    settings,
    define(prop, initial, label, push) {
      let value = initial;
      Object.defineProperty(settings, prop, {
        enumerable: true,
        get: () => value,
        set(v) {
          value = v;
          const recorder = getRecorder();
          if (recorder) push(recorder, v);
          if (recorder?.isRecording) {
            warn(`Recording: ${label} change applies to the next recording `
              + '(the current one is already running).');
          }
        },
      });
      // Unguarded: replay() runs immediately after the recorder is constructed,
      // and a null-tolerant replay would drop every setting in silence.
      replays.push(() => push(/** @type {Object} */ (getRecorder()), value));
    },
    replay() {
      for (const push of replays) push();
    },
  };
}

/**
 * Build the "Test All" ticker: the timer that walks the current resolution's
 * effect list, one entry per interval.
 *
 * The index is the ticker's own, not one re-derived from the live effect: a
 * rejected switch reverts the state to the predecessor, so re-deriving would
 * recompute the same rejected slot forever. The list is re-read every tick, so a
 * resolution change mid-walk continues through what the new one offers.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {number} deps.intervalMs - Dwell time per effect.
 * @param {() => Array<string>} deps.availableEffects - The effect list the active
 *   resolution offers.
 * @param {() => string} deps.getEffect - The live effect name, where the walk starts.
 * @param {(name: string) => void} deps.setEffect - Requests the next effect.
 * @param {() => boolean} deps.engineReady - Whether an engine exists to take a
 *   switch; a tick before the module load lands is skipped, not queued.
 * @param {(fn: () => void, ms: number) => any} [deps.schedule] - Timer source.
 * @param {(handle: any) => void} [deps.cancel] - Timer sink.
 * @returns {{start: () => void, stop: () => void, running: () => boolean}} The
 *   ticker; start() is idempotent, so a re-entered toggle cannot arm two timers.
 */
export function createTestAllTicker({
  intervalMs,
  availableEffects,
  getEffect,
  setEffect,
  engineReady,
  schedule = (fn, ms) => setInterval(fn, ms),
  cancel = (handle) => clearInterval(handle),
}) {
  /** @type {any} */
  let handle = null;
  let index = 0;

  const tick = () => {
    if (!engineReady()) return;
    const list = availableEffects();
    if (list.length === 0) return;
    index = (index + 1) % list.length;
    setEffect(list[index]);
  };

  return {
    start() {
      if (handle !== null) return;
      // -1 for an effect off the list, so the first advance starts at its head.
      index = availableEffects().indexOf(getEffect());
      handle = schedule(tick, intervalMs);
    },
    stop() {
      if (handle === null) return;
      cancel(handle);
      handle = null;
    },
    running: () => handle !== null,
  };
}

// Dwell time before a notice self-clears, so a stale rejection cannot outlive
// the action that raised it.
const APPLY_NOTICE_MS = 8000;

/**
 * Build the page's notice sink over the shared apply-notice element.
 *
 * Several subsystems announce through that one element, so every write names an
 * owner: raising takes the element over, but a clear lands only when the caller
 * owns the notice on screen. A parameter write during a slider drag therefore
 * leaves a switch rejection standing instead of erasing the only explanation the
 * user was given.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {Document} deps.doc - Document holding the notice elements.
 * @param {number} [deps.timeoutMs] - Dwell time before a notice self-clears.
 * @param {(fn: () => void, ms: number) => any} [deps.schedule] - Timer source.
 * @param {(handle: any) => void} [deps.cancel] - Timer sink.
 * @param {(message: string) => void} [deps.logWarning] - Sink for the
 *   one-shot report that the notice elements are absent.
 * @returns {{show: (message: string|null, owner: string) => void,
 *   clear: () => void, owner: () => string|null}} The sink. clear() drops the
 *   notice whoever raised it, for the dismiss button and the page teardown;
 *   owner() reports who holds the element.
 */
export function createApplyNotice({
  doc,
  timeoutMs = APPLY_NOTICE_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  logWarning = (message) => console.warn(message),
}) {
  /** @type {{body: HTMLElement, text: HTMLElement}|null} */
  let elements = null;
  let missLogged = false;
  /** @type {any} */
  let handle = null;
  /** @type {string|null} */
  let held = null;

  // Latched only once both elements are present, so markup that arrives after
  // construction still gets its notices; the absence is reported once rather
  // than dropping every rejection message unremarked.
  const resolve = () => {
    if (elements) return elements;
    const found = {
      body: doc.getElementById('apply-notice-body'),
      text: doc.getElementById('apply-notice-text'),
    };
    if (found.body && found.text) {
      elements = { body: found.body, text: found.text };
      return elements;
    }
    if (!missLogged) {
      missLogged = true;
      const missing = Object.entries(found)
        .filter(([, el]) => !el).map(([part]) => `apply-notice-${part}`);
      logWarning(
        `Apply-notice elements absent from the document (${missing.join(', ')}); `
        + 'rejection and fallback messages are not shown until they appear.');
    }
    return null;
  };

  const write = (
    /** @type {string|null} */ notice, /** @type {string|null} */ owner) => {
    const el = resolve();
    if (!el) return;
    const { body, text } = el;
    if (handle !== null) cancel(handle);
    handle = null;
    held = notice === null ? null : owner;
    // Hidden content sits outside the accessibility tree, so the text has to
    // land in an already-exposed body: unhide before writing, hide before
    // clearing. Writing first leaves the unhide as the only mutation assistive
    // tech sees, which is not reliably announced.
    body.hidden = notice === null;
    text.textContent = notice ?? '';
    if (notice !== null) handle = schedule(() => expire(owner), timeoutMs);
  };

  // Hiding the body takes the dismiss button inside it out of the tree and drops
  // keyboard focus to <body>, so the dwell is served again while the user stands
  // on it. Only the self-clear waits; an explicit clear() is the user's own act.
  const expire = (/** @type {string|null} */ owner) => {
    if (elements?.body.contains?.(doc.activeElement)) {
      handle = schedule(() => expire(owner), timeoutMs);
      return;
    }
    write(null, owner);
  };

  return {
    show(message, owner) {
      const notice = message || null;
      if (notice === null && held !== null && held !== owner) return;
      write(notice, owner);
    },
    clear: () => write(null, null),
    owner: () => held,
  };
}

/**
 * Build the segmented pool's spawn guard.
 *
 * Spawning awaits a module warm-up, so a toggle burst can leave several
 * continuations in flight at once. Each attempt takes an epoch before the await
 * and spawns only if no later attempt or strand() superseded it and segmented
 * mode is still on — an on/off/on burst therefore builds one pool, not two, and
 * a page discard or a pool failure strands whatever is still awaiting.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => Promise<*>} deps.warmModules - Primes the worker module cache
 *   before the spawn burst.
 * @param {() => void} deps.spawn - Builds the pool at the requested size.
 * @param {() => boolean} deps.isActive - Whether segmented mode is still on.
 * @returns {{respawn: () => Promise<boolean>, strand: () => void}} The guarded
 *   spawn, resolving to whether it landed, and the stranding bump. A rejecting
 *   warm-up or a throwing spawn propagates, leaving the caller to run its
 *   fallback; the app's own warmModules is best-effort and never rejects.
 */
export function createSegmentSpawnGuard({ warmModules, spawn, isActive }) {
  let epoch = 0;
  return {
    async respawn() {
      const mine = ++epoch;
      await warmModules();
      if (mine !== epoch || !isActive()) return false;
      spawn();
      return true;
    },
    strand() { epoch++; },
  };
}

/**
 * Build the segmented pool's fallback to the single-thread engine.
 *
 * Ordered: the flag goes false before the strand and the teardown, so a
 * warmModules() continuation still in flight reads an inactive host after its
 * await and cannot spawn a pool behind the engine the app has fallen back to.
 * The toggle is corrected last, since its own onChange re-runs the (idempotent)
 * teardown.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{active: boolean, destroy: () => void, updateStats: () => void}} deps.segments -
 *   The segment controller.
 * @param {() => void} deps.strand - Bumps the spawn epoch.
 * @param {(message: string) => void} deps.showNotice - Reports the fallback;
 *   without it the only symptom is the toggle flipping back, which reads as a
 *   mis-click, and the fault banner covers latched runtime faults, not this path.
 * @param {(on: boolean) => void} deps.showToggle - Writes the Enabled control
 *   through setValue (not updateDisplay), so the deep-link writer drops
 *   segmented=true from the URL.
 * @param {(message: string, err: *) => void} [deps.logError] - Console sink.
 * @returns {(label: string, err: *) => void} The fallback, taking what failed
 *   (named in the log line and the notice) and the thrown value.
 */
export function createSegmentedFallback({
  segments,
  strand,
  showNotice,
  showToggle,
  logError = (message, err) => console.error(message, err),
}) {
  return (label, err) => {
    logError(`Segmented POV: ${label} failed; falling back to the single engine.`,
      err);
    showNotice(`Segmented POV ${label} failed: ${errorDetail(err)}. `
      + 'Falling back to the single engine.');
    segments.active = false;
    strand();
    segments.destroy();
    segments.updateStats();
    showToggle(false);
  };
}

// Consecutive clean frames that re-arm the render-loop guard's report, about a
// second of rendering at display rate.
export const FRAME_GUARD_REARM_FRAMES = 60;

/**
 * Wrap the render loop's per-frame body so a throw cannot freeze the page, and
 * stop the loop for good once the engine module reports itself dead.
 *
 * Three.js re-arms requestAnimationFrame only after the callback returns, so an
 * escaping throw stops the loop for the page's lifetime, silently and with the
 * last frame still on screen. Catching keeps the loop armed and keeps calling
 * the body: a failure is often per-frame state the next frame clears, and an
 * effect or resolution switch runs from an event handler, outside the loop, so
 * the user can still drive the app back to something that renders. A failure is
 * logged and banner-reported once, then not again until FRAME_GUARD_REARM_FRAMES
 * consecutive frames have rendered cleanly — a body throwing every frame (or
 * every other one) would otherwise report at display rate, while a latch that
 * never re-armed would swallow a later, unrelated failure for the page's
 * lifetime.
 *
 * A dead module outranks that re-arm. Its trap unwound nothing, so the frames
 * that follow are plausible rather than correct and need not throw at all — the
 * clean run that re-arms the report is exactly what a trapped module produces.
 * moduleDead() is therefore polled after every frame, throwing or not, and what
 * it reports is terminal: the body is never called again, no later clean frame
 * retracts the banner, and onModuleDead() releases the app so the page stops
 * presenting output it cannot stand behind.
 *
 * @param {Object} deps - Injected collaborators.
 * @param {() => void} deps.frame - The per-frame body.
 * @param {(message: string) => void} deps.report - Renders the failure banner.
 * @param {(...args: *) => void} [deps.logError] - Console sink for the throw.
 * @param {() => boolean} [deps.moduleDead] - Reads the engine module's death
 *   flag; polled once per frame, so it has to stay a cheap read.
 * @param {() => void} [deps.onModuleDead] - Releases the app once the module is
 *   dead. Runs after the banner, which the release leaves standing.
 * @returns {() => void} The guarded callback for setAnimationLoop.
 */
export function createFrameLoopGuard({
  frame,
  report,
  logError = console.error,
  moduleDead = () => false,
  onModuleDead = () => {},
}) {
  let reported = false;
  let clean = 0;
  let dead = false;

  /**
   * Poll the module's death flag and, the first time it reads dead, latch it:
   * banner, release, no further frames.
   * @returns {void}
   */
  function checkDead() {
    if (dead || !moduleDead()) return;
    // Latched before the release, so a release that throws still leaves the
    // loop stopped rather than resuming into a dead module.
    dead = true;
    logError('Render loop stopped: the rendering engine trapped.');
    report('The rendering engine hit an unrecoverable internal error and has'
      + ' been shut down. Reload the page to start it again. See the browser'
      + ' console for details.');
    onModuleDead();
  }

  return () => {
    if (dead) return;
    try {
      frame();
      if (reported && ++clean >= FRAME_GUARD_REARM_FRAMES) {
        reported = false;
        clean = 0;
      }
    } catch (e) {
      clean = 0;
      if (!reported) {
        reported = true;
        logError('Render loop frame failed:', e);
        report(`The render loop hit an error. ${errorDetail(e)}`
          + ' See the browser console for details.');
      }
    }
    checkDead();
  };
}

// Deadline for the main-thread WASM module load: fetch of the multi-megabyte
// binary plus glue, instantiate, and the module's own runtime init. Sized well
// above the segmented pool's INIT_WATCHDOG_MS, which bounds the same binary in a
// worker but only after its boot ping has already proved the connection; nothing
// precedes this one, so it has to cover a cold, throttled first fetch. A stalled
// fetch fires no error of its own, so without this the loading overlay spins for
// the page's lifetime.
export const MODULE_LOAD_DEADLINE_MS = 90000;

/**
 * Race a module load against a deadline, so a fetch that stalls rather than
 * failing still reaches the load-failure path.
 *
 * The timer is cleared once the race settles, so a load that beats the deadline
 * leaves nothing pending; the deadline promise then never rejects. A load that
 * loses the race stays attached to the race, so its own later rejection is
 * handled rather than escaping as an unhandled one.
 *
 * @param {() => Promise<Object>} load - Starts the module load.
 * @param {Object} [deps] - Injected collaborators.
 * @param {number} [deps.ms] - The deadline, in milliseconds.
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] - Timer
 *   source; the page (or, under test, whatever stands in for it).
 * @returns {Promise<Object>} The loaded module, or a rejection carrying the
 *   deadline that expired or whatever load() raised — a synchronous throw
 *   included, so every failure reaches the caller through the same catch.
 */
export function loadWithDeadline(load, {
  ms = MODULE_LOAD_DEADLINE_MS,
  timers = globalThis,
} = {}) {
  /** @type {any} */
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = timers.setTimeout(() => reject(new Error(
      `The rendering engine did not load within ${Math.round(ms / 1000)} seconds.`)), ms);
    // No-op in browsers; keeps an unfired deadline from holding the unit-test
    // process open.
    timer?.unref?.();
  });
  // A synchronous throw from load() would escape before the race is built,
  // leaving the deadline armed to reject unhandled long after the failure UI is
  // up. Routed into the same rejection every other failure takes.
  let started;
  try {
    started = load();
  } catch (err) {
    timers.clearTimeout(timer);
    return Promise.reject(err);
  }
  return Promise.race([started, deadline])
    .finally(() => timers.clearTimeout(timer));
}

/**
 * Build the handlers for the main WASM module promise, guarded against a page
 * discard that settles first.
 *
 * The teardown's pagehide listener is registered during module evaluation, so a
 * discard can win the race with the module load. Startup is skipped once the app
 * is disposed; a disposal that lands while startup is running instead releases
 * what startup built, since dispose() runs once and will not revisit it. A load
 * failure disposes the app so no listener or animation loop outlives the
 * failure UI.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => ?{dispose: Function, disposed: () => boolean}} deps.teardown -
 *   Reads the app teardown, which the composition root builds after these
 *   handlers, and reads null when module evaluation never got that far.
 * @param {(module: Object) => void} deps.start - Brings the app up on the
 *   loaded module.
 * @param {() => void} deps.discardStartup - Releases the engine, recorder, and
 *   adapter start() built when disposal won the race.
 * @param {(err: *) => void} deps.reportFailure - Renders the load-failure UI.
 * @returns {{onModuleReady: (module: Object) => void,
 *   onModuleFailed: (err: *) => void}} The fulfillment and rejection handlers.
 */
export function createModuleLoadHandlers({
  teardown,
  start,
  discardStartup,
  reportFailure,
}) {
  const disposed = () => teardown()?.disposed() === true;
  return {
    onModuleReady(module) {
      if (disposed()) return;
      start(module);
      if (disposed()) discardStartup();
    },
    onModuleFailed(err) {
      if (disposed()) return;
      reportFailure(err);
      teardown()?.dispose();
    },
  };
}
