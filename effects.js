import * as THREE from "three";
import { gui } from "gui";
import { Daydream, labels, pixelKey } from "./driver.js";
import FastNoiseLite from "./FastNoiseLite.js";
import { stereo, invStereo, mobius, MobiusParams } from "./3dmath.js";

import {
  Orientation, Dodecahedron, angleBetween, pixelToVector,
  distanceGradient, isOver, lissajous,
  fibSpiral, randomVector, Dot, sinWave, triWave, lerp, squareWave,
  logPolarToVector, vectorToLogPolar
} from "./geometry.js";

import {
  Path, drawLine, drawRing, plotDots, drawPolyhedron, DecayBuffer,
  drawFn, ringPoint, fnPoint, drawVector, ProceduralPath, tween, drawFibSpiral,
  sampleRing, sampleFn, samplePolyhedron, rasterize
} from "./draw.js";

import {
  blendOverMax, ProceduralPalette, MutatingPalette, blueToBlack,
  rainbow, VignettePalette, darkRainbow, richSunset, bloodStream,
  lateSunset, GenerativePalette, g1, g2, grayToBlack,
  emeraldForest, vintageSunset, underSea, mangoPeel, iceMelt, lemonLime,
  algae, embers
} from "./color.js";

import {
  Animation, Timeline, easeMid, easeInOutSin, Motion, Sprite, Transition,
  Rotation, RandomTimer, easeOutExpo, easeInSin, easeOutSin,
  Mutation, MutableNumber, ParticleSystem, RandomWalk,
  easeOutElastic, easeInOutBicubic, easeInCubic, easeOutCubic,
  easeInCirc, easeOutCirc, PeriodicTimer, ColorWipe,
  MobiusFlow, MobiusWarp
} from "./animation.js";

import {
  createRenderPipeline, FilterAntiAlias, FilterReplicate,
  FilterOrient, FilterChromaticShift, FilterDecay, FilterMobius, FilterHole,
  FilterOrientSlice
} from "./filters.js";

import { dir, wrap, shortest_distance, randomChoice, randomBetween } from "./util.js";

///////////////////////////////////////////////////////////////////////////////

export class Test {

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.alpha = 0.3;
    this.ringPalette = new GenerativePalette("circular", "split-complementary", "flat");
    this.polyPalette = new GenerativePalette("circular", "analagous", "cup");
    this.normal = Daydream.X_AXIS.clone();
    this.orientation = new Orientation();
    this.timeline = new Timeline();
    this.filters = createRenderPipeline(
      new FilterAntiAlias()
    );

    this.amplitude = new MutableNumber(0);
    this.amplitudeRange = 0.3;
    this.poly = new Dodecahedron();
    this.numRings = 1;

    //    this.timeline.add(0,
    //      new Sprite((opacity) => this.drawPoly(opacity), -1, 48, easeMid, 0, easeMid)
    //    );

    this.timeline.add(0,
      new Sprite((opacity) => this.drawFn(opacity), -1, 48, easeMid, 0, easeMid)
    );

    this.timeline.add(0,
      new RandomWalk(this.orientation, this.normal)
    );

