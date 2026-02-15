/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
// Removed import G from geometry.js to break cycle
import { quinticKernel } from "./filters.js";
import { randomBetween } from "./util.js"
import { StaticPool, colorPool, color4Pool } from "./memory.js";
import { Daydream } from "./driver.js";

// Inlined from geometry.js to break cycle
const PHI = (1 + Math.sqrt(5)) / 2;
const G = 1 / PHI;

/** 
 * Color4 class wrapping THREE.Color and alpha.
 */
export class Color4 {
  constructor(r, g, b, a = 1) {
    this.color = new THREE.Color();
    this.alpha = 1.0;

    if (r instanceof THREE.Color) {
      this.color.copy(r);
      this.alpha = g !== undefined ? g : 1.0;
    } else if (arguments.length >= 3) {
      this.color.setRGB(r, g, b);
      this.alpha = a;
    }
  }

  set(r, g, b, a = 1) {
    if (r instanceof Color4) {
      this.color.copy(r.color);
      this.alpha = r.alpha;
      return this;
    }
    if (r instanceof THREE.Color) {
      this.color.copy(r);
      this.alpha = g !== undefined ? g : 1.0;
      return this;
    }
    this.color.setRGB(r, g, b);
    this.alpha = a;
    return this;
  }

  copy(c) {
    if (c.color) this.color.copy(c.color);
    else this.color.setRGB(c.r, c.g, c.b);

    this.alpha = c.alpha !== undefined ? c.alpha : (c.a !== undefined ? c.a : 1.0);
    return this;
  }

  clone() {
    return new Color4(this.color, this.alpha);
  }

  get r() { return this.color.r; }
  set r(v) { this.color.r = v; }
  get g() { return this.color.g; }
  set g(v) { this.color.g = v; }
  get b() { return this.color.b; }
  set b(v) { this.color.b = v; }
  get a() { return this.alpha; }
  set a(v) { this.alpha = v; }

  lerp(color, alpha) {
    this.color.lerp(color.color, alpha);
    this.alpha += (color.alpha - this.alpha) * alpha;
    return this;
  }
}

color4Pool.Type = Color4;


/**
 * A standard Palette interface.
 * Returns a Color4.
 */
export class Palette {
  get(t) {
    const c = color4Pool.acquire();
    c.color.setHex(0xffffff);
    c.alpha = 1.0;
    return c;
  }
}

/**
 * Blends a color into the global pixel buffer at a specific index.
 * Optimized for Float32Array (Flat Buffer) access.
 * * @param {number} index - The pixel index (0 to W*H-1).
 * @param {THREE.Color} color - The source color.
 * @param {number} alpha - The alpha/opacity of the source (0.0 - 1.0).
 */
export function blendAlpha(index, color, alpha, mode = 'over') {
  // 1. Calculate the memory address (stride)
  const stride = index * 3;

  // 2. Direct reference to the GPU buffer
  const pixels = Daydream.pixels;

  // Optimization: Skip invisible updates
  if (alpha <= 0.000001) return;

  if (mode === 'add') {
    // Additive: New light adds to existing light
    pixels[stride] += color.r * alpha;
    pixels[stride + 1] += color.g * alpha;
    pixels[stride + 2] += color.b * alpha;
  } else if (mode === 'max') {
    // Max: Only keep the brightest value
    pixels[stride] = Math.max(pixels[stride], color.r * alpha);
    pixels[stride + 1] = Math.max(pixels[stride + 1], color.g * alpha);
    pixels[stride + 2] = Math.max(pixels[stride + 2], color.b * alpha);
  } else {
    // Optimization: Fast Path for Opaque pixels (Replace)
    if (alpha >= 0.999) {
      pixels[stride] = color.r;
      pixels[stride + 1] = color.g;
      pixels[stride + 2] = color.b;
      return;
    }

    // 3. Alpha Blending (Standard 'Over' operator)
    // Formula: Out = Old * (1 - alpha) + New * alpha
    const invAlpha = 1.0 - alpha;

    pixels[stride] = pixels[stride] * invAlpha + color.r * alpha;
    pixels[stride + 1] = pixels[stride + 1] * invAlpha + color.g * alpha;
    pixels[stride + 2] = pixels[stride + 2] * invAlpha + color.b * alpha;
  }
}

