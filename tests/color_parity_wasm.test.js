// @ts-check
//
// Executed parity between the browser tools' hand-ported color math and the
// engine functions they mirror, run against the real shipped WASM module.
//
// tools/color.js, tools/palette_math.js and tools/lissajous_math.js re-implement
// the engine's perceptual pipeline (the sRGB transfer, the Ottosson OKLab
// matrices, the integer HSV sextant split, the ProceduralPalette cosine formula,
// the lissajous curve). These tests call the engine's own functions through the
// WASM bridge and assert the JS ports reproduce them, so an engine-side change
// surfaces as a JS test failure instead of a silent divergence in the preview.
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

const M = await createHolosphereModule({ print() {}, printErr() {} });

const FLOAT_EPS = 1e-4; // float32 (engine) vs float64 (JS) on smooth transforms
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

/** Verifies the Ottosson OKLab matrices match color.js in both directions. */
test('OKLab matrix parity (linear_rgb_to_oklab / oklab_to_linear_rgb)', () => {
  for (const [r, g, b] of [[0.1, 0.5, 0.9], [1, 0, 0], [0, 0.8, 0.2], [0.3, 0.3, 0.3], [0, 0, 0]]) {
    const w = M.linear_rgb_to_oklab(r, g, b);
    const j = C.linearRgbToOklab(r, g, b);
    assert.ok(near(w.L, j.L) && near(w.a, j.a) && near(w.b, j.b),
      `linear_rgb_to_oklab(${r},${g},${b}): wasm(${w.L},${w.a},${w.b}) js(${j.L},${j.a},${j.b})`);

    const wr = M.oklab_to_linear_rgb(j.L, j.a, j.b);
    const jr = C.oklabToLinearRgb(j);
    assert.ok(near(wr.r, jr.r) && near(wr.g, jr.g) && near(wr.b, jr.b),
      `oklab_to_linear_rgb: wasm(${wr.r},${wr.g},${wr.b}) js(${jr.r},${jr.g},${jr.b})`);
  }
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
      assert.ok(Math.abs(jsLinear - wCh[ch]) <= 2,
        `palette t=${t} ch=${ch}: wasm=${wCh[ch]} js=${jsLinear}`);
    }
  }
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
