/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween, Orientation, MeshOps } from "./geometry.js";
import { vectorPool, quaternionPool } from "./memory.js";
import { Solids } from "./solids.js";
import FastNoiseLite from "./FastNoiseLite.js";
import { TWO_PI } from "./3dmath.js";
import { easeOutElastic, easeInOutSin, easeInSin, easeOutSin, easeOutExpo, easeOutCirc, easeInCubic, easeInCirc, easeMid, easeOutCubic } from "./easing.js";

// Easing functions moved to easing.js

/**
 * Manages animations on a timeline.
 */
export class Timeline {
  constructor() {
    this.t = 0;
    this.animations = [];
  }

  /**
   * Add animation.
   * @param {number} inFrames - Delay.
   * @param {Animation} animation - Animation.
   * @returns {Timeline} Self.
   */
  add(inFrames, animation) {
    let start = this.t + inFrames;
    for (let i = 0; i < this.animations.length; ++i) {
      if (this.animations[i].start > start) {
        this.animations.splice(i, 0, { start: start, animation: animation });
        return this;
      }
    }
    this.animations.push({ start: start, animation: animation });
    return this;
  }

  /**
   * Advances the timeline by one frame.
   */
  step() {
    ++this.t;

    // Prep
    const touchedOrientations = new Set();
    for (const item of this.animations) {
      if (this.t >= item.start && !item.animation.canceled) {
        const anim = item.animation;
        if (anim.orientation && !touchedOrientations.has(anim.orientation)) {
          anim.orientation.collapse();
          touchedOrientations.add(anim.orientation);
        }
      }
    }

    // Step
    for (let i = 0; i < this.animations.length; i++) {
      let animation = this.animations[i].animation;
      if (this.t >= this.animations[i].start) {
        animation.step();
        if (animation.done()) {
          if (animation.repeat) {
            animation.rewind();
            animation.post();
            continue;
          }
          this.animations.splice(i, 1);
          i--;
          animation.post();
        }
      }
    }
  }
}

/**
 * Animation base class.
 */
export class Animation {
  /**
   * @param {number} duration - Frames.
   * @param {boolean} repeat - Loop.
   */
  constructor(duration, repeat) {
    this.duration = duration == 0 ? 1 : duration;
    this.repeat = repeat;
    this.t = 0;
    this.canceled = false;
    this.post = () => { };
  }

  /**
   * Cancels the animation.
   */
  cancel() { this.canceled = true; }

  /**
   * Checks if the animation is done.
   * @returns {boolean} True if finished or canceled.
   */
  done() { return this.canceled || (this.duration >= 0 && this.t >= this.duration); }

  /**
   * Advances the animation.
   */
  step() { this.t++; }

  /**
   * Resets the animation.
   */
  rewind() { this.t = 0; }

  /**
   * Sets a callback to run after completion.
   * @param {Function} post - Callback function.
   * @returns {Animation} Self.
   */
  then(post) {
    this.post = post;
    return this;
  }

  /**
   * Executes the post-animation callback.
   */
  post() { this.post(); }
}

// North Pole
export const PARTICLE_BASE = new THREE.Vector3(0, 1, 0);

/**
 * Physics particle system.
 */
export class ParticleSystem extends Animation {
  static Particle = class {
    /**
     * @param {THREE.Vector3} position - Position.
     * @param {THREE.Vector3} velocity - Velocity.
     * @param {THREE.Color|Object} color - Color or Palette object.
     * @param {number} life - Frames to live.
     */
    constructor(position, velocity, palette, life) {
      this.position = position.clone();
      this.velocity = velocity.clone();
      this.palette = palette;
      this.life = life;
      this.maxLife = life;
      this.orientation = new Orientation();
    }

    get orientedPosition() {
      return this.orientation.orient(this.position);
    }
  }

  constructor(friction = 0.95, gravityScale = 0.001) {
    super(-1, false);
    this.reset(friction, gravityScale);
    this.interactionRadius = 0.2;
  }

