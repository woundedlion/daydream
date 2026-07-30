/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import createHolosphereModule from "./holosphere_wasm.js";
import { Daydream } from "./driver.js";
import { GUI, resetGUI } from "./gui.js";
import { EffectSidebar } from "./sidebar.js";
import {
  planResolutionApply,
  paramValueSkew,
  paramExportBlocker,
  paramGenerationStale,
  applyInitialState,
  createSwitchCoordinator,
  offeredResolutions,
  resolutionCorrection,
  resolutionEffects,
} from "./effect_sequencing.js";
import { AppState, URLSync } from "./state.js";
import { VideoRecorder } from "./recorder.js";
import { SegmentController, warmModules } from "./segment_controller.js";
import { EngineHost } from "./engine_host.js";
import {
  resolveParamSync,
  enumChoices,
  paramControlKind,
  engineParamValue,
} from "./param_sync.js";
import { formatExportParams } from "./tools/export_params.js";
import { showFatalError } from "./tools/banner.js";
import { showBootstrapFailure } from "./bootstrap.js";

// UI layer degrades gracefully (log + keep last good state); lower layers trap.

// How long a transient button label (Export status) stays before reverting.
const FLASH_MS = 1500;
// Transient Export button labels.
const EXPORT_COPIED = '\u2713 Copied!';
const EXPORT_FAILED = '\u2717 Copy failed';
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

// Re-point both display aliases (Three.js instanceColor + daydream.pixels) so
// source, displayed attribute, and daydream.pixels all reference the same WASM
// view. Shared by EngineHost.refresh(), drawFrame's alias heal, and
// SegmentController's composite heal.
function repointDisplayAliases(view) {
  daydream.dotMesh.instanceColor.array = view;
  daydream.dotMesh.instanceColor.needsUpdate = true;
  daydream.pixels = view;
}

const host = new EngineHost(repointDisplayAliases);

// Throttle the syncGUI param/value length-skew warning to once per skew episode.
let syncGuiSkewLogged = false;

/**
 * Live per-frame parameter values for the active effect. Once the worker pool
 * owns the display the main engine is no longer stepped, so its values are
 * stale; source from segment 0's worker instead (the pool drops its values on an
 * effect switch and fences the stream on renderGen). May be null or zero-length
 * if the WASM view detached on heap growth — callers must guard.
 * @returns {Float32Array|number[]|null} Null when no stream describes the GUI's
 *   current parameter snapshot.
 */
function liveParamValues() {
  if (segments.ownsDisplay) return segments.getParamValues();
  // The main engine's value stream describes whatever effect it last loaded;
  // pairing it with a snapshot from an earlier load binds sliders to another
  // effect's values, which equal parameter counts would hide.
  if (activeEffect
      && paramGenerationStale(activeEffect.paramGeneration, host.paramGeneration())) {
    return null;
  }
  return host.engine.getParamValues();
}

/**
 * Push the engine's per-frame parameter values back into the effect GUI so
 * animation-driven params track live, without clobbering controllers the user
 * is actively editing.
 * @returns {void}
 */
function syncGUI() {
  if (!activeEffect || !activeEffect.controllerByName) return;
  if (!activeEffect.hasLiveParams) return;

  const values = liveParamValues();
  if (!values || values.length === 0) return;

  const names = activeEffect.paramNames;
  // A names/values length skew means the cached param list drifted from the
  // engine's value stream (e.g. a stale list after an async effect change); skip
  // rather than silently mis-bind sliders by index, mirroring export()'s check.
  if (paramValueSkew(names.length, values.length)) {
    if (!syncGuiSkewLogged) {
      console.warn(`syncGUI: param/value length skew (${names.length} vs ${values.length}); skipping sync`);
      syncGuiSkewLogged = true;
    }
    return;
  }
  syncGuiSkewLogged = false;
  const n = names.length;
  for (let i = 0; i < n; i++) {
    const c = activeEffect.controllerByName.get(names[i]);
    if (!c) continue;

    // lil-gui sliders drag via a non-focusable div, invisible to activeElement,
    // so dragging covers an in-progress drag.
    const isEditing =
      c.dragging || c.domElement.contains(document.activeElement);

    const { update, value } = resolveParamSync(
      c.getValue(), values[i], c.isBoolean, isEditing);
    if (!update) continue;
    c.object[c.property] = value;
    c.updateDisplay();
  }
}

