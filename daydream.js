/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import createHolosphereModule from "./holosphere_wasm.js";
import { Daydream } from "./driver.js";
import { GUI, resetGUI } from "gui";

import { BufferGeometry, AddEquation, MaxEquation, Color, LinearSRGBColorSpace, SRGBColorSpace } from "three";

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
  "Metaballs",
  "MindSplatter",
  "MobiusGrid",
  "Moire",
  "PetalFlow",
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
  "Metaballs",
  "MobiusGrid",
  "Moire",
  "PetalFlow",
  "RingShower",
  "RingSpin",
  "SplineFlow",
  "Test",
  "TestShapes",
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

  // Re-run resolution setup now that WASM is ready, to populate sizes and replace JS GUI with WASM GUI
  if (controls.useWasm) {
    controls.setResolution(true);
  }
});


const urlParams = new URLSearchParams(window.location.search);
const initialEffect = urlParams.get('effect');

const initialResolution = urlParams.get('resolution');
const initialWasm = urlParams.get('wasm') !== 'false';

// Default to Holosphere
const resolutionPresets = {
  "Holosphere (20x96)": { h: 20, w: 96, size: 2 },
  "Phantasm (144x288)": { h: 144, w: 288, size: 0.25 },
};

const effectsByResolution = {
  "Holosphere (20x96)": LoResFavorites,
  "Phantasm (144x288)": HiResFavorites,
};

const daydream = new Daydream();
let activeEffect;

