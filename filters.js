/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream, XY } from "./driver.js";
import { wrap } from "./util.js"
import { blendAlpha, Color4 } from "./color.js";
import { colorPool, fragmentPool } from "./memory.js";
import { vectorToPixel, angleBetween, mobiusTransform } from "./geometry.js";
import { vectorPool } from "./memory.js";
import { Plot } from "./plot.js";
import { tween } from "./animation.js";

/** 
 * Data Packet for Shader Mode.
 * Ensures stable Hidden Class for V8 Optimization.
 */
export class Fragment {
  constructor() {
    this.pos = new THREE.Vector3(); // Pre-allocate vector
    // Data Registers (Scalar slots for varying data)
    this.v0 = 0;
    this.v1 = 0;
    this.v2 = 0;
    this.v3 = 0;
    this.age = 0; // Added based on User Request (Fragment becomes source of truth)

    // Outputs
    this.color = new Color4(0, 0, 0, 0);
    this.blend = 0; // Default: 0 (Normal)
  }
}

// Inject Type into Pool (Break Cycle)
fragmentPool.Type = Fragment;

import { TWO_PI, MobiusParams } from "./3dmath.js";
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
  /* 
   * Blend Mode Registry:
   * 0: Normal (Over)
   * 1: Additive (Add)
   * 2: Max (Lighten)
   */
  const BLEND_MODES = ['over', 'add', 'max'];

  // Canvas sink
  let head = (x, y, colorInput, age, alpha, tag) => {
    let xi = ((x + 0.5) | 0) % Daydream.W;
    let yi = Math.max(0, Math.min(Daydream.H - 1, (y + 0.5) | 0));
    let index = XY(xi, yi);
    const color = colorInput.isColor ? colorInput : (colorInput.color || colorInput);
    const alphaMod = (colorInput.alpha !== undefined ? colorInput.alpha : 1.0);

    let mode = 'over';
    if (typeof tag === 'number') {
      mode = BLEND_MODES[tag] || 'over';
    } else if (tag && tag.blendMode) {
      mode = tag.blendMode;
    }

    blendAlpha(index, color, alpha * alphaMod, mode);
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
  const flush = (trailFn, alpha) => {
    for (const filter of filters) {
      if (typeof filter.flush === 'function') {
        filter.flush(trailFn, alpha);
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
      flush: flush
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
      flush: flush
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
    this.enabled = true;
  }

  plot(v, color, age, alpha, tag, pass) {
    if (!this.enabled) {
      pass(v, color, age, alpha, tag);
      return;
    }
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

  flush(trailFn, alpha = 1.0) {
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
    this.is2D = false;
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
/**
 * Applies a Mobius Transformation to the 3D vectors.
 * Projects sphere -> complex plane -> transform -> sphere.
 */
export class FilterMobius {
  constructor() {
    this.is2D = false;
    this.params = new MobiusParams();
  }

  plot(v, color, age, alpha, tag, pass) {
    const v_out = mobiusTransform(v, this.params);
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

  flush(trailFn, alpha = 1.0) {
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


class TemporalNode {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.color = null;
    this.age = 0;
    this.alpha = 0;
    this.tag = null;
    this.ttl = 0;
  }
}

/**
 * Delays pixel drawing by a TTL determined by a function.
 */
/**
 * Optimized Temporal Filter using TypedArray Linked Lists.
 * - Zero Garbage Collection (Pre-allocated memory)
 * - O(1) Insertion / Free
 * - O(Window) Flush
 */
export class FilterTemporal {
  /**
   * @param {Function} ttlFn - Function(x, y) => delay frames (float)
   * @param {number} windowSize - TAA Window (e.g. 1.5 frames)
   * @param {number} maxDelay - Maximum supported delay in frames (e.g. 300)
   * @param {number} capacity - Maximum number of active particles (e.g. 1,000,000)
   */
  constructor(ttlFn, windowSize = 1.5, maxDelay = 300, capacity = 1000000) {
    this.is2D = true;
    this.ttlFn = ttlFn;
    this.windowSize = windowSize;
    this.capacity = capacity;

    // Buffer Stats
    this.bufferSize = maxDelay + Math.ceil(windowSize) * 2 + 10;
    this.currentFrame = 0;

    // Data Store (Stride = 8)
    // [x, y, r, g, b, a, age, targetTime]
    this.STRIDE = 8;
    this.data = new Float32Array(capacity * this.STRIDE);

    // Linked List Pointers
    // nextPtrs[i] points to the index of the next node in the chain
    this.nextPtrs = new Int32Array(capacity).fill(-1);

    // Buckets (Heads of Linked Lists)
    // buckets[i] points to the index of the first node in the bucket
    this.buckets = new Int32Array(this.bufferSize).fill(-1);

    // Tag Storage (Parallel Array for Objects)
    this.tags = new Array(capacity).fill(null);

    // Free List Management
    this.freeHead = 0;
    for (let i = 0; i < capacity - 1; i++) {
      this.nextPtrs[i] = i + 1;
    }
    this.nextPtrs[capacity - 1] = -1; // End of free list

    // Reusable scratch object
    this._tempColor = { r: 0, g: 0, b: 0 };
  }

  plot(x, y, colorInput, age, alpha, tag, pass) {
    this.pass = pass;

    // 1. Calculate absolute target frame
    const fDelay = this.ttlFn(x, y);
    const delay = Math.max(0, fDelay); // Safety
    const targetTime = this.currentFrame + delay;

    // 2. Determine Bucket Index
    const bucketIndex = Math.floor(targetTime) % this.bufferSize;

    // 3. Allocate Node
    const nodeIdx = this.freeHead;
    if (nodeIdx === -1) {
      // Out of memory - drop particle
      return;
    }
    // Pop from free list
    this.freeHead = this.nextPtrs[nodeIdx];

    // 4. Write Data
    const base = nodeIdx * this.STRIDE;

    // Flatten Color
    let r, g, b, a;
    if (colorInput.isColor) {
      r = colorInput.r; g = colorInput.g; b = colorInput.b; a = alpha;
    } else if (colorInput.color) {
      r = colorInput.color.r; g = colorInput.color.g; b = colorInput.color.b;
      a = (colorInput.alpha !== undefined ? colorInput.alpha : 1.0) * alpha;
    } else {
      r = colorInput.r; g = colorInput.g; b = colorInput.b; a = alpha;
    }

    this.data[base] = x;
    this.data[base + 1] = y;
    this.data[base + 2] = r;
    this.data[base + 3] = g;
    this.data[base + 4] = b;
    this.data[base + 5] = a;
    this.data[base + 6] = age;
    this.data[base + 7] = targetTime;

    this.tags[nodeIdx] = tag; // Store tag reference

    // 5. Link to Bucket (Prepend)
    this.nextPtrs[nodeIdx] = this.buckets[bucketIndex]; // Point to old head
    this.buckets[bucketIndex] = nodeIdx; // Become new head
  }

  flush(unused, globalAlpha) {
    if (!this.pass) return;

    const frame = this.currentFrame;
    const win = this.windowSize;

    // 1. Iterate Active Window
    const start = Math.floor(frame - win);
    const end = Math.ceil(frame + win);

    for (let f = start; f <= end; f++) {
      let idx = f % this.bufferSize;
      if (idx < 0) idx += this.bufferSize;

      // Walk Linked List
      let curr = this.buckets[idx];
      while (curr !== -1) {
        const base = curr * this.STRIDE;
        const targetTime = this.data[base + 7];

        // TAA Weight
        const dist = Math.abs(targetTime - frame);
        if (dist <= win) {
          const intensity = 1.0 - (dist / win);

          if (intensity > 0.01) {
            // Reconstruct Color
            this._tempColor.r = this.data[base + 2];
            this._tempColor.g = this.data[base + 3];
            this._tempColor.b = this.data[base + 4];

            this.pass(
              this.data[base],     // x
              this.data[base + 1], // y
              this._tempColor,
              this.data[base + 6], // age
              this.data[base + 5] * intensity * globalAlpha, // alpha
              this.tags[curr]      // tag
            );
          }
        }
        curr = this.nextPtrs[curr];
      }
    }

    // 2. Clean Up Old Bucket
    // The bucket at `frame - win - 1` has completely fallen out of scope.
    const cleanFrame = Math.floor(frame - win - 1);
    let cleanIdx = cleanFrame % this.bufferSize;
    if (cleanIdx < 0) cleanIdx += this.bufferSize;

    // Walk the entire chain and return to free list
    let head = this.buckets[cleanIdx];
    if (head !== -1) {
      // Find tail of this chain
      let tail = head;
      let count = 0;
      while (true) {
        this.tags[tail] = null; // Clear tag reference to avoid leaks
        const next = this.nextPtrs[tail];
        if (next === -1) break;
        tail = next;
        count++;
      }

      // Link entire chain to free list
      this.nextPtrs[tail] = this.freeHead;
      this.freeHead = head;

      // Empty the bucket
      this.buckets[cleanIdx] = -1;
    }

    // 3. Advance Time
    this.currentFrame++;
  }
}
