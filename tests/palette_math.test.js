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
  mapValue, proceduralPaletteCpp, generativePaletteCpp,
} = await import('../tools/palette_math.js');

/** sRGB -> linear, the same transfer the module applies on output. */
function srgbToLinear(s) {
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

const NEAR = 1e-6;

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

test('mapValue computes the expected interpolations', () => {
  assert.equal(mapValue(0.5, 0, 1, 0, 100), 50);
  assert.equal(mapValue(2, 0, 4, 10, 20), 15);
});

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