    this.timeline.add(0,
      new Mutation(this.amplitude,
        sinWave(-this.amplitudeRange, this.amplitudeRange, 1, 0), 32, easeMid, true)
    );

    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
  }

  drawPoly(opacity) {
    let dots = [];
    dots.push(...drawPolyhedron(this.poly.vertices, this.poly.eulerPath,
      (v, t) => this.polyPalette.get(t)
    ));
    plotDots(this.pixels, this.filters, dots, 0, opacity * this.alpha);
  }

  drawFn(opacity) {
    let dots = [];
    for (let i = 0; i < this.numRings; ++i) {
      let phase = 2 * Math.PI / i;
      dots.push(...drawFn(this.orientation.get(), this.normal,
        2 / (this.numRings + 1) * (i + 1),
        (t) => sinWave(this.amplitude.get(), -this.amplitude.get(), 4, 0)(t),
        (v, t) => {
          return this.ringPalette.get(t);
        },
        i * 2 * Math.PI / this.numRings
      ));
    }
    plotDots(this.pixels, this.filters, dots, 0, opacity * this.alpha);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////


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
    this.filters = createRenderPipeline(
      new FilterAntiAlias()
    );

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
    constructor(normal, palette, trailLength) {
      this.normal = normal;
      this.palette = new VignettePalette(palette);
      this.filters = createRenderPipeline(
        new FilterDecay(trailLength),
        new FilterAntiAlias()
      );
      this.orientation = new Orientation();
    }
  }

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.rings = [];
    this.alpha = 0.2;
    this.trailLength = new MutableNumber(20);
    this.palettes = [richSunset, mangoPeel, underSea, iceMelt];
    this.numRings = 4;
    this.timeline = new Timeline();

    for (let i = 0; i < this.numRings; ++i) {
      this.spawnRing(Daydream.X_AXIS, this.palettes[i]);
    }

    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
  }

  spawnRing(normal, palette) {
    let ring = new RingSpin.Ring(normal, palette, this.trailLength.get());
    ring.basePoints = sampleRing(new THREE.Quaternion(), ring.normal, 1);
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
    tween(ring.orientation, (q, t) => {
      let points = ring.basePoints.map(p => p.clone().applyQuaternion(q));
      let dots = rasterize(points, (v, t) => ring.palette.get(0), true);
      plotDots(this.pixels, ring.filters, dots, 0, this.alpha);
    });
    ring.orientation.collapse();
    ring.filters.trail((x, y, t) => ring.palette.get(t), this.alpha);
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
    this.palette = new GenerativePalette("straight", "triadic", "ascending");
    this.trails = new DecayBuffer(this.trailLength);

    this.filters = createRenderPipeline(
      new FilterOrient(this.orientation),
      new FilterAntiAlias()
    );
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
    this.nextPalette = new GenerativePalette("straight", "triadic", "ascending");
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
        (v, t) => this.palette.get(t)));
      this.trails.recordDots(dots, t, opacity * this.alpha);
    });
    node.orientation.collapse();
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    this.trails.render(this.pixels, this.filters, (v, t) => this.palette.get(1 - t));
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

    // Filters
    this.trails = new DecayBuffer(this.trailLength);
    this.filters = createRenderPipeline(
      new FilterReplicate(3),
      new FilterOrient(this.orientation),
      new FilterAntiAlias()
    );

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
    this.timeline.step();
    for (let i = Math.abs(this.speed) - 1; i >= 0; --i) {
      this.pull(0);
      this.drawNodes(i * 1 / Math.abs(this.speed));
    }
    this.trails.render(this.pixels, this.filters,
      (v, t) => this.color(v, t));
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
    this.trails.recordDots(dots, age, 0.5);
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

class Thruster extends Animation {
  constructor(drawFn, orientation, thrustPoint) {
    super(-1, false);
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
    this.filters = createRenderPipeline(new FilterAntiAlias())

    // State
    this.t = 0;
    this.alpha = 0.2;
    this.ring = new THREE.Vector3(0.5, 0.5, 0.5).normalize();
    this.orientation = new Orientation();
    this.thrusters = [];
    this.amplitude = new MutableNumber(0);
    this.warpPhase = 0;
    this.radius = new MutableNumber(1);

    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);

