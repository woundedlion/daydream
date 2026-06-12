/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Pure palette math extracted from tools/palettes.html. This module mirrors the
// engine's ProceduralPalette and GenerativePalette so the browser tool predicts
// the exact colors the device produces, and so the C++ export-string generators
// can be regression-tested without a DOM. No DOM/canvas/window references live
// here; all UI wiring stays inline in palettes.html.

import { srgbToLinearFloat, srgbToOklch, lerpOklch, oklchToLinearRgb } from './color.js';

const TWO_PI = 2 * Math.PI;

/**
 * The core procedural palette class.
 * C(t) = A + B * cos(TWO_PI * (C * t + D))
 */
export class ProceduralPalette {
  // a/b/c/d are each a [r, g, b] vec3 of cosine-formula coefficients.
  constructor(a, b, c, d) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
  }

  /**
   * Calculates the color vector (R, G, B) for a time parameter t in [0, 1].
   * @param {number} t Time parameter (0 to 1).
   * @returns {number[]} Array [R, G, B] of float values in [0, 1].
   */
  get(t) {
    const PI2 = TWO_PI;

    // Cosine formula yields sRGB; clamp each channel to [0, 1].
    const r = Math.max(0, Math.min(1, this.a[0] + this.b[0] * Math.cos(PI2 * (this.c[0] * t + this.d[0]))));
    const g = Math.max(0, Math.min(1, this.a[1] + this.b[1] * Math.cos(PI2 * (this.c[1] * t + this.d[1]))));
    const b = Math.max(0, Math.min(1, this.a[2] + this.b[2] * Math.cos(PI2 * (this.c[2] * t + this.d[2]))));

    // Linearize so callers see the same values as the C++ pipeline and GenerativePalette.
    return [srgbToLinearFloat(r), srgbToLinearFloat(g), srgbToLinearFloat(b)];
  }

  // Raw (unclamped, sRGB) cosine value for one channel at t — used to plot the
  // underlying curves in the tool, where over/undershoot past [0, 1] is visible.
  getChannelValue(t, channelIndex) {
    const PI2 = TWO_PI;
    return this.a[channelIndex] + this.b[channelIndex] * Math.cos(PI2 * (this.c[channelIndex] * t + this.d[channelIndex]));
  }
}

// --- Generative Palette Implementation ---

// An 8-bit RGB color (channels in 0..255), mirroring the engine's CRGB.
export class CPixel {
  constructor(r, g, b) {
    this.r = r; this.g = g; this.b = b;
  }
}

// Seeded linear-congruential PRNG for reproducible palette generation. A zero
// seed falls back to a random one so the tool still works without an explicit seed.
export class PRNG {
  constructor(seed) {
    this.state = seed ? seed : Math.floor(Math.random() * 0xFFFFFFFF);
  }
  // Next float in [0, 1).
  next() {
    this.state = (this.state * 1664525 + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }
  // Half-open [min, max) to match the engine's hs::rand_int, so a ported range
  // produces exactly the values the device does. Call sites use the engine's
  // own rand_int literals.
  nextInt(min, max) {
    return Math.floor(this.next() * (max - min)) + min;
  }
}

// HSV to RGB conversion (h, s, v in 0..255), ported byte-for-byte from the
// engine's CRGB(const CHSV&) path in core/platform.h: the hue wheel is split
// into six 43-wide regions (region = h/43) and the channels are mixed with
// >>8 fixed-point math. Float sextant math drifts from the device near every
// region boundary (e.g. pure green lands at h=86, not 85), so we mirror the
// integer path exactly to keep an exported palette's base color faithful.
// Returns CPixel with values in 0..255.
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

// Builds a 3-color gradient palette from high-level profile strings (gradient
// shape, color harmony, brightness/saturation profiles) plus a base hue,
// mirroring the engine's GenerativePalette so the tool previews device output.
export class GenerativePalette {
  // satProfile/brightnessProfile values pick fixed or PRNG-sampled HSV ranges
  // (h, s, v in 0..255) for the three anchor colors a/b/c; hueValue is the base hue.
  constructor(gradientShape, harmonyType, brightnessProfile, satProfile, hueValue) {
    this.gradientShape = gradientShape;
    this.harmonyType = harmonyType;

    // Use a stable deterministic PRNG seed based on the profile strings so that
    // scrubbing the Hue doesn't scramble the randomized saturation/brightness structure.
    const hashStr = gradientShape + harmonyType + brightnessProfile + satProfile;
    let stableSeed = 0;
    for (let i = 0; i < hashStr.length; i++) {
      stableSeed = ((stableSeed << 5) - stableSeed) + hashStr.charCodeAt(i);
      stableSeed |= 0; // Convert to 32bit integer
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
    }

    this.a = hsvToRgb(h1, s1, v1);
    this.b = hsvToRgb(h2, s2, v2);
    this.c = hsvToRgb(h3, s3, v3);

    this.updateLuts();
  }

  // Wrap a hue into 0..255, handling negative values (JS % can go negative).
  wrapHue(hue) {
    return ((hue % 256) + 256) % 256;
  }

