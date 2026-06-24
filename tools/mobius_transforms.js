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
 * Computes the complex quotient p/q. Returns 0 when |q|^2 < 1e-6 to avoid
 * divide-by-near-zero blow-up, matching the shader's guarded division.
 * @param {{re:number, im:number}} p - Complex dividend.
 * @param {{re:number, im:number}} q - Complex divisor.
 * @returns {{re:number, im:number}} The complex quotient p/q, or {re:0, im:0} when |q|^2 < 1e-6.
 */
export function cdiv(p, q) {
  const denom = q.re * q.re + q.im * q.im;
  if (denom < 1e-6) return { re: 0.0, im: 0.0 };
  return {
    re: (p.re * q.re + p.im * q.im) / denom,
    im: (p.im * q.re - p.re * q.im) / denom,
  };
}

// --- Drag-input snapping --------------------------------------------------

/**
 * Snaps a scalar to zero (if within 0.1 of zero) and then to the nearest
 * integer (if within `threshold`), so dragged coefficients latch onto grid lines.
 * @param {number} value - The scalar coefficient component to snap.
 * @param {number} [threshold=0.05] - Maximum distance to the nearest integer for snapping.
 * @returns {number} The snapped value.
 */
export function snapComplex(value, threshold = 0.05) {
  let v = value;
  if (Math.abs(v) < 0.1) v = 0.0;
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
    B: { re: 0, im: s }, // i*sin
    C: { re: 0, im: s }, // i*sin
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
