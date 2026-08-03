/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The composition root's frame and teardown wiring: the display-buffer aliases
 * every renderer writes through, the per-frame adapter the driver calls, and the
 * dispose path a page discard runs. Every collaborator is injected, so the alias
 * heal, the segmented/single-engine frame split, and the teardown order are
 * unit-testable without Three.js, a WASM engine, or a browser.
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
