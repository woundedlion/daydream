// filters.js
import * as THREE from "three";
import { Daydream, pixelKey, keyPixel } from "./driver.js";
import { pixelToSpherical, sphericalToPixel, squareWave } from "./geometry.js";
import { wrap } from "./util.js"
import { blendAlpha } from "./color.js";

/**
 * The base class for all image processing filters.
 * Filters are chained together to apply multiple effects.
 */
export class Filter {
  /**
   * Chains this filter to the next filter in the pipeline.
   * @param {Filter} nextFilter - The next filter object to call.
   * @returns {Filter} The next filter instance.
   */
  chain(nextFilter) {
    this.next = nextFilter;
    return nextFilter;
  }

  /**
   * Passes the plotting request to the next filter in the chain,
   * or performs the final pixel operation if this is the last filter.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate (can be float before final step).
   * @param {number} y - The y-coordinate (can be float before final step).
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment (for decay/trails).
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  pass(pixels, x, y, color, age, alpha) {
    if (this.next === undefined) {
      x = Math.round(x);
      y = Math.round(y);
      let key = pixelKey(x, y);
      let old = 0;
      if (pixels.has(key)) {
        old = pixels.get(key);
      } else {
        old = new THREE.Color(0, 0, 0);
      }
      pixels.set(pixelKey(x, y), blendAlpha(alpha)(old, color));
    } else {
      this.next.plot(pixels, x, y, color, age, alpha);
    }
  }

  /**
   * Propagates the decay signal through the filter chain.
   */
  decay() {
    if (this.next !== undefined) {
      this.next.decay();
    }
  }

  /**
   * Propagates the trail drawing signal through the filter chain.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {Function} trailFn - Function to generate color for trails (takes x, y, age_ratio).
   * @param {number} alpha - The opacity/coverage for the trail.
   */
  trail(pixels, trailFn, alpha) {
    if (this.next !== undefined) {
      this.next.trail(pixels, trailFn, alpha);
    }
  }
}

/**
 * Orients the pixel coordinates based on a given Orientation object.
 */
export class FilterOrient extends Filter {
  /**
   * @param {Orientation} orientation - The orientation quaternion object.
   */
  constructor(orientation) {
    super();
    this.orientation = orientation;
  }

  /**
   * Converts pixel coordinates to a 3D vector, applies the orientation,
   * converts back to pixel coordinates, and passes the result.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    let v = new THREE.Vector3()
      .setFromSpherical(pixelToSpherical(x, y));
    let r = sphericalToPixel(new THREE.Spherical()
      .setFromVector3(this.orientation.orient(v)));
    this.orientation.collapse();
    this.pass(pixels, r.x, r.y, color, age, alpha);
  }
}

/**
 * A pass-through filter that does no processing, used as a raw entry point.
 */
export class FilterRaw extends Filter {
  /**
   * Passes the raw coordinates and color to the next filter or performs final plot.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    this.pass(pixels, x, y, color, age, alpha);
  }
}

/**
 * A placeholder filter for future function-based operations.
 */
export class FilterFn extends Filter {
  /**
   * @param {Function} fn - The function to execute (currently unused in plot logic).
   */
  constructor(fn) {
    super();
    this.fn = fn();
  }

  /**
   * Passes the data through without modification.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    this.pass(pixels, x, y, color, age, alpha);
  }
}


/**
 * Replicates the plotted pixel horizontally across the globe.
 */
export class FilterReplicate extends Filter {
  /**
   * @param {number} count - The number of times to replicate the pixel across the width (Daydream.W).
   */
  constructor(count) {
    super();
    this.count = count;
  }

  /**
   * Replicates the point `count` times across the x-axis, maintaining y.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    for (let i = 0; i < Daydream.W; i += Daydream.W / this.count) {
      this.pass(pixels, wrap(x + Math.floor(i), Daydream.W), y, color, age, alpha);
    }
  }
}

/**
 * Mirrors the plotted pixel across the center of the sphere.
 */
export class FilterMirror extends Filter {
  constructor() {
    super();
  }