///////////////////////////////////////////////////////////////////////////////

/**
 * A class representing a discrete color gradient/lookup table.
 */
export class Gradient {
  /**
   * @param {number} size - The desired number of samples in the final gradient.
   * @param {Array<Array<number>>} points - An array of [t, hexColor] pairs defining the interpolation points.
   */
  constructor(size, points) {
    let lastPoint = [0, 0x000000];
    this.colors = points.reduce((r, nextPoint) => {
      let s = Math.floor(nextPoint[0] * size) - Math.floor(lastPoint[0] * size);

      // Extract sRGB components manually to ensure we stay in sRGB space for interpolation
      const lastHex = lastPoint[1];
      const nextHex = nextPoint[1];

      const r1 = ((lastHex >> 16) & 255) / 255;
      const g1 = ((lastHex >> 8) & 255) / 255;
      const b1 = (lastHex & 255) / 255;

      const r2 = ((nextHex >> 16) & 255) / 255;
      const g2 = ((nextHex >> 8) & 255) / 255;
      const b2 = (nextHex & 255) / 255;

      for (let i = 0; i < s; i++) {
        const t = i / s;
        // Interpolate in sRGB space
        const ri = r1 + (r2 - r1) * t;
        const gi = g1 + (g2 - g1) * t;
        const bi = b1 + (b2 - b1) * t;

        // Convert to Linear for storage
        // setRGB takes values as-is. convertSRGBToLinear applies the gamma curve.
        r.push(new THREE.Color().setRGB(ri, gi, bi).convertSRGBToLinear());
      }
      lastPoint = nextPoint;
      return r;
    }, []);
  }

  /**
   * Gets the color at a specific position along the gradient.
   * @param {number} a - The position parameter [0, 1].
   * @returns {{color: THREE.Color, alpha: number}} The sampled color and alpha.
   */
  get(a) {
    const t = Math.max(0, Math.min(1, a));
    const sourceColor = this.colors[Math.floor(t * (this.colors.length - 1))];
    const result = color4Pool.acquire();
    // Color is already Linear in storage, so we just copy it.
    result.color.copy(sourceColor);
    result.alpha = 1.0;
    return result;
  }
};

/**
 * Converts HSV (Hue, Saturation, Value) to HSL (Hue, Saturation, Lightness).
 * @param {number} h - Hue [0, 1].
 * @param {number} s - Saturation (HSV) [0, 1].
 * @param {number} v - Value (Brightness) [0, 1].
 * @returns {number[]} Array [h, s_hsl, l].
 */
export const hsvToHsl = (h, s, v) => {
  const l = v * (1 - s / 2);
  const s_hsl = (l === 0 || l === 1) ? 0 : (v - l) / Math.min(l, 1 - l);
  return [h, s_hsl, l];
}

/**
 * A class for generating palettes using color harmony rules and procedural shape logic.
 */
export class GenerativePalette {
  static seed = Math.random();
  static VIGNETTE_COLOR = new THREE.Color(0, 0, 0);

  /**
   * Calculates companion hues based on a base hue and a harmony type.
   * @param {number} baseHue - The base hue [0, 1].
   * @param {('triadic'|'split-complementary'|'complementary'|'analogous')} type - The harmony rule to follow.
   * @returns {number[]} Array of 3 hue values [hA, hB, hC].
   */
  static calcHues(baseHue, type) {
    let hA = baseHue;
    let hB, hC;
    const normalize = (h) => (h % 1 + 1) % 1;

    switch (type) {
      case 'triadic':
        // Three equidistant hues (1/3 of the wheel)
        hB = normalize(hA + 1 / 3);
        hC = normalize(hA + 2 / 3);
        break;

      case 'split-complementary':
        // HueA, and two hues adjacent to its complement
        const complement = normalize(hA + 0.5);
        // Offset by 1/12 (30 degrees)
        hB = normalize(complement - 1 / 12);
        hC = normalize(complement + 1 / 12);
        break;

      case 'complementary':
        // HueA and its direct opposite
        hB = normalize(hA + 0.5);
        // Introduce a subtle third hue for the blend
        hC = normalize(hA + randomBetween(-1 / 36, 1 / 36));
        break;

      case 'analogous':
      default:
        // Analogous (closely spaced hues 15-30 degrees)
        let dir = Math.random() < 0.5 ? 1 : -1;
        // Was 60-90 degrees (1/6 to 3/12), which created wide spreads
        // Now 15-30 degrees (1/24 to 1/12)
        hB = normalize(hA + dir * randomBetween(1 / 24, 1 / 12));
        hC = normalize(hB + dir * randomBetween(1 / 24, 1 / 12));
        break;
    }

    return [hA, hB, hC];
  }

