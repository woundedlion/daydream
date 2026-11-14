/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The page-discard teardown.
 * @typedef {{dispose: () => void, onPageHide: (e: {persisted?: boolean}) => void,
 *   disposed: () => boolean}} AppTeardown
 */

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
 * @param {() => void} deps.releaseAppServices - Releases subscriptions, interval timers, and notices.
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
 * @returns {AppTeardown} The teardown, already listening for pagehide.
 */
export function createAppTeardown({
  pageTarget,
  listeners,
  switches,
  releaseAppServices,
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
    release('the app services', releaseAppServices);
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

/** @param {import('./app_context.js').BootContext & {
 * shaderDocuments: ReturnType<typeof import('./app_shader_documents.js').createAppShaderDocuments>}} deps */
export function createSimulatorTeardown({win, onKeyDown, pageFailureListeners, onApplyNoticeDismiss,
  doc, switches, disposeEffectRoute, testAllTicker, applyNotice, effectGui,
  shaderDocuments, shell, host, urlSync, display, segments, segSpawn, recording}) {
  const {guiInstance, sidebar} = shell;
  return createAppTeardown({
    pageTarget: win,
    listeners: [
      ["keydown", onKeyDown],
      ...pageFailureListeners,
      ["click", onApplyNoticeDismiss, doc],
    ],
    switches,
    releaseAppServices: () => { disposeEffectRoute(); testAllTicker.stop(); applyNotice.clear(); },
    effectGui,
    shaderDocuments,
    globalGui: guiInstance,
    host,
    urlSync,
    sidebar,
    driver: display,
    segments,
    strandSegmentWork: () => segSpawn?.dispose(),
    removeOverlay: () => recording.removeOverlay(),
  });

}