  /**
   * Resets the particle system state.
   * @param {number} [friction] - Friction coefficient.
   * @param {number} [gravityScale] - Gravity scale.
   */
  reset(friction, gravityScale) {
    this.particles = [];
    this.attractors = [];
    if (friction !== undefined) this.friction = friction;
    if (gravityScale !== undefined) this.gravityScale = gravityScale;
  }

  /**
   * Adds an attractor.
   * @param {THREE.Vector3} position - Location.
   * @param {number} strength - Attraction strength.
   * @param {number} killRadius - Radius to kill particles.
   */
  addAttractor(position, strength, killRadius) {
    this.attractors.push({ position, strength, killRadius });
  }

  /**
   * Spawns a new particle.
   * @param {THREE.Vector3} position - Position.
   * @param {THREE.Vector3} velocity - Velocity.
   * @param {THREE.Color|Object} color - Color or Palette.
   * @param {number} life - Frames to live.
   */
  spawn(position, velocity, color, life = 600) {
    this.particles.push(new ParticleSystem.Particle(position, velocity, color, life));
  }

  /**
   * Simulates the physics step.
   */
  step() {
    super.step();

    const maxDelta = TWO_PI / Daydream.W;

    // Physics
    const G = this.gravityScale;
    const torque = vectorPool.acquire();
    const axis = vectorPool.acquire();
    const dQ = quaternionPool.acquire();
    const pos = vectorPool.acquire(); // Acquire once for reuse in sub-step loop

    // Attractors (Global Gravity)
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      let dead = false;

      // Age
      p.life--;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }

      // Adaptive sub-stepping
      const speed = p.velocity.length();
      const pos_y = p.orientedPosition.y;
      // Latitude scale: pixels have higher angular density near poles
      const latitudeScale = Math.sqrt(Math.max(0, 1.0 - pos_y * pos_y));
      const adjustedMaxDelta = maxDelta * Math.max(0.001, latitudeScale);
      const substeps = Math.max(1, Math.min(256, Math.ceil(speed / adjustedMaxDelta)));
      const dt = 1.0 / substeps;

      // Reset orientation history for this frame
      p.orientation.collapse();
      const currentQ = quaternionPool.acquire().copy(p.orientation.get(0)); // Working quaternion from pool

      // Sub-step loop
      for (let k = 0; k < substeps; k++) {
        pos.copy(p.position).applyQuaternion(currentQ);

        // Latitude scale for current position
        const latitudeScale = Math.sqrt(Math.max(0, 1.0 - pos.y * pos.y));

        // Apply forces from attractors
        for (const attr of this.attractors) {
          // Distance to attractor
          const distSq = pos.distanceToSquared(attr.position);

          // Kill if too close
          if (distSq < attr.killRadius * attr.killRadius) {
            dead = true;
            break;
          }

          // Apply Force
          if (distSq > 0.000001) {
            const dist = Math.sqrt(distSq);
            const coreRadius = 0.2; // Solid sphere radius

            let forceMag = 0;
            if (dist < coreRadius) {
              // Inside core: Linear drop-off
              forceMag = (G * attr.strength * dist) / (coreRadius * coreRadius * coreRadius);
            } else {
              // Outside core: Inverse Square Law
              forceMag = (G * attr.strength) / distSq;
            }

            forceMag *= dt;

            // Tangential force towards attractor
            torque.crossVectors(pos, attr.position).normalize().multiplyScalar(forceMag);
            const force = torque.cross(pos);
            p.velocity.add(force);
          }
        }

        if (dead) break;

        // Apply Friction (Drag)
        p.velocity.multiplyScalar(Math.pow(this.friction, dt));

        // Move (Rotate)
        const subSpeed = p.velocity.length();
        if (subSpeed > 0.000001) {
          axis.crossVectors(pos, p.velocity).normalize();
          // Angle is already in radians per frame, so we just scale by dt
          const angle = subSpeed * dt;
          dQ.setFromAxisAngle(axis, angle);
          currentQ.premultiply(dQ); // World rotation
          p.orientation.push(quaternionPool.acquire().copy(currentQ));
          p.velocity.applyQuaternion(dQ);
        }

      } // End Substeps

      if (dead) {
        this.particles.splice(i, 1);
      }
    }
  }
}

