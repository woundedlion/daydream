// effects.js
import * as THREE from "three";
import { gui } from "gui";
import { Daydream, pixelKey } from "./driver.js";

import {
  Orientation, Dodecahedron, angleBetween, pixelToVector,
  distanceGradient, isOver, bisect, lissajous,
  fibSpiral, randomVector, Dot, sinWave, lerp, squareWave
} from "./geometry.js";

import {
  Path, drawLine, drawRing, plotDots, drawPolyhedron,
  drawFn, ringPoint, fnPoint, drawVector
} from "./draw.js";

import {
  blendOverMax, ProceduralPalette, MutatingPalette, blueToBlack,
  rainbow, vignette, darkRainbow, richSunset, bloodStream,
  lateSunset, GenerativePalette, g1, g2, grayToBlack,
  emeraldForest, vintageSunset, underSea, mangoPeel, iceMelt, lemonLime,
  algae, embers
} from "./color.js";

import {
  Timeline, easeMid, easeInOutSin, Motion, Sprite, Transition,
  Rotation, RandomTimer, easeOutExpo, easeInSin, easeOutSin,
  Mutation, MutableNumber, ParticleSystem, RandomWalk,
  easeOutElastic, easeInOutBicubic, easeInCubic, easeOutCubic,
  easeInCirc, easeOutCirc
} from "./animation.js";

import {
  FilterAntiAlias, FilterDecayTrails, FilterRaw, FilterReplicate,
  FilterOrient, FilterChromaticShift, FilterMirror, FilterFn,
  FilterSinDisplace, FilterColorShift, FilterTwinkle
} from "./filters.js";

import { PerlinNoise1D, PerlinNoise4D } from "./noise.js";
import { dir, wrap, shortest_distance, randomChoice, randomBetween } from "./util.js";


class PolyRot {
  constructor() {
    this.pixels = new Map();

    this.ring = Daydream.Y_AXIS.clone();
    this.ringOrientation = new Orientation();

    this.spinAxis = Daydream.Y_AXIS.clone();
    this.spinAxisOrientation = new Orientation();

    this.topOrientation = new Orientation();
    this.bottomOrientation = new Orientation;

    this.genPolyDuration = 160;
    this.splitPolyDuration = 96;
    this.spinRingDuration = 16;
    this.spinPolyDuration = 192;

    // Output Filters
    this.out = new FilterAntiAlias();

    // -----------------------------------------------------------------
    // !! ERROR: FilterDecayMask is not defined in any provided file.
    // This line will cause a crash.
    // this.polyMaskMask = new FilterDecayMask(4); 
    // -----------------------------------------------------------------

    (this.polyMask = new FilterAntiAlias())
    // .chain(this.polyMaskMask); // Cannot chain an undefined filter

    this.states = {
      "genPoly": {
        enter: this.enterGenPoly,
        draw: this.drawGenPoly,
        animate: this.animateGenPoly,
        exit: () => { },
      },
      "spinRing": {
        enter: this.enterSpinRing,
        draw: this.drawPolyRing,
        animate: this.animateSpinRing,
        exit: () => { },
      },
      "splitPoly": {
        enter: this.enterSplitPoly,
        draw: this.drawSplitPoly,
        animate: this.animateSplitPoly,
        exit: () => { },
      },
      "spinPoly": {
        enter: this.enterSpinPoly,
        draw: this.drawPolyRing,
        animate: this.animateSpinPoly,
        exit: () => { },
      },
    };

    this.stateIndex = -1;
    this.sequence = [
      "genPoly",
      "spinRing",
      "spinPoly",
      "spinRing",
      "splitPoly",
      "spinRing",
    ];

    this.transition();

    this.gui = new gui.GUI();
    this.gui.add(this, 'genPolyDuration').min(8).max(320).step(1);
    this.gui.add(this, 'splitPolyDuration').min(8).max(256).step(1);
    this.gui.add(this, 'spinRingDuration').min(8).max(32).step(1);
    this.gui.add(this, 'spinPolyDuration').min(8).max(256).step(1);

    // This line will also fail if polyMaskMask is not created
    // this.gui.add(this.polyMaskMask, 'lifespan').min(1).max(20).step(1);
  }

  transition() {
    this.stateIndex = (this.stateIndex + 1) % this.sequence.length;
    this.transitionTo(this.sequence[this.stateIndex]);
  }

  transitionTo(state) {
    if (this.state != undefined) {
      this.states[this.state].exit.call(this);
    }
    this.t = 0;
    this.state = state;
    this.states[this.state].enter.call(this);
  }

  enterGenPoly() {
    this.poly = new Dodecahedron();
    this.genPolyPath = new Path().appendSegment(
      (t) => this.ringOrientation.orient(lissajous(10, 0.5, 0, t)),
      2 * Math.PI,
      this.genPolyDuration,
      easeInOutSin
    );
    this.genPolyMotion = new Motion(this.genPolyPath, this.genPolyDuration);
  }

  drawGenPoly() {
    this.pixels.clear();

    // This will fail:
    // this.polyMaskMask.decay(); 

    let vertices = this.topOrientation.orientPoly(this.poly.vertices);

    // Draw ring into polygon mask
    let n = this.ringOrientation.length();
    for (let i = 0; i < n; i++) {
      let normal = this.ringOrientation.orient(this.ring, i);
      let dots = drawRing(normal, 1, (v, t) => new THREE.Color(0x000000));
      plotDots(new Map(), this.polyMask, dots,
        (n - 1 - i) / n, blendOverMax);
    }
    this.ringOrientation.collapse();

    // Draw polyhedron
    let dots = drawPolyhedron(
      vertices,
      this.poly.eulerPath,
      (v) => distanceGradient(v, this.ringOrientation.orient(this.ring)));
    plotDots(this.pixels, this.out, dots, 0, blendOverMax);

    // This will also fail:
    // this.pixels.forEach((p, key) => {
    //   p.multiplyScalar(this.polyMaskMask.mask(key));
    // });

    // Draw ring
    plotDots(this.pixels, this.out,
      drawRing(this.ringOrientation.orient(this.ring), 1,
        (v, t) => new THREE.Color(0xaaaaaa)),
      0, blendOverMax);

    return this.pixels;
  }

  animateGenPoly() {
    if (this.genPolyMotion.done()) {
      this.transition();
    } else {
      this.genPolyMotion.move(this.ringOrientation);
    }
  }

  enterSpinRing() {
    this.poly = new Dodecahedron();
    let from = this.ringOrientation.orient(this.ring).clone();
    let toNormal = new THREE.Vector3(...this.poly.vertices[3]).normalize();
    this.ringPath = new Path().appendLine(from, toNormal, true);
    this.ringMotion = new Motion(this.ringPath, this.spinRingDuration);
  }

  animateSpinRing() {
    if (this.ringMotion.done()) {
      this.transition();
    } else {
      this.ringMotion.move(this.ringOrientation);
    }
  }

  enterSplitPoly() {
    this.poly = new Dodecahedron();
    let normal = this.ringOrientation.orient(this.ring);
    bisect(this.poly, this.topOrientation, normal);
    this.bottomOrientation.set(this.topOrientation.get());
    this.polyRotationFwd = new Rotation(
      normal, 4 * Math.PI, this.splitPolyDuration);
    this.polyRotationRev = new Rotation(
      normal.clone().negate(), 4 * Math.PI, this.splitPolyDuration);
  }

  drawSplitPoly() {
    this.pixels.clear();
    let normal = this.ringOrientation.orient(this.ring);
    let vertices = this.poly.vertices.map((c) => {
      let v = this.topOrientation.orient(new THREE.Vector3().fromArray(c));
      if (isOver(v, normal)) {
        return v.toArray();
      } else {
        return this.bottomOrientation.orient(new THREE.Vector3().fromArray(c)).toArray();
      }
    });

    plotDots(this.pixels, this.out,
      drawPolyhedron(vertices, this.poly.eulerPath,
        (v) => distanceGradient(v, normal)));
    plotDots(this.pixels, this.out,
      drawRing(normal, 1, (v, t) => new THREE.Color(0xaaaaaa)));
    return this.pixels;
  }

