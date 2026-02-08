/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";

export const TWO_PI = 2 * Math.PI;

// Complex number operations
export function cAdd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
export function cMult(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
export function cDiv(a, b) {
  const denom = b.re * b.re + b.im * b.im;
  if (denom < Number.EPSILON) return { re: 0, im: 0 };
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom
  };
}

// Inverse Stereographic Projection: Complex Plane -> Sphere
export function invStereo(z, target) {
  const r2 = z.re * z.re + z.im * z.im;
  const t = target || new THREE.Vector3();
  if (!Number.isFinite(r2)) {
    return t.set(0, 0, 1);
  }

  return t.set(
    2 * z.re / (r2 + 1),
    2 * z.im / (r2 + 1),
    (r2 - 1) / (r2 + 1)
  );
}

// Stereographic Projection: Sphere -> Complex Plane
export function stereo(v) {
  const denom = 1 - v.z;
  if (Math.abs(denom) < Number.EPSILON) {
    return { re: 1e15, im: 0 };
  }

  return { re: v.x / denom, im: v.y / denom };
}

// Mobius Transformation: f(z) = (az + b) / (cz + d)
export function mobius(z, params) {
  const num = cAdd(cMult(params.a, z), params.b);
  const den = cAdd(cMult(params.c, z), params.d);
  return cDiv(num, den);
}

/**
 * Class to hold Mobius parameters with mutable components.
 */
export class MobiusParams {
  constructor(aRe = 1, aIm = 0, bRe = 0, bIm = 0, cRe = 0, cIm = 0, dRe = 1, dIm = 0) {
    this.aRe = aRe;
    this.aIm = aIm;
    this.bRe = bRe;
    this.bIm = bIm;
    this.cRe = cRe;
    this.cIm = cIm;
    this.dRe = dRe;
    this.dIm = dIm;
  }

  reset() {
    this.aRe = 1; this.aIm = 0;
    this.bRe = 0; this.bIm = 0;
    this.cRe = 0; this.cIm = 0;
    this.dRe = 1; this.dIm = 0;
  }

  get a() { return { re: this.aRe, im: this.aIm }; }
  get b() { return { re: this.bRe, im: this.bIm }; }
  get c() { return { re: this.cRe, im: this.cIm }; }
  get d() { return { re: this.dRe, im: this.dIm }; }
}

// Gnomonic Projection: Sphere -> Plane (Equator at Infinity)
// Projects from center (0,0,0) to plane z=1 (tangent at North Pole)
export function gnomonic(v) {
  // Handle equator singularity with a large number instead of Infinity
  const div = (Math.abs(v.z) < 1e-9) ? 1e-9 * (v.z >= 0 ? 1 : -1) : v.z;
  return { re: v.x / div, im: v.y / div };
}

// Inverse Gnomonic: Plane -> Sphere
export function invGnomonic(z, target, originalSign = 1) {
  const t = target || new THREE.Vector3();
  // Project (re, im, 1) back onto unit sphere
  const len = Math.sqrt(z.re * z.re + z.im * z.im + 1);
  const invLen = 1 / len;

  // Restore hemisphere sign (Upper or Lower)
  return t.set(
    z.re * invLen * originalSign,
    z.im * invLen * originalSign,
    invLen * originalSign
  );
}