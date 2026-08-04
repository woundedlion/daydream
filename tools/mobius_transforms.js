/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/*
 * Pure math from the Mobius Transformation Visualizer (mobius.html). Each preset
 * generator maps elapsed time `t` to the four complex Mobius coefficients
 * {A, B, C, D} of f(z) = (Az + B) / (Cz + D); these feed the live shader
 * uniforms, so the coefficients must stay bit-for-bit identical to what the
 * shader expects.
 */

import { formatFloatCpp } from './cpp_format.js';

// --- Complex arithmetic ---------------------------------------------------
// Complex numbers are plain { re, im } objects.

/**
 * Computes the complex product p*q.
 * @param {{re:number, im:number}} p - First complex operand.
 * @param {{re:number, im:number}} q - Second complex operand.
 * @returns {{re:number, im:number}} The complex product p*q.
 */
export function cmult(p, q) {
  return { re: p.re * q.re - p.im * q.im, im: p.re * q.im + p.im * q.re };
}

/**
 * Computes the complex sum p+q.
 * @param {{re:number, im:number}} p - First complex operand.
 * @param {{re:number, im:number}} q - Second complex operand.
 * @returns {{re:number, im:number}} The complex sum p+q.
 */
export function cadd(p, q) {
  return { re: p.re + q.re, im: p.im + q.im };
}

/**
 * Computes the complex quotient p/q. Returns 0 when |q|^2 < 1e-6 (i.e. |q| <
 * 1e-3) to avoid divide-by-near-zero blow-up, matching the shader's guarded
 * division.
 * @param {{re:number, im:number}} p - Complex dividend.
 * @param {{re:number, im:number}} q - Complex divisor.
 * @returns {{re:number, im:number}} The complex quotient p/q, or {re:0, im:0} when |q|^2 < 1e-6 (|q| < 1e-3).
 */
export function cdiv(p, q) {
  const denom = q.re * q.re + q.im * q.im;
  if (denom < 1e-6) return { re: 0.0, im: 0.0 };
  return {
    re: (p.re * q.re + p.im * q.im) / denom,
    im: (p.im * q.re - p.re * q.im) / denom,
  };
}

// GLSL port of cmult/cadd/cdiv consumed by the mobius.html fragment shader.
// Single source of truth for the shader; tests/mobius_transforms.test.js pins
// this against the JS functions above so the two cannot silently diverge.
export const glslComplexFunctions = `
        struct CNum { float re; float im; };
        CNum cmult(CNum p, CNum q) { return CNum(p.re * q.re - p.im * q.im, p.re * q.im + p.im * q.re); }
        CNum cadd(CNum p, CNum q) { return CNum(p.re + q.re, p.im + q.im); }
        CNum cdiv(CNum p, CNum q) {
          float denom = q.re * q.re + q.im * q.im;
          if (denom < 1e-6) return CNum(0.0, 0.0);
          return CNum((p.re * q.re + p.im * q.im) / denom, (p.im * q.re - p.re * q.im) / denom);
        }
      `;

// --- Projection-domain conventions ----------------------------------------
// Mirrored from the engine (core/math/3dmath.h). The engine owns these
// constants and the point-at-infinity behavior built on them; the tool renders
// what the engine will run, so a divergence here is a lying preview.

/** Conventional magnitude representing the point at infinity. */
export const STEREO_INF = 1e4;

/**
 * 1 - v.y below which stereo() is inside the north-pole cap: the crossover
 * where |stereo(v)| = sqrt((1 + v.y) / (1 - v.y)) reaches STEREO_INF, so the
 * cap continues the projection instead of stepping.
 */
export const STEREO_POLE_EPS = 2 / (STEREO_INF * STEREO_INF);

/** (x,z) radius below which the north-pole azimuth is undefined. */
export const STEREO_AZIMUTH_EPS = 1e-12;

/**
 * Stereographic projection sphere -> complex plane: pole at +y, real axis x,
 * imaginary axis z.
 * @param {{x:number, y:number, z:number}} v - Point on the unit sphere.
 * @returns {{re:number, im:number}} The projected complex-plane coordinate.
 * @details Inside the north-pole cap the result carries the STEREO_INF sentinel
 * magnitude along the (x,z) azimuth; only the exact pole, where the azimuth is
 * undefined, lands on the real axis.
 */
