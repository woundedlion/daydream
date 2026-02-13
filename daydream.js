/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import createHolosphereModule from "./holosphere_wasm.js";
import { Daydream } from "./driver.js";
import { GUI, resetGUI } from "gui";
import * as allEffects from "./effects/index.js";

import { BufferGeometry, AddEquation, MaxEquation } from "three";

///////////////////////////////////////////////////////////////////////////////

const HiResFavorites = [
  "BZReactionDiffusion",
  "Comets",
  "DreamBalls",
  "FlamingMesh",
  "FlowField",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "HopfFibration",
  "IslamicStars",
  "LSystem",
  "MetaballEffect",
  "MindSplatter",
  "MobiusGrid",
  "Moire",
  "PetalFlow",
  "RingSpin",
  "SphericalHarmonics",
  "SpinShapes",
  "Test",
  "TestShapes",
  "TestSlewRate",
  "TestTemporal",
  "Voronoi",
];

const LoResFavorites = [
  "BZReactionDiffusion",
  "Comets",
  "Dynamo",
  "FlowField",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "IslamicStars",
  "MetaballEffect",
  "MobiusGrid",
  "Moire",
  "PetalFlow",
  "RingShower",
  "RingSpin",
  "Test",
  "TestShapes",
  "TestSlewRate",
  "TestTemporal",
  "Thrusters",
  "Voronoi",
];

let wasmModule = null;
let wasmEngine = null;
let wasmMemoryView = null;

// Initialize Wasm
createHolosphereModule().then(module => {
  wasmModule = module;
  wasmEngine = new module.HolosphereEngine();

  // Sync resolution from controls
  const p = resolutionPresets[controls.resolution];
  if (p) {
    wasmEngine.setResolution(p.w, p.h);
  }

  // Set initial effect matching URL or default
  if (controls.effect) {
    wasmEngine.setEffect(controls.effect);
  }

  console.log("Wasm Engine Loaded");
});


const urlParams = new URLSearchParams(window.location.search);
const initialEffect = urlParams.get('effect');

const initialResolution = urlParams.get('resolution');
const initialWasm = urlParams.get('wasm') === 'true';

// Default to Holosphere
const resolutionPresets = {
  "Holosphere (20x96)": { h: 20, w: 96, size: 2 },
  "Phantasm (144x288)": { h: 144, w: 288, size: 0.25 },
  "Pie-in-the-sky (288x576)": { h: 288, w: 576, size: 0.1 },
};

const effectsByResolution = {
  "Holosphere (20x96)": LoResFavorites,
  "Phantasm (144x288)": HiResFavorites,
  "Pie-in-the-sky (288x576)": HiResFavorites,
};

const daydream = new Daydream();
let activeEffect;

const controls = {
  effect: (initialEffect && allEffects[initialEffect]) ? initialEffect : 'PetalFlow',
  resolution: (initialResolution && resolutionPresets[initialResolution]) ? initialResolution : "Holosphere (20x96)",
  testAll: false,
  useWasm: initialWasm,

  setResolution: function (preserveParams = false) {
    const p = resolutionPresets[this.resolution];
    if (p) {
      if (wasmEngine) {
        wasmEngine.setResolution(p.w, p.h);
      }
      // Update available effects based on resolution
      const availableEffects = effectsByResolution[this.resolution] || Object.keys(allEffects);

      // Check if current effect is valid
      if (!availableEffects.includes(this.effect)) {
        this.effect = availableEffects[0];
      }

      // Update URL
      const newUrl = new URL(window.location);
      newUrl.searchParams.set('effect', this.effect);
      newUrl.searchParams.set('resolution', this.resolution);
      newUrl.searchParams.set('wasm', this.useWasm);
      window.history.replaceState({}, '', newUrl);

      daydream.updateResolution(p.h, p.w, p.size);

      // Update the sidebar options
      populateEffectSidebar(availableEffects);

      // Restart effect to use new resolution
      this.changeEffect(preserveParams);
    }
  },

  changeEffect: function (preserveParams = false) {
    if (activeEffect && activeEffect.gui) {
      try {
        const dom = activeEffect.gui.domElement;
        if (dom && dom.parentNode) {
          dom.parentNode.removeChild(dom);
        }
        activeEffect.gui.destroy();
      } catch (e) {
        console.warn("GUI destroy warning:", e);
      }
    }

    const EffectClass = allEffects[this.effect];
    if (typeof EffectClass !== 'function') {
      console.error(`Effect '${this.effect}' is not a constructor. Check your imports in daydream.js.`);
      return;
    }

    // Clear existing params to avoid pollution, unless we are initializing (preserveParams = true)
    if (!preserveParams) {
      resetGUI(['resolution', 'effect']);
    }

    // Update URL
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('effect', this.effect);
    newUrl.searchParams.set('wasm', this.useWasm);
    window.history.replaceState({}, '', newUrl);


    activeEffect = new EffectClass();
    if (this.useWasm && wasmEngine) {
      wasmEngine.setEffect(this.effect);
    }
    if (activeEffect && activeEffect.gui && window.innerWidth < 900) {
      activeEffect.gui.close();
    }

    // Ensure new effect's GUI is attached to our container
    if (activeEffect && activeEffect.gui) {
      const guiContainer = document.getElementById('gui-container');

      // Helper to add class
      const addEffectClass = (el) => {
        el.classList.add('effect-gui');
        el.classList.remove('global-gui'); // Safety
      };

      if (guiContainer) {
        // Check if we need to move it (auto-place or just detached)
        const autoContainer = document.querySelector('body > .dg.ac');
        if (autoContainer) {
          guiContainer.appendChild(autoContainer);
          addEffectClass(autoContainer);
        } else if (activeEffect.gui.domElement.parentElement !== guiContainer) {
          guiContainer.appendChild(activeEffect.gui.domElement);
          addEffectClass(activeEffect.gui.domElement);
        } else {
          // Already in container, just ensure class
          addEffectClass(activeEffect.gui.domElement);
        }
      }
    }

    // Update active state in sidebar
    updateSidebarActiveState();
  }
};

