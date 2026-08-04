/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import createHolosphereModule from "./holosphere_wasm.js";
import { Daydream } from "./driver.js";
import { GUI, resetGUI } from "./gui.js";
import { EffectSidebar } from "./sidebar.js";
import {
  applyInitialState,
  createApplyPipeline,
  createSwitchCoordinator,
  offeredResolutions,
  resolutionCorrection,
  resolutionEffects,
} from "./effect_sequencing.js";
import { createEffectGui } from "./effect_gui.js";
import {
  createAppTeardown,
  createGlobalKeydownHandler,
  createModuleLoadHandlers,
  createPoleLodBinding,
  createRenderAdapter,
  createUnhandledRejectionHandler,
  repointDisplayAliases,
} from "./app_lifecycle.js";
import { AppState, URLSync } from "./state.js";
import { VideoRecorder } from "./recorder.js";
import { SegmentController, warmModules } from "./segment_controller.js";
import { EngineHost } from "./engine_host.js";
import { showFatalError } from "./tools/banner.js";
import { showBootstrapFailure } from "./bootstrap.js";

// UI layer degrades gracefully (log + keep last good state); lower layers trap.

// Dwell time per effect while "Test All" cycles the favorites list.
const TEST_ALL_INTERVAL_MS = 1000;

const HiResFavorites = [
  "BZReactionDiffusion",
  "ChaoticStrings",
  "Comets",
  "DreamBalls",
  "MeshFeedback",
  "Flyby",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "HopfFibration",
  "IslamicStars",
  "Liquid2D",
  "MindSplatter",
  "MobiusGrid",
  "PetalFlow",
  "Raymarch",
  "RingSpin",
  "SphericalHarmonics",
  "DisplacementField",
  "ShapeShifter",
  "Voronoi",
];

const LoResFavorites = [
  "BZReactionDiffusion",
  "ChaoticStrings",
  "Comets",
  "Dynamo",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "IslamicStars",
  "Liquid2D",
  "MobiusGrid",
  "PetalFlow",
  "Raymarch",
  "RingShower",
  "RingSpin",
  "DisplacementField",
  "ShapeShifter",
  "Thrusters",
  "Voronoi",
];

// Display metadata (dot size), geometry, and the effect list offered per
// resolution. The dropdown offers only the subset the engine reports through
// getSupportedResolutions().
const resolutionPresets = {
  "Holosphere (96x20)": { h: 20, w: 96, dotSize: 2, favorites: LoResFavorites },
  "Phantasm (288x144)": { h: 144, w: 288, dotSize: 0.25, favorites: HiResFavorites },
};

/**
 * The effect list offered at a resolution.
 * @param {string} resolution - A resolutionPresets key.
 * @returns {string[]} That preset's favorites, or the high-res list when the
 *   preset is unknown or carries none.
 */
function favoritesFor(resolution) {
  const favorites = resolutionEffects(resolutionPresets, resolution);
  if (!favorites) {
    console.error(`No effect list for resolution "${resolution}"; offering the high-res list.`);
    return HiResFavorites;
  }
  return favorites;
}

///////////////////////////////////////////////////////////////////////////////
// Instances
///////////////////////////////////////////////////////////////////////////////

const daydream = new Daydream();
const host = new EngineHost((view) => repointDisplayAliases(daydream, view));

///////////////////////////////////////////////////////////////////////////////
// Centralized State
///////////////////////////////////////////////////////////////////////////////

// Seed plain defaults; URLSync is the single URL reader and hydrates these from
// the query string through the same validators below.
const knownEffects = new Set(
  Object.values(resolutionPresets).flatMap((preset) => preset.favorites));
const appState = new AppState({
  effect: 'IslamicStars',
  resolution: "Phantasm (288x144)",
});
const urlSync = new URLSync(appState, ['effect', 'resolution'], {
  resolution: (v) => Boolean(resolutionPresets[v]),
  effect: (v) => knownEffects.has(v),
});

const segments = new SegmentController({
  resolutionPresets,
  appState,
  driver: daydream,
  getWasmEngine: () => host.engine,
  refreshPixelView: () => host.refresh(),
  getMemoryView: () => host.view(),
  repointDisplayAliases: (view) => repointDisplayAliases(daydream, view),
  statsDoc: document,
});

///////////////////////////////////////////////////////////////////////////////
// Engine and URL Helpers
///////////////////////////////////////////////////////////////////////////////

/**
 * Drop the outgoing effect's param URL entries, keeping the global GUI's keys.
 * @returns {void}
 */
function clearEffectParamUrl() {
  resetGUI(['resolution', 'effect', ...guiInstance.collectUrlKeys()]);
}

