/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The composition root's frame, timer, and teardown wiring: the per-frame adapter
 * the driver calls, the global keydown shortcuts, the Test All walk, the module
 * load deadline, and the dispose path a page discard runs. Every collaborator is
 * injected, so the segmented/single-engine frame split, the walk, the load race,
 * and the teardown order are unit-testable without Three.js, a WASM engine, or a
 * browser.
 */

import { errorDetail } from './tools/banner.js';
import { displayAliasesDiverged, repointDisplayAliases } from './display_aliases.js';

/** @typedef {import('./display_aliases.js').DisplayDriver} DisplayDriver */

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

// Consecutive clean frames that re-arm the render-loop guard's report, about a
// second of rendering at display rate.
export const FRAME_GUARD_REARM_FRAMES = 60;

// The banner a trapped module raises, from the render loop and from a startup
// call alike.
export const MODULE_TRAP_NOTICE = 'The rendering engine hit an unrecoverable'
  + ' internal error and has been shut down. Reload the page to start it again.'
  + ' See the browser console for details.';

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
    report(MODULE_TRAP_NOTICE);
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
