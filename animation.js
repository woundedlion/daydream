/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// TODO: Split Transition into ContinuousTransition and DiscreteTransition

import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween, Orientation, vectorPool, quaternionPool } from "./geometry.js";
import FastNoiseLite from "./FastNoiseLite.js";
import { TWO_PI } from "./3dmath.js";

/**
 * Elastic easing out.
 * @param {number} x - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeOutElastic = (x) => {
  const c4 = TWO_PI / 3;
  return x === 0 ?
    0 : x === 1 ?
      1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}

/**
 * Bicubic easing in and out.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeInOutBicubic = (t) => {
  return t < 0.5 ? 4 * Math.pow(t, 3) : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Sinusoidal easing in and out.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeInOutSin = (t) => {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/**
 * Sinusoidal easing in.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeInSin = (t) => {
  return 1 - Math.cos((t * Math.PI) / 2);
}

/**
 * Sinusoidal easing out.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeOutSin = (t) => {
  return Math.sin((t * Math.PI) / 2);
}

/**
 * Exponential easing out.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeOutExpo = (t) => {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

/**
 * Circular easing out.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeOutCirc = (t) => {
  return Math.sqrt(1 - Math.pow(t - 1, 2));
}

/**
 * Cubic easing in.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeInCubic = (t) => {
  return Math.pow(t, 3);
}

/**
 * Circular easing in.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeInCirc = (t) => {
  return 1 - Math.sqrt(1 - Math.pow(t, 2));
}

/**
 * Linear easing (no easing).
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeMid = (t) => {
  return t;
}

/**
 * Cubic easing out.
 * @param {number} t - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeOutCubic = (t) => {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Manages a list of animations on a timeline.
 */
export class Timeline {
  constructor() {
    this.t = 0;
    this.animations = [];
  }