  // Derive the two companion hues (h2, h3) from base hue h1 per the color-harmony
  // rule. Offsets are in the 0..255 hue space (85 ≈ 120°, 128 ≈ 180°).
  calcHues(h1, harmonyType) {
    let h2, h3;
    switch (harmonyType) {
      case "TRIADIC":
        h2 = this.wrapHue(h1 + 85);
        h3 = this.wrapHue(h1 + 170);
        break;
      case "SPLIT_COMPLEMENTARY":
        const complement = this.wrapHue(h1 + 128);
        h2 = this.wrapHue(complement - 21);
        h3 = this.wrapHue(complement + 21);
        break;
      case "COMPLEMENTARY":
        h2 = this.wrapHue(h1 + 128);
        h3 = this.wrapHue(h1 + this.prng.nextInt(-7, 8));
        break;
      case "ANALOGOUS":
      default:
        const dir = (this.prng.nextInt(0, 2) === 0) ? 1 : -1;
        h2 = this.wrapHue(h1 + dir * this.prng.nextInt(11, 22));
        h3 = this.wrapHue(h2 + dir * this.prng.nextInt(11, 22));
        break;
    }
    return { h2, h3 };
  }

  // Build the gradient's stop positions (shape), colors and stop count from the
  // gradient-shape profile. Shapes that fade to black insert a black vignette stop.
  updateLuts() {
    const vignetteColor = new CPixel(0, 0, 0);
    switch (this.gradientShape) {
      case "VIGNETTE":
        this.shape = [0, 0.1, 0.5, 0.9, 1.0];
        this.colors = [vignetteColor, this.a, this.b, this.c, vignetteColor];
        this.size = 5;
        break;
      case "STRAIGHT":
        this.shape = [0, 0.5, 1.0];
        this.colors = [this.a, this.b, this.c];
        this.size = 3;
        break;
      case "CIRCULAR":
        this.shape = [0, 0.33, 0.66, 1.0];
        this.colors = [this.a, this.b, this.c, this.a];
        this.size = 4;
        break;
      case "FALLOFF":
        this.shape = [0, 0.33, 0.66, 0.9, 1.0];
        this.colors = [this.a, this.b, this.c, vignetteColor, vignetteColor];
        this.size = 5;
        break;
    }
  }

  // Sample the gradient at t in [0, 1], returning linear [R, G, B]. Locates the
  // stop segment containing t and interpolates between its two endpoint colors.
  get(t) {
    let seg = -1;
    for (let i = 0; i < this.size - 1; ++i) {
      if (t >= this.shape[i] && t < this.shape[i + 1]) {
        seg = i;
        break;
      }
    }
    if (seg < 0) seg = this.size - 2;

    const start = this.shape[seg];
    const end = this.shape[seg + 1];
    const c1 = this.colors[seg];
    const c2 = this.colors[seg + 1];

    const dist = end - start;
    if (dist < 0.0001) {
      return [srgbToLinearFloat(c1.r / 255), srgbToLinearFloat(c1.g / 255), srgbToLinearFloat(c1.b / 255)];
    }

    const p = Math.max(0, Math.min(1, (t - start) / dist));

    // Interpolate in OKLCH for perceptually uniform gradients
    const lch1 = srgbToOklch(c1.r, c1.g, c1.b);
    const lch2 = srgbToOklch(c2.r, c2.g, c2.b);
    return oklchToLinearRgb(lerpOklch(lch1, lch2, p));
  }

  // One channel (0=R, 1=G, 2=B) of the linear sample at t, for curve plotting.
  getChannelValue(t, channelIndex) {
    return this.get(t)[channelIndex];
  }
}

/**
 * Linearly remap value from the [fromMin, fromMax] range onto [toMin, toMax].
 * Not clamped: inputs outside the source range extrapolate past the target range.
 */
export function mapValue(value, fromMin, fromMax, toMin, toMax) {
  return (value - fromMin) * (toMax - toMin) / (fromMax - fromMin) + toMin;
}

/**
 * Emit the C++ initializer the engine actually consumes —
 * `ProceduralPalette name({r,g,b}f, ...)` — not bare JS arrays. Brace-init
 * each vec3 with `f`-suffixed floats so the output pastes straight into
 * palettes.h beside the named instances, matching the generative tab.
 * @param {{A_R:number,A_G:number,A_B:number,B_R:number,B_G:number,B_B:number,C_R:number,C_G:number,C_B:number,D_R:number,D_G:number,D_B:number}} parameters
 * @returns {string}
 */
export function proceduralPaletteCpp(parameters) {
  const f = (n) => n.toFixed(3) + 'f';
  const v = (r, g, b) => `{${f(r)}, ${f(g)}, ${f(b)}}`;
  return `ProceduralPalette palette(${v(parameters.A_R, parameters.A_G, parameters.A_B)},  // A
                          ${v(parameters.B_R, parameters.B_G, parameters.B_B)},  // B
                          ${v(parameters.C_R, parameters.C_G, parameters.C_B)},  // C
                          ${v(parameters.D_R, parameters.D_G, parameters.D_B)}); // D`;
}

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
 * @param {{shape:string,harmony:string,brightness:string,sat:string,hueValue:number}} opts
 * @returns {string}
 */
export function generativePaletteCpp({ shape, harmony, brightness, sat, hueValue }) {
  return `// Reproduces the profiles + base hue exactly; the randomized\n// saturation/brightness/hue-offset structure is drawn from the\n// engine's global RNG and will differ from the tool preview.\nGenerativePalette palette{\n    GradientShape::${shape}, HarmonyType::${harmony},\n    BrightnessProfile::${brightness}, SaturationProfile::${sat}, ${hueValue}};`;
}
