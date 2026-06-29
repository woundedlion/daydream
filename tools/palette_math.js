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

import { srgbToLinearFloat } from './color.js';
import { formatFloatCpp } from './cpp_format.js';

const TWO_PI = 2 * Math.PI;

// Mirror of the engine's fast_cosf (core/3dmath.h): a Bhaskara I sine
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
// calls it for the exact colors and keeps only the JS-side profile PRNG.
let bakeLut = null;

/**
 * Injects the WASM PaletteOps bridge GenerativePalette uses to bake its LUT.
 * @param {(shape:number, h1:number, s1:number, v1:number, h2:number, s2:number, v2:number, h3:number, s3:number, v3:number) => (Uint8Array|number[])} fn
 *   Returns a 256*3 sRGB LUT; entry i is the palette sampled at t = i/255.
 */
export function setPaletteOps(fn) {
  bakeLut = fn;
}

// GradientShape enum order, mirrored from core/color.h (STRAIGHT=0 .. FALLOFF=3).
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
   * Raw (unclamped, sRGB) cosine value for one channel at t, used to plot the
   * underlying curves where over/undershoot past [0, 1] is visible.
   * @param {number} t - Time parameter in [0, 1].
   * @param {number} channelIndex - Channel to sample (0=R, 1=G, 2=B).
   * @returns {number} Unclamped sRGB cosine value for the channel.
   */
  getChannelValue(t, channelIndex) {
    const PI2 = TWO_PI;
    return this.a[channelIndex] + this.b[channelIndex] * fastCos(PI2 * (this.c[channelIndex] * t + this.d[channelIndex]));
  }
}

// --- Generative Palette Implementation ---

/**
 * An 8-bit RGB color (channels in 0..255), mirroring the engine's CRGB.
 */
export class CPixel {
  /**
   * @param {number} r - Red channel in 0..255.
   * @param {number} g - Green channel in 0..255.
   * @param {number} b - Blue channel in 0..255.
   */
  constructor(r, g, b) {
    this.r = r; this.g = g; this.b = b;
  }
}

/**
 * Seeded linear-congruential PRNG for reproducible palette generation.
 */