  /**
   * Adds an animation to the timeline.
   * @param {number} inFrames - The delay in frames before starting the animation.
   * @param {Animation} animation - The animation object to add.
   * @returns {Timeline} The timeline instance.
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
   * Advances the timeline by one frame and steps active animations.
   */
  step() {
    ++this.t;

    // Prep Animations
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

    // Step animations
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
 * Base class for animations.
 */
export class Animation {
  /**
   * @param {number} duration - Duration of the animation in frames.
   * @param {boolean} repeat - Whether the animation should repeat.
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
   * @returns {boolean} True if done or canceled.
   */
  done() { return this.canceled || (this.duration >= 0 && this.t >= this.duration); }

  /**
   * Advances the animation by one step.
   */
  step() {
    this.t++;
  }

  /**
   * Resets the animation time.
   */
  rewind() {
    this.t = 0;
  }

  /**
   * Sets a callback to run after the animation finishes.
   * @param {Function} post - The callback function.
   * @returns {Animation} The animation instance.
   */
  then(post) {
    this.post = post;
    return this;
  }

  /**
   * Executes the post-animation callback.
   */
  post() {
    this.post();
  }
}

/**
 * Hashes 3D points into spatial buckets for fast neighbor lookup.
 */
class SpatialHash {
  /**
   * @param {number} cellSize - The size of each cell in the grid.
   */
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.buckets = new Map();
  }

  /**
   * Inserts a particle into the hash.
   * @param {ParticleSystem.Particle} particle - The particle to insert.
   */
  insert(particle) {
    const key = this.getKey(particle.p);
    if (!this.buckets.has(key)) {
      this.buckets.set(key, []);
    }
    this.buckets.get(key).push(particle);
  }

  getKey(v) {
    const x = Math.floor(v.x / this.cellSize);
    const y = Math.floor(v.y / this.cellSize);
    const z = Math.floor(v.z / this.cellSize);
    return `${x},${y},${z}`;
  }

  /**
   * Queries for particles within a radius.
   * @param {THREE.Vector3} position - Center of query.
   * @param {number} radius - Radius of query.
   * @returns {ParticleSystem.Particle[]} Array of neighbors.
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
              if (p.p.distanceToSquared(position) <= radius * radius) {
                particles.push(p);
              }
            }
          }
        }
      }
    }
    return particles;
  }

  /**
   * Clears the hash table.
   */
  clear() {
    this.buckets.clear();
  }
}

/**
 * A physics-based particle system with gravity and spatial hashing.
 */
// Base vector for particle orientation (North Pole)
export const PARTICLE_BASE = new THREE.Vector3(0, 1, 0);

export class ParticleSystem extends Animation {
  static Particle = class {
    /**
     * @param {THREE.Vector3} p - Initial position.
     * @param {THREE.Vector3} v - Initial velocity.
     * @param {Color4} c - Color.
     * @param {number} gravity - Gravity mass/strength.
     */
    constructor(p, v, c, gravity) {
      this.p = p.clone(); // Position (cache)
      this.v = v.clone(); // Velocity (Angular)
      this.c = c;         // Color (Color4)
      this.gravity = gravity;

      this.orientation = new Orientation();
      // Initialize orientation to match position p
      // assuming PARTICLE_BASE is (0,1,0)
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
    this.spatialHash = new SpatialHash(0.1); // Default cell size, adjustable
    this.interactionRadius = 0.2;
  }

  /**
   * Adds a gravity well.
   * @param {THREE.Vector3} position 
   * @param {number} strength 
   * @param {number} killRadius 
   */
  addAttractor(position, strength, killRadius) {
    this.attractors.push({ position, strength, killRadius });
  }

  /**
   * Spawns a new particle.
   * @param {THREE.Vector3} p 
   * @param {THREE.Vector3} v 
   * @param {Color4} c 
   * @param {number} gravity 
   */
  spawn(p, v, c, gravity) {
    this.particles.push(new ParticleSystem.Particle(p, v, c, gravity));
  }

  /**
   * Updates the particles' physics.
   */
  step() {
    super.step();

    // 1. Rebuild Spatial Hash
    this.spatialHash.clear();
    for (const p of this.particles) {
      this.spatialHash.insert(p);
    }

    // 2. Physics Step
    const G = this.gravityConstant;
    const radius = this.interactionRadius;
    const torque = vectorPool.acquire(); // Reuse vector for torque calculation
    const q = quaternionPool.acquire();  // Reuse quaternion

    for (const p of this.particles) {
      // Find neighbors
      const neighbors = this.spatialHash.query(p.p, radius);

      for (const other of neighbors) {
        if (p === other) continue;

        // Force is attraction between p and other
        // In rotational physics, we apply a Torque
        // Vector D = other - p
        // Torque T = p x D (axis of rotation to move p towards other)

        const distSq = p.p.distanceToSquared(other.p);

        if (distSq > 0.0001 && distSq < radius * radius) {
          const forceMag = (G * p.gravity * other.gravity) / distSq;

          // Calculate Torque direction (p cross (other - p) = p cross other)
          torque.crossVectors(p.p, other.p).normalize().multiplyScalar(forceMag);
          p.v.add(torque);
        }
      }

      // Apply Rotational Velocity
      // v represents axis * speed
      p.v.multiplyScalar(this.friction);

      const speed = p.v.length();
      if (speed > 0.00001) {
        const axis = vectorPool.acquire().copy(p.v).multiplyScalar(1 / speed); // Normalize axis

        // Animate rotation, upsampling history for trails
        const easeLinear = (t) => t;
        Rotation.animate(p.orientation, axis, speed, easeLinear, "World");
      }
    }


    // 3. Attractors & Death
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      let dead = false;
      for (const attr of this.attractors) {
        const distSq = p.p.distanceToSquared(attr.position);
        if (distSq < attr.killRadius * attr.killRadius) {
          dead = true;
          break;
        }

        // Attractor Torque
        // T = p x attr
        const dist = Math.sqrt(distSq);
        if (dist > 0.001) {
          const forceMag = attr.strength / distSq;
          torque.crossVectors(p.p, attr.position).normalize().multiplyScalar(forceMag);
          p.v.add(torque);
        }
      }

      if (dead) {
        this.particles.splice(i, 1);
      }
    }
  }
}


/**
 * A timer that triggers a function at random intervals.
 */
export class RandomTimer extends Animation {
  /**
   * @param {number} min - Minimum delay in frames.
   * @param {number} max - Maximum delay in frames.
   * @param {Function} f - The function to execute.
   * @param {boolean} [repeat=false] - Whether to repeat the timer.
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
   * Resets the timer with a new random delay.
   * @param {number} [t] - Optional time parameter (unused).
   */
  reset(t) {
    this.next = this.t + Math.round(Math.random() * (this.max - this.min) + this.min);
  }