const guiInstance = new GUI({ autoPlace: false });
guiInstance.domElement.classList.add('global-gui');
if (window.innerWidth < 900) {
  guiInstance.close();
}
document.getElementById('gui-container').appendChild(guiInstance.domElement);

guiInstance.add(controls, 'resolution', Object.keys(resolutionPresets))
  .name('Resolution')
  .onChange(() => controls.setResolution());

guiInstance.add(controls, 'useWasm')
  .name('Use WASM')
  .onChange((v) => {
    if (v && wasmEngine) {
      wasmEngine.setEffect(controls.effect);
    }
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('wasm', v);
    window.history.replaceState({}, '', newUrl);
  });

function populateEffectSidebar(options) {
  const sidebar = document.getElementById('effect-sidebar');
  if (!sidebar) return;

  sidebar.innerHTML = '';

  const heading = document.createElement('h3');
  heading.innerText = 'Effects';
  heading.className = 'effect-sidebar-heading';
  sidebar.appendChild(heading);

  options.forEach(effectName => {
    const btn = document.createElement('button');
    btn.className = 'effect-button';
    btn.innerText = effectName;
    btn.dataset.effect = effectName;
    btn.onclick = () => {
      controls.effect = effectName;
      controls.changeEffect();
    };
    sidebar.appendChild(btn);
  });
  updateSidebarActiveState();
}

function updateSidebarActiveState() {
  const sidebar = document.getElementById('effect-sidebar');
  if (!sidebar) return;
  const buttons = sidebar.querySelectorAll('.effect-button');
  buttons.forEach(btn => {
    if (btn.dataset.effect === controls.effect) {
      btn.classList.add('active');
      btn.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else {
      btn.classList.remove('active');
    }
  });
}

let testAllInterval = null;
guiInstance.add(controls, 'testAll').name('Test All').onChange((v) => {
  if (v) {
    testAllInterval = setInterval(() => {
      const currentList = effectsByResolution[controls.resolution];
      const currentIndex = currentList.indexOf(controls.effect);
      const nextIndex = (currentIndex + 1) % currentList.length;
      controls.effect = currentList[nextIndex];
      controls.changeEffect();
    }, 1000);
  } else {
    clearInterval(testAllInterval);
    testAllInterval = null;
  }
});

controls.resetDefaults = () => {
  resetGUI(['resolution', 'effect']);
  controls.changeEffect();
};
guiInstance.add(controls, 'resetDefaults').name('Reset Defaults');

controls.setResolution(true);

// Helper to catch any late-bound auto-placed GUIs
const moveAutoGui = () => {
  const autoContainer = document.querySelector('body > .dg.ac');
  if (autoContainer) {
    document.getElementById('gui-container').appendChild(autoContainer);
    autoContainer.classList.add('effect-gui');
  }
};
setInterval(moveAutoGui, 1000);

guiInstance.add(daydream, 'labelAxes').name('Show Axes');
guiInstance.add(daydream, 'cullBackLabels').name('Cull Back Labels');
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));



daydream.renderer.setAnimationLoop(() => {
  if (controls.useWasm && wasmEngine) {
    const wasmWrapper = {
      drawFrame: () => {
        // 1. Explicitly clear JS buffer to prevent inter-frame persistence
        // (This addresses the user request for a clean buffer)
        Daydream.pixels.fill(0);

        // 2. Step the C++ engine
        wasmEngine.drawFrame();

        // 3. Extract and convert pixels
        const wasmPixels = wasmEngine.getPixels();
        for (let i = 0; i < wasmPixels.length; i++) {
          Daydream.pixels[i] = wasmPixels[i] / 255.0;
        }

        // Diagnostic: If you still see a black screen, check the console for this:
        // console.log("WASM Frame Max Pixel:", Math.max(...wasmPixels));
      }
    };
    daydream.render(wasmWrapper);
  }
  else if (activeEffect) {
    // Existing JS Logic
    daydream.render(activeEffect);
  }
});
