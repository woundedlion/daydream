import * as THREE from "three";

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
export function mobius(z, a, b, c, d) {
  const num = cAdd(cMult(a, z), b);
  const den = cAdd(cMult(c, z), d);
  return cDiv(num, den);
}
