/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import createHolosphereModule from "./holosphere_wasm.js";
import { Daydream, SLOW_FRAME_MS } from "./driver.js";
import { GUI, resetGUI, setUrlParam } from "gui";
import { EffectSidebar } from "./sidebar.js";
import { AppState, URLSync } from "./state.js";
import { VideoRecorder } from "./recorder.js";
import { SegmentController } from "./segment_controller.js";

import { SRGBColorSpace } from "three";

///////////////////////////////////////////////////////////////////////////////
//
// Failure-handling doctrine (boundary between this file and the engine layers):
//
//   * This main-thread UI layer DEGRADES GRACEFULLY. When an engine call that
//     depends on user/config input fails (setEffect, setResolution,
//     getEffectSizes, getArenaMetrics, ...), it logs via console.error/warn,
//     keeps the last good state, and returns — never white-screening the user
//     over a bad effect name or an unsupported resolution.
//   * The engine/protocol/pure layers TRAP. segment_layout.js validates its
//     inputs with `throw`, segment_controller.composite() throws on an
//     out-of-bounds blit, and the WASM module fail-fasts on a broken invariant.
//     These are programmer/contract errors that must not be silently absorbed.
//
// Rule of thumb: degrade where the failure is the user's (recoverable input);
// trap where the failure is ours (a violated invariant). The graceful catches
// below are deliberate, not missing error handling.
//
///////////////////////////////////////////////////////////////////////////////

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

// Resolution presets and effect lists per resolution
const resolutionPresets = {
  "Holosphere (20x96)": { h: 20, w: 96, size: 2 },
  "Phantasm (144x288)": { h: 144, w: 288, size: 0.25 },
};

const effectsByResolution = {
  "Holosphere (20x96)": LoResFavorites,
  "Phantasm (144x288)": HiResFavorites,
};

let wasmModule = null;
let wasmEngine = null;
let wasmMemoryView = null;
let wasmAdapter = null;
const recorder = new VideoRecorder(document.querySelector('#canvas-container canvas') || document.createElement('canvas'));

// Guard WASM memory view — spec-correct detached buffer check
function refreshPixelView() {
  if (!wasmMemoryView || wasmMemoryView.buffer.byteLength === 0) {
    wasmMemoryView = wasmEngine.getPixels();
    daydream.dotMesh.instanceColor.array = wasmMemoryView;
    Daydream.pixels = wasmMemoryView;
  }
}