/**
 * Write one parameter value to the main engine. setParameter returns a
 * Module.ParamSetResult enum value; compare against the enum, never by
 * truthiness (every enum value is a truthy object).
 * @param {string} name - The engine parameter name.
 * @param {number} value - The float value to write.
 * @returns {void}
 */
function setEngineParam(name, value) {
  const result = host.engine.setParameter(name, value);
  if (result !== host.module.ParamSetResult.APPLIED) {
    const message = `Parameter "${name}" was rejected: ${paramSetResultName(result)}.`;
    console.warn(message);
    showApplyNotice(message);
  } else {
    showApplyNotice(null);
  }
}

const APPLY_NOTICE_MS = 8000;
let applyNoticeTimer = null;

/**
 * Show or clear the parameter-rejection notice. The notice self-clears so a
 * stale rejection cannot outlive the action that raised it.
 * @param {string|null} message - Text to announce, or null to clear.
 * @returns {void}
 */
function showApplyNotice(message) {
  const body = document.getElementById('apply-notice-body');
  const text = document.getElementById('apply-notice-text');
  if (!body || !text) return;
  clearTimeout(applyNoticeTimer);
  applyNoticeTimer = null;
  text.textContent = message ?? '';
  body.hidden = !message;
  if (message) {
    applyNoticeTimer = setTimeout(() => showApplyNotice(null), APPLY_NOTICE_MS);
  }
}

document.getElementById('apply-notice-dismiss')
  ?.addEventListener('click', () => showApplyNotice(null));

/**
 * Name a ParamSetResult enum value for logging.
 * @param {Object} result - A Module.ParamSetResult value.
 * @returns {string} The enum constant's name, e.g. "READONLY".
 */
function paramSetResultName(result) {
  const names = Object.keys(host.module.ParamSetResult);
  return names.find((n) => host.module.ParamSetResult[n] === result)
    ?? 'unrecognized result';
}

/**
 * Narrow the resolution dropdown to the rows the engine reports it can build,
 * correcting the active resolution when the hydrated one is not among them.
 * @param {Object} module - The loaded WASM module.
 * @returns {void}
 */
function syncResolutionOptions(module) {
  let supported = null;
  try { supported = module.HolosphereEngine.getSupportedResolutions(); }
  catch (e) { console.warn('getSupportedResolutions failed (offering every preset):', e); }

  const { labels, unlabeled } = offeredResolutions(resolutionPresets, supported);
  if (unlabeled.length > 0) {
    console.warn(`Engine resolutions with no preset (not offered): ${unlabeled.join(', ')}`);
  }
  resolutionController.options(labels);

  const current = appState.get('resolution');
  const corrected = resolutionCorrection(labels, current);
  if (corrected !== null) {
    console.warn(`Resolution "${current}" is not supported by the engine; using "${corrected}".`);
    // Fires the controller's onChange, so appState and the URL both follow.
    resolutionController.setValue(corrected);
  }
}

///////////////////////////////////////////////////////////////////////////////
// Initialize WASM
///////////////////////////////////////////////////////////////////////////////

// Assigned in the GUI setup below; declared here so the load-failure handler can
// tear the Test-All ticker down.
let testAllInterval = null;
let testAllController = null;
let testAllIndex = 0;

/**
 * Stop the Test All ticker, leaving it ready to be started again.
 * @returns {void}
 */