///////////////////////////////////////////////////////////////////////////////
// Instances
///////////////////////////////////////////////////////////////////////////////

const daydream = new Daydream();
let activeEffect;

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
  repointDisplayAliases,
  statsDoc: document,
});

///////////////////////////////////////////////////////////////////////////////
// Reactive Handlers — subscribe to appState
///////////////////////////////////////////////////////////////////////////////

/**
 * Tear down the active effect GUI and clear activeEffect. The drag's
 * pointerup/pointercancel listeners live on `window`, not the GUI DOM, so
 * destroying the GUI mid-drag would leave them dangling — drain them first.
 * @returns {void}
 */
function destroyActiveEffectGui() {
  if (activeEffect && activeEffect.gui) {
    // A pending Export flash would otherwise fire into a destroyed controller.
    clearTimeout(activeEffect.exportFlashTimer);
    activeEffect.exportFlashTimer = null;
    if (activeEffect.activeDragEnds) {
      for (const end of activeEffect.activeDragEnds) {
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      }
      activeEffect.activeDragEnds.clear();
    }
    const dom = activeEffect.gui.domElement;
    if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
    // Only lil-gui's own teardown is tolerated to throw; a leaked listener set or
    // a detached DOM node above is a real bug and should surface, not be muffled.
    try {
      activeEffect.gui.destroy();
    } catch (e) {
      console.warn("GUI destroy warning:", e);
    }
  }
  activeEffect = null;
}

/**
 * Tear down the current effect GUI and build a new one for the active effect.
 * @param {boolean} [preserveParams=false] - When true, keep the existing per-effect
 *   param URL entries (used during initial hydration); when false, clear them since
 *   they don't apply to the newly selected effect.
 * @returns {boolean|void} false when the engine rejected the effect (the caller
 *   must revert appState so UI/URL don't advertise an unapplied effect); otherwise
 *   undefined.
 */
function applyEffect(preserveParams = false) {
  // A rejected effect leaves the engine unchanged, so return before the worker
  // broadcast below: sending the rejected name would diverge them from main.
  if (host.engine && !selectEngineEffect()) return false;

  destroyActiveEffectGui();
  if (!preserveParams) clearEffectParamUrl();
  if (host.engine) buildActiveEffectGui();
  mountActiveEffectGui();

  // Gated on segmented mode, not on a live pool: a faulted pool can hold no
  // workers, and setEffect() is the trigger that rebuilds it from appState.
  if (segments.active) {
    segments.setEffect(appState.get('effect'));
  }

  sidebar.setActive(appState.get('effect'));
}

/**
 * Point the engine at the state's effect and mirror its strobe layout onto the
 * driver.
 * @returns {boolean} False when the engine rejected the effect.
 */
function selectEngineEffect() {
  const effect = appState.get('effect');
  const applied = host.engine.setEffect(effect) !== false;
  daydream.setStrobeColumns(host.engine.strobeColumns());
  if (!applied) {
    console.error(`setEffect("${effect}") failed; effect unavailable.`);
  }
  return applied;
}

/**
 * Drop the outgoing effect's param URL entries, keeping the global GUI's keys.
 * @returns {void}
 */
function clearEffectParamUrl() {
  resetGUI(['resolution', 'effect', ...guiInstance.collectUrlKeys()]);
}

/**
 * Build the effect GUI for the engine's current effect and install it as the
 * active effect record.
 * @returns {void}
 */
function buildActiveEffectGui() {
  activeEffect = { gui: new GUI({ autoPlace: false }, 'fx'), activeDragEnds: new Set() };
  // Identity of this GUI's effect record, so async continuations can tell whether
  // a switch has since replaced it.
  const fx = activeEffect;

  const params = host.engine.getParameterDefinitions();
  // Stamp the snapshot with the engine's effect-load generation so a later value
  // read can prove it describes these definitions.
  fx.paramGeneration = host.paramGeneration();

  addEffectActions(fx, params);
  const pause = addPauseToggle(fx, params);
  addParamControllers(fx, params, pause);
}

/**
 * Add the effect GUI's Reset and Export buttons.
 * @param {Object} fx - The effect record being built.
 * @param {Array<Object>} params - The engine's parameter definitions.
 * @returns {void}
 */