    // Animations
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(this.drawRing.bind(this), -1,
        16, easeInSin,
        16, easeOutSin)
    );
    this.timeline.add(0, new RandomTimer(16, 48,
      () => this.onFireThruster(), true)
    );
  }

  drawThruster(orientation, thrustPoint, radius, opacity) {
    let dots = drawRing(orientation.get(), thrustPoint, radius.get(),
      (v, t) => new THREE.Color(0xffffff).multiplyScalar(opacity));
    plotDots(this.pixels, this.filters, dots, 0, opacity * this.alpha);
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
    let dots = drawFn(this.orientation.get(), this.ring, this.radius.get(),
      this.ringFn.bind(this),
      (v, t) => {
        let z = this.orientation.orient(Daydream.X_AXIS);
        return this.palette.get(angleBetween(z, v) / Math.PI);
      }
    );
    plotDots(this.pixels, this.filters, dots, 0, this.alpha * opacity);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    this.t++;
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////////
// Experimental Effects Below!
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
      this.pos = randomVector();
      this.vel = new THREE.Vector3(0, 0, 0);
    }
  }

  constructor() {
    this.pixels = new Map();
    this.timeline = new Timeline();

    // --- Configuration ---
    this.NUM_PARTICLES = 250;      // Total number of particles (Was 1000)
    this.NOISE_SCALE = 1.5;
    this.TIME_SCALE = 0.01;
    this.FORCE_SCALE = 0.002;
    this.GRAVITY = 0.001;
    this.MAX_SPEED = 0.05;
    this.TRAIL_LENGTH = 12; // Length of the trail (Was 8)

    // --- Palette ---
    this.palette = new GenerativePalette("straight", "analogous", "ascending");

    // --- State ---
    this.particles = [];
    this.noise = new FastNoiseLite();
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.OpenSimplex2);
    this.t = 0;

    // --- Filters ---
    this.trails = new DecayBuffer(this.TRAIL_LENGTH);
    this.filters = createRenderPipeline(
      new FilterAntiAlias()
    );

    // --- Initialize Particles ---
    for (let i = 0; i < this.NUM_PARTICLES; i++) {
      this.particles.push(new FlowField.Particle());
    }

    // --- Animation: Periodically change the palette ---
    this.timeline.add(0,
      new PeriodicTimer(200, () => {
        this.updatePalette();
      }, true)
    );
  }

  updatePalette() {
    this.nextPalette = new GenerativePalette("straight", "analogous", "ascending");
    this.timeline.add(0,
      new ColorWipe(this.palette, this.nextPalette, 48, easeMid)
    );
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    this.t += this.TIME_SCALE;

    const dots = [];

    for (const p of this.particles) {
      // 1. Calculate Noise Force (Flow Field)
      // We sample 4D noise using the particle's 3D position and time.
      // We need 3 components for the force vector.
      const fx = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
      const fy = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE + 100, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
      const fz = this.noise.GetNoise(p.pos.x * this.NOISE_SCALE + 200, p.pos.y * this.NOISE_SCALE, p.pos.z * this.NOISE_SCALE + this.t) * this.FORCE_SCALE;
      const force = new THREE.Vector3(fx, fy, fz);

      // 2. Apply Gravity (Keep on Sphere)
      // Pull towards the center to counteract the noise pushing it off.
      const gravity = p.pos.clone().multiplyScalar(-this.GRAVITY);
      force.add(gravity);

      // 3. Update Velocity
      p.vel.add(force);
      p.vel.clampLength(0, this.MAX_SPEED); // Limit speed

      // 4. Update Position
      p.pos.add(p.vel);
      p.pos.normalize(); // Snap back to sphere surface exactly

      // 5. Create Dot for Rendering
      // Color based on velocity direction or position? Let's use position for a nice gradient.
      // We can map the position to a 0-1 value for the palette.
      // Let's use the Y coordinate (poles) for variation.
      const paletteT = (p.pos.y + 1) / 2;
      dots.push(new Dot(p.pos.clone(), this.palette.get(paletteT)));
    }

    // 6. Render with Trails
    this.trails.recordDots(dots, 0, 0.8); // 0.8 opacity
    this.trails.render(this.pixels, this.filters, (v, t) => this.palette.get(t)); // Color decay

    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class MobiusGrid {
  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.alpha = 0.2;
    this.numRings = new MutableNumber(0);
    this.numLines = new MutableNumber(0);
    this.palette = new GenerativePalette("circular", "split-complementary", "flat");
    this.orientation = new Orientation();
    this.timeline = new Timeline();
    this.holeN = new FilterHole(new THREE.Vector3(0, 0, 1), 1.2);
    this.holeS = new FilterHole(new THREE.Vector3(0, 0, -1), 1.2);
    this.filters = createRenderPipeline(
      this.holeN,
      this.holeS,
      new FilterOrient(this.orientation),
      new FilterAntiAlias()
    );
    this.params = new MobiusParams(1, 0, 0, 0, 0, 0, 1, 0);

    this.timeline.add(0, new MobiusWarp(this.params, this.numRings, 160, true));
    this.timeline.add(0, new Rotation(this.orientation, Daydream.Y_AXIS, 2 * Math.PI, 400, easeMid, true));
    this.timeline.add(0, new PeriodicTimer(120, () => this.wipePalette(), true));
    this.timeline.add(0,
      new Mutation(this.numRings, (t) => sinWave(12, 1, 1, 0)(t), 320, easeMid, true)
    )
    this.timeline.add(160,
      new Mutation(this.numLines, (t) => sinWave(12, 1, 1, 0)(t), 320, easeMid, true)
    )

    this.setupGui();
  }

  setupGui() {
    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
    const folder = this.gui.addFolder('Mobius Params');
    folder.add(this.params.aRe, 'n').name('aRe').min(-2).max(2).step(0.01).listen();
    folder.add(this.params.aIm, 'n').name('aIm').min(-2).max(2).step(0.01).listen();
    folder.add(this.params.bRe, 'n').name('bRe').min(-2).max(2).step(0.01).listen();
    folder.add(this.params.bIm, 'n').name('bIm').min(-2).max(2).step(0.01).listen();
    folder.add(this.params.cRe, 'n').name('cRe').min(-2).max(2).step(0.01).listen();
    folder.add(this.params.cIm, 'n').name('cIm').min(-2).max(2).step(0.01).listen();
    folder.add(this.params.dRe, 'n').name('dRe').min(-2).max(2).step(0.01).listen();
    folder.add(this.params.dIm, 'n').name('dIm').min(-2).max(2).step(0.01).listen();
  }

  wipePalette() {
    this.nextPalette = new GenerativePalette("circular", "split-complementary", "flat");
    this.timeline.add(0, new ColorWipe(this.palette, this.nextPalette, 60, easeMid));
  }

  drawAxisRings(normal, numRings, mobiusParams, axisComponent, phase = 0) {
    let dots = [];
    const logMin = -2.5;
    const logMax = 2.5;
    const range = logMax - logMin;
    const count = Math.ceil(numRings);
    for (let i = 0; i < count; i++) {
      let t = wrap(i / numRings + phase, 1.0);
      const logR = logMin + t * range;
      const R = Math.exp(logR);
      const radius = (4 / Math.PI) * Math.atan(1 / R);
      const points = sampleRing(new THREE.Quaternion(), normal, radius);
      const transformedPoints = points.map(p => {
        const z = stereo(p);
        const w = mobius(z, mobiusParams);
        return invStereo(w);
      });

      const opacity = Math.min(1.0, Math.max(0.0, numRings - i));
      dots.push(...rasterize(transformedPoints, (p) => this.palette.get(i / numRings).multiplyScalar(opacity), true));
    }
    return dots;
  }

  drawLongitudes(numLines, mobiusParams, axisComponent, phase = 0) {
    let dots = [];
    const count = Math.ceil(numLines);

    for (let i = 0; i < count; i++) {
      const theta = (i / numLines) * Math.PI;
      const normal = new THREE.Vector3(Math.cos(theta), Math.sin(theta), 0);
      const radius = 1.0;
      const points = sampleRing(new THREE.Quaternion(), normal, radius);

      const transformedPoints = points.map(p => {
        const z = stereo(p);
        const w = mobius(z, mobiusParams);
        return invStereo(w);
      });

      const opacity = Math.min(1.0, Math.max(0.0, numLines - i));
      dots.push(...rasterize(transformedPoints, (p, tLine) => {
        // Interpolate unwarped points to get Z
        const idx = tLine * points.length;
        const i1 = Math.floor(idx) % points.length;
        const i2 = (i1 + 1) % points.length;
        const f = idx - Math.floor(idx);
        const z = points[i1].z * (1 - f) + points[i2].z * f;
        const R = Math.sqrt((1 + z) / (1 - z));
        const logR = Math.log(R);
        const logMin = -2.5;
        const logMax = 2.5;
        const range = logMax - logMin;
        const t = (logR - logMin) / range;

        return this.palette.get(wrap(t - phase, 1.0)).multiplyScalar(opacity);
      }, true));
    }
    return dots;
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    const phase = ((this.timeline.t || 0) % 120) / 120;
    let dots = [];

    dots.push(...this.drawAxisRings(Daydream.Z_AXIS.clone(), this.numRings.get(), this.params, 'y', phase));
    dots.push(...this.drawLongitudes(this.numLines.get(), this.params, 'x', phase));

    // Calculate stabilizing counter-rotation
    const nIn = Daydream.Z_AXIS.clone();
    const nTrans = invStereo(mobius(stereo(nIn), this.params));
    const sIn = Daydream.Z_AXIS.clone().negate();
    const sTrans = invStereo(mobius(stereo(sIn), this.params));
    const mid = new THREE.Vector3().addVectors(nTrans, sTrans).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(mid, Daydream.Z_AXIS);

    // Apply counter-rotation to dots and holes
    dots.forEach(d => d.position.applyQuaternion(q));
    this.holeN.origin.copy(nTrans).applyQuaternion(q);
    this.holeS.origin.copy(sTrans).applyQuaternion(q);

    plotDots(this.pixels, this.filters, dots, 0, this.alpha);
    return this.pixels;
  }
}

