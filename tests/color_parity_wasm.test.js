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
import { defaultPaletteRecipe, PaletteV2 } from '../tools/palette_controls.js';
import * as L from '../tools/lissajous_math.js';
import * as MB from '../tools/mobius_transforms.js';

// Top-level await fails this file loudly if the module can't instantiate,
// rather than silently skipping the parity checks.
const M = await createHolosphereModule({ print() {}, printErr() {} });

test('WASM parity module is present with the exports this suite pins', () => {
  for (const name of [
    'srgb_to_linear_float', 'linear_to_srgb_float', 'srgb_to_linear_interp',
    'linear_rgb_to_oklab', 'oklab_to_linear_rgb', 'hsv_to_rgb',
    'procedural_palette_linear', 'named_procedural_palettes',
    'lissajous', 'mobius_transform',
    'PaletteOps',
  ]) {
    assert.equal(typeof M[name], 'function',
      `holosphere_wasm.js is missing export ${name} — parity check would not run`);
  }
});

// Largest divergence observed over the inputs below is 6.1e-7, on the Mobius
// presets, whose coefficients also carry mobiusCodeString's 6-digit rounding;
// the golden literals are themselves written to 6 decimals, a 5e-7 floor.
const FLOAT_EPS = 5e-6;
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
 * Pins the engine's integer HSV sextant split (hsv_to_rgb) to fixed golden bytes.
 * The C++ path splits the wheel into six 43-wide regions (primaries land on
 * 0/86/172) and mixes channels with >>8 fixed-point math; these goldens catch a
 * drift in the region boundaries or the fixed-point blend. The out-of-range rows
 * confirm the uint8_t cast wraps mod 256 rather than clamping.
 */
test('HSV sextant golden bytes (hsv_to_rgb, absolute pin)', () => {
  const golden = [
    [[0, 255, 255], [255, 0, 0]],
    [[43, 255, 255], [254, 255, 0]],
    [[86, 255, 255], [0, 255, 0]],
    [[128, 255, 255], [0, 255, 252]],
    [[172, 255, 255], [0, 0, 255]],
    [[215, 255, 255], [255, 0, 254]],
    [[30, 128, 200], [200, 170, 99]],
    [[100, 0, 180], [180, 180, 180]],
    [[50, 255, 0], [0, 0, 0]],
    [[256, 128, 200], [200, 100, 99]],
    [[-1, 128, 200], [200, 99, 105]],
  ];
  for (const [[h, s, v], [r, g, b]] of golden) {
    const w = M.hsv_to_rgb(h, s, v);
    assert.ok(w.r === r && w.g === g && w.b === b,
      `hsv_to_rgb(${h},${s},${v}): wasm(${w.r},${w.g},${w.b}) golden(${r},${g},${b})`);
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

/**
 * Pins palette_math.js's NAMED_PROCEDURAL_PALETTES table to the engine's own
 * roster: name, order and all twelve a/b/c/d coefficients. The tool transcribes
 * core/color/palettes.h so the gallery preview and the C++ it tells you to paste
 * back match the device, and nothing but this comparison enforces it. The engine
 * returns float32, so each mirrored coefficient is rounded through Math.fround
 * before the comparison — an exact equality, not a tolerance.
 */
test('NAMED_PROCEDURAL_PALETTES matches the engine table (named_procedural_palettes)', () => {
  const toFloat32 = (vec3) => vec3.map((v) => Math.fround(v));
  const mirror = P.NAMED_PROCEDURAL_PALETTES.map(({ name, a, b, c, d }) => ({
    name,
    a: toFloat32(a), b: toFloat32(b), c: toFloat32(c), d: toFloat32(d),
  }));
  assert.deepEqual(M.named_procedural_palettes(), mirror);
});

const LUT_SAMPLES = [0, 32, 64, 96, 128, 160, 192, 224, 255];

function sampleLut(lut) {
  assert.equal(lut.length, 256 * 3);
  return LUT_SAMPLES.map((index) =>
    [lut[3 * index], lut[3 * index + 1], lut[3 * index + 2]]);
}

test('PaletteOps exposes only the V2 recipe compiler operations', () => {
  const ops = new M.PaletteOps();
  try {
    assert.equal(typeof ops.compileAndBakeV2, 'function');
    assert.equal(typeof ops.inspectV2, 'function');
    assert.equal(ops.bakeLut, undefined);
  } finally {
    ops.delete();
  }
});

test('PaletteOps compiles deterministic V2 recipe LUTs', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  try {
    const first = ops.compileAndBakeV2(recipe);
    const second = ops.compileAndBakeV2(recipe);
    assert.equal(first.status.code, 0);
    assert.equal(first.canonicalRecipe.schemaVersion, 2);
    assert.deepEqual(sampleLut(Uint8Array.from(first.lut)),
      sampleLut(Uint8Array.from(second.lut)));
  } finally {
    ops.delete();
  }
});

test('PaletteOps enforces exact mirror and loop seams', () => {
  const ops = new M.PaletteOps();
  try {
    const mirror = defaultPaletteRecipe();
    mirror.domain = PaletteV2.domain.MIRROR;
    const mirrored = Uint8Array.from(ops.compileAndBakeV2(mirror).lut);
    for (let index = 0; index < 128; index += 1) {
      assert.deepEqual(
        Array.from(mirrored.slice(index * 3, index * 3 + 3)),
        Array.from(mirrored.slice((255 - index) * 3, (256 - index) * 3)));
    }

    const loop = defaultPaletteRecipe();
    loop.domain = PaletteV2.domain.LOOP;
    loop.hue.mode = PaletteV2.hueMode.SWEEP;
    const looped = Uint8Array.from(ops.compileAndBakeV2(loop).lut);
    assert.deepEqual(Array.from(looped.slice(765)), Array.from(looped.slice(0, 3)));
  } finally {
    ops.delete();
  }
});

test('GenerativePalette removes the saturated-blue gamut seam', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  recipe.domain = PaletteV2.domain.VIGNETTE;
  recipe.hue.baseTurns = 200 / 256;
  recipe.chroma.center = 1;
  recipe.chroma.headroom = 1;
  recipe.lightness.center = 0.43;

  try {
    const result = ops.inspectV2(recipe);
    const lut = Uint8Array.from(result.lut);
    let largestChannelStep = 0;
    for (let index = 52; index <= 78; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        largestChannelStep = Math.max(largestChannelStep,
          Math.abs(lut[index * 3 + channel] - lut[(index - 1) * 3 + channel]));
      }
    }
    assert.ok(largestChannelStep < 16,
      `saturated-blue region contains a ${largestChannelStep}-level channel seam`);
    assert.ok(Array.from(result.fallback).every((mapped) => mapped === 0));
  } finally {
    ops.delete();
  }
});

