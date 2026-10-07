// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Lissajous curves and rational-frequency matching.
import { formatFloatCpp } from '../../shared/cpp_format.js';

const TWO_PI = 2 * Math.PI;

/**
 * The largest denominator the ratio search admits, and its default numerator
 * cap. The closing period is 2π·N/passiveC.
 * @type {number}
 */
export const MAX_RATIONAL_TERM = 8;

// Cap on numerators the range-bounded search walks.
const MAX_SEARCH_NUMERATOR = 1024;

/**
 * Greatest common divisor of two non-negative integers (Euclid).
 * @param {number} a - First integer (>= 0).
 * @param {number} b - Second integer (>= 0).
 * @returns {number} gcd(a, b); gcd(0, 0) is 0.
 */
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/**
 * The reduced ratio of a pair that already closes: the smallest denominator in
 * [1, maxTerm] whose multiple of the ratio is a whole number of active turns.
 * @param {number} ratio - Active over passive frequency.
 * @param {number} maxTerm - Largest denominator to try.
 * @param {number} [tol] - Relative tolerance on the whole-number test.
 * @returns {?{ M: number, N: number }} The reduced ratio, or null when the pair
 *   closes at no denominator this small.
 */
const closingRatio = (ratio, maxTerm, tol = 1e-9) => {
  for (let N = 1; N <= maxTerm; N++) {
    const M = Math.round(ratio * N);
    if (Math.abs(ratio * N - M) > tol * Math.max(1, Math.abs(M))) continue;
    const g = gcd(Math.abs(M), N);
    return { M: M / g, N: N / g };
  }
  return null;
};

/**
 * The spherical Lissajous parametric curve (on the unit sphere, R = 1).
 * Argument order mirrors the engine's lissajous(m1, m2, a, t) (core/math/spherical.h).
 * @param {number} m1 - Axial frequency C₁.
 * @param {number} m2 - Orbital frequency C₂.
 * @param {number} a - Phase shift A (radians).
 * @param {number} t - Curve parameter.
 * @returns {{x: number, y: number, z: number}} Point on the unit sphere.
 */
export const lissajous = (m1, m2, a, t) => {
  const phase = a;
  const x = Math.sin(m2 * t) * Math.cos(m1 * t - phase);
  const y = Math.cos(m2 * t);
  const z = Math.sin(m2 * t) * Math.sin(m1 * t - phase);
  // Already unit-length: sin²(m2·t)(cos²+sin²) + cos²(m2·t) = 1.
  return { x, y, z };
};

/**
 * Finds the simplest rational approximation (M/N) for a given value (ratio).
 * A negative target returns a negative numerator (sign carried on M, N stays
 * positive).
 * @param {number} value - The ratio to approximate (e.g., C1/C2), may be negative.
 * @param {number} [maxTerm] - Maximum denominator, and the default maximum
 *   numerator (the search grid is then square: M, N each range over [1, maxTerm]).
 * @param {((value: number) => boolean)|null} [accept] - Optional test on the signed
 *   candidate ratio. Candidates it rejects rank behind every accepted one, so a
 *   ratio it admits always wins and an empty admissible set still returns the
 *   closest fraction. The test must depend only on the candidate ratio.
 * @param {number} [maxNumerator] - Maximum numerator, when the reachable
 *   ratios run past the denominator cap.
 * @returns {{ M: number, N: number }} The best simple rational ratio.
 */
export const findBestRationalRatio = (value, maxTerm = MAX_RATIONAL_TERM, accept = null,
  maxNumerator = maxTerm) => {
  if (value === 0) return { M: 0, N: 1 };

  const sign = value < 0 ? -1 : 1;
  const absValue = Math.abs(value);

  let bestM = 1;
  let bestN = 1;
  let bestAccepted = false;
  let minDiff = Infinity;

  for (let N = 1; N <= maxTerm; N++) {
    for (let M = 1; M <= maxNumerator; M++) {
      const ratio = M / N;
      const accepted = !accept || accept(sign * ratio);
      const diff = Math.abs(absValue - ratio);

      // Equivalent fractions tie on error; smaller M + N selects lowest terms.
      const better = accepted !== bestAccepted
        ? accepted
        : (diff < minDiff || (diff === minDiff && (M + N) < (bestM + bestN)));
      if (better) {
        bestAccepted = accepted;
        minDiff = diff;
        bestM = M;
        bestN = N;
      }
    }
  }

  return { M: sign * bestM, N: bestN };
};