///////////////////////////////////////////////////////////////////////////////

export class Moire {
  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.alpha = 0.2;
    this.basePalette = new GenerativePalette("circular", "split-complementary", "bell");
    this.interferencePalette = new GenerativePalette("circular", "split-complementary", "cup");

    this.density = new MutableNumber(10);
    this.scale = new MutableNumber(1.0);
    this.rotation = new MutableNumber(0);
    this.amp = new MutableNumber(0);
    this.orientation = new Orientation();
    this.timeline = new Timeline();

    this.filters = createRenderPipeline(
      new FilterOrient(this.orientation),
      new FilterAntiAlias()
    );

    this.timeline
      .add(0, new PeriodicTimer(80, () => this.colorWipe()))
      //      .add(0, new RandomTimer(48, 48, () => this.deRes(), false))
      .add(0, new Rotation(this.orientation, Daydream.Y_AXIS, 2 * Math.PI, 300, easeMid, true))
      .add(0,
        new Transition(this.rotation, 2 * Math.PI, 160, easeMid, false, true)
          .then(() => this.rotation.set(0)))
      .add(0,
        new Mutation(this.amp, sinWave(0.1, 0.5, 1, 0), 160, easeMid, true));
    this.setupGui();
  }

  setupGui() {
    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
    this.gui.add(this.density, 'n', 5, 50).name('density').listen();
    this.gui.add(this.amp, 'n', -1, 1).name('amplitude').step(0.01).listen();
    this.gui.add(this.scale, 'n', 0.8, 1.2).name('scale');
    this.gui.add(this.rotation, 'n', 0, Math.PI).name('rotation');
  }

  colorWipe() {
    this.nextBasePalette = new GenerativePalette("straight", "triadic", "ascending");
    this.nextInterferencePalette = new GenerativePalette("straight", "triadic", "ascending");
    this.timeline.add(0,
      new ColorWipe(this.basePalette, this.nextBasePalette, 80, easeMid)
    );
    this.timeline.add(0,
      new ColorWipe(this.interferencePalette, this.nextInterferencePalette, 80, easeMid)
    );
  }

  deRes() {
    this.timeline.add(0,
      new Transition(this.density, 5, 6, easeMid, true, false)
        .then(() => this.timeline.add(0, new RandomTimer(48, 48, () => this.res(), false)))
    );
  }

  res() {
    this.timeline.add(0,
      new Transition(this.density, 11, 6, easeMid, true, false)
        .then(() => this.timeline.add(0, new RandomTimer(48, 48, () => this.deRes(), false)))
    );
  }

  drawLayer(transform, palette) {
    let dots = [];
    const count = Math.ceil(this.density.get());
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      const r = t * 2.0;
      const normal = Daydream.Z_AXIS;
      const points = sampleFn(new THREE.Quaternion(), normal, r, sinWave(-this.amp.get(), this.amp.get(), 4, 0));
      const transformedPoints = points.map(p => transform(p));
      dots.push(...rasterize(transformedPoints, (p) => palette.get(t), true));
    }
    return dots;
  }

  rotate(p, axis) {
    let q = new THREE.Quaternion().setFromAxisAngle(axis, this.rotation.get());
    return p.applyQuaternion(q);
  }

  transform(p) {
    p = this.rotate(p, Daydream.Z_AXIS);
    p = this.rotate(p, Daydream.X_AXIS);
    return p;
  }

  invTransform(p) {
    p = this.rotate(p, Daydream.X_AXIS.clone().negate());
    p = this.rotate(p, Daydream.Z_AXIS.clone().negate());
    return p;
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();

    let dots = [];
    dots.push(...this.drawLayer((p) => this.invTransform(p), this.basePalette)); // Base layer
    dots.push(...this.drawLayer((p) => this.transform(p), this.interferencePalette));  // Interference layer

    plotDots(this.pixels, this.filters, dots, 0, this.alpha);
    return this.pixels;
  }
}