function syncGUI() {
  if (!activeEffect || !activeEffect.controllerByName) return;

  // Zero-copy view over WASM memory (see wasm.cpp getParamValues). Like
  // getPixels(), heap growth can detach the buffer and leave a zero-length
  // view; it is fetched fresh and consumed synchronously here, but guard anyway
  // so a detached/stale view skips this frame rather than silently mis-reading.
  const values = wasmEngine.getParamValues();
  if (values.length === 0) return;

  // values[i] is the i-th parameter in getParameters() order; paramNames was
  // captured from the same iteration at GUI-build time, so names[i] labels
  // values[i]. Look the controller up by that name so the controller-build
  // order is decoupled from the value-stream order.
  const names = activeEffect.paramNames;
  const n = Math.min(names.length, values.length);
  for (let i = 0; i < n; i++) {
    const c = activeEffect.controllerByName.get(names[i]);
    if (!c) continue;

    // Skip if user is interacting
    if (c.domElement.contains(document.activeElement)) continue;

    let val = values[i];
    if (c.isBoolean) val = (val > 0.5);

    if (c.getValue() !== val) {
      c.object[c.property] = val;
      c.updateDisplay();
    }
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
const urlSync = new URLSync(appState, ['effect', 'resolution']);

// Segmented-POV worker pipeline (own state + lifecycle). wasmEngine and
// wasmMemoryView are reassignable, so they're passed as lazy getters.
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

/** Tear down the current effect GUI and build a new one for the active effect. */
function applyEffect(preserveParams = false) {
  // Tear down existing GUI
  if (activeEffect && activeEffect.gui) {
    try {
      const dom = activeEffect.gui.domElement;
      if (dom && dom.parentNode) dom.parentNode.removeChild(dom);
      activeEffect.gui.destroy();
    } catch (e) {
      console.warn("GUI destroy warning:", e);
    }
  }
  activeEffect = null;

  // Clear existing params to avoid pollution, unless we are initializing
  if (!preserveParams) {
    resetGUI(['resolution', 'effect']);
  }

  if (wasmEngine) {
    // setEffect() returns false for an unknown/stale effect name; the engine
    // resets to a blank state on failure, so surface it and skip building a GUI
    // for an effect that doesn't exist (mirrors the setResolution guard below).
    if (wasmEngine.setEffect(appState.get('effect')) === false) {
      console.error(`setEffect("${appState.get('effect')}") failed; effect unavailable.`);
      return;
    }
    activeEffect = { gui: new GUI({ autoPlace: false }) };

    // Get Params from C++
    const params = wasmEngine.getParameterDefinitions();

    // Reset + Export buttons at top of effect folder
    const effectActions = {
      reset() { applyEffect(); },
      export() {
        const values = wasmEngine.getParamValues();
        const items = [];
        for (let i = 0; i < params.length; i++) {
          const v = (i < values.length) ? values[i] : 0;
          items.push(v.toFixed(4) + 'f');
        }
        const cpp = '{ ' + items.join(', ') + ' }';
        navigator.clipboard.writeText(cpp).then(() => {
          exportCtrl.name('\u2713 Copied!');
          setTimeout(() => exportCtrl.name('Export'), 1500);
        });
      }
    };
    activeEffect.gui.add(effectActions, 'reset').name('Reset');
    const exportCtrl = activeEffect.gui.add(effectActions, 'export').name('Export');

    // Standard "Pause Animation" toggle — shown only when the effect has at
    // least one animation-driven param. Grabbing such a slider auto-engages it
    // (the animation freezes so the user's value takes over); untoggle resumes.
    const hasAnimated = params.some(p => p.animated);
    const animState = { pause: false };
    let pauseController = null;
    const setPaused = (v) => {
      animState.pause = v;
      wasmEngine.setAnimationsPaused(v);
      segments.setAnimationsPaused(v);
    };
    if (hasAnimated) {
      pauseController = activeEffect.gui.add(animState, 'pause').name('Pause Animation');
      pauseController.onChange(setPaused);
    }

    // Build GUI. syncGUI() binds the engine's per-frame value stream back to
    // these controllers by parameter NAME, not array index — paramNames records
    // the value-stream order (getParamValues mirrors getParameterDefinitions) so
    // a C++ param reorder can't silently mis-bind sliders.
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

      // Read-only telemetry: keep it updating live (syncGUI) but block editing.
      if (p.readonly && typeof controller.disable === 'function') {
        controller.disable();
      }

      // Push the GUI's initial value into the engine. DeepLinkGUI.add() may have
      // overridden state[p.name] from a ?param=value deep link, but nothing fires
      // onChange on load — without this the slider shows the URL value while the
      // engine still renders the effect default. Skip read-only telemetry, which
      // flows engine → GUI, never the reverse.
      if (!p.readonly) {
        const initVal = isBool ? (state[p.name] ? 1.0 : 0.0) : state[p.name];
        if (wasmEngine.setParameter(p.name, initVal) === false)
          console.warn(`setParameter("${p.name}") rejected as unknown.`);
        segments.setParameter(p.name, initVal);
      }

      controller.onChange(v => {
        const floatVal = (typeof v === 'boolean') ? (v ? 1.0 : 0.0) : v;
        // setParameter returns false on an unknown name; surface it (the UI
        // degrades gracefully — see the doctrine note at the top of this file).
        if (wasmEngine.setParameter(p.name, floatVal) === false)
          console.warn(`setParameter("${p.name}") rejected as unknown.`);
        // Forward to workers
        segments.setParameter(p.name, floatVal);
        // Persist to the deep-link URL. DeepLinkGUI.add() installed its own
        // setUrlParam handler, but lil-gui keeps a single onChange slot, so this
        // handler replaced it — write the URL here too or the edit never sticks.
        // Effect params are top-level, so the URL key is just p.name (the same
        // key DeepLinkGUI derives) and is cleared on effect switch via resetGUI.
        setUrlParam(p.name, v);
        // Touching an animated slider takes over from the animation.
        if (p.animated && pauseController && !animState.pause) {
          setPaused(true);
          pauseController.updateDisplay();
        }
      });
    });
  }

  if (activeEffect && activeEffect.gui && window.innerWidth < 900) {
    activeEffect.gui.close();
  }

  // Attach new effect's GUI to container
  if (activeEffect && activeEffect.gui) {
    const guiContainer = document.getElementById('gui-container');
    if (guiContainer) {
      activeEffect.gui.domElement.classList.add('effect-gui');
      activeEffect.gui.domElement.classList.remove('global-gui');
      guiContainer.appendChild(activeEffect.gui.domElement);
    }
  }

  // Update workers with new effect
  if (segments.workers.length > 0) {
    segments.setEffect(appState.get('effect'));
  }

  // Update sidebar highlight
  sidebar.setActive(appState.get('effect'));
}

