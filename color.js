// color.js
import * as THREE from "three";
import { G } from "./geometry.js";
import { randomBetween } from "./util.js"

/**
 * Blends two colors by taking the maximum value for each RGB channel.
 * @param {THREE.Color} c1 - The first color.
 * @param {THREE.Color} c2 - The second color.
 * @returns {THREE.Color} The resulting color.
 */
export const blendMax = (c1, c2) => {
  return new THREE.Color(
    Math.max(c1.r, c2.r),
    Math.max(c1.g, c2.g),
    Math.max(c1.b, c2.b)
  );
}

/**
 * Blends the two colors using an opaque "over" operation (returns c2).
 * @param {THREE.Color} c1 - The background color (ignored).
 * @param {THREE.Color} c2 - The foreground color.
 * @returns {THREE.Color} The foreground color.
 */
export const blendOver = (c1, c2) => {
  return c2;
}

/**
 * Blends the two colors using an opaque "under" operation (returns c1).
 * @param {THREE.Color} c1 - The background color.
 * @param {THREE.Color} c2 - The foreground color (ignored).
 * @returns {THREE.Color} The background color.
 */
export const blendUnder = (c1, c2) => {
  return c1;
}

/**
 * Adds the two colors, clamping each channel at 1.0.
 * @param {THREE.Color} c1 - The first color.
 * @param {THREE.Color} c2 - The second color.
 * @returns {THREE.Color} The resulting color.
 */
export const blendAdd = (c1, c2) => {
  return new THREE.Color(
    Math.min(1, c1.r + c2.r),
    Math.min(1, c1.g + c2.g),
    Math.min(1, c1.b + c2.b)
  );
}

/**
 * Returns a function that performs standard alpha blending.
 * C_result = C1 * (1 - a) + C2 * a
 * @param {number} a - The alpha value of the second color [0, 1].
 * @returns {function(THREE.Color, THREE.Color): THREE.Color} A blending function.
 */
export const blendAlpha = (a) => {
  return (c1, c2) => {
    return new THREE.Color(
      c1.r * (1 - a) + c2.r * (a),
      c1.g * (1 - a) + c2.g * (a),
      c1.b * (1 - a) + c2.b * (a)
    );
  }
}

/**
 * Returns a function that performs an accumulation blend.
 * C_result = C_existing + C_fragment * coverage (a)
 * @param {number} a - The coverage/alpha value of the incoming fragment [0, 1].
 * @returns {function(THREE.Color, THREE.Color): THREE.Color} A blending function.
 */
export const blendAccumulate = (a) => {
  return (c1, c2) => {
    // c1: existing pixel color, c2: incoming fragment color
    // Formula: C_result = C_existing + C_fragment * coverage (a)
    return new THREE.Color(
      Math.min(1, c1.r + c2.r * a),
      Math.min(1, c1.g + c2.g * a),
      Math.min(1, c1.b + c2.b * a)
    );
  }
}

/**
 * Blends by applying the maximum color magnitude to the second color (c2).
 * Result is c2 scaled by max(magnitude(c1), magnitude(c2)) / magnitude(c2).
 * @param {THREE.Color} c1 - The first color.
 * @param {THREE.Color} c2 - The second color (the color being scaled).
 * @returns {THREE.Color} The resulting scaled color.
 */
export const blendOverMax = (c1, c2) => {
  const m1 =
    Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 =
    Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
  if (m2 == 0) {
    return c1;
  }
  let s = Math.max(m1, m2) / m2;
  return new THREE.Color(
    c2.r * s,
    c2.g * s,
    c2.b * s
  );
}

/**
 * Blends by applying the minimum color magnitude to the second color (c2).
 * Result is c2 scaled by min(magnitude(c1), magnitude(c2)) / magnitude(c2).
 * @param {THREE.Color} c1 - The first color.
 * @param {THREE.Color} c2 - The second color (the color being scaled).
 * @returns {THREE.Color} The resulting scaled color.
 */
export const blendOverMin = (c1, c2) => {
  const m1 =
    Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 =
    Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
  let s = 0;
  if (m2 > 0) {
    s = Math.min(m1, m2) / m2;
  }
  return new THREE.Color(
    c2.r * s,
    c2.g * s,
    c2.b * s
  );
}

/**
 * Calculates the mean (average) of two colors.
 * @param {THREE.Color} c1 - The first color.
 * @param {THREE.Color} c2 - The second color.
 * @returns {THREE.Color} The mean color.
 */