/**
 * Randomized timer.
 */
export class RandomTimer extends Animation {
  /**
   * @param {number} min - Min delay frames.
   * @param {number} max - Max delay frames.
   * @param {Function} f - Callback.
   * @param {boolean} repeat - Loop.
   */
  constructor(min, max, f, repeat = false) {
    super(-1, repeat);
    this.min = min;
    this.max = max;
    this.f = f;
    this.next = 0;
    this.reset();
  }

  /**
   * Resets the timer.
   * @param {number} t - Unused.
   */
  reset(t) {
    this.next = this.t + Math.round(Math.random() * (this.max - this.min) + this.min);
  }

  /**
   * Checks timer.
   */
  step() {
    super.step();
    if (this.t >= this.next) {
      this.f();
      if (this.repeat) this.reset();
      else this.canceled = true;
    }
  }
}

/**
 * Regular interval timer.
 */
export class PeriodicTimer extends Animation {
  /**
   * @param {number} period - Interval frames.
   * @param {Function} f - Callback.
   * @param {boolean} repeat - Loop.
   */
  constructor(period, f, repeat = false) {
    super(-1, repeat);
    this.period = period;
    this.f = f;
    this.reset();
  }

  /**
   * Resets the timer.
   */
  reset() {
    this.next = this.t + this.period;
  }

  /**
   * Checks timer.
   */
  step() {
    super.step();
    if (this.t >= this.next) {
      this.f();
      if (this.repeat) this.reset();
      else this.cancel();
    }
  }
}

/**
 * Property transition.
 */
export class Transition extends Animation {
  /**
   * @param {Object} target - Object.
   * @param {string} property - Property name.
   * @param {number} to - Target value.
   * @param {number} duration - Frames.
   * @param {Function} easingFn - Easing.
   * @param {boolean} quantized - Int only.
   * @param {boolean} repeat - Loop.
   */
  constructor(target, property, to, duration, easingFn, quantized = false, repeat = false) {
    super(duration, repeat);
    this.target = target;
    this.property = property;
    this.to = to;
    this.duration = duration;
    this.easingFn = easingFn;
    this.quantized = quantized;
  }

  /**
   * Interpolates property.
   */
  step() {
    if (this.t == 0) this.from = this.target[this.property];
    super.step();
    let t = Math.min(1, this.t / (this.duration));
    let n = this.easingFn(t) * (this.to - this.from) + this.from;
    if (this.quantized) n = Math.floor(n);
    this.target[this.property] = n;
  }
}

/**
 * Property mutation.
 */
export class Mutation extends Animation {
  /**
   * @param {Object} target - Object.
   * @param {string} property - Property name.
   * @param {Function} fn - Mutator(easing, val).
   * @param {number} duration - Frames.
   * @param {Function} easingFn - Easing.
   * @param {boolean} repeat - Loop.
   */
  constructor(target, property, fn, duration, easingFn, repeat = false) {
    super(duration, repeat);
    this.target = target;
    this.property = property;
    this.fn = fn;
    this.duration = duration;
    this.easingFn = easingFn;
  }

  /**
   * Mutates property.
   */
  step() {
    if (this.t == 0) this.from = this.target[this.property];
    super.step();
    let t = Math.min(1, this.t / this.duration);
    this.target[this.property] = this.fn(this.easingFn(t), this.target[this.property]);
  }
}

/**
 * Fade-in/out sprite animation.
 */
export class Sprite extends Animation {
  /**
   * @param {Function} drawFn - Draw callback(opacity).
   * @param {number} duration - Total frames.
   * @param {number} fadeInDuration - Fade in frames.
   * @param {Function} fadeInEasingFn - Fade in easing.
   * @param {number} fadeOutDuration - Fade out frames.
   * @param {Function} fadeOutEasingFn - Fade out easing.
   */
  constructor(drawFn, duration,
    fadeInDuration = 0, fadeInEasingFn = easeMid,
    fadeOutDuration = 0, fadeOutEasingFn = easeMid) {
    super(duration, false);
    this.drawFn = drawFn;
    this.opacity = fadeInDuration > 0 ? 0 : 1;
    this.fadeInDuration = fadeInDuration;
    this.fadeOutDuration = fadeOutDuration;
    this.fadeIn = new Transition(this, 'opacity', 1, fadeInDuration, fadeInEasingFn);
    this.fadeOut = new Transition(this, 'opacity', 0, fadeOutDuration, fadeOutEasingFn);
  }

