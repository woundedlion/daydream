import * as THREE from "three";
import { gui } from "gui";
import { Daydream, pixelKey } from "./driver.js";
import FastNoiseLite from "./FastNoiseLite.js";

import {
  Orientation, Dodecahedron, angleBetween, pixelToVector,
  distanceGradient, isOver, bisect, lissajous,
  fibSpiral, randomVector, Dot, sinWave, lerp, squareWave
} from "./geometry.js";

import {
  Path, drawLine, drawRing, plotDots, drawPolyhedron,
  drawFn, ringPoint, fnPoint, drawVector, ProceduralPath, tween
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
  easeInCirc, easeOutCirc, PeriodicTimer, ColorWipe
} from "./animation.js";

import {
  FilterAntiAlias, FilterDecay, FilterRaw, FilterReplicate,
  FilterOrient, FilterChromaticShift, FilterMirror, FilterFn,
  FilterSinDisplace, FilterColorShift, FilterTwinkle
} from "./filters.js";

import { dir, wrap, shortest_distance, randomChoice, randomBetween } from "./util.js";

///////////////////////////////////////////////////////////////////////////////

export class Test {
  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.alpha = 1.0;
    this.filters = new FilterAntiAlias();
    this.palette = mangoPeel;
    this.normal = Daydream.X_AXIS.clone();
    this.orientation = new Orientation();
    this.timeline = new Timeline();
    this.amplitude = new MutableNumber(0);

    this.timeline.add(0,
      new Sprite((opacity) => this.draw(opacity), -1, 48, easeMid, 0, easeMid)
    );