/** Apply a resolution change: resize geometry, refresh sidebar list, then re-apply effect. */
function applyResolution(preserveParams = false) {
  const resolution = appState.get('resolution');
  const p = resolutionPresets[resolution];
  if (!p) return;

  if (wasmEngine) {
    // setResolution returns false for a size the WASM factory can't build; keep
    // the current (valid) resolution rather than driving the engine blank.
    if (wasmEngine.setResolution(p.w, p.h) === false) {
      console.error(`Unsupported resolution ${p.w}x${p.h}; keeping current.`);
      return;
    }
    wasmMemoryView = null; // Force refreshPixelView to re-fetch after resize
  }

  // Update workers
  if (segments.workers.length > 0) {
    segments.setResolution(p.w, p.h);
  }

  // Update available effects based on resolution
  const availableEffects = effectsByResolution[resolution] || HiResFavorites;

  // If current effect isn't in the new list, switch to the first one
  let effectChanged = false;
  if (!availableEffects.includes(appState.get('effect'))) {
    appState.set('effect', availableEffects[0]);
    effectChanged = true;
  }

  daydream.updateResolution(p.h, p.w, p.size);

  // Update the sidebar options
  let effectSizes = null;
  if (wasmEngine) {
    try { effectSizes = wasmEngine.getEffectSizes(); }
    catch (e) { console.warn('getEffectSizes failed (sidebar sizes unavailable):', e); }
  }
  sidebar.setEffects(availableEffects, effectSizes);

  // Apply the current effect in the new resolution (if not already handled by effect switch)
  if (!effectChanged) {
    applyEffect(preserveParams);
  }
}

