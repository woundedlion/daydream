/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import createHolosphereModule from "./holosphere_wasm.js";
import { Daydream } from "./driver.js";
import { GUI, resetGUI } from "gui";
import { EffectSidebar } from "./sidebar.js";
import { AppState, URLSync } from "./state.js";
import { VideoRecorder } from "./recorder.js";

import { SRGBColorSpace } from "three";

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
  "Test",
  "TestShapes",
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
  "Test",
  "TestShapes",
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
  if (activeEffect && activeEffect.controllers) {
    const values = wasmEngine.getParamValues();
    for (let i = 0; i < activeEffect.controllers.length; i++) {
      if (i >= values.length) break;
      const c = activeEffect.controllers[i];

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
    wasmEngine.setEffect(appState.get('effect'));
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
          exportCtrl.name('✓ Copied!');
          setTimeout(() => exportCtrl.name('Export'), 1500);
        });
      }
    };
    activeEffect.gui.add(effectActions, 'reset').name('Reset');
    const exportCtrl = activeEffect.gui.add(effectActions, 'export').name('Export');

    // Build GUI
    const state = {};
    activeEffect.controllers = [];

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
      activeEffect.controllers.push(controller);

      controller.onChange(v => {
        const floatVal = (typeof v === 'boolean') ? (v ? 1.0 : 0.0) : v;
        wasmEngine.setParameter(p.name, floatVal);
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

  // Update sidebar highlight
  sidebar.setActive(appState.get('effect'));
}

/** Apply a resolution change: resize geometry, refresh sidebar list, then re-apply effect. */
function applyResolution(preserveParams = false) {
  const resolution = appState.get('resolution');
  const p = resolutionPresets[resolution];
  if (!p) return;

  if (wasmEngine) {
    wasmEngine.setResolution(p.w, p.h);
    wasmMemoryView = null; // Force refreshPixelView to re-fetch after resize
  }

  // Update available effects based on resolution
  const availableEffects = effectsByResolution[resolution] || HiResFavorites;

  // If current effect isn't in the new list, switch to the first one
  let effectChanged = false;
  if (!availableEffects.includes(appState.get('effect'))) {
    // This will trigger the 'effect' subscriber, which calls applyEffect
    appState.set('effect', availableEffects[0]);
    effectChanged = true;
  }

  daydream.updateResolution(p.h, p.w, p.size);

  // Update the sidebar options
  let effectSizes = null;
  if (wasmEngine) {
    try { effectSizes = wasmEngine.getEffectSizes(); } catch (e) { }
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

  // Set initial effect
  const effect = appState.get('effect');
  if (effect) {
    wasmEngine.setEffect(effect);
  }

  // Create persistent adapter object (avoids per-frame allocation)
  wasmAdapter = {
    drawFrame() {
      wasmEngine.drawFrame();
      syncGUI();
      refreshPixelView();
      daydream.dotMesh.instanceColor.needsUpdate = true;
    },
    getArenaMetrics() {
      return wasmEngine.getArenaMetrics();
    }
  };

  console.log("Wasm Engine Loaded");

  // Wire recorder to the actual canvas now that daydream is ready
  recorder.canvas = daydream.canvas;
  daydream.recorder = recorder;

  // Remove loading overlay
  const loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) loadingOverlay.remove();

  // Run initial resolution setup now that WASM is ready
  applyResolution(true);
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


// Initial resolution setup (will be re-run after WASM loads)
applyResolution(true);

guiInstance.add(daydream, 'labelAxes').name('Show Axes');
guiInstance.add(daydream, 'cullBackLabels').name('Cull Back Labels');
guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere');

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
guiInstance.add(recSettings, 'quality', 1, 20, 1).name('Rec Quality (Mbps)');
guiInstance.add(recSettings, 'recResolution', Object.keys(REC_RESOLUTIONS)).name('Rec Resolution');
Object.defineProperty(recSettings, 'recFormat', {
  get() { return this._format; },
  set(v) {
    this._format = v;
    if (recorder) recorder.format = REC_FORMATS[v];
  }
});
guiInstance.add(recSettings, 'recFormat', Object.keys(REC_FORMATS)).name('Rec Format');

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
    recordCtrl.name('■ Stop');
  } else {
    canvasEl?.classList.remove('recording');
    durationEl.style.display = 'none';
    recordCtrl.name('● Record');
  }
}};
const recordCtrl = guiInstance.add(recordState, 'record').name('● Record');
window.addEventListener("keydown", (e) => daydream.keydown(e));

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
