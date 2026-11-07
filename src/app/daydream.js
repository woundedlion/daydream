/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import { callWorkbenchBinding, getChainSnapshot, restoreChainSnapshot } from '../engine/workbench_bindings.js';
import { GlobalStatsView } from "../ui/global_stats_view.js";
import { MAX_DISPLAY_CAP_PERCENT, createDisplayCapsBinding } from "../renderer/display_caps.js";
import createHolosphereModule from "../../generated/holosphere_wasm.js";
import { Daydream } from "../renderer/driver.js";
import { FPS } from '../renderer/frame_constants.js';
import { MOBILE_MEDIA_QUERY } from "../shared/layout.js";
import { GUI, resetGUI } from "../ui/gui.js";
import { EffectSidebar } from "../ui/sidebar.js";
import {
  ApplyResult,
  applyInitialState,
  createApplyPipeline,
  createSwitchCoordinator,
  offeredResolutions,
  resolutionCorrection,
} from "../effects/effect_sequencing.js";
import { createEffectGui } from "../ui/effect_gui.js";
import {
  createAppTeardown,
  createFrameLoopGuard,
  createGlobalKeydownHandler,
  createModuleLoadHandlers,
  createRenderAdapter,
  createTestAllTicker,
  loadWithDeadline,
  MODULE_TRAP_NOTICE,
} from "./app_lifecycle.js";
import { createApplyNotice } from "../ui/apply_notice.js";
import { displayAliasesDiverged, repointDisplayAliases } from "../engine/display_aliases.js";
import { createPoleLodBinding } from "../renderer/pole_lod.js";
import { createRecordingControls } from "../recording/recording_controls.js";
import {
  createSegmentedPovControls,
} from "../ui/segmented_pov_controls.js";
import { canonicalEffectId } from "../effects/effect_identity.js";
import { AppState, URLSync } from "./state.js";
import { replaceUrl } from "../shared/url.js";
import { SegmentStatsView } from "../ui/segment_stats_view.js";
import { VideoRecorder } from "../recording/recorder.js";
import {
  SEGMENT_CONTROLLER_API_VERSION,
  SegmentController,
} from "../segments/segment_controller.js";
import { EngineHost } from "../engine/engine_host.js";
import { clearFatalError, errorDetail, reportPageFailures, showFatalError } from "../shared/banner.js";
import { reportBootFailure, StaleModuleError } from "./bootstrap.js";
import { enumConstantName } from "../effects/param_sync.js";
import { copyToClipboard } from "../shared/copy_text.js";
import { createShaderDocumentController } from "../workbench/shader/shader_documents.js";
import {
  DEFAULT_EFFECT,
  favoritesFor,
  resolutionPresets,
  SHADER_DOCUMENT_EFFECTS,
  WORKBENCH_EFFECTS,
} from "../effects/effect_roster.js";

/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereModule} HolosphereModule */
/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereEngine} HolosphereEngine */
/** @typedef {EngineHost & {module: HolosphereModule, engine: HolosphereEngine}} LoadedHost */
/** @typedef {Daydream & import('../engine/display_aliases.js').DisplayDriver} ReadyDisplay */

// UI layer degrades gracefully (log + keep last good state); lower layers trap.

// Dwell time per effect while "Test All" cycles the test roster.
const TEST_ALL_INTERVAL_MS = 1000;
const EXPECTED_SEGMENT_CONTROLLER_API_VERSION = 4;

if (SEGMENT_CONTROLLER_API_VERSION !== EXPECTED_SEGMENT_CONTROLLER_API_VERSION) {
  throw new StaleModuleError(
    'Cached segment_controller.js is incompatible; reload the simulator.');
}

/**
 * Builds the dedicated authoring route while preserving the incoming query.
 * @param {Location|URL|string} location - Current simulator location.
 * @param {string} [effect] - Effect the workbench opens on.
 * @returns {string} Same-origin workbench URL.
 */
