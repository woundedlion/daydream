// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  vec3Normalize,
  generateBezierCurve,
  generateCatmullRomCurve,
  formatFloatCpp,
  splineExportCode,
  randomPointOnSphere,
} = await import('../tools/spline_math.js');
const { formatFloatCpp: cppFormatFloatCpp } = await import('../tools/cpp_format.js');

/**
 * Computes the Euclidean magnitude of a 3D point; used to assert unit length.
 * @param {{x:number, y:number, z:number}} p - The point to measure.
 * @returns {number} The Euclidean length sqrt(x^2 + y^2 + z^2).
 */
const mag = (p) => Math.sqrt(p.x*p.x + p.y*p.y + p.z*p.z);

/**
 * Trivial linear point evaluator: treats the 4 controls as the ends of a
 * straight lerp from p0 (t=0) to p3 (t=1), ignoring the middle controls. Lets
 * the sampling loop be checked without any real spline backend.
 * @param {{x:number, y:number, z:number}} p0 - Start control point (t=0).
 * @param {{x:number, y:number, z:number}} p1 - Ignored inner control point.
 * @param {{x:number, y:number, z:number}} p2 - Ignored inner control point.
 * @param {{x:number, y:number, z:number}} p3 - End control point (t=1).
 * @param {number} t - Interpolation parameter in [0, 1].
 * @returns {{x:number, y:number, z:number}} The linearly interpolated point.
 */
const lerpEval = (p0, p1, p2, p3, t) => ({
  x: p0.x + (p3.x - p0.x) * t,
  y: p0.y + (p3.y - p0.y) * t,
  z: p0.z + (p3.z - p0.z) * t,
});

/** Verifies a known (3,0,4) vector normalizes to unit length with preserved direction. */
test('vec3Normalize: known vector -> unit length, direction preserved', () => {
  const v = vec3Normalize({ x: 3, y: 0, z: 4 });
  assert.ok(Math.abs(mag(v) - 1) < 1e-12);
  assert.ok(Math.abs(v.x - 0.6) < 1e-12);
  assert.ok(Math.abs(v.z - 0.8) < 1e-12);
});

/** Verifies the zero vector falls back to the safe unit vector {1,0,0}. */
test('vec3Normalize: zero vector returns the safe {1,0,0}', () => {
  assert.deepEqual(vec3Normalize({ x: 0, y: 0, z: 0 }), { x: 1, y: 0, z: 0 });
});

/** Verifies fewer than 4 control points yields an empty curve. */
test('generateBezierCurve: needs >= 4 points', () => {
  assert.deepEqual(generateBezierCurve([{ x: 0, y: 0, z: 0 }], 4, lerpEval), []);
});

/** A zero/NaN sample count is degenerate (would divide by zero -> NaN points). */
test('generateBezierCurve: non-positive sample count returns []', () => {
  const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }, { x: 3, y: 3, z: 3 }];
  assert.deepEqual(generateBezierCurve(pts, 0, lerpEval), []);
  assert.deepEqual(generateBezierCurve(pts, NaN, lerpEval), []);
});

/** Verifies the sampled curve starts at p0, ends at p3, and has N+1 samples. */
test('generateBezierCurve: endpoints hit p0/p3 and sample count is N+1', () => {
  const p0 = { x: 0, y: 0, z: 0 };
  const p3 = { x: 1, y: 2, z: 3 };
  const pts = [p0, { x: 9, y: 9, z: 9 }, { x: 8, y: 8, z: 8 }, p3];
  const numSamples = 5;
  const curve = generateBezierCurve(pts, numSamples, lerpEval);
  assert.equal(curve.length, numSamples + 1);
  assert.deepEqual(curve[0], p0);
  assert.deepEqual(curve[curve.length - 1], p3);
});

/**
 * Trivial tangent callback: passes the segment endpoints straight through as the
 * inner controls, so lerpEval reproduces the segment exactly.
 * @param {{x:number, y:number, z:number}} prev - Control point before the segment.
 * @param {{x:number, y:number, z:number}} start - Segment start control point.
 * @param {{x:number, y:number, z:number}} end - Segment end control point.
 * @param {{x:number, y:number, z:number}} next - Control point after the segment.
 * @returns {{cp1:{x:number,y:number,z:number}, cp2:{x:number,y:number,z:number}}} The inner control points (start and end passed through).
 */
