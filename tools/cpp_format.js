/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Dependency-free C++ float-literal formatter shared by the tool pages' code
// generators. Kept in its own module (like clipboard.js) so the pure,
// THREE-free generators (spline_math, solid_codegen, palette_math) can import
// it without pulling Three.js into their unit tests, while shared.js re-exports
// it for the scene-based pages.

/**
 * Format a number as a C++ float literal: fixed precision, trailing zeros
 * trimmed but always at least one fractional digit, with an `f` suffix (so a
 * whole value stays a valid float literal: 2 -> "2.0f", never "2f"). Routes
 * through toFixed (not toString) so extreme magnitudes never emit scientific
 * notation, which is not a valid C++ float literal (e.g. 1e-7).
 * @param {number} n - The value to format.
 * @param {number} [digits=6] - Fractional digits to round to before trimming.
 * @returns {string} The C++ float literal (e.g. "1.5f").
 */
export function formatFloatCpp(n, digits = 6) {
  let s = n.toFixed(digits).replace(/(\.\d*?)0+$/, '$1');
  if (s.endsWith('.')) s += '0';
  return s + 'f';
}