export function shaderWorkbenchUrl(location, effect = 'ShaderChain') {
  const source = typeof location === 'string' || location instanceof URL
    ? location : location.href;
  const current = new URL(source);
  const url = new URL('tools/shader.html', current);
  url.search = current.search;
  url.hash = current.hash;
  url.searchParams.set('effect', canonicalEffectId(effect));
  url.searchParams.delete('view');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** @typedef {ReturnType<typeof createAppTeardown> & {ready: Promise<unknown>}} AppHandle */

/**
 * Builds the simulator: driver, engine host, state, GUI, sidebar, apply
 * pipeline, recording, and the page listeners, then kicks off the WASM load.
 * @param {Object} [dependencies] - Seams the page owns; each defaults to the real one.
 * @param {Document} [dependencies.doc] - Document the controls mount into.
 * @param {Window & typeof globalThis} [dependencies.win] - Page target for the global listeners.
 * @param {Navigator} [dependencies.nav] - Read for the segment-pool cap.
 * @param {() => Daydream} [dependencies.createDriver] - Builds the three.js driver.
 * @param {(options: ConstructorParameters<typeof GUI>[0], namespace: string) => GUI} [dependencies.createGui] - Builds a namespaced GUI root.
 * @param {() => Promise<HolosphereModule>} [dependencies.loadModule] - Resolves the WASM module.
 * @returns {AppHandle} The teardown handle; ready settles after module startup or failure reporting.
 */
export function start({
  doc = globalThis.document,
  win = /** @type {Window & typeof globalThis} */ (globalThis),
  nav = globalThis.navigator,
  createDriver = () => new Daydream({
    doc, win, nav, statsView: new GlobalStatsView(doc),
    pipOnRight: doc.documentElement?.dataset.daydreamMode === 'shader-workbench',
  }),
  createGui = (options, namespace) => new GUI(options, namespace, null, win),
  loadModule = createHolosphereModule,
} = {}) {
  const shaderWorkbench = doc.documentElement?.dataset.daydreamMode === 'shader-workbench';
  const routeParams = new URLSearchParams(win.location?.search ?? '');
  const requestedEffect = routeParams.get('effect');
  const canonicalRequest = canonicalEffectId(requestedEffect ?? '');
  const workbenchEffect = canonicalRequest === canonicalEffectId('ShaderChain')
    ? canonicalRequest : requestedEffect === canonicalRequest
      && routeParams.get('view') !== 'simulator'
      && SHADER_DOCUMENT_EFFECTS.includes(canonicalRequest) ? canonicalRequest : null;
  if (!shaderWorkbench && workbenchEffect) {
    win.location.replace(shaderWorkbenchUrl(win.location, workbenchEffect));
    let redirectDisposed = false;
    return {
      dispose() { redirectDisposed = true; },
      onPageHide() {},
      disposed: () => redirectDisposed,
      ready: Promise.resolve(),
    };
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Instances
  ///////////////////////////////////////////////////////////////////////////////

  const daydream = createDriver();
  /** Display callbacks run after updateResolution() creates its color attribute. */
  const display = /** @type {ReadyDisplay} */ (daydream);
  const host = new EngineHost((view) => repointDisplayAliases(display, view));
  /** Engine callbacks run after the module-ready handler installs both members. */
  const loaded = /** @type {LoadedHost} */ (host);

  ///////////////////////////////////////////////////////////////////////////////
  // Centralized State
  ///////////////////////////////////////////////////////////////////////////////

  // Seed plain defaults; URLSync hydrates these from the query string through
  // its validators.
  const knownEffects = new Set((shaderWorkbench
    ? WORKBENCH_EFFECTS
    : Object.values(resolutionPresets).flatMap((preset) => preset.favorites)
  ).map(canonicalEffectId));
  const appState = new AppState({
    effect: canonicalEffectId(shaderWorkbench ? 'ShaderChain' : DEFAULT_EFFECT),
    view: null,
    resolution: "Phantasm (288x144)",
  });
  const syncRoute = () => appState.set('view', !shaderWorkbench
    && SHADER_DOCUMENT_EFFECTS.includes(canonicalEffectId(appState.get('effect')))
    ? 'simulator' : null);
  const disposeEffectRoute = appState.subscribe((key) => { if (key === 'effect') syncRoute(); });
  const urlSync = new URLSync(appState, ['effect', 'resolution', 'view'], {
    resolution: (v) => Object.hasOwn(resolutionPresets, v),
    effect: (v) => knownEffects.has(canonicalEffectId(v)),
    view: (v) => !shaderWorkbench && v === 'simulator',
  }, win);
  appState.set('effect', canonicalEffectId(appState.get('effect')));
  syncRoute();
  let workbenchUrlPending = shaderWorkbench;
  if (workbenchUrlPending) urlSync.suspend();
  const releaseWorkbenchUrl = () => {
    if (!workbenchUrlPending) return;
    workbenchUrlPending = false;
    urlSync.resume();
  };
  for (const key of ['view.povPresentation', 'view.povExposureMs']) {
    if (routeParams.has(key)) urlSync.setParam(key, null);
  }
  const availableEffects = (/** @type {string} */ resolution) => shaderWorkbench
    ? WORKBENCH_EFFECTS.map(canonicalEffectId) : favoritesFor(resolution).map(canonicalEffectId);

  const segments = new SegmentController({
    resolutionPresets,
    appState,
    driver: display,
    getWasmEngine: () => host.engine,
    refreshPixelView: () => host.refresh(),
    getMemoryView: () => host.view(),
    repointDisplayAliases: (view) => repointDisplayAliases(display, view),
    displayAliasesDiverged: (view) => displayAliasesDiverged(display, view),
    statsView: new SegmentStatsView(doc),
    onFault: () => host.recorder?.abort(
      'the segmented rendering engine failed.'),
  });

  ///////////////////////////////////////////////////////////////////////////////
  // Engine and URL Helpers
  ///////////////////////////////////////////////////////////////////////////////

  /**
   * Drop the outgoing effect's param URL entries, keeping the global GUI's keys.
   * @returns {void}
   */
  function clearEffectParamUrl() {
    resetGUI(['resolution', 'effect', 'view', ...guiInstance.collectUrlKeys()], win);
  }

  const applyNotice = createApplyNotice({ doc });

  const PARAM_NOTICE = 'param';
  const SWITCH_NOTICE = 'switch';
  const SEGMENT_NOTICE = 'segments';
  const RECORD_NOTICE = 'record';
  const CONFIG_NOTICE = 'config';
  const EXPORT_NOTICE = 'export';
  const WORKBENCH_NOTICE = 'workbench';

  /**
   * Write one parameter value to the main engine. setParameter returns a
   * Module.ParamSetResult enum value; compare against the enum, never by
   * truthiness (every enum value is a truthy object).
   * @param {string} name - The engine parameter name.
   * @param {number} value - The float value to write.
   * @param {object} [gesture] - Shared by the edits of one pointer gesture.
   * @returns {boolean} True when the engine accepted the value.
   */
  function setEngineParam(name, value, gesture) {
    const result = loaded.engine.setParameter(name, value);
    if (result !== loaded.module.ParamSetResult.APPLIED) {
      const message = `Parameter "${name}" was rejected: `
        + `${enumConstantName(loaded.module.ParamSetResult, result)}.`;
      console.warn(message);
      applyNotice.show(message, PARAM_NOTICE, gesture);
    } else {
      applyNotice.show(null, PARAM_NOTICE);
    }
    return result === loaded.module.ParamSetResult.APPLIED;
  }

  /**
   * Hold or resume animation on every live engine instance.
   * @param {boolean} paused - Whether animation is held.
   * @returns {void}
   * @details The flag is per module instance, so the main engine and every
   *   pool worker each need their own write.
   */
  function setAnimationsPaused(paused) {
    loaded.engine.setAnimationsPaused(paused);
    segments.setAnimationsPaused(paused);
  }

  const onApplyNoticeDismiss = (/** @type {MouseEvent} */ e) => {
    if (e.target === doc.getElementById('apply-notice-dismiss')) {
      /** @type {HTMLCanvasElement|null} */ (doc.getElementById('canvas'))?.focus();
      applyNotice.clear();
    }
  };
  doc.addEventListener('click', onApplyNoticeDismiss);

  /** @type {ReturnType<typeof createAppTeardown>|null} */
  let appTeardown = null;

  /**
   * Release the app when a caught failure came from a trapped module, which has
   * no recovery path.
   * @param {unknown} error - Failure from the module.
   * @returns {boolean} Whether the module is dead and the app was released.
   */
  function abandonOnModuleDeath(error) {
    if (!host.moduleDead(error)) return false;
    console.error('Startup stopped: the rendering engine trapped.');
    reportBootFailure(MODULE_TRAP_NOTICE, { document: doc, location: win.location });
    appTeardown?.dispose();
    return true;
  }

  /**
   * Narrow the resolution dropdown to the rows the engine reports it can build,
   * correcting the active resolution when the hydrated one is not among them.
   * @param {HolosphereModule} module - The loaded WASM module.
   * @returns {boolean} Whether the module survived the query; false leaves the
   *   app released and the rest of the startup unrun.
   */
  function syncResolutionOptions(module) {
    let supported = null;
    try { supported = module.HolosphereEngine.getSupportedResolutions(); }
    catch (e) {
      console.warn('getSupportedResolutions failed (offering every preset):', e);
      if (abandonOnModuleDeath(e)) return false;
    }

    const { labels, unlabeled } = offeredResolutions(resolutionPresets, supported);
    if (unlabeled.length > 0) {
      console.warn(`Engine resolutions with no preset (not offered): ${unlabeled.join(', ')}`);
    }
    resolutionController = resolutionController.options(labels).onChange(setResolution);

    const current = appState.get('resolution');
    const corrected = resolutionCorrection(labels, current);
    if (corrected !== null) {
      console.warn(`Resolution "${current}" is not supported by the engine; using "${corrected}".`);
      // Muted: the onChange carries the correction into appState and the URL;
      // applyInitialState performs the apply.
      switches.mute(() => resolutionController.setValue(corrected));
    }
    return true;
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Initialize WASM
  ///////////////////////////////////////////////////////////////////////////////

  /** @type {import('lil-gui').Controller|null} */
  let testAllController = null;

  const testAllTicker = createTestAllTicker({
    intervalMs: TEST_ALL_INTERVAL_MS,
    availableEffects: () => availableEffects(appState.get('resolution')),
    getEffect: () => appState.get('effect'),
    setEffect: (name) => appState.set('effect', name),
    engineReady: () => Boolean(host.engine),
  });

  const reportModuleFailure = (/** @type {unknown} */ err) => {
    console.error('Failed to initialize the Holosphere renderer:', err);
    // No engine: the Test All ticker would spin uselessly for the page lifetime.
    testAllTicker.stop();
    if (testAllController) {
      testAllController.setValue(false);
      testAllController.disable();
    }
    if (host.module && host.moduleDead(err)) {
      reportBootFailure(MODULE_TRAP_NOTICE, { document: doc, location: win.location });
      return;
    }
    reportBootFailure(err, {
      document: doc,
      location: win.location,
      title: 'Failed to load the rendering engine.',
    });
  };

  const moduleLoad = createModuleLoadHandlers({
    teardown: () => appTeardown,
    start: (/** @type {HolosphereModule} */ module) => {
      host.module = module;
      if (module.HolosphereEngine.isLive())
        throw new Error('HolosphereEngine is already live.');
      host.engine = new module.HolosphereEngine();
      loaded.engine.setTemporalSampling(daydream.povFidelity);

      // Push the Pole LOD value set while host.engine was null.
      poleLod.replay();
      if (!displayCaps.replay()) throw new Error('Engine rejected display cap settings.');

      if (!syncResolutionOptions(module)) return;

      const renderAdapter = createRenderAdapter({
        host: loaded,
        driver: display,
        segments,
        syncEffectGui: (advanced) => effectGui.sync(advanced),
      });
      host.adapter = renderAdapter;

      host.recorder = new VideoRecorder(daydream.canvas, undefined, undefined, doc);
      recording.attach(host.recorder);

      const loadingOverlay = doc.getElementById('loading-overlay');
      try {
        // Apply the hydrated resolution with its params preserved and validate
        // the hydrated effect against its allow-list, before first paint.
        applyInitialState(
          () => apply.applyResolution({ preserveParams: true }),
          () => loadingOverlay?.remove(),
        );
        shaderDocuments?.init().then(() => {
          if (!shaderDocuments.preservesOriginalLink()) releaseWorkbenchUrl();
        }).catch((err) => {
          releaseWorkbenchUrl();
          console.error('The shader workbench could not be initialized:', err);
          if (abandonOnModuleDeath(err)) return;
          applyNotice.show(
            `The shader workbench could not be initialized: ${errorDetail(err)}`,
            WORKBENCH_NOTICE);
        }).finally(finishColumnDefaults);
      } catch (err) {
        console.error('Initial resolution/effect could not be applied:', err);
        if (abandonOnModuleDeath(err)) return;
        const title = 'No supported resolution and effect could be applied.';
        reportBootFailure(err, { document: doc, location: win.location, title });
        appTeardown?.dispose();
      }
    },
    reportFailure: reportModuleFailure,
  });

  ///////////////////////////////////////////////////////////////////////////////
  // GUI + Sidebar Setup
  ///////////////////////////////////////////////////////////////////////////////

  const guiInstance = createGui({ autoPlace: false, title: 'View' }, 'view');
  guiInstance.domElement.classList.add('global-gui');
  if (win.matchMedia?.(MOBILE_MEDIA_QUERY).matches ?? false) {
    guiInstance.close();
  }
  const guiContainer = doc.getElementById('gui-container');
  if (guiContainer) {
    guiContainer.appendChild(guiInstance.domElement);
  } else {
    console.warn('daydream: #gui-container not found; skipping global GUI mount.');
  }

  const setResolution = (/** @type {string} */ v) => appState.set('resolution', v);
  // Reassigned when syncResolutionOptions narrows the offered rows.
  let resolutionController = guiInstance
    .addSession({ resolution: appState.get('resolution') }, 'resolution', Object.keys(resolutionPresets))
    .name('Resolution')
    .onChange(setResolution);

  const sidebarContainer = doc.getElementById('effect-sidebar');
  if (!sidebarContainer && !shaderWorkbench) {
    console.warn('daydream: #effect-sidebar not found; the effect list is not shown.');
  }
  const sidebar = new EffectSidebar(
    sidebarContainer ?? doc.createElement('div'),
    (/** @type {string} */ name) => appState.set('effect', name)
  );

  ///////////////////////////////////////////////////////////////////////////////
  // Composition — the effect panel, the apply path, and the switch transaction
  ///////////////////////////////////////////////////////////////////////////////

  /** @returns {boolean} */
  function usesChainSnapshot() {
    if (host.moduleDead() || !host.module?.ChainSnapshotRestoreResult) return false;
    return callWorkbenchBinding(host.engine, 'isValid', [], false);
  }

  // The shader-document controller publishes the chain editor's selected-instance
  // filter through this slot.
  /** @type {{current: {external: true}|null}} */
  const paramFilterRef = { current: null };

  const effectGui = createEffectGui({
    moduleDead: (error) => host.moduleDead(error),
    engine: {
      getParameterDefinitions: () => loaded.engine.getParameterDefinitions(),
      getParameterAdvisories: () => loaded.engine.getParameterAdvisories(),
      paramGeneration: () => host.paramGeneration(),
      paramValues: () => loaded.engine.getParamValues(),
      setParam: setEngineParam,
      setAnimationsPaused,
      animationsPaused: () => loaded.engine.getAnimationsPaused(),
      getPresetCount: () => loaded.engine.getPresetCount(),
      getPresetIndex: () => segments.ownsDisplay
        ? (segments.getPresetIndex() ?? loaded.engine.getPresetIndex())
        : loaded.engine.getPresetIndex(),
      synchronizePreset: (index) => loaded.engine.getPresetIndex() === index
        || loaded.engine.synchronizePreset(index),
      selectPreset: (index) => {
        if (!loaded.engine.selectPreset(index)) return false;
        segments.selectPreset(index);
        return true;
      },
    },
    segments: {
      ownsDisplay: () => segments.ownsDisplay,
      paramValues: () => segments.getParamValues(),
      setParam: (name, value) => segments.setParameter(name, value),
    },
    config: {
      inUse: usesChainSnapshot,
      snapshot: () => getChainSnapshot(host.engine),
      restore: (snapshot) => restoreChainSnapshot(host.engine, loaded.module, snapshot),
      restoreResults: () => loaded.module.ChainSnapshotRestoreResult,
      showImportNotice: (message) => applyNotice.show(message, CONFIG_NOTICE),
    },
    host: {
      createGui: () => createGui({ autoPlace: false, title: 'Effect' }, 'fx'),
      container: () => shaderWorkbench ? null : doc.getElementById('gui-container'),
      isMobile: () => win.matchMedia?.(MOBILE_MEDIA_QUERY).matches ?? false,
      canPausePresets: () => loaded.engine.getPresetCount() > 1
        || loaded.engine.getParameterDefinitions().some((parameter) => parameter.animated),
      copyText: copyToClipboard,
      showActionNotice: (message) => applyNotice.show(message, EXPORT_NOTICE),
      applyEffect: () => {
        const rejected = apply.applyEffect() !== ApplyResult.APPLIED;
        const notice = rejected
          ? 'Effect reset was rejected. The panel still shows the current values.'
          : null;
        applyNotice.show(notice, SWITCH_NOTICE);
      },
      dragTarget: win,
      focusedElement: () => doc.activeElement,
      paramFilter: () => paramFilterRef.current,
    },
  });

  let columnDefaultsReady = false;
  const apply = createApplyPipeline({
    appState,
    getEngine: () => host.engine,
    getModule: () => loaded.module,
    invalidateEngineView: () => host.invalidateView(),
    presets: resolutionPresets,
    availableEffects,
    effectGui,
    clearEffectParamUrl,
    segments,
    driver: display,
    sidebar,
    muteSubscription: (write) => switches.mute(write),
    moduleDead: (error) => host.moduleDead(error),
    onColumnDefault: () => {
      if (columnDefaultsReady) urlSync.setParam('view.noBlackColumns', null);
    },
  });

  const switches = createSwitchCoordinator({
    appState,
    getActiveEffect: () => effectGui.active(),
    applyEffect: (options) => apply.applyEffect(options),
    applyResolution: (options) => apply.applyResolution(options),
    currentUrl: () =>
      win.location.pathname + win.location.search + win.location.hash,
    restoreUrl: (url) => {
      urlSync.discardPending();
      replaceUrl(url, win);
    },
    showResolution: (resolution) => resolutionController.setValue(resolution),
    syncResolutionUrl: () => urlSync.schedule(),
    logError: (message, error) => console.error(message, error),
    showNotice: (message) => applyNotice.show(message, SWITCH_NOTICE),
    showFatal: showFatalError,
    moduleDead: (error) => host.moduleDead(error),
    usesChainSnapshot,
    getChainSnapshot: () => getChainSnapshot(host.engine),
    restoreChainSnapshot: (snapshot) => restoreChainSnapshot(host.engine, loaded.module, snapshot)
      === loaded.module.ChainSnapshotRestoreResult.APPLIED,
  });

  const shaderDocuments = shaderWorkbench ? createShaderDocumentController({
    doc,
    onOriginalLinkReleased: releaseWorkbenchUrl,
    getEngine: () => host.engine,
    getModule: () => loaded.module,
    selectEffect: (effect) => {
      const canonical = canonicalEffectId(effect);
      appState.set('effect', canonical);
      return appState.get('effect') === canonical;
    },
    syncEffectGui: () => effectGui.sync(),
    invalidate: () => daydream.invalidate(),
    getAnimationsPaused: () => host.engine?.getAnimationsPaused() ?? null,
    setAnimationsPaused,
    setParamFilter: (filter) => { paramFilterRef.current = filter; },
    initialEffect: requestedEffect,
    win,
  }) : null;

  testAllController = shaderWorkbench ? null : guiInstance.addSession({ testAll: false }, 'testAll').name('Test All')
    .onChange((/** @type {boolean} */ v) => {
      if (v) testAllTicker.start();
      else testAllTicker.stop();
    });


  guiInstance.addSession(daydream, 'paused').name('Pause').listen().onChange((/** @type {boolean} */ v) => {
    if (!v) daydream.stepFrames = 0;
  });
  guiInstance.add(daydream, 'labelAxes').name('Show Axes').onChange(() => daydream.invalidate());
  guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere').onChange(() => daydream.invalidate());
  guiInstance.add(daydream, 'showPip').name('Show PiP').onChange(() => daydream.invalidate());
  let temporalSampling = daydream.povFidelity;
  const povFidelity = guiInstance.add(daydream, 'povFidelity').name(`POV fidelity (${FPS} Hz)`);
  const povResponse = guiInstance.add(daydream, 'povResponseScale', 0.5, 2, 0.05).name('Response timescale');
  const armPositions = guiInstance.add(daydream, 'showSweepBoundary').name('Show arm positions');
  const syncPovControls = () => {
    for (const control of [povResponse, armPositions]) {
      if (daydream.povFidelity) control.enable();
      else control.disable();
    }
    daydream.invalidate();
  };
  povFidelity.onChange(() => {
    const changed = temporalSampling !== daydream.povFidelity;
    temporalSampling = daydream.povFidelity;
    if (host.engine) host.engine.setTemporalSampling(daydream.povFidelity);
    segments.setTemporalSampling(daydream.povFidelity);
    if (changed && daydream.paused && host.adapter && !segments.ownsDisplay)
      host.adapter.drawFrame();
    syncPovControls();
  });
  povResponse.onChange(() => daydream.invalidate());
  armPositions.onChange(() => daydream.invalidate());
  syncPovControls();
  /** @type {boolean|null} */
  let initialColumnOverride = null;
  let columnOverrideChanged = false;
  const finishColumnDefaults = () => {
    if (initialColumnOverride !== null && host.engine && !columnOverrideChanged) {
      daydream.noBlackColumns = initialColumnOverride;
      daydream.invalidate();
    }
    columnDefaultsReady = true;
  };
  guiInstance.add(daydream, 'noBlackColumns').name('No black columns').listen().onChange((/** @type {boolean} */ value) => {
    if (!host.engine) initialColumnOverride = value;
    else columnOverrideChanged = true;
    daydream.invalidate();
  });

  const poleLod = createPoleLodBinding({
    getEngine: () => host.engine,
    onChange: () => daydream.invalidate(),
  });
  guiInstance.add(poleLod.state, 'poleLod', 0, 2, 0.05).name('Pole LOD')
    .onChange((/** @type {number} */ value) => {
      poleLod.apply(value);
      segments.setPoleLod(value);
      if (daydream.paused && !segments.ownsDisplay) daydream.stepOnce();
    });

  const displayCaps = createDisplayCapsBinding({
    getEngine: () => host.engine,
    onChange: (geometry) => {
      daydream.setDisplayGeometry(geometry);
      host.invalidateView();
      segments.setDisplayCaps(displayCaps.state.topCap, displayCaps.state.bottomCap);
      if (host.adapter) {
        host.refresh();
        host.adapter.drawFrame();
        if (segments.ownsDisplay) daydream.resetPovOnNextFrame();
        else daydream.resetPovNow();
        effectGui.sync(true);
      }
      daydream.invalidate();
    },
  });
  let acceptedCaps = { ...displayCaps.state };
  /** @type {import('lil-gui').Controller[]} */
  const capControls = [];
  const applyDisplayCaps = () => {
    if (!displayCaps.apply()) {
      Object.assign(displayCaps.state, acceptedCaps);
      for (const control of capControls) control.updateDisplay();
      throw new Error('Engine rejected display cap settings.');
    }
    acceptedCaps = { ...displayCaps.state };
    if (!host.engine) segments.setDisplayCaps(displayCaps.state.topCap, displayCaps.state.bottomCap);
  };
  capControls.push(guiInstance.add(displayCaps.state, 'topCap', 0, MAX_DISPLAY_CAP_PERCENT, 0.1).name('Top cap (%)')
    .onChange(applyDisplayCaps));
  capControls.push(guiInstance.add(displayCaps.state, 'bottomCap', 0, MAX_DISPLAY_CAP_PERCENT, 0.1).name('Bottom cap (%)')
    .onChange(applyDisplayCaps));

  const segSpawn = shaderWorkbench ? null : createSegmentedPovControls({
    gui: guiInstance,
    segments,
    nav,
    win,
    showNotice: (message) => applyNotice.show(message, SEGMENT_NOTICE),
  });

  const recording = createRecordingControls({
    doc,
    gui: guiInstance,
    driver: display,
    getRecorder: () => host.recorder,
    getEffect: () => appState.get('effect'),
    showNotice: (message) => applyNotice.show(message, RECORD_NOTICE),
  });
  const onKeyDown = createGlobalKeydownHandler({
    dispatch: (e) => daydream.keydown(e, (delta) => !shaderWorkbench && effectGui.movePreset(delta)),
  });
  win.addEventListener("keydown", onKeyDown);

  const pageFailureListeners = reportPageFailures('simulator', win);

  daydream.startFrameLoop(createFrameLoopGuard({
    frame: () => {
      if (host.adapter) {
        daydream.render(host.adapter);
      }
      recording.tick();
    },
    report: showFatalError,
    clearReport: clearFatalError,
    moduleDead: (error) => host.moduleDead(error),
    onModuleDead: () => appTeardown?.dispose(),
  }));

  ///////////////////////////////////////////////////////////////////////////////
  // Teardown
  ///////////////////////////////////////////////////////////////////////////////

  appTeardown = createAppTeardown({
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

  const ready = loadWithDeadline(loadModule)
    .then(moduleLoad.onModuleReady)
    .then(() => {
      if (!shaderDocuments) finishColumnDefaults();
    }).catch(moduleLoad.onModuleFailed);

  return Object.assign(appTeardown, { ready });
}
