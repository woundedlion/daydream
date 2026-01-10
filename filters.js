/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream, XY } from "./driver.js";
import { wrap } from "./util.js"
import { blendAlpha } from "./color.js";
import { vectorToPixel, angleBetween } from "./geometry.js";
import { tween } from "./draw.js";

const BLACK = new THREE.Color(0, 0, 0);

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
  let head = (pixels, x, y, colorInput, age, alpha) => {
    let xi = ((x + 0.5) | 0) % Daydream.W;
    let yi = Math.max(0, Math.min(Daydream.H - 1, (y + 0.5) | 0));
    let index = XY(xi, yi);
    const color = colorInput.isColor ? colorInput : (colorInput.color || colorInput);
    const alphaMod = (colorInput.alpha !== undefined ? colorInput.alpha : 1.0);
    blendAlpha(Daydream.pixels[index], color, alpha * alphaMod, Daydream.pixels[index]);
  };
  let nextIs2D = true;

  // Create Filter Chain
  for (let i = filters.length - 1; i >= 0; i--) {
    const filter = filters[i];
    const next = head;
    if (filter.is2D) {
      // 2D -> 2D
      const pass = (x, y, c, age, alpha) => {
        next(Daydream.pixels, x, y, c, age, alpha);
      }
      head = (pixels, x, y, c, age, alpha) => {
        filter.plot(x, y, c, age, alpha, pass);
      };
    } else {
      if (nextIs2D) {
        // 3D -> 2D Rasterize
        const pass = (v, c, age, alpha) => {
          const p = vectorToPixel(v);
          next(Daydream.pixels, p.x, p.y, c, age, alpha);
        }
        head = (pixels, v, c, age, alpha) => {
          filter.plot(v, c, age, alpha, pass);
        };
      } else {
        // 3D -> 3D
        const pass = (v, c, age, alpha) => {
          next(Daydream.pixels, v, c, age, alpha);
        }
        head = (pixels, v, c, age, alpha) => {
          filter.plot(v, c, age, alpha, pass);
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
      plot: (pixels, v, c, age, alpha) => {
        const p = vectorToPixel(v);
        head(pixels, p.x, p.y, c, age, alpha);
      },
      // 2D Entry Point (New - For Scanners)
      plot2D: (pixels, x, y, c, age, alpha) => {
        head(pixels, x, y, c, age, alpha);
      },
      trail: trail
    };
  } else {
    // Pipeline starts with 3D filter (e.g. FilterOrient)
    // We cannot scan directly into this without un-projecting x,y -> v
    return {
      plot: head,
      plot2D: (pixels, x, y, c, age, alpha) => {
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
  plot(x, y, color, age, alpha, pass) {
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
      pass(xi, yi, color, age, v00 * alpha);
    }
    if (v10 > 0.0001) {
      pass(wrap((xi + 1), Daydream.W), yi, color, age, v10 * alpha);
    }

    if (yi < Daydream.H - 1) {
      if (v01 > 0.0001) {
        pass(xi, yi + 1, color, age, v01 * alpha);
      }
      if (v11 > 0.0001) {
        pass(wrap((xi + 1), Daydream.W), yi + 1, color, age, v11 * alpha);
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
  plot(v, color, age, alpha, pass) {
    tween(this.orientation, (q, t) => {
      pass(v.clone().applyQuaternion(q), color, age + 1.0 - t, alpha);
    });
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
    this.step = 2 * Math.PI / count;
  }

  /**
   * Plots a 3D vector and its replicates.
   * @param {THREE.Vector3} v - The vector to plot.
   * @param {THREE.Color} color - The color.
   * @param {number} age - The initial age of the dots
   * @param {number} alpha - The opacity.
   * @param {Function} pass - The callback.
   */
  plot(v, color, age, alpha, pass) {
    pass(v, color, age, alpha);
    for (let i = 1; i < this.count; i++) {
      const r = v.clone().applyAxisAngle(Daydream.Y_AXIS, this.step * i);
      pass(r, color, age, alpha);
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

  plot(v, color, age, alpha, pass) {
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
        pass(new THREE.Vector3(0, 1, 0), color, age, alpha);
        return;
      }

      w = this.cdiv(num, den);
    }

    // 3. Inverse Stereographic Projection (Plane -> Sphere)
    const w_mag_sq = w.re * w.re + w.im * w.im;
    const inv_denom = 1 / (w_mag_sq + 1);

    const v_out = new THREE.Vector3(
      2 * w.re * inv_denom,
      (w_mag_sq - 1) * inv_denom,
      2 * w.im * inv_denom
    );

    pass(v_out, color, age, alpha);
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
  plot(x, y, color, alpha, pass) {
    let r = new THREE.Color(color.r, 0, 0);
    let g = new THREE.Color(0, color.g, 0);
    let b = new THREE.Color(0, 0, color.b);
    pass(x, y, color, alpha);
    pass(wrap(x + 1, Daydream.W), y, r, alpha);
    pass(wrap(x + 2, Daydream.W), y, g, alpha);
    pass(wrap(x + 3, Daydream.W), y, b, alpha);
  }
}


export class FilterDecay {
  constructor(lifespan, maxCapacity = 10000) {
    this.is2D = true;
    this.lifespan = lifespan;
    this.count = 0;

    // Pre-allocate memory (like StaticCircularBuffer in C++)
    this.xs = new Float32Array(maxCapacity);
    this.ys = new Float32Array(maxCapacity);
    this.ttls = new Float32Array(maxCapacity);
  }

  plot(x, y, color, age, alpha, pass) {
    this.pass = pass; // saved for trail injection
    pass(x, y, color, age, alpha);

    // Record for trail (if buffer isn't full)
    if (this.count < this.ttls.length) {
      const i = this.count;
      this.xs[i] = x;
      this.ys[i] = y;
      this.ttls[i] = this.lifespan - age;
      this.count++;
    }
  }

  trail(trailFn, alpha) {
    let i = 0;
    // Single Loop: Render AND Decay/Compact in one pass
    while (i < this.count) {
      // 1. Render Current Particle
      const ttl = this.ttls[i];
      const x = this.xs[i];
      const y = this.ys[i];

      // Calculate palette progress
      const t = 1.0 - (ttl / this.lifespan);

      let res = trailFn(x, y, t);
      const color = res.isColor ? res : (res.color || res);
      const outputAlpha = (res.alpha !== undefined ? res.alpha : 1.0) * alpha;

      this.pass(x, y, color, this.lifespan - ttl, outputAlpha);

      // 2. Decay
      this.ttls[i] -= 1;

      // 3. Remove if Dead (Swap-Remove Logic)
      if (this.ttls[i] <= 0) {
        this.count--; // Shrink size

        if (i < this.count) {
          // Swap the last element into the current slot
          this.xs[i] = this.xs[this.count];
          this.ys[i] = this.ys[this.count];
          this.ttls[i] = this.ttls[this.count];
          // Do NOT increment i; we need to process the swapped-in element
        }
      } else {
        // Pixel survived, move to next
        i++;
      }
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

  plot(v, c, age, alpha, pass) {
    const d = angleBetween(v, this.origin);
    if (d > this.radius) {
      pass(v, c, age, alpha);
    } else {
      let t = d / this.radius;
      t = quinticKernel(t);
      c.r *= t;
      c.g *= t;
      c.b *= t;
      pass(v, c, age, alpha);
    }
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

  plot(v, color, age, alpha, pass) {
    const dot = Math.max(-1, Math.min(1, v.dot(this.axis)));
    const t = 1 - Math.acos(dot) / Math.PI;
    let idx = Math.floor(t * this.orientations.length);
    if (idx >= this.orientations.length) idx = this.orientations.length - 1;
    if (idx < 0) idx = 0;
    const orientation = this.orientations[idx];
    pass(orientation.orient(v), color, age, alpha);
  }
}
