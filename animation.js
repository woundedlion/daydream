/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween, MeshOps } from "./geometry.js";
import { vectorPool, quaternionPool } from "./memory.js";
import { Solids } from "./solids.js";
import FastNoiseLite from "./FastNoiseLite.js";
import { TWO_PI } from "./3dmath.js";
import { easeOutElastic, easeInOutSin, easeInSin, easeOutSin, easeOutExpo, easeOutCirc, easeInCubic, easeInCirc, easeMid, easeOutCubic } from "./easing.js";
import { StaticCircularBuffer } from "./StaticCircularBuffer.js";

// Easing functions moved to easing.js

/**
 * Manages the rotation and orientation of a 3D object over time.
 * Stores a history of quaternions for motion trails.
 */
export class Orientation {
  constructor() {
    this.orientations = [new THREE.Quaternion(0, 0, 0, 1)];
    this.count = 1;
  }

  /**
   * Gets the number of recorded orientations (history length).
   * @returns {number} The length of the orientation history.
   */
  length() {
    return this.count;
  }

  /**
   * Applies an orientation from the history to a given vector.
   * @param {THREE.Vector3} v - The vector to be oriented.
   * @param {number} [i=this.length() - 1] - The index in the history to use.
   * @param {THREE.Vector3} [target=null] - Optional target vector.
   * @returns {THREE.Vector3} The oriented and normalized vector.
   */
  orient(v, i = this.length() - 1, target = null) {
    const out = target || vectorPool.acquire();
    return out.copy(v).normalize().applyQuaternion(this.orientations[i]);
  }

  /**
   * Applies the inverse orientation from the history to a given vector.
   * @param {THREE.Vector3} v - The vector to be unoriented.
   * @param {number} [i=this.length() - 1] - The index in the history to use.
   * @returns {THREE.Vector3} The unoriented and normalized vector.
   */
  unorient(v, i = this.length() - 1) {
    const q = quaternionPool.acquire().copy(this.orientations[i]).invert();
    return vectorPool.acquire().copy(v).normalize().applyQuaternion(q);
  }

  /**
   * Applies the orientation to an array of coordinate arrays.
   * @param {number[][]} vertices - Array of [x, y, z] coordinates.
   * @param {number} [i=this.length() - 1] - The index in the history to use.
   * @returns {number[][]} Array of oriented [x, y, z] coordinates.
   */
  orientPoly(vertices, i = this.length() - 1) {
    return vertices.map((c) => {
      return this.orient(vectorPool.acquire().fromArray(c)).toArray();
    });
  }

  /**
   * Increases the resolution of the history to 'count' steps, preserving shape via Slerp.
   * @param {number} count - The target number of steps in the history.
   * Does nothing if count is less than current length.
   */
  /**
   * Increases the resolution of the history to 'count' steps, preserving shape via Slerp.
   * @param {number} count - The target number of steps in the history.
   * Does nothing if count is less than current length.
   */
  upsample(count) {
    if (this.count >= count) return;

    this.ensureCapacity(count);

    const oldLen = this.count;

    // Use backwards iteration to perform in-place expansion
    for (let i = count - 1; i >= 0; i--) {
      // Normalized position
      const t = i / (count - 1);

      // Float index
      const oldVal = t * (oldLen - 1);
      const idxA = Math.floor(oldVal);
      const idxB = Math.ceil(oldVal);
      const alpha = oldVal - idxA;

      // in-place slerp:
      const qA = this.orientations[idxA];
      const qB = this.orientations[idxB];
      const target = this.orientations[i];
      const safeQB = (target === qB) ? quaternionPool.acquire().copy(qB) : qB;

      target.copy(qA).slerp(safeQB, alpha);
    }

    this.count = count;
  }

  /**
   * Clears all recorded orientations.
   */
  clear() {
    this.orientations = [];
    this.count = 0;
  }

  /**
   * Gets a specific quaternion from the history.
   * @param {number} [i=this.length() - 1] - The index in the history to get.
   * @returns {THREE.Quaternion} The requested quaternion.
   */
  get(i = this.length() - 1) {
    return this.orientations[i];
  }

