/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween, Orientation, vectorPool, quaternionPool, MeshOps } from "./geometry.js";
import { Solids } from "./solids.js";
import FastNoiseLite from "./FastNoiseLite.js";
import { TWO_PI } from "./3dmath.js";

/**
 * Elastic easing out.
 * @param {number} x - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutElastic = (x) => {
  const c4 = TWO_PI / 3;
  return x === 0 ? 0 : x === 1 ? 1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}

/**
 * Sinusoidal easing in-out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeInOutSin = (t) => -(Math.cos(Math.PI * t) - 1) / 2;

/**
 * Sinusoidal easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeInSin = (t) => 1 - Math.cos((t * Math.PI) / 2);

/**
 * Sinusoidal easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutSin = (t) => Math.sin((t * Math.PI) / 2);

/**
 * Exponential easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutExpo = (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);

/**
 * Circular easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutCirc = (t) => Math.sqrt(1 - Math.pow(t - 1, 2));

/**
 * Cubic easing in.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeInCubic = (t) => Math.pow(t, 3);

/**
 * Circular easing in.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeInCirc = (t) => 1 - Math.sqrt(1 - Math.pow(t, 2));

/**
 * Linear easing.
 * @param {number} t - Time [0, 1].
 * @returns {number} Value.
 */
export const easeMid = (t) => t;

/**
 * Cubic easing out.
 * @param {number} t - Time [0, 1].
 * @returns {number} Eased value.
 */
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

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

/**
 * Spatial hashing for neighbor lookup.
 */
class SpatialHash {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.buckets = new Map();
  }

  /**
   * Inserts a particle.
   * @param {Object} particle - Particle with .p (position).
   */
  insert(particle) {
    const key = this.getKey(particle.p);
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key).push(particle);
  }

  /**
   * Gets hash key for a vector.
   * @param {THREE.Vector3} v - Position.
   * @returns {string} Hash key.
   */
  getKey(v) {
    const x = Math.floor(v.x / this.cellSize);
    const y = Math.floor(v.y / this.cellSize);
    const z = Math.floor(v.z / this.cellSize);
    return `${x},${y},${z}`;
  }

  /**
   * Finds neighbors within radius.
   * @param {THREE.Vector3} position - Center.
   * @param {number} radius - Search radius.
   * @returns {Array} List of neighbors.
   */
  query(position, radius) {
    const particles = [];
    const cx = Math.floor(position.x / this.cellSize);
    const cy = Math.floor(position.y / this.cellSize);
    const cz = Math.floor(position.z / this.cellSize);
    const range = Math.ceil(radius / this.cellSize);

    for (let x = cx - range; x <= cx + range; x++) {
      for (let y = cy - range; y <= cy + range; y++) {
        for (let z = cz - range; z <= cz + range; z++) {
          const key = `${x},${y},${z}`;
          if (this.buckets.has(key)) {
            const bucket = this.buckets.get(key);
            for (const p of bucket) {
              if (p.p.distanceToSquared(position) <= radius * radius) particles.push(p);
            }
          }
        }
      }
    }
    return particles;
  }

  /**
   * Clears the hash.
   */
  clear() {
    this.buckets.clear();
  }
}

// North Pole
export const PARTICLE_BASE = new THREE.Vector3(0, 1, 0);

/**
 * Physics particle system.
 */
export class ParticleSystem extends Animation {
  static Particle = class {
    /**
     * @param {THREE.Vector3} p - Position.
     * @param {THREE.Vector3} v - Velocity.
     * @param {THREE.Color} c - Color.
     * @param {number} gravity - Gravity scale.
     */
    constructor(p, v, c, gravity) {
      this.p = p.clone();
      this.v = v.clone();
      this.c = c;
      this.gravity = gravity;
      this.orientation = new Orientation();

      // Orient
      const q = quaternionPool.acquire().setFromUnitVectors(PARTICLE_BASE, p.clone().normalize());
      this.orientation.orientations[0].copy(q);
    }
  }