  /**
   * Manages fading and drawing.
   */
  step() {
    if (this.t == 0) {
      this.fadeIn.rewind();
      this.fadeOut.rewind();
    }
    super.step();
    if (!this.fadeIn.done()) {
      this.fadeIn.step();
    } else if (this.duration >= 0 && this.t >= (this.duration - this.fadeOutDuration)) {
      this.fadeOut.step();
    }
    this.drawFn(this.opacity);
  }
}

/**
 * Orientation path animation.
 */
export class Motion extends Animation {
  static get MAX_ANGLE() { return TWO_PI / Daydream.W; }

  /**
   * Static helper to create and run path animation.
   * @param {Orientation} orientation - Object.
   * @param {THREE.CurvePath} path - Path.
   */
  static animate(orientation, path) {
    let m = new Motion(orientation, path, 1, false, 1);
    m.step();
  }

  /**
   * @param {Orientation} orientation - Object to animate.
   * @param {THREE.CurvePath} path - 3D path.
   * @param {number} duration - Frames.
   * @param {boolean} repeat - Loop.
   * @param {string} space - "World" or "Local".
   */
  constructor(orientation, path, duration, repeat = false, space = "World") {
    super(duration, repeat);
    this.orientation = orientation;
    this.path = path;
    this.space = space;
  }

  /**
   * Advances motion.
   */
  step() {
    super.step();
    let currentV = this.path.getPoint((this.t - 1) / this.duration);
    const targetV = this.path.getPoint(this.t / this.duration);
    const totalAngle = angleBetween(currentV, targetV);
    const numSteps = Math.ceil(Math.max(1, totalAngle / Motion.MAX_ANGLE));

    // Upsample
    this.orientation.upsample(numSteps + 1);
    const len = this.orientation.length();

    let prevV = currentV.clone();
    const accumulatedQ = quaternionPool.acquire();
    accumulatedQ.set(0, 0, 0, 1);

    const applyRotation = (this.space === "Local")
      ? (target, source) => target.multiply(source)
      : (target, source) => target.premultiply(source);

    for (let i = 1; i < len; i++) {
      const subT = (this.t - 1) + (i / (len - 1));
      const nextV = this.path.getPoint(subT / this.duration);
      const stepAngle = angleBetween(prevV, nextV);

      if (stepAngle > 0.0001) {
        const stepAxis = vectorPool.acquire().crossVectors(prevV, nextV).normalize();
        const qStep = quaternionPool.acquire().setFromAxisAngle(stepAxis, stepAngle);
        applyRotation(accumulatedQ, qStep);
      }

      applyRotation(this.orientation.orientations[i], accumulatedQ).normalize();
      prevV = nextV;
    }
  }
}

/**
 * Axis rotation.
 */
export class Rotation extends Animation {
  static get MAX_ANGLE() { return TWO_PI / Daydream.W; }

  /**
   * Static helper to animate rotation.
   * @param {Orientation} orientation - Object.
   * @param {THREE.Vector3} axis - Axis.
   * @param {number} angle - Total radians.
   * @param {Function} easingFn - Easing.
   * @param {string} space - "World"/"Local".
   */
  static animate(orientation, axis, angle, easingFn, space) {
    orientation.collapse();
    let r = new Rotation(orientation, axis, angle, 1, easingFn, false, space);
    r.step();
  }

  /**
   * @param {Orientation} orientation - Object.
   * @param {THREE.Vector3} axis - Axis.
   * @param {number} angle - Total radians.
   * @param {number} duration - Frames.
   * @param {Function} easingFn - Easing.
   * @param {boolean} repeat - Loop.
   * @param {string} space - Space.
   */
  constructor(orientation, axis, angle, duration, easingFn, repeat = false, space = "World") {
    super(duration, repeat);
    this.orientation = orientation;
    this.axis = axis;
    this.totalAngle = angle;
    this.easingFn = easingFn;
    this.last_angle = 0.0;
    this.space = space;
  }