export class Portholes {
  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.alpha = 0.3; // Default alpha

    this.basePalette = new GenerativePalette("circular", "analogous", "bell", "vibrant");
    this.interferencePalette = new GenerativePalette("circular", "analogous", "cup", "vibrant");

    this.orientations = [];
    const numSlices = 2;
    for (let i = 0; i < numSlices; i++) {
      this.orientations.push(new Orientation());
    }
    this.hemisphereAxis = new THREE.Vector3(0, 1, 0);
    this.timeline = new Timeline();

    // Parameters
    this.numPoints = new MutableNumber(20);
    this.circleRadius = new MutableNumber(0.27);
    this.offsetRadius = new MutableNumber(5 / Daydream.W);
    this.offsetSpeed = new MutableNumber(2.0);
    this.t = 0;

    this.filters = createRenderPipeline(
      new FilterOrientSlice(this.orientations, this.hemisphereAxis),
      new FilterAntiAlias()
    );

    // Animations
    this.timeline.add(0, new PeriodicTimer(48, () => this.colorWipe()));
    this.timeline.add(0, new PeriodicTimer(160, () => this.spinSlices(), true));

    this.setupGui();
  }

  setupGui() {
    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha').min(0).max(1).step(0.01);
    this.gui.add(this.numPoints, 'n', 10, 200).name('Num Points').step(1).listen();
    this.gui.add(this.circleRadius, 'n', 0.005, 0.5).name('Circle Radius').listen();
    this.gui.add(this.offsetRadius, 'n', 0.0, 0.2).name('Offset Radius').listen();
    this.gui.add(this.offsetSpeed, 'n', 0.0, 5.0).name('Offset Speed').listen();
  }

  colorWipe() {
    this.nextBasePalette = new GenerativePalette("straight", "triadic", "ascending");
    this.nextInterferencePalette = new GenerativePalette("straight", "triadic", "ascending");
    this.timeline.add(0,
      new ColorWipe(this.basePalette, this.nextBasePalette, 80, easeMid)
    );
    this.timeline.add(0,
      new ColorWipe(this.interferencePalette, this.nextInterferencePalette, 80, easeMid)
    );
  }

  drawLayer(isInterference) {
    let dots = [];
    const n = Math.floor(this.numPoints.get());

    // Generate Fibonacci points
    for (let i = 0; i < n; i++) {
      let p = fibSpiral(n, 0.3, i);

      if (isInterference) {
        // Create basis for tangent plane
        const axis = (Math.abs(p.y) > 0.99) ? Daydream.X_AXIS : Daydream.Y_AXIS;
        let u = new THREE.Vector3().crossVectors(p, axis).normalize();
        let v = new THREE.Vector3().crossVectors(p, u).normalize();

        // Time based offset in tangent plane
        const phase = i * 0.1;
        const angle = this.t * this.offsetSpeed.get() * 2 * Math.PI + phase;
        const r = this.offsetRadius.get();

        // Calculate offset vector
        const offset = u.clone().multiplyScalar(Math.cos(angle)).add(v.clone().multiplyScalar(Math.sin(angle))).multiplyScalar(r);

        // Apply offset to normal (approximate, spherical surface constraint handled by normalization)
        p.add(offset).normalize();
      }

      // Draw ring
      let ring = drawRing(new THREE.Quaternion(), p, this.circleRadius.get(), (v, t) => {
        const palette = isInterference ? this.interferencePalette : this.basePalette;
        return palette.get(t);
      });
      dots.push(...ring);
    }
    return dots;
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    this.t += 0.01; // Global time

    let dots = [];
    dots.push(...this.drawLayer(true));  // Interference
    dots.push(...this.drawLayer(false)); // Base

    plotDots(this.pixels, this.filters, dots, 0, this.alpha);
    return this.pixels;
  }

  spinSlices() {
    let axis = randomVector();
    this.hemisphereAxis.copy(axis);

    // Spin alternating directions over 5 seconds (80 frames)
    for (let i = 0; i < this.orientations.length; i++) {
      const direction = (i % 2 === 0) ? 1 : -1;
      this.timeline.add(0, new Rotation(this.orientations[i], axis, direction * 2 * Math.PI, 80, easeInOutSin, false));
    }
  }
}