const controls = {
  effect: initialEffect || 'IslamicStars',
  resolution: (initialResolution && resolutionPresets[initialResolution]) ? initialResolution : "Phantasm (144x288)",
  testAll: false,
  useWasm: true,

  setResolution: function (preserveParams = false) {
    const p = resolutionPresets[this.resolution];
    if (p) {
      if (wasmEngine) {
        wasmEngine.setResolution(p.w, p.h);
      }
      // Update available effects based on resolution
      const availableEffects = effectsByResolution[this.resolution] || HiResFavorites;

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

    activeEffect = null;

    // Clear existing params to avoid pollution, unless we are initializing (preserveParams = true)
    if (!preserveParams) {
      resetGUI(['resolution', 'effect', 'wasm']);
    }

    // Update URL
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('effect', this.effect);
    newUrl.searchParams.set('wasm', this.useWasm);
    window.history.replaceState({}, '', newUrl);

    if (this.useWasm) {
      if (wasmEngine) {
        // WASM Mode - The Primary Mode
        wasmEngine.setEffect(this.effect);
        activeEffect = { gui: new GUI({ autoPlace: false }) };

        // 1. Get Params from C++
        const params = wasmEngine.getParameterDefinitions();

        // 2. Build GUI
        // 2. Build GUI
        const state = {};
        activeEffect.controllers = [];

        params.forEach(p => {
          state[p.name] = p.value;

          let controller;
          const isBool = (typeof p.value === 'boolean');

          if (isBool) {
            controller = activeEffect.gui.add(state, p.name);
          } else {
            controller = activeEffect.gui.add(state, p.name, p.min, p.max);
          }
          controller.isBoolean = isBool;
          activeEffect.controllers.push(controller);

          controller.onChange(v => {
            // Convert boolean to float (1.0/0.0) for C++ as setParameter expects float
            const floatVal = (typeof v === 'boolean') ? (v ? 1.0 : 0.0) : v;
            wasmEngine.setParameter(p.name, floatVal);
          });
        });
      }
    } else {
      console.warn("WASM Engine not ready or useWasm is false (should be true).");
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
        if (activeEffect.gui.domElement.parentElement !== guiContainer) {
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


let sidebarSort = { key: 'name', dir: 'asc' };

function populateEffectSidebar(options) {
  const sidebar = document.getElementById('effect-sidebar');
  if (!sidebar) return;

  sidebar.innerHTML = '';

  const heading = document.createElement('h3');
  heading.innerText = 'Effects';
  heading.className = 'effect-sidebar-heading';
  sidebar.appendChild(heading);

  // Query effect sizes from WASM
  let effectSizes = null;
  if (wasmEngine) {
    try { effectSizes = wasmEngine.getEffectSizes(); } catch (e) { }
  }

  // Sort controls
  const sortRow = document.createElement('div');
  sortRow.className = 'sort-controls';

  const makeArrow = (dir) => dir === 'asc' ? '▲' : '▼';

  const nameBtn = document.createElement('button');
  nameBtn.className = 'sort-btn' + (sidebarSort.key === 'name' ? ' active' : '');
  nameBtn.innerText = 'Name ' + (sidebarSort.key === 'name' ? makeArrow(sidebarSort.dir) : '⇅');
  nameBtn.onclick = () => {
    if (sidebarSort.key === 'name') sidebarSort.dir = sidebarSort.dir === 'asc' ? 'desc' : 'asc';
    else { sidebarSort.key = 'name'; sidebarSort.dir = 'asc'; }
    populateEffectSidebar(options);
  };

  const sizeBtn = document.createElement('button');
  sizeBtn.className = 'sort-btn' + (sidebarSort.key === 'size' ? ' active' : '');
  sizeBtn.innerText = 'Size ' + (sidebarSort.key === 'size' ? makeArrow(sidebarSort.dir) : '⇅');
  sizeBtn.onclick = () => {
    if (sidebarSort.key === 'size') sidebarSort.dir = sidebarSort.dir === 'asc' ? 'desc' : 'asc';
    else { sidebarSort.key = 'size'; sidebarSort.dir = 'desc'; }
    populateEffectSidebar(options);
  };

  sortRow.appendChild(nameBtn);
  sortRow.appendChild(sizeBtn);
  sidebar.appendChild(sortRow);

  // Build sortable list
  const items = options.map(name => ({
    name,
    size: effectSizes ? (effectSizes[name] || 0) : 0
  }));

  items.sort((a, b) => {
    const mul = sidebarSort.dir === 'asc' ? 1 : -1;
    if (sidebarSort.key === 'size') return (a.size - b.size) * mul;
    return a.name.localeCompare(b.name) * mul;
  });

  items.forEach(({ name, size }) => {
    const btn = document.createElement('button');
    btn.className = 'effect-button';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'effect-name';
    nameSpan.textContent = name;
    btn.appendChild(nameSpan);

    if (size > 0) {
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'effect-size';
      const kb = (size / 1024).toFixed(1);
      sizeSpan.textContent = `${kb} KB`;
      btn.appendChild(sizeSpan);
    }

    btn.dataset.effect = name;
    btn.onclick = () => {
      controls.effect = name;
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



guiInstance.add(daydream, 'labelAxes').name('Show Axes');
guiInstance.add(daydream, 'cullBackLabels').name('Cull Back Labels');
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));



daydream.renderer.setAnimationLoop(() => {
  if (wasmEngine) {
    daydream.renderer.outputColorSpace = SRGBColorSpace;
    const wasmWrapper = {
      drawFrame: () => {
        wasmEngine.drawFrame();

        // Sync GUI with Animations
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

        if (!wasmMemoryView || wasmMemoryView.buffer.byteLength === 0 || wasmMemoryView.length !== Daydream.W * Daydream.H * 3) {
          wasmMemoryView = wasmEngine.getPixels();
          daydream.dotMesh.instanceColor.array = wasmMemoryView;
          Daydream.pixels = wasmMemoryView;
        }

        // Tell Three.js the buffer needs an update (it will upload directly from WASM memory)
        daydream.dotMesh.instanceColor.needsUpdate = true;
      },
      getArenaMetrics: () => {
        return wasmEngine.getArenaMetrics();
      }
    };
    daydream.render(wasmWrapper);
  }
});