function stopTestAllTicker() {
  if (testAllInterval !== null) {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
}

// Assigned by the teardown wiring at the end of this module, which runs before
// the module promise can settle.
let appTeardown = null;

const moduleLoad = createModuleLoadHandlers({
  teardown: () => appTeardown,
  start: (module) => {
    host.module = module;
    host.engine = new module.HolosphereEngine();

    // Push the Pole LOD value the GUI settled on during the async WASM-load
    // window; its onChange no-op'd while host.engine was null.
    poleLod.replay();

    syncResolutionOptions(module);

    // Resolution and effect are both applied once via applyResolution(true) below,
    // before first paint: it sets the hydrated resolution and validates the hydrated
    // effect against this resolution's allow-list.

    host.adapter = createRenderAdapter({
      host,
      driver: daydream,
      segments,
      syncEffectGui: () => effectGui.sync(),
    });

    console.log("Wasm Engine Loaded");

    // Construct the recorder now that daydream's canvas exists.
    host.recorder = new VideoRecorder(daydream.canvas);
    host.recorder.frameInterval = daydream.frameInterval;
    // Push any Recording settings changed during the async WASM-load window; their
    // setters no-op'd while host.recorder was null.
    host.recorder.bitrateMbps = recSettings.recQuality;
    host.recorder.targetHeight = REC_RESOLUTIONS[recSettings.recResolution];
    host.recorder.format = REC_FORMATS[recSettings.recFormat];
    host.recorder.onFormatFallback = (extension) => {
      const label = Object.keys(REC_FORMATS)
        .find(key => REC_FORMATS[key] === extension) ?? 'Auto';
      recFormatCtrl.setValue(label);
    };
    // An encoder fault ends the session on its own; drop the recording UI so the
    // button doesn't keep offering to stop a session that is already gone.
    host.recorder.onError = () => showRecording(false);
    daydream.recorder = host.recorder;
    recordCtrl.enable();

    const loadingOverlay = document.getElementById('loading-overlay');
    applyInitialState(
      () => apply.applyResolution(true),
      () => loadingOverlay?.remove(),
    );
  },
  discardStartup: () => {
    host.adapter = null;
    host.recorder?.dispose();
    host.recorder = null;
    daydream.recorder = null;
    host.engine?.delete();
    host.engine = null;
  },
  reportFailure: (err) => {
    console.error('Failed to initialize the Holosphere renderer:', err);
    // No engine: the Test All ticker would spin uselessly for the page lifetime.
    stopTestAllTicker();
    if (testAllController) {
      testAllController.setValue(false);
      testAllController.disable();
    }
    const loadingOverlay = document.getElementById('loading-overlay');
    const detailText = (err && err.message) ? err.message : String(err);
    if (loadingOverlay) {
      showBootstrapFailure(err, { title: 'Failed to load the rendering engine.' });
    } else {
      showFatalError(`Failed to initialize the rendering engine. ${detailText}`);
    }
  },
});

createHolosphereModule().then(moduleLoad.onModuleReady).catch(moduleLoad.onModuleFailed);

///////////////////////////////////////////////////////////////////////////////
// GUI + Sidebar Setup
///////////////////////////////////////////////////////////////////////////////

// Namespaced roots: 'fx' keys come from C++ register_param() names, 'view' keys
// from the app's own controls, so the two can never collide in the URL.
const guiInstance = new GUI({ autoPlace: false }, 'view');
guiInstance.domElement.classList.add('global-gui');
if (daydream.isMobile) {
  guiInstance.close();
}
const guiContainer = document.getElementById('gui-container');
if (guiContainer) {
  guiContainer.appendChild(guiInstance.domElement);
} else {
  console.warn('daydream: #gui-container not found; skipping global GUI mount.');
}

// Not deep-linked here: urlSync owns the `resolution` param, so a second writer
// under the 'view' namespace would give the URL two authorities for one setting.
const resolutionController = guiInstance
  .addSession({ resolution: appState.get('resolution') }, 'resolution', Object.keys(resolutionPresets))
  .name('Resolution')
  .onChange((v) => appState.set('resolution', v));

const sidebar = new EffectSidebar(
  document.getElementById('effect-sidebar'),
  (name) => appState.set('effect', name)
);

///////////////////////////////////////////////////////////////////////////////
// Composition — the effect panel, the apply path, and the switch transaction
///////////////////////////////////////////////////////////////////////////////

const effectGui = createEffectGui({
  createGui: () => new GUI({ autoPlace: false }, 'fx'),
  getParameterDefinitions: () => host.engine.getParameterDefinitions(),
  paramGeneration: () => host.paramGeneration(),
  segmentsOwnDisplay: () => segments.ownsDisplay,
  segmentParamValues: () => segments.getParamValues(),
  engineParamValues: () => host.engine.getParamValues(),
  setEngineParam,
  setWorkerParam: (name, value) => segments.setParameter(name, value),
  setAnimationsPaused: (paused) => {
    host.engine.setAnimationsPaused(paused);
    segments.setAnimationsPaused(paused);
  },
  applyEffect: () => apply.applyEffect(),
  guiContainer: () => document.getElementById('gui-container'),
  activeElement: () => document.activeElement,
  isMobile: () => daydream.isMobile,
  dragTarget: window,
  clipboard: () => navigator.clipboard ?? null,
});

const apply = createApplyPipeline({
  appState,
  getEngine: () => host.engine,
  invalidateEngineView: () => host.invalidateView(),
  presets: resolutionPresets,
  availableEffects: favoritesFor,
  effectGui,
  clearEffectParamUrl,
  segments,
  driver: daydream,
  sidebar,
  isRestoring: () => switches.isRestoring(),
});

const switches = createSwitchCoordinator({
  appState,
  getActiveEffect: () => effectGui.active(),
  applyEffect: (preserveParams) => apply.applyEffect(preserveParams),
  applyResolution: (preserveParams) => apply.applyResolution(preserveParams),
  currentUrl: () =>
    window.location.pathname + window.location.search + window.location.hash,
  restoreUrl: (url) => window.history.replaceState({}, '', url),
  showResolution: (resolution) => resolutionController.setValue(resolution),
  syncResolutionUrl: () => urlSync.schedule(),
  logError: (message, error) => console.error(message, error),
  showNotice: showApplyNotice,
  showFatal: showFatalError,
});

testAllController = guiInstance.addSession({ testAll: false }, 'testAll').name('Test All').onChange((v) => {
  if (v) {
    const startList = favoritesFor(appState.get('resolution'));
    testAllIndex = startList.indexOf(appState.get('effect'));
    testAllInterval = setInterval(() => {
      if (!host.engine) return;
      const currentList = favoritesFor(appState.get('resolution'));
      if (currentList.length === 0) return;
      // Advance a persistent index, not one re-derived from the live effect: a
      // rejected setEffect reverts appState to the predecessor, so re-deriving
      // would recompute the same rejected slot forever.
      testAllIndex = (testAllIndex + 1) % currentList.length;
      appState.set('effect', currentList[testAllIndex]);
    }, TEST_ALL_INTERVAL_MS);
  } else {
    stopTestAllTicker();
  }
});


guiInstance.add(daydream, 'labelAxes').name('Show Axes').onChange(() => daydream.invalidate());
guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere').onChange(() => daydream.invalidate());
guiInstance.add(daydream, 'showPip').name('Show PiP').onChange(() => daydream.invalidate());
guiInstance.add(daydream, 'columnFillOverlap', 1.0, 2.0, 0.01).name('Column Fill Overlap').onChange(() => daydream.invalidate());

const poleLod = createPoleLodBinding({
  getEngine: () => host.engine,
  onChange: () => daydream.invalidate(),
});
// The aggressiveness is per module instance, so segmented mode needs it pushed to
// every worker's own engine as well as to the main one; the controller keeps the
// value so a pool spawned later inherits it.
guiInstance.add(poleLod.state, 'poleLod', 0, 2, 0.05).name('Pole LOD')
  .onChange((v) => { poleLod.apply(v); segments.setPoleLod(v); });

// ── Segmented POV controls ──────────────────────────────────────────────────
// The folder name and the segState property names are deep-link key segments
// (view.Segmented POV.<prop>); renaming either invalidates links already shared.
const segFolder = guiInstance.addFolder('Segmented POV');
segFolder.close();
const segState = { segmented: segments.active, segments: segments.count, boundaries: segments.showBoundaries };
// Bumped on every segmented enable/count change and on teardown. An await'd
// handler captures the epoch before warmModules() and bails if a later toggle
// superseded it, so an on->off->on burst spawns the worker pool once, not twice.
let segEpoch = 0;
// Requested size; segments.count follows the live pool and lags this across
// the warmModules() await.
let segCount = segments.count;
/**
 * Fall back to the single-thread engine after a segmented-pool failure, leaving
 * the toggle showing the state the app is actually in.
 * @param {string} label - What failed, for the log line.
 * @param {*} err - The thrown value.
 * @returns {void}
 */
function segmentedFailed(label, err) {
  console.error(`Segmented POV: ${label} failed; falling back to the single engine.`, err);
  segments.active = false;
  // Strand any continuation still awaiting warmModules().
  segEpoch++;
  segments.destroy();
  segments.updateStats();
  // setValue (not updateDisplay) so the deep-link writer drops segmented=true
  // from the URL; it no-ops when the toggle is already false. Its onChange
  // re-runs the teardown, which is idempotent.
  segEnabledCtrl.setValue(false);
}
const segEnabledCtrl = segFolder.add(segState, 'segmented').name('Enabled').onChange(async v => {
  try {
    segments.active = v;
    const epoch = ++segEpoch;
    if (v) {
      // Reopen the (idle-dropped) keep-alive connection and prime the module cache
      // before the worker-spawn burst.
      await warmModules();
      if (epoch === segEpoch && segments.active) segments.create(segCount);
    } else {
      segments.destroy();
      segments.updateStats();
    }
  } catch (e) {
    segmentedFailed(v ? 'enable' : 'teardown', e);
  }
});
segFolder.add(segState, 'segments', 2, 8, 2).name('Segments').onChange(async v => {
  try {
    segCount = v;
    const epoch = ++segEpoch;
    if (segments.active) {
      await warmModules();
      if (epoch === segEpoch && segments.active) segments.create(segCount);
    }
  } catch (e) {
    segmentedFailed('resize', e);
  }
});
segFolder.addSession(segState, 'boundaries').name('Show Boundaries').onChange(v => {
  segments.showBoundaries = v;
});

// Video recording
const REC_RESOLUTIONS = { 'Native': null, '720p': 720, '1080p': 1080 };
const REC_FORMATS = { 'Auto': 'auto', 'MP4': 'mp4', 'WebM': 'webm' };
// These settings are latched at recorder.start(); warn that a mid-recording
// change won't take effect until the next start().
const warnIfRecording = (label) => {
  if (host.recorder?.isRecording) {
    console.warn(`Recording: ${label} change applies to the next recording (the current one is already running).`);
  }
};
/** GUI-bound recording settings, replayed onto a recorder constructed later. */
const recSettings = {};
/**
 * Defines one recording setting: the value is held privately and pushed to the
 * live recorder on every write.
 * @param {string} prop - Property name on recSettings.
 * @param {*} initial - Value before the GUI or a recorder exists.
 * @param {string} label - Setting name used in the mid-recording warning.
 * @param {function(*): void} push - Applies the value to the live host.recorder.
 * @returns {void}
 */
const defineRecSetting = (prop, initial, label, push) => {
  let value = initial;
  Object.defineProperty(recSettings, prop, {
    enumerable: true,
    get() { return value; },
    set(v) {
      value = v;
      if (host.recorder) push(v);
      warnIfRecording(label);
    },
  });
};
defineRecSetting('recQuality', 16, 'bitrate',
  v => { host.recorder.bitrateMbps = v; });
defineRecSetting('recResolution', 'Native', 'resolution',
  v => { host.recorder.targetHeight = REC_RESOLUTIONS[v]; });
defineRecSetting('recFormat', 'Auto', 'format',
  v => { host.recorder.format = REC_FORMATS[v]; });

const durationEl = document.createElement('div');
durationEl.className = 'rec-duration';
durationEl.style.display = 'none';
document.getElementById('canvas-container')?.appendChild(durationEl);

/**
 * Reflects the session state in the canvas styling, duration readout, and record
 * button label.
 * @param {boolean} recording - Whether a recording session is now active.
 * @returns {void}
 */
const showRecording = (recording) => {
  const canvasEl = document.getElementById('canvas-container');
  if (recording) {
    canvasEl?.classList.add('recording');
    durationEl.style.display = '';
    recordCtrl.name('\u25a0 Stop');
  } else {
    canvasEl?.classList.remove('recording');
    durationEl.style.display = 'none';
    recordCtrl.name('\u25cf Record');
  }
};

const recordState = { record: () => {
  if (!host.recorder) {
    console.warn('Recording is unavailable until the rendering engine finishes loading.');
    return;
  }
  showRecording(host.recorder.toggle(appState.get('effect')));
}};

const recFolder = guiInstance.addFolder('Recording');
recFolder.close();
recFolder.addSession(recSettings, 'recQuality', 1, 20, 1).name('Rec Quality (Mbps)');
recFolder.addSession(recSettings, 'recResolution', Object.keys(REC_RESOLUTIONS)).name('Rec Resolution');
const recFormatCtrl =
  recFolder.addSession(recSettings, 'recFormat', Object.keys(REC_FORMATS)).name('Rec Format');
const recordCtrl = recFolder.add(recordState, 'record').name('\u25cf Record');
recordCtrl.disable();
const onKeyDown = createGlobalKeydownHandler({ dispatch: (e) => daydream.keydown(e) });
window.addEventListener("keydown", onKeyDown);

const onUnhandledRejection = createUnhandledRejectionHandler({ report: showFatalError });
window.addEventListener("unhandledrejection", onUnhandledRejection);

daydream.renderer.setAnimationLoop(() => {
  if (host.adapter) {
    daydream.render(host.adapter);
  }
  if (host.recorder?.isRecording) {
    durationEl.textContent = host.recorder.elapsedFormatted;
  }
});

///////////////////////////////////////////////////////////////////////////////
// Teardown
///////////////////////////////////////////////////////////////////////////////

appTeardown = createAppTeardown({
  pageTarget: window,
  listeners: [
    ["keydown", onKeyDown],
    ["unhandledrejection", onUnhandledRejection],
  ],
  switches,
  stopTimers: () => { stopTestAllTicker(); showApplyNotice(null); },
  effectGui,
  globalGui: guiInstance,
  host,
  urlSync,
  sidebar,
  driver: daydream,
  segments,
  strandSegmentWork: () => { segEpoch++; },
  removeOverlay: () => durationEl.remove(),
});