///////////////////////////////////////////////////////////////////////////////

const PHI = (1 + Math.sqrt(5)) / 2;

export class Reaction extends Sprite {
  constructor(rd, duration = 192, fadeOut = 32, fadeIn = 32) {
    // 16 FPS. 10s exist + 2s fade = 12s total (192 frames).
    super((alpha) => this.render(alpha), duration, fadeIn, easeMid, fadeOut, easeMid);

    this.rd = rd;
    this.N = rd.N;

    // RD State
    this.A = new Float32Array(this.N).fill(1.0);
    this.B = new Float32Array(this.N).fill(0.0);
    this.nextA = new Float32Array(this.N);
    this.nextB = new Float32Array(this.N);

    // Params (Brain Coral)
    this.feed = 0.0545;
    this.k = 0.062;
    // Fibonacci Mode diffusion
    this.dA = 0.15;
    this.dB = 0.075;
    this.dt = 1.0;

    // Palette (Instantiate new one)
    this.palette = new GenerativePalette("straight", "split-complementary", "ascending", "vibrant");
  }

  seed() {
    // Seed random spots
    for (let i = 0; i < 5; i++) {
      let idx = Math.floor(Math.random() * this.N);
      let nbs = this.rd.neighbors[idx];
      this.B[idx] = 1.0;
      for (let j of nbs) { // Check if nbs is iterable (it is array of indices)
        this.B[j] = 1.0;
      }
    }
  }

  render(currentAlpha) {
    // 1. Simulate (12 steps per frame)
    for (let k = 0; k < 12; k++) {
      this.updatePhysics();
    }

    // 2. Draw
    for (let i = 0; i < this.N; i++) {
      let b = this.B[i];
      if (b > 0.1) {
        let t = Math.max(0, Math.min(1, (b - 0.15) * 4.0));
        let c = this.palette.get(t);
        this.rd.filters.plot(this.rd.pixels, this.rd.nodes[i], c, 0, currentAlpha * this.rd.alpha);
      }
    }
  }

