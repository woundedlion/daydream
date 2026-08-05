/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Dependency-free C++ float-literal formatter shared by the tool pages' code
// generators, so the THREE-free generators can import it without pulling
// Three.js into their unit tests.

// toFixed's maximum fractional precision.
const MAX_FRACTION_DIGITS = 100;

/**
 * Round `n` to `prec` fractional digits as plain decimal with trailing zeros
 * trimmed and at least one fractional digit kept ("2" -> "2.0").
 * @param {number} n - The value to round.
 * @param {number} prec - Fractional digits.
 * @returns {string} The decimal text, without an `f` suffix.
 */
function fixedDecimal(n, prec) {
  let s = n.toFixed(prec).replace(/(\.\d*?)0+$/, '$1');
  if (!s.includes('.')) return s + '.0';
  if (s.endsWith('.')) return s + '0';
  return s;
}

/**
 * Format a number as a C++ float literal: trailing zeros trimmed but always at
 * least one fractional digit, with an `f` suffix (so a whole value stays a
 * valid float literal: 2 -> "2.0f", never "2f"). Routes through toFixed (not
 * toString) so the output is always plain decimal, never scientific notation
 * (which generated C++ float literals avoid).
 *
 * `digits` is a floor, not a cap: toFixed counts fractional digits, not
 * significant figures, so rounding there costs a small value its significant
 * figures. Precision widens until the literal reads back as the same float32,
 * so the emitted C++ and the value that produced it are the same float.
 * @param {number} n - The value to format.
 * @param {number} [digits=6] - Minimum fractional digits before trimming.
 * @returns {string} The C++ float literal (e.g. "1.5f").
 * @throws {Error} When the value is non-finite, formats in exponential notation, or has no plain-decimal literal that reads back as the same float32.
 */
export function formatFloatCpp(n, digits = 6) {
  if (!Number.isFinite(n)) {
    throw new Error(`formatFloatCpp: non-finite value ${n}`);
  }
  if (Math.abs(n) >= 1e21) {
    throw new Error(`formatFloatCpp: magnitude ${n} formats in exponential notation`);
  }
  const target = Math.fround(n);
  for (let prec = Math.max(0, digits); prec <= MAX_FRACTION_DIGITS; prec++) {
    const s = fixedDecimal(n, prec);
    const parsed = parseFloat(s);
    // A nonzero coefficient must never be emitted as 0.0f, even where it is
    // below the float32 subnormal floor and so rounds to a zero target.
    if (parsed === 0 && n !== 0) continue;
    if (Math.fround(parsed) === target) return s + 'f';
  }
  throw new Error(`formatFloatCpp: magnitude ${n} underflows to zero at max precision`);
}