  /**
   * @param {('straight'|'circular'|'vignette'|'falloff')} [shape='straight'] - The palette shape/sampling method.
   * @param {('analagous'|'triadic'|'split-complementary'|'complementary')} [harmonyType='analagous'] - The color harmony rule.
   * @param {('ascending'|'descending'|'flat'|'bell'|'cup')} [brightnessProfile='ascending'] - The distribution of value/brightness.
   * @param {('pastel'|'mid'|'vibrant')} [saturationProfile='mid'] - The distribution of saturation.
   * @param {number} [baseHue] - Optional base hue [0, 1]. If provided, static seed is ignored.
   */
  constructor(shape = 'straight', harmonyType = 'analagous', brightnessProfile = 'ascending', saturationProfile = 'mid', baseHue = undefined) {
    this.shapeSpec = shape;
    this.harmonyType = harmonyType;
    this.brightnessProfile = brightnessProfile;
    this.saturationProfile = saturationProfile;
    this.init(baseHue);
  }

  /**
   * Regenerates the palette colors based on the stored configuration.
   * @param {number} [baseHue] - Optional base hue override.
   */
  init(baseHue) {
    let hueA;
    if (baseHue !== undefined) {
      hueA = baseHue;
    } else {
      hueA = GenerativePalette.seed;
      GenerativePalette.seed = (GenerativePalette.seed + G) % 1;
    }
    const [hA, hB, hC] = GenerativePalette.calcHues(hueA, this.harmonyType);

    let sat1, sat2, sat3;
    switch (this.saturationProfile) {
      case 'pastel':
        sat1 = 0.4;
        sat2 = 0.4;
        sat3 = 0.4;
        break;
      case 'mid':
        sat1 = randomBetween(0.6, 0.8);
        sat2 = randomBetween(0.6, 0.8);
        sat3 = randomBetween(0.6, 0.8);
        break;
      case 'vibrant':
        sat1 = 1.0;
        sat2 = 1.0;
        sat3 = 1.0;
        break;
    }

    let v1, v2, v3;
    switch (this.brightnessProfile) {
      case 'ascending':
        v1 = randomBetween(0.1, 0.3);
        v2 = randomBetween(0.5, 0.7);
        v3 = randomBetween(0.8, 1.0);
        break;
      case 'descending':
        v1 = randomBetween(0.8, 1.0);
        v2 = randomBetween(0.5, 0.7);
        v3 = randomBetween(0.1, 0.3);
        break;
      case 'flat':
        v1 = 1.0;
        v2 = 1.0;
        v3 = 1.0;
        break;
      case 'bell':
        v1 = randomBetween(0.2, 0.5);
        v2 = randomBetween(0.7, 1.0);
        v3 = v1;
        break;
      case 'cup':
        v1 = randomBetween(0.7, 1.0);
        v2 = randomBetween(0.2, 1.5);
        v3 = v1;
        break;
    }

    this.a = new THREE.Color().setHSL(...hsvToHsl(hA, sat1, v1));
    this.b = new THREE.Color().setHSL(...hsvToHsl(hB, sat2, v2));
    this.c = new THREE.Color().setHSL(...hsvToHsl(hC, sat3, v3));
  }

