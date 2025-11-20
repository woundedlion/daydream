import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween } from "./geometry.js";
import FastNoiseLite from "./FastNoiseLite.js";

export const easeOutElastic = (x) => {
  const c4 = (2 * Math.PI) / 3;
  return x === 0 ?
    0 : x === 1 ?
      1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}

export const easeInOutBicubic = (t) => {
  return t < 0.5 ? 4 * Math.pow(t, 3) : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export const easeInOutSin = (t) => {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

export const easeInSin = (t) => {
  return 1 - Math.cos((t * Math.PI) / 2);
}

export const easeOutSin = (t) => {
  return Math.sin((t * Math.PI) / 2);
}

export const easeOutExpo = (t) => {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

export const easeOutCirc = (t) => {
  return Math.sqrt(1 - Math.pow(t - 1, 2));
}

export const easeInCubic = (t) => {
  return Math.pow(t, 3);
}

export const easeInCirc = (t) => {
  return 1 - Math.sqrt(1 - Math.pow(t, 2));
}

export const easeMid = (t) => {
  return t;
}

export const easeOutCubic = (t) => {
  return 1 - Math.pow(1 - t, 3);
}

export class Timeline {
  constructor() {
    this.t = 0;
    this.animations = [];
  }

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

  step() {
    ++this.t;
    let i = this.animations.length;
    while (i--) {
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
          animation.post();
        }
      }
    }
  }
}

export class Animation {
  constructor(duration, repeat) {
    this.duration = duration == 0 ? 1 : duration;
    this.repeat = repeat;
    this.t = 0;
    this.canceled = false;
    this.post = () => { };
  }

  cancel() { this.canceled = true; }
  done() { return this.canceled || (this.duration >= 0 && this.t >= this.duration); }

  step() {
    this.t++;
  }

  rewind() {
    this.t = 0;
  }

  then(post) {
    this.post = post;
    return this;
  }

  post() {
    this.post();
  }
}
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

  spawn(p) {
    this.particles.push(new ParticleSystem.Particle(p));
  }

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


export class RandomTimer extends Animation {
  constructor(min, max, f, repeat = false) {
    super(-1, repeat);
    this.min = min;
    this.max = max;
    this.f = f;
    this.next = 0;
    this.reset();
  }

  reset(t) {
    this.next = this.t + Math.round(Math.random() * (this.max - this.min) + this.min);
  }

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
    super.step();
  }
}

export class PeriodicTimer extends Animation {
  constructor(period, f, repeat = false) {
    super(-1, repeat);
    this.period = period;
    this.f = f;
    this.reset();
  }

  reset() {
    this.next = this.t + this.period;
  }

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

export class MutableNumber {
  constructor(n) {
    this.n = n;
  }
  get() { return this.n; }
  set(n) { this.n = n; }
}

export class Transition extends Animation {
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

export class Mutation extends Animation {
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

export class Sprite extends Animation {
  constructor(drawFn, duration,
    fadeInDuration = 0, fadeInEasingFn = easeMid,
    fadeOutDuration = 0, fadeOutEasingFn = easeMid)
  {
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
export class Motion extends Animation {
  static get MAX_ANGLE() { return 2 * Math.PI / Daydream.W; }

  static animate(orientation, path) {
    let m = new Motion(orientation, path, 1, false);
    m.step();
  }

  constructor(orientation, path, duration, repeat = false) {
    super(duration, repeat);
    this.orientation = orientation;
    this.path = path;
  }

  step() {
    if (this.t == 0) {
      this.to = this.path.getPoint(0);
    }
    super.step();
    this.orientation.collapse();
    this.from = this.to;
    this.to = this.path.getPoint(this.t / this.duration);
    if (!this.from.equals(this.to)) {
      let axis = new THREE.Vector3().crossVectors(this.from, this.to).normalize();
      let angle = angleBetween(this.from, this.to);
      let step_angle = angle / Math.ceil(angle / Motion.MAX_ANGLE);
      let origin = this.orientation.get();
      for (let a = step_angle; angle - a > 0.0001; a += step_angle) {
        let r = new THREE.Quaternion().setFromAxisAngle(axis, a);
        this.orientation.push(origin.clone().premultiply(r));
      }
      let r = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      this.orientation.push(origin.clone().premultiply(r));
    }
  }
}
export class Rotation extends Animation {
  static get MAX_ANGLE() {
    return 2 * Math.PI / Daydream.W;
  }
  static animate(orientation, axis, angle, easingFn) {
    let r = new Rotation(orientation, axis, angle, 1, easingFn, false);
    r.step();
  }

  constructor(orientation, axis, angle, duration, easingFn, repeat = false) {
    super(duration, repeat);
    this.orientation = orientation;
    this.axis = axis;
    this.totalAngle = angle;
    this.easingFn = easingFn;
    this.origin = orientation.get().clone();
    this.last_angle = 0.0;
  }

  step() {
    if (this.t == 0) {
      this.last_angle = 0;
      this.origin = this.orientation.get().clone();
    }
    super.step();
    this.orientation.collapse();
    let angle = this.easingFn(this.t / this.duration) * this.totalAngle;
    let delta = angle - this.last_angle;
    if (Math.abs(delta) > 0.0001) {
      const step = delta / Math.ceil(Math.abs(delta) / Rotation.MAX_ANGLE);
      for (let a = this.last_angle + step; Math.abs(angle - a) > 0.0001; a += step) {
        let r = new THREE.Quaternion().setFromAxisAngle(this.axis, a);
        this.orientation.push(this.origin.clone().premultiply(r));
      }
      let r = new THREE.Quaternion().setFromAxisAngle(this.axis, angle);
      this.orientation.push(this.origin.clone().premultiply(r));
      this.last_angle = angle;
    }
  }
}

export class RandomWalk extends Animation {
  constructor(orientation, v_start) {
    super(-1, false);
    this.orientation = orientation;
    this.v = v_start.clone();
    
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
    Rotation.animate(this.orientation, walkAxis, walkAngle, easeMid);
  }
}

export class ColorWipe extends Animation {
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
    this.curPalette.a.lerpColors(this.a0, this.toPalette.a, easingFn(this.t / this.duration));
    this.curPalette.b.lerpColors(this.b0, this.toPalette.b, easingFn(this.t / this.duration));
    this.curPalette.c.lerpColors(this.c0, this.toPalette.c, easingFn(this.t / this.duration));
  }
}