test('Complementary harmony progresses once from the seed to its opposite', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  recipe.hue.harmony = PaletteV2.harmony.COMPLEMENTARY;

  try {
    const diagnostics = ops.inspectV2(recipe).diagnostics;
    const firstHue = diagnostics[4];
    const middleHue = diagnostics[127 * 6 + 4];
    const lastHue = diagnostics[255 * 6 + 4];
    assert.ok(Math.abs(middleHue - firstHue - Math.PI / 2) < 0.02);
    assert.ok(Math.abs(lastHue - firstHue - Math.PI) < 0.02);
  } finally {
    ops.delete();
  }
});

test('browser GenerativePalette owns the real bridge result', () => {
  const ops = new M.PaletteOps();
  P.setPaletteOps(ops);
  try {
    const recipe = defaultPaletteRecipe();
    recipe.hue.baseTurns = 0.37;
    const direct = ops.inspectV2(recipe);
    const palette = new P.GenerativePalette(recipe);
    assert.deepEqual(palette.lut, Uint8Array.from(direct.lut));
    assert.deepEqual(palette.canonicalRecipe, direct.canonicalRecipe);
    assert.equal(palette.diagnostics.length, 256 * 6);
    assert.equal(palette.fallback.length, 256);
  } finally {
    P.setPaletteOps(null);
    ops.delete();
  }
});

test('PATH_MINIMUM is rejected until its certified solver is available', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  recipe.chroma.basis = PaletteV2.chromaBasis.PATH_MINIMUM;
  try {
    const result = ops.compileAndBakeV2(recipe);
    assert.notEqual(result.status.code, 0);
    assert.equal(result.lut, undefined);
  } finally {
    ops.delete();
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
    assert.ok(near(Math.hypot(p.x, p.y, p.z), 1),
      `lissajous point off the unit sphere: (${p.x},${p.y},${p.z})`);
  }
});

/**
 * Stereographic projection in the convention the mobius.html fragment shader
 * uses: pole at +y, real axis x, imaginary axis z.
 * @param {number[]} p - Unit sphere point as [x, y, z].
 * @returns {{re:number, im:number}} The projected complex-plane coordinate.
 */
function stereo([x, y, z]) {
  const denom = 1 - y;
  return { re: x / denom, im: z / denom };
}

/**
 * Inverse stereographic projection back onto the unit sphere.
 * @param {{re:number, im:number}} w - Complex-plane coordinate.
 * @returns {{x:number, y:number, z:number}} The corresponding sphere point.
 */
