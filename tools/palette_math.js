/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Pure palette math mirroring the engine's ProceduralPalette and
// GenerativePalette so the browser tool can predict device colors. Parity is
// close, not exact, on either path:
//   - ProceduralPalette evaluates the cosine with the engine's fast_cosf
//     approximation (so the curve matches the device) and linearizes with an
//     exact pow; only the linearization differs from the device's interpolated
//     16-bit-linear LUT, by up to ~1 LSB per channel.
//   - GenerativePalette previews via a sampler reconstructing each entry from
//     the WASM bridge's 8-bit sRGB LUT, not the engine's native 16-bit-linear
//     BakedPalette. The interpolation domain matches (linear), but the 8-bit
//     source quantization can diverge by MORE than ~1 LSB, most in dark tones.

import { srgbToLinearFloat, linearToSrgbFloat } from './color.js';
import { formatFloatCpp } from './cpp_format.js';

const TWO_PI = 2 * Math.PI;

// Mirror of the engine's fast_cosf (core/math/3dmath.h): a Bhaskara I sine
// approximation, range-reduced to [0, 2π). ProceduralPalette::get evaluates its
// cosine this way on the per-sample path, so the browser preview must use the
// same approximation (not Math.cos) to predict device colors.
function fastSin(x) {
  x -= Math.floor(x / TWO_PI) * TWO_PI;
  let sign = 1;
  if (x > Math.PI) { x -= Math.PI; sign = -1; }
  const xpi = x * (Math.PI - x);
  return (sign * 16 * xpi) / (5 * Math.PI * Math.PI - 4 * xpi);
}
function fastCos(x) { return fastSin(x + Math.PI * 0.5); }

// --- WASM color-math bridge -------------------------------------------------
// The engine's PaletteOps.bakeLut is injected via setPaletteOps; this module
// calls it for the exact colors and mirrors the engine's seeded profile draws.
let bakeLut = null;

/**
 * Injects the WASM PaletteOps bridge GenerativePalette uses to bake its LUT.
 * @param {(shape:number, h1:number, s1:number, v1:number, h2:number, s2:number, v2:number, h3:number, s3:number, v3:number) => (Uint8Array|number[])} fn
 *   Returns a 256*3 sRGB LUT; entry i is the palette sampled at t = i/255.
 */
export function setPaletteOps(fn) {
  bakeLut = fn;
}

// GradientShape enum order, mirrored from core/color/color.h (STRAIGHT=0 .. FALLOFF=3).
const GRADIENT_SHAPE_INDEX = { STRAIGHT: 0, CIRCULAR: 1, VIGNETTE: 2, FALLOFF: 3 };

/**
 * The core procedural palette, defined by C(t) = A + B * cos(TWO_PI * (C * t + D)).
 */
export class ProceduralPalette {
  /**
   * Stores the four cosine-formula coefficient vectors.
   * @param {number[]} a - [r, g, b] vec3 of A (DC offset) coefficients.
   * @param {number[]} b - [r, g, b] vec3 of B (amplitude) coefficients.
   * @param {number[]} c - [r, g, b] vec3 of C (frequency) coefficients.
   * @param {number[]} d - [r, g, b] vec3 of D (phase) coefficients.
   */
  constructor(a, b, c, d) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
  }

  /**
   * Calculates the linearized color vector (R, G, B) for a time parameter t.
   * @param {number} t - Time parameter in [0, 1].
   * @returns {number[]} Linear [R, G, B] float values in [0, 1], approximating
   *   the C++ pipeline: the cosine uses the engine's fast_cosf approximation
   *   and is linearized with an exact pow, so the result can differ from the
   *   device's interpolated 16-bit-linear LUT by up to ~1 LSB per channel.
   */
  get(t) {
    const PI2 = TWO_PI;

    const r = Math.max(0, Math.min(1, this.a[0] + this.b[0] * fastCos(PI2 * (this.c[0] * t + this.d[0]))));
    const g = Math.max(0, Math.min(1, this.a[1] + this.b[1] * fastCos(PI2 * (this.c[1] * t + this.d[1]))));
    const b = Math.max(0, Math.min(1, this.a[2] + this.b[2] * fastCos(PI2 * (this.c[2] * t + this.d[2]))));

    return [srgbToLinearFloat(r), srgbToLinearFloat(g), srgbToLinearFloat(b)];
  }

  /**
   * Raw (unclamped, sRGB) cosine values for all three channels at t, used to
   * plot the underlying curves where over/undershoot past [0, 1] is visible.
   * @param {number} t - Time parameter in [0, 1].
   * @returns {number[]} Unclamped sRGB cosine values as [R, G, B].
   */
  getChannelValues(t) {
    const PI2 = TWO_PI;
    return [
      this.a[0] + this.b[0] * fastCos(PI2 * (this.c[0] * t + this.d[0])),
      this.a[1] + this.b[1] * fastCos(PI2 * (this.c[1] * t + this.d[1])),
      this.a[2] + this.b[2] * fastCos(PI2 * (this.c[2] * t + this.d[2])),
    ];
  }

  /**
   * One channel of the raw (unclamped, sRGB) cosine sample at t.
   * @param {number} t - Time parameter in [0, 1].
   * @param {number} channelIndex - Channel to sample (0=R, 1=G, 2=B).
   * @returns {number} Unclamped sRGB cosine value for the channel.
   */
  getChannelValue(t, channelIndex) {
    return this.getChannelValues(t)[channelIndex];
  }
}