  /**
   * Advances rotation.
   */
  step() {
    if (this.t == 0) this.last_angle = 0;
    super.step();

    let targetAngle = this.easingFn(this.t / this.duration) * this.totalAngle;
    let delta = targetAngle - this.last_angle;
    if (Math.abs(delta) < 0.000001) {
      this.last_angle = targetAngle;
      return;
    }

    const steps = 1 + Math.ceil(Math.abs(delta) / Rotation.MAX_ANGLE);
    this.orientation.upsample(steps + 1);
    const len = this.orientation.length();

    const stepAngle = delta / (len - 1);
    const applyRotation = (this.space === "Local")
      ? (target, source) => target.multiply(source)
      : (target, source) => target.premultiply(source);

    for (let i = 1; i < len; i++) {
      const angle = stepAngle * i;
      const q = quaternionPool.acquire().setFromAxisAngle(this.axis, angle);
      applyRotation(this.orientation.orientations[i], q).normalize();
    }
    this.last_angle = targetAngle;
  }
}

/**
 * Random surface walk.
 */
export class RandomWalk extends Animation {
  static Languid = { speed: 0.02, pivotStrength: 0.1, noiseScale: 0.02 };
  static Energetic = { speed: 0.05, pivotStrength: 0.4, noiseScale: 0.08 };

  /**
   * @param {Orientation} orientation - Object.
   * @param {THREE.Vector3} v_start - Initial vector.
   * @param {Object} options - {speed, pivotStrength, noiseScale, seed, space}.
   */
  constructor(orientation, v_start, options = {}) {
    super(-1, false);
    this.orientation = orientation;
    this.v = v_start.clone();
    this.space = options.space || "World";
    this.noise = new FastNoiseLite();
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.noise.SetSeed(options.seed !== undefined ? options.seed : Math.floor(Math.random() * 65535));

    this.WALK_SPEED = options.speed !== undefined ? options.speed : RandomWalk.Languid.speed;
    this.PIVOT_STRENGTH = options.pivotStrength !== undefined ? options.pivotStrength : RandomWalk.Languid.pivotStrength;
    this.NOISE_SCALE = options.noiseScale !== undefined ? options.noiseScale : RandomWalk.Languid.noiseScale;

    this.noise.SetFrequency(this.NOISE_SCALE);
    let u = (Math.abs(this.v.x) > 0.9) ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.direction = new THREE.Vector3().crossVectors(this.v, u).normalize();
  }

  /**
   * Advances walk.
   */
  step() {
    super.step();
    // Pivot
    const pivotAngle = this.noise.GetNoise(this.t, 0.0) * this.PIVOT_STRENGTH;
    this.direction.applyAxisAngle(this.v, pivotAngle).normalize();

    // Walk
    const walkAxis = new THREE.Vector3().crossVectors(this.v, this.direction).normalize();
    const walkAngle = this.WALK_SPEED;
    this.v.applyAxisAngle(walkAxis, walkAngle).normalize();
    this.direction.applyAxisAngle(walkAxis, walkAngle).normalize();

    Rotation.animate(this.orientation, walkAxis, walkAngle, easeMid, this.space);
  }
}

/**
 * Transitions from one color palette to another.
 */
export class ColorWipe extends Animation {
  /**
   * @param {Object} fromPalette - The source palette.
   * @param {Object} toPalette - The target palette.
   * @param {number} duration - Duration of the wipe.
   * @param {Function} easingFn - Easing function.
   */
  constructor(fromPalette, toPalette, duration, easingFn) {
    super(duration, false);
    this.curPalette = fromPalette;
    this.toPalette = toPalette;
    this.easingFn = easingFn;
  }

  step() {
    if (this.t == 0) {
      this.a0 = this.curPalette.a.clone();
      this.b0 = this.curPalette.b.clone();
      this.c0 = this.curPalette.c.clone();
    }
    super.step();
    this.curPalette.a.lerpColors(this.a0, this.toPalette.a, this.easingFn(this.t / this.duration));
    this.curPalette.b.lerpColors(this.b0, this.toPalette.b, this.easingFn(this.t / this.duration));
    this.curPalette.c.lerpColors(this.c0, this.toPalette.c, this.easingFn(this.t / this.duration));
  }
}