    this.timeline.add(0,
      new Transition(this.amplitude, 1, 48, easeInOutSin, false, true)
        .then(() => { this.amplitude.set(0); })
    );
  
    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
  }

  draw(opacity) {
    let dots = [];
    dots.push(...drawFn(this.orientation.get(), this.normal, 1,
      (t) => sinWave(-0.3 * this.amplitude.get(), 0.3 * this.amplitude.get(), 4, 0)(t),
      (v, t) => this.palette.get(t)
    ));
    plotDots(this.pixels, this.filters, dots, 0, opacity * this.alpha);
  }


  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
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
      this.phase = new MutableNumber(0);
    }
  }

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.rings = [];
    this.alpha = 0.2;

    this.palette = new GenerativePalette();
    this.orientation = new Orientation();
    this.filters = new FilterAntiAlias();

    this.timeline = new Timeline();
    this.timeline.add(0,
      new RandomTimer(4, 48,
        () => this.spawnRing(),
        true
      )
    );

    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
  }

  spawnRing() {
    let ring = new RingShower.Ring(this.filters);
    this.rings.unshift(ring);

    this.timeline.add(0,
      new Sprite((opacity) => this.drawRing(opacity, ring),
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

  drawRing(opacity, ring) {
    let step = 1 / Daydream.W;
    let dots = drawRing(this.orientation.get(), ring.normal, ring.radius.get(),
      (v, t) => ring.palette.get(t), ring.phase.get());
    plotDots(this.pixels, this.filters, dots, 0, opacity * this.alpha);
    ring.lastRadius = ring.radius.get();
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class RingSpin {
  static Ring = class {
    constructor(normal, filters, palette, trailLength) {
      this.normal = normal;
      this.orientation = new Orientation();
      this.palette = palette;
      this.trails = new FilterDecay(trailLength);
      this.trails.chain(filters);
    }
  }

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.rings = [];
    this.alpha = 0.2;
    this.trailLength = new MutableNumber(20);
    this.filters = new FilterAntiAlias();

    this.palettes = [richSunset, mangoPeel, underSea, iceMelt ];
    this.numRings = 4;
    this.timeline = new Timeline();

    for (let i = 0; i < this.numRings; ++i) {
      this.spawnRing(Daydream.X_AXIS, this.palettes[i]);
    }

    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
  }

  spawnRing(normal, palette) {
    let ring = new RingSpin.Ring(normal, this.filters, palette, this.trailLength.get());
    this.rings.unshift(ring);

    this.timeline.add(0,
      new Sprite((opacity) => this.drawRing(opacity, ring),
        -1,
        4, easeMid,
        0, easeMid
      ));
    this.timeline.add(0,
      new RandomWalk(ring.orientation, ring.normal));
  }

  drawRing(opacity, ring) {
    let end = ring.orientation.length();
    tween(ring.orientation, (q, t) => {
      let dots = drawRing(q, ring.normal, 1,
        (v, t) => vignette(ring.palette)(0));
      plotDots(this.pixels, ring.trails, dots, t, this.alpha);
    });
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

///////////////////////////////////////////////////////////////////////////////

export class Comets {
  static Node = class {
    constructor(path) {
      this.orientation = new Orientation();
      this.v = Daydream.Y_AXIS;
      this.path = path;
    }
  }
  constructor() {
    this.pixels = new Map();
    this.timeline = new Timeline();
    this.numNodes = 1;
    this.spacing = 48;
    this.cycleDuration = 80;
    this.trailLength = this.cycleDuration;
    this.alpha = 0.5;
    this.orientation = new Orientation();
    this.path = new Path(Daydream.Y_AXIS);
    this.functions = [
      [(t) => lissajous(1.06, 1.06, 0, t), 5.909],
      [(t) => lissajous(6.06, 1, 0, t), 2 * Math.PI],
      [(t) => lissajous(6.02, 4.01, 0, t), 3.132],
      [(t) => lissajous(46.62, 62.16, 0, t), 0.404],
      [(t) => lissajous(46.26, 69.39, 0, t), 0.272],
      [(t) => lissajous(19.44, 9.72, 0, t), 0.646],
      [(t) => lissajous(8.51, 17.01, 0, t), 0.739],
      [(t) => lissajous(7.66, 6.38, 0, t), 4.924],
      [(t) => lissajous(8.75, 5, 0, t), 5.027],
      [(t) => lissajous(11.67, 14.58, 0, t), 2.154],
      [(t) => lissajous(11.67, 8.75, 0, t), 2.154],
      [(t) => lissajous(10.94, 8.75, 0, t), 2.872]
    ]
    this.curFunction = 0;
    this.updatePath();
    this.palette = new GenerativePalette("straight", "analogous", "ascending");

    this.filters = new FilterDecay(this.trailLength);
    this.filters
      .chain(new FilterOrient(this.orientation))
      .chain(new FilterAntiAlias());
    this.nodes = [];

    for (let i = 0; i < this.numNodes; ++i) {
      this.spawnNode(this.path);
    }

    this.timeline.add(0,
      new PeriodicTimer(2 * this.cycleDuration, () => {
        this.curFunction = Math.floor(randomBetween(0, this.functions.length));
        this.updatePath();
        this.updatePalette();
      }, true)
    );
    this.timeline.add(0, new RandomWalk(this.orientation, randomVector()));
  }

  updatePath() {
    let f = this.functions[this.curFunction][0];
    let domain = this.functions[this.curFunction][1];
    this.path.collapse();
    this.path.appendSegment(f, domain, 1024, easeMid);
  }

  updatePalette() {
    this.nextPalette = new GenerativePalette("straight", "analogous", "ascending");
    this.timeline.add(0,
      new ColorWipe(this.palette, this.nextPalette, 48, easeMid)
    );
  }

  spawnNode(path) {
    let i = this.nodes.length;
    this.nodes.push(new Comets.Node(path));
    this.timeline.add(0,
      new Sprite((opacity) => this.drawNode(opacity, i), -1, 16, easeMid, 0, easeMid)
    );
    this.timeline.add(i * this.spacing,
      new Motion(this.nodes[i].orientation, this.nodes[i].path, this.cycleDuration, true)
    );

  }

  drawNode(opacity, i) {
    let node = this.nodes[i];
    tween(node.orientation, (q, t) => {
      let dots = [];
      let v = node.v.clone().applyQuaternion(q).normalize();
      dots.push(...drawVector(v,
        (v, t) => this.palette.get(1 - t)));
      plotDots(this.pixels, this.filters, dots, t, opacity);
    });
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
    this.gap = 5;
    this.trailLength = 8;
    this.orientation = new Orientation();
    this.trails = new FilterDecay(this.trailLength);
    this.aa = new FilterAntiAlias();
    this.replicate = new FilterReplicate(3);
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
      new RandomTimer(48, 160, () => {
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
    const blendWidth = Math.PI / 4;
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


///////////////////////////////////////////////////////////////////////////////
// Experimental Effects Below!
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
    this.trails = new FilterDecay(4);
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


export class RingMachine {

  static Ring = class {
    constructor(filters, timeline, normal, axis, speed, delay, palette, trailLength) {
      this.normal = normal;
      this.axis = axis;
      this.speed = speed;
      this.delay = delay;
      this.orientation = new Orientation();
      this.palette = palette;
      this.trails = new FilterDecay(trailLength);
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

    this.noise = new FastNoiseLite();
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
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
        
        // Using 3D noise slicing for animation (approximating 4D effect)
        const noiseValue = this.noise.GetNoise(
          v.x * this.noiseScale,
          v.y * this.noiseScale,
          v.z * this.noiseScale + this.t * this.timeScale // Offset Z by time
        );

        const palette_t = (noiseValue + 1) / 2;
        const color = this.palette.get(palette_t);
        this.pixels.set(pixelKey(x, y), color);
      }
    }

    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

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

    this.noise = new FastNoiseLite();
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.noise.SetSeed(Math.floor(Math.random() * 65535));

    this.palette = iceMelt;

    // --- Filters ---
    // MODIFIED: Pass 'this.TRAIL_LENGTH' so it's not a static value
    this.trails = new FilterDecay(this.TRAIL_LENGTH);
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

    // C++ Style 3D noise slice for force field
    // Using 3D noise by mapping (x, y, t), (y, z, t), (z, x, t)
    // to approximate 4D noise derivatives
    let x_force = this.noise.GetNoise(n_pos.x, n_pos.y, t_scaled);
    let y_force = this.noise.GetNoise(n_pos.y, n_pos.z, t_scaled + 100);
    let z_force = this.noise.GetNoise(n_pos.z, n_pos.x, t_scaled + 200);

    return new THREE.Vector3(x_force, y_force, z_force).multiplyScalar(this.FORCE_SCALE);
  }
}

///////////////////////////////////////////////////////////////////////////////
