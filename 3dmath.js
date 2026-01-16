/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { MutableNumber } from "./animation.js";

export const TWO_PI = 2 * Math.PI;

// Complex number operations
function cAdd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
function cMult(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
function cDiv(a, b) {
  const denom = b.re * b.re + b.im * b.im;
  return {
    re: (a.re * b.re + a.im * b.im) / denom,
    im: (a.im * b.re - a.re * b.im) / denom
  };
}

// Inverse Stereographic Projection: Complex Plane -> Sphere
export function invStereo(z) {
  const r2 = z.re * z.re + z.im * z.im;
  return new THREE.Vector3(
    2 * z.re / (r2 + 1),
    2 * z.im / (r2 + 1),
    (r2 - 1) / (r2 + 1)
  );
}

// Stereographic Projection: Sphere -> Complex Plane
export function stereo(v) {
  const denom = 1 - v.z;
  if (Math.abs(denom) < 0.0001) return { re: 100, im: 100 }; // Infinity
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
    this.aRe = new MutableNumber(aRe);
    this.aIm = new MutableNumber(aIm);
    this.bRe = new MutableNumber(bRe);
    this.bIm = new MutableNumber(bIm);
    this.cRe = new MutableNumber(cRe);
    this.cIm = new MutableNumber(cIm);
    this.dRe = new MutableNumber(dRe);
    this.dIm = new MutableNumber(dIm);
  }

  get a() { return { re: this.aRe.get(), im: this.aIm.get() }; }
  get b() { return { re: this.bRe.get(), im: this.bIm.get() }; }
  get c() { return { re: this.cRe.get(), im: this.cIm.get() }; }
  get d() { return { re: this.dRe.get(), im: this.dIm.get() }; }
}
