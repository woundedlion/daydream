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
  PetalFlow
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
  PetalFlow
};

const urlParams = new URLSearchParams(window.location.search);
const initialEffect = urlParams.get('effect');

let activeEffect;
const controls = {
  effectName: (initialEffect && effects[initialEffect]) ? initialEffect : 'PetalFlow',
  changeEffect: function () {
    if (activeEffect && activeEffect.gui) {
      try {
        const dom = activeEffect.gui.domElement;
        // If we moved the dom element, dat.gui might fail to remove it from where it expects
        if (dom && dom.parentNode) {
          dom.parentNode.removeChild(dom);
        }
        // Force destroy without throwing if DOM is already gone
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
// Initialize main dropdown gui with autoPlace: false
const guiInstance = new GUI({ autoPlace: false });
document.getElementById('gui-container').appendChild(guiInstance.domElement);

guiInstance.add(controls, 'effectName', effectNames)
  .name('Active Effect')
  .onChange(() => controls.changeEffect());

// Helper to catch any late-bound auto-placed GUIs
const moveAutoGui = () => {
  const autoContainer = document.querySelector('body > .dg.ac');
  if (autoContainer) {
    document.getElementById('gui-container').appendChild(autoContainer);
  }
};
setInterval(moveAutoGui, 1000);

const daydream = new Daydream();
guiInstance.add(daydream, 'labelAxes').name('Show Axes');
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));

controls.changeEffect();

daydream.renderer.setAnimationLoop(() => {
  if (activeEffect) {
    daydream.render(activeEffect);
  }
});