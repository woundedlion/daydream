// daydream.js

import { Daydream } from "./driver.js";
import {
  RingShower,
  Comets,
  Dynamo,
  RingSpin,
  MetaballEffect,
  NoiseParticles,
  RingMachine,
  FlowField
} from "./effects.js";

import { BufferGeometry, AddEquation, MaxEquation } from "three";

///////////////////////////////////////////////////////////////////////////////

const daydream = new Daydream();
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));

// var effect = new RingShower();
// var effect = new RingSpin();
// var effect = new Comets();
// var effect = new FlowField();
 var effect = new Dynamo();//

//var effect = new MetaballEffect();
// var effect = new NoiseParticles();
// var effect = new RingMachine();
// var effect = new VerticalMarch();

daydream.renderer.setAnimationLoop(() => daydream.render(effect));