function addEffectActions(fx, params) {
  /**
   * Flash a transient status label on the Export button, restoring the default
   * label after the flash window. Supersedes any flash still pending for this GUI.
   * @param {string} label - The transient button label to show.
   * @returns {void}
   */
  const flashExport = (label) => {
    clearTimeout(fx.exportFlashTimer);
    exportCtrl.name(label);
    fx.exportFlashTimer = setTimeout(() => exportCtrl.name('Export'), FLASH_MS);
  };

  const effectActions = {
    /**
     * Rebuild the effect GUI from the engine's current state, discarding edits.
     * @returns {void}
     */
    reset() { applyEffect(); },
    /**
     * Copy the current parameter values to the clipboard as a C++ brace-init
     * list of float literals, then flash the outcome on the Export button.
     * @returns {void}
     */
    export() { exportParams(fx, params, flashExport); }
  };
  fx.gui.add(effectActions, 'reset').name('Reset');
  const exportCtrl = fx.gui.add(effectActions, 'export').name('Export');
}

/**
 * Write the live parameter values to the clipboard as a C++ brace-init list.
 * @param {Object} fx - The effect record owning the Export button.
 * @param {Array<Object>} params - The engine's parameter definitions.
 * @param {(label: string) => void} flashExport - Shows a transient Export label.
 * @returns {void}
 */
function exportParams(fx, params, flashExport) {
  const values = liveParamValues();
  const blocked = paramExportBlocker(
    values, fx.paramNames.length, Boolean(navigator.clipboard));
  if (blocked) {
    console.warn(blocked);
    flashExport(EXPORT_FAILED);
    return;
  }

  navigator.clipboard.writeText(formatExportParams(params, values)).then(() => {
    if (activeEffect !== fx) return;
    flashExport(EXPORT_COPIED);
  }).catch((err) => {
    console.warn('Export: clipboard write failed', err);
    if (activeEffect !== fx) return;
    flashExport(EXPORT_FAILED);
  });
}

/**
 * Add the "Pause Animation" toggle, offered only when the effect has an animated
 * param.
 * @param {Object} fx - The effect record being built.
 * @param {Array<Object>} params - The engine's parameter definitions.
 * @returns {{animationState: {pause: boolean}, controller: Object|null,
 *   setPaused: (v: boolean) => void}} The toggle's state, its controller (null
 *   when no param animates), and the writer that pauses both engines.
 */
function addPauseToggle(fx, params) {
  const animationState = { pause: false };
  /**
   * Pause or resume animation-driven params on both the main engine and the
   * segment-worker pool, keeping the local toggle state in sync.
   * @param {boolean} v - True to freeze animations, false to resume.
   * @returns {void}
   */
  const setPaused = (v) => {
    animationState.pause = v;
    host.engine.setAnimationsPaused(v);
    segments.setAnimationsPaused(v);
  };

  let controller = null;
  if (params.some(p => p.animated)) {
    controller = fx.gui.add(animationState, 'pause').name('Pause Animation');
    controller.onChange(setPaused);
  }
  fx.animationState = animationState;
  fx.pauseController = controller;
  return { animationState, controller, setPaused };
}

/**
 * Build one controller per engine parameter, recording the value-stream order
 * and seeding the engine with each initial value.
 * @param {Object} fx - The effect record being built.
 * @param {Array<Object>} params - The engine's parameter definitions.
 * @param {{animationState: Object, controller: Object|null, setPaused: Function}}
 *   pause - The effect's pause toggle.
 * @returns {void}
 */
function addParamControllers(fx, params, pause) {
  // paramNames records the value-stream order; syncGUI() binds by name, not
  // index, so a C++ param reorder can't mis-bind sliders.
  const state = {};
  fx.paramNames = [];
  fx.writableParamNames = [];
  fx.controllerByName = new Map();
  // animated (animation-driven) and readonly (engine telemetry) are the only
  // params the engine rewrites per frame; a set without them lets syncGUI skip.
  fx.hasLiveParams = params.some(p => p.animated || p.readonly);

  params.forEach(p => {
    state[p.name] = p.value;

    const controller = addParamControl(fx.gui, state, p);
    fx.paramNames.push(p.name);
    fx.controllerByName.set(p.name, controller);

    if (p.readonly) {
      if (typeof controller.disable === 'function') controller.disable();
    } else {
      fx.writableParamNames.push(p.name);
      trackDragState(fx, controller);
      // Push the GUI's initial value into the engine: a ?param=value deep link
      // sets state[p.name] but fires no onChange, so the engine would otherwise
      // render the default while the slider shows the URL value.
      setEngineParam(p.name, engineParamValue(state[p.name]));
    }

    controller.onChange(v => {
      const value = engineParamValue(v);
      setEngineParam(p.name, value);
      segments.setParameter(p.name, value);
      // Touching an animated slider takes over from the animation.
      if (p.animated && pause.controller && !pause.animationState.pause) {
        pause.setPaused(true);
        pause.controller.updateDisplay();
      }
    });
  });
}