  updatePhysics() {
    // Brain Coral Regime (Phase Eta)
    // Gray-Scott on Graph

    let nodes = this.rd.nodes;
    let neighbors = this.rd.neighbors;
    let weights = this.rd.weights;
    let scales = this.rd.scales;

    for (let i = 0; i < this.N; i++) {
      let a = this.A[i];
      let b = this.B[i];

      let lapA = 0;
      let lapB = 0;
      let nbs = neighbors[i];
      let ws = weights[i];
      let degree = nbs.length;

      for (let k = 0; k < degree; k++) {
        let j = nbs[k];
        let w = ws[k];
        lapA += (this.A[j] - a) * w;
        lapB += (this.B[j] - b) * w;
      }

      // Apply Physical Scale Correction
      let s = scales[i];
      lapA *= s;
      lapB *= s;

      // Reaction
      let reaction = a * b * b;
      let feed = this.feed * (1 - a);
      let kill = (this.k + this.feed) * b;

      this.nextA[i] = a + (this.dA * lapA - reaction + feed) * this.dt;
      this.nextB[i] = b + (this.dB * lapB + reaction - kill) * this.dt;

      // Clamp
      this.nextA[i] = Math.max(0, Math.min(1, this.nextA[i]));
      this.nextB[i] = Math.max(0, Math.min(1, this.nextB[i]));
    }

    // Swap
    let tempA = this.A; this.A = this.nextA; this.nextA = tempA;
    let tempB = this.B; this.B = this.nextB; this.nextB = tempB;
  }
}

export class GSReactionDiffusion {
  constructor() {
    this.pixels = new Map();
    this.alpha = 0.3;

    // Graph Parameters
    this.N = 4096;
    this.nodes = [];
    this.neighbors = [];
    this.weights = [];
    this.scales = [];

    // Build Graph (Fibonacci Hex)
    this.buildGraph();

    // Visualization
    this.orientation = new Orientation();
    this.filters = createRenderPipeline(
      new FilterOrient(this.orientation),
      new FilterAntiAlias()
    );

    this.timeline = new Timeline();
    this.timeline.add(0,
      new Rotation(this.orientation, Daydream.Y_AXIS, Math.PI / 2, 200, easeInOutSin, true)
    );
    this.spawn();
    this.timeline.add(0, new PeriodicTimer(96, () => this.spawn(), true));

    this.setupGui();
  }

  spawn() {
    // Create new reaction
    // 10s alive + 2s fade = 12s = 192 frames.
    // Fadeout 2s = 32 frames.
    let r = new Reaction(this, 192, 32);
    r.seed();
    this.timeline.add(0, r);
  }

  setupGui() {
    if (this.gui) this.gui.destroy();
    this.gui = new gui.GUI();
    this.gui.add(this, 'alpha', 0, 1).step(0.01).name('Alpha');
  }

  // Graph Build Logic
  buildGraph() {
    // Fibonacci Sphere (Uniform Isotropy)

    this.N = 4096; // Adjust for density

    this.nodes = [];
    this.neighbors = [];
    this.weights = [];
    this.scales = [];

    // 1. Generate Nodes (Fibonacci Spiral)
    const phi = Math.PI * (3 - Math.sqrt(5)); // Golden Angle

    for (let i = 0; i < this.N; i++) {
      let y = 1 - (i / (this.N - 1)) * 2; // y goes from 1 to -1
      let radius = Math.sqrt(1 - y * y);
      let theta = phi * i;
      let x = Math.cos(theta) * radius;
      let z = Math.sin(theta) * radius;
      this.nodes.push(new THREE.Vector3(x, y, z));
    }

    // 2. Build K=6 Neighbors (Hexagonal Topology)
    const K = 6;
    for (let i = 0; i < this.N; i++) {
      let p1 = this.nodes[i];
      let bestIndices = [];
      let bestDists = [];

      for (let j = 0; j < this.N; j++) {
        if (i === j) continue;
        let d2 = p1.distanceToSquared(this.nodes[j]);

        let len = bestDists.length;
        if (len < K || d2 < bestDists[len - 1]) {
          let pos = len;
          while (pos > 0 && d2 < bestDists[pos - 1]) { pos--; }
          bestDists.splice(pos, 0, d2);
          bestIndices.splice(pos, 0, j);
          if (bestDists.length > K) { bestDists.pop(); bestIndices.pop(); }
        }
      }
      this.neighbors.push(bestIndices);
      this.weights.push(new Array(K).fill(1.0));
      this.scales.push(1.0);
    }
    console.log("Graph built (Fibonacci Hex Sphere). Nodes:", this.N);
  }

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();
    return this.pixels;
  }
}