  /**
   * Replaces the entire history with a single quaternion.
   * @param {THREE.Quaternion} quaternion - The new orientation.
   * @returns {Orientation} The orientation instance.
   */
  set(quaternion) {
    this.orientations = [quaternion];
    this.count = 1;
    return this;
  }

  ensureCapacity(n) {
    while (this.orientations.length < n) {
      this.orientations.push(new THREE.Quaternion());
    }
  }

  copyFrom(source) {
    const len = source.length();
    this.ensureCapacity(len);
    for (let i = 0; i < len; i++) {
      this.orientations[i].copy(source.get(i));
    }
    this.count = len;
  }

  /**
   * Adds a new quaternion to the end of the history.
   * @param {THREE.Quaternion} quaternion - The quaternion to push.
   */
  push(quaternion) {
    this.orientations[this.count] = quaternion;
    this.count++;
  }

  /**
   * Appends a quaternion by copying it into the next available slot.
   * Allocates new storage only if necessary.
   * @param {THREE.Quaternion} q - The quaternion to copy.
   */
  append(q) {
    if (this.count >= this.orientations.length) {
      this.orientations.push(new THREE.Quaternion());
    }
    this.orientations[this.count].copy(q);
    this.count++;
  }

  /**
   * Collapses the history to just the most recent orientation.
   */
  collapse() {
    if (this.count > 1) {
      // Copy last to first
      this.orientations[0].copy(this.orientations[this.count - 1]);
      this.count = 1;
    }
  }
}

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
   * @param {Animation.Base} animation - Animation.
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
        if (!animation.canceled) {
          animation.step();
        }
        if (animation.done()) {
          if (animation.repeat && !animation.canceled) {
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
class Base {
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
   * @returns {Base} Self.
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
class ParticleSystem extends Base {
  static Particle = class {
    /**
     * @param {THREE.Vector3} position - Position.
     * @param {THREE.Vector3} velocity - Velocity.
     * @param {THREE.Color|Object} color - Color or Palette object.
     * @param {number} ttl - Frames to live.
     */
    constructor(trailLength = 20) {
      this.position = new THREE.Vector3();
      this.velocity = new THREE.Vector3();
      this.palette = null;
      this.ttl = 0;
      this.maxTtl = 0;
      this.tag = { trailData: this };
      this.orientation = new Orientation();
      this.history = new OrientationTrail(trailLength);
      this.trailLength = trailLength;
    }

    /**
     * Re-initializes the particle state.
     */
    init(position, velocity, palette, ttl) {
      this.position.copy(position);
      this.velocity.copy(velocity);
      this.palette = palette;
      this.ttl = ttl;
      this.maxTtl = ttl;
      this.orientation.count = 1;
      this.orientation.orientations[0].set(0, 0, 0, 1);
      this.history.head = 0;
      this.history.count = 0;
    }

    get orientedPosition() {
      return this.orientation.orient(this.position);
    }
  }

  constructor(capacity = 1000, friction = 0.95, gravityScale = 0.001, trailLength = 20) {
    super(-1, false);
    this.capacity = capacity;
    this.reset(friction, gravityScale, trailLength);
    this.interactionRadius = 0.2;
    this.resolutionScale = 1.0;
  }

  // Getter for backwards compatibility (returns full pool, including inactive)
  get particles() {
    return this.pool;
  }

  /**
   * Resets the particle system state.
   * @param {number} [friction] - Friction coefficient.
   * @param {number} [gravityScale] - Gravity scale.
   * @param {number} [trailLength] - Trail History Length.
   */
  reset(friction, gravityScale, trailLength) {
    this.activeCount = 0;
    this.attractors = [];
    this.emitters = [];
    this.timeScale = 1.0;

    if (friction !== undefined) this.friction = friction;
    if (gravityScale !== undefined) this.gravityScale = gravityScale;

    // Rebuild pool if trailLength changes or pool is empty
    if (this.pool === undefined || this.pool.length === 0 || (trailLength !== undefined && trailLength !== this.trailLength)) {
      if (trailLength !== undefined) this.trailLength = trailLength;
      this.pool = [];
      for (let i = 0; i < this.capacity; i++) {
        this.pool.push(new ParticleSystem.Particle(this.trailLength));
      }
    }
  }

  /**
   * Adds an emitter function.
   * @param {Function} callback - Function that returns a new Particle or null.
   */
  addEmitter(callback) {
    this.emitters.push(callback);
  }

  /**
   * Adds an attractor.
   * @param {THREE.Vector3} position - Location.
   * @param {number} strength - Attraction strength.
   * @param {number} killRadius - Radius to kill particles.
   * @param {number} eventHorizon - Radius where particles get sucked in.
   */
  addAttractor(position, strength, killRadius, eventHorizon) {
    this.attractors.push({ position, strength, killRadius, eventHorizon });
  }

  /**
   * Spawns a new particle.
   * @param {THREE.Vector3} position - Position.
   * @param {THREE.Vector3} velocity - Velocity.
   * @param {THREE.Color|Object} color - Color or Palette.
   * @param {number} ttl - Frames to live.
   */
  spawn(position, velocity, color, ttl = 600) {
    if (this.activeCount < this.capacity) {
      const p = this.pool[this.activeCount];
      p.init(position, velocity, color, ttl);
      this.activeCount++;
    }
  }

  /**
   * Simulates the physics step.
   */
  step() {
    super.step();

    for (let k = 0; k < this.timeScale; k++) {

      // Run Emitters
      for (const emit of this.emitters) {
        emit(this);
      }

      const maxDelta = TWO_PI / Daydream.W / this.resolutionScale;
      const G = this.gravityScale;

      // Scratch variables reused across particles for performance
      const scratch = {
        torque: vectorPool.acquire(),
        axis: vectorPool.acquire(),
        dQ: quaternionPool.acquire(),
        pos: vectorPool.acquire()
      };

      // Attractors (Global Gravity)
      for (let i = 0; i < this.activeCount; i++) {
        const p = this.pool[i];
        const dead = this.stepParticle(p, maxDelta, G, scratch);
        if (dead) {
          // Swap with last active
          const last = this.pool[this.activeCount - 1];
          this.pool[i] = last;
          this.pool[this.activeCount - 1] = p; // Return to pool (swap)
          this.activeCount--;
          i--; // Reprocess the swapped-in particle
        }
      }
    }
  }

  /**
   * Simulates a single frame for a particle.
   * @param {Particle} p - Particle.
   * @param {number} maxDelta - Max rotation delta.
   * @param {number} G - Gravity scale.
   * @param {Object} scratch - Scratch variables {torque, axis, dQ, pos}.
   * @returns {boolean} True if particle died.
   */
  stepParticle(p, maxDelta, G, scratch) {
    const { torque, axis, dQ, pos } = scratch;

    // Age
    p.ttl--;
    let active = p.ttl > 0;

    // Physics
    if (active) {
      const currentQ = quaternionPool.acquire().copy(p.orientation.get());
      pos.copy(p.position).applyQuaternion(currentQ);

      // Attractors
      for (const attr of this.attractors) {
        const distSq = pos.distanceToSquared(attr.position);

        if (distSq < attr.killRadius * attr.killRadius) {
          active = false;
          break;
        }

        if (distSq > 0.0000001) {
          const eventHorizonSq = attr.eventHorizon * attr.eventHorizon;

          if (distSq < eventHorizonSq) {
            // Steer directly into the center at the current speed
            torque.subVectors(attr.position, pos).normalize();
            const currentSpeed = p.velocity.length();
            p.velocity.copy(torque).multiplyScalar(currentSpeed);
          } else {
            // Apply gravity
            const forceMag = (G * attr.strength) / distSq;
            torque.crossVectors(pos, attr.position).normalize().multiplyScalar(forceMag);
            p.velocity.add(torque.cross(pos));
          }
        }
      }

      if (active) {
        // Drag
        p.velocity.multiplyScalar(this.friction);

        // Move
        const subSpeed = p.velocity.length();
        if (subSpeed > 0.000001) {
          axis.crossVectors(pos, p.velocity).normalize();
          const angle = subSpeed;
          dQ.setFromAxisAngle(axis, angle);
          currentQ.premultiply(dQ);
          p.orientation.append(currentQ);
          p.velocity.applyQuaternion(dQ);
        }
      }
    }

    // 3. History Management
    if (active) {
      p.history.record(p.orientation);
    } else {
      if (p.history.length() > 0) {
        p.history.expire();
      }
    }

    p.orientation.collapse();

    if (!active && p.history.length() === 0) {
      return true;
    }

    return false;
  }

}

/**
 * Randomized timer.
 */
class RandomTimer extends Base {
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
class PeriodicTimer extends Base {
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
class Transition extends Base {
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
class Mutation extends Base {
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
class Sprite extends Base {
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
class Motion extends Base {
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
class Rotation extends Base {
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
class RandomWalk extends Base {
  static Languid = { speed: 0.02, pivotStrength: 0.1, noiseScale: 0.02 };
  static Brisk = { speed: 0.06, pivotStrength: 0.1, noiseScale: 0.02 };
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
class ColorWipe extends Base {
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
class MobiusFlow extends Base {
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
class MobiusWarp extends Base {
  /**
   * @param {Object} params - The Mobius parameters.
   * @param {number} duration - Animation duration.
   * @param {number} scale - Magnitude of distortion.
   * @param {boolean} [repeat=true] - Whether to repeat.
   */
  constructor(params, duration, scale = 1.0, repeat = true, easingFn = easeInOutSin) {
    super(duration, repeat);
    this.params = params;
    this.scale = scale;
    this.easingFn = easingFn;
  }

  step() {
    super.step();
    const progress = this.easingFn(this.t / this.duration);
    const angle = progress * TWO_PI;
    this.params.bRe = this.scale * (Math.cos(angle) - 1);
    this.params.bIm = this.scale * Math.sin(angle);
  }
}

/**
 * Animates the Mobius parameters for a warping effect pulling the poles together in a circular motion.
 */
class MobiusWarpCircular extends Base {
  /**
   * @param {Object} params - The Mobius parameters.
   * @param {number} duration - Animation duration.
   * @param {number} scale - Magnitude of distortion.
   * @param {boolean} [repeat=true] - Whether to repeat.
   */
  constructor(params, duration, scale = 1.0, repeat = true, easingFn = easeInOutSin) {
    super(duration, repeat);
    this.params = params;
    this.scale = scale;
    this.easingFn = easingFn;
  }

  step() {
    super.step();
    const progress = this.easingFn(this.t / this.duration);
    const angle = progress * TWO_PI;
    this.params.bRe = this.scale * (Math.cos(angle));
    this.params.bIm = this.scale * Math.sin(angle);
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
    snapshot.copyFrom(source);

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
  get(i = 0) {
    // 0 = Oldest, count-1 = Newest
    const idx = (this.head - this.count + i + this.capacity) % this.capacity;
    return this.snapshots[idx];
  }

  expire() {
    if (this.count > 0) {
      this.count--;
    }
  }
}

/**
 * "Super-Source" mesh morphing.
 * Projects source vertices onto destination surface, animates, then swaps topology.
 */
class MeshMorph extends Base {
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
 * t = 0 is the oldest frame, t = 1 is the newest frame.
 * Calls back with quaternion or Orientation and frame progress
 * @param {Orientation} orientation - The orientation object containing the motion history.
 * @param {Function} drawFn - Function to draw a segment (takes orientation quaternion and normalized progress).
 */
export const tween = (orientation, drawFn) => {
  let s = orientation.length();
  let start = (s > 1) ? 1 : 0;
  for (let i = start; i < s; ++i) {
    drawFn(orientation.get(i), s > 1 ? i / (s - 1) : 0);
  }
}

/**
 * Performs a deep tween on an OrientationTrail, handling interpolation between frames.
 * Calls back with quaternion and global time t.
 * t = 0 is the oldest frame, t = 1 is the newest frame.
 * @param {OrientationTrail} trail - The trail of orientation histories.
 * @param {Function} drawFn - Function to draw a sample (takes quaternion and global time t).
 */
export const deepTween = (orientationTrail, drawFn) => {
  const trailLength = orientationTrail.length();
  if (trailLength === 0) return;

  for (let i = 0; i < trailLength; i++) {
    const frame = orientationTrail.get(i);
    const frameSize = frame.length();
    const startJ = (i === 0) ? 0 : 1;
    for (let j = startJ; j < frameSize; j++) {
      const q = frame.get(j);
      const subT = (frameSize > 1) ? j / (frameSize - 1) : 0;
      const globalT = (i + subT) / trailLength;
      drawFn(q, globalT);
    }
  }
}

/**
 * Continuously modulates Mobius parameters to create an evolving warp.
 * Uses multiple frequencies for non-repeating chaos.
 */
class MobiusGenerate extends Base {
  /**
   * @param {MobiusParams} params - The params to animate.
   * @param {number} scale - Magnitude of modulation.
   * @param {number} speed - Speed of the animation.
   */
  constructor(params, scale = 0.5, speed = 0.01) {
    super(-1, true);
    this.params = params;
    this.scale = scale;
    this.speed = speed;

    // Capture initial state as base
    this.base = {
      aRe: params.aRe, aIm: params.aIm,
      bRe: params.bRe, bIm: params.bIm,
      cRe: params.cRe, cIm: params.cIm,
      dRe: params.dRe, dIm: params.dIm
    };

    // Random phase offsets for each parameter to ensure they don't sync up
    this.phases = {
      aRe: Math.random() * 100, aIm: Math.random() * 100,
      bRe: Math.random() * 100, bIm: Math.random() * 100,
      cRe: Math.random() * 100, cIm: Math.random() * 100,
      dRe: Math.random() * 100, dIm: Math.random() * 100
    };
  }

  step() {
    super.step();
    const t = this.t * this.speed;
    const s = this.scale;

    // Use prime-ish number ratios for frequencies to minimize repetition cycle
    this.params.aRe = this.base.aRe + Math.sin(t * 1.0 + this.phases.aRe) * s;
    this.params.aIm = this.base.aIm + Math.cos(t * 1.13 + this.phases.aIm) * s;

    this.params.bRe = this.base.bRe + Math.sin(t * 1.27 + this.phases.bRe) * s;
    this.params.bIm = this.base.bIm + Math.cos(t * 1.39 + this.phases.bIm) * s;

    this.params.cRe = this.base.cRe + Math.sin(t * 0.71 + this.phases.cRe) * s;
    this.params.cIm = this.base.cIm + Math.cos(t * 0.83 + this.phases.cIm) * s;

    this.params.dRe = this.base.dRe + Math.sin(t * 0.97 + this.phases.dRe) * s;
    this.params.dIm = this.base.dIm + Math.cos(t * 1.09 + this.phases.dIm) * s;
  }
}

/**
 * Adapts an arbitrary behavior function to the Animation system.
 */
class PaletteAnimation extends Base {
  /**
   * @param {Function} behaviorFn - Function(t, age) returning transformed t.
   * @param {number} duration - Duration in frames (-1 for infinite).
   */
  constructor(behaviorFn, duration = -1, repeat = true) {
    super(duration, repeat);
    this.behaviorFn = behaviorFn;
  }

  transform(t) {
    return this.behaviorFn(t, this.t);
  }
}

/**
 * Factory functions for common palette behaviors.
 */
export const PaletteBehaviors = {
  /**
   * Linearly shifts t over time.
   * @param {number} speed - Rate of change per frame.
   */
  Cycle: (speed = 0.01) => {
    return (t, age) => (t + age * speed) % 1;
  },

  /**
   * Oscillates t sinusodally.
   * @param {number} freq - Frequency of oscillation.
   * @param {number} amp - Amplitude of oscillation.
   */
  Breathe: (freq = 0.05, amp = 0.1) => {
    return (t, age) => (t + Math.sin(age * freq) * amp);
  },

  /**
   * Arbitrary mutation function.
   * @param {Function} fn - Custom transform function.
   */
  Mutate: (fn) => fn
};

export const Animation = {
  Base,
  ParticleSystem,
  RandomTimer,
  PeriodicTimer,
  Transition,
  Mutation,
  Sprite,
  Motion,
  Rotation,
  RandomWalk,
  ColorWipe,
  MobiusFlow,
  MobiusWarp,
  MobiusWarpCircular,
  MeshMorph,
  MobiusGenerate,
  PaletteAnimation
};