/**
 * Add the lil-gui control one engine parameter definition calls for.
 * @param {Object} gui - The effect GUI to add to.
 * @param {Object} state - The GUI-bound value object.
 * @param {Object} p - The parameter definition.
 * @returns {Object} The created controller.
 */
function addParamControl(gui, state, p) {
  const kind = paramControlKind(p);
  let controller;
  if (kind === 'boolean') {
    controller = gui.add(state, p.name);
  } else if (kind === 'enum') {
    // Dropdown of labels whose values are the option indices the engine expects.
    controller = gui.add(state, p.name, enumChoices(p.options));
  } else {
    controller = gui.add(state, p.name, p.min, p.max).decimals(3);
  }
  controller.isBoolean = (kind === 'boolean');
  return controller;
}

/**
 * Write one parameter value to the main engine.
 * @param {string} name - The engine parameter name.
 * @param {number} value - The float value to write.
 * @returns {void}
 */
function setEngineParam(name, value) {
  if (host.engine.setParameter(name, value) === false)
    console.warn(`setParameter("${name}") rejected as unknown.`);
}

/**
 * Flag a controller as dragging until the pointer is released, so syncGUI()'s
 * value stream doesn't fight the drag. The drag-end listeners live on `window`,
 * so they join the effect record's set for a GUI destroyed mid-drag to drain.
 * @param {Object} fx - The effect record owning the controller.
 * @param {Object} controller - The controller to track.
 * @returns {void}
 */