  /**
   * Gets the color based on the internal shape specification.
   * @param {number} t - The position parameter [0, 1].
   * @returns {{color: THREE.Color, alpha: number}} The sampled color and alpha.
   */
  get(t) {
    let colors;
    let shape;
    switch (this.shapeSpec) {
      case 'vignette':
        shape = [0, 0.1, 0.5, 0.9, 1];
        colors = [GenerativePalette.VIGNETTE_COLOR, this.a, this.b, this.c, GenerativePalette.VIGNETTE_COLOR];
        break;
      case 'straight':
        shape = [0, 0.5, 1];
        colors = [this.a, this.b, this.c];
        break;
      case 'circular':
        shape = [0, 0.33, 0.66, 1];
        colors = [this.a, this.b, this.c, this.a];
        break;
      case 'falloff':
        shape = [0, 0.33, 0.66, 0.9, 1];
        colors = [this.a, this.b, this.c, GenerativePalette.VIGNETTE_COLOR];
        break;
    }

    let segIndex = -1;
    for (let i = 0; i < shape.length - 1; i++) {
      if (t >= shape[i] && t < shape[i + 1]) {
        segIndex = i;
        break;
      }
    }
    if (segIndex < 0) {
      segIndex = shape.length - 2; // Should index the last segment
    }

    const start = shape[segIndex];
    const end = shape[segIndex + 1];
    const c1 = colors[segIndex];
    const c2 = colors[segIndex + 1];

    const result = color4Pool.acquire();
    result.color.lerpColors(c1, c2, (t - start) / (end - start)).convertSRGBToLinear();
    result.alpha = 1.0;
    return result;
  }
}

/**
 * Implements the cosine-wave procedural color palette formula:
 * C(t) = A + B * cos(2 * PI * (C * t + D))
 */
export class ProceduralPalette {
  /**
   * @param {number[]} a - Base color vector [r, g, b].
   * @param {number[]} b - Amplitude vector [r, g, b].
   * @param {number[]} c - Frequency vector [r, g, b].
   * @param {number[]} d - Phase shift vector [r, g, b].
   */
  constructor(a, b, c, d) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;

    // Memoize the palette
    const TABLE_SIZE = 16384;
    this.table = new Array(TABLE_SIZE);

    for (let i = 0; i < TABLE_SIZE; i++) {
      const t = i / (TABLE_SIZE - 1);
      const color = new THREE.Color();
      color.setRGB(
        this.a[0] + this.b[0] * Math.cos(2 * Math.PI * (this.c[0] * t + this.d[0])),
        this.a[1] + this.b[1] * Math.cos(2 * Math.PI * (this.c[1] * t + this.d[1])),
        this.a[2] + this.b[2] * Math.cos(2 * Math.PI * (this.c[2] * t + this.d[2]))
      ).convertSRGBToLinear();
      this.table[i] = color;
    }
  }

  /**
   * Gets the color for a given position on the palette.
   * @param {number} t - The position parameter [0, 1].
   * @returns {{color: THREE.Color, alpha: number}} The sampled color and alpha.
   */
  get(t) {
    // Clamp t to [0, 1]
    const tClamped = Math.max(0, Math.min(1, t));
    const index = Math.floor(tClamped * (this.table.length - 1));

    const result = color4Pool.acquire();
    result.color.copy(this.table[index]);
    result.alpha = 1.0;
    return result;
  }
};

/**
 * An extension of ProceduralPalette that allows continuous mutation
 * between two full sets of palette vectors over time.
 */
export class MutatingPalette {
  /**
   * @param {number[]} a1 - Base color vector 1.
   * @param {number[]} b1 - Amplitude vector 1.
   * @param {number[]} c1 - Frequency vector 1.
   * @param {number[]} d1 - Phase shift vector 1.
   * @param {number[]} a2 - Base color vector 2.
   * @param {number[]} b2 - Amplitude vector 2.
   * @param {number[]} c2 - Frequency vector 2.
   * @param {number[]} d2 - Phase shift vector 2.
   */
  constructor(a1, b1, c1, d1, a2, b2, c2, d2) {
    this.a1 = new THREE.Vector3(a1[0], a1[1], a1[2]);
    this.b1 = new THREE.Vector3(b1[0], b1[1], b1[2]);
    this.c1 = new THREE.Vector3(c1[0], c1[1], c1[2]);
    this.d1 = new THREE.Vector3(d1[0], d1[1], d1[2]);
    this.a2 = new THREE.Vector3(a2[0], a2[1], a2[2]);
    this.b2 = new THREE.Vector3(b2[0], b2[1], b2[2]);
    this.c2 = new THREE.Vector3(c2[0], c2[1], c2[2]);
    this.d2 = new THREE.Vector3(d2[0], d2[1], d2[2]);
    this.mutate(0);
  }

