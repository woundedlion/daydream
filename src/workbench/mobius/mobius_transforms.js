/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/*
 * Möbius transform math for the workbench: complex helpers, projection, and
 * preset generators mapping time `t` to the coefficients {A, B, C, D} of
 * f(z) = (Az + B) / (Cz + D).
 */

import { formatFloatCpp } from '../../shared/cpp_format.js';

export const MOBIUS_GRID_SCALE_R = 1.5;

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

// GLSL port of cmult/cadd for the mobius.html fragment shader.
export const glslComplexFunctions = `
        struct CNum { float re; float im; };
        CNum cmult(CNum p, CNum q) { return CNum(p.re * q.re - p.im * q.im, p.re * q.im + p.im * q.re); }
        CNum cadd(CNum p, CNum q) { return CNum(p.re + q.re, p.im + q.im); }
      `;

// --- Projection-domain conventions ----------------------------------------
// Projection division: core/math/mobius.h; stereo constants: core/math/stereographic.h.
// Underflow lift: core/math/3dmath.h.

/** Conventional magnitude representing the point at infinity. */
export const STEREO_INF = 1e4;

/**
 * 1 - v.y below which stereo() is inside the north-pole cap: the crossover
 * where |stereo(v)| = sqrt((1 + v.y) / (1 - v.y)) reaches STEREO_INF, so the
 * cap continues the projection instead of stepping.
 */
export const STEREO_POLE_EPS = 2 / (STEREO_INF * STEREO_INF);

/** (x,z) radius below which the north-pole azimuth uses the real-axis sentinel. */
export const STEREO_AZIMUTH_EPS = 1e-12;

/**
 * 2^96, the factor projectDiv scales a divisor pair by when squaring the
 * divisor is subnormal or zero; exact in float, so the lifted quotient is the
 * unlifted one.
 */
export const STEREO_UNDERFLOW_LIFT = 79228162514264337593543950336.0;

/**
 * Stereographic projection sphere -> complex plane: pole at +y, real axis x,
 * imaginary axis z.
 * @param {{x:number, y:number, z:number}} v - Point on the unit sphere.
 * @returns {{re:number, im:number}} The projected complex-plane coordinate.
 * @details Inside the north-pole cap the result carries the STEREO_INF sentinel
 * magnitude along the (x,z) azimuth; radii below STEREO_AZIMUTH_EPS use the
 * real-axis sentinel.
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
 * @returns {{re:number, im:number}} num/den, except a quotient whose magnitude would reach STEREO_INF collapses to the sentinel along the quotient's direction (the numerator's when the divisor is zero).
 * @details The guard is relative, so a near-singular divisor yields a finite
 * point carrying the quotient's azimuth. An exactly zero numerator returns
 * (0,0). A nonzero divisor whose square is subnormal or zero is lifted by
 * STEREO_UNDERFLOW_LIFT along with the numerator.
 */
export function projectDiv(num, den) {
  let denRe = den.re;
  let denIm = den.im;
  let numRe = num.re;
  let numIm = num.im;
  let denom = denRe * denRe + denIm * denIm;
  if (denom < 2 ** -1022 && (denRe !== 0.0 || denIm !== 0.0)) {
    denRe *= STEREO_UNDERFLOW_LIFT;
    denIm *= STEREO_UNDERFLOW_LIFT;
    numRe *= STEREO_UNDERFLOW_LIFT;
    numIm *= STEREO_UNDERFLOW_LIFT;
    denom = denRe * denRe + denIm * denIm;
  }
  const numMag = numRe * numRe + numIm * numIm;
  if (numMag >= denom * (STEREO_INF * STEREO_INF)) {
    // Normalize each operand by its peak component first: a value squared far
    // above the sentinel overflows to infinity and one far below it underflows
    // to zero, and either collapses the direction onto the origin.
    const peak = Math.max(Math.abs(num.re), Math.abs(num.im));
    if (peak === 0.0) return { re: 0.0, im: 0.0 };
    let re = num.re / peak;
    let im = num.im / peak;
    const denPeak = Math.max(Math.abs(den.re), Math.abs(den.im));
    if (denPeak > 0.0) {
      const dRe = den.re / denPeak;
      const dIm = den.im / denPeak;
      const qRe = re * dRe + im * dIm;
      im = im * dRe - re * dIm;
      re = qRe;
    }
    const scale = STEREO_INF / Math.sqrt(re * re + im * im);
    return { re: re * scale, im: im * scale };
  }
  return {
    re: (numRe * denRe + numIm * denIm) / denom,
    im: (numIm * denRe - numRe * denIm) / denom,
  };
}

