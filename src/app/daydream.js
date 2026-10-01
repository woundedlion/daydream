/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import { callWorkbenchBinding } from '../engine/workbench_bindings.js';
import { GlobalStatsView } from "../ui/global_stats_view.js";
import { createDisplayCapsBinding } from "../renderer/display_caps.js";
import createHolosphereModule from "../../generated/holosphere_wasm.js";
import { Daydream, MOBILE_BREAKPOINT_PX } from "../renderer/driver.js";
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
import { isShaderSchema } from "../effects/shader_stages.js";
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
import { AppState, URLSync, replaceUrl } from "./state.js";
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
import { importLegacyShaderSelection, LEGACY_SHADER_ALIASES } from "../effects/legacy_shader_import.js";
import { createShaderDocumentController } from "../workbench/shader/shader_documents.js";
import {
  DEFAULT_EFFECT,
  favoritesFor,
  resolutionPresets,
  SHADER_DOCUMENT_EFFECTS,
  WORKBENCH_EFFECTS,
} from "../effects/effect_roster.js";

// UI layer degrades gracefully (log + keep last good state); lower layers trap.

// Dwell time per effect while "Test All" cycles the favorites list.
const TEST_ALL_INTERVAL_MS = 1000;
const EXPECTED_SEGMENT_CONTROLLER_API_VERSION = 3;

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
export function shaderWorkbenchUrl(location, effect = 'Shader') {
  const source = typeof location === 'string' || location instanceof URL
    ? location : location.href;
  const current = new URL(source);
  const url = new URL('tools/shader.html', current);
  url.search = current.search;
  url.hash = current.hash;
  url.searchParams.set('effect', effect);
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Builds the simulator: driver, engine host, state, GUI, sidebar, apply
 * pipeline, recording, and the page listeners, then kicks off the WASM load.
 * @param {Object} [dependencies] - Seams the page owns; each defaults to the real one.
 * @param {Document} [dependencies.doc] - Document the controls mount into.
 * @param {Window} [dependencies.win] - Page target for the global listeners.
 * @param {Navigator} [dependencies.nav] - Read for the segment-pool cap.
 * @param {() => Daydream} [dependencies.createDriver] - Builds the three.js driver.
 * @param {(options: Object, namespace: string) => GUI} [dependencies.createGui] - Builds a namespaced GUI root.
 * @param {() => Promise<Object>} [dependencies.loadModule] - Resolves the WASM module.
 * @returns {Object} The teardown handle; ready settles after module startup or failure reporting.
 */
export function start({
  doc = globalThis.document,
  win = globalThis,
  nav = globalThis.navigator,
  createDriver = () => new Daydream({ doc, win, nav, statsView: new GlobalStatsView(doc) }),
  createGui = (options, namespace) => new GUI(options, namespace, null, win),
  loadModule = createHolosphereModule,
} = {}) {
  const shaderWorkbench = doc.documentElement?.dataset.daydreamMode === 'shader-workbench';
  const requestedEffect = new URLSearchParams(win.location?.search ?? '').get('effect');
  const requestedSelection = importLegacyShaderSelection(requestedEffect);
  const workbenchEffect = requestedSelection.effect === 'Shader' ? 'Shader'
    : SHADER_DOCUMENT_EFFECTS.includes(requestedEffect) ? requestedEffect : null;
  if (!shaderWorkbench && workbenchEffect) {
    const redirectedEffect = requestedSelection.migrated
      ? requestedEffect : workbenchEffect;
    win.location.replace(shaderWorkbenchUrl(win.location, redirectedEffect));
    // Nothing was built, but the shape is createAppTeardown's: a caller reads
    // disposed() on either path.
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
  const host = new EngineHost((view) => repointDisplayAliases(daydream, view));

  ///////////////////////////////////////////////////////////////////////////////
  // Centralized State
  ///////////////////////////////////////////////////////////////////////////////

  // Seed plain defaults; URLSync is the single URL reader and hydrates these from
  // the query string through the same validators below.
  const knownEffects = new Set(shaderWorkbench
    ? WORKBENCH_EFFECTS
    : Object.values(resolutionPresets).flatMap((preset) => preset.favorites));
  for (const alias of LEGACY_SHADER_ALIASES) knownEffects.add(alias);
  const appState = new AppState({
    effect: shaderWorkbench ? 'Shader' : DEFAULT_EFFECT,
    resolution: "Phantasm (288x144)",
  });
  const urlSync = new URLSync(appState, ['effect', 'resolution'], {
    resolution: (v) => Object.hasOwn(resolutionPresets, v),
    effect: (v) => knownEffects.has(v),
  }, win);
  const legacySelection = importLegacyShaderSelection(appState.get('effect'));
  let legacyUrlPending = legacySelection.migrated;
  if (legacyUrlPending) {
    urlSync.suspend();
    appState.set('effect', legacySelection.effect);
  }
  const availableEffects = (resolution) => shaderWorkbench
    ? [...WORKBENCH_EFFECTS] : favoritesFor(resolution);

  const segments = new SegmentController({
    resolutionPresets,
    appState,
    driver: daydream,
    getWasmEngine: () => host.engine,
    refreshPixelView: () => host.refresh(),
    getMemoryView: () => host.view(),
    repointDisplayAliases: (view) => repointDisplayAliases(daydream, view),
    displayAliasesDiverged: (view) => displayAliasesDiverged(daydream, view),
    statsDoc: doc,
    onFault: () => host.recorder?.abort(
      "Recording stopped because the segmented rendering engine failed."),
  });

  ///////////////////////////////////////////////////////////////////////////////
  // Engine and URL Helpers
  ///////////////////////////////////////////////////////////////////////////////

  /**
   * Drop the outgoing effect's param URL entries, keeping the global GUI's keys.
   * @returns {void}
   */
  function clearEffectParamUrl() {
    resetGUI(['resolution', 'effect', ...guiInstance.collectUrlKeys()], win);
  }

  const applyNotice = createApplyNotice({ doc });

  const PARAM_NOTICE = 'param';
  const SWITCH_NOTICE = 'switch';
  const SEGMENT_NOTICE = 'segments';
  const RECORD_NOTICE = 'record';
  const CONFIG_NOTICE = 'config';
  const WORKBENCH_NOTICE = 'workbench';

  /**
   * Write one parameter value to the main engine. setParameter returns a
   * Module.ParamSetResult enum value; compare against the enum, never by
   * truthiness (every enum value is a truthy object).
   * @param {string} name - The engine parameter name.
   * @param {number} value - The float value to write.
   * @returns {boolean} True when the engine accepted the value.
   */
  function setEngineParam(name, value) {
    const result = host.engine.setParameter(name, value);
    if (result !== host.module.ParamSetResult.APPLIED) {
      const message = `Parameter "${name}" was rejected: `
        + `${enumConstantName(host.module.ParamSetResult, result)}.`;
      console.warn(message);
      applyNotice.show(message, PARAM_NOTICE);
    } else {
      applyNotice.show(null, PARAM_NOTICE);
    }
    return result === host.module.ParamSetResult.APPLIED;
  }

  /**
   * Hold or resume animation on every live engine instance.
   * @param {boolean} paused - Whether animation is held.
   * @returns {void}
   * @details The flag is per module instance, so the main engine and every
   *   pool worker each need their own write.
   */
  function setAnimationsPaused(paused) {
    host.engine.setAnimationsPaused(paused);
    segments.setAnimationsPaused(paused);
  }

  const onApplyNoticeDismiss = (e) => {
    if (e.target === doc.getElementById('apply-notice-dismiss')) {
      doc.getElementById('canvas')?.focus();
      applyNotice.clear();
    }
  };
  doc.addEventListener('click', onApplyNoticeDismiss);

  let appTeardown = null;

  /**
   * Release the app when a caught failure came from a trapped module. HS_CHECK
   * sets HS_MODULE_DEAD ahead of a trap that unwinds nothing, so every later
   * call runs on a permanently shortened shadow stack and writes past its end
   * unreported (-sASSERTIONS=0). No call is a recovery path.
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
   * @param {Object} module - The loaded WASM module.
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
      // Muted: the onChange still carries the correction into appState and the URL,
      // but the apply is applyInitialState's single preserving one below.
      switches.mute(() => resolutionController.setValue(corrected));
    }
    return true;
  }

  ///////////////////////////////////////////////////////////////////////////////
  // Initialize WASM
  ///////////////////////////////////////////////////////////////////////////////

  let testAllController = null;

  const testAllTicker = createTestAllTicker({
    intervalMs: TEST_ALL_INTERVAL_MS,
    availableEffects: () => availableEffects(appState.get('resolution')),
    getEffect: () => appState.get('effect'),
    setEffect: (name) => appState.set('effect', name),
    engineReady: () => Boolean(host.engine),
  });

  const reportModuleFailure = (err) => {
    console.error('Failed to initialize the Holosphere renderer:', err);
    // No engine: the Test All ticker would spin uselessly for the page lifetime.
    testAllTicker.stop();
    if (testAllController) {
      testAllController.setValue(false);
      testAllController.disable();
    }
    if (host.moduleDead(err)) {
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
    start: (module) => {
      host.module = module;
      if (module.HolosphereEngine.isLive())
        throw new Error('HolosphereEngine is already live.');
      host.engine = new module.HolosphereEngine();

      // Push the Pole LOD value the GUI settled on during the async WASM-load
      // window; its onChange no-op'd while host.engine was null.
      poleLod.replay();
      if (!displayCaps.replay()) throw new Error('Engine rejected display cap settings.');

      if (!syncResolutionOptions(module)) return;

      // Resolution and effect are both applied once via applyResolution(true) below,
      // before first paint: it sets the hydrated resolution and validates the hydrated
      // effect against this resolution's allow-list.

      const renderAdapter = createRenderAdapter({
        host,
        driver: daydream,
        segments,
        syncEffectGui: (advanced) => effectGui.sync(advanced),
      });
      host.adapter = {
        ...renderAdapter,
        drawFrame() {
          try {
            renderAdapter.drawFrame();
          } finally {
            if (legacyUrlPending) {
              legacyUrlPending = false;
              urlSync.resume();
              applyNotice.show(legacySelection.notice, CONFIG_NOTICE);
            }
          }
        },
      };


      // Construct the recorder now that daydream's canvas exists.
      host.recorder = new VideoRecorder(daydream.canvas);
      recording.attach(host.recorder);

      const loadingOverlay = doc.getElementById('loading-overlay');
      try {
        applyInitialState(
          () => apply.applyResolution(true),
          () => loadingOverlay?.remove(),
        );
        shaderDocuments?.init().catch((err) => {
          console.error('The shader workbench could not be initialized:', err);
          if (abandonOnModuleDeath(err)) return;
          applyNotice.show(
            `The shader workbench could not be initialized: ${errorDetail(err)}`,
            WORKBENCH_NOTICE);
        });
      } catch (err) {
        console.error('Initial resolution/effect could not be applied:', err);
        if (abandonOnModuleDeath(err)) return;
        const title = 'No supported resolution and effect could be applied.';
        reportBootFailure(err, { document: doc, location: win.location, title });
        appTeardown?.dispose();
      }
    },
    discardStartup: () => {
      host.dispose();
      daydream.recorder = null;
    },
    reportFailure: reportModuleFailure,
  });

  ///////////////////////////////////////////////////////////////////////////////
  // GUI + Sidebar Setup
  ///////////////////////////////////////////////////////////////////////////////

  const guiInstance = createGui({ autoPlace: false }, 'view');
  guiInstance.domElement.classList.add('global-gui');
  if (win.matchMedia?.(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches ?? false) {
    guiInstance.close();
  }
  const guiContainer = doc.getElementById('gui-container');
  if (guiContainer) {
    guiContainer.appendChild(guiInstance.domElement);
  } else {
    console.warn('daydream: #gui-container not found; skipping global GUI mount.');
  }

  const setResolution = (v) => appState.set('resolution', v);
  // Reassigned by syncResolutionOptions, which narrows the offered rows through
  // lil-gui's options().
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
    (name) => appState.set('effect', name)
  );

  ///////////////////////////////////////////////////////////////////////////////
  // Composition — the effect panel, the apply path, and the switch transaction
  ///////////////////////////////////////////////////////////////////////////////

  let fullConfigGeneration = null;
  let fullConfigSchema = false;
  /**
   * @returns {boolean} Whether the live effect persists through the exhaustive
   *   versioned snapshot API rather than through per-parameter values.
   */
  function usesFullConfigSnapshot() {
    if (host.moduleDead() || typeof host.engine?.getFullConfigSnapshot !== 'function'
        || typeof host.engine.restoreFullConfigSnapshot !== 'function'
        || !host.module?.FullConfigRestoreResult) {
      return false;
    }
    const generation = host.paramGeneration();
    if (generation === undefined || generation !== fullConfigGeneration) {
      fullConfigGeneration = generation;
      fullConfigSchema = isShaderSchema(host.engine.getParameterDefinitions());
    }
    return fullConfigSchema;
  }

  // The shader-document controller (created below, after the panel it filters)
  // publishes the chain editor's selected-instance filter through this slot.
  const paramFilterRef = { current: null };

  const effectGui = createEffectGui({
    moduleDead: (error) => host.moduleDead(error),
    engine: {
      getParameterDefinitions: () => host.engine.getParameterDefinitions(),
      paramGeneration: () => host.paramGeneration(),
      paramValues: () => host.engine.getParamValues(),
      setParam: setEngineParam,
      setAnimationsPaused,
      animationsPaused: () => host.engine.getAnimationsPaused?.(),
      getPresetCount: () => segments.ownsDisplay
        ? (segments.getPresetCount() ?? host.engine.getPresetCount())
        : host.engine.getPresetCount(),
      getPresetIndex: () => segments.ownsDisplay
        ? (segments.getPresetIndex() ?? host.engine.getPresetIndex())
        : host.engine.getPresetIndex(),
      synchronizePreset: (index) => host.engine.getPresetIndex() === index
        || host.engine.synchronizePreset(index),
      selectPreset: (index) => {
        if (!host.engine.selectPreset(index)) return false;
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
      inUse: usesFullConfigSnapshot,
      snapshot: () => callWorkbenchBinding(host.engine, 'getLegacyShaderBindings', 'getFullConfigSnapshot', []),
      fieldDefinitions: () => callWorkbenchBinding(host.engine, 'getLegacyShaderBindings', 'getFullConfigFieldDefinitions', []),
      restore: (snapshot) => callWorkbenchBinding(host.engine, 'getLegacyShaderBindings', 'restoreFullConfigSnapshot', [snapshot], host.module.FullConfigRestoreResult.NOT_SHADER_WORKBENCH),
      restoreResults: () => host.module.FullConfigRestoreResult,
      showImportNotice: (message) => applyNotice.show(message, CONFIG_NOTICE),
    },
    host: {
      createGui: () => createGui({ autoPlace: false }, 'fx'),
      container: () => shaderWorkbench ? null : doc.getElementById('gui-container'),
      isMobile: () => win.matchMedia?.(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches ?? false,
      copyText: copyToClipboard,
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

  const apply = createApplyPipeline({
    appState,
    getEngine: () => host.engine,
    getModule: () => host.module,
    invalidateEngineView: () => host.invalidateView(),
    presets: resolutionPresets,
    availableEffects,
    effectGui,
    clearEffectParamUrl,
    segments,
    driver: daydream,
    sidebar,
    muteSubscription: (write) => switches.mute(write),
    moduleDead: (error) => host.moduleDead(error),
  });

  const switches = createSwitchCoordinator({
    appState,
    getActiveEffect: () => effectGui.active(),
    applyEffect: (preserveParams) => apply.applyEffect(preserveParams),
    applyResolution: (preserveParams) => apply.applyResolution(preserveParams),
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
    usesFullConfigSnapshot,
  });

  const shaderDocuments = shaderWorkbench ? createShaderDocumentController({
    doc,
    getEngine: () => host.engine,
    getModule: () => host.module,
    selectEffect: (effect) => {
      appState.set('effect', effect);
      return appState.get('effect') === effect;
    },
    syncEffectGui: () => effectGui.sync(),
    invalidate: () => daydream.invalidate(),
    getAnimationsPaused: () => host.engine?.getAnimationsPaused?.() ?? null,
    setAnimationsPaused,
    setParamFilter: (filter) => { paramFilterRef.current = filter; },
    initialEffect: requestedSelection.effect,
    win,
  }) : null;

  testAllController = guiInstance.addSession({ testAll: false }, 'testAll').name('Test All')
    .onChange((v) => {
      if (v) testAllTicker.start();
      else testAllTicker.stop();
    });


  guiInstance.add(daydream, 'labelAxes').name('Show Axes').onChange(() => daydream.invalidate());
  guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere').onChange(() => daydream.invalidate());
  guiInstance.add(daydream, 'showPip').name('Show PiP').onChange(() => daydream.invalidate());
  guiInstance.add(daydream, 'columnFillOverlap', 1.0, 2.0, 0.01).name('Column Fill Overlap').onChange(() => daydream.invalidate());

  const poleLod = createPoleLodBinding({
    getEngine: () => host.engine,
    onChange: () => daydream.invalidate(),
  });
  guiInstance.add(poleLod.state, 'poleLod', 0, 2, 0.05).name('Pole LOD')
    .onChange((v) => { poleLod.apply(v); segments.setPoleLod(v); });

  const displayCaps = createDisplayCapsBinding({
    getEngine: () => host.engine,
    onChange: (geometry) => {
      daydream.setDisplayGeometry(geometry);
      host.invalidateView();
      segments.setDisplayCaps(displayCaps.state.topCap, displayCaps.state.bottomCap);
      if (host.adapter) {
        host.refresh();
        host.adapter.drawFrame();
        effectGui.sync(true);
        if (daydream.dotMesh?.instanceColor) daydream.dotMesh.instanceColor.needsUpdate = true;
      }
      daydream.invalidate();
    },
  });
  let acceptedCaps = { ...displayCaps.state };
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
  capControls.push(guiInstance.add(displayCaps.state, 'topCap', 0, 25, 0.1).name('Top cap (%)')
    .onChange(applyDisplayCaps));
  capControls.push(guiInstance.add(displayCaps.state, 'bottomCap', 0, 25, 0.1).name('Bottom cap (%)')
    .onChange(applyDisplayCaps));

  const segSpawn = shaderWorkbench ? null : createSegmentedPovControls({
    gui: guiInstance,
    segments,
    nav,
    driver: daydream,
    showNotice: (message) => applyNotice.show(message, SEGMENT_NOTICE),
  });

  const recording = createRecordingControls({
    doc,
    gui: guiInstance,
    driver: daydream,
    getRecorder: () => host.recorder,
    getEffect: () => appState.get('effect'),
    showNotice: (message) => applyNotice.show(message, RECORD_NOTICE),
  });
  const onKeyDown = createGlobalKeydownHandler({
    dispatch: (e) => daydream.keydown(e, (delta) => effectGui.movePreset(delta)),
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
    stopTimers: () => { testAllTicker.stop(); applyNotice.clear(); },
    effectGui,
    shaderDocuments,
    globalGui: guiInstance,
    host,
    urlSync,
    sidebar,
    driver: daydream,
    segments,
    strandSegmentWork: () => segSpawn?.strand(),
    removeOverlay: () => recording.removeOverlay(),
  });

  const ready = loadWithDeadline(loadModule)
    .then(moduleLoad.onModuleReady).catch(moduleLoad.onModuleFailed);

  return Object.assign(appTeardown, { ready });
}
