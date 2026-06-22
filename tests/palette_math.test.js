// @ts-check
//
// palette_math.js — pure palette math extracted from tools/palettes.html.
// The module mirrors the engine's ProceduralPalette and GenerativePalette and
// owns the C++ export-string generators, so these tests lock both the numeric
// output and the exact C++ initializer text the inline page cannot cover.
//
// Run: node --test --experimental-test-module-mocks "tests/palette_math.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  ProceduralPalette, CPixel, PRNG, hsvToRgb, GenerativePalette,
  mapValue, proceduralPaletteCpp, generativePaletteCpp, setPaletteOps,
} = await import('../tools/palette_math.js');

// GenerativePalette's color math now lives in the C++ engine (PaletteOps.bakeLut
// in the WASM module) and is covered by the native test suite. These tests cover
// the JS side's responsibilities: resolving profiles into the bakeLut arguments
// and sampling the returned LUT. A mock bakeLut stands in for the WASM bridge --
// a smooth in-range sRGB ramp -- and records its last arguments so the delegation
// (shape enum int + nine [0,255] HSV values) can be asserted.
let lastBakeArgs = null;
function mockBakeLut(...args) {
  lastBakeArgs = args;
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    lut[3 * i] = i;            // R ramps up
    lut[3 * i + 1] = 255 - i;  // G ramps down
    lut[3 * i + 2] = 128;      // B constant
  }
  return lut;
}
setPaletteOps(mockBakeLut);

/**
 * Converts an sRGB channel value to linear light, the same transfer the module applies on output.
 * @param {number} s - sRGB channel value in [0, 1].
 * @returns {number} The linearized channel value in [0, 1].
 */