/**
 * Pure closing-domain core of snapFrequencies. Snaps the active frequency to
 * maintain a simple rational ratio M/N with the passive frequency, and computes
 * the domain T = 2π·N / passiveC after which the curve closes.
 * @param {number} activeC - The intended (raw) active frequency value.
 * @param {number} passiveC - The passive (held) frequency value.
 * @param {number} [maxTerm] - Maximum denominator in the closing check and ratio search.
 * @param {?{min: number, max: number}} [range] - Optional inclusive bounds on the
 *   snapped active frequency. The ratio search then prefers ratios landing inside
 *   them.
 * @returns {{ snappedActiveC: number, m: number, n: number, closingPeriod: number }} The
 *   snapped active frequency, the rational ratio m/n, and the curve's closing period T.
 */
export const snapToRationalRatio = (activeC, passiveC, maxTerm = MAX_RATIONAL_TERM, range = null) => {
  if (passiveC === 0) {
    return { snappedActiveC: activeC, m: 1, n: 1, closingPeriod: 0 };
  }

  const targetRatio = activeC / passiveC;
  // A pair that already closes within the denominator budget is left exactly
  // where it was authored.
  const closing = closingRatio(targetRatio, maxTerm);
  if (closing !== null) {
    return { snappedActiveC: activeC, m: closing.M, n: closing.N,
      closingPeriod: (TWO_PI * closing.N) / passiveC };
  }

  /** @type {((ratio: number) => boolean)|null} */
  const inRange = range
    ? (ratio) => passiveC * ratio >= range.min && passiveC * ratio <= range.max
    : null;
  // The range reaches ratios the denominator cap alone excludes: a control
  // running to 100 over a passive 5 holds every M/N up to 20·maxTerm.
  const reachable = range
    ? Math.ceil((Math.abs(range.max) / Math.abs(passiveC)) * maxTerm) : maxTerm;
  const maxNumerator = Math.min(MAX_SEARCH_NUMERATOR, Math.max(maxTerm, reachable));
  const { M, N } = findBestRationalRatio(targetRatio, maxTerm, inRange, maxNumerator);

  const snappedActiveC = passiveC * (M / N);

  const closingPeriod = (TWO_PI * N) / passiveC;

  return { snappedActiveC, m: M, n: N, closingPeriod };
};

/**
 * The traversal length at which a spherical Lissajous curve returns to its t=0
 * start (0, 1, 0), which happens only when m2·domain is an exact multiple of 2π.
 * Mirror of the engine's Comets::closing_domain (effects/Comets.h), including its
 * floor of one cycle.
 * @param {number} m2 - Orbital frequency C₂.
 * @param {number} domain - The authored traversal length.
 * @returns {number} The nearest closing domain, or 0 when m2 is not positive.
 */
export const closingDomain = (m2, domain) => {
  if (!(m2 > 0)) return 0;
  const cycles = Math.max(1, Math.round((m2 * domain) / TWO_PI));
  return (TWO_PI * cycles) / m2;
};

/**
 * Describes the gap between an authored domain and what the engine traverses.
 * @param {number} c2 - Frequency C₂ (m2).
 * @param {number} domain - The authored domain.
 * @param {number} [tol] - Relative tolerance below which the domain counts as closed.
 * @returns {?string} Warning text, or null when the domain already closes.
 */
export const domainClosureWarning = (c2, domain, tol = 1e-4) => {
  const closed = closingDomain(c2, domain);
  if (closed === 0 || Math.abs(domain - closed) <= tol * closed) return null;
  return `Domain ${domain.toFixed(3)} does not close the curve. Comets snaps it to ` +
    `${closed.toFixed(3)} (2π·${Math.round((c2 * closed) / TWO_PI)}/C₂), so the preview above ` +
    `is not the arc it renders; Fishbowl keeps ${domain.toFixed(3)} and pinches at the seam.`;
};

/**
 * Builds the export snippet: a C++ `LissajousParams` aggregate initializer
 * (core/math/spherical.h). Phase A is emitted in radians with no π scaling;
 * C₁/C₂ map to m1/m2.
 * @param {number} c1 - Frequency C₁ (m1).
 * @param {number} c2 - Frequency C₂ (m2).
 * @param {number} a - Phase shift A (radians).
 * @param {number} domain - The curve domain (duration).
 * @returns {string} A `math::LissajousParams{...}` initializer.
 */
export const lissajousCodeString = (c1, c2, a, domain) => {
  const f = formatFloatCpp;

  // Every literal round-trips to the engine float precision.
  const c1Str = f(c1);
  const c2Str = f(c2);
  const aStr = f(a);

  // Emit exact 2π multiples against PI_F to match the engine's source form.
  let domainStr;
  const multiple = domain / TWO_PI;
  if (Math.abs(multiple - Math.round(multiple)) < 0.001 && Math.round(multiple) > 0) {
    domainStr = `${2 * Math.round(multiple)} * math::PI_F`;
  } else {
    domainStr = f(domain);
  }

  return `math::LissajousParams{${c1Str}, ${c2Str}, ${aStr}, ${domainStr}}`;
};
