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
  createApplyNotice,
  createFrameLoopGuard,
  createGlobalKeydownHandler,
  createModuleLoadHandlers,
  createPoleLodBinding,
  createRecordingSettings,
  createRenderAdapter,
  createSegmentSpawnGuard,
  createSegmentedFallback,
  createTestAllTicker,
  createUnhandledRejectionHandler,
  repointDisplayAliases,
} from "./app_lifecycle.js";
import { AppState, URLSync, replaceUrl } from "./state.js";
import { VideoRecorder } from "./recorder.js";
import {
  SEGMENT_CONTROLLER_API_VERSION,
  SegmentController,
  maxSegmentCount,
  warmModules,
} from "./segment_controller.js";
import { EngineHost } from "./engine_host.js";
import { showFatalError } from "./tools/banner.js";
import { showBootstrapFailure } from "./bootstrap.js";
import { copyToClipboard } from "./tools/copy_text.js";

// UI layer degrades gracefully (log + keep last good state); lower layers trap.

// Dwell time per effect while "Test All" cycles the favorites list.
const TEST_ALL_INTERVAL_MS = 1000;
const EXPECTED_SEGMENT_CONTROLLER_API_VERSION = 1;

if (SEGMENT_CONTROLLER_API_VERSION !== EXPECTED_SEGMENT_CONTROLLER_API_VERSION) {
  throw new Error('Cached segment_controller.js is incompatible; reload the simulator.');
}

const HiResFavorites = [
  "BZReactionDiffusion",
  "ChaoticStrings",
  "Comets",
  "DreamBalls",
  "MeshFeedback",
  "ShaderBall",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "HopfFibration",
  "IslamicStars",
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
  "ShaderBall",
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
// getSupportedResolutions(). Null prototype: a URL string indexes this table, and
// an inherited key ("constructor", "toString") would answer as a preset.
const resolutionPresets = {
  __proto__: null,
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
  resolution: (v) => Object.hasOwn(resolutionPresets, v),
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

const applyNotice = createApplyNotice({ doc: document });

// Owner tags for the shared notice element: a parameter write clears only its
// own message, leaving a switch rejection standing.
const PARAM_NOTICE = 'param';
const SWITCH_NOTICE = 'switch';
const RECORD_NOTICE = 'record';

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
    applyNotice.show(message, PARAM_NOTICE);
  } else {
    applyNotice.show(null, PARAM_NOTICE);
  }
}

const applyNoticeDismiss = document.getElementById('apply-notice-dismiss');
const onApplyNoticeDismiss = () => applyNotice.clear();
applyNoticeDismiss?.addEventListener('click', onApplyNoticeDismiss);

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
    // Muted: the onChange still carries the correction into appState and the URL,
    // but the apply is applyInitialState's single preserving one below.
    switches.mute(() => resolutionController.setValue(corrected));
  }
}

///////////////////////////////////////////////////////////////////////////////
// Initialize WASM
///////////////////////////////////////////////////////////////////////////////

// Assigned in the GUI setup below; declared here so the load-failure handler can
// switch the Test All toggle off and disable it.
let testAllController = null;

const testAllTicker = createTestAllTicker({
  intervalMs: TEST_ALL_INTERVAL_MS,
  availableEffects: () => favoritesFor(appState.get('resolution')),
  getEffect: () => appState.get('effect'),
  setEffect: (name) => appState.set('effect', name),
  engineReady: () => Boolean(host.engine),
});

// Assigned by the teardown wiring at the end of this module, which runs before
// the WASM load below it is kicked off.
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
    recording.replay();
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
    host.dispose();
    daydream.recorder = null;
  },
  reportFailure: (err) => {
    console.error('Failed to initialize the Holosphere renderer:', err);
    // No engine: the Test All ticker would spin uselessly for the page lifetime.
    testAllTicker.stop();
    if (testAllController) {
      testAllController.setValue(false);
      testAllController.disable();
    }
    if (!showBootstrapFailure(err, { title: 'Failed to load the rendering engine.' })) {
      const detailText = (err && err.message) ? err.message : String(err);
      showFatalError(`Failed to initialize the rendering engine. ${detailText}`);
    }
  },
});

///////////////////////////////////////////////////////////////////////////////
// GUI + Sidebar Setup
///////////////////////////////////////////////////////////////////////////////

// Namespaced roots keep the URL keys apart: 'fx' holds the C++ register_param()
// names plus the panel's own 'pause' toggle, 'view' the app's own controls.
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

const sidebarContainer = document.getElementById('effect-sidebar');
if (!sidebarContainer) {
  console.warn('daydream: #effect-sidebar not found; the effect list is not shown.');
}
// Off-document fallback: the sidebar is a collaborator of the apply pipeline and
// of the teardown, so it exists whether or not the page offers it a mount point.
const sidebar = new EffectSidebar(
  sidebarContainer ?? document.createElement('div'),
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
  segmentParamGeneration: () => segments.getParamGeneration(),
  engineParamValues: () => host.engine.getParamValues(),
  setEngineParam,
  setWorkerParam: (name, value) => segments.setParameter(name, value),
  setAnimationsPaused: (paused) => {
    host.engine.setAnimationsPaused(paused);
    segments.setAnimationsPaused(paused);
  },
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
  engineAnimationsPaused: () => host.engine.getAnimationsPaused?.(),
  applyEffect: () => apply.applyEffect(),
  guiContainer: () => document.getElementById('gui-container'),
  activeElement: () => document.activeElement,
  isMobile: () => daydream.isMobile,
  dragTarget: window,
  copyText: copyToClipboard,
});