/**
 * Animates the Mobius parameters for a continuous loxodromic flow.
 */
export class MobiusFlow extends Animation {
  /**
   * @param {Object} params - The Mobius parameters object.
   * @param {number} numRings - Number of rings in the flow.
   * @param {number} numLines - Number of lines.
   * @param {number} duration - Animation duration.
   * @param {boolean} [repeat=true] - Whether to repeat.
   */
  constructor(params, numRings, numLines, duration, repeat = true) {
    super(duration, repeat);
    this.params = params;
    this.numRings = numRings;
    this.numLines = numLines;
  }

  step() {
    super.step();
    const progress = this.t / this.duration;
    const logPeriod = 5.0 / (this.numRings + 1);
    const flowParam = progress * logPeriod;
    const scale = Math.exp(flowParam);
    const s = Math.sqrt(scale);
    const angle = progress * (TWO_PI / this.numLines);

    this.params.aRe = s * Math.cos(angle);
    this.params.aIm = s * Math.sin(angle);
    this.params.dRe = (1 / s) * Math.cos(-angle);
    this.params.dIm = (1 / s) * Math.sin(-angle);
  }
}

/**
 * Animates the Mobius parameters for a warping effect pulling the poles together.
 */
export class MobiusWarp extends Animation {
  /**
   * @param {Object} params - The Mobius parameters.
   * @param {number} numRings - Number of rings.
   * @param {number} duration - Animation duration.
   * @param {boolean} [repeat=true] - Whether to repeat.
   */
  constructor(params, numRings, duration, repeat = true) {
    super(duration, repeat);
    this.params = params;
    this.numRings = numRings;
  }

  step() {
    super.step();
    const progress = this.t / this.duration;
    const angle = progress * TWO_PI;
    this.params.bRe = Math.cos(angle);
    this.params.bIm = Math.sin(angle);
  }
}

export class OrientationTrail {
  /**
   * @param {number} capacity - Number of frames to keep in history.
   */
  constructor(capacity) {
    this.capacity = capacity;
    // Pre-allocate buffer of Orientation objects
    this.snapshots = [];
    for (let i = 0; i < capacity; i++) {
      this.snapshots.push(new Orientation());
    }
    this.head = 0;
    this.count = 0;
  }

  /**
   * Records a snapshot of the current orientation state.
   * @param {Orientation} source - The orientation to copy.
   */
  record(source) {
    const snapshot = this.snapshots[this.head];
    const srcData = source.orientations;
    const dstData = snapshot.orientations;

    // 1. Ensure buffer size matches source (grow if needed)
    while (dstData.length < srcData.length) {
      dstData.push(new THREE.Quaternion()); // These are persistent within the OrientationTrail snapshots
    }
    // 2. Trim if source shrank (optional, but keeps state clean)
    dstData.length = srcData.length;

    // 3. Deep copy quaternions
    for (let i = 0; i < srcData.length; i++) {
      dstData[i].copy(srcData[i]);
    }

    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  length() {
    return this.count;
  }

  /**
   * Gets a historical orientation. 0 is oldest, length-1 is newest.
   * @param {number} i - Index [0..length-1].
   * @returns {Orientation} The orientation at that index.
   */
  get(i) {
    // 0 = Oldest, count-1 = Newest
    // head points to next empty slot. head-1 is newest.
    // oldest is head - count.
    const idx = (this.head - this.count + i + this.capacity) % this.capacity;
    return this.snapshots[idx];
  }


}

/**
 * "Super-Source" mesh morphing.
 * Projects source vertices onto destination surface, animates, then swaps topology.
 */
export class MeshMorph extends Animation {
  /**
   * @param {Object} source - Source mesh {vertices, faces}.
   * @param {string} dest - Target solid name.
   * @param {number} duration - Frames.
   * @param {boolean} repeat - Loop.
   * @param {Function} easingFn - Easing.
   * @param {Object} params - {target, dual, hankin, hankinAngle}.
   */
  constructor(source, dest, duration, repeat = false, easingFn = easeInOutSin, params = {}) {
    super(duration, repeat);
    this.source = source;
    this.dest = dest;
    this.easingFn = easingFn;
    this.params = params;

    this.startPositions = null;
    this.targetPositions = null;

    // Cache original
    this.originalState = {
      vertices: source.vertices.map(v => v.clone()),
      faces: source.faces.map(f => [...f])
    };

    this.init();
  }

