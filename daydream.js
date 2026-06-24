/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import createHolosphereModule from "./holosphere_wasm.js";
import { Daydream, SLOW_FRAME_MS } from "./driver.js";
import { GUI, resetGUI } from "gui";
import { EffectSidebar } from "./sidebar.js";
import { resolveActiveEffect } from "./sidebar_logic.js";
import { AppState, URLSync } from "./state.js";
import { VideoRecorder } from "./recorder.js";
import { SegmentController } from "./segment_controller.js";
import { refreshPixelView as computePixelView } from "./pixel_view.js";
import { resolveParamSync } from "./param_sync.js";

// This UI layer degrades gracefully (log, keep last good state, return) on
// failures from user/config-dependent engine calls; the lower layers trap.

const HiResFavorites = [
  "BZReactionDiffusion",
  "ChaoticStrings",
  "Comets",
  "DreamBalls",
  "MeshFeedback",
  "FlowField",
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
  "SplineFlow",
  "DistortedRing",
  "ShapeShifter",
  "Thrusters",
  "Voronoi",
];

const LoResFavorites = [
  "BZReactionDiffusion",
  "ChaoticStrings",
  "Comets",
  "Dynamo",
  "FlowField",
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
  "SplineFlow",
  "DistortedRing",
  "ShapeShifter",
  "Thrusters",
  "Voronoi",
];

const resolutionPresets = {
  "Holosphere (20x96)": { h: 20, w: 96, dotSize: 2 },
  "Phantasm (144x288)": { h: 144, w: 288, dotSize: 0.25 },
};

const effectsByResolution = {
  "Holosphere (20x96)": LoResFavorites,
  "Phantasm (144x288)": HiResFavorites,
};

let wasmModule = null;
let wasmEngine = null;
let wasmMemoryView = null;
let wasmAdapter = null;
let recorder = null;

/**
 * Re-fetch the WASM pixel view when missing or detached (heap growth can detach
 * the underlying ArrayBuffer, leaving a zero-length view), and re-point the two
 * display aliases at it so source, displayed attribute, and Daydream.pixels match.
 * @returns {void}
 */
function refreshPixelView() {
  const { view, refreshed } = computePixelView(
    wasmMemoryView, () => wasmEngine.getPixels());
  if (refreshed) {
    wasmMemoryView = view;
    daydream.dotMesh.instanceColor.array = view;
    Daydream.pixels = view;
  }
}

/**
 * Push the engine's per-frame parameter values back into the effect GUI so
 * animation-driven params track live, without clobbering controllers the user
 * is actively editing.
 * @returns {void}
 */
