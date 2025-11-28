// filters.js
import * as THREE from "three";
import { Daydream, pixelKey, keyPixel } from "./driver.js";
import { wrap } from "./util.js"
import { blendAlpha } from "./color.js";
import { vectorToPixel } from "./geometry.js";

const BLACK = new THREE.Color(0, 0, 0);

export function createRenderPipeline(...filters) {
  // Canvas sink
  let head = (pixels, x, y, color, alpha) => {
    let xi = Math.round(x);
    let yi = Math.round(y);
    let key = pixelKey(xi, yi);
    let old = 0;
    if (pixels.has(key)) {
      old = pixels.get(key);
    } else {
      old = BLACK;
    }
    pixels.set(pixelKey(x, y), blendAlpha(alpha)(old, color));
  };
  let nextIs2D = true;

  // Create Fiter Chain
  for (let i = filters.length - 1; i >= 0; i--) {
    const filter = filters[i];
    const next = head;
    if (filter.is2D) {
      // 2D -> 2D
      head = (pixels, x, y, c, alpha) => {
        const pass = (x, y, c, alpha) => {
          next(pixels, x, y, c, alpha);
        }
        filter.plot(x, y, c, alpha, pass);
      };
    } else {
      if (nextIs2D) {
        // 3D -> 2D Rasterize
        head = (pixels, v, c, alpha) => {
          const pass = (v, c, alpha) => {
            const p = vectorToPixel(v);
            next(pixels, p.x, p.y, c, alpha);
          }
          filter.plot(v, c, alpha, pass);
        };
      } else {
        // 3D -> 3D
        head = (pixels, v, c, alpha) => {
          const pass = (v, c, alpha) => {
            next(pixels, v, c, alpha);
          }
          filter.plot(v, c, alpha, pass);
        };
      }
      nextIs2D = false;
    }
  }

  if (nextIs2D) {
    // Head is 2D filter, rasterize first
    return {
      plot: (pixels, v, c, alpha) => {
        const p = vectorToPixel(v);
        head(pixels, p.x, p.y, c, alpha);
      }
    };
  } else {
    return {
      plot: head
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

  kernel(t) {
    return 6 * Math.pow(t, 5) - 15 * Math.pow(t, 4) + 10 * Math.pow(t, 3);
  }

  plot(x, y, color, alpha, pass) {
    let xi = Math.trunc(x);
    let xm = x - xi;
    let yi = Math.trunc(y);
    let ym = y - yi;

    // 1. Calculate the smoothed fractional factors
    let xs = this.kernel(xm);
    let ys = this.kernel(ym);

    // 2. Calculate the four weights using the smoothed factors
    let v00 = (1 - xs) * (1 - ys);  // Top-Left weight
    let v10 = xs * (1 - ys);        // Top-Right weight
    let v01 = (1 - xs) * ys;        // Bottom-Left weight
    let v11 = xs * ys;              // Bottom-Right weight

    if (v00 > 0.0001) {
      pass(xi, yi, color, v00 * alpha);
    }
    if (v10 > 0.0001) {
      pass(wrap((xi + 1), Daydream.W), yi, color, v10 * alpha);
    }

    if (yi < Daydream.H - 1) {
      if (v01 > 0.0001) {
        pass(xi, yi + 1, color, v01 * alpha);
      }
      if (v11 > 0.0001) {
        pass(wrap((xi + 1), Daydream.W), yi + 1, color, v11 * alpha);
      }
    }
  }
}

/**
 * Orients the pixel coordinates based on a given Orientation object.
 */
export class FilterOrient{
  /**
   * @param {Orientation} orientation - The orientation quaternion object.
   */
  constructor(orientation) {
    this.is2D = false;
    this.orientation = orientation;
  }

  plot(v, color, alpha, pass) {
    this.orientation.collapse();
    pass(this.orientation.orient(v), color, alpha);
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

  plot(v, color, alpha, pass) {
    pass(v, color, alpha);
    for (let i = 1; i < this.count; i++) {
      const r = v.clone().applyAxisAngle(Daydream.Y_AXIS, this.step * i);
      pass(r, color, alpha);
    }
  }
}

/**
 * Splits the color into its R, G, B components and shifts them.
 */
export class FilterChromaticShift {
  constructor() {
    this.is2D = true;
  }

  plot(x, y, color, alpha) {
    let r = new THREE.Color(color.r, 0, 0);
    let g = new THREE.Color(0, color.g, 0);
    let b = new THREE.Color(0, 0, color.b);
    pass(x, y, color, alpha);
    pass(wrap(x + 1, Daydream.W), y, r, alpha);
    pass(wrap(x + 2, Daydream.W), y, g, alpha);
    pass(wrap(x + 3, Daydream.W), y, b, alpha);
  }
}


export class FilterDecay2D {
  /**
   * @param {number} lifespan - How many frames a trail pixel persists.
   */
  constructor(lifespan) {
    this.is2D = true;
    this.lifespan = lifespan;
    this.trails = new Map();
  }

  plot(x, y, color, alpha, pass) {
    this.pass = pass;
    pass(x, y, color, alpha);
    const key = pixelKey(x, y);
    const ttl = this.trails.get(key) || 0;
    if (this.lifespan > ttl) {
      this.trails.set(key, this.lifespan); 
    }
  }

  trail(trailFn, alpha) {
    for (const [key, ttl] of this.trails) {
      if (ttl > 0) {
        let p = keyPixel(key);
        let color = trailFn(p[0], p[1], 1 - (ttl / this.lifespan));
        //       labels.push({ position: pixelToVector(p[0], p[1]), content: `${parseFloat(p[0]).toFixed(1)}, ${parseFloat(p[1]).toFixed(1)}` });
        this.pass(p[0], p[1], color, alpha);
      }
    }
    this.decay();
  }

  decay() {
    this.trails.forEach((ttl, key) => {
      ttl -= 1;
      if (ttl <= 0) {
        this.trails.delete(key);
      } else {
        this.trails.set(key, ttl);
      }
    });
  }
}