export class BZReaction extends Reaction {
  constructor(rd, duration = 192, fadeOut = 32) {
    super(rd, duration, fadeOut);

    // 3rd Chemical Species
    this.C = new Float32Array(this.N).fill(0.0);
    this.nextC = new Float32Array(this.N);

    // Params for Cyclic Competition
    // A eats B, B eats C, C eats A
    this.alpha = 1.2; // Predation rate
    this.beta = 0.1;  // Decay rate
    this.D = 0.08;    // Diffusion

    this.seed();

    this.palette = new GenerativePalette('straight', 'triadic', 'descending', 'vibrant');
  }

  seed() {
    // Sparse Seeding for Spirals (Droplets)
    this.A.fill(0.0);
    this.B.fill(0.0);
    this.C.fill(0.0);

    // Seed random droplets
    for (let k = 0; k < 50; k++) {
      let center = Math.floor(Math.random() * this.N);
      let r = Math.random();
      // Set a small neighborhood
      let nbs = this.rd.neighbors[center];

      let target = (r < 0.33) ? this.A : (r < 0.66) ? this.B : this.C;
      target[center] = 1.0;
      for (let j of nbs) target[j] = 1.0;
    }
  }

  updatePhysics() {
    // 3-Species Cyclic Model (Rock-Paper-Scissors)

    let nodes = this.rd.nodes;
    let neighbors = this.rd.neighbors;
    let weights = this.rd.weights;

    // Use parameters from BZReactionDiffusion GUI if available
    let dt = this.rd.bzParams ? this.rd.bzParams.dt : 0.2;
    let D = this.rd.bzParams ? this.rd.bzParams.D : 0.03;
    this.alpha = this.rd.bzParams ? this.rd.bzParams.alpha : 1.6;

    for (let i = 0; i < this.N; i++) {
      let a = this.A[i];
      let b = this.B[i];
      let c = this.C[i];

      let lapA = 0, lapB = 0, lapC = 0;
      let nbs = neighbors[i];
      let degree = nbs.length;

      for (let k = 0; k < degree; k++) {
        let j = nbs[k];
        lapA += (this.A[j] - a);
        lapB += (this.B[j] - b);
        lapC += (this.C[j] - c);
      }

      let da = a * (1 - a - this.alpha * c);
      let db = b * (1 - b - this.alpha * a);
      let dc = c * (1 - c - this.alpha * b);

      this.nextA[i] = a + (D * lapA + da) * dt;
      this.nextB[i] = b + (D * lapB + db) * dt;
      this.nextC[i] = c + (D * lapC + dc) * dt;

      // Clamp
      this.nextA[i] = Math.max(0, Math.min(1, this.nextA[i]));
      this.nextB[i] = Math.max(0, Math.min(1, this.nextB[i]));
      this.nextC[i] = Math.max(0, Math.min(1, this.nextC[i]));
    }

    // Swap
    let temp;
    temp = this.A; this.A = this.nextA; this.nextA = temp;
    temp = this.B; this.B = this.nextB; this.nextB = temp;
    temp = this.C; this.C = this.nextC; this.nextC = temp;
  }

  render(currentAlpha) {
    let ca = this.palette.get(0);
    let cb = this.palette.get(0.5);
    let cc = this.palette.get(1);

    // 1. Simulate
    for (let k = 0; k < 2; k++) {
      this.updatePhysics();
    }

    // 2. Draw
    let color = new THREE.Color();
    let hsl = { h: 0, s: 0, l: 0 };

    for (let i = 0; i < this.N; i++) {
      let a = this.A[i];
      let b = this.B[i];
      let c = this.C[i];
      let sum = a + b + c;
      if (sum > 0.01) {
        // Alpha Blending (Layered: A first, then B, then C)
        color.setRGB(0, 0, 0);
        color.lerp(ca, a);
        color.lerp(cb, b);
        color.lerp(cc, c);
        hsl = color.getHSL(hsl);
        color.setHSL(hsl.h, 1.0, hsl.l);

        this.rd.filters.plot(this.rd.pixels, this.rd.nodes[i], color, 0, currentAlpha * this.rd.alpha);
      }
    }
  }
}

export class BZReactionDiffusion extends GSReactionDiffusion {
  constructor() {
    super();
    this.bzParams = {
      alpha: 1.6,
      D: 0.03,
      dt: 0.2
    };
    this.initBZGui();
  }

  initBZGui() {
    // Add folder to the existing GUI created by super()
    if (this.gui) {
      const folder = this.gui.addFolder('BZ Parameters');
      folder.add(this.bzParams, 'alpha', 0.5, 2.0).name('Predation (α)');
      folder.add(this.bzParams, 'D', 0.001, 0.1).name('Diffusion');
      folder.add(this.bzParams, 'dt', 0.01, 0.5).name('Time Step');
      folder.open();
    }
  }

  spawn() {
    let r = new BZReaction(this, 192, 32);
    this.timeline.add(0, r);
  }
}
