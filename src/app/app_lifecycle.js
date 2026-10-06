/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** The composition root's frame, timer, and teardown wiring, over injected collaborators. */

import { raceDeadline } from '../shared/deadline.js';
import { errorDetail } from '../shared/banner.js';
import { displayAliasesDiverged, repointDisplayAliases } from '../engine/display_aliases.js';

/** @typedef {import('../engine/display_aliases.js').DisplayDriver} DisplayDriver */

/**
 * Build the per-frame adapter the driver's render loop calls.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{engine: {drawFrame: () => void, getArenaMetrics: () => Object},
 *   refresh: () => boolean, view: () => Uint16Array|null}} deps.host - The EngineHost
 *   owning the main engine and its view.
 * @param {DisplayDriver} deps.driver - The Daydream driver.
 * @param {{ownsDisplay: boolean, active: boolean, consumeCapture: () => boolean,
 *   tick: () => void, updateStats: () => void}} deps.segments - The SegmentController.
 * @param {(advanced: boolean) => void} deps.syncEffectGui - Mirrors engine params
 *   into the panel, told whether the simulation stepped this frame.
 * @param {(message: string) => void} [deps.logError] - Console sink for the
 *   once-per-page alias divergence report.
 * @returns {{drawFrame: () => void, sync: (advanced: boolean) => void,
 *   getArenaMetrics: () => Object|null, captureReady: (advanced?: boolean) => boolean,
 *   refreshPixelView: () => void}} The adapter.
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
    refreshPixelView() {
      host.refresh();
      const view = host.view();
      if (view !== null) repointDisplayAliases(driver, view);
    },
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
        // A still-spawning pool paints nothing; render here and report the spawn.
        if (segments.active) segments.updateStats();
        host.engine.drawFrame();
        host.refresh();
        // Log once and re-point: a throw here halts the render loop.
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
     * Consume the displayed frame's capture obligation, including while idle.
     * @param {boolean} [advanced] - Whether the simulation stepped this repaint.
     * @returns {boolean} True once per newly displayed frame.
     */
    captureReady(advanced = true) {
      return segments.ownsDisplay ? segments.consumeCapture() : advanced;
    }
  };
}

/**
 * Wire the page-discard teardown and register its pagehide listener.
 *
 * Order is the contract: listeners go before the GUI and scene teardown, the
 * engine host before driver.dispose() drops the WebGL context the recorder
 * captures from, and the pool is stranded before it is destroyed.
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
 * @param {{active: boolean, dispose: Function}} deps.segments - The pool;
 *   dispose() also drops the warmer's held compilation.
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
   * Run one release step; a throw is reported and later steps still run.
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
   * Release the listeners, timers, and worker pool the app owns. Runs once.
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
    // Strand any in-flight warmModules() continuation; its post-await guard reads both.
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
  'input, textarea, select, button, a[href], [contenteditable], .lil-gui, .effect-sidebar, .chain-strip-region';

/**
 * Build the window keydown handler for the global playback shortcuts.
 *
 * A key landing in an INTERACTIVE_KEY_TARGET element is ignored; a non-node
 * target falls through to the shortcuts.
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
 * The index is the ticker's own: a rejected switch reverts the live effect, so
 * re-deriving it would retry the rejected slot forever. The list is re-read
 * every tick.
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
 *   ticker; start() is idempotent.
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
 * Reports re-arm after FRAME_GUARD_REARM_FRAMES clean frames. A dead module
 * stops the loop permanently and releases the app.
 *
 * @param {Object} deps - Injected collaborators.
 * @param {() => void} deps.frame - The per-frame body.
 * @param {(message: string) => void} deps.report - Renders the failure banner.
 * @param {(message: string) => void} [deps.clearReport] - Clears a recovered failure.
 * @param {(...args: *) => void} [deps.logError] - Console sink for the throw.
 * @param {(error?: *) => boolean} [deps.moduleDead] - Reads the engine module's death
 *   flag; polled before and after every frame, so it must be cheap.
 * @param {() => void} [deps.onModuleDead] - Releases the app once the module is
 *   dead. Runs after the banner, which the release leaves standing.
 * @returns {() => void} The guarded callback for setAnimationLoop.
 */
export function createFrameLoopGuard({
  frame,
  report,
  clearReport = () => {},
  logError = console.error,
  moduleDead = () => false,
  onModuleDead = () => {},
}) {
  let reported = false;
  let failureMessage = '';
  let clean = 0;
  let dead = false;

  /** @param {string} message */
  function reportNotice(message) {
    try { report(message); }
    catch (error) { logError('Render error reporting failed:', error); }
  }

  /**
   * Poll the module's death flag and, the first time it reads dead, latch it:
   * banner, release, no further frames.
   * @returns {void}
   */
  function checkDead(/** @type {*} */ error = undefined) {
    if (dead || !moduleDead(error)) return;
    // Latched before the release, so a throwing release still stops the loop.
    dead = true;
    logError('Render loop stopped: the rendering engine trapped.');
    reportNotice(MODULE_TRAP_NOTICE);
    onModuleDead();
  }

  return () => {
    checkDead();
    if (dead) return;
    try {
      frame();
      if (reported && ++clean >= FRAME_GUARD_REARM_FRAMES && !moduleDead()) {
        clearReport(failureMessage);
        reported = false;
        clean = 0;
      }
    } catch (e) {
      checkDead(e);
      if (dead) return;
      clean = 0;
      if (!reported) {
        reported = true;
        logError('Render loop frame failed:', e);
        failureMessage = `The render loop hit an error. ${errorDetail(e)}`
          + ' See the browser console for details.';
        reportNotice(failureMessage);
      }
    }
    checkDead();
  };
}

// Main-thread WASM fetch, instantiation and runtime-init deadline.
export const MODULE_LOAD_DEADLINE_MS = 90000;

/**
 * Race a module load against a deadline. The timer is cleared once the race
 * settles; a losing load's later rejection is handled.
 *
 * @param {() => Promise<Object>} load - Starts the module load.
 * @param {Object} [deps] - Injected collaborators.
 * @param {number} [deps.ms] - The deadline, in milliseconds.
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] - Timer
 *   source.
 * @returns {Promise<Object>} The loaded module, or a rejection carrying the
 *   deadline that expired or whatever load() raised, synchronous throws included.
 */
export function loadWithDeadline(load, {
  ms = MODULE_LOAD_DEADLINE_MS,
  timers = globalThis,
} = {}) {
  return raceDeadline(load, ms, timers, () => {
    throw new Error(`The rendering engine did not load within ${Math.round(ms / 1000)} seconds.`);
  });
}

/**
 * Build the handlers for the main WASM module promise, guarded against a page
 * discard that settles first.
 *
 * Startup is skipped once the app is disposed; a disposal that lands during
 * startup releases what startup built. A load failure disposes the app.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => ?{dispose: Function, disposed: () => boolean}} deps.teardown -
 *   Reads the app teardown; null when startup never built it.
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
      try {
        reportFailure(err);
      } finally {
        teardown()?.dispose();
      }
    },
  };
}