function srgbToLinear(s) {
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

const NEAR = 1e-6;

/** Verifies ProceduralPalette.get clamps and linearizes the cosine output, and that getChannelValue exposes the raw cosine. */
test('ProceduralPalette.get at t=0 and t=0.5 for a known coefficient set', () => {
  // a=0.5, b=0.5, c=1, d=0 → sRGB = clamp(0.5 + 0.5*cos(2π·t)).
  const p = new ProceduralPalette([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0]);

  // t=0: cos(0)=1 → sRGB 1.0 → linear 1.0 on every channel.
  const at0 = p.get(0);
  for (const ch of at0) assert.ok(Math.abs(ch - srgbToLinear(1.0)) < NEAR);
  assert.ok(Math.abs(at0[0] - 1.0) < NEAR);

  // t=0.5: cos(π) = -1 → sRGB clamp(0.0) → linear 0.0.
  const at05 = p.get(0.5);
  for (const ch of at05) assert.ok(Math.abs(ch - srgbToLinear(0.0)) < NEAR);
  assert.ok(Math.abs(at05[0] - 0.0) < NEAR);

  // getChannelValue returns the raw (un-clamped, un-linearized) cosine value.
  assert.ok(Math.abs(p.getChannelValue(0, 0) - 1.0) < NEAR);
  assert.ok(Math.abs(p.getChannelValue(0.5, 0) - 0.0) < NEAR);
});

/** Verifies the PRNG yields identical sequences for equal seeds (via next and nextInt) and diverges for different seeds. */
test('PRNG is deterministic: same seed -> same sequence', () => {
  const a = new PRNG(12345);
  const b = new PRNG(12345);
  for (let i = 0; i < 16; i++) {
    assert.equal(a.next(), b.next());
  }
  const c = new PRNG(12345);
  const d = new PRNG(12345);
  for (let i = 0; i < 16; i++) {
    assert.equal(c.nextInt(0, 100), d.nextInt(0, 100));
  }
  // A different seed should (overwhelmingly likely) diverge.
  assert.notEqual(new PRNG(1).next(), new PRNG(2).next());
});

/** Verifies hsvToRgb maps the region-boundary hues to pure primaries and returns a CPixel. */
test('hsvToRgb on primary hues returns pure red/green/blue', () => {
  // h, s, v in 0..255; full saturation and value. The engine splits the wheel
  // into six 43-wide regions (region = h/43), so the pure primaries land on the
  // region boundaries: red=0, green=86, blue=172 (not the float-math 0/85/170).
  const red = hsvToRgb(0, 255, 255);
  assert.deepEqual([red.r, red.g, red.b], [255, 0, 0]);
  assert.ok(red instanceof CPixel);

  const green = hsvToRgb(86, 255, 255);
  assert.deepEqual([green.r, green.g, green.b], [0, 255, 0]);

  const blue = hsvToRgb(172, 255, 255);
  assert.deepEqual([blue.r, blue.g, blue.b], [0, 0, 255]);
});

/** Verifies mapValue linearly remaps a value from one numeric range to another. */
test('mapValue computes the expected interpolations', () => {
  assert.equal(mapValue(0.5, 0, 1, 0, 100), 50);
  assert.equal(mapValue(2, 0, 4, 10, 20), 15);
});

/** Verifies proceduralPaletteCpp emits the ProceduralPalette initializer with f-suffixed floats and per-vector comments. */
test('proceduralPaletteCpp emits a valid C++ initializer (finding 291 guard)', () => {
  const params = {
    A_R: 0.5, A_G: 0.5, A_B: 0.5,
    B_R: 0.5, B_G: 0.5, B_B: 0.5,
    C_R: 1.0, C_G: 1.0, C_B: 1.0,
    D_R: 0.0, D_G: 0.33, D_B: 0.67,
  };
  const s = proceduralPaletteCpp(params);
  assert.ok(s.includes('ProceduralPalette palette('));
  assert.ok(s.includes('f}')); // f-suffixed floats inside brace-init vec3s
  assert.ok(s.includes('// A'));
  assert.ok(s.includes('// B'));
  assert.ok(s.includes('// C'));
  assert.ok(s.includes('// D'));
  // Floats carry the `f` suffix, not bare JS numbers.
  assert.ok(s.includes('{0.500f, 0.500f, 0.500f}'));
});

/** Verifies generativePaletteCpp emits the GenerativePalette block with the chosen enum tokens, base hue, and caveat comment. */
test('generativePaletteCpp emits the block with the chosen enum tokens', () => {
  const s = generativePaletteCpp({
    shape: 'VIGNETTE',
    harmony: 'TRIADIC',
    brightness: 'ASCENDING',
    sat: 'VIBRANT',
    hueValue: 42,
  });
  assert.ok(s.includes('GenerativePalette palette{'));
  assert.ok(s.includes('GradientShape::VIGNETTE'));
  assert.ok(s.includes('HarmonyType::TRIADIC'));
  assert.ok(s.includes('BrightnessProfile::ASCENDING'));
  assert.ok(s.includes('SaturationProfile::VIBRANT'));
  assert.ok(s.includes('42}'));
  // Reproducibility caveat comment is preserved.
  assert.ok(s.includes('// Reproduces the profiles + base hue exactly'));
});

/** Verifies generativePaletteCpp rejects an enum token that would emit a nonexistent C++ enumerator. */
test('generativePaletteCpp rejects an unknown enum token', () => {
  const ok = { shape: 'STRAIGHT', harmony: 'TRIADIC', brightness: 'FLAT', sat: 'MID', hueValue: 0 };
  assert.throws(() => generativePaletteCpp({ ...ok, shape: 'SPIRAL' }), /unknown GradientShape "SPIRAL"/);
  assert.throws(() => generativePaletteCpp({ ...ok, harmony: 'TETRADIC' }), /unknown HarmonyType "TETRADIC"/);
  assert.throws(() => generativePaletteCpp({ ...ok, brightness: 'DOME' }), /unknown BrightnessProfile "DOME"/);
  assert.throws(() => generativePaletteCpp({ ...ok, sat: 'NEON' }), /unknown SaturationProfile "NEON"/);
  assert.doesNotThrow(() => generativePaletteCpp(ok));
});

/** Verifies GenerativePalette resolves the profiles into a valid bakeLut call: the GradientShape enum int and nine in-range HSV values. */
test('GenerativePalette delegates resolved (shape, h,s,v x3) to bakeLut', () => {
  lastBakeArgs = null;
  new GenerativePalette('VIGNETTE', 'TRIADIC', 'FLAT', 'VIBRANT', 100);
  assert.ok(Array.isArray(lastBakeArgs) && lastBakeArgs.length === 10, 'bakeLut called with 10 args');
  // VIGNETTE is index 2 in core/color.h GradientShape order.
  assert.equal(lastBakeArgs[0], 2, 'shape enum int');
  // The nine HSV values are integers in [0, 255].
  for (let i = 1; i < 10; i++) {
    assert.ok(Number.isInteger(lastBakeArgs[i]), `arg ${i} integer`);
    assert.ok(lastBakeArgs[i] >= 0 && lastBakeArgs[i] <= 255, `arg ${i} in [0,255]`);
  }
  // FLAT/VIBRANT are RNG-free: value 255, saturation 255 on all three keys.
  assert.deepEqual([lastBakeArgs[3], lastBakeArgs[6], lastBakeArgs[9]], [255, 255, 255], 'FLAT values');
  assert.deepEqual([lastBakeArgs[2], lastBakeArgs[5], lastBakeArgs[8]], [255, 255, 255], 'VIBRANT saturations');
});

/** Verifies GenerativePalette rejects an unknown gradient shape before reaching bakeLut. */
test('GenerativePalette throws on an unknown gradient shape', () => {
  assert.throws(() => new GenerativePalette('SPIRAL', 'TRIADIC', 'FLAT', 'VIBRANT', 0),
    /unknown GradientShape "SPIRAL"/);
});

/**
 * Verifies GenerativePalette.get's upper boundary. get clamps t to [0,1] and
 * maps it onto the 256-entry LUT: t === 1.0 lands exactly on the final entry
 * (no lo+1 overrun), and t > 1.0 clamps to that same entry — it must return the
 * final color, not NaN or a wrapped value, and be continuous with the interior
 * limit approaching it.
 */
test('GenerativePalette.get: t === 1.0 and t > 1.0 clamp to the final stop color', () => {
  const pal = new GenerativePalette('STRAIGHT', 'ANALOGOUS', 'ASCENDING', 'VIBRANT', 128);

  const atOne = pal.get(1.0);
  const beyond = pal.get(1.5);
  const justBelow = pal.get(0.99999);

  // Finite and in range at the boundary.
  assert.equal(atOne.length, 3);
  for (const ch of atOne) {
    assert.ok(Number.isFinite(ch), `channel finite at t=1.0`);
    assert.ok(ch >= -1e-6 && ch <= 1 + 1e-6, `channel ${ch} in [0,1] at t=1.0`);
  }

  // t > 1.0 clamps to the same endpoint as t === 1.0 (no wrap-around).
  assert.deepEqual(beyond, atOne);

  // The endpoint is continuous with the interior approaching it.
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(atOne[i] - justBelow[i]) < 1e-4, `continuous at t→1 on channel ${i}`);
  }
});

/** Verifies GenerativePalette.get yields finite linear RGB triples within [0, 1] across several t values and shapes. */
test('GenerativePalette.get returns finite linear RGB in range', () => {
  const pal = new GenerativePalette('STRAIGHT', 'ANALOGOUS', 'ASCENDING', 'VIBRANT', 128);
  for (const t of [0, 0.25, 0.5, 0.75, 0.999]) {
    const rgb = pal.get(t);
    assert.equal(rgb.length, 3);
    for (const ch of rgb) {
      assert.ok(Number.isFinite(ch), `channel finite at t=${t}`);
      assert.ok(ch >= -1e-6 && ch <= 1 + 1e-6, `channel ${ch} in [0,1] at t=${t}`);
    }
  }
  // Vignette shape exercises the black endpoints and 5-segment LUT.
  const vig = new GenerativePalette('VIGNETTE', 'COMPLEMENTARY', 'BELL', 'MID', 200);
  const mid = vig.get(0.5);
  for (const ch of mid) assert.ok(Number.isFinite(ch));
});
