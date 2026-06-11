/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Pure math extracted from tools/lissajous.html so it can be unit-tested in
// Node without a DOM. Contains the spherical Lissajous parametric curve
// (lissajous), the brute-force simplest-rational-ratio search used by the
// "closed curve" snap (findBestRationalRatio), the pure closing-domain core
// that snaps a frequency to a rational ratio and computes the curve's closing
// period (snapToRationalRatio), and the export-snippet string builder
// (lissajousCodeString). All DOM/THREE-coupled wiring stays inline in the page;
// THREE is imported here only so lissajous can keep returning a THREE.Vector3,
// preserving the page's existing caller behavior exactly.

import * as THREE from 'three';

const TWO_PI = 2 * Math.PI;

/**
 * The spherical Lissajous parametric curve (on the unit sphere, R = 1).
 * Argument order mirrors the engine's lissajous(m1, m2, a, t) (core/geometry.h)
 * so the preview, the exported snippet, and the engine all agree on which
 * slider maps to which parameter. t is last in every case.
 * @param {number} m1 Axial frequency C₁.
 * @param {number} m2 Orbital frequency C₂.
 * @param {number} a Phase shift A (radians).
 * @param {number} t Parameter.
 * @returns {THREE.Vector3} Point on the unit sphere.
 */
export const lissajous = (m1, m2, a, t) => {
  const phase = a;
  const x = Math.sin(m2 * t) * Math.cos(m1 * t - phase);
  const y = Math.cos(m2 * t);
  const z = Math.sin(m2 * t) * Math.sin(m1 * t - phase);
  return new THREE.Vector3(x, y, z);
};

/**
 * Finds the simplest rational approximation (M/N) for a given value (ratio).
 * @param {number} value The ratio to approximate (e.g., C1/C2).
 * @param {number} maxDenominator Maximum value for the numerator/denominator.
 * @returns {{ M: number, N: number }} The best simple rational ratio.
 */
export const findBestRationalRatio = (value, maxDenominator = 8) => {
  if (value === 0) return { M: 1, N: 1 };

  let bestM = 1;
  let bestN = 1;
  let minDiff = Infinity;

  // Check ratios M/N where M and N are between 1 and maxDenominator
  for (let N = 1; N <= maxDenominator; N++) {
    for (let M = 1; M <= maxDenominator; M++) {
      const ratio = M / N;
      const diff = Math.abs(value - ratio);

      // Prefer closer approximation, but also prefer smaller ratios
      if (diff < minDiff || (diff === minDiff && (M + N) < (bestM + bestN))) {
        minDiff = diff;
        bestM = M;
        bestN = N;
      }
    }
  }
  return { M: bestM, N: bestN };
};

/**
 * Pure closing-domain core of snapFrequencies. Snaps the active frequency to
 * maintain a simple rational ratio M/N with the passive frequency, and computes
 * the domain T = 2π·N / passiveC after which the curve closes.
 * @param {number} activeC The intended (raw) active frequency value.
 * @param {number} passiveC The passive (held) frequency value.
 * @param {number} [maxDenominator] Max numerator/denominator for the ratio.
 * @returns {{ snappedActiveC: number, m: number, n: number, closingPeriod: number }}
 */
export const snapToRationalRatio = (activeC, passiveC, maxDenominator = 8) => {
  // Find M/N such that M/N ≈ activeC / passiveC.
  const targetRatio = activeC / passiveC;
  const { M, N } = findBestRationalRatio(targetRatio, maxDenominator);

  // Snapped active frequency keeps the rational ratio against the passive one.
  const snappedActiveC = passiveC * (M / N);

  // With M/N the rational approximation of the frequency ratio, the curve
  // repeats after T = 2π·N / passiveC.
  const closingPeriod = (TWO_PI * N) / passiveC;

  return { snappedActiveC, m: M, n: N, closingPeriod };
};

/**
 * Builds the export snippet string for the current curve parameters. Pure: it
 * takes plain numbers and returns the string the page writes into the DOM.
 * @param {number} c1 Frequency C₁.
 * @param {number} c2 Frequency C₂.
 * @param {number} a Phase shift A (radians).
 * @param {number} domain The curve domain (duration).
 * @returns {string} A [fn, domain] pair matching timeline.add()'s tuple.
 */
export const lissajousCodeString = (c1, c2, a, domain) => {
  // Helper to format floats to a clean string representation (e.g., 3.000 -> 3)
  const f = (n, fixed = 3) => {
    const s = n.toFixed(fixed);
    // Remove trailing zeros and decimal point if they exist
    return s.replace(/\.?0+$/, '');
  };

  const c1Str = f(c1, 2);
  const c2Str = f(c2, 2);
  const aStr = f(a, 3);

  // Format the domain: exact 2π multiples render as TWO_PI expressions, else a float.
  let domainStr = '';
  const twoPi = TWO_PI;
  // Check for multiples of 2*PI within a small tolerance
  const multiple = domain / twoPi;

  if (Math.abs(multiple - Math.round(multiple)) < 0.001 && Math.round(multiple) > 0) {
    const N = Math.round(multiple);
    domainStr = (N === 1) ? 'TWO_PI' : `${N} * TWO_PI`;
  } else {
    domainStr = f(domain, 3); // Use the formatted float value
  }

  // Emit a [fn, domain] pair, matching timeline.add()'s expected tuple.
  return `[(t) => lissajous(${c1Str}, ${c2Str}, ${aStr}, t), ${domainStr}]`;
};