/**
 * The named procedural palettes shipped by the engine, mirrored from
 * core/color/palettes.h (namespace Palettes). Each entry's a/b/c/d are the
 * cosine-formula coefficient vec3s in the order the C++ initializer lists them,
 * so a gallery preview and its exported code match the on-device palette.
 * @type {{name:string, a:number[], b:number[], c:number[], d:number[]}[]}
 */
export const NAMED_PROCEDURAL_PALETTES = [
  { name: 'DARK_RAINBOW', a: [0.367, 0.367, 0.367], b: [0.500, 0.500, 0.500], c: [1.000, 1.000, 1.000], d: [0.000, 0.330, 0.670] },
  { name: 'BLOOD_STREAM', a: [0.169, 0.169, 0.169], b: [0.313, 0.313, 0.313], c: [0.231, 0.231, 0.231], d: [0.036, 0.366, 0.706] },
  { name: 'VINTAGE_SUNSET', a: [0.256, 0.256, 0.256], b: [0.500, 0.080, 0.500], c: [0.277, 0.277, 0.277], d: [0.000, 0.330, 0.670] },
  { name: 'RICH_SUNSET', a: [0.309, 0.500, 0.500], b: [1.000, 1.000, 0.500], c: [0.149, 0.148, 0.149], d: [0.132, 0.222, 0.521] },
  { name: 'UNDERSEA', a: [0.000, 0.000, 0.000], b: [0.500, 0.276, 0.423], c: [0.296, 0.296, 0.296], d: [0.374, 0.941, 0.000] },
  { name: 'LATE_SUNSET', a: [0.337, 0.500, 0.096], b: [0.500, 1.000, 0.176], c: [0.261, 0.261, 0.261], d: [0.153, 0.483, 0.773] },
  { name: 'MANGO_PEEL', a: [0.500, 0.500, 0.500], b: [0.500, 0.080, 0.500], c: [0.431, 0.431, 0.431], d: [0.566, 0.896, 0.236] },
  { name: 'ICE_MELT', a: [0.500, 0.500, 0.500], b: [0.500, 0.500, 0.500], c: [0.083, 0.147, 0.082], d: [0.579, 0.353, 0.244] },
  { name: 'LEMON_LIME', a: [0.455, 0.455, 0.455], b: [0.571, 0.151, 0.571], c: [0.320, 0.320, 0.320], d: [0.087, 0.979, 0.319] },
  { name: 'ALGAE', a: [0.210, 0.210, 0.210], b: [0.500, 1.000, 0.021], c: [0.086, 0.086, 0.075], d: [0.419, 0.213, 0.436] },
  { name: 'EMBERS', a: [0.500, 0.500, 0.500], b: [0.500, 0.500, 0.500], c: [0.265, 0.285, 0.198], d: [0.577, 0.440, 0.358] },
  { name: 'FIRE_GLOW', a: [0.000, 0.000, 0.000], b: [0.560, 0.560, 0.560], c: [0.216, 0.346, 0.174], d: [0.756, 0.542, 0.279] },
  { name: 'DARK_PRIMARY', a: [0.500, 0.500, 0.500], b: [0.500, 0.610, 0.500], c: [0.746, 0.347, 0.000], d: [0.187, 0.417, 0.670] },
  { name: 'MAUVE_FADE', a: [0.583, 0.000, 0.583], b: [1.000, 0.000, 1.000], c: [0.191, 0.348, 0.191], d: [0.175, 0.045, 0.150] },
  { name: 'LAVENDER_LAKE', a: [0.473, 0.473, 0.473], b: [0.500, 0.500, 0.500], c: [0.364, 0.124, 0.528], d: [0.142, 0.378, 0.876] },
  { name: 'DESERT_ROSE', a: [0.500, 0.500, 0.500], b: [0.500, 0.270, 0.442], c: [0.303, 1.012, 0.585], d: [0.985, 0.720, 0.212] },
  { name: 'BRUISED_MOSS', a: [0.500, 0.500, 0.500], b: [0.500, 0.500, 0.500], c: [0.142, 0.252, 0.000], d: [0.492, 0.200, 0.670] },
  { name: 'BRUISED_BANANA', a: [0.620, 0.620, 0.620], b: [0.742, 0.742, 0.742], c: [0.162, 0.286, 0.012], d: [0.235, 0.205, 0.688] },
  { name: 'BRIGHT_SUNRISE', a: [0.620, 0.620, 0.620], b: [0.742, 0.742, 0.742], c: [0.162, 0.286, 0.012], d: [0.090, 0.205, 0.688] },
  { name: 'FIRE_AND_ICE', a: [0.500, 0.500, 0.500], b: [0.500, 0.500, 0.500], c: [0.955, 1.004, 0.910], d: [0.167, 0.018, 0.930] },
  { name: 'PEACH_POP', a: [1.000, 0.144, 0.175], b: [0.543, 0.543, 0.543], c: [0.507, 0.409, 0.507], d: [0.001, 0.002, 0.620] },
  { name: 'POPPED_PEACH', a: [1.000, 0.144, 0.175], b: [0.543, 0.543, 0.543], c: [-0.507, -0.409, -0.507], d: [0.508, 0.411, 1.127] },
  { name: 'BLUE_LAGOON', a: [0.253, 0.500, 1.000], b: [0.500, 0.844, 1.000], c: [0.232086, 0.232086, 0.232086], d: [0.279882, 0.609882, 0.949882] },
  { name: 'ORANGE_CRUSH', a: [0.575, 0.168, 0.464], b: [0.406, 0.697, 0.357], c: [0.000, -0.10051, -0.042778], d: [0.141, 0.25551, 0.579778] },
  { name: 'PLUM_SUNRISE', a: [0.407, 0.000, 0.296], b: [0.332, 0.592, 0.029], c: [0.358961, 0.331145, 0.274519], d: [0.500342, 0.505109, 0.278634] },
];

