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
  BZReactionDiffusion
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
  BZReactionDiffusion
};

const urlParams = new URLSearchParams(window.location.search);
const initialEffect = urlParams.get('effect');

let activeEffect;
const controls = {
  effectName: (initialEffect && effects[initialEffect]) ? initialEffect : 'BZReactionDiffusion',
  changeEffect: function () {
    if (activeEffect && activeEffect.gui) {
      activeEffect.gui.destroy();
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
  }
};

const effectNames = Object.keys(effects);
const guiInstance = new GUI();
guiInstance.add(controls, 'effectName', effectNames)
  .name('Active Effect')
  .onChange(() => controls.changeEffect());

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