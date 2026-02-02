/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream, XY } from "./driver.js";
import { wrap } from "./util.js"
import { blendAlpha } from "./color.js";
import { colorPool } from "./memory.js";
import { vectorToPixel, angleBetween } from "./geometry.js";
import { vectorPool } from "./memory.js";
import { Plot } from "./plot.js";
import { tween } from "./animation.js";

import { TWO_PI } from "./3dmath.js";
import { StaticCircularBuffer } from "./StaticCircularBuffer.js";

class Trail3DNode {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.ttl = 0;
    this.data = null;
  }
}

class Trail2DNode {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.ttl = 0;
    this.data = null;
  }
}

const BLACK = new THREE.Color(0, 0, 0);
const _tempVec = new THREE.Vector3();

/**
 * Quintic kernel (smootherstep): 6t^5 - 15t^4 + 10t^3
 */
export const quinticKernel = (t) => {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Creates a render pipeline by chaining multiple filters together.
 * @param {...Object} filters - A variable number of filter objects (e.g., FilterAntiAlias, FilterOrient).
 * @returns {Object} An object with a `plot` method that initiates the pipeline.
 */
export function createRenderPipeline(...filters) {
  // Canvas sink
  let head = (x, y, colorInput, age, alpha, tag) => {
    let xi = ((x + 0.5) | 0) % Daydream.W;
    let yi = Math.max(0, Math.min(Daydream.H - 1, (y + 0.5) | 0));
    let index = XY(xi, yi);
    const color = colorInput.isColor ? colorInput : (colorInput.color || colorInput);
    const alphaMod = (colorInput.alpha !== undefined ? colorInput.alpha : 1.0);
    blendAlpha(index, color, alpha * alphaMod);
  };
  let nextIs2D = true;

  // Create Filter Chain
  for (let i = filters.length - 1; i >= 0; i--) {
    const filter = filters[i];
    const next = head;
    if (filter.is2D) {
      // 2D -> 2D
      const pass = (x, y, c, age, alpha, tag) => {
        next(x, y, c, age, alpha, tag);
      }
      head = (x, y, c, age, alpha, tag) => {
        filter.plot(x, y, c, age, alpha, tag, pass);
      };
    } else {
      if (nextIs2D) {
        // 3D -> 2D Rasterize
        const pass = (v, c, age, alpha, tag) => {
          const p = vectorToPixel(v);
          next(p.x, p.y, c, age, alpha, tag);
        }
        head = (v, c, age, alpha, tag) => {
          filter.plot(v, c, age, alpha, tag, pass);
        };
      } else {
        // 3D -> 3D
        const pass = (v, c, age, alpha, tag) => {
          next(v, c, age, alpha, tag);
        }
        head = (v, c, age, alpha, tag) => {
          filter.plot(v, c, age, alpha, tag, pass);
        };
      }
    }
    nextIs2D = filter.is2D;
  }

  // Define the trail propagator
  const trail = (trailFn, alpha) => {
    for (const filter of filters) {
      if (typeof filter.trail === 'function') {
        filter.trail(trailFn, alpha);
      }
    }
  };

  if (nextIs2D) {
    // Head is 2D filter
    return {
      // 3D Entry Point (Standard)
      plot: (v, c, age, alpha, tag) => {
        const p = vectorToPixel(v);
        head(p.x, p.y, c, age, alpha, tag);
      },
      // 2D Entry Point (New - For Scanners)
      plot2D: (x, y, c, age, alpha, tag) => {
        head(x, y, c, age, alpha, tag);
      },
      trail: trail
    };
  } else {
    // Pipeline starts with 3D filter (e.g. FilterOrient)
    // We cannot scan directly into this without un-projecting x,y -> v
    return {
      plot: head,
      plot2D: (x, y, c, age, alpha, tag) => {
        // Optional: Convert back to vector if needed, or throw error
        console.warn("Cannot scan 2D into 3D pipeline head");
      },
      trail: trail
    };
  }
}
/**
 * Implements anti-aliasing by distributing color across a 2x2 pixel grid.
 */
export class FilterAntiAlias {
  constructor() {
    this.is2D = true;
  }

  /**
   * Plots a pixel with anti-aliasing.
   * @param {number} x - The x coordinate.
   * @param {number} y - The y coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The initial age of the dots
   * @param {number} alpha - The opacity.
   * @param {Function} pass - The callback to pass the pixel to the next stage.
   */
  plot(x, y, color, age, alpha, tag, pass) {
    let xi = Math.trunc(x);
    let xm = x - xi;
    let yi = Math.trunc(y);
    let ym = y - yi;

    // 1. Calculate the smoothed fractional factors
    let xs = quinticKernel(xm);
    let ys = quinticKernel(ym);

    // 2. Calculate the four weights using the smoothed factors
    let v00 = (1 - xs) * (1 - ys);  // Top-Left weight
    let v10 = xs * (1 - ys);        // Top-Right weight
    let v01 = (1 - xs) * ys;        // Bottom-Left weight
    let v11 = xs * ys;              // Bottom-Right weight

    if (v00 > 0.0001) {
      pass(xi, yi, color, age, v00 * alpha, tag);
    }
    if (v10 > 0.0001) {
      pass(wrap((xi + 1), Daydream.W), yi, color, age, v10 * alpha, tag);
    }

    if (yi < Daydream.H - 1) {
      if (v01 > 0.0001) {
        pass(xi, yi + 1, color, age, v01 * alpha, tag);
      }
      if (v11 > 0.0001) {
        pass(wrap((xi + 1), Daydream.W), yi + 1, color, age, v11 * alpha, tag);
      }
    }
  }
}

/**
 * Orients the pixel coordinates based on a given Orientation object.
 */
export class FilterOrient {
  /**
   * @param {Orientation} orientation - The orientation quaternion object.
   */
  constructor(orientation) {
    this.is2D = false;
    this.orientation = orientation;
  }

  /**
   * Plots a 3D vector, applying the orientation.
   * @param {THREE.Vector3} v - The vector to plot.
   * @param {THREE.Color} color - The color.
   * @param {number} age - The initial age of the dots
   * @param {number} alpha - The opacity.
   * @param {Function} pass - The callback.
   */
  plot(v, color, age, alpha, tag, pass) {
    tween(this.orientation, (q, t) => {
      let v_oriented = vectorPool.acquire().copy(v).applyQuaternion(q);
      pass(v_oriented, color, age + 1.0 - t, alpha, tag);
    });
  }
}

/**
 * Applies different orientations to points in n latitude bands defined by axis.
 */
export class FilterOrientSlice {
  /**
   * @param {Orientation[]} orientations - Array of orientations (South to North).
   * @param {THREE.Vector3} axis - The axis defining the poles for slicing.
   */
  constructor(orientations, axis) {
    this.is2D = false;
    this.orientations = orientations;
    this.axis = axis;
  }

  plot(v, color, age, alpha, tag, pass) {
    const dot = Math.max(-1, Math.min(1, v.dot(this.axis)));
    const t = 1 - Math.acos(dot) / Math.PI;
    let idx = Math.floor(t * this.orientations.length);
    if (idx >= this.orientations.length) idx = this.orientations.length - 1;
    if (idx < 0) idx = 0;
    const orientation = this.orientations[idx];
    pass(orientation.orient(v), color, age, alpha, tag);
  }
}

export class FilterWorldTrails {
  constructor(lifespan, capacity = 4096) {
    this.is2D = false;
    this.lifespan = lifespan;
    this.buffer = new StaticCircularBuffer(capacity);
    this.pool = [];
  }

  plot(v, color, age, alpha, tag, pass) {
    this.pass = pass;
    pass(v, color, age, alpha, tag);

    // Reuse or create node
    let node = this.pool.pop();
    if (!node) node = new Trail3DNode();

    node.x = v.x;
    node.y = v.y;
    node.z = v.z;
    node.ttl = this.lifespan - age;
    node.data = (tag && tag.trailData) ? tag.trailData : null;

    this.buffer.push_back(node);
  }

  trail(trailFn, alpha = 1.0) {
    // Age
    for (const node of this.buffer) {
      node.ttl -= 1;
    }

    // Remove Dead
    while (!this.buffer.is_empty()) {
      const head = this.buffer.front();
      if (head.ttl <= 0) {
        this.buffer.pop();
        head.data = null;
        this.pool.push(head);
      } else {
        break;
      }
    }

    // Draw
    const v = vectorPool.acquire();
    for (const node of this.buffer) {
      v.set(node.x, node.y, node.z);

      const t = 1.0 - (node.ttl / this.lifespan);
      let res = trailFn(v, t, node.data);
      const color = res.isColor ? res : (res.color || res);
      const outputAlpha = (res.alpha !== undefined ? res.alpha : 1.0) * alpha;

      this.pass(v, color, this.lifespan - node.ttl, outputAlpha);
    }
  }
}

/**
 * Applies an alpha falloff based on distance from an origin point on the sphere.
 * Alpha falls off from 1.0 at `radius` to 0.0 at `0` distance using a quintic kernel.
 */
export class FilterHole {
  /**
   * @param {THREE.Vector3} origin - The center point of the falloff (normalized).
   * @param {number} radius - The radius (in radians) at which fading starts.
   */
  constructor(origin, radius) {
    this.origin = origin.clone().normalize();
    this.radius = radius;
  }

  plot(v, c, age, alpha, tag, pass) {
    const d = angleBetween(v, this.origin);
    if (d > this.radius) {
      pass(v, c, age, alpha, tag);
    } else {
      let t = d / this.radius;
      t = quinticKernel(t);

      const param = c.isColor ? c : (c.color || c);
      param.r *= t;
      param.g *= t;
      param.b *= t;
      pass(v, c, age, alpha, tag);
    }
  }
}

/**
 * Replicates the plotted pixel horizontally across the globe.
 */
export class FilterReplicate {
  /**
   * @param {number} count - The number of times to replicate the pixel across the width (Daydream.W).
   */
  constructor(count) {
    this.is2D = false;
    this.count = count;
    this.step = TWO_PI / count;
  }

  /**
   * Plots a 3D vector and its replicates.
   * @param {THREE.Vector3} v - The vector to plot.
   * @param {THREE.Color} color - The color.
   * @param {number} age - The initial age of the dots
   * @param {number} alpha - The opacity.
   * @param {Function} pass - The callback.
   */
  plot(v, color, age, alpha, tag, pass) {
    pass(v, color, age, alpha, tag);
    for (let i = 1; i < this.count; i++) {
      _tempVec.copy(v).applyAxisAngle(Daydream.Y_AXIS, this.step * i);
      pass(_tempVec, color, age, alpha, tag);
    }
  }
}


/**
 * Applies a Mobius Transformation to the 3D vectors.
 * Projects sphere -> complex plane -> transform -> sphere.
 */
export class FilterMobius {
  constructor() {
    this.is2D = false;
    // Transformation parameters: f(z) = (az + b) / (cz + d)
    // Initialized to Identity: f(z) = z  (a=1, b=0, c=0, d=1)
    this.a = { re: 1, im: 0 };
    this.b = { re: 0, im: 0 };
    this.c = { re: 0, im: 0 };
    this.d = { re: 1, im: 0 };
  }

  get aRe() { return this.a.re; }
  set aRe(v) { this.a.re = v; }
  get aIm() { return this.a.im; }
  set aIm(v) { this.a.im = v; }

  get bRe() { return this.b.re; }
  set bRe(v) { this.b.re = v; }
  get bIm() { return this.b.im; }
  set bIm(v) { this.b.im = v; }

  get cRe() { return this.c.re; }
  set cRe(v) { this.c.re = v; }
  get cIm() { return this.c.im; }
  set cIm(v) { this.c.im = v; }

  get dRe() { return this.d.re; }
  set dRe(v) { this.d.re = v; }
  get dIm() { return this.d.im; }
  set dIm(v) { this.d.im = v; }

  // Complex Multiply
  cmul(c1, c2) {
    return {
      re: c1.re * c2.re - c1.im * c2.im,
      im: c1.re * c2.im + c1.im * c2.re
    };
  }

  // Complex Add
  cadd(c1, c2) {
    return { re: c1.re + c2.re, im: c1.im + c2.im };
  }

  // Complex Divide
  cdiv(c1, c2) {
    const denom = c2.re * c2.re + c2.im * c2.im;
    if (denom === 0) return { re: 0, im: 0 };
    return {
      re: (c1.re * c2.re + c1.im * c2.im) / denom,
      im: (c1.im * c2.re - c1.re * c2.im) / denom
    };
  }

  plot(v, color, age, alpha, tag, pass) {
    // 1. Stereographic Projection (North Pole -> Plane)
    // Singularity check: If we are AT the North Pole, z_in is Infinity.
    // Möbius of Infinity is a/c.
    const denom = 1 - v.y;
    let w;

    if (Math.abs(denom) < 0.00001) {
      // Input is North Pole (Infinity)
      // Limit of (az+b)/(cz+d) as z->inf is a/c
      w = this.cdiv(this.a, this.c);
    } else {
      const z_in = { re: v.x / denom, im: v.z / denom };

      // w = (az + b) / (cz + d)
      const num = this.cadd(this.cmul(this.a, z_in), this.b);
      const den = this.cadd(this.cmul(this.c, z_in), this.d);

      // Check for division by zero (Map to North Pole)
      const den_mag = den.re * den.re + den.im * den.im;
      if (den_mag < 0.000001) {
        // Result is Infinity -> North Pole
        pass(Daydream.UP_AXIS, color, age, alpha, tag);
        return;
      }

      w = this.cdiv(num, den);
    }

    // 3. Inverse Stereographic Projection (Plane -> Sphere)
    const w_mag_sq = w.re * w.re + w.im * w.im;
    const inv_denom = 1 / (w_mag_sq + 1);

    const v_out = _tempVec.set(
      2 * w.re * inv_denom,
      (w_mag_sq - 1) * inv_denom,
      2 * w.im * inv_denom
    );

    pass(v_out, color, age, alpha, tag);
  }
}
///////////////////////////////////////////////////////////////////////////////
// 2D Filters
///////////////////////////////////////////////////////////////////////////////

/**
 * Splits the color into its R, G, B components and shifts them.
 */
export class FilterChromaticShift {
  constructor() {
    this.is2D = true;
  }

  /**
   * Plots a pixel, shifting RGB components to adjacent pixels.
   * @param {number} x - The x coordinate.
   * @param {number} y - The y coordinate.
   * @param {THREE.Color} color - The color.
   * @param {number} age - The initial age of the dots
   * @param {number} alpha - The opacity.
   * @param {Function} pass - The callback.
   */
  plot(x, y, colorInput, alpha, tag, pass) {
    const color = colorInput.isColor ? colorInput : (colorInput.color || colorInput);
    let r = colorPool.acquire().setRGB(color.r, 0, 0);
    let g = colorPool.acquire().setRGB(0, color.g, 0);
    let b = colorPool.acquire().setRGB(0, 0, color.b);
    pass(x, y, colorInput, alpha, tag);
    pass(wrap(x + 1, Daydream.W), y, r, alpha, tag);
    pass(wrap(x + 2, Daydream.W), y, g, alpha, tag);
    pass(wrap(x + 3, Daydream.W), y, b, alpha, tag);
  }
}


export class FilterScreenTrails {
  constructor(lifespan, maxCapacity = 10000) {
    this.is2D = true;
    this.lifespan = lifespan;
    this.buffer = new StaticCircularBuffer(maxCapacity);
    this.pool = [];
  }

  plot(x, y, color, age, alpha, tag, pass) {
    this.pass = pass;
    pass(x, y, color, age, alpha, tag);

    let node = this.pool.pop();
    if (!node) node = new Trail2DNode();

    node.x = x;
    node.y = y;
    node.ttl = this.lifespan - age;
    node.data = (tag && tag.trailData) ? tag.trailData : null;

    this.buffer.push_back(node);
  }

  trail(trailFn, alpha = 1.0) {
    // Age
    for (const node of this.buffer) {
      node.ttl -= 1;
    }

    // Remove Dead
    while (!this.buffer.is_empty()) {
      const head = this.buffer.front();
      if (head.ttl <= 0) {
        this.buffer.pop();
        head.data = null;
        this.pool.push(head);
      } else {
        break;
      }
    }

    // Draw
    for (const node of this.buffer) {
      const t = 1.0 - (node.ttl / this.lifespan);

      let res = trailFn(node.x, node.y, t, node.data);
      const color = res.isColor ? res : (res.color || res);
      const outputAlpha = (res.alpha !== undefined ? res.alpha : 1.0) * alpha;
      this.pass(node.x, node.y, color, this.lifespan - node.ttl, outputAlpha);
    }
  }
}

/**
 * Applies a variable 3x3 Gaussian Blur.
 * @param {number} factor - Blur intensity [0.0 to 1.0].
 */
export class FilterGaussianBlur {
  constructor(factor = 1.0) {
    this.is2D = true;

    // Clamp factor to valid range [0, 1]
    const f = Math.max(0, Math.min(1, factor));

    // Interpolate weights between Identity (Center=1) and Gaussian (Center=0.25)
    // Gaussian reference: Corner=1/16, Edge=2/16, Center=4/16
    const c = 1.0 - (0.75 * f); // Center weight: 1.0 -> 0.25
    const e = 0.125 * f;        // Edge weight:   0.0 -> 0.125
    const d = 0.0625 * f;       // Diagonal weight: 0.0 -> 0.0625

    // Flattened 3x3 kernel
    this.kernel = [
      d, e, d,
      e, c, e,
      d, e, d
    ];
  }

  update(factor) {
    // Clamp factor to valid range [0, 1]
    const f = Math.max(0, Math.min(1, factor));

    // Interpolate weights between Identity (Center=1) and Gaussian (Center=0.25)
    const c = 1.0 - (0.75 * f);
    const e = 0.125 * f;
    const d = 0.0625 * f;

    this.kernel = [
      d, e, d,
      e, c, e,
      d, e, d
    ];
  }

  plot(x, y, color, age, alpha, tag, pass) {
    const cx = Math.round(x);
    const cy = Math.round(y);

    let k = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = cy + dy;

      // Strict vertical bounds check
      if (ny >= 0 && ny < Daydream.H) {
        for (let dx = -1; dx <= 1; dx++) {
          const weight = this.kernel[k++];

          // Optimization: Skip zero-weight neighbors if factor is 0
          if (weight > 0.001) {
            pass(wrap(cx + dx, Daydream.W), ny, color, age, alpha * weight, tag);
          }
        }
      } else {
        k += 3; // Skip row
      }
    }
  }
}