  animateSplitPoly() {
    if (this.polyRotationFwd.done()) {
      this.transition();
    } else {
      this.polyRotationFwd.rotate(this.topOrientation);
      this.polyRotationRev.rotate(this.bottomOrientation);
    }
  }

  enterSpinPoly() {
    this.poly = new Dodecahedron();
    let axis = this.spinAxisOrientation.orient(this.spinAxis);
    this.spinPolyRotation = new Rotation(axis, 4 * Math.PI,
      this.spinPolyDuration);
    this.spinAxisPath = new Path().appendSegment(
      (t) => lissajous(12.8, 2 * Math.PI, 0, t),
      1,
      this.spinPolyDuration
    );
    this.spinAxisMotion = new Motion(this.spinAxisPath, this.spinPolyDuration);
  }

  drawPolyRing() {
    this.pixels.clear();
    let normal = this.ringOrientation.orient(this.ring);
    let vertices = this.topOrientation.orientPoly(this.poly.vertices);
    plotDots(this.pixels, this.out,
      drawPolyhedron(vertices, this.poly.eulerPath,
        (v) => distanceGradient(v, normal)));
    plotDots(this.pixels, this.out,
      drawRing(normal, 1, (v, t) => new THREE.Color(0xaaaaaa)));
    return this.pixels;
  }

  animateSpinPoly() {
    if (this.spinPolyRotation.done()) {
      this.transition();
    } else {
      this.spinAxisMotion.move(this.spinAxisOrientation);
      this.spinPolyRotation.axis =
        this.spinAxisOrientation.orient(this.spinAxis);
      this.spinPolyRotation.rotate(this.topOrientation);
    }
  }

  drawFrame() {
    let out = this.states[this.state].draw.call(this);
    this.states[this.state].animate.call(this);
    return out;
  }
}


///////////////////////////////////////////////////////////////////////////////

class Thruster {
  constructor(drawFn, orientation, thrustPoint) {
    this.exhaustRadius = new MutableNumber(0);
    this.exhaustMotion = new Transition(this.exhaustRadius, 0.3, 8, easeMid);
    this.exhaustSprite = new Sprite(
      drawFn.bind(null, orientation, thrustPoint, this.exhaustRadius),
      16, 0, easeMid, 16, easeOutExpo);
  }

  done() {
    return this.exhaustMotion.done()
      && this.exhaustSprite.done();
    ;
  }

  step() {
    this.exhaustSprite.step();
    this.exhaustMotion.step();
  }
}