// Subscribe: react to state changes
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

  // Sync resolution from state
  const p = resolutionPresets[appState.get('resolution')];
  if (p) {
    wasmEngine.setResolution(p.w, p.h);
  }

  // Set initial effect — validate against this resolution's allow-list first.
  // The effect name is hydrated from the URL, so a stale or hand-edited value
  // can be unknown to the engine; setEffect() on an unknown name leaves
  // currentEffect null and renders blank. applyResolution(true) below
  // re-validates and self-heals, but don't feed an unvalidated name across the
  // WASM boundary in the first place — fall back to the list's default.
  const allowedEffects =
    effectsByResolution[appState.get('resolution')] || HiResFavorites;
  let effect = appState.get('effect');
  if (!allowedEffects.includes(effect)) {
    effect = allowedEffects[0];
    appState.set('effect', effect);
  }
  if (effect && wasmEngine.setEffect(effect) === false) {
    // Already validated against the allow-list above; a failure here means the
    // engine itself rejected the name. applyResolution(true) below re-validates
    // and self-heals, but log so the blank render isn't silent.
    console.error(`Initial setEffect("${effect}") failed.`);
  }

  // Create persistent adapter object (avoids per-frame allocation). Segmented
  // mode is pipelined inside SegmentController.tick(): it displays frame N-1's
  // composite while frame N renders in parallel on the workers.
  wasmAdapter = {
    drawFrame() {
      if (segments.active) {
        // Composite the previous frame + dispatch the next (no-op while the
        // workers are still spawning). Runs AFTER driver.render() cleared the
        // buffer, so the composite overwrites the clear.
        segments.tick();
      } else {
        // Normal mode: single engine renders full canvas
        wasmEngine.drawFrame();
        refreshPixelView();
        // refreshPixelView() must leave the three pixel-buffer aliases pointing
        // at the one WASM view: wasmMemoryView (the rendered source), Daydream.pixels
        // (the buffer driver.render() clears each frame), and instanceColor.array
        // (the attribute THREE displays). composite() asserts this same invariant on
        // the segment path; assert it here too so a future divergence — e.g. a resize
        // that re-points only some of the three — fails loudly instead of silently
        // displaying a stale buffer that the engine never rendered into.
        if (Daydream.pixels !== wasmMemoryView ||
            daydream.dotMesh.instanceColor.array !== wasmMemoryView) {
          throw new Error(
            "drawFrame: display-buffer alias broken after refreshPixelView() — " +
            "Daydream.pixels / instanceColor.array / wasmMemoryView diverged; the " +
            "rendered WASM buffer is not the one being cleared and displayed");
        }
        daydream.dotMesh.instanceColor.needsUpdate = true;
        // Hide segment stats if they were showing
        const segEl = document.getElementById('segment-stats');
        if (segEl) segEl.style.display = 'none';
      }
      syncGUI();
    },
    getArenaMetrics() {
      return wasmEngine.getArenaMetrics();
    }
  };

  console.log("Wasm Engine Loaded");

  // Wire recorder to the actual canvas now that daydream is ready
  recorder.canvas = daydream.canvas;
  // Track the driver's frame cadence (Daydream.FPS) instead of the recorder's
  // hardcoded default, so elapsed-time accounting stays correct if FPS changes.
  recorder.frameInterval = daydream.frameInterval;
  daydream.recorder = recorder;

  // Remove loading overlay
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.remove();

  // Run initial resolution setup now that WASM is ready
  applyResolution(true);
}).catch(err => {
  // Nothing renders without the engine, so a load/instantiation failure must
  // be surfaced — otherwise the loading overlay spins forever and the rejection
  // goes unhandled. Turn the overlay into an explicit error state.
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
if (window.innerWidth < 900) {
  guiInstance.close();
}
document.getElementById('gui-container').appendChild(guiInstance.domElement);

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
      const currentList = effectsByResolution[appState.get('resolution')];
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


// Resolution setup runs once, after the WASM engine loads (see the
// createHolosphereModule().then handler above). It used to also run here
// synchronously with a null engine, but nothing renders until wasmAdapter is
// set (the animation loop is gated on it), so that early pass was redundant.

guiInstance.add(daydream, 'labelAxes').name('Show Axes');
guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere');

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
Object.defineProperty(recSettings, 'quality', {
  get() { return this._quality; },
  set(v) {
    this._quality = v;
    if (recorder) recorder.bitrateMbps = v;
  }
});
Object.defineProperty(recSettings, 'recResolution', {
  get() { return this._resolution; },
  set(v) {
    this._resolution = v;
    if (recorder) {
      recorder.targetHeight = REC_RESOLUTIONS[v];
    }
  }
});
Object.defineProperty(recSettings, 'recFormat', {
  get() { return this._format; },
  set(v) {
    this._format = v;
    if (recorder) recorder.format = REC_FORMATS[v];
  }
});

// Duration readout element
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
const onKeyDown = (e) => daydream.keydown(e);
window.addEventListener("keydown", onKeyDown);

daydream.renderer.setAnimationLoop(() => {
  if (wasmAdapter) {
    daydream.renderer.outputColorSpace = SRGBColorSpace;
    daydream.render(wasmAdapter);
  }
  // Update duration readout
  if (recorder?.isRecording) {
    durationEl.textContent = recorder.elapsedFormatted;
  }
});

///////////////////////////////////////////////////////////////////////////////
// Teardown — release the listeners, timers and observers this module owns so a
// page discard leaves nothing firing into a dead scene. Symmetric with
// Daydream.dispose() and EffectSidebar.dispose().
///////////////////////////////////////////////////////////////////////////////

function disposeApp() {
  window.removeEventListener("keydown", onKeyDown);
  if (testAllInterval !== null) {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
  sidebar.dispose();
  daydream.dispose();
  // Terminate the segment-worker pool too: each worker holds a live WASM
  // module, so a discard with Segmented POV enabled would leak N workers
  // until the tab closes. destroy() is a no-op when the pool is empty.
  segments.destroy();
}

// pagehide (not unload) so the bfcache path is respected: only tear down on a
// real discard, never when the page is merely frozen for back/forward cache.
window.addEventListener("pagehide", (e) => {
  if (!e.persisted) disposeApp();
});
