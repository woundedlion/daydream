// daydream.js

import { Daydream } from "./driver.js";
import { gui } from "gui";
import {
  RingShower,
  Comets,
  Dynamo,
  RingSpin,

  MetaballEffect,
  FlowField,
  Thrusters,
  Test,
  MobiusGrid
} from "./effects.js";

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
  MobiusGrid
};



let activeEffect;
const controls = {
  effectName: 'Test',
  changeEffect: function () {
    if (activeEffect && activeEffect.gui) {
      activeEffect.gui.destroy();
    }

    const EffectClass = effects[this.effectName];
    if (typeof EffectClass !== 'function') {
      console.error(`Effect '${this.effectName}' is not a constructor. Check your imports in daydream.js.`);
      return;
    }
    activeEffect = new EffectClass();
  }
};

const effectNames = Object.keys(effects);
const guiInstance = new gui.GUI();
guiInstance.add(controls, 'effectName', effectNames)
  .name('Active Effect')
  .onChange(() => controls.changeEffect());

const daydream = new Daydream();
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));

controls.changeEffect();

daydream.renderer.setAnimationLoop(() => {
  if (activeEffect) {
    daydream.render(activeEffect);
  }
});