const passThroughTangents = (prev, start, end, next) => ({ cp1: start, cp2: end });

/** Verifies fewer than 2 control points yields an empty curve. */
test('generateCatmullRomCurve: needs >= 2 points', () => {
  assert.deepEqual(
    generateCatmullRomCurve([{ x: 0, y: 0, z: 0 }], 0.5, 4, passThroughTangents, lerpEval, false),
    []);
});

/** A zero/NaN per-segment sample count is degenerate (divide by zero). */
test('generateCatmullRomCurve: non-positive sample count returns []', () => {
  const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }];
  assert.deepEqual(generateCatmullRomCurve(pts, 0.5, 0, passThroughTangents, lerpEval, false), []);
  assert.deepEqual(generateCatmullRomCurve(pts, 0.5, NaN, passThroughTangents, lerpEval, false), []);
});

/** Verifies the open curve has the expected sample count and passes through every control point. */
test('generateCatmullRomCurve: open case passes through every control point', () => {
  const pts = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
  ];
  const perSeg = 4;
  const curve = generateCatmullRomCurve(pts, 0.5, perSeg, passThroughTangents, lerpEval, false);
  // Open: n-1 segments; first emits perSeg+1, the rest perSeg each.
  assert.equal(curve.length, perSeg + 1 + (pts.length - 2) * perSeg);
  for (const cp of pts) {
    assert.ok(curve.some((q) => q.x === cp.x && q.y === cp.y && q.z === cp.z),
      `control point (${cp.x}) missing from open curve`);
  }
});

/** Verifies the closed curve adds a wrap segment back to the first point, making it longer than the open curve. */
test('generateCatmullRomCurve: closed case wraps (one segment per point)', () => {
  const pts = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
  ];
  const perSeg = 4;
  const open = generateCatmullRomCurve(pts, 0.5, perSeg, passThroughTangents, lerpEval, false);
  const closed = generateCatmullRomCurve(pts, 0.5, perSeg, passThroughTangents, lerpEval, true);
  // Closed: n segments (vs n-1 open), with the extra wrap segment.
  assert.equal(closed.length, perSeg + 1 + (pts.length - 1) * perSeg);
  assert.ok(closed.length > open.length);
  assert.deepEqual(closed[closed.length - 1], pts[0]);
});

/** spline_math re-exports cpp_format's formatter; its behavior is pinned in cpp_format.test.js. */
test('formatFloatCpp re-exports the authoritative cpp_format formatter', () => {
  assert.equal(formatFloatCpp, cppFormatFloatCpp);
});

/** Verifies the empty placeholder plus the 'vectors' and 'fragments' export formats. */
test('splineExportCode: empty placeholder, and both export formats', () => {
  assert.equal(splineExportCode([], 'vectors'), '// Place control points to generate code');

  const pts = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0.5, z: 0 }];
  const vectors = splineExportCode(pts, 'vectors');
  assert.ok(vectors.startsWith('constexpr std::array<Vector, 2> control_points = {{'));
  assert.ok(vectors.includes('Vector(1.0f, 0.0f, 0.0f)'));
  assert.ok(vectors.includes('Vector(0.0f, 0.5f, 0.0f)'));

  const frags = splineExportCode(pts, 'fragments');
  assert.ok(frags.startsWith('// 2 control point fragments'));
  assert.ok(frags.includes('f0.pos = Vector(1.0f, 0.0f, 0.0f);'));
});

/** Verifies that a deterministic RNG sequence produces a unit-length point on the sphere. */
test('randomPointOnSphere: deterministic RNG yields a unit-length point', () => {
  // A fixed sequence of "random" values; values avoid the s>=1 / s===0 reject.
  const seq = [0.75, 0.25, 0.1, 0.9];
  let i = 0;
  const rng = () => seq[i++ % seq.length];
  const p = randomPointOnSphere(rng);
  assert.ok(Math.abs(mag(p) - 1) < 1e-12, `|p| = ${mag(p)}`);
});