export const blendMean = (c1, c2) => {
  return new THREE.Color(
    (c1.r + c2.r) / 2,
    (c1.g + c2.g) / 2,
    (c1.b + c2.b) / 2
  );
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
      for (let i = 0; i < s; i++) {
        r.push(new THREE.Color(lastPoint[1]).lerp(
          new THREE.Color(nextPoint[1]),
          i / s));
      }
      lastPoint = nextPoint;
      return r;
    }, []);
  }

  /**
   * Gets the color at a specific position along the gradient.
   * @param {number} a - The position parameter [0, 1].
   * @returns {THREE.Color} The sampled color, converted to linear color space.
   */
  get(a) {
    return this.colors[Math.floor(a * (this.colors.length - 1))].clone().convertSRGBToLinear();
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
 * A wrapper class that reverses the sampling direction of an existing palette.
 */
export class reversePalette {
  /**
   * @param {Object} palette - The original palette object with a .get(t) method.
   */
  constructor(palette) {
    this.palette = palette;
  }

  /**
   * Gets the color at a reversed position.
   * @param {number} t - The position parameter [0, 1].
   * @returns {THREE.Color} The color from the underlying palette at position (1 - t).
   */
  get(t) {
    return this.palette.get(1 - t);
  }
}

/**
 * A class for generating palettes using color harmony rules and procedural shape logic.
 */
export class GenerativePalette {
  static seed = Math.random();

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
        // Analogous (closely spaced hues)
        let dir = Math.random() < 0.5 ? 1 : -1;
        hB = normalize(hA + dir * randomBetween(1 / 6, 3 / 12));
        hC = normalize(hB + dir * randomBetween(1 / 6, 3 / 12));
        break;
    }

    return [hA, hB, hC];
  }

  /**
   * @param {('straight'|'circular'|'vignette'|'faloff')} [shape='straight'] - The palette shape/sampling method.
   * @param {('analagous'|'triadic'|'split-complementary'|'complementary')} [harmonyType='analagous'] - The color harmony rule.
   * @param {('ascending'|'descending'|'flat'|'bell')} [brightnessProfile='ascending'] - The distribution of value/brightness.
   */
  constructor(shape = 'straight', harmonyType = 'analagous', brightnessProfile = 'ascending') {
    this.shapeSpec = shape;
    this.harmonyType = harmonyType;

    let hueA = GenerativePalette.seed;
    GenerativePalette.seed = (GenerativePalette.seed + G) % 1;
    const [hA, hB, hC] = GenerativePalette.calcHues(hueA, harmonyType);

    let sat1 = randomBetween(0.4, 0.8);
    let sat2 = randomBetween(0.4, 0.8);
    let sat3 = randomBetween(0.4, 0.8);

    let v1, v2, v3;
    switch (brightnessProfile) {
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
    }

    this.a = new THREE.Color().setHSL(...hsvToHsl(hA, sat1, v1));
    this.b = new THREE.Color().setHSL(...hsvToHsl(hB, sat2, v2));
    this.c = new THREE.Color().setHSL(...hsvToHsl(hC, sat3, v3));
  }

  /**
   * Gets the color based on the internal shape specification.
   * @param {number} t - The position parameter [0, 1].
   * @returns {THREE.Color} The sampled color, converted to linear color space.
   */
  get(t) {
    let colors;
    let shape;
    const vignetteColor = new THREE.Color(0, 0, 0);
    switch (this.shapeSpec) {
      case 'vignette':
        shape = [0, 0.1, 0.5, 0.9, 1];
        colors = [vignetteColor, this.a, this.b, this.c, vignetteColor];
        break;
      case 'straight':
        shape = [0, 0.5, 1];
        colors = [this.a, this.b, this.c];
        break;
      case 'circular':
        shape = [0, 0.33, 0.66, 1];
        colors = [this.a, this.b, this.c, this.a];
        break;
      case 'faloff':
        shape = [0, 0.33, 0.66, 0.9, 1];
        colors = [this.a, this.b, this.c, vignetteColor];
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

    return new THREE.Color().lerpColors(c1, c2, (t - start) / (end - start)).convertSRGBToLinear();
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
  }

  /**
   * Gets the color for a given position on the palette.
   * @param {number} t - The position parameter [0, 1].
   * @returns {THREE.Color} The resulting color, converted to linear color space.
   */
  get(t) {
    return new THREE.Color(
      this.a[0] + this.b[0] * Math.cos(2 * Math.PI * (this.c[0] * t + this.d[0])),
      this.a[1] + this.b[1] * Math.cos(2 * Math.PI * (this.c[1] * t + this.d[1])),
      this.a[2] + this.b[2] * Math.cos(2 * Math.PI * (this.c[2] * t + this.d[2]))
    ).convertSRGBToLinear();
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
   * @returns {THREE.Color} The resulting color, converted to linear color space.
   */
  get(p) {
    // a + b * cos(2 * PI * (c * t + d));
    return new THREE.Color(
      this.a.x + this.b.x * Math.cos(2 * Math.PI * (this.c.x * p + this.d.x)),
      this.a.y + this.b.y * Math.cos(2 * Math.PI * (this.c.y * p + this.d.y)),
      this.a.z + this.b.z * Math.cos(2 * Math.PI * (this.c.z * p + this.d.z))
    ).convertSRGBToLinear();
  }
}

/** @type {Gradient} A pre-defined full spectrum rainbow gradient. */
export let rainbow = new Gradient(256, [
  [0, 0xFF0000],
  [1 / 16, 0xD52A00],
  [2 / 16, 0xAB5500],
  [3 / 16, 0xAB7F00],
  [4 / 16, 0xABAB00],
  [5 / 16, 0x56D500],
  [6 / 16, 0x00FF00],
  [7 / 16, 0x00D52A],
  [8 / 16, 0x00AB55],
  [9 / 16, 0x0056AA],
  [10 / 16, 0x0000FF],
  [11 / 16, 0x2A00D5],
  [12 / 16, 0x5500AB],
  [13 / 16, 0x7F0081],
  [14 / 16, 0xAB0055],
  [15 / 16, 0xD5002B],
  [16 / 16, 0xD5002B]
]);

/** @type {Gradient} A pre-defined rainbow gradient with black stripes. */
export let rainbowStripes = new Gradient(256, [
  [0, 0xFF0000],
  [1 / 16, 0x000000],
  [2 / 16, 0xAB5500],
  [3 / 16, 0x000000],
  [4 / 16, 0xABAB00],
  [5 / 16, 0x000000],
  [6 / 16, 0x00FF00],
  [7 / 16, 0x000000],
  [8 / 16, 0x00AB55],
  [9 / 16, 0x000000],
  [10 / 16, 0x0000FF],
  [11 / 16, 0x000000],
  [12 / 16, 0x5500AB],
  [13 / 16, 0x000000],
  [14 / 16, 0xAB0055],
  [15 / 16, 0x000000],
  [16 / 16, 0xFF0000]
]);

/** @type {Gradient} A pre-defined rainbow gradient with thinner black stripes. */
export let rainbowThinStripes = new Gradient(256, [
  [0, 0xFF0000], //
  [1 / 32, 0x000000],
  [3 / 32, 0x000000],
  [4 / 32, 0xAB5500], //
  [5 / 32, 0x000000],
  [7 / 32, 0x000000],
  [8 / 32, 0xABAB00], //
  [9 / 32, 0x000000],
  [11 / 32, 0x000000],
  [12 / 32, 0x00FF00], //
  [13 / 32, 0x000000],
  [15 / 32, 0x000000],
  [16 / 32, 0x00AB55], //
  [17 / 32, 0x000000],
  [19 / 32, 0x000000],
  [20 / 32, 0x0000FF], //
  [21 / 32, 0x000000],
  [23 / 32, 0x000000],
  [24 / 32, 0x5500AB], //
  [25 / 32, 0x000000],
  [27 / 32, 0x000000],
  [28 / 32, 0xAB0055], //
  [29 / 32, 0x000000],
  [32 / 32, 0x000000] //
]);

/** @type {Gradient} A gray-to-black gradient. */
export let grayToBlack = new Gradient(16384, [
  [0, 0x888888],
  [1, 0x000000]
]);

/** @type {Gradient} A blue-to-black gradient. */
export let blueToBlack = new Gradient(256, [
  [0, 0xee00ee],
  [1, 0x000000]
]);

/** @type {Gradient} Generic Gradient 1 (Orange/Red). */
export let g1 = new Gradient(256, [
  [0, 0xffaa00],
  [1, 0xff0000],
]);

/** @type {Gradient} Generic Gradient 2 (Blue/Purple). */
export let g2 = new Gradient(256, [
  [0, 0x0000ff],
  [1, 0x660099],
]);

/** @type {Gradient} Generic Gradient 3 (Yellow/Orange to Dark Blue/Black). */
export let g3 = new Gradient(256, [
  //  [0, 0xaaaaaa],
  [0, 0xffff00],
  [0.3, 0xfc7200],
  [0.8, 0x06042f],
  [1, 0x000000]
]);

/** @type {Gradient} Generic Gradient 4 (Blue to Black). */
export let g4 = new Gradient(256, [
  //  [0, 0xaaaaaa],
  [0, 0x0000ff],
  [1, 0x000000]
]);

///////////////////////////////////////////////////////////////////////////////

/**
 * Wraps an existing palette with a falloff vignette effect.
 * @param {Object} palette - The original palette object with a .get(t) method.
 * @returns {function(number): THREE.Color} A function that returns the vignetted color.
 */
export function vignette(palette) {
  let vignetteColor = new THREE.Color(0, 0, 0);
  return (t) => {
    if (t < 0.2) {
      return new THREE.Color().lerpColors(vignetteColor, palette.get(0), t / 0.2);
    } else if (t >= 0.8) {
      return new THREE.Color().lerpColors(palette.get(1), vignetteColor, (t - 0.8) / 0.2);
    } else {
      return palette.get((t - 0.2) / 0.6);
    }
  };
}


/** @type {ProceduralPalette} A dark, saturated rainbow palette. */
export const darkRainbow = new ProceduralPalette(
  [0.367, 0.367, 0.367], // A
  [0.500, 0.500, 0.500], // B
  [1.000, 1.000, 1.000], // C
  [0.000, 0.330, 0.670]  // D
);

/** @type {Gradient} A lush green/blue/gold gradient. */
export const emeraldForest = new Gradient(16384, [
  [0.0, 0x004E64],
  [0.2, 0x0B6E4F],
  [0.4, 0x08A045],
  [0.6, 0x6BBF59],
  [0.8, 0x138086],
  //  [0.8, 0xEB9C35],
  [1, 0x000000]
]);

/** @type {ProceduralPalette} A pulsating red/black palette. */
export const bloodStream = new ProceduralPalette(
  [0.169, 0.169, 0.169], // A
  [0.313, 0.313, 0.313], // B
  [0.231, 0.231, 0.231], // C
  [0.036, 0.366, 0.706]  // D
);

/** @type {ProceduralPalette} A warm, faded sunset palette. */
export const vintageSunset = new ProceduralPalette(
  [0.256, 0.256, 0.256], // A
  [0.500, 0.080, 0.500], // B
  [0.277, 0.277, 0.277], // C
  [0.000, 0.330, 0.670]  // D
);

/** @type {ProceduralPalette} A vibrant, rich sunset palette. */
export const richSunset = new ProceduralPalette(
  [0.309, 0.500, 0.500], // A
  [1.000, 1.000, 0.500], // B
  [0.149, 0.148, 0.149], // C
  [0.132, 0.222, 0.521]  // D
);

/** @type {ProceduralPalette} A cool, deep ocean palette. */
export const underSea = new ProceduralPalette(
  [0.000, 0.000, 0.000], // A
  [0.500, 0.276, 0.423], // B
  [0.296, 0.296, 0.296], // C
  [0.374, 0.941, 0.000]  // D);
);

/** @type {ProceduralPalette} A warm late sunset palette with reds and yellows. */
export const lateSunset = new ProceduralPalette(
  [0.337, 0.500, 0.096], // A
  [0.500, 1.000, 0.176], // B
  [0.261, 0.261, 0.261], // C
  [0.153, 0.483, 0.773]  // D
);

/** @type {ProceduralPalette} A palette with yellow, orange, and green tones. */
export const mangoPeel = new ProceduralPalette(
  [0.500, 0.500, 0.500], // A
  [0.500, 0.080, 0.500], // B
  [0.431, 0.431, 0.431], // C
  [0.566, 0.896, 0.236]  // D
);

/** @type {ProceduralPalette} A cool, desaturated blue/gray palette. */
export const iceMelt = new ProceduralPalette(
  [0.500, 0.500, 0.500], // A
  [0.500, 0.500, 0.500], // B
  [0.083, 0.147, 0.082], // C
  [0.579, 0.353, 0.244]  // D
);

/** @type {ProceduralPalette} A vivid green and yellow-green palette. */
export const lemonLime = new ProceduralPalette(
  [0.455, 0.455, 0.455], // A
  [0.571, 0.151, 0.571], // B
  [0.320, 0.320, 0.320], // C
  [0.087, 0.979, 0.319]  // D
);

/** @type {ProceduralPalette} A dull green/brown, murky water palette. */
export const algae = new ProceduralPalette(
  [0.210, 0.210, 0.210], // A
  [0.500, 1.000, 0.021], // B
  [0.086, 0.086, 0.075], // C
  [0.419, 0.213, 0.436]  // D
);

/** @type {ProceduralPalette} A warm, fiery red/orange/black palette. */
export const embers = new ProceduralPalette(
  [0.500, 0.500, 0.500], // A
  [0.500, 0.500, 0.500], // B
  [0.265, 0.285, 0.198], // C
  [0.577, 0.440, 0.358]  // D
);

/**
 * Applies a falloff (fade to black) to a single color based on a position parameter t.
 * @param {THREE.Color} color - The base color.
 * @param {number} size - The size of the falloff zone [0, 1].
 * @param {number} t - The position parameter [0, 1].
 * @returns {THREE.Color} The blended color.
 */
export const paletteFalloff = function (color, size, t) {
  if (t >= (1 - size)) {
    t = (t - (1 - size)) / size;
    return color.clone().lerpColors(color, new THREE.Color(0, 0, 0), t);
  }
  return color;
}