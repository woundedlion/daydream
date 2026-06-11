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

const mag = (p) => Math.sqrt(p.x*p.x + p.y*p.y + p.z*p.z);

// A trivial linear point evaluator: treats the 4 controls as the ends of a
// straight lerp from p0 (t=0) to p3 (t=1), ignoring the middle controls. Lets
// us check the sampling loop without any real spline backend.
const lerpEval = (p0, p1, p2, p3, t) => ({
  x: p0.x + (p3.x - p0.x) * t,
  y: p0.y + (p3.y - p0.y) * t,
  z: p0.z + (p3.z - p0.z) * t,
});

test('vec3Normalize: known vector -> unit length, direction preserved', () => {
  const v = vec3Normalize({ x: 3, y: 0, z: 4 });
  assert.ok(Math.abs(mag(v) - 1) < 1e-12);
  assert.ok(Math.abs(v.x - 0.6) < 1e-12);
  assert.ok(Math.abs(v.z - 0.8) < 1e-12);
});

test('vec3Normalize: zero vector returns the safe {1,0,0}', () => {
  assert.deepEqual(vec3Normalize({ x: 0, y: 0, z: 0 }), { x: 1, y: 0, z: 0 });
});

test('generateBezierCurve: needs >= 4 points', () => {
  assert.deepEqual(generateBezierCurve([{ x: 0, y: 0, z: 0 }], 4, lerpEval), []);
});

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

// Trivial tangent callback: pass the segment endpoints straight through as the
// inner controls, so lerpEval reproduces the segment exactly.
const passThroughTangents = (prev, start, end, next) => ({ cp1: start, cp2: end });

test('generateCatmullRomCurve: needs >= 2 points', () => {
  assert.deepEqual(
    generateCatmullRomCurve([{ x: 0, y: 0, z: 0 }], 0.5, 4, passThroughTangents, lerpEval, false),
    []);
});

test('generateCatmullRomCurve: open case passes through every control point', () => {
  const pts = [
    { x: 0, y: 0, z: 0 },
    { x: 1, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 3, y: 0, z: 0 },
  ];
  const perSeg = 4;
  const curve = generateCatmullRomCurve(pts, 0.5, perSeg, passThroughTangents, lerpEval, false);
  // Open: (n-1) segments; first emits perSeg+1, the rest perSeg points each.
  assert.equal(curve.length, perSeg + 1 + (pts.length - 2) * perSeg);
  // Each control point is reproduced exactly somewhere on the curve.
  for (const cp of pts) {
    assert.ok(curve.some((q) => q.x === cp.x && q.y === cp.y && q.z === cp.z),
      `control point (${cp.x}) missing from open curve`);
  }
});

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
  // Closed has n segments vs n-1 open, so it is strictly longer (the wrap seg).
  assert.equal(closed.length, perSeg + 1 + (pts.length - 1) * perSeg);
  assert.ok(closed.length > open.length);
  // The closing segment runs from the last control point back toward the first.
  assert.deepEqual(closed[closed.length - 1], pts[0]);
});

test('formatFloatCpp: whole, half, and trailing-zero trimming', () => {
  assert.equal(formatFloatCpp(1), '1.0f');
  assert.equal(formatFloatCpp(0), '0.0f');
  assert.equal(formatFloatCpp(0.5), '0.5f');
  assert.equal(formatFloatCpp(1.2500), '1.25f');
});

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

test('randomPointOnSphere: deterministic RNG yields a unit-length point', () => {
  // A fixed sequence of "random" values; values avoid the s>=1 / s===0 reject.
  const seq = [0.75, 0.25, 0.1, 0.9];
  let i = 0;
  const rng = () => seq[i++ % seq.length];
  const p = randomPointOnSphere(rng);
  assert.ok(Math.abs(mag(p) - 1) < 1e-12, `|p| = ${mag(p)}`);
});
