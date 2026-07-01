// @ts-check
//
// Executed parity between the browser tools' hand-ported color math and the
// engine functions they mirror, run against the real shipped WASM module.
//
// The C++ runs the math in float; the JS ports run it in double, so float
// outputs are compared within a small tolerance while integer outputs (the HSV
// bytes, the LUT-quantized palette) must match exactly (or within 1 LUT step,
// where the float-vs-double cosine input can land in an adjacent cell).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createHolosphereModule from '../holosphere_wasm.js';
import * as C from '../tools/color.js';
import * as P from '../tools/palette_math.js';
import * as L from '../tools/lissajous_math.js';

// Top-level await fails this file loudly if the module can't instantiate,
// rather than silently skipping the parity checks.
const M = await createHolosphereModule({ print() {}, printErr() {} });

test('WASM parity module is present with the exports this suite pins', () => {
  for (const name of [
    'srgb_to_linear_float', 'linear_to_srgb_float', 'srgb_to_linear_interp',
    'linear_rgb_to_oklab', 'oklab_to_linear_rgb', 'hsv_to_rgb',
    'procedural_palette_linear', 'lissajous',
  ]) {
    assert.equal(typeof M[name], 'function',
      `holosphere_wasm.js is missing export ${name} — parity check would not run`);
  }
});

const FLOAT_EPS = 1e-4;
const near = (a, b, eps = FLOAT_EPS) => Math.abs(a - b) <= eps;

/** Verifies the sRGB transfer function and its inverse match color.js. */
test('sRGB transfer parity (srgb_to_linear / linear_to_srgb)', () => {
  for (const s of [0, 0.01, 0.04045, 0.05, 0.2, 0.5, 0.8, 1]) {
    assert.ok(near(M.srgb_to_linear_float(s), C.srgbToLinearFloat(s)),
      `srgb_to_linear(${s})`);
    assert.ok(near(M.linear_to_srgb_float(s), C.linearToSrgbFloat(s)),
      `linear_to_srgb(${s})`);
  }
});

/**
 * Pins the engine's OKLab transform to fixed golden values in both directions.
 * The parity test above is wasm-vs-js only, so a coordinated drift shared by both
 * ports (e.g. a mistyped Ottosson coefficient copied into each) would slip
 * through; these absolutes catch a systematic shift in the matrices. The forward
 * red golden is Ottosson's published reference (L≈0.628, a≈0.225, b≈0.126), so it
 * also pins the engine to the canonical OKLab definition, not just to itself.
 */
test('OKLab golden values (absolute pin)', () => {
  const fwd1 = M.linear_rgb_to_oklab(0.1, 0.5, 0.9);
  assert.ok(near(fwd1.L, 0.757296) && near(fwd1.a, -0.067583) && near(fwd1.b, -0.101862),
    `oklab(0.1,0.5,0.9): (${fwd1.L},${fwd1.a},${fwd1.b})`);
  const fwdRed = M.linear_rgb_to_oklab(1, 0, 0);
  assert.ok(near(fwdRed.L, 0.627955) && near(fwdRed.a, 0.224863) && near(fwdRed.b, 0.125846),
    `oklab(1,0,0) vs Ottosson red: (${fwdRed.L},${fwdRed.a},${fwdRed.b})`);
  const inv = M.oklab_to_linear_rgb(0.7, 0.1, -0.05);
  assert.ok(near(inv.r, 0.57893) && near(inv.g, 0.228833) && near(inv.b, 0.50137),
    `oklab_to_linear_rgb(0.7,0.1,-0.05): (${inv.r},${inv.g},${inv.b})`);
});

/**
 * Verifies the integer HSV sextant split matches byte-for-byte. This is the path
 * where float sextant math would drift from the device at every region boundary,
 * so an exact match across the wheel is the point.
 */
test('HSV sextant parity (hsv_to_rgb) is exact across the wheel', () => {
  for (let h = 0; h < 256; h += 5) {
    for (const s of [0, 1, 64, 128, 200, 255]) {
      for (const v of [0, 1, 77, 255]) {
        const w = M.hsv_to_rgb(h, s, v);
        const j = P.hsvToRgb(h, s, v);
        assert.ok(w.r === j.r && w.g === j.g && w.b === j.b,
          `hsv_to_rgb(${h},${s},${v}): wasm(${w.r},${w.g},${w.b}) js(${j.r},${j.g},${j.b})`);
      }
    }
  }
});

/**
 * Out-of-range HSV inputs: the WASM uint8_t cast and palette_math.js's `& 0xff`
 * both wrap mod 256, so the two must still agree past the [0,255] edges (the
 * in-range sweep above can't catch a clamp-vs-wrap divergence).
 */