/**
 * Flattens a palette's a/b/c/d coefficient vec3s into the tool's 12-key
 * `parameters` object (A_R..D_B) the sliders and the C++ export read.
 * @param {{a:number[], b:number[], c:number[], d:number[]}} palette - A {a,b,c,d} coefficient set (e.g. a NAMED_PROCEDURAL_PALETTES entry).
 * @returns {{A_R:number,A_G:number,A_B:number,B_R:number,B_G:number,B_B:number,C_R:number,C_G:number,C_B:number,D_R:number,D_G:number,D_B:number}} The flattened coefficients.
 */
export function proceduralPaletteParams({ a, b, c, d }) {
  return {
    A_R: a[0], A_G: a[1], A_B: a[2],
    B_R: b[0], B_G: b[1], B_B: b[2],
    C_R: c[0], C_G: c[1], C_B: c[2],
    D_R: d[0], D_G: d[1], D_B: d[2],
  };
}

// --- Generative Palette Implementation ---

// Mirror of the engine's hash01 (core/math/3dmath.h): the PCG RXS-M-XS output
// hash, in 32-bit unsigned arithmetic.
function hash01(i, seed) {
  seed >>>= 0;
  let h = (Math.imul((i ^ seed) >>> 0, 747796405) + 2891336453) >>> 0;
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h ^ seed) >>> 0, 277803737) >>> 0;
  h = ((h >>> 22) ^ h) >>> 0;
  return (h >>> 8) / 16777216;
}

