// TODO: Split Transition into ContinuousTransition and DiscreteTransition

// animation.js
import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween } from "./geometry.js";
import FastNoiseLite from "./FastNoiseLite.js";

/**
 * Elastic easing out.
 * @param {number} x - The time value between 0 and 1.
 * @returns {number} The eased value.
 */
export const easeOutElastic = (x) => {
  const c4 = (2 * Math.PI) / 3;
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
 * A particle system animation driven by Perlin noise.
 */
export class ParticleSystem extends Animation {
  static Particle = class {
    constructor(p) {
      this.p = p;
      this.v = new THREE.Vector3();
    }
  }

  constructor() {
    super(-1, false);
    this.particles = [];
    this.noise = new FastNoiseLite();
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.noise.SetSeed(Math.floor(Math.random() * 65535));

    this.NOISE_SCALE = 10;
    this.TIME_SCALE = 0.01;
    this.FORCE_SCALE = 10;
  }

  /**
   * Spawns a new particle.
   * @param {THREE.Vector3} p - The initial position of the particle.
   */
  spawn(p) {
    this.particles.push(new ParticleSystem.Particle(p));
  }

  /**
   * Updates the particles' velocities based on noise.
   */
  step() {
    super.step();
    let t_scaled = this.t * this.TIME_SCALE;
    for (let p of this.particles) {
      let nx = p.p.x * this.NOISE_SCALE;
      let ny = p.p.y * this.NOISE_SCALE;
      let nz = p.p.z * this.NOISE_SCALE;

      // Using 3D slice technique to approximate 4D noise (matching C++ FlowField logic)
      let vx = this.noise.GetNoise(nx, ny, t_scaled);
      let vy = this.noise.GetNoise(ny, nz, t_scaled + 100);
      let vz = this.noise.GetNoise(nz, nx, t_scaled + 200);

      p.v.set(vx, vy, vz).multiplyScalar(this.FORCE_SCALE);
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
 * Wrapper for a number that can be mutated.
 */
export class MutableNumber {
  /**
   * @param {number} n - The initial value.
   */
  constructor(n) {
    this.n = n;
  }
  get() { return this.n; }
  set(n) { this.n = n; }
}

/**
 * Transitions a MutableNumber from one value to another over time.
 */
export class Transition extends Animation {
  /**
   * @param {MutableNumber} mutable - The value to modify.
   * @param {number} to - The target value.
   * @param {number} duration - Duration of transition.
   * @param {Function} easingFn - Easing function.
   * @param {boolean} [quantized=false] - If true, rounds values to integers.
   * @param {boolean} [repeat=false] - Whether to repeat.
   */
  constructor(mutable, to, duration, easingFn, quantized = false, repeat = false) {
    super(duration, repeat);
    this.mutable = mutable;
    this.to = to;
    this.duration = duration;
    this.easingFn = easingFn;
    this.quantized = quantized;
  }

  step() {
    if (this.t == 0) {
      this.from = this.mutable.get();
    }
    super.step();
    let t = Math.min(1, this.t / (this.duration));
    let n = this.easingFn(t) * (this.to - this.from) + this.from;
    if (this.quantized) {
      n = Math.floor(n);
    }
    this.mutable.set(n);
  }
}

/**
 * Mutates a value using a provided function over time.
 */
export class Mutation extends Animation {
  /**
   * @param {MutableNumber} mutable - The value to mutate.
   * @param {Function} fn - The mutation function (takes eased time and current value).
   * @param {number} duration - Duration.
   * @param {Function} easingFn - Easing function.
   * @param {boolean} [repeat=false] - Whether to repeat.
   */
  constructor(mutable, fn, duration, easingFn, repeat = false) {
    super(duration, repeat);
    this.mutable = mutable;
    this.fn = fn;
    this.duration = duration;
    this.easingFn = easingFn;
  }

  step() {
    if (this.t == 0) {
      this.from = this.mutable.get();
    }
    super.step();
    let t = Math.min(1, this.t / this.duration);
    this.mutable.set(this.fn(this.easingFn(t), this.mutable.get()));
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
    this.fader = new MutableNumber(fadeInDuration > 0 ? 0 : 1);
    this.fadeInDuration = fadeInDuration;
    this.fadeOutDuration = fadeOutDuration;
    this.fadeIn = new Transition(this.fader, 1, fadeInDuration, fadeInEasingFn);
    this.fadeOut = new Transition(this.fader, 0, fadeOutDuration, fadeOutEasingFn);
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
    this.drawFn(this.fader.get());
  }
}

/**
 * Animates an orientation along a path.
 */
export class Motion extends Animation {
  static get MAX_ANGLE() { return 2 * Math.PI / Daydream.W; }

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
   * @param {number} [history=1] - History window size.
   */
  constructor(orientation, path, duration, repeat = false, history = 1) {
    super(duration, repeat);
    this.orientation = orientation;
    this.path = path;
    this.history = history;
  }

  step() {
    super.step();


    let currentV = this.path.getPoint((this.t - 1) / this.duration);
    const targetV = this.path.getPoint(this.t / this.duration);
    const totalAngle = angleBetween(currentV, targetV);
    const numSteps = Math.ceil(Math.max(1, totalAngle / Motion.MAX_ANGLE));
    let origin = this.orientation.get();
    for (let i = 1; i <= numSteps; i++) {
      const subT = (this.t - 1) + (i / numSteps);
      const nextV = this.path.getPoint(subT / this.duration);
      const stepAngle = angleBetween(currentV, nextV);
      if (stepAngle > 0.000001) {
        const stepAxis = new THREE.Vector3().crossVectors(currentV, nextV).normalize();
        const q = new THREE.Quaternion().setFromAxisAngle(stepAxis, stepAngle);
        origin = origin.clone().premultiply(q);
        this.orientation.push(origin);
      }

      currentV = nextV;
    }
    let h = (this.history && typeof this.history.get === 'function') ? this.history.get() : this.history;
    this.orientation.collapse(h);
  }
}

/**
 * Animates an orientation by rotating it around an axis.
 */
export class Rotation extends Animation {
  static get MAX_ANGLE() {
    return 2 * Math.PI / Daydream.W;
  }

  /**
   * Static helper for a one-shot rotation.
   * @param {Orientation} orientation 
   * @param {THREE.Vector3} axis 
   * @param {number} angle 
   * @param {Function} easingFn 
   */
  static animate(orientation, axis, angle, easingFn) {
    let r = new Rotation(orientation, axis, angle, 1, easingFn, false, 1);
    r.step();
  }

  /**
   * @param {Orientation} orientation - The orientation to rotate.
   * @param {THREE.Vector3} axis - Axis of rotation.
   * @param {number} angle - Total angle to rotate.
   * @param {number} duration - Duration.
   * @param {Function} easingFn - Easing function.
   * @param {boolean} [repeat=false] - Whether to repeat.
   * @param {number} [history=1] - History window size.
   */
  constructor(orientation, axis, angle, duration, easingFn, repeat = false, history = 1) {
    super(duration, repeat);
    this.orientation = orientation;
    this.axis = axis;
    this.totalAngle = angle;
    this.easingFn = easingFn;
    this.last_angle = 0.0;
    this.history = history;
  }

  step() {
    if (this.t == 0) {
      this.last_angle = 0;
    }
    super.step();


    let targetAngle = this.easingFn(this.t / this.duration) * this.totalAngle;
    let delta = targetAngle - this.last_angle;
    if (Math.abs(delta) > 0.0001) {
      const numSteps = Math.ceil(Math.abs(delta) / Rotation.MAX_ANGLE);
      const stepAngle = delta / numSteps;
      const qStep = new THREE.Quaternion().setFromAxisAngle(this.axis, stepAngle);
      for (let i = 0; i < numSteps; i++) {
        let currentQ = this.orientation.get().clone();
        currentQ.premultiply(qStep).normalize();
        this.orientation.push(currentQ);
      }
      this.last_angle = targetAngle;
    }
    let h = (this.history && typeof this.history.get === 'function') ? this.history.get() : this.history;
    this.orientation.collapse(h);
  }
}

/**
 * Randomly walks an orientation over the sphere surface.
 */
export class RandomWalk extends Animation {
  /**
   * @param {Orientation} orientation - The orientation to animate.
   * @param {THREE.Vector3} v_start - The starting vector.
   * @param {number} [history=1] - History window size.
   */
  constructor(orientation, v_start, history = 1) {
    super(-1, false);
    this.orientation = orientation;
    this.v = v_start.clone();
    this.history = history;

    this.noise = new FastNoiseLite();
    this.noise.SetNoiseType(FastNoiseLite.NoiseType.Perlin);
    this.noise.SetSeed(Math.floor(Math.random() * 65535));

    this.WALK_SPEED = 0.05; // Constant angular speed (radians per step)
    this.PIVOT_STRENGTH = 0.4; // Max pivot angle (radians per step)
    this.NOISE_SCALE = 0.08; // How fast the Perlin noise changes

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

    // Manually apply rotation with sub-stepping to ensure smoothness in High Res
    // AND avoid Rotation.animate() which forces history collapse (preserving FieldSample)
    const numSteps = Math.ceil(walkAngle / Rotation.MAX_ANGLE);
    const stepAngle = walkAngle / numSteps;
    const qStep = new THREE.Quaternion().setFromAxisAngle(walkAxis, stepAngle);

    for (let i = 0; i < numSteps; i++) {
      let currentQ = this.orientation.get().clone();
      currentQ.premultiply(qStep).normalize();
      this.orientation.push(currentQ);
    }
    let h = (this.history && typeof this.history.get === 'function') ? this.history.get() : this.history;
    if (Math.random() < 0.001) console.log("RW h:", h);
    this.orientation.collapse(h);
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
    const angle = progress * (Math.PI * 2 / this.numLines);

    this.params.aRe.set(s * Math.cos(angle));
    this.params.aIm.set(s * Math.sin(angle));
    this.params.dRe.set((1 / s) * Math.cos(-angle));
    this.params.dIm.set((1 / s) * Math.sin(-angle));
  }
}

/**
 * Animates the Mobius parameters for a warping effect pulling the poles together.
 */
export class MobiusWarp extends Animation {
  constructor(params, numRings, duration, repeat = true) {
    super(duration, repeat);
    this.params = params;
    this.numRings = numRings;
  }

  step() {
    super.step();
    const progress = this.t / this.duration;
    const angle = progress * Math.PI * 2;
    this.params.bRe.set(Math.cos(angle));
    this.params.bIm.set(Math.sin(angle));
  }
}