// GLSL port of stereo/projectDiv; requires glslComplexFunctions (declares CNum).
export const glslProjectionFunctions = `
        const float STEREO_INF = 1e4;
        const float STEREO_POLE_EPS = 2.0 / (STEREO_INF * STEREO_INF);
        const float STEREO_AZIMUTH_EPS = 1e-12;
        const float STEREO_UNDERFLOW_LIFT = 79228162514264337593543950336.0;
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
          float den_re = den.re;
          float den_im = den.im;
          float num_re = num.re;
          float num_im = num.im;
          float denom = den_re * den_re + den_im * den_im;
          if (denom < 1.1754943508222875e-38 && (den_re != 0.0 || den_im != 0.0)) {
            den_re *= STEREO_UNDERFLOW_LIFT;
            den_im *= STEREO_UNDERFLOW_LIFT;
            num_re *= STEREO_UNDERFLOW_LIFT;
            num_im *= STEREO_UNDERFLOW_LIFT;
            denom = den_re * den_re + den_im * den_im;
          }
          float num_mag = num_re * num_re + num_im * num_im;
          if (num_mag >= denom * (STEREO_INF * STEREO_INF)) {
            float peak = max(abs(num.re), abs(num.im));
            if (peak == 0.0) return CNum(0.0, 0.0);
            float re = num.re / peak;
            float im = num.im / peak;
            float den_peak = max(abs(den.re), abs(den.im));
            if (den_peak > 0.0) {
              float d_re = den.re / den_peak;
              float d_im = den.im / den_peak;
              float q_re = re * d_re + im * d_im;
              im = im * d_re - re * d_im;
              re = q_re;
            }
            float scale = STEREO_INF / sqrt(re * re + im * im);
            return CNum(re * scale, im * scale);
          }
          return CNum((num_re * den_re + num_im * den_im) / denom, (num_im * den_re - num_re * den_im) / denom);
        }
      `;

// --- Drag-input snapping --------------------------------------------------

/**
 * Snaps a scalar to zero (within twice `threshold`) and then to the nearest
 * integer (within `threshold`), so dragged coefficients latch onto grid lines.
 * @param {number} value - The scalar coefficient component to snap.
 * @param {number} [threshold=0.05] - Maximum distance to the nearest integer for snapping.
 * @returns {number} The snapped value.
 */
export function snapCoefficientComponent(value, threshold = 0.05) {
  let v = value;
  if (Math.abs(v) < threshold * 2) v = 0.0;
  if (Math.abs(v - Math.round(v)) < threshold) v = Math.round(v);
  return v;
}

// --- Preset coefficient generators ----------------------------------------

/**
 * Elliptic (Rotation) preset: continuous rotation around the poles.
 * @param {number} t - Animation time, advancing at 0.6 units per second.
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
 * @param {number} t - Animation time, advancing at 0.6 units per second.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function hyperbolic(t) {
  const logPeriod = 1.0 / MOBIUS_GRID_SCALE_R;
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
 * @param {number} t - Animation time, advancing at 0.6 units per second.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function loxodromic(t) {
  const angle = t * 0.3;
  const logPeriod = 1.0 / MOBIUS_GRID_SCALE_R;
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
 * Parabolic (Drift) preset: continuous translation bouncing between -2 and 2.
 * @param {number} t - Animation time, advancing at 0.6 units per second.
 * @returns {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} The Mobius coefficients {A, B, C, D}.
 */
export function parabolic(t) {
  return {
    A: { re: 1, im: 0 },
    B: { re: 2 - Math.abs(((t * 0.8 + 2) % 8 + 8) % 8 - 4), im: 0 },
    C: { re: 0, im: 0 },
    D: { re: 1, im: 0 },
  };
}

/**
 * Inversion (Rotation) preset: continuous rotation around the Real axis (swaps 0/∞).
 * @param {number} t - Animation time, advancing at 0.6 units per second.
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
 * @param {number} t - Animation time, advancing at 0.6 units per second.
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
 * @param {number} t - Animation time, advancing at 0.6 units per second.
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
 * @returns {string} e.g. "math::MobiusParams{1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f}".
 */
export function mobiusCodeString(a, b, c, d) {
  const parts = [];
  for (const z of [a, b, c, d]) {
    parts.push(formatFloatCpp(z.re), formatFloatCpp(z.im));
  }
  return `math::MobiusParams{${parts.join(', ')}}`;
}
