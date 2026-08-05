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

/**
 * Re-point both display aliases (Three.js instanceColor + driver.pixels) so
 * source, displayed attribute, and driver.pixels all reference the same WASM
 * view. Shared by EngineHost.refresh(), the frame adapter's alias heal, and
 * SegmentController's composite heal.
 * @param {Object} driver - The Daydream driver owning the dot mesh.
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
 * @param {Object} driver - The Daydream driver owning the dot mesh.
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
 * @param {Object} deps.host - The EngineHost owning the main engine and its view.
 * @param {Object} deps.driver - The Daydream driver.
 * @param {Object} deps.segments - The SegmentController.
 * @param {() => void} deps.syncEffectGui - Mirrors engine params into the panel.
 * @param {(message: string) => void} [deps.logError] - Console sink for the
 *   once-per-page alias divergence report.
 * @returns {{drawFrame: () => void, getArenaMetrics: () => Object|null,
 *   captureReady: () => boolean}} The adapter.
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
     * republish the pixel view, then mirror engine params back into the GUI.
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
        if (displayAliasesDiverged(driver, view)) {
          if (!aliasDivergenceLogged) {
            logError(
              "drawFrame: display-buffer alias diverged after host.refresh() — " +
              "re-pointing driver.pixels / instanceColor.array at the WASM view");
            aliasDivergenceLogged = true;
          }
          repointDisplayAliases(driver, view);
        }
        driver.dotMesh.instanceColor.needsUpdate = true;
      }
      syncEffectGui();
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
 * a disposed renderer), the pool is stranded before it is destroyed, and the
 * render adapter is nulled before the engine handle is deleted so a frame
 * outliving setAnimationLoop(null) cannot reach a freed engine.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{addEventListener: Function, removeEventListener: Function}}
 *   deps.pageTarget - Where the page listeners live (the window).
 * @param {Array<[string, Function]>} deps.listeners - Window listeners the app
 *   installed, removed on dispose.
 * @param {{dispose: Function}} deps.switches - The switch coordinator.
 * @param {() => void} deps.stopTimers - Stops the app's interval timers.
 * @param {{destroy: Function}} deps.effectGui - The effect panel controller.
 * @param {{destroy: Function}} deps.globalGui - The global GUI root.
 * @param {Object} deps.host - The EngineHost owning engine, adapter, recorder.
 * @param {{dispose: Function}} deps.urlSync - The URL writer.
 * @param {{dispose: Function}} deps.sidebar - The effect sidebar.
 * @param {{dispose: Function}} deps.driver - The Daydream driver.
 * @param {{active: boolean, destroy: Function}} deps.segments - The pool.
 * @param {() => void} deps.strandSegmentWork - Bumps the segmented epoch so an
 *   in-flight spawn continuation cannot land in a discarded page.
 * @param {() => void} deps.removeOverlay - Removes the app's canvas overlays.
 * @returns {{dispose: () => void, onPageHide: (e: {persisted?: boolean}) => void,
 *   disposed: () => boolean}}
 */
export function createAppTeardown({
  pageTarget,
  listeners,
  switches,
  stopTimers,
  effectGui,
  globalGui,
  host,
  urlSync,
  sidebar,
  driver,
  segments,
  strandSegmentWork,
  removeOverlay,
}) {
  let appDisposed = false;

  /**
   * Release the listeners, timers, and worker pool the app owns so a page
   * discard leaves nothing firing into a dead scene. Symmetric with
   * Daydream.dispose() and EffectSidebar.dispose().
   * @returns {void}
   */
  function dispose() {
    if (appDisposed) return;
    appDisposed = true;
    for (const [type, handler] of listeners) {
      pageTarget.removeEventListener(type, handler);
    }
    pageTarget.removeEventListener("pagehide", onPageHide);
    switches.dispose();
    stopTimers();
    effectGui.destroy();
    globalGui.destroy();
    // Best-effort on a real discard: dispose() ends the MediaRecorder and
    // releases the stream/offscreen, but its async onstop download cannot be
    // flushed synchronously here, so an in-progress recording may be lost.
    host.recorder?.dispose();
    urlSync.dispose();
    sidebar.dispose();
    driver.dispose();
    // Strand any in-flight warmModules() continuation: its post-await guard reads
    // both, so without this it spawns a worker pool into the discarded page.
    segments.active = false;
    strandSegmentWork();
    segments.destroy();
    removeOverlay();
    host.adapter = null;
    host.engine?.delete();
    host.engine = null;
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
    const target = e.target;
    if (target instanceof Element && target.closest(INTERACTIVE_KEY_TARGET)) return;
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
 * @param {(fn: Function, ms: number) => *} [deps.schedule] - Timer source.
 * @param {(handle: *) => void} [deps.cancel] - Timer sink.
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
  let handle = null;
  // -1 until the first advance when the live effect is off the list, so the walk
  // starts at its head.
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
 * user was given. The element references are resolved once, at construction.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {Object} deps.doc - Document holding the notice elements.
 * @param {number} [deps.timeoutMs] - Dwell time before a notice self-clears.
 * @param {(fn: Function, ms: number) => *} [deps.schedule] - Timer source.
 * @param {(handle: *) => void} [deps.cancel] - Timer sink.
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
}) {
  const body = doc.getElementById('apply-notice-body');
  const text = doc.getElementById('apply-notice-text');
  let handle = null;
  let held = null;

  const write = (notice, owner) => {
    if (!body || !text) return;
    if (handle !== null) cancel(handle);
    handle = null;
    held = notice === null ? null : owner;
    text.textContent = notice ?? '';
    body.hidden = notice === null;
    if (notice !== null) handle = schedule(() => write(null, owner), timeoutMs);
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
 *   spawn, resolving to whether it landed, and the stranding bump. A warm-up
 *   failure rejects, leaving the caller to run its fallback.
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
 * Build the window `unhandledrejection` handler.
 *
 * A rejection nothing awaited would otherwise reach only the console, leaving a
 * page that misbehaves with no explanation. It is reported through the banner,
 * which carries a dismiss control, so a survivable failure does not occlude the
 * app for the rest of the session. preventDefault() suppresses the browser's
 * own duplicate console report.
 *
 * @param {Object} deps - Injected collaborators.
 * @param {(message: string) => void} deps.report - Renders the failure banner.
 * @param {(...args: *) => void} [deps.logError] - Console sink for the reason.
 * @returns {(e: PromiseRejectionEvent) => void} The handler.
 */
export function createUnhandledRejectionHandler({ report, logError = console.error }) {
  return (e) => {
    logError('Unhandled promise rejection:', e.reason);
    e.preventDefault();
    report(`Something went wrong. ${e.reason?.message ?? String(e.reason)}`);
  };
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
      reportFailure(err);
      teardown()?.dispose();
    },
  };
}
