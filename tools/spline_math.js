/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Pure, backend-agnostic spline helpers from tools/splines.html, unit-testable
// in Node without a DOM, THREE, or the WASM engine. The Bézier and Catmull-Rom
// sampling cores take injected eval/tangent callbacks so the actual math stays
// in the WASM engine.

import { formatFloatCpp } from './cpp_format.js';

export { formatFloatCpp };

/**
 * Normalize a plain {x,y,z} vector to unit length. A degenerate (near-zero)
 * vector returns {x:1, y:0, z:0} rather than NaNs.
 * @param {{x:number,y:number,z:number}} v - Vector to normalize.
 * @returns {{x:number,y:number,z:number}} Unit-length vector, or {x:1,y:0,z:0} if degenerate.
 */
export function vec3Normalize(v) {
  const len = Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z);
  if (len < 1e-10) return { x: 1, y: 0, z: 0 };
  return { x: v.x/len, y: v.y/len, z: v.z/len };
}

/**
 * Sample a 4-point Bézier curve over [0,1]. The actual point math is delegated
 * to evalFn so callers can swap in any backend (e.g. the WASM engine).
 * @param {Array<{x:number,y:number,z:number}>} pts - Control points (first 4 are used).
 * @param {number} numSamples - Number of segments; returns numSamples+1 points.
 * @param {Function} evalFn - Point evaluator (p0, p1, p2, p3, t) => point.
 * @returns {Array<*>} Sampled curve points, or [] if fewer than 4 control points.
 */
export function generateBezierCurve(pts, numSamples, evalFn) {
  if (pts.length < 4) return [];
  // Negated compare rejects NaN, isFinite rejects Infinity; numSamples divides t = i / numSamples.
  if (!(numSamples >= 1) || !Number.isFinite(numSamples)) return [];
  const result = [];
  for (let i = 0; i <= numSamples; i++) {
    const t = i / numSamples;
    result.push(evalFn(pts[0], pts[1], pts[2], pts[3], t));
  }
  return result;
}

/**
 * Sample a Catmull-Rom spline through N control points, with closed-loop
 * support. Per-segment tangents come from tangentFn and the per-step point math
 * from evalFn, keeping this routine backend-agnostic.
 * @param {Array<{x:number,y:number,z:number}>} pts - Control points (at least 2 required).
 * @param {number} tension - Catmull-Rom tension, forwarded to tangentFn.
 * @param {number} numSamplesPerSeg - Samples per segment.
 * @param {Function} tangentFn - Tangent builder (prev, start, end, next, tension) => {cp1, cp2}.
 * @param {Function} evalFn - Point evaluator (p0, p1, p2, p3, t) => point.
 * @param {boolean} closed - Whether the spline forms a closed loop.
 * @returns {Array<*>} Sampled curve points, or [] if fewer than 2 control points.
 */
export function generateCatmullRomCurve(pts, tension, numSamplesPerSeg, tangentFn, evalFn, closed) {
  const n = pts.length;
  if (n < 2) return [];
  // Negated compare rejects NaN, isFinite rejects Infinity; numSamplesPerSeg divides t = j / numSamplesPerSeg.
  if (!(numSamplesPerSeg >= 1) || !Number.isFinite(numSamplesPerSeg)) return [];
  const result = [];
  const segCount = closed ? n : n - 1;

  for (let i = 0; i < segCount; i++) {
    const i0 = (i === 0 && !closed) ? 0 : ((i - 1 + n) % n);
    const i1 = i;
    const i2 = (i + 1) % n;
    const i3 = (i + 2 >= n && !closed) ? n - 1 : ((i + 2) % n);

    const { cp1, cp2 } = tangentFn(pts[i0], pts[i1], pts[i2], pts[i3], tension);

    const startJ = (i === 0) ? 0 : 1;
    for (let j = startJ; j <= numSamplesPerSeg; j++) {
      const t = j / numSamplesPerSeg;
      result.push(evalFn(pts[i1], cp1, cp2, pts[i2], t));
    }
  }
  return result;
}

/**
 * Build the C++ export snippet for a set of control points. Pure string work;
 * the DOM read of the format selector and write of the output stays inline.
 * @param {Array<{x:number,y:number,z:number}>} pts - Control points.
 * @param {string} format - Output mode: 'vectors' or 'fragments'.
 * @returns {string} The generated C++ source snippet.
 */
export function splineExportCode(pts, format) {
  if (pts.length === 0) {
    return '// Place control points to generate code';
  }
  if (format !== 'vectors' && format !== 'fragments') {
    throw new Error(`splineExportCode: unknown format "${format}" ` +
      `(expected one of vectors, fragments)`);
  }
  const f = formatFloatCpp;
  if (format === 'vectors') {
    let code = `constexpr std::array<Vector, ${pts.length}> control_points = {{\n`;
    pts.forEach((p, i) => {
      code += `    Vector(${f(p.x)}, ${f(p.y)}, ${f(p.z)})`;
      code += (i < pts.length - 1) ? ',\n' : '\n';
    });
    code += '}};';
    return code;
  }
  let code = `// ${pts.length} control point fragments\n`;
  pts.forEach((p, i) => {
    code += `Fragment f${i};\n`;
    code += `f${i}.pos = Vector(${f(p.x)}, ${f(p.y)}, ${f(p.z)});\n`;
  });
  return code;
}

/**
 * Convert a flat vertex buffer ([x0,y0,z0, x1,y1,z1, ...]) into spline anchor
 * points. Each vertex is normalized onto the unit sphere, since solid vertices
 * are not guaranteed unit-radius but control points must lie on the sphere.
 * @param {ArrayLike<number>} flatVerts - Flattened xyz triples (e.g. the Float32Array from MeshOps.getVertices()).
 * @returns {Array<{x:number,y:number,z:number}>} One unit-length anchor point per vertex.
 */
export function solidVertexAnchors(flatVerts) {
  if (flatVerts.length % 3 !== 0) {
    throw new Error(`solidVertexAnchors: vertex buffer length ${flatVerts.length} ` +
      `is not a multiple of 3`);
  }
  const pts = [];
  for (let i = 0; i < flatVerts.length; i += 3) {
    pts.push(vec3Normalize({ x: flatVerts[i], y: flatVerts[i + 1], z: flatVerts[i + 2] }));
  }
  return pts;
}

/**
 * Sample a point uniformly on the unit sphere via Marsaglia's method. The RNG
 * is injectable so the result is deterministic under test.
 * @param {Function} [rng] - Uniform [0,1) source; defaults to Math.random.
 * @returns {{x:number,y:number,z:number}} A unit vector uniformly distributed on the sphere.
 */
export function randomPointOnSphere(rng = Math.random) {
  let v1, v2, s;
  do {
    v1 = 2 * rng() - 1;
    v2 = 2 * rng() - 1;
    s = v1*v1 + v2*v2;
  } while (s >= 1 || s === 0);
  const sq = Math.sqrt(1 - s);
  // Unit by construction (Marsaglia): with s = v1²+v2² in (0,1),
  // (2·v1·√(1-s))² + (2·v2·√(1-s))² + (1-2s)² = 4s(1-s) + (1-2s)² = 1.
  return {
    x: 2 * v1 * sq,
    y: 2 * v2 * sq,
    z: 1 - 2 * s
  };
}