function invStereo(w) {
  const r2 = w.re * w.re + w.im * w.im;
  return { x: (2 * w.re) / (r2 + 1), y: (r2 - 1) / (r2 + 1), z: (2 * w.im) / (r2 + 1) };
}

/**
 * Maps a sphere point through the tool's own complex arithmetic: project, apply
 * f(z) = (Az + B) / (Cz + D), unproject. This is the reference the engine's
 * fused mobius_transform must reproduce.
 * @param {number[]} p - Unit sphere point as [x, y, z].
 * @param {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} coeffs - The Mobius coefficients.
 * @returns {{x:number, y:number, z:number}} The transformed sphere point.
 */
function mobiusSphereJs(p, { A, B, C, D }) {
  const w = stereo(p);
  return invStereo(MB.cdiv(MB.cadd(MB.cmult(A, w), B), MB.cadd(MB.cmult(C, w), D)));
}

/**
 * Splits mobiusCodeString's C++ initializer back into its eight floats, so the
 * WASM call is fed in exactly the order the generated MobiusParams literal uses.
 * The values are the tool's 6-digit rounding of the coefficients, which is the
 * only difference between the two sides of the comparison.
 * @param {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} coeffs - The Mobius coefficients.
 * @returns {number[]} The eight floats, in emission order.
 */
function mobiusArgs({ A, B, C, D }) {
  const body = MB.mobiusCodeString(A, B, C, D).replace(/^MobiusParams\{|\}$/g, '');
  const floats = body.split(',').map((s) => parseFloat(s));
  assert.equal(floats.length, 8, `mobiusCodeString emitted ${floats.length} floats, want 8`);
  for (const f of floats) assert.ok(Number.isFinite(f), `mobiusCodeString emitted ${body}`);
  return floats;
}

const MOBIUS_POINTS = [
  [0.48, 0.6, 0.64], [0.6, -0.8, 0], [-0.36, 0.48, -0.8],
  [0.8, 0, 0.6], [0, -0.6, 0.8],
];

/**
 * Pins every preset generator's coefficients against the engine's Mobius map.
 * The WASM side is fed through mobiusCodeString, so this covers both the
 * eight-float MobiusParams ordering the tool emits and the stereographic
 * convention (pole +y, real axis x, imaginary axis z) the two share. Sample
 * points stay clear of the pole, where the engine's fused form and the tool's
 * guarded division diverge by design.
 */
test('mobius preset parity (mobius_transform)', () => {
  const presets = [
    ['elliptic', MB.elliptic, 0.7], ['hyperbolic', MB.hyperbolic, 1.3],
    ['loxodromic', MB.loxodromic, 2.1], ['parabolic', MB.parabolic, 0.9],
    ['inversion', MB.inversion, 1.6], ['tumble', MB.tumble, 2.4],
    ['cayley', MB.cayley, 3.0],
  ];
  for (const [name, gen, t] of presets) {
    const coeffs = gen(t);
    const args = mobiusArgs(coeffs);
    for (const p of MOBIUS_POINTS) {
      const w = M.mobius_transform(p[0], p[1], p[2], ...args);
      const j = mobiusSphereJs(p, coeffs);
      assert.ok(near(w.x, j.x) && near(w.y, j.y) && near(w.z, j.z),
        `${name}(t=${t}) at (${p}): wasm(${w.x},${w.y},${w.z}) js(${j.x},${j.y},${j.z})`);
      assert.ok(near(Math.hypot(w.x, w.y, w.z), 1),
        `${name}(t=${t}) at (${p}) left the unit sphere`);
    }
  }
});

/**
 * Pins the Mobius map to analytically derived images, so a drift copied into
 * both ports cannot pass. Identity fixes every point; f(z) = 1/z is a 180°
 * rotation about x under this stereographic convention, and its coefficients
 * (a=0, b=1, c=1, d=0) are asymmetric in every adjacent argument pair, so a
 * transposed eight-float ordering fails here.
 */
test('mobius golden images (absolute pin)', () => {
  for (const [x, y, z] of MOBIUS_POINTS) {
    const id = M.mobius_transform(x, y, z, 1, 0, 0, 0, 0, 0, 1, 0);
    assert.ok(near(id.x, x) && near(id.y, y) && near(id.z, z),
      `identity moved (${x},${y},${z}) to (${id.x},${id.y},${id.z})`);
    const inv = M.mobius_transform(x, y, z, 0, 0, 1, 0, 1, 0, 0, 0);
    assert.ok(near(inv.x, x) && near(inv.y, -y) && near(inv.z, -z),
      `1/z mapped (${x},${y},${z}) to (${inv.x},${inv.y},${inv.z}), want (${x},${-y},${-z})`);
  }
});