  /**
   * Passes the original point and a mirrored point (Daydream.W - x, Daydream.H - y).
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    this.pass(pixels, x, y, color, age, alpha);
    this.pass(pixels, Daydream.W - x - 1, Daydream.H - y - 1, color, age, alpha);
  }
}


/**
 * Placeholder function for calculating color falloff/vignette.
 * @param {THREE.Color} c - The input color.
 * @returns {THREE.Color} The processed color (currently returns c unchanged).
 */
export const falloff = (c) => {
  return c;
}

/**
 * Implements anti-aliasing by distributing color across a 2x2 pixel grid.
 */
export class FilterAntiAlias extends Filter {
  /**
   * Distributes the color to four surrounding pixels based on the fractional parts of x and y.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The floating-point x-coordinate.
   * @param {number} y - The floating-point y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
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
      this.pass(pixels, xi, yi, color, age, v00 * alpha);
    }
    if (v10 > 0.0001) {
      this.pass(pixels, wrap((xi + 1), Daydream.W), yi, color, age, v10 * alpha);
    }

    if (yi < Daydream.H - 1) {
      if (v01 > 0.0001) {
        this.pass(pixels, xi, yi + 1, color, age, v01 * alpha);
      }
      if (v11 > 0.0001) {
        this.pass(pixels, wrap((xi + 1), Daydream.W), yi + 1, color, age, v11 * alpha);
      }
    }
  }

  kernel(t) {
    return 6 * Math.pow(t, 5) - 15 * Math.pow(t, 4) + 10 * Math.pow(t, 3);
  }

}

/**
 * Displaces the x-coordinate based on a sinusoidal function.
 */
export class FilterSinDisplace extends Filter {
  /**
   * @param {number} phase - The base phase offset.
   * @param {Function} amplitudeFn - Function that returns the amplitude (takes t).
   * @param {Function} freqFn - Function that returns the frequency (takes t).
   * @param {Function} phaseSpeedFn - Function that returns the phase speed (takes t).
   */
  constructor(phase, amplitudeFn, freqFn, phaseSpeedFn) {
    super();
    this.amplitudeFn = amplitudeFn;
    this.freqFn = freqFn;
    this.phaseSpeedFn = phaseSpeedFn;
    this.phase = phase;
    this.t = 0;
  }

  /**
   * Advances the internal time and updates the phase.
   */
  shift() {
    ++this.t;
    this.phase += this.phaseSpeedFn(this.t);
  }

  /**
   * Calculates the new x-coordinate and passes the request.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    let dx = wrap(
      x + this.amplitudeFn(this.t) * Math.sin(
        this.freqFn(this.t) * (((y / (Daydream.H - 1)) * 2 * Math.PI) + this.phase)
      ), Daydream.W);
    this.pass(pixels, dx, y, color, age, alpha);
  }
}

/**
 * Splits the color into its R, G, B components and shifts them.
 */
export class FilterChromaticShift extends Filter {
  /**
   * @param {Function} magnitudeFn - Function that returns the shift magnitude (currently unused).
   */
  constructor(magnitudeFn) {
    super();
    this.magnitudeFn = magnitudeFn;
    this.t = 0;
  }

  /**
   * Plots the original color, then plots the red, green, and blue channels
   * with a horizontal offset.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    let r = new THREE.Color(color.r, 0, 0);
    let g = new THREE.Color(0, color.g, 0);
    let b = new THREE.Color(0, 0, color.b);
    this.pass(pixels, x, y, color, age, alpha);
    this.pass(pixels, wrap(x + 1, Daydream.W), y, r, age, alpha);
    this.pass(pixels, wrap(x + 2, Daydream.W), y, g, age, alpha);
    this.pass(pixels, wrap(x + 3, Daydream.W), y, b, age, alpha);

  }
}

/**
 * Applies a color transformation function to the plotted pixel.
 */
export class FilterColorShift extends Filter {
  /**
   * @param {Function} colorShiftFn - Function that returns a transformed color (takes x, y, color).
   */
  constructor(colorShiftFn) {
    super();
    this.colorShiftFn = colorShiftFn;
    this.t = 0;
  }

  /**
   * Applies the color transformation before passing the result to the next filter.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The original color.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    this.pass(pixels, x, y, this.colorShiftFn(x, y, color), age, alpha);
  }
}

/**
 * Generates a repeatable hash for a 32-bit integer.
 * @param {number} n - The integer to hash.
 * @returns {number} A 32-bit integer hash.
 */
export function hashInt(n) {
  // Force to 32-bit integer for consistent behavior
  n = n | 0;

  // Mixing operations (variant of MurmurHash3 finalizer)
  n = ((n >> 16) ^ n) * 0x45d9f3b;
  n = ((n >> 16) ^ n) * 0x45d9f3b;
  n = ((n >> 16) ^ n);
  return n;
}

/**
 * Adds a twinkling effect by modulating the color brightness based on time and a random spatial hash.
 */
export class FilterTwinkle extends Filter {
  /**
   * @param {number} amplitude - The base magnitude of the brightness modulation.
   * @param {number} freq - The frequency of the time-based modulation.
   */
  constructor(amplitude, freq) {
    super();
    this.amplitude = amplitude;
    this.freq = freq;
    this.t = 0;
  }