export function stereo(v) {
  const denom = 1.0 - v.y;
  if (denom < STEREO_POLE_EPS) {
    const r = Math.sqrt(v.x * v.x + v.z * v.z);
    if (r < STEREO_AZIMUTH_EPS) return { re: STEREO_INF, im: 0.0 };
    const scale = STEREO_INF / r;
    return { re: v.x * scale, im: v.z * scale };
  }
  return { re: v.x / denom, im: v.z / denom };
}

/**
 * Projection-domain complex division for the stereographic/Mobius maps.
 * @param {{re:number, im:number}} num - Numerator.
 * @param {{re:number, im:number}} den - Divisor.
 * @returns {{re:number, im:number}} num/den, except a quotient whose magnitude would reach STEREO_INF collapses to the sentinel along the numerator's direction.
 * @details Not general complex division (see cdiv): the guard is relative, so a
 * near-singular divisor still yields a finite point carrying the numerator's
 * azimuth rather than a fixed constant. Only an exactly zero numerator is the
 * indeterminate 0/0 form, which returns (0,0).
 */
export function projectDiv(num, den) {
  const denom = den.re * den.re + den.im * den.im;
  const numMag = num.re * num.re + num.im * num.im;
  if (numMag >= denom * (STEREO_INF * STEREO_INF)) {
    if (numMag === 0.0) return { re: 0.0, im: 0.0 };
    const scale = STEREO_INF / Math.sqrt(numMag);
    return { re: num.re * scale, im: num.im * scale };
  }
  return {
    re: (num.re * den.re + num.im * den.im) / denom,
    im: (num.im * den.re - num.re * den.im) / denom,
  };
}

// GLSL port of stereo/projectDiv, appended after glslComplexFunctions (which
// declares CNum). tests/mobius_transforms.test.js pins both the constants and
// the bodies against the JS above.
export const glslProjectionFunctions = `
        const float STEREO_INF = 1e4;
        const float STEREO_POLE_EPS = 2.0 / (STEREO_INF * STEREO_INF);
        const float STEREO_AZIMUTH_EPS = 1e-12;
        CNum stereo(vec3 v) {
          float denom = 1.0 - v.y;
          if (denom < STEREO_POLE_EPS) {
            float r = sqrt(v.x * v.x + v.z * v.z);
            if (r < STEREO_AZIMUTH_EPS) return CNum(STEREO_INF, 0.0);
            float scale = STEREO_INF / r;
            return CNum(v.x * scale, v.z * scale);
          }
          return CNum(v.x / denom, v.z / denom);
        }
        CNum project_div(CNum num, CNum den) {
          float denom = den.re * den.re + den.im * den.im;
          float num_mag = num.re * num.re + num.im * num.im;
          if (num_mag >= denom * (STEREO_INF * STEREO_INF)) {
            if (num_mag == 0.0) return CNum(0.0, 0.0);
            float scale = STEREO_INF / sqrt(num_mag);
            return CNum(num.re * scale, num.im * scale);
          }
          return CNum((num.re * den.re + num.im * den.im) / denom, (num.im * den.re - num.re * den.im) / denom);
        }
      `;

// --- Drag-input snapping --------------------------------------------------

/**
 * Snaps a scalar to zero (within twice `threshold`) and then to the nearest
 * integer (within `threshold`), so dragged coefficients latch onto grid lines.
 * Zero gets the wider band so coefficients settle onto an exact 0 more readily;
 * deriving it from `threshold` keeps the two bands proportional.
 * @param {number} value - The scalar coefficient component to snap.
 * @param {number} [threshold=0.05] - Maximum distance to the nearest integer for snapping.
 * @returns {number} The snapped value.
 */
export function snapComplex(value, threshold = 0.05) {
  let v = value;
  if (Math.abs(v) < threshold * 2) v = 0.0;
  if (Math.abs(v - Math.round(v)) < threshold) v = Math.round(v);
  return v;
}

// --- Preset coefficient generators ----------------------------------------