export class PRNG {
  /**
   * @param {number} seed - Initial state. A non-finite seed (undefined/null/NaN)
   *   falls back to a random one so the tool still works without an explicit
   *   seed. Note 0 is a VALID seed and stays reproducible — the old `seed ? ...`
   *   test treated 0 as "unset" and silently randomized it.
   */
  constructor(seed) {
    this.state = Number.isFinite(seed) ? seed : Math.floor(Math.random() * 0xFFFFFFFF);
  }
  /**
   * Advances the state and returns the next float.
   * @returns {number} Pseudo-random float in [0, 1).
   */
  next() {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  /**
   * Half-open [min, max) integer to match the engine's hs::rand_int, so a
   * ported range produces exactly the values the device does. Call sites use
   * the engine's own rand_int literals.
   * @param {number} min - Inclusive lower bound.
   * @param {number} max - Exclusive upper bound.
   * @returns {number} Pseudo-random integer in [min, max).
   */
  nextInt(min, max) {
    return Math.floor(this.next() * (max - min)) + min;
  }
}

/**
 * HSV to RGB conversion, ported byte-for-byte from the engine's
 * CRGB(const CHSV&) path in core/platform.h: the hue wheel is split into six
 * 43-wide regions (region = h/43) and the channels are mixed with >>8
 * fixed-point math. Float sextant math drifts from the device near every region
 * boundary (e.g. pure green lands at h=86, not 85), so this mirrors the integer
 * path exactly to keep an exported palette's base color faithful.
 * @param {number} h - Hue in 0..255 (masked to a byte).
 * @param {number} s - Saturation in 0..255 (masked to a byte).
 * @param {number} v - Value/brightness in 0..255 (masked to a byte).
 * @returns {CPixel} RGB color with channels in 0..255.
 */
export function hsvToRgb(h, s, v) {
  h &= 0xff;
  s &= 0xff;
  v &= 0xff;

  if (s === 0) {
    return new CPixel(v, v, v);
  }

  const region = Math.floor(h / 43);
  const remainder = (h - region * 43) * 6;

  const p = (v * (255 - s)) >> 8;
  const q = (v * (255 - ((s * remainder) >> 8))) >> 8;
  const t = (v * (255 - ((s * (255 - remainder)) >> 8))) >> 8;

  switch (region) {
    case 0: return new CPixel(v, t, p);
    case 1: return new CPixel(q, v, p);
    case 2: return new CPixel(p, v, t);
    case 3: return new CPixel(p, q, v);
    case 4: return new CPixel(t, p, v);
    default: return new CPixel(v, p, q);
  }
}

/**
 * Builds a 3-color gradient palette from high-level profile strings (gradient
 * shape, color harmony, brightness/saturation profiles) plus a base hue,
 * mirroring the engine's GenerativePalette so the tool previews device output.
 */
export class GenerativePalette {
  /**
   * Resolves the profile strings into three anchor colors and gradient stops.
   * satProfile/brightnessProfile values pick fixed or PRNG-sampled HSV ranges
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

    // Seed from the profile strings (not the hue) so scrubbing the hue keeps the
    // randomized saturation/brightness structure stable.
    const hashStr = gradientShape + harmonyType + brightnessProfile + satProfile;
    let stableSeed = 0;
    for (let i = 0; i < hashStr.length; i++) {
      stableSeed = ((stableSeed << 5) - stableSeed) + hashStr.charCodeAt(i);
      stableSeed |= 0;
    }
    this.prng = new PRNG(Math.abs(stableSeed) || 1337);

    let h1 = hueValue;
    let hues = this.calcHues(h1, harmonyType);
    let h2 = hues.h2;
    let h3 = hues.h3;

    let s1 = 0, s2 = 0, s3 = 0;
    switch (satProfile) {
      case "PASTEL":
        s1 = s2 = s3 = 100;
        break;
      case "MID":
        s1 = this.prng.nextInt(153, 204);
        s2 = this.prng.nextInt(153, 204);
        s3 = this.prng.nextInt(153, 204);
        break;
      case "VIBRANT":
        s1 = s2 = s3 = 255;
        break;
      default:
        throw new Error(`unknown SaturationProfile "${satProfile}"`);
    }

    let v1 = 0, v2 = 0, v3 = 0;
    switch (brightnessProfile) {
      case "ASCENDING":
        v1 = this.prng.nextInt(25, 76);
        v2 = this.prng.nextInt(127, 178);
        v3 = this.prng.nextInt(204, 255);
        break;
      case "DESCENDING":
        v1 = this.prng.nextInt(204, 255);
        v2 = this.prng.nextInt(127, 178);
        v3 = this.prng.nextInt(25, 76);
        break;
      case "FLAT":
        v1 = v2 = v3 = 255;
        break;
      case "BELL":
        v1 = this.prng.nextInt(51, 127);
        v2 = this.prng.nextInt(178, 255);
        v3 = v1;
        break;
      case "CUP":
        v1 = this.prng.nextInt(178, 255);
        v2 = this.prng.nextInt(51, 127);
        v3 = v1;
        break;
      default:
        throw new Error(`unknown BrightnessProfile "${brightnessProfile}"`);
    }

    const shapeIndex = GRADIENT_SHAPE_INDEX[this.gradientShape];
    if (shapeIndex === undefined) {
      throw new Error(`unknown GradientShape "${this.gradientShape}"`);
    }
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
   * @returns {{h2:number, h3:number}} The two companion hues in 0..255.
   */
  calcHues(h1, harmonyType) {
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
        h3 = this.wrapHue(h1 + this.prng.nextInt(-7, 8));
        break;
      case "ANALOGOUS": {
        const dir = (this.prng.nextInt(0, 2) === 0) ? 1 : -1;
        h2 = this.wrapHue(h1 + dir * this.prng.nextInt(11, 22));
        h3 = this.wrapHue(h2 + dir * this.prng.nextInt(11, 22));
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
   * (core/color.h) lerps between two linear-light Color4 LUT entries (lerp16), so
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
   * One channel of the linear sample at t, for curve plotting. Recomputes the
   * full triple via get(t) and discards two channels; cost is negligible at
   * plot resolution.
   * @param {number} t - Time parameter in [0, 1].
   * @param {number} channelIndex - Channel to sample (0=R, 1=G, 2=B).
   * @returns {number} Linear value for the channel.
   */
  getChannelValue(t, channelIndex) {
    return this.get(t)[channelIndex];
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

// The four GenerativePalette enum sets, mirrored from core/color.h. A token
// outside these sets would paste a nonexistent enumerator into the emitted C++,
// so generativePaletteCpp rejects it at the source.
export const GRADIENT_SHAPES = new Set(['STRAIGHT', 'CIRCULAR', 'VIGNETTE', 'FALLOFF']);
export const HARMONY_TYPES = new Set(['TRIADIC', 'SPLIT_COMPLEMENTARY', 'COMPLEMENTARY', 'ANALOGOUS']);
export const BRIGHTNESS_PROFILES = new Set(['ASCENDING', 'DESCENDING', 'FLAT', 'BELL', 'CUP']);
export const SATURATION_PROFILES = new Set(['PASTEL', 'MID', 'VIBRANT']);

/**
 * Emit the generative-tab C++ initializer.
 *
 * Reproducibility caveat: this tool draws the per-palette saturation,
 * brightness and harmony hue offsets from a PRNG seeded by the profile
 * strings, but the engine's GenerativePalette draws them from its global
 * RNG. So the export reproduces the gradient shape, harmony, profiles and
 * base hue exactly, but its randomized structure will differ from this
 * preview. The caveat is stated in the emitted comment so the export isn't
 * mistaken for a pixel-faithful reproduction.
 * @param {{shape:string,harmony:string,brightness:string,sat:string,hueValue:number}} opts - Gradient shape, harmony, brightness/saturation profiles and base hue.
 * @returns {string} The C++ GenerativePalette initializer source, prefixed with the reproducibility caveat comment.
 */
export function generativePaletteCpp({ shape, harmony, brightness, sat, hueValue }) {
  const reject = (label, token, allowed) => {
    if (!allowed.has(token)) {
      throw new Error(`generativePaletteCpp: unknown ${label} "${token}" ` +
        `(expected one of ${[...allowed].join(', ')})`);
    }
  };
  reject('GradientShape', shape, GRADIENT_SHAPES);
  reject('HarmonyType', harmony, HARMONY_TYPES);
  reject('BrightnessProfile', brightness, BRIGHTNESS_PROFILES);
  reject('SaturationProfile', sat, SATURATION_PROFILES);
  if (!Number.isInteger(hueValue) || hueValue < 0 || hueValue > 255) {
    throw new Error(`generativePaletteCpp: hueValue ${hueValue} must be an ` +
      `integer in 0..255`);
  }
  return `// Reproduces the profiles + base hue exactly; the randomized\n// saturation/brightness/hue-offset structure is drawn from the\n// engine's global RNG and will differ from the tool preview.\nGenerativePalette palette{\n    GradientShape::${shape}, HarmonyType::${harmony},\n    BrightnessProfile::${brightness}, SaturationProfile::${sat}, ${hueValue}};`;
}