function trackDragState(fx, controller) {
  controller.domElement.addEventListener('pointerdown', () => {
    controller.dragging = true;
    const end = () => {
      controller.dragging = false;
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      fx.activeDragEnds.delete(end);
    };
    fx.activeDragEnds.add(end);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
}

/**
 * Mount the active effect GUI in the page's GUI container.
 * @returns {void}
 */
function mountActiveEffectGui() {
  if (!activeEffect || !activeEffect.gui) return;

  // Driver's container-width isMobile, not window.innerWidth (differs for a
  // narrow container in a wide window).
  if (daydream.isMobile) activeEffect.gui.close();

  const container = document.getElementById('gui-container');
  if (!container) return;
  const dom = activeEffect.gui.domElement;
  dom.classList.add('effect-gui');
  dom.classList.remove('global-gui');
  container.appendChild(dom);
}

/**
 * Apply a resolution change: resize geometry, refresh sidebar list, then re-apply effect.
 * @param {boolean} [preserveParams=false] - When true, keep the active effect's
 *   param URL entries through the re-apply (only if the effect is still offered;
 *   an off-list effect is corrected to the list's first entry, dropping its
 *   effect-specific URL entries regardless).
 * @returns {boolean|void} false when the resolution was not applied — an unknown
 *   preset name, or an engine rejection — so the caller must revert appState and
 *   UI/URL don't advertise an unapplied value; otherwise undefined.
 */
function applyResolution(preserveParams = false) {
  const resolution = appState.get('resolution');
  const p = resolutionPresets[resolution];
  if (!p) {
    console.error(`Unknown resolution preset "${resolution}"; keeping current.`);
    return false;
  }

  if (host.engine) {
    if (host.engine.setResolution(p.w, p.h) === false) {
      console.error(`Unsupported resolution ${p.w}x${p.h}; keeping current.`);
      return false;
    }
    host.invalidateView(); // force host.refresh() to re-fetch after resize
  }

  // Gated on segmented mode, not on a live pool: a faulted pool can hold no
  // workers, and setResolution() is the trigger that rebuilds it from appState.
  if (segments.active) {
    segments.setResolution(p.w, p.h);
  }

  const availableEffects = favoritesFor(resolution);

  daydream.updateResolution(p.w, p.h, p.dotSize);

  let effectSizes = null;
  if (host.engine) {
    try { effectSizes = host.engine.getEffectSizes(); }
    catch (e) { console.warn('getEffectSizes failed (sidebar sizes unavailable):', e); }
  }
  sidebar.setEffects(availableEffects, effectSizes);

  // Done after updateResolution()/setEffects() because appState.set('effect',…)
  // synchronously fires applyEffect(), which would otherwise build against the
  // pre-resize dot mesh / stale sidebar.
  const { nextEffect, effectChanged, applyDirectly } =
    planResolutionApply(availableEffects, appState.get('effect'), switches.isRestoring());
  if (effectChanged) {
    appState.set('effect', nextEffect);
    if (appState.get('effect') !== nextEffect) return false;
  }

  if (applyDirectly) {
    if (applyEffect(preserveParams) === false) return false;
  }

  daydream.invalidate();
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

const switches = createSwitchCoordinator({
  appState,
  getActiveEffect: () => activeEffect,
  applyEffect,
  applyResolution,
  currentUrl: () =>
    window.location.pathname + window.location.search + window.location.hash,
  restoreUrl: (url) => window.history.replaceState({}, '', url),
  showResolution: (resolution) => resolutionController.setValue(resolution),
  syncResolutionUrl: () => urlSync.setParam('resolution', appState.get('resolution')),
  logError: (message, error) => console.error(message, error),
  showFatal: showFatalError,
});

///////////////////////////////////////////////////////////////////////////////
// Initialize WASM
///////////////////////////////////////////////////////////////////////////////

// Assigned in the GUI setup below; declared here so the load-failure handler can
// tear the Test-All ticker down.
let testAllInterval = null;
let testAllController = null;
let appDisposed = false;
let testAllIndex = 0;

createHolosphereModule().then(module => {
  host.module = module;
  host.engine = new module.HolosphereEngine();

  syncResolutionOptions(module);

  // Resolution and effect are both applied once via applyResolution(true) below,
  // before first paint: it sets the hydrated resolution and validates the hydrated
  // effect against this resolution's allow-list.

  let aliasDivergenceLogged = false;
  host.adapter = {
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
        if (daydream.pixels !== view ||
            daydream.dotMesh.instanceColor.array !== view) {
          if (!aliasDivergenceLogged) {
            console.error(
              "drawFrame: display-buffer alias diverged after host.refresh() — " +
              "re-pointing daydream.pixels / instanceColor.array at the WASM view");
            aliasDivergenceLogged = true;
          }
          repointDisplayAliases(view);
        }
        daydream.dotMesh.instanceColor.needsUpdate = true;
      }
      syncGUI();
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

  console.log("Wasm Engine Loaded");

  // Construct the recorder now that daydream's canvas exists.
  host.recorder = new VideoRecorder(daydream.canvas);
  host.recorder.frameInterval = daydream.frameInterval;
  // Push any Recording settings changed during the async WASM-load window; their
  // setters no-op'd while host.recorder was null.
  host.recorder.bitrateMbps = recSettings.quality;
  host.recorder.targetHeight = REC_RESOLUTIONS[recSettings.resolution];
  host.recorder.format = REC_FORMATS[recSettings.format];
  // An encoder fault ends the session on its own; drop the recording UI so the
  // button doesn't keep offering to stop a session that is already gone.
  host.recorder.onError = () => showRecording(false);
  daydream.recorder = host.recorder;

  const loadingOverlay = document.getElementById('loading-overlay');
  applyInitialState(
    () => applyResolution(true),
    () => loadingOverlay?.remove(),
  );
}).catch(err => {
  console.error('Failed to initialize the Holosphere renderer:', err);
  // No engine: the Test All ticker would spin uselessly for the page lifetime.
  if (testAllInterval !== null) {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
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
});

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
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
});


guiInstance.add(daydream, 'labelAxes').name('Show Axes').onChange(() => daydream.invalidate());
guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere').onChange(() => daydream.invalidate());
guiInstance.add(daydream, 'columnFillOverlap', 1.0, 2.0, 0.01).name('Column Fill Overlap').onChange(() => daydream.invalidate());

// Near-pole azimuthal shading decimation. 1.0 is the physically-neutral
// setting: one shade per run of columns sharing an LED footprint. Higher
// trades fidelity for render time; 0 disables.
const poleLodState = { poleLod: 0 };
guiInstance.add(poleLodState, 'poleLod', 0, 2, 0.05).name('Pole LOD').onChange(v => {
  host.engine?.setPoleLod(v);
  daydream.invalidate();
});

// ── Segmented POV controls ──────────────────────────────────────────────────
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
const recSettings = { quality: 16, resolution: 'Native', format: 'Auto' };
// These settings are latched at recorder.start(); warn that a mid-recording
// change won't take effect until the next start().
const warnIfRecording = (label) => {
  if (host.recorder?.isRecording) {
    console.warn(`Recording: ${label} change applies to the next recording (the current one is already running).`);
  }
};
Object.defineProperty(recSettings, 'recQuality', {
  get() { return this.quality; },
  set(v) {
    this.quality = v;
    if (host.recorder) host.recorder.bitrateMbps = v;
    warnIfRecording('bitrate');
  }
});
Object.defineProperty(recSettings, 'recResolution', {
  get() { return this.resolution; },
  set(v) {
    this.resolution = v;
    if (host.recorder) {
      host.recorder.targetHeight = REC_RESOLUTIONS[v];
    }
    warnIfRecording('resolution');
  }
});
Object.defineProperty(recSettings, 'recFormat', {
  get() { return this.format; },
  set(v) {
    this.format = v;
    if (host.recorder) host.recorder.format = REC_FORMATS[v];
    warnIfRecording('format');
  }
});

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
  if (!host.recorder) return;
  showRecording(host.recorder.toggle(appState.get('effect')));
}};