/**
 * Mirror of GenerativePalette::seeded_rand_int (core/color/color.h): the
 * seed-hashed setup draw the engine makes when the palette pins its base hue,
 * so a preview reproduces the exported palette rather than merely its ranges.
 * @param {number} seed - Palette seed, i.e. the base hue in 0..255.
 * @param {number} site - Draw-site index, distinct per engine call site.
 * @param {number} min - Inclusive lower bound.
 * @param {number} max - Exclusive upper bound.
 * @returns {number} The drawn integer in [min, max).
 */
export function seededRandInt(seed, site, min, max) {
  if (max <= min) return min;
  const u = hash01(seed, Math.imul(site, 0x9E3779B9) >>> 0);
  // fround: the engine scales the draw in single precision before truncating.
  return min + Math.trunc(Math.fround(u * (max - min)));
}

/**
 * Builds a 3-color gradient palette from high-level profile strings (gradient
 * shape, color harmony, brightness/saturation profiles) plus a base hue,
 * mirroring the engine's GenerativePalette so the tool previews device output.
 */
export class GenerativePalette {
  /**
   * Resolves the profile strings into three anchor colors and gradient stops.
   * satProfile/brightnessProfile values pick fixed or seed-hashed HSV ranges
   * (h, s, v in 0..255) for the three anchor colors a/b/c.
   * @param {string} gradientShape - Gradient-shape profile (e.g. "VIGNETTE", "STRAIGHT").
   * @param {string} harmonyType - Color-harmony rule (e.g. "TRIADIC", "ANALOGOUS").
   * @param {string} brightnessProfile - Brightness profile (e.g. "ASCENDING", "BELL").
   * @param {string} satProfile - Saturation profile ("PASTEL", "MID", "VIBRANT").
   * @param {number} hueValue - Base hue in 0..255.
   */
  constructor(gradientShape, harmonyType, brightnessProfile, satProfile, hueValue) {
    this.gradientShape = gradientShape;
    this.harmonyType = harmonyType;

    assertMember('GradientShape', gradientShape, GRADIENT_SHAPES);
    assertMember('HarmonyType', harmonyType, HARMONY_TYPES);
    assertMember('BrightnessProfile', brightnessProfile, BRIGHTNESS_PROFILES);
    assertMember('SaturationProfile', satProfile, SATURATION_PROFILES);

    const h1 = hueValue;
    const { h2, h3 } = this.calcHues(h1, harmonyType, hueValue);

    let s1 = 0, s2 = 0, s3 = 0;
    switch (satProfile) {
      case "PASTEL":
        s1 = s2 = s3 = 100;
        break;
      case "MID":
        s1 = seededRandInt(hueValue, 4, 153, 204);
        s2 = seededRandInt(hueValue, 5, 153, 204);
        s3 = seededRandInt(hueValue, 6, 153, 204);
        break;
      case "VIBRANT":
        s1 = s2 = s3 = 255;
        break;
    }

    let v1 = 0, v2 = 0, v3 = 0;
    switch (brightnessProfile) {
      case "ASCENDING":
        v1 = seededRandInt(hueValue, 7, 25, 76);
        v2 = seededRandInt(hueValue, 8, 127, 178);
        v3 = seededRandInt(hueValue, 9, 204, 256);
        break;
      case "DESCENDING":
        v1 = seededRandInt(hueValue, 7, 204, 256);
        v2 = seededRandInt(hueValue, 8, 127, 178);
        v3 = seededRandInt(hueValue, 9, 25, 76);
        break;
      case "FLAT":
        v1 = v2 = v3 = 255;
        break;
      case "BELL":
        v1 = seededRandInt(hueValue, 7, 51, 127);
        v2 = seededRandInt(hueValue, 8, 178, 256);
        v3 = v1;
        break;
      case "CUP":
        v1 = seededRandInt(hueValue, 7, 178, 256);
        v2 = seededRandInt(hueValue, 8, 51, 127);
        v3 = v1;
        break;
    }

    const shapeIndex = GRADIENT_SHAPE_INDEX[this.gradientShape];
    if (!bakeLut) {
      throw new Error(
        'PaletteOps bridge not initialized: call setPaletteOps() with the WASM ' +
        'PaletteOps.bakeLut before constructing a GenerativePalette.');
    }
    // Copy out of the WASM memory view: it aliases the module buffer and the
    // next bake invalidates it.
    this.lut = Uint8Array.from(
      bakeLut(shapeIndex, h1, s1, v1, h2, s2, v2, h3, s3, v3));
  }

