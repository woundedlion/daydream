// daydream.js - HMR Touch

import { Daydream } from "./driver.js";
import { GUI } from "gui"; // Fixed import
import {
  RingShower,
  Comets,
  Dynamo,
  RingSpin,
  MetaballEffect,
  FlowField,
  Thrusters,
  Test,
  MobiusGrid,
  Moire,
  Portholes,
  GSReactionDiffusion,
  BZReactionDiffusion,
  PetalFlow,
  LSystem,
  FieldSample
} from "./effects/index.js";

import { BufferGeometry, AddEquation, MaxEquation } from "three";

///////////////////////////////////////////////////////////////////////////////

const effects = {
  RingShower,
  RingSpin,
  Comets,
  Dynamo,
  Thrusters,
  MetaballEffect,
  FlowField,
  Test,
  MobiusGrid,
  Moire,
  Portholes,
  GSReactionDiffusion,
  BZReactionDiffusion,
  PetalFlow,
  LSystem,
  FieldSample
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
  effectName: (initialEffect && effects[initialEffect]) ? initialEffect : 'PetalFlow',
  resolution: (initialResolution && resolutionPresets[initialResolution]) ? initialResolution : "Holosphere (20x96)",

  setResolution: function () {
    const p = resolutionPresets[this.resolution];
    if (p) {
      // Update URL
      const newUrl = new URL(window.location);
      newUrl.searchParams.set('effect', this.effectName);
      newUrl.searchParams.set('resolution', this.resolution);
      window.history.pushState({}, '', newUrl);

      daydream.updateResolution(p.h, p.w, p.size);
      // Restart effect to use new resolution
      this.changeEffect();
    }
  },

  changeEffect: function () {
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

    const EffectClass = effects[this.effectName];
    if (typeof EffectClass !== 'function') {
      console.error(`Effect '${this.effectName}' is not a constructor. Check your imports in daydream.js.`);
      return;
    }

    // Update URL
    const newUrl = new URL(window.location);
    newUrl.searchParams.set('effect', this.effectName);
    window.history.pushState({}, '', newUrl);

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

guiInstance.add(controls, 'effectName', effectNames)
  .name('Active Effect')
  .onChange(() => controls.changeEffect());

controls.setResolution();

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

controls.changeEffect();

daydream.renderer.setAnimationLoop(() => {
  if (activeEffect) {
    daydream.render(activeEffect);
  }
});