test('HSV out-of-range parity (hsv_to_rgb) wraps mod 256 on both sides', () => {
  for (const [h, s, v] of [
    [-1, 128, 200], [256, 128, 200], [300, 64, 64], [-256, 255, 255],
    [128, -1, 200], [128, 256, 200], [128, 128, -5], [128, 128, 511],
  ]) {
    const w = M.hsv_to_rgb(h, s, v);
    const j = P.hsvToRgb(h, s, v);
    assert.ok(w.r === j.r && w.g === j.g && w.b === j.b,
      `hsv_to_rgb(${h},${s},${v}): wasm(${w.r},${w.g},${w.b}) js(${j.r},${j.g},${j.b})`);
  }
});

/**
 * Verifies the ProceduralPalette cosine formula matches the engine. The engine's
 * get() clamps the cosine to sRGB then quantizes through the interpolated linear
 * LUT; the JS port computes the same clamped sRGB cosine, so feeding it through
 * the engine's srgb_to_linear_interp must land on the engine's 16-bit linear
 * value (within one LUT step from the float-vs-double cosine input).
 */
test('ProceduralPalette cosine parity (procedural_palette_linear)', () => {
  const a = [0.5, 0.5, 0.5], b = [0.5, 0.5, 0.5], c = [1, 1, 1], d = [0, 0.33, 0.67];
  const pal = new P.ProceduralPalette(a, b, c, d);
  for (const t of [0, 0.15, 0.25, 0.5, 0.75, 1]) {
    const w = M.procedural_palette_linear(
      a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], t);
    const wCh = [w.r, w.g, w.b];
    for (let ch = 0; ch < 3; ch++) {
      const srgb = Math.max(0, Math.min(1, pal.getChannelValue(t, ch)));
      const jsLinear = M.srgb_to_linear_interp(srgb);
      // Within one 16-bit LUT step: the only divergence is float-vs-double cosine rounding.
      assert.ok(Math.abs(jsLinear - wCh[ch]) <= 1,
        `palette t=${t} ch=${ch}: wasm=${wCh[ch]} js=${jsLinear}`);
    }
  }
});

/**
 * Pins the engine's procedural_palette_linear output to fixed golden 16-bit
 * linear values. The parity test above compares wasm-vs-js, so a *uniform* offset
 * shared by both sides would slip through; these absolute goldens catch a
 * systematic shift in the palette formula or the linear LUT.
 */
test('ProceduralPalette golden linear values (absolute pin)', () => {
  const a = [0.5, 0.5, 0.5], b = [0.5, 0.5, 0.5], c = [1, 1, 1], d = [0, 0.33, 0.67];
  const at = (t) => {
    const w = M.procedural_palette_linear(
      a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], t);
    return [w.r, w.g, w.b];
  };
  assert.deepEqual(at(0.5), [0, 33327, 33327]);
  assert.deepEqual(at(0.25), [14028, 338, 56614]);
});

/** Verifies the lissajous curve matches lissajous_math.js. */
test('lissajous parity (lissajous)', () => {
  for (const [m1, m2, a, t] of [[3, 2, 0, 0.7], [5, 4, 0.5, 1.2], [1, 1, 0, 0], [2, 3, 1.1, 2.5]]) {
    const w = M.lissajous(m1, m2, a, t);
    const j = L.lissajous(m1, m2, a, t);
    assert.ok(near(w.x, j.x) && near(w.y, j.y) && near(w.z, j.z),
      `lissajous(${m1},${m2},${a},${t}): wasm(${w.x},${w.y},${w.z}) js(${j.x},${j.y},${j.z})`);
  }
});

/**
 * Pins the lissajous curve to fixed golden points. The parity test above is
 * wasm-vs-js only, so a phase/axis-swap or amplitude drift copied into both ports
 * would pass; these absolutes catch a systematic change in the curve formula.
 * Every golden point lies on the unit sphere (the curve is sphere-mapped), which
 * is itself an invariant a drift would break.
 */
test('lissajous golden points (absolute pin)', () => {
  const p1 = M.lissajous(3, 2, 0, 0.7);
  assert.ok(near(p1.x, -0.4975) && near(p1.y, 0.169967) && near(p1.z, 0.850649),
    `lissajous(3,2,0,0.7): (${p1.x},${p1.y},${p1.z})`);
  const p2 = M.lissajous(5, 4, 0.5, 1.2);
  assert.ok(near(p2.x, -0.705952) && near(p2.y, 0.087499) && near(p2.z, 0.702834),
    `lissajous(5,4,0.5,1.2): (${p2.x},${p2.y},${p2.z})`);
  for (const p of [p1, p2]) {
    assert.ok(near(Math.hypot(p.x, p.y, p.z), 1, 1e-3),
      `lissajous point off the unit sphere: (${p.x},${p.y},${p.z})`);
  }
});