  /**
   * Wraps a hue into 0..255, handling negative values (JS % can go negative).
   * @param {number} hue - Hue value, possibly out of range or negative.
   * @returns {number} Equivalent hue in 0..255.
   */
  wrapHue(hue) {
    return ((hue % 256) + 256) % 256;
  }

  /**
   * Derives the two companion hues (h2, h3) from base hue h1 per the color-harmony
   * rule. Offsets are in the 0..255 hue space (85 ≈ 120°, 128 ≈ 180°).
   * @param {number} h1 - Base hue in 0..255.
   * @param {string} harmonyType - Color-harmony rule (e.g. "TRIADIC", "ANALOGOUS").
   * @param {number} seed - Palette seed for the jittered harmonies' draws.
   * @returns {{h2:number, h3:number}} The two companion hues in 0..255.
   */
  calcHues(h1, harmonyType, seed) {
    let h2, h3;
    switch (harmonyType) {
      case "TRIADIC":
        h2 = this.wrapHue(h1 + 85);
        h3 = this.wrapHue(h1 + 170);
        break;
      case "SPLIT_COMPLEMENTARY": {
        const complement = this.wrapHue(h1 + 128);
        h2 = this.wrapHue(complement - 21);
        h3 = this.wrapHue(complement + 21);
        break;
      }
      case "COMPLEMENTARY":
        h2 = this.wrapHue(h1 + 128);
        h3 = this.wrapHue(h1 + seededRandInt(seed, 0, -7, 8));
        break;
      case "ANALOGOUS": {
        const dir = (seededRandInt(seed, 1, 0, 2) === 0) ? 1 : -1;
        h2 = this.wrapHue(h1 + dir * seededRandInt(seed, 2, 11, 22));
        h3 = this.wrapHue(h2 + dir * seededRandInt(seed, 3, 11, 22));
        break;
      }
      default:
        throw new Error(`PaletteMath.calcHues: unknown harmonyType "${harmonyType}" ` +
          `(expected one of ${[...HARMONY_TYPES].join(', ')})`);
    }
    return { h2, h3 };
  }

  /**
   * Samples the engine-baked gradient LUT at t, interpolating between adjacent
   * entries in linear light. Domain-verified against the engine: BakedPalette::get
   * (core/color/composition.h) lerps between two linear-light Color4 LUT entries (lerp16), so
   * converting each sRGB-8bit entry here to linear first and lerping in linear
   * matches the engine's interpolation DOMAIN (linear, not sRGB). Note the
   * SOURCE precision does not match: `this.lut` is the bridge's 8-bit sRGB LUT,
   * while the engine's BakedPalette holds 16-bit linear entries — so this
   * reconstruction can diverge by more than ~1 LSB (see the module header),
   * most in dark tones. Close, not exact.
   * @param {number} t - Time parameter in [0, 1] (clamped).
   * @returns {number[]} Linear [R, G, B] float values.
   */
  get(t) {
    const sample = (i) => [
      srgbToLinearFloat(this.lut[3 * i] / 255),
      srgbToLinearFloat(this.lut[3 * i + 1] / 255),
      srgbToLinearFloat(this.lut[3 * i + 2] / 255),
    ];
    const idx = Math.max(0, Math.min(1, t)) * 255;
    const lo = Math.floor(idx);
    if (lo >= 255) return sample(255);
    const frac = idx - lo;
    const a = sample(lo);
    const b = sample(lo + 1);
    return [
      a[0] + (b[0] - a[0]) * frac,
      a[1] + (b[1] - a[1]) * frac,
      a[2] + (b[2] - a[2]) * frac,
    ];
  }