  /**
   * Raycasts point onto mesh.
   * @param {THREE.Vector3} p - Point to project.
   * @param {Object} mesh - Target mesh.
   * @returns {THREE.Vector3} Projected point.
   */
  projectToMesh(p, mesh) {
    if (!mesh.bvh) {
      mesh.bvh = new BVH(mesh);
      mesh.bvh.build();
    }

    const dir = vectorPool.acquire().copy(p).normalize();
    const origin = vectorPool.acquire().set(0, 0, 0);

    const hit = mesh.bvh.intersectRay(origin, dir);

    if (hit) {
      return hit.point;
    }

    let best = mesh.vertices[0];
    let minD = p.distanceToSquared(best);
    for (let i = 1; i < mesh.vertices.length; i++) {
      const d = p.distanceToSquared(mesh.vertices[i]);
      if (d < minD) { minD = d; best = mesh.vertices[i]; }
    }
    return best.clone();
  }

  /**
   * Initializes morph targets and paths.
   */
  init() {
    // Resolve Dest
    let destSolid = Solids[this.params.target]();
    if (this.params.dual) destSolid = MeshOps.dual(destSolid);

    // Hankin
    if (this.params.hankin) destSolid = MeshOps.hankin(destSolid, this.params.hankinAngle);

    // Store Dest
    this.destMesh = {
      vertices: destSolid.vertices.map(v => v.clone()),
      faces: destSolid.faces
    };

    // Correspondences

    // Source -> Dest
    this.sourcePaths = [];
    for (const v of this.source.vertices) {
      const target = MeshOps.closestPointOnMeshGraph(v, destSolid);
      this.sourcePaths.push({
        start: v.clone(),
        end: target,
        angle: v.angleTo(target),
        axis: new THREE.Vector3().crossVectors(v, target).normalize()
      });
    }

    // Dest -> Source
    this.destPaths = [];
    for (const v of destSolid.vertices) {
      const start = MeshOps.closestPointOnMeshGraph(v, this.source);
      this.destPaths.push({
        start: start,
        end: v.clone(),
        angle: start.angleTo(v),
        axis: new THREE.Vector3().crossVectors(start, v).normalize()
      });
    }
  }

  /**
   * Animates morph.
   */
  step() {
    super.step();
    const progress = Math.min(1, this.t / this.duration);
    const alpha = this.easingFn(progress);

    // Expose alpha
    this.alpha = alpha;

    // Animate Source
    for (let i = 0; i < this.source.vertices.length; i++) {
      const path = this.sourcePaths[i];
      if (!this.source.vertices[i]) continue;

      // SLERP or LERP
      if (path.angle > 0.0001) {
        this.source.vertices[i].copy(path.start).applyAxisAngle(path.axis, path.angle * alpha);
      } else {
        this.source.vertices[i].copy(path.start).lerp(path.end, alpha);
      }
    }

    // Animate Dest
    for (let i = 0; i < this.destMesh.vertices.length; i++) {
      const path = this.destPaths[i];
      if (path.angle > 0.0001) {
        this.destMesh.vertices[i].copy(path.start).applyAxisAngle(path.axis, path.angle * alpha);
      } else {
        this.destMesh.vertices[i].copy(path.start).lerp(path.end, alpha);
      }
    }

    // Swap
    if (this.t >= this.duration) {
      this.source.vertices = this.destMesh.vertices;
      this.source.faces = this.destMesh.faces;
      this.destMesh = null;
    }
  }