  /**
   * Advances the internal time counter.
   */
  twinkle() {
    ++this.t;
  }

  /**
   * Generates a repeatable phase shift for a given pixel coordinate.
   * @param {number} x - The integer x-coordinate.
   * @param {number} y - The integer y-coordinate.
   * @returns {number} A phase value in the range [0, 2 * PI).
   */
  randomPhase(x, y) {
    // 1. Combine the two integers into a single hash input (32-bit integer mix)
    // We start with x, and then mix in y using bitwise operations and a multiplier (like 31 or 17).
    let combined = (x | 0); // Start with x

    // 0x9e3779b9 is a standard magic number (the golden ratio base in 32-bit) used for mixing.
    combined = (combined ^ (y | 0) + 0x9e3779b9 + (combined << 6) + (combined >> 2));

    // 2. Hash the combined 32-bit integer
    const hashedInt = hashInt(combined);

    // 3. Convert to a number in the range [0, 1)
    // The >>> 0 converts the signed 32-bit integer to an unsigned 32-bit integer [0, 2^32 - 1].
    const unsignedInt = hashedInt >>> 0;

    // Divide by 2^32 (4294967296.0) to normalize to [0, 1)
    const normalizedValue = unsignedInt / 4294967296.0;

    // 4. Scale to the desired range [0, 2 * PI)
    return normalizedValue * 2 * Math.PI;
  }

  /**
   * Modulates the color brightness based on a twinkling pattern.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment.
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    let m = this.amplitude * Math.sin(
      this.randomPhase(x, y) + Math.sin((this.freq * this.t))
    ) + this.amplitude;
    let c = color;
    c.multiplyScalar(m);
    this.pass(pixels, x, y, c, age, alpha);
  }
}


/**
 * Implements trail decay and management for persistent effects.
 */
export class FilterDecay extends Filter {
  /**
   * @param {number} lifespan - The number of frames a trail pixel lasts.
   */
  constructor(lifespan) {
    super();
    this.lifespan = lifespan;
    this.trails = new Map();
  }

  /**
   * Plots the incoming fragment and records its key and remaining lifespan if applicable.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {number} x - The x-coordinate.
   * @param {number} y - The y-coordinate.
   * @param {THREE.Color} color - The color to plot.
   * @param {number} age - The age of the fragment (0 for a head/new point).
   * @param {number} alpha - The opacity/coverage of the fragment.
   */
  plot(pixels, x, y, color, age, alpha) {
    if (age >= 0) {
      let key = pixelKey(x, y);
      this.trails.set(key, Math.max(0, this.lifespan - age));
    }
    if (age <= 0) {
      this.pass(pixels, x, y, color, age, alpha);
    }
  }

  /**
   * Decrements the time-to-live (TTL) for all stored trail pixels.
   */
  decay() {
    this.trails.forEach((ttl, key) => {
      ttl -= 1;
      if (ttl <= 0) {
        this.trails.delete(key);
      } else {
        this.trails.set(key, ttl);
      }
    });
    super.decay();
  }

  /**
   * Renders the stored trail pixels.
   * @param {Map<string, THREE.Color>} pixels - The map of pixel keys to colors.
   * @param {Function} trailFn - Function to generate color for trails (takes x, y, age_ratio).
   * @param {number} alpha - The opacity/coverage for the trail.
   */
  trail(pixels, trailFn, alpha) {
    for (const [key, ttl] of this.trails) {
      if (ttl > 0) {
        let p = keyPixel(key);
        let color = trailFn(p[0], p[1], 1 - (ttl / this.lifespan));
        //       labels.push({ position: pixelToVector(p[0], p[1]), content: `${parseFloat(p[0]).toFixed(1)}, ${parseFloat(p[1]).toFixed(1)}` });
        this.pass(pixels, p[0], p[1], color, this.lifespan - ttl, alpha);
      }
    }
    super.trail(pixels, trailFn, alpha);
  }
}