  /**
   * The sRGB sample at t, for curve plotting. Takes the linear triple from
   * get(t) back to sRGB so the wave graph plots the same domain as
   * ProceduralPalette (raw sRGB) and the 8-bit sRGB form the device bakes and
   * exports.
   * @param {number} t - Time parameter in [0, 1].
   * @returns {number[]} sRGB values as [R, G, B].
   */
  getChannelValues(t) {
    const [r, g, b] = this.get(t);
    return [linearToSrgbFloat(r), linearToSrgbFloat(g), linearToSrgbFloat(b)];
  }

  /**
   * One channel of the sRGB sample at t.
   * @param {number} t - Time parameter in [0, 1].
   * @param {number} channelIndex - Channel to sample (0=R, 1=G, 2=B).
   * @returns {number} sRGB value for the channel.
   */
  getChannelValue(t, channelIndex) {
    return this.getChannelValues(t)[channelIndex];
  }
}

/**
 * Linearly remaps a value from the [fromMin, fromMax] range onto [toMin, toMax].
 * Not clamped: inputs outside the source range extrapolate past the target range.
 * @param {number} value - Input value to remap.
 * @param {number} fromMin - Lower bound of the source range.
 * @param {number} fromMax - Upper bound of the source range.
 * @param {number} toMin - Lower bound of the target range.
 * @param {number} toMax - Upper bound of the target range.
 * @returns {number} The remapped value.
 */
export function mapValue(value, fromMin, fromMax, toMin, toMax) {
  if (fromMax === fromMin) return toMin;
  return (value - fromMin) * (toMax - toMin) / (fromMax - fromMin) + toMin;
}

/**
 * The value range the RGB wave graph plots. Wider than the [0, 1] output range
 * so a channel's out-of-range excursions — which the device clamps — stay
 * visible rather than flattening against the top or bottom of the canvas.
 * @type {{min: number, max: number}}
 */
export const WAVE_GRAPH_VALUE_RANGE = { min: -0.5, max: 1.5 };

/**
 * Maps WAVE_GRAPH_VALUE_RANGE onto a wave-graph canvas of the given height: the
 * band between 10% and 90% of the height, value increasing upward. The 10%
 * margins leave the range-boundary lines drawable inside the canvas.
 * @param {number} height - Canvas height in pixels.
 * @returns {{yTop: number, yBottom: number, toY: function(number): number}} The band's canvas-y edges (yTop is the max-value edge) and the value-to-canvas-y map.
 */
export function waveGraphBand(height) {
  const yTop = height * 0.1;
  const yBottom = height * 0.9;
  const { min, max } = WAVE_GRAPH_VALUE_RANGE;
  return { yTop, yBottom, toY: (value) => mapValue(value, min, max, yBottom, yTop) };
}

/**
 * Rescales the procedural cosine-formula frequency (C) and phase (D) triples so
 * the window [tStart, tEnd] of the current palette fills the whole [0, 1] strip.
 * @param {{C_R:number,C_G:number,C_B:number,D_R:number,D_G:number,D_B:number}} parameters - The current frequency/phase coefficients.
 * @param {number} tStart - Start of the zoom window, in current-palette phase.
 * @param {number} tEnd - End of the zoom window, in current-palette phase.
 * @returns {{C_R:number,C_G:number,C_B:number,D_R:number,D_G:number,D_B:number}} The zoomed coefficients; the A/B triples are unaffected.
 * @details Per channel C' = C * (tEnd - tStart) and D' = (D + C * tStart) % 1.
 */