  /**
   * Resets to original state.
   */
  rewind() {
    super.rewind();
    this.source.vertices = this.originalState.vertices.map(v => v.clone());
    this.source.faces = this.originalState.faces.map(f => [...f]);
    this.init();
  }
}

/**
 * Represents a path composed of connected points on the sphere.
 */
export class Path {
  /**
   * @param {THREE.Vector3} initialPos - The starting position of the path.
   */
  constructor(initialPos) {
    this.points = [initialPos.clone()];
  }

  /**
   * Collapses the path to only the last point.
   */
  collapse() {
    this.points = [this.points[this.points.length - 1]];
  }

  /**
   * Gets the number of points in the path.
   * @returns {number} The length of the path.
   */
  length() {
    return this.points.length;
  }

  /**
   * Appends a line segment between two vectors to the path.
   * @param {THREE.Vector3} c1 - The start vector.
   * @param {THREE.Vector3} c2 - The end vector.
   * @param {boolean} [longWay=false] - If true, take the longer arc.
   * @param {Function} [easingFn=(t) => t] - An unused easing function (retained for signature).
   * @returns {Path} The path instance.
   */
  appendLine(c1, c2, longWay = false, easingFn = (t) => t) {
    if (this.points.length > 0) {
      this.points.pop();
    }
    this.points.push(c2.clone());
    return this;
  }

  /**
   * Appends a segment generated by a plotting function.
   * @param {Function} plotFn - Function that returns a vector based on a domain parameter t.
   * @param {number} domain - The range of the input parameter for plotFn.
   * @param {number} samples - The number of points to sample.
   * @param {Function} [easingFn=(t) => t] - The easing function to apply to the input parameter.
   * @returns {Path} The path instance.
   */
  appendSegment(plotFn, domain, samples, easingFn = (t) => t) {
    if (this.points.length > 0) {
      this.points.pop();
    }
    for (let t = 0; t <= samples; t++) {
      // Clone
      this.points.push(plotFn(easingFn(t / samples) * domain).clone());
    }
    return this;
  }

  /**
   * Gets a point on the path based on a normalized parameter t.
   * @param {number} t - Normalized position along the path [0, 1].
   * @returns {THREE.Vector3} A clone of the point at the given position.
   */
  getPoint(t) {
    const rawIndex = t * (this.points.length - 1);
    const i = Math.floor(rawIndex);
    const f = rawIndex - i;

    // Check end
    if (i >= this.points.length - 1) {
      return vectorPool.acquire().copy(this.points[this.points.length - 1]);
    }

    const p1 = this.points[i];
    const p2 = this.points[i + 1];
    return vectorPool.acquire().copy(p1).lerp(p2, f);
  }
}

/**
 * Represents a path defined by a single procedural function.
 */
export class ProceduralPath {
  /**
   * @param {Function} pathFn - Function that takes a parameter t [0, 1] and returns a THREE.Vector3.
   */
  constructor(pathFn) {
    this.f = pathFn;
  }

  /**
   * Gets a point on the path.
   * @param {number} t - Normalized position along the path [0, 1].
   * @returns {THREE.Vector3} The point on the path.
   */
  getPoint(t) {
    return this.f(t);
  }
}

/**
 * Draws a motion trail by tweening between orientations in the queue.
 * @param {Orientation} orientation - The orientation object containing the motion history.
 * @param {Function} drawFn - Function to draw a segment (takes orientation quaternion and normalized progress).
 */
export const tween = (orientation, drawFn) => {
  let s = orientation.length();
  let start = (s > 1) ? 1 : 0;
  for (let i = start; i < s; ++i) {
    drawFn(orientation.get(i), (s - 1 - i) / s);
  }
}

/**
 * Performs a deep tween on an OrientationTrail, handling interpolation between frames.
 * @param {OrientationTrail} trail - The trail of orientation histories.
 * @param {Function} drawFn - Function to draw a sample (takes quaternion and global time t).
 */
export const deepTween = (trail, drawFn) => {
  const dt = 1.0 / trail.capacity;
  tween(trail, (frame, t) => {
    tween(frame, (q, subT) => {
      const globalT = t + subT * dt;
      drawFn(q, globalT);
    });
  });
}
