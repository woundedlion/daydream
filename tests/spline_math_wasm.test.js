// @ts-check
//
// WASM-backed spline parity: wires the REAL exported WASM evaluators
// (spline_cubic_fast / spline_cubic_slerp / spline_catmull_rom_tangents) through
// the same sampling cores the splines.html tool uses and pins their output, so an
// engine-side change fails here instead of silently drifting from the preview.
// The pure spline_math.test.js only exercises the sampling loop with fake
// evaluators, leaving the engine math itself unverified.
//
// The wrappers below are byte-identical to splines.html's bridge callbacks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateBezierCurve, generateCatmullRomCurve } from '../tools/spline_math.js';
import createHolosphereModule from '../holosphere_wasm.js';

// Top-level await means a load/instantiation failure fails this file loudly
// rather than skipping the parity check.
const M = await createHolosphereModule({ print() {}, printErr() {} });

test('WASM parity module is present with the exports this suite pins', () => {
  for (const name of [
    'spline_cubic_fast', 'spline_cubic_slerp', 'spline_catmull_rom_tangents',
  ]) {
    assert.equal(typeof M[name], 'function',
      `holosphere_wasm.js is missing export ${name} — parity check would not run`);
  }
});

const cubicFast = (p0, p1, p2, p3, t) =>
  M.spline_cubic_fast(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z,
    p2.x, p2.y, p2.z, p3.x, p3.y, p3.z, t);
const cubicSlerp = (p0, p1, p2, p3, t) =>
  M.spline_cubic_slerp(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z,
    p2.x, p2.y, p2.z, p3.x, p3.y, p3.z, t);
const catmullRomTangents = (prev, start, end, next, tension) =>
  M.spline_catmull_rom_tangents(prev.x, prev.y, prev.z, start.x, start.y, start.z,
    end.x, end.y, end.z, next.x, next.y, next.z, tension);

// p0..p3 control polygon (all unit vectors), shared by every case.
const P = [{ x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: -1, y: 0, z: 0 }];

const EPS = 1e-5;
/** Asserts a {x,y,z} point matches expected within EPS. */
const closeVec = (v, x, y, z, msg = '') => {
  assert.ok(Math.abs(v.x - x) <= EPS && Math.abs(v.y - y) <= EPS && Math.abs(v.z - z) <= EPS,
    `${msg} expected ~(${x}, ${y}, ${z}), got (${v.x}, ${v.y}, ${v.z})`);
};
const mag = (v) => Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

/**
 * Verifies the real exported spline_cubic_fast, driven through the tool's
 * generateBezierCurve sampler, interpolates its endpoints, stays on the unit
 * sphere, and reproduces a pinned interior point (golden vector from the engine).
 */
test('spline_cubic_fast (real WASM) Bézier curve pins to the engine', () => {
  const curve = generateBezierCurve(P, 4, cubicFast);
  assert.equal(curve.length, 5);
  // p0/p3 are already unit, so the endpoints interpolate exactly.
  closeVec(curve[0], 0, 1, 0, 't=0');
  closeVec(curve[4], -1, 0, 0, 't=1');
  // Pinned interior sample (t=0.5) — golden vector from the engine.
  closeVec(curve[2], 0.534522, 0.267261, 0.801784, 't=0.5');
  // cubic_fast renormalizes, so every sample is on the unit sphere.
  for (const p of curve) assert.ok(Math.abs(mag(p) - 1) <= EPS, `non-unit sample mag=${mag(p)}`);
});

/**
 * Verifies spline_cubic_slerp pins to the engine and is a genuinely different
 * curve from cubic_fast away from the endpoints (so the two bindings cannot
 * silently resolve to the same underlying function).
 */
test('spline_cubic_slerp (real WASM) pins to the engine and differs from cubic_fast', () => {
  const slerpMid = cubicSlerp(P[0], P[1], P[2], P[3], 0.5);
  closeVec(slerpMid, 0.486519, 0.243259, 0.839121, 'slerp t=0.5');
  assert.ok(Math.abs(mag(slerpMid) - 1) <= EPS, `slerp sample not unit: ${mag(slerpMid)}`);
  // cubic_fast and cubic_slerp are different curves between the endpoints;
  // identical midpoints would mean the two evaluators collapsed to one.
  const fastMid = cubicFast(P[0], P[1], P[2], P[3], 0.5);
  assert.ok(mag({ x: slerpMid.x - fastMid.x, y: slerpMid.y - fastMid.y, z: slerpMid.z - fastMid.z }) > 1e-3,
    'cubic_fast and cubic_slerp produced the same midpoint');
});

/**
 * Verifies the real spline_catmull_rom_tangents + spline_cubic_fast, driven
 * through generateCatmullRomCurve in closed-loop mode, produce the engine's
 * pinned tangents, the expected sample count, and a pinned interior sample.
 */
test('Catmull-Rom (real WASM tangents + eval) closed loop pins to the engine', () => {
  // Tangents for the (p0,p1,p2,p3) window at tension 0.5 — golden from the engine.
  const t = catmullRomTangents(P[0], P[1], P[2], P[3], 0.5);
  closeVec(t.cp1, 0.707107, 0.5, 0.5, 'cp1');
  closeVec(t.cp2, 0.707107, 0, 0.707107, 'cp2');

  // Closed loop, 4 control points, 3 samples/segment: the first segment emits
  // j=0..3 (4 points) and each of the remaining 3 segments emits j=1..3, so
  // 4 + 3*3 = 13 points. Pins the closed-loop index bookkeeping against the
  // real evaluators.
  const curve = generateCatmullRomCurve(P, 0.5, 3, catmullRomTangents, cubicFast, true);
  assert.equal(curve.length, 13);
  closeVec(curve[5], 0.571435, 0.124877, 0.81109, 'closed-loop sample [5]');
});