  /**
   * Interpolates the palette vectors (a, b, c, d) between the initial (1) and final (2) sets.
   * @param {number} t - The interpolation factor [0, 1].
   */
  mutate(t) {
    this.a = new THREE.Vector3().lerpVectors(this.a1, this.a2, t);
    this.b = new THREE.Vector3().lerpVectors(this.b1, this.b2, t);
    this.c = new THREE.Vector3().lerpVectors(this.c1, this.c2, t);
    this.d = new THREE.Vector3().lerpVectors(this.d1, this.d2, t);
  }

  /**
   * Gets the color for a given position on the palette using the currently mutated vectors.
   * @param {number} p - The position parameter [0, 1].
   * @returns {{color: THREE.Color, alpha: number}} The sampled color and alpha.
   */
  get(p) {
    // a + b * cos(2 * PI * (c * t + d));
    const result = color4Pool.acquire();
    result.color.setRGB(
      this.a.x + this.b.x * Math.cos(2 * Math.PI * (this.c.x * p + this.d.x)),
      this.a.y + this.b.y * Math.cos(2 * Math.PI * (this.c.y * p + this.d.y)),
      this.a.z + this.b.z * Math.cos(2 * Math.PI * (this.c.z * p + this.d.z))
    ).convertSRGBToLinear();
    result.alpha = 1.0;
    return result;
  }
}

///////////////////////////////////////////////////////////////////////////////
// Palette Wrappers
///////////////////////////////////////////////////////////////////////////////

/**
 * A wrapper class that reverses the sampling direction of an existing palette.
 */
export class ReversePalette {
  /**
   * @param {Object} palette - The original palette object with a .get(t) method.
   */
  constructor(palette) {
    this.palette = palette;
  }

  /**
   * Gets the color at a reversed position.
   * @param {number} t - The position parameter [0, 1].
   * @returns {{color: THREE.Color, alpha: number}} The color and alpha from the underlying palette at position (1 - t).
   */
  get(t) {
    return this.palette.get(1 - t);
  }
}

/**
 * A wrapper class that maps [0,1] to [0,1,0] (Triangle Wave).
 * Useful for making any palette cycle seamlessly.
 */
export class CircularPalette {
  /**
   * @param {Object} palette - The original palette object.
   */
  constructor(palette) {
    this.palette = palette;
  }

  get(t) {
    // 0 -> 0
    // 0.5 -> 1
    // 1.0 -> 0
    // formula: 1 - abs(2*t - 1)
    return this.palette.get(1 - Math.abs(2 * t - 1));
  }
}


/**
 * A wrapper class that applies falloff to both ends of an existing palette.
 */
export class VignettePalette {
  static vignetteColor = new THREE.Color(0, 0, 0);

  /**
   * @param {Object} palette - The original palette object with a .get(t) method.
   */
  constructor(palette) {
    this.palette = palette;
  }

  /**
   * Gets the color at a reversed position.
   * @param {number} t - The position parameter [0, 1].
   * @returns {{color: THREE.Color, alpha: number}} The color and alpha from the underlying palette.
   */
  get(t) {
    let resultColor;
    let factor = 1.0;

    if (t < 0.2) {
      resultColor = this.palette.get(0);
      factor = t / 0.2;
    } else if (t >= 0.8) {
      resultColor = this.palette.get(1);
      factor = (1 - (t - 0.8) / 0.2); // Fade out
    } else {
      return this.palette.get((t - 0.2) / 0.6); // returns Color4
    }

    // Blend to vignette color (Black)
    // result = resultColor * factor + Black * (1-factor)
    // Black is 0,0,0 so result = resultColor * factor

    resultColor.color.multiplyScalar(factor);

    return resultColor;
  }
}