export function zoomedProceduralParams(parameters, tStart, tEnd) {
  const range = tEnd - tStart;
  return {
    C_R: parameters.C_R * range,
    D_R: (parameters.D_R + parameters.C_R * tStart) % 1.0,
    C_G: parameters.C_G * range,
    D_G: (parameters.D_G + parameters.C_G * tStart) % 1.0,
    C_B: parameters.C_B * range,
    D_B: (parameters.D_B + parameters.C_B * tStart) % 1.0,
  };
}

/**
 * Emit the C++ initializer the engine actually consumes —
 * `ProceduralPalette name({r,g,b}f, ...)` — not bare JS arrays. Brace-init
 * each vec3 with `f`-suffixed floats so the output pastes straight into
 * palettes.h beside the named instances, matching the generative tab.
 * @param {{A_R:number,A_G:number,A_B:number,B_R:number,B_G:number,B_B:number,C_R:number,C_G:number,C_B:number,D_R:number,D_G:number,D_B:number}} parameters - The 12 cosine-formula coefficients (A/B/C/D per R/G/B channel).
 * @returns {string} The C++ ProceduralPalette initializer source.
 */
export function proceduralPaletteCpp(parameters) {
  const f = (n) => formatFloatCpp(n, 6);
  const v = (r, g, b) => `{${f(r)}, ${f(g)}, ${f(b)}}`;
  return `ProceduralPalette palette(${v(parameters.A_R, parameters.A_G, parameters.A_B)},  // A
                          ${v(parameters.B_R, parameters.B_G, parameters.B_B)},  // B
                          ${v(parameters.C_R, parameters.C_G, parameters.C_B)},  // C
                          ${v(parameters.D_R, parameters.D_G, parameters.D_B)}); // D`;
}

// The four GenerativePalette enum sets, mirrored from core/color/color.h. A token
// outside these sets would paste a nonexistent enumerator into the emitted C++,
// so generativePaletteCpp rejects it at the source.
export const GRADIENT_SHAPES = new Set(Object.keys(GRADIENT_SHAPE_INDEX));
export const HARMONY_TYPES = new Set(['TRIADIC', 'SPLIT_COMPLEMENTARY', 'COMPLEMENTARY', 'ANALOGOUS']);
export const BRIGHTNESS_PROFILES = new Set(['ASCENDING', 'DESCENDING', 'FLAT', 'BELL', 'CUP']);
export const SATURATION_PROFILES = new Set(['PASTEL', 'MID', 'VIBRANT']);

/**
 * Throws if `token` is not in `allowed`, naming the value and the permitted set.
 * Shared by GenerativePalette and generativePaletteCpp so the preview and the
 * C++ export reject the same vocabulary with one error format.
 * @param {string} label - Enum name shown in the error (e.g. "GradientShape").
 * @param {string} token - The candidate value to validate.
 * @param {Set<string>} allowed - The permitted values.
 */
function assertMember(label, token, allowed) {
  if (!allowed.has(token)) {
    throw new Error(`unknown ${label} "${token}" ` +
      `(expected one of ${[...allowed].join(', ')})`);
  }
}

/**
 * Emit the generative-tab C++ initializer. Passing the base hue pins the
 * engine's setup draws to the seed-hashed path, so the emitted palette
 * reproduces the preview rather than only its profiles.
 * @param {{shape:string,harmony:string,brightness:string,sat:string,hueValue:number}} opts - Gradient shape, harmony, brightness/saturation profiles and base hue.
 * @returns {string} The C++ GenerativePalette initializer source.
 */
export function generativePaletteCpp({ shape, harmony, brightness, sat, hueValue }) {
  assertMember('GradientShape', shape, GRADIENT_SHAPES);
  assertMember('HarmonyType', harmony, HARMONY_TYPES);
  assertMember('BrightnessProfile', brightness, BRIGHTNESS_PROFILES);
  assertMember('SaturationProfile', sat, SATURATION_PROFILES);
  if (!Number.isInteger(hueValue) || hueValue < 0 || hueValue > 255) {
    throw new Error(`generativePaletteCpp: hueValue ${hueValue} must be an ` +
      `integer in 0..255`);
  }
  return `GenerativePalette palette{\n    GradientShape::${shape}, HarmonyType::${harmony},\n    BrightnessProfile::${brightness}, SaturationProfile::${sat}, ${hueValue}};`;
}
