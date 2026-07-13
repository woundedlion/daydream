/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Pure math from tools/lissajous.html so it can be unit-tested in Node without
// a DOM. THREE is imported only so lissajous can return a THREE.Vector3.

import * as THREE from 'three';
import { formatFloatCpp } from './cpp_format.js';

const TWO_PI = 2 * Math.PI;
export const MAX_RATIONAL_TERM = 8;

/**
 * Greatest common divisor of two non-negative integers (Euclid). Used to reduce
 * a found ratio to lowest terms.
 * @param {number} a - First integer (>= 0).
 * @param {number} b - Second integer (>= 0).
 * @returns {number} gcd(a, b); gcd(0, 0) is 0.
 */
const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));

/**
 * The spherical Lissajous parametric curve (on the unit sphere, R = 1).
 * Argument order mirrors the engine's lissajous(m1, m2, a, t) (core/geometry.h)
 * so the preview, the exported snippet, and the engine all agree on which
 * slider maps to which parameter. t is last in every case.
 * @param {number} m1 - Axial frequency C₁.
 * @param {number} m2 - Orbital frequency C₂.
 * @param {number} a - Phase shift A (radians).
 * @param {number} t - Curve parameter.
 * @returns {THREE.Vector3} Point on the unit sphere.
 */
export const lissajous = (m1, m2, a, t) => {
  const phase = a;
  const x = Math.sin(m2 * t) * Math.cos(m1 * t - phase);
  const y = Math.cos(m2 * t);
  const z = Math.sin(m2 * t) * Math.sin(m1 * t - phase);
  // Already unit-length: sin²(m2·t)(cos²+sin²) + cos²(m2·t) = 1.
  return new THREE.Vector3(x, y, z);
};

/**
 * Finds the simplest rational approximation (M/N) for a given value (ratio).
 * A negative target returns a negative numerator (sign carried on M, N stays
 * positive); the search grid itself is positive, so the sign is split off first.
 * @param {number} value - The ratio to approximate (e.g., C1/C2), may be negative.
 * @param {number} [maxTerm] - Maximum value for both the numerator and the
 *   denominator (the search grid is square: M, N each range over [1, maxTerm]).
 * @returns {{ M: number, N: number }} The best simple rational ratio.
 */
export const findBestRationalRatio = (value, maxTerm = MAX_RATIONAL_TERM) => {
  if (value === 0) return { M: 0, N: 1 };

  const sign = value < 0 ? -1 : 1;
  const absValue = Math.abs(value);

  let bestM = 1;
  let bestN = 1;
  let minDiff = Infinity;

  for (let N = 1; N <= maxTerm; N++) {
    for (let M = 1; M <= maxTerm; M++) {
      const ratio = M / N;
      const diff = Math.abs(absValue - ratio);

      if (diff < minDiff || (diff === minDiff && (M + N) < (bestM + bestN))) {
        minDiff = diff;
        bestM = M;
        bestN = N;
      }
    }
  }

  // Reduce to lowest terms so 2π·N/passiveC is the true (shortest) period.
  const g = gcd(bestM, bestN);
  return { M: (sign * bestM) / g, N: bestN / g };
};

/**
 * Pure closing-domain core of snapFrequencies. Snaps the active frequency to
 * maintain a simple rational ratio M/N with the passive frequency, and computes
 * the domain T = 2π·N / passiveC after which the curve closes.
 * @param {number} activeC - The intended (raw) active frequency value.
 * @param {number} passiveC - The passive (held) frequency value.
 * @param {number} [maxTerm] - Max numerator/denominator for the ratio.
 * @returns {{ snappedActiveC: number, m: number, n: number, closingPeriod: number }} The
 *   snapped active frequency, the rational ratio m/n, and the curve's closing period T.
 */
export const snapToRationalRatio = (activeC, passiveC, maxTerm = MAX_RATIONAL_TERM) => {
  if (passiveC === 0) {
    return { snappedActiveC: activeC, m: 1, n: 1, closingPeriod: 0 };
  }

  const targetRatio = activeC / passiveC;
  const { M, N } = findBestRationalRatio(targetRatio, maxTerm);

  const snappedActiveC = passiveC * (M / N);

  const closingPeriod = (TWO_PI * N) / passiveC;

  return { snappedActiveC, m: M, n: N, closingPeriod };
};

/**
 * Builds the export snippet string for the current curve parameters. Pure: it
 * takes plain numbers and returns the string the page writes into the DOM.
 *
 * The snippet is a C++ `LissajousParams` aggregate initializer — the form the
 * engine's Lissajous effects (ChaoticStrings, Comets) actually consume
 * (core/geometry.h: `struct LissajousParams { float m1, m2, a, domain; }`).
 * Phase A is emitted in radians and fed to the engine as-is: the tool's
 * radians-labelled slider matches `lissajous()`'s phase with no π scaling.
 * C₁/C₂ map to m1/m2.
 * @param {number} c1 - Frequency C₁ (m1).
 * @param {number} c2 - Frequency C₂ (m2).
 * @param {number} a - Phase shift A (radians).
 * @param {number} domain - The curve domain (duration).
 * @returns {string} A `LissajousParams{...}` initializer.
 */
export const lissajousCodeString = (c1, c2, a, domain) => {
  const f = formatFloatCpp;

  const c1Str = f(c1, 2);
  const c2Str = f(c2, 2);
  const aStr = f(a, 3);

  // Emit exact 2π multiples against PI_F to match the engine's source form.
  let domainStr;
  const multiple = domain / TWO_PI;
  if (Math.abs(multiple - Math.round(multiple)) < 0.001 && Math.round(multiple) > 0) {
    domainStr = `${2 * Math.round(multiple)} * PI_F`;
  } else {
    domainStr = f(domain, 3);
  }

  return `LissajousParams{${c1Str}, ${c2Str}, ${aStr}, ${domainStr}}`;
};
