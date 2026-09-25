/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Dependency-free C++ source formatting shared by the tool pages' code
// generators, so the THREE-free generators can import it without pulling
// Three.js into their unit tests.

/**
 * A value pasted into the engine as a C++ identifier — a seed-solid function
 * name, a namespace qualifier — must match this or the paste is malformed.
 */
export const CPP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The engine headers the generators paste into are clang-formatted at 80
 * columns and the paste goes in verbatim, so this limit is the contract.
 */
export const COLUMN_LIMIT = 80;

/**
 * Greedy fill of `words` at the column limit, the way clang-format packs the
 * comment bodies and initializer lists already in the engine headers.
 * @param {string[]} words - The space-separated words, in order.
 * @param {string} firstIndent - Text the first line starts with.
 * @param {string} [restIndent] - Text every later line starts with; the first
 *   line's indent when omitted.
 * @returns {string[]} The filled lines.
 */
export function fillColumns(words, firstIndent, restIndent = firstIndent) {
  const lines = [];
  let line = firstIndent + words[0];
  for (const word of words.slice(1)) {
    if (line.length + 1 + word.length > COLUMN_LIMIT) {
      lines.push(line);
      line = restIndent + word;
    } else {
      line += ` ${word}`;
    }
  }
  lines.push(line);
  return lines;
}

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
  // toFixed drops the sign of -0, whose C++ literal is a different float32.
  if (n === 0) return Object.is(n, -0) ? '-0.0f' : '0.0f';
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