  /**
   * Checks if the timer should fire.
   */
  step() {
    super.step();
    if (this.t >= this.next) {
      this.f();
      if (this.repeat) {
        this.reset();
      } else {
        this.canceled = true;
      }
    }
  }
}

/**
 * A timer that triggers a function at regular intervals.
 */
export class PeriodicTimer extends Animation {
  /**
   * @param {number} period - The interval in frames.
   * @param {Function} f - The function to execute.
   * @param {boolean} [repeat=false] - Whether to repeat.
   */
  constructor(period, f, repeat = false) {
    super(-1, repeat);
    this.period = period;
    this.f = f;
    this.reset();
  }

  /**
   * Resets the timer for the next period.
   */
  reset() {
    this.next = this.t + this.period;
  }

  /**
   * Checks if the timer should fire.
   */
  step() {
    super.step();
    if (this.t >= this.next) {
      this.f();
      if (this.repeat) {
        this.reset();
      } else {
        this.cancel();
      }
    }
  }
}


/**
 * Transitions a property on an object from one value to another over time.
 */
export class Transition extends Animation {
  /**
   * @param {Object} target - The object to modify.
   * @param {string} property - The property name.
   * @param {number} to - The target value.
   * @param {number} duration - Duration of transition.
   * @param {Function} easingFn - Easing function.
   * @param {boolean} [quantized=false] - If true, rounds values to integers.
   * @param {boolean} [repeat=false] - Whether to repeat.
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

  step() {
    if (this.t == 0) {
      this.from = this.target[this.property];
    }
    super.step();
    let t = Math.min(1, this.t / (this.duration));
    let n = this.easingFn(t) * (this.to - this.from) + this.from;
    if (this.quantized) {
      n = Math.floor(n);
    }
    this.target[this.property] = n;
  }
}

/**
 * Mutates a property on an object using a provided function over time.
 */
export class Mutation extends Animation {
  /**
   * @param {Object} target - The object to modify.
   * @param {string} property - The property name.
   * @param {Function} fn - The mutation function (takes eased time and current value).
   * @param {number} duration - Duration.
   * @param {Function} easingFn - Easing function.
   * @param {boolean} [repeat=false] - Whether to repeat.
   */
  constructor(target, property, fn, duration, easingFn, repeat = false) {
    super(duration, repeat);
    this.target = target;
    this.property = property;
    this.fn = fn;
    this.duration = duration;
    this.easingFn = easingFn;
  }

  step() {
    if (this.t == 0) {
      this.from = this.target[this.property];
    }
    super.step();
    let t = Math.min(1, this.t / this.duration);
    this.target[this.property] = this.fn(this.easingFn(t), this.target[this.property]);
  }
}

/**
 * An animation that draws something with fade-in and fade-out capabilities.
 */
export class Sprite extends Animation {
  /**
   * @param {Function} drawFn - The function to draw the sprite (takes opacity).
   * @param {number} duration - Total duration.
   * @param {number} [fadeInDuration=0] - Fade in duration.
   * @param {Function} [fadeInEasingFn=easeMid] - Fade in easing.
   * @param {number} [fadeOutDuration=0] - Fade out duration.
   * @param {Function} [fadeOutEasingFn=easeMid] - Fade out easing.
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
 * Animates an orientation along a path.
 */
export class Motion extends Animation {
  static get MAX_ANGLE() { return TWO_PI / Daydream.W; }