const apply = createApplyPipeline({
  appState,
  getEngine: () => host.engine,
  getModule: () => host.module,
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
  restoreUrl: replaceUrl,
  showResolution: (resolution) => resolutionController.setValue(resolution),
  syncResolutionUrl: () => urlSync.schedule(),
  logError: (message, error) => console.error(message, error),
  showNotice: (message) => applyNotice.show(message, SWITCH_NOTICE),
  showFatal: showFatalError,
});

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
// Every pool member holds a WASM heap of its own, so the ceiling is what the
// device can carry. The slider is built against it, which is also what bounds a
// deep link — addWithHydration clamps an over-cap URL value and rewrites the URL.
const segMax = maxSegmentCount(navigator, daydream.isMobile);
const segState = {
  segmented: segments.active,
  segments: Math.min(segments.count, segMax),
  boundaries: segments.showBoundaries,
};
// Requested size; segments.count follows the live pool and lags this across
// the warmModules() await.
let segCount = segState.segments;
const segSpawn = createSegmentSpawnGuard({
  warmModules,
  spawn: () => segments.create(segCount),
  isActive: () => segments.active,
});
const segmentedFailed = createSegmentedFallback({
  segments,
  strand: () => segSpawn.strand(),
  showNotice: (message) => applyNotice.show(message, SWITCH_NOTICE),
  // No-ops when the toggle is already false.
  showToggle: (on) => segEnabledCtrl.setValue(on),
});
const segEnabledCtrl = segFolder.add(segState, 'segmented').name('Enabled').onChange(async v => {
  try {
    segments.active = v;
    if (v) {
      await segSpawn.respawn();
    } else {
      segSpawn.strand();
      segments.destroy();
      segments.updateStats();
    }
  } catch (e) {
    segmentedFailed(v ? 'enable' : 'teardown', e);
  }
});
// The firmware takes a power-of-two segment count <= 8, so 6 is extra worker
// parallelism no hardware produces; the label says so, since the per-segment
// overlay otherwise names boards that cannot exist. A device cap that drops 6
// from the range takes the marker with it and names the cap instead.
const segLabel = segMax >= 6 ? 'Segments (6 = sim only)' : `Segments (max ${segMax} here)`;
segFolder.add(segState, 'segments', 2, segMax, 2).name(segLabel).onChange(async v => {
  try {
    segCount = v;
    if (segments.active) await segSpawn.respawn();
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
const recording = createRecordingSettings({ getRecorder: () => host.recorder });
const recSettings = recording.settings;
recording.define('recQuality', 16, 'bitrate',
  (recorder, v) => { recorder.bitrateMbps = v; });
recording.define('recResolution', 'Native', 'resolution',
  (recorder, v) => { recorder.targetHeight = REC_RESOLUTIONS[v]; });
recording.define('recFormat', 'Auto', 'format',
  (recorder, v) => { recorder.format = REC_FORMATS[v]; });

const durationEl = document.createElement('div');
durationEl.className = 'rec-duration';
durationEl.style.display = 'none';
document.getElementById('canvas-container')?.appendChild(durationEl);

// Last string written to durationEl, so the animation loop only touches the DOM
// on a second boundary rather than on every display frame.
let durationText = null;

/**
 * Reflects the session state in the canvas styling, duration readout, and record
 * button label.
 * @param {boolean} recording - Whether a recording session is now active.
 * @returns {void}
 */
const showRecording = (recording) => {
  durationText = null;
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
  const recording = host.recorder.toggle(appState.get('effect'));
  // The canvas tint, the duration readout, and the button label are all visual;
  // the notice region is what carries the state change to assistive tech.
  const axisWarning = recording && daydream.labelAxes
    ? ' Axis labels are page overlays, not canvas pixels; the recording will not carry them.'
    : '';
  applyNotice.show(
    `${recording ? 'Recording started.' : 'Recording stopped.'}${axisWarning}`,
    RECORD_NOTICE);
  showRecording(recording);
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

daydream.renderer.setAnimationLoop(createFrameLoopGuard({
  frame: () => {
    if (host.adapter) {
      daydream.render(host.adapter);
    }
    if (host.recorder?.isRecording) {
      const elapsed = host.recorder.elapsedFormatted;
      if (elapsed !== durationText) {
        durationText = elapsed;
        durationEl.textContent = elapsed;
      }
    }
  },
  report: showFatalError,
}));

///////////////////////////////////////////////////////////////////////////////
// Teardown
///////////////////////////////////////////////////////////////////////////////

appTeardown = createAppTeardown({
  pageTarget: window,
  listeners: [
    ["keydown", onKeyDown],
    ["unhandledrejection", onUnhandledRejection],
    ...(applyNoticeDismiss
      ? [["click", onApplyNoticeDismiss, applyNoticeDismiss]]
      : []),
  ],
  switches,
  stopTimers: () => { testAllTicker.stop(); applyNotice.clear(); },
  effectGui,
  globalGui: guiInstance,
  host,
  urlSync,
  sidebar,
  driver: daydream,
  segments,
  strandSegmentWork: () => segSpawn.strand(),
  removeOverlay: () => durationEl.remove(),
});

// Last: a throw anywhere above aborts module evaluation, and a load already in
// flight would then build an engine into a half-built module — no teardown to
// release it, no pagehide listener. Only synchronous construction sits between
// this and the import, so the binary's fetch still starts in the same task.
createHolosphereModule().then(moduleLoad.onModuleReady).catch(moduleLoad.onModuleFailed);