/**
 * Elliptic (Rotation) preset: continuous rotation around the poles.
 * @param {number} t - Elapsed time in seconds.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function elliptic(t) {
  const angle = t * 0.5;
  return {
    A: { re: Math.cos(angle), im: Math.sin(angle) },
    B: { re: 0, im: 0 },
    C: { re: 0, im: 0 },
    D: { re: Math.cos(-angle), im: Math.sin(-angle) },
  };
}

/**
 * Hyperbolic (Zoom) preset: continuous flow from Source to Sink.
 * @param {number} t - Elapsed time in seconds.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function hyperbolic(t) {
  const gridScaleR = 1.5;
  const logPeriod = 1.0 / gridScaleR;
  const speed = 0.4;
  const flowParam = (t * speed) % logPeriod;
  const scale = Math.exp(flowParam);
  const s = Math.sqrt(scale);
  return {
    A: { re: s, im: 0 },
    B: { re: 0, im: 0 },
    C: { re: 0, im: 0 },
    D: { re: 1 / s, im: 0 },
  };
}

/**
 * Loxodromic (Spiral) preset: seamless spiral flow.
 * @param {number} t - Elapsed time in seconds.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function loxodromic(t) {
  const angle = t * 0.3;
  const gridScaleR = 1.5;
  const logPeriod = 1.0 / gridScaleR;
  const speed = 0.3;
  const flowParam = (t * speed) % logPeriod;
  const scale = Math.exp(flowParam);
  const s = Math.sqrt(scale);
  return {
    A: { re: s * Math.cos(angle), im: s * Math.sin(angle) },
    B: { re: 0, im: 0 },
    C: { re: 0, im: 0 },
    D: { re: (1 / s) * Math.cos(-angle), im: (1 / s) * Math.sin(-angle) },
  };
}

/**
 * Parabolic (Drift) preset: continuous translation along the Real axis.
 * @param {number} t - Elapsed time in seconds.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function parabolic(t) {
  return {
    A: { re: 1, im: 0 },
    B: { re: t * 0.8, im: 0 },
    C: { re: 0, im: 0 },
    D: { re: 1, im: 0 },
  };
}

/**
 * Inversion (Rotation) preset: continuous rotation around the Real axis (swaps 0/∞).
 * @param {number} t - Elapsed time in seconds.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function inversion(t) {
  const theta = t * 0.5;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return {
    A: { re: c, im: 0 },
    B: { re: 0, im: s },
    C: { re: 0, im: s },
    D: { re: c, im: 0 },
  };
}

/**
 * Tumble preset: rotation around the Imaginary axis.
 * @param {number} t - Elapsed time in seconds.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function tumble(t) {
  const theta = t * 0.4;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return {
    A: { re: c, im: 0 },
    B: { re: -s, im: 0 },
    C: { re: s, im: 0 },
    D: { re: c, im: 0 },
  };
}

/**
 * Cayley Transform preset: interpolate Identity (1,0,0,1) -> Cayley (1,-i,1,i),
 * saturating the interpolation parameter at p = 1.
 * @param {number} t - Elapsed time in seconds.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function cayley(t) {
  const p = Math.min(1.0, t * 0.5);
  return {
    A: { re: 1, im: 0 },
    B: { re: 0, im: -p },
    C: { re: p, im: 0 },
    D: { re: 1 - p, im: p },
  };
}

// --- C++ export -----------------------------------------------------------

/**
 * Formats the four coefficients as a C++ MobiusParams initializer, using the
 * struct's eight-float constructor order (real/imaginary pair per coefficient).
 * @param {{re:number, im:number}} a - Coefficient a.
 * @param {{re:number, im:number}} b - Coefficient b.
 * @param {{re:number, im:number}} c - Coefficient c.
 * @param {{re:number, im:number}} d - Coefficient d.
 * @returns {string} e.g. "MobiusParams{1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f}".
 */
export function mobiusCodeString(a, b, c, d) {
  const parts = [];
  for (const z of [a, b, c, d]) {
    parts.push(formatFloatCpp(z.re), formatFloatCpp(z.im));
  }
  return `MobiusParams{${parts.join(', ')}}`;
}