function syncGUI() {
  if (!activeEffect || !activeEffect.controllerByName) return;

  // Heap growth can detach this view to zero length; guard rather than mis-read.
  const values = wasmEngine.getParamValues();
  if (values.length === 0) return;

  const names = activeEffect.paramNames;
  const n = Math.min(names.length, values.length);
  for (let i = 0; i < n; i++) {
    const c = activeEffect.controllerByName.get(names[i]);
    if (!c) continue;

    // lil-gui sliders drag via a non-focusable div, invisible to activeElement,
    // so _dragging covers an in-progress drag.
    const isEditing =
      c._dragging || c.domElement.contains(document.activeElement);

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

const urlParams = new URLSearchParams(window.location.search);
const initialEffect = urlParams.get('effect');
const initialResolution = urlParams.get('resolution');

const appState = new AppState({
  effect: initialEffect || 'IslamicStars',
  resolution: (initialResolution && resolutionPresets[initialResolution]) ? initialResolution : "Phantasm (144x288)",
});
const urlSync = new URLSync(appState, ['effect', 'resolution'], {
  resolution: (v) => Boolean(resolutionPresets[v]),
});

const segments = new SegmentController({
  resolutionPresets,
  appState,
  getWasmEngine: () => wasmEngine,
  refreshPixelView,
  getMemoryView: () => wasmMemoryView,
});

///////////////////////////////////////////////////////////////////////////////
// Reactive Handlers — subscribe to appState
///////////////////////////////////////////////////////////////////////////////

/**
 * Tear down the current effect GUI and build a new one for the active effect.
 * @param {boolean} [preserveParams=false] - When true, keep the existing per-effect
 *   param URL entries (used during initial hydration); when false, clear them since
 *   they don't apply to the newly selected effect.
 * @returns {void}
 */
function applyEffect(preserveParams = false) {
  if (activeEffect && activeEffect.gui) {
    try {
      // The drag's pointerup/pointercancel listeners live on `window`, not the
      // GUI DOM, so destroying the GUI mid-drag would leave them dangling.
      if (activeEffect.activeDragEnds) {
        for (const end of activeEffect.activeDragEnds) {
          window.removeEventListener('pointerup', end);
          window.removeEventListener('pointercancel', end);
        }
        activeEffect.activeDragEnds.clear();
      }
      const dom = activeEffect.gui.domElement;
      if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
      activeEffect.gui.destroy();
    } catch (e) {
      console.warn("GUI destroy warning:", e);
    }
  }
  activeEffect = null;

  // Clear the old effect's param URL entries but keep the global GUI's keys.
  if (!preserveParams) {
    resetGUI(['resolution', 'effect', ...guiInstance.collectUrlKeys()]);
  }

  if (wasmEngine) {
    if (wasmEngine.setEffect(appState.get('effect')) === false) {
      console.error(`setEffect("${appState.get('effect')}") failed; effect unavailable.`);
      // The early return skips the end-of-function sync; run it here.
      if (segments.workers.length > 0) segments.setEffect(appState.get('effect'));
      sidebar.setActive(appState.get('effect'));
      return;
    }
    daydream.setStrobeColumns(wasmEngine.strobeColumns());

    activeEffect = { gui: new GUI({ autoPlace: false }), activeDragEnds: new Set() };

    const params = wasmEngine.getParameterDefinitions();

    const effectActions = {
      /**
       * Rebuild the effect GUI from the engine's current state, discarding edits.
       * @returns {void}
       */
      reset() { applyEffect(); },
      /**
       * Copy the current parameter values to the clipboard as a C++ brace-init
       * list of float literals, then flash the Export button to confirm.
       * @returns {void}
       */
      export() {
        const values = wasmEngine.getParamValues();
        // A heap-growth detach leaves the view zero-length; skip so we don't copy
        // an all-zero preset.
        if (values.length === 0) {
          console.warn('Export: parameter view detached (zero-length); skipping copy');
          exportCtrl.name('✗ Copy failed');
          setTimeout(() => exportCtrl.name('Export'), 1500);
          return;
        }
        const items = [];
        for (let i = 0; i < params.length; i++) {
          const v = (i < values.length) ? values[i] : 0;
          items.push(v.toFixed(4) + 'f');
        }
        const cpp = '{ ' + items.join(', ') + ' }';
        navigator.clipboard.writeText(cpp).then(() => {
          exportCtrl.name('\u2713 Copied!');
          setTimeout(() => exportCtrl.name('Export'), 1500);
        }).catch((err) => {
          console.warn('Export: clipboard write failed', err);
          exportCtrl.name('\u2717 Copy failed');
          setTimeout(() => exportCtrl.name('Export'), 1500);
        });
      }
    };
    activeEffect.gui.add(effectActions, 'reset').name('Reset');
    const exportCtrl = activeEffect.gui.add(effectActions, 'export').name('Export');

    // "Pause Animation" toggle, shown only when the effect has an animated param.
    const hasAnimated = params.some(p => p.animated);
    const animState = { pause: false };
    let pauseController = null;
    /**
     * Pause or resume animation-driven params on both the main engine and the
     * segment-worker pool, keeping the local toggle state in sync.
     * @param {boolean} v - True to freeze animations, false to resume.
     * @returns {void}
     */
    const setPaused = (v) => {
      animState.pause = v;
      wasmEngine.setAnimationsPaused(v);
      segments.setAnimationsPaused(v);
    };
    if (hasAnimated) {
      pauseController = activeEffect.gui.add(animState, 'pause').name('Pause Animation');
      pauseController.onChange(setPaused);
    }

    // paramNames records the value-stream order; syncGUI() binds by name, not
    // index, so a C++ param reorder can't mis-bind sliders.
    const state = {};
    activeEffect.paramNames = [];
    activeEffect.controllerByName = new Map();

    params.forEach(p => {
      state[p.name] = p.value;

      let controller;
      const isBool = (typeof p.value === 'boolean');

      if (isBool) {
        controller = activeEffect.gui.add(state, p.name);
      } else {
        controller = activeEffect.gui.add(state, p.name, p.min, p.max).decimals(3);
      }
      controller.isBoolean = isBool;
      activeEffect.paramNames.push(p.name);
      activeEffect.controllerByName.set(p.name, controller);

      if (p.readonly) {
        if (typeof controller.disable === 'function') controller.disable();
      } else {
        // Flag _dragging so syncGUI's value stream doesn't fight a drag. The window
        // listeners go on activeDragEnds so a GUI destroyed mid-drag removes them.
        controller.domElement.addEventListener('pointerdown', () => {
          controller._dragging = true;
          const fx = activeEffect;
          const end = () => {
            controller._dragging = false;
            window.removeEventListener('pointerup', end);
            window.removeEventListener('pointercancel', end);
            if (fx && fx.activeDragEnds) fx.activeDragEnds.delete(end);
          };
          if (fx && fx.activeDragEnds) fx.activeDragEnds.add(end);
          window.addEventListener('pointerup', end);
          window.addEventListener('pointercancel', end);
        });
      }

      // Push the GUI's initial value into the engine: a ?param=value deep link
      // sets state[p.name] but fires no onChange, so the engine would otherwise
      // render the default while the slider shows the URL value.
      if (!p.readonly) {
        const initVal = isBool ? (state[p.name] ? 1.0 : 0.0) : state[p.name];
        if (wasmEngine.setParameter(p.name, initVal) === false)
          console.warn(`setParameter("${p.name}") rejected as unknown.`);
      }

      controller.onChange(v => {
        const floatVal = (typeof v === 'boolean') ? (v ? 1.0 : 0.0) : v;
        if (wasmEngine.setParameter(p.name, floatVal) === false)
          console.warn(`setParameter("${p.name}") rejected as unknown.`);
        segments.setParameter(p.name, floatVal);
        // Touching an animated slider takes over from the animation.
        if (p.animated && pauseController && !animState.pause) {
          setPaused(true);
          pauseController.updateDisplay();
        }
      });
    });
  }

  // Driver's container-width isMobile, not window.innerWidth (differs for a
  // narrow container in a wide window).
  if (activeEffect && activeEffect.gui && daydream.isMobile) {
    activeEffect.gui.close();
  }

  if (activeEffect && activeEffect.gui) {
    const guiContainer = document.getElementById('gui-container');
    if (guiContainer) {
      activeEffect.gui.domElement.classList.add('effect-gui');
      activeEffect.gui.domElement.classList.remove('global-gui');
      guiContainer.appendChild(activeEffect.gui.domElement);
    }
  }

  if (segments.workers.length > 0) {
    segments.setEffect(appState.get('effect'));
  }

  sidebar.setActive(appState.get('effect'));
}

/**
 * Apply a resolution change: resize geometry, refresh sidebar list, then re-apply effect.
 * @param {boolean} [preserveParams=false] - Forwarded to applyEffect() when the
 *   active effect is still offered at the new resolution; when true, preserve that
 *   effect's param URL entries through the re-apply. When the active/hydrated effect
 *   is NOT offered (off-list) it is corrected to the list's first entry, and only
 *   GLOBAL param URL entries (resolution, effect, and the global GUI's deep-link
 *   keys) carry over — the effect-specific entries are dropped regardless of this
 *   flag, since they target an effect this resolution can't run.
 * @returns {void}
 */
function applyResolution(preserveParams = false) {
  const resolution = appState.get('resolution');
  const p = resolutionPresets[resolution];
  if (!p) return;

  if (wasmEngine) {
    if (wasmEngine.setResolution(p.w, p.h) === false) {
      console.error(`Unsupported resolution ${p.w}x${p.h}; keeping current.`);
      return;
    }
    wasmMemoryView = null; // force refreshPixelView to re-fetch after resize
  }

  if (segments.workers.length > 0) {
    segments.setResolution(p.w, p.h);
  }

  const availableEffects = effectsByResolution[resolution] || HiResFavorites;

  daydream.updateResolution(p.h, p.w, p.dotSize);

  let effectSizes = null;
  if (wasmEngine) {
    try { effectSizes = wasmEngine.getEffectSizes(); }
    catch (e) { console.warn('getEffectSizes failed (sidebar sizes unavailable):', e); }
  }
  sidebar.setEffects(availableEffects, effectSizes);

  // Done after updateResolution()/setEffects() because appState.set('effect',…)
  // synchronously fires applyEffect(), which would otherwise build against the
  // pre-resize dot mesh / stale sidebar.
  let effectChanged = false;
  const resolvedEffect = resolveActiveEffect(availableEffects, appState.get('effect'));
  if (resolvedEffect !== appState.get('effect')) {
    appState.set('effect', resolvedEffect);
    effectChanged = true;
  }

  if (!effectChanged) {
    applyEffect(preserveParams);
  }

  daydream.invalidate();
}

appState.subscribe((key, value, old) => {
  if (key === 'effect') {
    applyEffect();
  } else if (key === 'resolution') {
    applyResolution();
  }
});

///////////////////////////////////////////////////////////////////////////////
// Initialize WASM
///////////////////////////////////////////////////////////////////////////////

createHolosphereModule().then(module => {
  wasmModule = module;
  wasmEngine = new module.HolosphereEngine();

  // Apply the hydrated resolution before first paint.
  const p = resolutionPresets[appState.get('resolution')];
  if (p && wasmEngine.setResolution(p.w, p.h) === false) {
    console.error(`Init: unsupported resolution ${p.w}x${p.h} from hydrated preset; ` +
      `keeping the engine's current resolution.`);
  }

  // setEffect happens once via applyResolution(true) below, after it validates the
  // hydrated effect against this resolution's allow-list.

  wasmAdapter = {
    /**
     * Per-frame entry the driver calls: render (segmented or single-engine),
     * republish the pixel view, then mirror engine params back into the GUI.
     * @returns {void}
     */
    drawFrame() {
      if (segments.active) {
        // Composite the previous frame (overwriting driver.render()'s cleared
        // buffer) and dispatch the next.
        segments.tick();
      } else {
        wasmEngine.drawFrame();
        refreshPixelView();
        // All three aliases must point at the one WASM view; fail loudly if a
        // future change re-points only some.
        if (Daydream.pixels !== wasmMemoryView ||
            daydream.dotMesh.instanceColor.array !== wasmMemoryView) {
          throw new Error(
            "drawFrame: display-buffer alias broken after refreshPixelView() — " +
            "Daydream.pixels / instanceColor.array / wasmMemoryView diverged; the " +
            "rendered WASM buffer is not the one being cleared and displayed");
        }
        daydream.dotMesh.instanceColor.needsUpdate = true;
      }
      syncGUI();
    },
    /**
     * Report the engine's current arena allocation metrics for the driver's HUD.
     * @returns {Object} The WASM engine's arena metrics snapshot.
     */
    getArenaMetrics() {
      return wasmEngine.getArenaMetrics();
    },
    /**
     * Whether the buffer holds a real frame the recorder may capture this tick.
     * Single-engine mode always renders the full canvas in drawFrame(); segmented
     * mode composites a frame late, so report false until (and on any tick where)
     * a composite has not landed — otherwise the recorder captures the cleared
     * (black) buffer left by driver.render()'s fill(0).
     * @returns {boolean} True when the displayed buffer is a real rendered frame.
     */
    captureReady() {
      return segments.active ? segments.frameComposited : true;
    }
  };

  console.log("Wasm Engine Loaded");

  // Construct the recorder now that daydream's canvas exists.
  recorder = new VideoRecorder(daydream.canvas);
  recorder.frameInterval = daydream.frameInterval;
  daydream.recorder = recorder;

  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.remove();

  applyResolution(true);
}).catch(err => {
  console.error('Failed to load the Holosphere WASM engine:', err);
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) {
    loadingOverlay.classList.add('error');
    loadingOverlay.innerHTML =
      '<span class="load-error-title">Failed to load the rendering engine.</span>' +
      '<span class="load-error-detail"></span>';
    const detail = loadingOverlay.querySelector('.load-error-detail');
    // textContent (not innerHTML) so an arbitrary error message can't inject markup.
    if (detail) detail.textContent = (err && err.message) ? err.message : String(err);
  }
});

///////////////////////////////////////////////////////////////////////////////
// GUI + Sidebar Setup
///////////////////////////////////////////////////////////////////////////////

const guiInstance = new GUI({ autoPlace: false });
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

guiInstance.add({ resolution: appState.get('resolution') }, 'resolution', Object.keys(resolutionPresets))
  .name('Resolution')
  .onChange((v) => appState.set('resolution', v));

const sidebar = new EffectSidebar(
  document.getElementById('effect-sidebar'),
  (name) => appState.set('effect', name)
);

let testAllInterval = null;
guiInstance.add({ testAll: false }, 'testAll').name('Test All').onChange((v) => {
  if (v) {
    testAllInterval = setInterval(() => {
      if (!wasmEngine) return;
      const currentList = effectsByResolution[appState.get('resolution')];
      if (!currentList || currentList.length === 0) return;
      const currentEffect = appState.get('effect');
      const currentIndex = currentList.indexOf(currentEffect);
      const nextIndex = (currentIndex + 1) % currentList.length;
      appState.set('effect', currentList[nextIndex]);
    }, 1000);
  } else {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
});


guiInstance.add(daydream, 'labelAxes').name('Show Axes').onChange(() => daydream.invalidate());
guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere').onChange(() => daydream.invalidate());
guiInstance.add(daydream, 'columnFillOverlap', 1.0, 2.0, 0.01).name('Column Fill Overlap').onChange(() => daydream.invalidate());

// ── Segmented POV controls ──────────────────────────────────────────────────
const segFolder = guiInstance.addFolder('Segmented POV');
segFolder.close();
const segState = { segmented: segments.active, segments: segments.count, boundaries: segments.showBoundaries };
segFolder.add(segState, 'segmented').name('Enabled').onChange(v => {
  segments.active = v;
  if (v) {
    segments.create(segments.count);
  } else {
    segments.destroy();
    segments.updateStats();
  }
});
segFolder.add(segState, 'segments', 2, 8, 2).name('Segments').onChange(v => {
  segments.count = v;
  if (segments.active) {
    segments.create(segments.count);
  }
});
segFolder.add(segState, 'boundaries').name('Show Boundaries').onChange(v => {
  segments.showBoundaries = v;
});

// Video recording
const REC_RESOLUTIONS = { 'Native': null, '720p': 720, '1080p': 1080 };
const REC_FORMATS = { 'Auto': 'auto', 'MP4': 'mp4', 'WebM': 'webm' };
const recSettings = { _quality: 16, _resolution: 'Native', _format: 'Auto' };
// These settings are latched at recorder.start(); warn that a mid-recording
// change won't take effect until the next start().
const warnIfRecording = (label) => {
  if (recorder?.isRecording) {
    console.warn(`Recording: ${label} change applies to the next recording (the current one is already running).`);
  }
};
Object.defineProperty(recSettings, 'quality', {
  get() { return this._quality; },
  set(v) {
    this._quality = v;
    if (recorder) recorder.bitrateMbps = v;
    warnIfRecording('bitrate');
  }
});
Object.defineProperty(recSettings, 'recResolution', {
  get() { return this._resolution; },
  set(v) {
    this._resolution = v;
    if (recorder) {
      recorder.targetHeight = REC_RESOLUTIONS[v];
    }
    warnIfRecording('resolution');
  }
});
Object.defineProperty(recSettings, 'recFormat', {
  get() { return this._format; },
  set(v) {
    this._format = v;
    if (recorder) recorder.format = REC_FORMATS[v];
    warnIfRecording('format');
  }
});

const durationEl = document.createElement('div');
durationEl.className = 'rec-duration';
durationEl.style.display = 'none';
document.getElementById('canvas-container')?.appendChild(durationEl);

const recordState = { record: () => {
  if (!recorder) return;
  const canvasEl = document.getElementById('canvas-container');
  const nowRecording = recorder.toggle(appState.get('effect'));
  if (nowRecording) {
    canvasEl?.classList.add('recording');
    durationEl.style.display = '';
    recordCtrl.name('\u25a0 Stop');
  } else {
    canvasEl?.classList.remove('recording');
    durationEl.style.display = 'none';
    recordCtrl.name('\u25cf Record');
  }
}};

const recFolder = guiInstance.addFolder('Recording');
recFolder.close();
recFolder.add(recSettings, 'quality', 1, 20, 1).name('Rec Quality (Mbps)');
recFolder.add(recSettings, 'recResolution', Object.keys(REC_RESOLUTIONS)).name('Rec Resolution');
recFolder.add(recSettings, 'recFormat', Object.keys(REC_FORMATS)).name('Rec Format');
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

daydream.renderer.setAnimationLoop(() => {
  if (wasmAdapter) {
    daydream.render(wasmAdapter);
  }
  if (recorder?.isRecording) {
    durationEl.textContent = recorder.elapsedFormatted;
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
  window.removeEventListener("keydown", onKeyDown);
  if (testAllInterval !== null) {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
  recorder?.stop();
  urlSync.dispose();
  sidebar.dispose();
  daydream.dispose();
  segments.destroy();
}

// pagehide (not unload) so bfcache is respected: e.persisted is false only on a
// real discard, true when merely frozen for back/forward cache.
window.addEventListener("pagehide", (e) => {
  if (!e.persisted) disposeApp();
});