  /**
   * Static helper to perform a one-shot motion animation.
   * @param {Orientation} orientation - The orientation object.
   * @param {Path} path - The path to follow.
   */
  static animate(orientation, path) {
    let m = new Motion(orientation, path, 1, false, 1);
    m.step();
  }

  /**
   * @param {Orientation} orientation - The orientation to update.
   * @param {Path} path - The path to follow.
   * @param {number} duration - Duration of the motion.
   * @param {boolean} [repeat=false] - Whether to repeat.
   * @param {string} [space="World"] - "World" or "Local".
   */
  constructor(orientation, path, duration, repeat = false, space = "World") {
    super(duration, repeat);
    this.orientation = orientation;
    this.path = path;
    this.space = space;
  }

  step() {
    super.step();

    let currentV = this.path.getPoint((this.t - 1) / this.duration);
    const targetV = this.path.getPoint(this.t / this.duration);
    const totalAngle = angleBetween(currentV, targetV);
    const numSteps = Math.ceil(Math.max(1, totalAngle / Motion.MAX_ANGLE));

    // Ensure sufficient resolution
    this.orientation.upsample(numSteps + 1);
    const len = this.orientation.length();

    let prevV = currentV.clone(); // Path points might be needing clone if path reuses them? Path usually computes fresh.
    const accumulatedQ = quaternionPool.acquire(); // Identity? No, acquire returns whatever.
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
 * Animates an orientation by rotating it around an axis.
 */
export class Rotation extends Animation {
  static get MAX_ANGLE() {
    return TWO_PI / Daydream.W;
  }

  /**
   * Static helper for a one-shot rotation.
   * @param {Orientation} orientation 
   * @param {THREE.Vector3} axis 
   * @param {number} angle 
   * @param {Function} easingFn 
   * @param {string} [space="World"]
   */
  static animate(orientation, axis, angle, easingFn, space) {
    orientation.collapse();
    let r = new Rotation(orientation, axis, angle, 1, easingFn, false, space);
    r.step();
  }

  /**
   * @param {THREE.Vector3} axis - Axis of rotation.
   * @param {number} angle - Total angle to rotate.
   * @param {number} duration - Duration.
   * @param {Function} easingFn - Easing function.
   * @param {boolean} [repeat=false] - Whether to repeat.
   * @param {string} [space="World"] - "World" or "Local".
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

  step() {
    if (this.t == 0) {
      this.last_angle = 0;
    }
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
 * Randomly walks an orientation over the sphere surface.
 */
export class RandomWalk extends Animation {
  /**
   * @typedef {Object} RandomWalkOptions
   * @property {number} [speed=0.02] - Speed of the walk (angular speed in radians per step).
   * @property {number} [pivotStrength=0.1] - Turning sharpness (max pivot angle in radians per step).
   * @property {number} [noiseScale=0.02] - Frequency of turn direction changes (Perlin noise frequency).
   * @property {number} [seed] - Seed for the noise generator (default: random).
   * @property {string} [space="World"] - Coordinate space ("World" or "Local").
   */

  static Languid = { speed: 0.02, pivotStrength: 0.1, noiseScale: 0.02 };
  static Energetic = { speed: 0.05, pivotStrength: 0.4, noiseScale: 0.08 };

  /**
   * @param {Orientation} orientation - The orientation to animate.
   * @param {THREE.Vector3} v_start - The starting vector.
   * @param {RandomWalkOptions} [options] - Configuration options.
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

    let u = (Math.abs(this.v.x) > 0.9)
      ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(1, 0, 0);
    this.direction = new THREE.Vector3().crossVectors(this.v, u).normalize();

  }

  step() {
    super.step();
    //pivot
    const pivotAngle = this.noise.GetNoise(this.t, 0.0) * this.PIVOT_STRENGTH;
    this.direction.applyAxisAngle(this.v, pivotAngle).normalize();

    //walk forward
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