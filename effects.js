import * as THREE from "three";
import { gui } from "gui";
import { Daydream, labels, pixelKey } from "./driver.js";
import FastNoiseLite from "./FastNoiseLite.js";
import { stereo, invStereo, mobius } from "./3dmath.js";

import {
  Orientation, Dodecahedron, angleBetween, pixelToVector,
  distanceGradient, isOver, bisect, lissajous,
  fibSpiral, randomVector, Dot, sinWave, lerp, squareWave,
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
  easeInCirc, easeOutCirc, PeriodicTimer, ColorWipe
} from "./animation.js";

import {
  createRenderPipeline, FilterAntiAlias, FilterReplicate,
  FilterOrient, FilterChromaticShift, FilterDecay, FilterMobius
} from "./filters.js";

import { dir, wrap, shortest_distance, randomChoice, randomBetween } from "./util.js";

///////////////////////////////////////////////////////////////////////////////

export class Test {

  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.alpha = 0.3;
    this.ringPalette = new GenerativePalette("circular", "analagous", "flat");
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
        sinWave(-this.amplitudeRange, this.amplitudeRange, 2, 0), 64, easeMid, true)
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
    this.palette = new GenerativePalette("straight", "analogous", "ascending");
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
    this.timeline.add(0, new RandomTimer(8, 48,
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
    this.alpha = 0.5;
    this.palette = new GenerativePalette("circular", "analagous", "flat");
    this.orientation = new Orientation();
    this.timeline = new Timeline();
    this.filters = createRenderPipeline(
      new FilterAntiAlias()
    );

    this.mobiusParam = new MutableNumber(0);
    this.rotation = new MutableNumber(0);

    this.timeline.add(0,
      new Transition(this.mobiusParam, 1.5, 128, easeInOutSin)
    );
    this.timeline.add(0,
      new Transition(this.rotation, 2 * Math.PI, 256, (t) => t)
    );

    // Mobius Parameters
    this.params = {
      aRe: new MutableNumber(1), aIm: new MutableNumber(0),
      bRe: new MutableNumber(0), bIm: new MutableNumber(0),
      cRe: new MutableNumber(0), cIm: new MutableNumber(0),
      dRe: new MutableNumber(1), dIm: new MutableNumber(0)
    };

    this.setupGui();

    this.timeline.add(0,
      new Mutation(this.params.bIm, (t) => sinWave(-1, 1, 1, 0)(t), 64, easeMid, true)
    );
    this.timeline.add(0,
      new Mutation(this.params.cRe, (t) => sinWave(-1, 1, 1, 0)(t + 0.1), 64, easeMid, true)
    );
    this.timeline.add(0,
      new Mutation(this.params.aRe, (t) => sinWave(-1, 1, 1, 0)(t + 0.3), 64, easeMid, true)
    );
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

  drawFrame() {
    this.pixels.clear();
    this.timeline.step();

    const rot = this.rotation.get();
    let a, b, c, d;
    a = { re: this.params.aRe.get(), im: this.params.aIm.get() };
    b = { re: this.params.bRe.get(), im: this.params.bIm.get() };
    c = { re: this.params.cRe.get(), im: this.params.cIm.get() };
    d = { re: this.params.dRe.get(), im: this.params.dIm.get() };

    // Generate Geometry (Grid of rings)
    const numRings = 2;
    let dots = [];

    // Axis 1 Rings (Latitudes around Y)
    // We iterate radius from >0 to <2 to avoid the poles singularities and redundant checks
    // Using sampleRing which handles 0..2 mapping (0=North, 1=Equator, 2=South)
    for (let i = 1; i < numRings; i++) {
      const t = i / numRings; // 0..1
      const radius = t * 2; // 0..2

      // Axis Z
      const normalZ = Daydream.Z_AXIS.clone();
      const pointsZ = sampleRing(this.orientation.get(), normalZ, radius);

      const transformedPointsZ = pointsZ.map(p => {
        const z = stereo(p);
        const w = mobius(z, a, b, c, d);
        return invStereo(w);
      });
      dots.push(...rasterize(transformedPointsZ, (p) => this.palette.get(0.5 + 0.5 * p.z), true));


      // Axis Y
      const normalY = Daydream.Y_AXIS.clone();
      const pointsY = sampleRing(this.orientation.get(), normalY, radius);

      const transformedPointsY = pointsY.map(p => {
        const z = stereo(p);
        const w = mobius(z, a, b, c, d);
        return invStereo(w);
      });
      dots.push(...rasterize(transformedPointsY, (p) => this.palette.get(0.5 + 0.5 * p.y), true));

      // Axis X ("Longitudes" but parallel circles like latitudes)
      const normalX = Daydream.X_AXIS.clone();
      const pointsX = sampleRing(this.orientation.get(), normalX, radius);

      const transformedPointsX = pointsX.map(p => {
        const z = stereo(p);
        const w = mobius(z, a, b, c, d);
        return invStereo(w);
      });
      dots.push(...rasterize(transformedPointsX, (p) => this.palette.get(0.5 + 0.5 * p.x), true));
    }

    plotDots(this.pixels, this.filters, dots, 0, 1.0);
    return this.pixels;
  }
}