  constructor() {
    super(-1, false);
    this.particles = [];
    this.friction = 0.95;
    this.gravityConstant = 0.01;
    this.attractors = [];
    this.spatialHash = new SpatialHash(0.1);
    this.interactionRadius = 0.2;
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
   * @param {THREE.Vector3} p - Position.
   * @param {THREE.Vector3} v - Velocity.
   * @param {THREE.Color} c - Color.
   * @param {number} gravity - Gravity scale.
   */
  spawn(p, v, c, gravity) {
    this.particles.push(new ParticleSystem.Particle(p, v, c, gravity));
  }

  /**
   * Simulates the physics step.
   */
  step() {
    super.step();

    // Rebuild Hash
    this.spatialHash.clear();
    for (const p of this.particles) this.spatialHash.insert(p);

    // Physics
    const G = this.gravityConstant;
    const radius = this.interactionRadius;
    const torque = vectorPool.acquire();
    const q = quaternionPool.acquire();

    for (const p of this.particles) {
      const neighbors = this.spatialHash.query(p.p, radius);
      for (const other of neighbors) {
        if (p === other) continue;
        const distSq = p.p.distanceToSquared(other.p);

        if (distSq > 0.0001 && distSq < radius * radius) {
          const forceMag = (G * p.gravity * other.gravity) / distSq;
          // Torque
          torque.crossVectors(p.p, other.p).normalize().multiplyScalar(forceMag);
          p.v.add(torque);
        }
      }

      // Friction
      p.v.multiplyScalar(this.friction);

      const speed = p.v.length();
      if (speed > 0.00001) {
        const axis = vectorPool.acquire().copy(p.v).multiplyScalar(1 / speed);
        // Rotate
        const easeLinear = (t) => t;
        Rotation.animate(p.orientation, axis, speed, easeLinear, "World");
      }
    }

    // Attractors
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      let dead = false;
      for (const attr of this.attractors) {
        const distSq = p.p.distanceToSquared(attr.position);
        if (distSq < attr.killRadius * attr.killRadius) {
          dead = true;
          break;
        }
        // Torque
        const dist = Math.sqrt(distSq);
        if (dist > 0.001) {
          const forceMag = attr.strength / distSq;
          torque.crossVectors(p.p, attr.position).normalize().multiplyScalar(forceMag);
          p.v.add(torque);
        }
      }
      if (dead) this.particles.splice(i, 1);
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
 * Orientation history trail.
 */
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

    while (dstData.length < srcData.length) {
      dstData.push(new THREE.Quaternion());
    }
    dstData.length = srcData.length;

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
    const idx = (this.head - this.count + i + this.capacity) % this.capacity;
    return this.snapshots[idx];
  }
}

/**
 * Color palette transition.
 */
export class ColorWipe extends Animation {
  /**
   * @param {Object} fromPalette - Source colors.
   * @param {Object} toPalette - Target colors.
   * @param {number} duration - Frames.
   * @param {Function} easingFn - Easing.
   */
  constructor(fromPalette, toPalette, duration, easingFn = easeMid) {
    super(duration, false);
    this.from = fromPalette;
    this.to = toPalette;
    this.easingFn = easingFn;
    this.current = {};
    for (const key in fromPalette) {
      if (typeof fromPalette[key] === 'object' && fromPalette[key].isColor) {
        this.current[key] = fromPalette[key].clone();
      }
    }
  }

  /**
   * Interpolates colors.
   */
  step() {
    super.step();
    const t = this.easingFn(Math.min(1, this.t / this.duration));
    for (const key in this.from) {
      if (this.to[key]) this.current[key].copy(this.from[key]).lerp(this.to[key], t);
    }
  }
  /**
   * Gets current color.
   * @param {string} key - Color key.
   * @returns {THREE.Color} Current color.
   */
  get(key) { return this.current[key]; }
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
    const dir = vectorPool.acquire().copy(p).normalize();
    let bestHit = null;
    let minT = Infinity;

    // Cache vectors
    const edge1 = vectorPool.acquire();
    const edge2 = vectorPool.acquire();
    const normal = vectorPool.acquire();
    const hit = vectorPool.acquire();
    const toHit = vectorPool.acquire();
    const tempCross = vectorPool.acquire();

    // Check faces
    const facesToCheck = mesh.faces;
    const count = facesToCheck.length;

    for (let i = 0; i < count; i++) {
      const face = facesToCheck[i];
      if (face.length < 3) continue;

      // Triangulate
      for (let tIdx = 0; tIdx < face.length - 2; tIdx++) {
        const v0 = mesh.vertices[face[0]];
        const v1 = mesh.vertices[face[tIdx + 1]];
        const v2 = mesh.vertices[face[tIdx + 2]];

        edge1.subVectors(v1, v0);
        edge2.subVectors(v2, v0);
        normal.crossVectors(edge1, edge2);

        const lenSq = normal.lengthSq();
        if (lenSq < 0.000001) continue;
        normal.multiplyScalar(1.0 / Math.sqrt(lenSq));

        // Culling
        const denom = dir.dot(normal);
        if (denom < 0.0001) continue;

        const t = v0.dot(normal) / denom;
        if (t <= 0 || t >= minT) continue;

        // Hit test
        hit.copy(dir).multiplyScalar(t);

        // 0
        edge1.subVectors(v1, v0);
        toHit.subVectors(hit, v0);
        if (tempCross.crossVectors(edge1, toHit).dot(normal) < 0) continue;

        // 1
        edge1.subVectors(v2, v1);
        toHit.subVectors(hit, v1);
        if (tempCross.crossVectors(edge1, toHit).dot(normal) < 0) continue;

        // 2
        edge1.subVectors(v0, v2);
        toHit.subVectors(hit, v2);
        if (tempCross.crossVectors(edge1, toHit).dot(normal) < 0) continue;

        // Hit
        if (!bestHit) bestHit = new THREE.Vector3();
        bestHit.copy(hit);
        minT = t;
      }
    }

    if (bestHit) return bestHit;

    // Fallback
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
 * Mobius transform flow.
 */
export class MobiusFlow extends Animation {
  /**
   * @param {Mobius} mobius - Transform.
   * @param {THREE.Vector3} v - Movement vector.
   * @param {number} duration - Frames.
   */
  constructor(mobius, v, duration = -1) {
    super(duration, duration != -1);
    this.mobius = mobius;
    this.v = v;
  }
  /**
   * Moves flow.
   */
  step() {
    super.step();
    this.mobius.move(this.v);
  }
}

/**
 * Mobius warp.
 */
export class MobiusWarp extends Animation {
  /**
   * @param {Mobius} mobius - Transform.
   * @param {number} amount - Warp factor.
   * @param {number} duration - Frames.
   */
  constructor(mobius, amount, duration = -1) {
    super(duration, duration != -1);
    this.mobius = mobius;
    this.amount = amount;
  }
  /**
   * Warps space.
   */
  step() {
    super.step();
    this.mobius.warp(this.amount);
  }
}