/**
 * A wrapper class that applies alpha fade-out to both ends of an existing palette.
 * Instead of darkening to black, it becomes transparent.
 */
export class TransparentVignette {
  constructor(palette) {
    this.palette = palette;
  }

  get(t) {
    const tClamped = Math.max(0, Math.min(1, t));
    const result = this.palette.get(tClamped);
    let factor = 1.0;
    // Fade In (0.0 -> 0.2)
    if (tClamped < 0.2) {
      const t_edge = tClamped / 0.2;
      factor = quinticKernel(t_edge);
    }
    // Fade Out (0.8 -> 1.0)
    else if (tClamped > 0.8) {
      const t_edge = (1.0 - tClamped) / 0.2;
      factor = quinticKernel(t_edge);
    }

    result.alpha *= factor;
    return result;
  }
}


/**
 * A wrapper class that applies a scalar falloff function to an existing palette.
 * The scalar result is clamped to [0, 1] and used to scale the color's brightness.
 */
export class FalloffPalette {
  /**
   * @param {function(number): number} falloffFn - A function that takes t [0-1] and returns a brightness scale factor.
   * @param {Object} palette - The original palette object with a .get(t) method.
   */
  constructor(falloffFn, palette) {
    this.palette = palette;
    this.falloffFn = falloffFn;
  }

  /**
   * Gets the color with brightness scaling applied.
   * @param {number} t - The position parameter [0, 1].
   * @returns {{color: THREE.Color, alpha: number}} The scaled color and alpha.
   */
  get(t) {
    const result = this.palette.get(t);
    let scale = this.falloffFn(t);
    scale = Math.max(0, Math.min(1, scale)); // Clamp to [0, 1]

    // Direct scale
    result.color.multiplyScalar(scale);

    return result;
  }
}

/**
 * A wrapper class that applies a scalar falloff function to an existing palette's alpha channel.
 * The scalar result is clamped to [0, 1] and used to scale the alpha.
 */
export class AlphaFalloffPalette {
  /**
   * @param {function(number): number} falloffFn - A function that takes t [0-1] and returns an alpha scale factor.
   * @param {Object} palette - The original palette object with a .get(t) method.
   */
  constructor(falloffFn, palette) {
    this.palette = palette;
    this.falloffFn = falloffFn;
  }

  /**
   * Gets the color with alpha scaling applied.
   * @param {number} t - The position parameter [0, 1].
   * @returns {{color: THREE.Color, alpha: number}} The scaled color and alpha.
   */
  get(t) {
    const result = this.palette.get(t);
    let scale = this.falloffFn(t);
    scale = Math.max(0, Math.min(1, scale)); // Clamp to [0, 1]
    result.alpha *= scale;
    return result;
  }
}

/**
 * A wrapper that applies a chain of modifiers to the palette parameter 't'
 * before sampling the underlying source palette.
 */
export class AnimatedPalette {
  /**
   * @param {Object} source - The source Palette (e.g., Palettes.mangoPeel)
   */
  constructor(source) {
    this.source = source;
    this.modifiers = []; // List of objects with a transform(t) method
  }

  /**
   * Explicitly connect a modifier to this palette.
   * @param {Object} modifier - Object with a transform(t) method.
   */
  add(modifier) {
    this.modifiers.push(modifier);
    return this;
  }

  /**
   * Sets the source palette.
   * @param {Object} p - The new source palette.
   */
  setSource(p) { this.source = p; }

  /**
   * Palette Interface: Transforms parameter t through all modifiers, then samples source.
   * @param {number} t - The lookup parameter (0..1)
   * @returns {THREE.Color}
   */
  get(t) {
    let finalT = t;
    // Pipe t through the modifier chain: t -> m1 -> m2 ... -> t'
    for (let i = 0; i < this.modifiers.length; i++) {
      finalT = this.modifiers[i].transform(finalT);
    }
    return this.source.get(finalT);
  }
}