const recFolder = guiInstance.addFolder('Recording');
recFolder.close();
recFolder.addSession(recSettings, 'recQuality', 1, 20, 1).name('Rec Quality (Mbps)');
recFolder.addSession(recSettings, 'recResolution', Object.keys(REC_RESOLUTIONS)).name('Rec Resolution');
recFolder.addSession(recSettings, 'recFormat', Object.keys(REC_FORMATS)).name('Rec Format');
const recordCtrl = recFolder.add(recordState, 'record').name('\u25cf Record');
const INTERACTIVE_KEY_TARGET =
  'input, textarea, select, button, [contenteditable], .lil-gui, .effect-sidebar';
/**
 * Window keydown handler for global playback shortcuts. Ignores keys whose
 * target sits inside an interactive element (gui control, sidebar, input) so
 * activating those controls doesn't also toggle the simulation.
 * @param {KeyboardEvent} e - The keydown event.
 * @returns {void}
 */
const onKeyDown = (e) => {
  const t = e.target;
  if (t instanceof Element && t.closest(INTERACTIVE_KEY_TARGET)) return;
  daydream.keydown(e);
};
window.addEventListener("keydown", onKeyDown);

/**
 * Surface a rejection nothing awaited. Async failures after boot would
 * otherwise reach only the console, leaving a frozen page with no explanation.
 * @param {PromiseRejectionEvent} e - The rejection event.
 * @returns {void}
 */
const onUnhandledRejection = (e) => {
  console.error('Unhandled promise rejection:', e.reason);
  const detail = e.reason?.message ?? String(e.reason);
  showFatalError(`Something went wrong. ${detail}`);
};
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

/**
 * Release the listeners, timers, and worker pool this module owns so a page
 * discard leaves nothing firing into a dead scene. Symmetric with
 * Daydream.dispose() and EffectSidebar.dispose().
 * @returns {void}
 */
function disposeApp() {
  if (appDisposed) return;
  appDisposed = true;
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("unhandledrejection", onUnhandledRejection);
  window.removeEventListener("pagehide", onPageHide);
  // Released before the GUI/scene teardown below: a later set() would otherwise
  // re-enter applyEffect()/applyResolution() against a disposed renderer.
  switches.dispose();
  if (testAllInterval !== null) {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
  destroyActiveEffectGui();
  guiInstance.destroy();
  // Best-effort on a real discard: dispose() ends the MediaRecorder and releases
  // the stream/offscreen, but its async onstop download cannot be flushed
  // synchronously here, so an in-progress recording may be lost on teardown.
  host.recorder?.dispose();
  urlSync.dispose();
  sidebar.dispose();
  daydream.dispose();
  // Strand any in-flight warmModules() continuation: its post-await guard reads
  // both, so without this it spawns a worker pool into the discarded page.
  segments.active = false;
  segEpoch++;
  segments.destroy();
  durationEl.remove();
  // Null first: the animation-loop guard reads it, so a frame outliving
  // setAnimationLoop(null) cannot reach the deleted handle.
  host.adapter = null;
  host.engine?.delete();
  host.engine = null;
}

// pagehide (not unload) so bfcache is respected: e.persisted is false only on a
// real discard, true when merely frozen for back/forward cache.
function onPageHide(e) {
  if (!e.persisted) disposeApp();
}
window.addEventListener("pagehide", onPageHide);
