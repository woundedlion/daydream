/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */


import { Daydream } from "./driver.js";
import { GUI, resetGUI } from "gui";
import {
  BZReactionDiffusion,
  Comets,
  DreamBalls,
  Dynamo,
  FlowField,
  GSReactionDiffusion,
  HopfFibration,
  LSystem,
  MetaballEffect,
  MindSplatter,
  MobiusGrid,
  Moire,
  PetalFlow,
  RingShower,
  RingSpin,
  SphericalHarmonics,
  SpinShapes,
  Test,
  TestShapes,
  TestSolids,
  Thrusters,
  Voronoi
} from "./effects/index.js";

import { BufferGeometry, AddEquation, MaxEquation } from "three";

///////////////////////////////////////////////////////////////////////////////

const effects = {
  BZReactionDiffusion,
  Comets,
  DreamBalls,
  Dynamo,
  FlowField,
  GSReactionDiffusion,
  HopfFibration,
  LSystem,
  MetaballEffect,
  MindSplatter,
  MobiusGrid,
  Moire,
  PetalFlow,
  RingShower,
  RingSpin,
  SphericalHarmonics,
  SpinShapes,
  Test,
  TestShapes,
  TestSolids,
  Thrusters,
  Voronoi
};

const urlParams = new URLSearchParams(window.location.search);
const initialEffect = urlParams.get('effect');

const initialResolution = urlParams.get('resolution');

// Default to Holosphere
const resolutionPresets = {
  "Holosphere (20x96)": { h: 20, w: 96, size: 2 },
  "Phantasm (144x288)": { h: 144, w: 288, size: 0.25 }
};

const daydream = new Daydream();
let activeEffect;

const controls = {
  effect: (initialEffect && effects[initialEffect]) ? initialEffect : 'PetalFlow',
  resolution: (initialResolution && resolutionPresets[initialResolution]) ? initialResolution : "Holosphere (20x96)",
  testAll: false,

  setResolution: function (preserveParams = false) {
    const p = resolutionPresets[this.resolution];
    if (p) {
      // Update URL
      const newUrl = new URL(window.location);
      newUrl.searchParams.set('effect', this.effect);
      newUrl.searchParams.set('resolution', this.resolution);
      window.history.replaceState({}, '', newUrl);

      daydream.updateResolution(p.h, p.w, p.size);
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

    const EffectClass = effects[this.effect];
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
    window.history.replaceState({}, '', newUrl);


    activeEffect = new EffectClass();

    // Ensure new effect's GUI is attached to our container
    if (activeEffect && activeEffect.gui) {
      const guiContainer = document.getElementById('gui-container');
      if (guiContainer && activeEffect.gui.domElement.parentElement !== guiContainer) {
        // Move the auto-placed container if implicit
        const autoContainer = document.querySelector('body > .dg.ac');
        if (autoContainer) {
          guiContainer.appendChild(autoContainer);
        } else if (activeEffect.gui.domElement.parentElement !== guiContainer) {
          // Or just the domain element if it's standalone
          guiContainer.appendChild(activeEffect.gui.domElement);
        }
      }
    }
  }
};

const effectNames = Object.keys(effects);
const guiInstance = new GUI({ autoPlace: false });
document.getElementById('gui-container').appendChild(guiInstance.domElement);

guiInstance.add(controls, 'resolution', Object.keys(resolutionPresets))
  .name('Resolution')
  .onChange(() => controls.setResolution());

const effectController = guiInstance.add(controls, 'effect', effectNames)
  .name('Active Effect')
  .onChange(() => controls.changeEffect());

let testAllInterval = null;
guiInstance.add(controls, 'testAll').name('Test All').onChange((v) => {
  if (v) {
    testAllInterval = setInterval(() => {
      const currentIndex = effectNames.indexOf(controls.effect);
      const nextIndex = (currentIndex + 1) % effectNames.length;
      controls.effect = effectNames[nextIndex];
      controls.changeEffect();
      effectController.updateDisplay();
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
  }
};
setInterval(moveAutoGui, 1000);

guiInstance.add(daydream, 'labelAxes').name('Show Axes');
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));



daydream.renderer.setAnimationLoop(() => {
  if (activeEffect) {
    daydream.render(activeEffect);
  }
});