export class Thrusters {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.3, 0.3],
      [0.0, 0.2, 0.6]
    );

    // Output Filters
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      ;

    // State
    this.t = 0;
    this.ring = new THREE.Vector3(0.5, 0.5, 0.5).normalize();
    this.orientation = new Orientation();
    this.to = new Orientation();
    this.thrusters = [];
    this.amplitude = new MutableNumber(0);
    this.warpPhase = 0;
    this.radius = new MutableNumber(1);

    // Animations
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(this.drawRing.bind(this), -1,
        16, easeInSin,
        16, easeOutSin)
    );
    this.timeline.add(0, new RandomTimer(8, 48,
      () => this.onFireThruster(), true)
    );
  }

  drawThruster(orientation, thrustPoint, radius, opacity) {
    let dots = drawRing(orientation, thrustPoint, radius.get(),
      (v) => new THREE.Color(0xffffff).multiplyScalar(opacity));
    plotDots(this.pixels, this.ringOutput, dots, 0, blendOverMax);
  }

  onFireThruster() {
    let thrustDir = Math.random() < 0.5 ? -1 : -1;
    this.warpPhase = Math.random() * 2 * Math.PI;
    let thrustPoint = fnPoint(
      this.ringFn.bind(this), this.ring, 1, this.warpPhase);
    let thrustOrientation = new Orientation().set(this.orientation.get());
    let thrustOpp = fnPoint(
      this.ringFn.bind(this), this.ring, 1, (this.warpPhase + Math.PI));
    // warp ring
    if (!(this.warp === undefined || this.warp.done())) {
      this.warp.cancel();
    }
    this.warp = new Mutation(
      this.amplitude, (t) => 0.7 * Math.exp(-2 * t), 32, easeMid);
    this.timeline.add(1 / 16,
      this.warp
    );

    // Spin ring
    let thrustAxis = new THREE.Vector3().crossVectors(
      this.orientation.orient(thrustPoint),
      this.orientation.orient(this.ring))
      .normalize();
    this.timeline.add(0,
      new Rotation(this.orientation, thrustAxis, 2 * Math.PI, 8 * 16, easeOutExpo)
    );

    // show thruster
    this.timeline.add(0,
      new Thruster(
        this.drawThruster.bind(this),
        thrustOrientation,
        thrustPoint)
    );
    this.timeline.add(0,
      new Thruster(
        this.drawThruster.bind(this),
        thrustOrientation,
        thrustOpp)
    );
  }

  ringFn(t) {
    return sinWave(-1, 1, 2, this.warpPhase)(t) // ring
      * sinWave(-1, 1, 3, 0)((this.t % 32) / 32) // oscillation
      * this.amplitude.get();
  }

  drawRing(opacity) {
    // rotateBetween(this.orientation, this.to); // rotateBetween is not defined
    this.orientation.collapse();
    this.to.collapse();
    let dots = drawFn(this.orientation, this.ring, this.radius.get(),
      this.ringFn.bind(this),
      (v) => {
        let z = this.orientation.orient(Daydream.X_AXIS);
        return this.palette.get(angleBetween(z, v) / Math.PI).multiplyScalar(opacity);
      }
    );
    plotDots(this.pixels, this.ringOutput, dots, 0, blendOverMax);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    this.t++;
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class RingCircus {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();

    // Palettes
    this.palette = new MutatingPalette(
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.25, 0.25],
      [0.91, 0.205, 0.505],

      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    (this.ringOutput = new FilterRaw())
      //      .chain(new FilterChromaticShift())
      .chain(new FilterAntiAlias())
      ;

    // State
    this.normal = Daydream.Z_AXIS.clone();
    this.orientation = new Orientation();
    this.numRings = new MutableNumber(5);
    this.spreadFactor = new MutableNumber(0);
    this.homeRadius = new MutableNumber(0);
    this.dutyCycle = new MutableNumber(1);
    this.freq = new MutableNumber(6);
    this.twist = new MutableNumber(0);
    this.t = 0;

    // Animations
    this.timeline = new Timeline();

    this.timeline.add(0,
      new Sprite((opacity) => {
        this.orientation.collapse();
        this.drawRings(opacity);
      },
        -1, 8, easeMid, 0, easeMid)
    );

    // T0: sweep to center
    this.timeline.add(0,
      new Transition(this.homeRadius, 1, 16, easeMid)
    );

    // T1: Spin everything
    this.onSpinRings(1);

    // T5: start circus
    this.timeline.add(2,
      new RandomTimer(16, 48, this.onMultiplyRings.bind(this)));
    this.timeline.add(5,
      new RandomTimer(16, 48, this.onSplitRings.bind(this)));
    this.timeline.add(5,
      new RandomTimer(16, 48, this.onSpreadRings.bind(this)));
    this.timeline.add(5,
      new RandomTimer(16, 48, this.onTwistRings.bind(this)));
  }

  onSpinRings(inSecs = 0) {
    this.orientation.collapse();
    this.timeline.add(inSecs,
      new Rotation(this.orientation,
        ringPoint(this.normal, 1, Math.random() * 2 * Math.PI),
        4 * Math.PI,
        96, easeInOutSin, false)
    );
    this.timeline.add(inSecs,
      new RandomTimer(48, 80, () => {
        this.onSpinRings();
      })
    );
  }

  onSpreadRings(inSecs = 0) {
    // spread
    this.timeline.add(inSecs,
      new Transition(this.spreadFactor, 1, 80, easeInOutSin)
    );
    // collapse rings
    this.timeline.add(inSecs + 5,
      new RandomTimer(80, 160, this.onCollapseRings.bind(this)));
  }

  onCollapseRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Transition(this.spreadFactor, 0, 80, easeInOutSin)
    );
    //spread rings
    this.timeline.add(inSecs + 5,
      new RandomTimer(16, 48, this.onSpreadRings.bind(this)));
  }

  onSplitRings(inSecs = 0) {
    this.timeline.add(0,
      new Transition(this.dutyCycle, 2 * Math.PI / Daydream.W, 32, easeInOutSin)
    );
    // merge rings
    this.timeline.add(inSecs + 2,
      new RandomTimer(80, 160, this.onMergeRings.bind(this)));
  }

  onMergeRings(inSecs = 0) {
    this.timeline.add(0,
      new Transition(this.dutyCycle, 1, 32, easeInOutSin)
    );
    // split rings
    this.timeline.add(inSecs + 2,
      new RandomTimer(16, 48, this.onSplitRings.bind(this)));
  }

  onMultiplyRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Transition(this.numRings, Daydream.W,
        48, easeMid, true)
    );
    // reduce rings
    this.timeline.add(inSecs + 3,
      new RandomTimer(16, 48, this.onReduceRings.bind(this)));
  }

  onReduceRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Transition(this.numRings, 5,
        48, easeMid, true)
    );
    // multiply rings
    this.timeline.add(inSecs + 3,
      new RandomTimer(80, 160, this.onMultiplyRings.bind(this)));
  }

  onTwistRings(inSecs = 0) {
    this.timeline.add(0,
      new Transition(this.twist, Math.PI / Daydream.W,
        80, easeMid)
    );
    // align rings
    this.timeline.add(inSecs + 5,
      new RandomTimer(48, 80, this.onAlignRings.bind(this)));
  }

  onAlignRings(inSecs = 0) {
    this.timeline.add(0,
      new Transition(this.twist, 0,
        80, easeMid)
    );
    // twist rings
    this.timeline.add(inSecs + 5,
      new RandomTimer(16, 48, this.onTwistRings.bind(this)));
  }

  calcRingSpread() {
    this.radii = new Array(this.numRings.get());
    for (let i = 0; i < this.numRings.get(); ++i) {
      let x = ((i + 1) / (this.numRings.get() + 1)) * 2 - 1;
      let r = Math.sqrt(Math.pow(1 - x, 2));
      this.radii[i] = new MutableNumber(lerp(this.homeRadius.get(), r, this.spreadFactor.get()));
    }
  }

  drawRings(opacity) {
    this.calcRingSpread();
    for (let i = 0; i < this.radii.length; ++i) {
      let dots = drawRing(this.orientation.orient(this.normal), this.radii[i].get(),
        (v, t) => {
          let idx = this.numRings.get() == 1 ? 0 : (1 - (i / (this.numRings.get() - 1)));
          let color = this.palette.get(idx);
          let r = dottedBrush(color.multiplyScalar(opacity), this.freq.get(), 
            this.dutyCycle.get(), this.twist.get(), t);
          return r;
        }, (0.1 + this.twist.get()) * i);
      plotDots(this.pixels, this.ringOutput, dots, 0, blendOverMax);
    }
  }

  drawFrame() {
    this.palette.mutate(Math.sin(0.01 * this.t++));
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class Wormhole {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      ;

    // State
    this.normal = Daydream.Z_AXIS.clone();
    this.numRings = new MutableNumber(Daydream.W);
    this.orientation = new Orientation();
    this.spreadFactor = new MutableNumber(1);
    this.homeRadius = new MutableNumber(1);
    this.dutyCycle = new MutableNumber((2 * Math.PI) / Daydream.W);
    this.freq = new MutableNumber(2);
    this.twist = new MutableNumber(7 / Daydream.W);
    this.phase = new MutableNumber(0);
    this.t = 0;

    // Animations
    this.timeline = new Timeline();

    this.timeline.add(0,
      new Sprite((opacity) => {
        this.drawRings(opacity);
      },
        -1, 8, easeMid, 0, easeMid)
    );

    // T1: Spin everything
    this.onThrustRings(1);
    this.onSpinRings(1);
    this.onMutateDutyCyle(1);
    this.onMutateTwist(1);

  }

  onMutateDutyCyle(inSecs = 0) {
    this.timeline.add(inSecs,
      new Mutation(this.dutyCycle, sinWave((2 * Math.PI) / Daydream.W, (8 * 2 * Math.PI) / Daydream.W, 1, Math.PI / 2),
        160, easeMid, true)
    );
  }

  onMutateTwist(inSecs = 0) {
    this.timeline.add(inSecs,
      new Mutation(this.twist, sinWave(3 / Daydream.W, 10 / Daydream.W, 1, Math.PI / 2),
        64, easeMid, true)
    );
  }

  onThrustRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Rotation(this.orientation,
        ringPoint(this.normal, 1, Math.random() * 2 * Math.PI),
        2 * Math.PI,
        96, easeInOutSin, false)
    );

    this.timeline.add(inSecs,
      new RandomTimer(48, 70, () => {
        this.onThrustRings();
      })
    );
  }

  onSpinRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Transition(this.phase, 2 * Math.PI, 32, easeMid, false, true)
    );
  }

  calcRingSpread() {
    this.radii = new Array(this.numRings.get());
    for (let i = 0; i < this.numRings.get(); ++i) {
      let x = ((i + 1) / (this.numRings.get() + 1)) * 2 - 1;
      let r = Math.sqrt(Math.pow(1 - x, 2));
      this.radii[i] = new MutableNumber(lerp(this.homeRadius.get(), r, this.spreadFactor.get()));
    }
  }

  drawRings(opacity) {
    this.calcRingSpread();
    this.orientation.collapse();
    for (let i = 0; i < this.radii.length; ++i) {
      let dots = drawRing(this.orientation.orient(this.normal), this.radii[i].get(),
        (v, t) => {
          let idx = this.numRings.get() == 1 ? 0 : (1 - (i / (this.numRings.get() - 1)));
          let darken = Math.pow(1 - Math.abs(this.radii[i].get() - 1), 3);
          let color = this.palette.get(idx).multiplyScalar(darken);
          let r = dottedBrush(color.multiplyScalar(opacity), this.freq.get(),
            this.dutyCycle.get(), this.twist.get(), t);
          return r;
        }, (this.twist.get()) * i + this.phase.get());
      plotDots(this.pixels, this.ringOutput, dots, 0, blendOverMax);
    }
  }

  drawFrame() {
    //    this.palette.mutate(Math.sin(0.01 * this.t++));
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class Pulses {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      ;

    // State
    //    this.poly = new Dodecahedron();
    this.orientation = new Orientation();
    this.numRings = 6;
    this.normals = Array.from({ length: this.numRings }, (v, i) => {
      return new THREE.Vector3().setFromSpherical(
        new THREE.Spherical(1, Math.PI / 2, (2 * Math.PI) * i / this.numRings));
    });
    this.radii = Array.from({ length: this.normals.length }, (v, i) => {
      return new MutableNumber(0);
    });

    // Animations
    this.timeline = new Timeline();

    this.timeline.add(0,
      new Sprite(
        (opacity) => this.drawRings(opacity),
        -1, 8, easeMid, 0, easeMid)
    );

    // T1: Start ring pulses
    this.onPulseRings(1);

  }


  onPulseRings(inSecs = 0) {
    for (let i = 0; i < this.radii.length; ++i) {
      this.timeline.add(inSecs,
        new Transition(this.radii[i], 2, 32, easeInOutSin, false, true)
      );
    }
  }

  drawRings(opacity) {
    for (let i = 0; i < this.radii.length; ++i) {
      let dots = drawRing(this.orientation.orient(this.normals[i]), this.radii[i].get(),
        (v, t) => {
          return this.palette.get(i / (this.radii.length - 1));
        },
        0
      );
      plotDots(this.pixels, this.ringOutput, dots, 0, blendOverMax);
    }
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class Fib {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    this.trails = new FilterDecayTrails(4);
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      //      .chain(new FilterChromaticShift())
      ;

    // State
    this.orientation = new Orientation();
    this.n = 20;
    this.heads = [];
    for (let i = 0; i < this.n; ++i) {
      this.heads.push(fibSpiral(this.n, 0, i));
    }
    this.tails = Array.from({ length: this.heads.length }, (v, i) => new MutableNumber(0));

    // Scene
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(
        (opacity) => this.draw(opacity),
        -1, 8, easeMid, 0, easeMid)
    );

    // T1: Start tails spinning
    this.onSpinTails(0);
  }

  onSpinTails(inSecs = 0) {
    for (let i = 0; i < this.heads.length; ++i) {
      this.timeline.add(inSecs,
        new Transition(this.tails[i], 2 * Math.PI, 16, easeMid, false, true)
      );
    }
  }

  draw(opacity) {
    this.trails.decay();
    let dots = [];
    for (let i = 0; i < this.heads.length; ++i) {
      let head = ringPoint(this.heads[i], 0.4, (this.tails[i].get() + Math.PI) % (2 * Math.PI), 2 * Math.PI / i)
      let tail = ringPoint(this.heads[i], 0.4, this.tails[i].get(), 2 * Math.PI / i);
      dots.push(...drawLine(head, tail, () => new THREE.Color(0x888888)));
    }
    this.trails.trail(this.pixels, (x, y, t) => blueToBlack.get(t), 0.1);
    plotDots(this.pixels, this.ringOutput, dots, 0, blendOverMax);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

/////////////////////////////////////////////////////////////////////////////////

export class Angles {
  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    this.trails = new FilterDecayTrails(10);
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      //      .chain(new FilterAntiAlias())
      //            .chain(new FilterChromaticShift())
      //      .chain(new FilterReplicate(2))
      //          .chain(new FilterMirror())
      // .chain(this.trails)
      ;

    // State
    this.orientation = new Orientation();
    this.ring = new THREE.Vector3(1, 0, 0).normalize();
    this.n = Daydream.W;
    this.dots = new Array(this.n);
    for (let i = 0; i < this.n; ++i) {
      this.dots[i] = ((v) => {
        return v;
      })(ringPoint(this.ring, 1, 2 * Math.PI * i / this.n, 0));
    }
    this.axisRing = new THREE.Vector3(0, 1, 0).normalize();
    this.axes = new Array(this.n);
    for (let i = 0; i < this.n; ++i) {
      this.axes[i] = ringPoint(this.axisRing, 0.2, 2 * Math.PI * i / this.n, 0);
    }
    this.orientations = new Array(this.n);
    for (let i = 0; i < this.n; ++i) {
      this.orientations[i] = new Orientation();
    }

    // Scene
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(
        (opacity) => this.draw(opacity),
        -1, 8, easeMid, 0, easeMid)
    );
    for (let i = 0; i < this.n; ++i) {
      let a = 2 * Math.PI / Daydream.W;
      this.timeline.add(0,
        new Rotation(this.orientations[i], this.axes[i], a * 16, 16, easeMid, true)
      );
    }
  }


  draw(opacity) {
    this.trails.decay();
    for (let i = 0; i < this.n; ++i) {
      for (let j = 1; j < this.orientations[i].length(); ++j) {
        plotDots(this.pixels, this.ringOutput,
          drawVector(this.orientations[i].orient(this.dots[i], j),
            () => new THREE.Color(1, 0, 0)),
          0, // Added age
          opacity // Added alpha
        );
      }
      this.orientations[i].collapse();

      /*
       plotDots(this.pixels, this.ringOutput,
              drawVector(this.axes[i],
                () => new THREE.Color(0, 1, 0))
            );
       */
    }
    this.trails.trail(this.pixels, (x, y, t) => rainbow.get(t), opacity);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}


///////////////////////////////////////////////////////////////////////////////
/*
class Grid {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    this.trails = new FilterDecayTrails(4);
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      //      .chain(new FilterChromaticShift())
      ;

    // State
    this.orientation = new Orientation();
    this.n = 20;
    this.heads =
    for (let i = 0; i < this.n; ++i) {
      this.heads.push(fibSpiral(this.n, 0, i));
    }
    this.tails = Array.from({ length: this.heads.length }, (v, i) => new MutableNumber(0));

    // Scene
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(
        (opacity) => this.draw(opacity),
        -1, 8, easeMid, 0, easeMid)
    );

    // T1: Start tails spinning
    this.onSpinTails(0);
  }

  onSpinTails(inSecs = 0) {
    for (let i = 0; i < this.heads.length; ++i) {
      this.timeline.add(inSecs,
        new Transition(this.tails[i], 2 * Math.PI, 16, easeMid, false, true)
      );
    }
  }

  draw(opacity) {
    this.trails.decay();
    let dots = [];
    for (let i = 0; i < this.heads.length; ++i) {
      let head = ringPoint(this.heads[i], 0.4, (this.tails[i].get() + Math.PI) % (2 * Math.PI), 2 * Math.PI / i)
      let tail = ringPoint(this.heads[i], 0.4, this.tails[i].get(), 2 * Math.PI / i);
      dots.push(...drawLine(head, tail, () => new THREE.Color(0x888888)));
    }
    this.trails this.pixels, new FilterRaw(), (x, y, t) => blueToBlack.get(t));
    plotDots(this.pixels, this.ringOutput, dots, 0, blendOverMax);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}
*/
///////////////////////////////////////////////////////////////////////////////


export class Dynamo {
  static Node = class {
    constructor(y) {
      this.x = 0;
      this.y = y;
      this.v = 0;
    }
  }

  constructor() {
    Daydream.W = 96;

    // State
    this.pixels = new Map();

    this.palettes = [new GenerativePalette('vignette')];
    this.paletteBoundaries = [];
    this.paletteNormal = Daydream.Y_AXIS.clone();

    this.nodes = [];
    for (let i = 0; i < Daydream.H; ++i) {
      this.nodes.push(new Dynamo.Node(i));
    }
    this.speed = 2;
    this.gap = 4;
    this.trailLength = 10;
    this.orientation = new Orientation();
    this.trails = new FilterDecayTrails(this.trailLength);
    this.aa = new FilterAntiAlias();
    this.replicate = new FilterReplicate(4);
    this.orient = new FilterOrient(this.orientation);

    // Filters
    this.filters = new FilterRaw();
    this.filters
      .chain(this.replicate)
      .chain(this.trails)
      .chain(this.orient)
      .chain(this.aa)
      ;

    // Scene
    this.timeline = new Timeline();

    this.timeline.add(0,
      new RandomTimer(4, 64, () => {
        this.reverse();
      }, true)
    );
    this.timeline.add(0,
      new RandomTimer(20, 64, () => {
        this.colorWipe();
      }, true)
    );

    this.timeline.add(0,
      new RandomTimer(80, 160, () => {
        this.rotate();
      }, true)
    );
  }

  reverse() {
    this.speed *= -1;
  }

  rotate() {
    this.timeline.add(0,
      new Rotation(
        this.orientation,
        randomVector(),
        Math.PI,
        40,
        easeInOutSin,
        false
      )
    );
  }

  colorWipe() {
    this.palettes.unshift(new GenerativePalette('vignette'));
    this.paletteBoundaries.unshift(new MutableNumber(0));
    this.timeline.add(0,
      new Transition(this.paletteBoundaries[0], Math.PI, 20, easeMid)
        .then(() => {
          this.paletteBoundaries.pop();
          this.palettes.pop();
        }
        )
    );
  }

  color(v, t) {
    const blendWidth = Math.PI / 8;
    const numBoundaries = this.paletteBoundaries.length;
    const numPalettes = this.palettes.length;
    const a = angleBetween(v, this.paletteNormal);

    for (let i = 0; i < numBoundaries; ++i) {
      const boundary = this.paletteBoundaries[i].get();
      const lowerBlendEdge = boundary - blendWidth;
      const upperBlendEdge = boundary + blendWidth;

      if (a < lowerBlendEdge) {
        return this.palettes[i].get(t);
      }

      if (a >= lowerBlendEdge && a <= upperBlendEdge) {
        const blendFactor = (a - lowerBlendEdge) / (2 * blendWidth);
        const clampedBlendFactor = Math.max(0, Math.min(blendFactor, 1));
        const color1 = this.palettes[i].get(t);
        const color2 = this.palettes[i + 1].get(t);
        return color1.clone().lerp(color2, clampedBlendFactor);
      }

      const nextBoundaryLowerBlendEdge = (i + 1 < numBoundaries)
        ? this.paletteBoundaries[i + 1].get() - blendWidth
        : Infinity;

      if (a > upperBlendEdge && a < nextBoundaryLowerBlendEdge) {
        return this.palettes[i + 1].get(t);
      }
    }

    return this.palettes[0].get(t);
  }

  drawFrame() {
    this.pixels.clear();
    this.trails.decay();
    this.timeline.step();
    for (let i = Math.abs(this.speed) - 1; i >= 0; --i) {
      this.pull(0);
      this.drawNodes(i * 1 / Math.abs(this.speed));
    }
    this.trails.trail(this.pixels,
      (x, y, t) => this.color(pixelToVector(x, y), t), 0.5);
    return this.pixels;
  }

  nodeY(node) {
    return (node.y / (this.nodes.length - 1)) * (Daydream.H - 1);
  }

  drawNodes(age) {
    let dots = [];
    for (let i = 0; i < this.nodes.length; ++i) {
      if (i == 0) {
        let from = pixelToVector(this.nodes[i].x, this.nodeY(this.nodes[i]));
        dots.push(...drawVector(from, (v) => this.color(v, 0)));
      } else {
        let from = pixelToVector(this.nodes[i - 1].x, this.nodeY(this.nodes[i - 1]));
        let to = pixelToVector(this.nodes[i].x, this.nodeY(this.nodes[i]));
        dots.push(...drawLine(from, to, (v) => this.color(v, 0)));
      }
    }
    plotDots(this.pixels, this.filters, dots, age, 0.5);
  }

  pull(y) {
    this.nodes[y].v = dir(this.speed);
    this.move(this.nodes[y]);
    for (let i = y - 1; i >= 0; --i) {
      this.drag(this.nodes[i + 1], this.nodes[i]);
    }
    for (let i = y + 1; i < this.nodes.length; ++i) {
      this.drag(this.nodes[i - 1], this.nodes[i]);
    }
  }

  drag(leader, follower) {
    let dest = wrap(follower.x + follower.v, Daydream.W);
    if (shortest_distance(dest, leader.x, Daydream.W) > this.gap) {
      follower.v = leader.v;
      while (shortest_distance(follower.x, leader.x, Daydream.W) > this.gap) {
        this.move(follower);
      }
    } else {
      this.move(follower);
    }
  }

  move(ring) {
    let dest = wrap(ring.x + ring.v, Daydream.W);
    let x = ring.x;
    while (x != dest) {
      x = wrap(x + dir(ring.v), Daydream.W);
    }
    ring.x = dest;
  }
}

export class RingShower {

  static Ring = class {
    constructor(filters) {
      this.normal = randomVector();
      this.duration = 8 + Math.random() * 72;
      this.radius = new MutableNumber(0);
      this.lastRadius = this.radius.get();
      this.palette = new GenerativePalette('circular', 'analogous', 'flat');
    }
  }

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.rings = [];

    this.palette = new GenerativePalette();
    this.orientation = new Orientation();
    this.filters = new FilterAntiAlias();

    this.timeline = new Timeline();
    this.timeline.add(0,
      new RandomTimer(1, 24,
        () => this.spawnRing(),
        true
      )
    );
  }

  spawnRing() {
    let ring = new RingShower.Ring(this.filters);
    this.rings.unshift(ring);

    this.timeline.add(0,
      new Sprite(() => this.drawRing(ring),
        ring.duration,
        4, easeMid,
        0, easeMid
      ).then(() => {
        this.rings.pop();
      }));

    this.timeline.add(0,
      new Transition(ring.radius, 2, ring.duration, easeMid)
    );
  }

  drawRing(ring) {
    let step = 1 / Daydream.W;
    let dots = drawRing(this.orientation.orient(ring.normal), ring.radius.get(),
      (v, t) => ring.palette.get(t));
    plotDots(this.pixels, this.filters, dots, 0, 0.5);
    ring.lastRadius = ring.radius.get();

  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

export class RingSpin {
  static Ring = class {
    constructor(normal, filters, palette, trailLength) {
      this.normal = normal;
      this.orientation = new Orientation();
      this.walk = new RandomWalk(this.orientation, this.normal);
      this.palette = palette;
      this.trails = new FilterDecayTrails(trailLength);
      this.trails.chain(filters);
    }
  }

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.rings = [];
    this.alpha = 0.2;
    this.trailLength = new MutableNumber(6);
    this.filters = new FilterAntiAlias();

    this.palettes = [richSunset, iceMelt];
    this.numRings = 2;

    this.timeline = new Timeline();
    this.timeline.add(0, new Mutation(this.trailLength,
      sinWave(0, 20, 1, 0),
      10, true)
    );
    for (let i = 0; i < this.numRings; ++i) {
      this.spawnRing(randomVector(), this.palettes[i]);
    }

    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
  }

  spawnRing(normal, palette) {
    let ring = new RingSpin.Ring(normal, this.filters, palette, this.trailLength.get());
    this.rings.unshift(ring);

    this.timeline.add(0,
      new Sprite(() => this.drawRing(ring),
        -1,
        4, easeMid,
        0, easeMid
      ));
    this.timeline.add(0, ring.walk);
  }

  drawRing(ring) {
    let end = ring.orientation.length();
    let start = end == 1 ? 0 : 1;
    for (let i = start; i < end; ++i) {
      let dots = drawRing(ring.orientation.orient(ring.normal, i), 1,
        (v, t) => vignette(ring.palette)(0));
      plotDots(this.pixels, ring.trails, dots,
        (end - 1 - i) / end,
        this.alpha);
    }
    ring.trails.trail(this.pixels, (x, y, t) => vignette(ring.palette)(t), this.alpha);
    ring.trails.decay();
    ring.orientation.collapse();
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}


export class RingMachine {

  static Ring = class {
    constructor(filters, timeline, normal, axis, speed, delay, palette, trailLength) {
      this.normal = normal;
      this.axis = axis;
      this.speed = speed;
      this.delay = delay;
      this.orientation = new Orientation();
      this.palette = palette;
      this.trails = new FilterDecayTrails(trailLength);
      this.trails.chain(filters);

      this.rotation = new Rotation(this.orientation, this.axis, 2 * Math.PI, this.speed, easeMid, true);
      timeline.add(delay / 16, this.rotation);
    }
  }

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.rings = [];
    this.alpha = 0.5;
    this.trailLength = 10;
    this.speed = 80;
    this.numRings = 96;
    this.offsetAngle = 2 * Math.PI / this.numRings;
    this.filters = new FilterAntiAlias();
    this.timeline = new Timeline();


    for (let i = 0; i < this.numRings; ++i) {
      let axis = Daydream.Y_AXIS.clone().applyAxisAngle(Daydream.Z_AXIS, i * this.offsetAngle)
      this.spawnRing(Daydream.Z_AXIS, axis, this.speed, i * 16, lateSunset, this.trailLength);
    }

    for (let i = 0; i < this.numRings; ++i) {
      let axis = Daydream.Z_AXIS.clone().applyAxisAngle(Daydream.X_AXIS, i * this.offsetAngle)
      this.spawnRing(Daydream.X_AXIS, axis, this.speed, i * 16, lemonLime, this.trailLength);
    }

    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);

  }

  spawnRing(normal, axis, speed, delay, palette, trailLength) {
    let ring = new RingMachine.Ring(this.filters, this.timeline, normal, axis, speed, delay, palette, trailLength);
    this.rings.unshift(ring);

    this.timeline.add(0,
      new Sprite(() => this.drawRing(ring),
        -1,
        4, easeMid,
        0, easeMid
      ));
  }

  drawRing(ring) {
    // Draw trails from last motion up to current position
    for (let i = 0; i < ring.orientation.length() - 1; ++i) {
      let dots = drawVector(
        ring.orientation.orient(ring.normal, i),
        (v, t) => new THREE.Color(1, 1, 1));
      plotDots(this.pixels, ring.trails, dots, 1 - (i / ring.orientation.length() - 1), this.alpha);
    }

    ring.trails.trail(this.pixels, (x, y, t) => ring.palette.get(1 - t), this.alpha);
    ring.trails.decay();
    ring.orientation.collapse();

    // Draw current position
    let dots = drawVector(
      ring.orientation.orient(ring.normal),
      (v, t) => ring.palette.get(1.0));
    plotDots(this.pixels, ring.trails, dots, 0, this.alpha);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class NoiseParticles {

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.alpha = 0.5;
    this.filters = new FilterAntiAlias();
    this.timeline = new Timeline();
    this.particles = new ParticleSystem();
    this.timeline.add(0, this.particles);

    for (let x = 0; x < Daydream.W; ++x) {
      for (let y = 0; y < Daydream.H; ++y) {
        if (x % 4 == 0 && y % 2 == 0) {
          this.particles.spawn(pixelToVector(x, y));
        }
      }
    }

    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    let dots = [];
    for (let p of this.particles.particles) {
      dots.push(...drawVector(p.p.clone().add(p.v).normalize(), () => new THREE.Color(1, 0, 0)));
    }
    plotDots(this.pixels, this.filters, dots, 0, this.alpha);
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class NoiseFieldEffect {
  constructor() {
    this.pixels = new Map();

    this.perlin1 = new PerlinNoise1D();
    this.perlin4 = new PerlinNoise4D();
    this.palette = darkRainbow;
    this.t = 0;
    this.noiseScale = 2;
    this.timeScale = 0.1;
  }

  drawFrame() {
    this.pixels.clear();
    this.t++;
    for (let x = 0; x < Daydream.W; x++) {
      for (let y = 0; y < Daydream.H; y++) {
        const v = pixelToVector(x, y);
        let t = this.t * this.timeScale + Math.sin(this.t * 2 * Math.PI) * 0.01
        const noiseValue = this.perlin4.noise(
          v.x * this.noiseScale,
          v.y * this.noiseScale,
          v.z * this.noiseScale,
          this.t * this.timeScale
        );

        const palette_t = (noiseValue + 1) / 2;
        const color = this.palette.get(palette_t);
        this.pixels.set(pixelKey(x, y), color);
      }
    }

    return this.pixels;
  }
}


/**
 * Metaballs Effect (V5: Smooth Orbital Physics)
 * * Uses a central gravity force for smooth, "soft" containment
 * * instead of a jerky "hard" bounce.
 */
export class MetaballEffect {
  constructor() {
    this.pixels = new Map();
    this.palette = richSunset;
    this.t = 0;

    // --- Tunable Knobs ---
    this.maxInfluence = 10.0;
    this.gravity = 0.005; // New knob: How strong is the pull to the center?

    // --- Define our 16 Metaballs ---
    this.balls = [];
    const NUM_BALLS = 16;

    for (let i = 0; i < NUM_BALLS; i++) {
      const rand = (min, max) => Math.random() * (max - min) + min;

      this.balls.push({
        p: new THREE.Vector3(
          rand(-0.5, 0.5), // Random start position
          rand(-0.5, 0.5),
          rand(-0.5, 0.5)
        ),
        r: rand(0.5, 0.8), // Bigger radius
        v: new THREE.Vector3(
          rand(-0.02, 0.08), // Slightly faster velocity
          rand(-0.02, 0.08),
          rand(-0.02, 0.08)
        )
      });
    }
  }

  drawFrame() {
    this.pixels.clear();
    this.t++;

    // 1. Animate the balls
    for (const ball of this.balls) {

      // --- THIS IS THE NEW LOGIC ---
      // 1. Apply a "gravity" force pulling the ball toward the center (0,0,0)
      //    We do this by adding a tiny, inverted copy of its position to its velocity.
      ball.v.add(ball.p.clone().multiplyScalar(-this.gravity));

      // 2. Apply the (now gravity-affected) velocity to the position
      ball.p.add(ball.v); //

    }

    // 2. Iterate *every single pixel* on the sphere's surface
    for (let x = 0; x < Daydream.W; x++) {
      for (let y = 0; y < Daydream.H; y++) {

        // Get the 3D position of this pixel
        const v = pixelToVector(x, y); //

        let sum = 0.0;

        // 3. Sum the influence from all 16 balls
        for (const ball of this.balls) {
          // Get squared distance (faster, no sqrt) from pixel to ball
          const distSq = v.distanceToSquared(ball.p);

          // The metaball function: r^2 / d^2
          sum += (ball.r * ball.r) / distSq;
        }

        // 4. Map the total influence to a palette coordinate
        const palette_t = Math.min(1.0, sum / this.maxInfluence);

        // 5. Get the color and plot the dot
        const color = this.palette.get(palette_t); //
        this.pixels.set(pixelKey(x, y), color); //
      }
    }

    return this.pixels;
  }
}

export class Comets {
  static Node = class {
    constructor() {
      this.orientation = new Orientation();
      this.v = randomVector();
      this.path = new Path();
      this.updatePath();
    }

    updatePath() {
      this.path.collapse();
      this.path.appendLine(this.orientation.orient(this.v), randomVector(), true, easeMid);
    }
  }
  constructor() {
    this.pixels = new Map();
    this.alpha = 0.5;
    this.orientation = new Orientation();

    this.palette = embers;

    this.filters = new FilterDecayTrails(20);
    this.filters
      .chain(new FilterOrient(this.orientation))
      .chain(new FilterAntiAlias());
    this.numNodes = 6;
    this.nodes = [];
    this.timeline = new Timeline();

    for (let i = 0; i < this.numNodes; ++i) {
      this.spawnNode();
    }

    this.timeline.add(0, new RandomWalk(this.orientation, randomVector()));
  }

  spawnNode() {
    let i = this.nodes.length;
    this.nodes.push(new Comets.Node());
    this.timeline.add(randomBetween(0, 48),
      new Sprite((opacity) => this.drawNode(opacity, i), -1, 16, easeMid, 0, easeMid)
    );
    this.timeline.add(randomBetween(0, 16),
      new Motion(this.nodes[i].orientation, this.nodes[i].path, 16, true)
        .then(() => {
          this.nodes[i].updatePath();
        })
    );

  }

  drawNode(opacity, i) {
    let dots = [];
    let node = this.nodes[i];
    let s = node.orientation.length();
    for (let i = 0; i < s; ++i) {
      dots.push(...drawVector(node.orientation.orient(node.v, i),
        (v, t) => this.palette.get(1 - ((s - 1 - i) / s))));
    }
    plotDots(this.pixels, this.filters, dots, 0, opacity);
    node.orientation.collapse();
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    this.filters.trail(this.pixels, (x, y, t) => this.palette.get(1 - t), this.alpha);
    this.filters.decay();
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////




/**
 * FlowField Effect
 * * This effect simulates a particle system where each particle is pushed
 * across the sphere's surface by an evolving 4D Perlin noise field.
 * A gentle gravity-like force, similar to the one in your MetaballEffect,
 * keeps the particles from flying off, ensuring smooth, orbital motion.
 */
export class FlowField {

  // A simple class to hold particle state
  static Particle = class {
    constructor() {
      // Start at a random point on the sphere's surface
      this.pos = new THREE.Vector3(
        Math.random() * 2 - 1,
        Math.random() * 2 - 1,
        Math.random() * 2 - 1
      ).normalize();

      // Start with no velocity
      this.vel = new THREE.Vector3(0, 0, 0);
    }
  }

  // 1. REPLACE the old constructor with this new one
  constructor() {
    this.pixels = new Map();
    this.timeline = new Timeline();

    // --- Configuration ---
    // MODIFIED: Reduced default particle count
    this.NUM_PARTICLES = 250;      // Total number of particles (Was 1000)
    this.NOISE_SCALE = 1.5;
    this.TIME_SCALE = 0.01;
    this.FORCE_SCALE = 0.002;
    this.GRAVITY = 0.001;
    this.MAX_SPEED = 0.01;
    // MODIFIED: Reduced default trail length
    this.TRAIL_LENGTH = 8;         // Trail filter lifespan in frames (Was 15)
    this.ALPHA = 0.7;

    // --- Setup ---
    this.particles = [];
    // (Particles will be created in resetParticles)

    this.noise = new PerlinNoise4D();

    this.palette = iceMelt;

    // --- Filters ---
    // MODIFIED: Pass 'this.TRAIL_LENGTH' so it's not a static value
    this.trails = new FilterDecayTrails(this.TRAIL_LENGTH);
    this.aa = new FilterAntiAlias();
    this.filters = new FilterRaw();

    this.filters.chain(this.trails).chain(this.aa);

    // --- GUI Controls ---
    this.gui = new gui.GUI();

    // NEW: Add GUI for particle count
    this.gui.add(this, 'NUM_PARTICLES').min(50).max(2000).step(10).name('Particle Count').onChange(() => this.resetParticles());

    // NEW: Add GUI for trail length
    this.gui.add(this, 'TRAIL_LENGTH').min(1).max(30).step(1).name('Trail Length').onChange((value) => {
      this.trails.lifespan = value; // Update the filter's lifespan directly
    });

    this.gui.add(this, 'NOISE_SCALE').min(0.1).max(5).step(0.1).name('Noise Scale');
    this.gui.add(this, 'FORCE_SCALE').min(0.0001).max(0.01).step(0.0001).name('Force');
    this.gui.add(this, 'GRAVITY').min(0).max(0.01).step(0.0001).name('Gravity');
    this.gui.add(this, 'MAX_SPEED').min(0.001).max(0.1).step(0.001).name('Max Speed');
    this.gui.add(this, 'ALPHA').min(0).max(1).step(0.01).name('Opacity');

    // --- Initial Population ---
    // NEW: Call the new method
    this.resetParticles();
  }

  // 2. ADD this new method right after the constructor
  /**
   * Clears and repopulates the particle array based on this.NUM_PARTICLES.
   * Called by the constructor and the "Particle Count" GUI slider.
   */
  resetParticles() {
    this.particles = []; // Clear old particles
    for (let i = 0; i < this.NUM_PARTICLES; i++) {
      this.particles.push(new FlowField.Particle());
    }
  }

  // (The 'Particle' subclass, 'drawFrame', and 'getNoiseForce' methods
  // can all remain exactly as they were.)

  /**
   * Main render loop, called by the daydream renderer.
   */
  drawFrame() {
    this.pixels.clear();
    this.timeline.step(); // This increments this.timeline.t
    this.trails.decay();  // Age all existing trails by one frame

    let dots = []; // A buffer for all particle "heads" this frame

    for (const p of this.particles) {
      // 1. Get acceleration from the 4D noise field
      let accel = this.getNoiseForce(p.pos, this.timeline.t);

      // 2. Apply a gravity force pulling the particle to the center
      // This is the same technique from your MetaballEffect
      let gravityForce = p.pos.clone().multiplyScalar(-this.GRAVITY);
      accel.add(gravityForce);

      // 3. Update velocity
      p.vel.add(accel);
      p.vel.clampLength(0, this.MAX_SPEED); // Apply terminal velocity

      // 4. Update position
      p.pos.add(p.vel);
      p.pos.normalize(); // Snap the particle back to the sphere's surface

      // 5. Get color based on speed
      // We map the particle's speed [0, MAX_SPEED] to the palette's t [0, 1]
      let speedRatio = p.vel.length() / this.MAX_SPEED;
      let color = this.palette.get(speedRatio);

      // 6. Add the particle's head to the dot buffer
      dots.push(new Dot(p.pos, color));
    }

    // Plot all particle heads to the trail filter (with age 0)
    plotDots(this.pixels, this.filters, dots, 0, this.ALPHA);

    // Now, render the actual trails left behind from previous frames
    this.trails.trail(this.pixels,
      (x, y, t) => {
        // 't' is the trail's age (0.0 at head, 1.0 at end)
        // We'll fade the color and brightness based on its age.
        return this.palette.get(1.0 - t).multiplyScalar(1.0 - t);
      },
      this.ALPHA
    );

    return this.pixels;
  }

  /**
   * Helper to get a 3D force vector from 4D noise.
   * We sample the noise field 3 times with different 'w' (time) offsets
   * to create a complex, "swirly" vector field.
   */
  getNoiseForce(pos, t) {
    let t_scaled = t * this.TIME_SCALE;
    let n_pos = pos.clone().multiplyScalar(this.NOISE_SCALE);

    let x_force = this.noise.noise(n_pos.x, n_pos.y, n_pos.z, t_scaled);
    let y_force = this.noise.noise(n_pos.x, n_pos.y, n_pos.z, t_scaled + 100);
    let z_force = this.noise.noise(n_pos.x, n_pos.y, n_pos.z, t_scaled + 200);

    return new THREE.Vector3(x_force, y_force, z_force).multiplyScalar(this.FORCE_SCALE);
  }
}





///////////////////////////////////////////////////////////////////////////////

/**
 * VerticalMarch Effect (v4)
 *
 * This effect draws a configurable number of dots in a vertical line.
 * - Every 1-3 seconds, the dots animate (slerp) to a new random longitude.
 * - The duration of this move is configurable.
 * - The camera (via FilterOrient) rotates in the opposite direction at speed 'c'
 * AND is mutated by a RandomWalk.
 */
export class VerticalMarch {

  constructor() {
    this.pixels = new Map();
    this.timeline = new Timeline();

    // --- Configurable State (from GUI) ---
    this.camera_speed = new MutableNumber(0.01);   // 'c'
    this.trail_length = new MutableNumber(5);      // Trail length
    this.num_dots = new MutableNumber(1);          // Number of dots
    this.dot_move_duration = new MutableNumber(16); // Duration of the slerp (1 sec @ 16fps)
    this.alpha = 1.0;                            // Particle opacity

    // --- Internal State ---
    this.dot_base_positions = []; // Base positions (longitude 0)
    this.dot_orientation = new Orientation(); // Manages dot rotation

    // The dot orientation starts at a random longitude
    this.dot_orientation.set(
      new THREE.Quaternion().setFromAxisAngle(Daydream.Y_AXIS, Math.random() * 2 * Math.PI)
    );

    // Camera motion is split into two parts
    this.camera_orient_base = new Orientation(); // For the opposing rotation
    this.camera_orient_walk = new Orientation(); // For the RandomWalk
    this.final_camera_orient = new Orientation(); // For the filter

    this.palette = richSunset; // Use the specified palette

    // --- Filters ---
    this.trails = new FilterDecayTrails(this.trail_length.get());
    this.orient = new FilterOrient(this.final_camera_orient); // Filter uses the combined result
    this.aa = new FilterAntiAlias();

    // Set up the filter chain: [Raw Plot] -> Trails -> Orient -> AntiAlias
    this.filters = new FilterRaw();
    this.filters
      .chain(this.trails)
      .chain(this.orient)
      .chain(this.aa);

    // --- GUI Setup ---
    this.gui = new gui.GUI();
    this.gui.add(this.num_dots, 'n', 1, 20).step(1).name('Dot Count').onChange(() => {
      this.reset_dots();
    });
    // REPLACED 'Dot Speed (s)' with 'Dot Move Duration'
    this.gui.add(this.dot_move_duration, 'n', 4, 64).step(1).name('Dot Move (frames)');
    this.gui.add(this.camera_speed, 'n', 0.0, 0.1).step(0.001).name('Camera Speed (c)');
    this.gui.add(this.trail_length, 'n', 1, 30).step(1).name('Trail Length').onChange((value) => {
      this.trails.lifespan = Math.floor(value); // Update filter lifespan
    });

    // --- Animation Timeline ---
    // This Sprite just handles drawing the dots every frame
    this.timeline.add(0, new Sprite(this.draw_dots.bind(this), -1));

    // This Mutation animates the camera's base angle continuously
    this.timeline.add(0, new Mutation(
      this.camera_angle, // This variable is created/used by the Mutation
      (t, old_val) => (old_val - this.camera_speed.get()) % (2 * Math.PI), // SUBTRACT speed
      -1,
      easeMid,
      true
    ));

    // Add the RandomWalk animation to mutate the camera's "walk" orientation
    this.timeline.add(0, new RandomWalk(this.camera_orient_walk, randomVector()));

    // NEW: Add a repeating timer to trigger the dot moves
    // 16-48 frames is 1-3 seconds at 16fps
    this.timeline.add(0, new RandomTimer(
      16, // min frames
      48, // max frames
      () => this.on_move_dots(), // callback
      true // repeat
    ));

    // --- Initial Setup ---
    this.reset_dots(); // Create the initial dot positions
  }

  /**
   * (Re)creates the base dot positions at longitude 0.
   */
  reset_dots() {
    this.dot_base_positions = [];
    const n = Math.floor(this.num_dots.get());
    const theta = 0; // All dots start at longitude 0

    if (n === 1) {
      // Default to 1 dot at the equator
      const phi = Math.PI / 2;
      this.dot_base_positions.push(
        new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, phi, theta))
      );
    } else {
      // Space dots evenly from (but not at) pole to pole
      for (let i = 0; i < n; i++) {
        const phi = (i + 1) * (Math.PI / (n + 1));
        this.dot_base_positions.push(
          new THREE.Vector3().setFromSpherical(new THREE.Spherical(1, phi, theta))
        );
      }
    }
  }

  /**
   * NEW: Callback for the RandomTimer.
   * This function calculates the rotation needed to get from the current
   * orientation to a new random one and adds that Rotation to the timeline.
   */
  on_move_dots() {
    // 1. Get the current orientation (where the dots *are* right now)
    const q_current = this.dot_orientation.get().clone();

    // 2. Define a new target orientation (where we *want* them to go)
    const target_angle = Math.random() * 2 * Math.PI;
    const q_target = new THREE.Quaternion().setFromAxisAngle(Daydream.Y_AXIS, target_angle);

    // 3. Find the relative rotation (q_rel) to get from current to target
    // We need to solve: q_target = q_rel * q_current
    // So: q_rel = q_target * q_current.invert()
    const q_rel = q_target.clone().multiply(q_current.invert());

    // 4. Find the shortest path (slerp)
    // If w is negative, we're taking the "long way" around the 4D sphere.
    // Negating the quaternion gives us the same rotation via the short way.
    if (q_rel.w < 0) {
      q_rel.negate();
    }

    // 5. Extract the axis and angle from this relative rotation
    const angle = 2 * Math.acos(q_rel.w);
    let axis = new THREE.Vector3(q_rel.x, q_rel.y, q_rel.z);

    // Avoid division by zero if angle is 0
    if (axis.lengthSq() > 0.0001) {
      axis.normalize();
    } else {
      axis.set(0, 1, 0); // Default to Y-axis if no rotation
    }

    // 6. Add this new relative Rotation animation to the timeline
    this.timeline.add(0, new Rotation(
      this.dot_orientation,
      axis,
      angle,
      this.dot_move_duration.get(),
      easeInOutSin // A smooth ease-in-out for the move
    ));
  }

  /**
   * The main draw function, called by the Sprite animation.
   */
  draw_dots(opacity) {
    let dots = [];
    const n = this.dot_base_positions.length;

    // 1. Animate the base camera orientation
    // We use Rotation.animate here because it's a *continuous*
    // rotation, unlike the dots' intermittent moves.
    Rotation.animate(
      this.camera_orient_base,
      Daydream.Y_AXIS,
      -this.camera_speed.get(), // Negative angle
      easeMid
    );

    // 2. Combine camera orientations
    // The final orientation is the base rotation * the random walk
    this.final_camera_orient.set(
      this.camera_orient_base.get().clone().premultiply(this.camera_orient_walk.get())
    );
    // Collapse intermediates, as the filter only needs the final state
    this.camera_orient_base.collapse();
    this.camera_orient_walk.collapse();
    this.final_camera_orient.collapse();

    // 3. Draw all dots, "graphing" the intermediate rotation steps
    // The timeline.step() in drawFrame will have run any active Rotation
    // animation, populating dot_orientation with intermediate steps.
    const num_steps = this.dot_orientation.length();

    // Iterate from 1, as 0 is the "previous" frame's position
    for (let step = 1; step < num_steps; step++) {
      // Calculate age based on how far back in the frame's history it is
      // This is 0 for the most recent step (the "head")
      const age = (num_steps - 1 - step) / (num_steps - 1);

      for (let i = 0; i < n; i++) {
        const base_pos = this.dot_base_positions[i];

        // Get the dot's position at this intermediate step
        const rotated_pos = this.dot_orientation.orient(base_pos, step);

        // Get color from the palette
        let color_t = (n === 1) ? 0.5 : (i / (n - 1));
        const color = this.palette.get(color_t);

        // Fade the dot's opacity based on its age *within* the frame
        const step_opacity = opacity * (1.0 - age);

        dots.push(new Dot(rotated_pos, color.clone().multiplyScalar(step_opacity)));
      }
    }

    // 4. Collapse the dot orientation to its final state for the next frame
    // This becomes the starting point for the *next* Rotation.
    this.dot_orientation.collapse();

    // 5. Plot the dots. This sends them to this.filters (Raw -> Trails -> Orient -> AA)
    // We set age 0, as the trail filter will handle fading them over *time*.
    plotDots(this.pixels, this.filters, dots, 0, this.alpha * opacity);
  }

  /**
   * Main render loop, called by the daydream renderer.
   */
  drawFrame() {
    this.pixels.clear();

    // Run all animations (Sprite, RandomWalk, Camera Mutation, and any
    // active dot Rotations)
    this.timeline.step();

    // Draw the trails from previous frames
    this.trails.trail(
      this.pixels,
      (x, y, t) => {
        // 't' is the trail's age (0.0 at head, 1.0 at end)
        return this.palette.get(1.0 - t).multiplyScalar(1.0 - t);
      },
      this.alpha
    );

    // Age all trail pixels
    this.trails.decay();

    return this.pixels;
  }
}