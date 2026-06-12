/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Shared sRGB / linear-RGB / OKLab / OKLCH color-space math for the browser
// tools. This mirrors the engine's perceptual pipeline (core/color.h: the same
// sRGB transfer function and Björn Ottosson OKLab matrices) so the tools predict
// what the device renders. Kept in one module rather than re-implemented inline
// per tool, where the copies would silently drift from each other and the engine.

// --- sRGB transfer function (gamma) ---

/**
 * Applies the sRGB transfer function (gamma) to convert an sRGB channel to linear.
 * @param {number} s - sRGB channel value in [0, 1].
 * @returns {number} The linearized channel value in [0, 1].
 */
export function srgbToLinearFloat(s) {
  return (s <= 0.04045) ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * Applies the inverse sRGB transfer function to convert a linear channel to sRGB.
 * @param {number} l - Linear channel value in [0, 1].
 * @returns {number} The sRGB-encoded channel value in [0, 1].
 */
export function linearToSrgbFloat(l) {
  return (l <= 0.0031308) ? l * 12.92 : 1.055 * Math.pow(l, 1.0 / 2.4) - 0.055;
}

// --- OKLab / OKLCH color space (Björn Ottosson, 2020) ---

/**
 * Converts a linear RGB color to OKLab using the Björn Ottosson matrices.
 * @param {number} r - Linear red channel in [0, 1].
 * @param {number} g - Linear green channel in [0, 1].
 * @param {number} b - Linear blue channel in [0, 1].
 * @returns {{L:number, a:number, b:number}} The OKLab color (lightness L, opponent axes a and b).
 */
export function linearRgbToOklab(r, g, b) {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return {
    L: 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  };
}

/**
 * Converts an OKLab color to linear RGB. The result may be out of the [0, 1] gamut.
 * @param {{L:number, a:number, b:number}} lab - The OKLab color (lightness L, opponent axes a and b).
 * @returns {{r:number, g:number, b:number}} The linear RGB color, possibly out of gamut.
 */
export function oklabToLinearRgb(lab) {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return {
    r: +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  };
}

/**
 * Converts an OKLab color to its cylindrical OKLCH form.
 * @param {{L:number, a:number, b:number}} lab - The OKLab color (lightness L, opponent axes a and b).
 * @returns {{L:number, C:number, h:number}} The OKLCH color (lightness L, chroma C, hue h in radians).
 */
export function oklabToOklch(lab) {
  return {
    L: lab.L,
    C: Math.sqrt(lab.a * lab.a + lab.b * lab.b),
    h: Math.atan2(lab.b, lab.a)
  };
}

/**
 * Converts a cylindrical OKLCH color back to OKLab.
 * @param {{L:number, C:number, h:number}} lch - The OKLCH color (lightness L, chroma C, hue h in radians).
 * @returns {{L:number, a:number, b:number}} The OKLab color (lightness L, opponent axes a and b).
 */
export function oklchToOklab(lch) {
  return { L: lch.L, a: lch.C * Math.cos(lch.h), b: lch.C * Math.sin(lch.h) };
}

/**
 * Converts an sRGB byte color to OKLCH, applying the full sRGB -> linear -> OKLab -> OKLCH pipeline.
 * @param {number} r - sRGB red channel in [0, 255].
 * @param {number} g - sRGB green channel in [0, 255].
 * @param {number} b - sRGB blue channel in [0, 255].
 * @returns {{L:number, C:number, h:number}} The OKLCH color (lightness L, chroma C, hue h in radians).
 */
export function srgbToOklch(r, g, b) {
  return oklabToOklch(linearRgbToOklab(
    srgbToLinearFloat(r / 255.0),
    srgbToLinearFloat(g / 255.0),
    srgbToLinearFloat(b / 255.0)
  ));
}

/**
 * Interpolates between two OKLCH colors, taking the shortest hue arc and treating
 * near-achromatic endpoints (chroma below 1e-4) as having no meaningful hue.
 * @param {{L:number, C:number, h:number}} a - Start OKLCH color (hue h in radians).
 * @param {{L:number, C:number, h:number}} b - End OKLCH color (hue h in radians).
 * @param {number} t - Interpolation factor in [0, 1] (0 yields a, 1 yields b).
 * @returns {{L:number, C:number, h:number}} The interpolated OKLCH color.
 */
export function lerpOklch(a, b, t) {
  let h;
  if (a.C < 1e-4 && b.C < 1e-4) {
    h = 0;
  } else if (a.C < 1e-4) {
    h = b.h;
  } else if (b.C < 1e-4) {
    h = a.h;
  } else {
    let dh = b.h - a.h;
    if (dh > Math.PI) dh -= 2 * Math.PI;
    if (dh < -Math.PI) dh += 2 * Math.PI;
    h = a.h + dh * t;
  }
  return { L: a.L + (b.L - a.L) * t, C: a.C + (b.C - a.C) * t, h };
}

/**
 * Converts an OKLCH color to linear RGB, clamping each channel into [0, 1].
 * @param {{L:number, C:number, h:number}} lch - The OKLCH color (lightness L, chroma C, hue h in radians).
 * @returns {Array<number>} The clamped linear RGB color as [r, g, b], each in [0, 1].
 */
export function oklchToLinearRgb(lch) {
  const rgb = oklabToLinearRgb(oklchToOklab(lch));
  return [
    Math.max(0, Math.min(1, rgb.r)),
    Math.max(0, Math.min(1, rgb.g)),
    Math.max(0, Math.min(1, rgb.b))
  ];
}

/**
 * Converts a linear RGB color to a "#rrggbb" hex string, applying the linear -> sRGB
 * transfer function and clamping each channel before encoding.
 * @param {number} r - Linear red channel in [0, 1].
 * @param {number} g - Linear green channel in [0, 1].
 * @param {number} b - Linear blue channel in [0, 1].
 * @returns {string} The color as a "#rrggbb" hex string.
 */
export function linearRgbToHex(r, g, b) {
  /**
   * Encodes one linear channel as a two-digit sRGB hex byte, clamped into [0, 255].
   * @param {number} c - Linear channel value in [0, 1].
   * @returns {string} Two-character lowercase hex byte.
   */
  const toHex = (c) => {
    const i = Math.round(linearToSrgbFloat(Math.max(0, Math.min(1, c))) * 255);
    const hex = Math.max(0, Math.min(255, i)).toString(16);
    return hex.length === 1 ? "0" + hex : hex;
  };
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}
