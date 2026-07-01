/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Shared sRGB / linear-RGB color-space math, mirroring the engine's perceptual
// pipeline (core/color.h: same sRGB transfer function) so the tools predict what
// the device renders.

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
