// Browser tools' colour, Lissajous and Mobius math parity and goldens,
// run against the real shipped WASM module.
//
// The C++ runs the math in float; the JS ports run it in double, so float
// outputs are compared within a small tolerance. LUT-quantized palette outputs
// allow one 16-bit linear LSB for float-versus-double rounding.
import {oklchLinearRgb, maxSrgbGamutChroma} from '../src/workbench/palettes/palette_wheel.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import createHolosphereModule from '../generated/holosphere_wasm.js';
import * as C from '../src/shared/color.js';
import { PaletteRecipeModel } from '../src/workbench/palettes/palette_recipe_model.js';
import * as P from '../src/workbench/palettes/palette_math.js';
import {
  defaultPaletteRecipe, hueKeyState, paletteEnumName,  PaletteV4, zoomRecipeWindow,
} from '../src/workbench/palettes/palette_controls.js';
import * as L from '../src/workbench/lissajous/lissajous_math.js';
import * as MB from '../src/workbench/mobius/mobius_transforms.js';
import { LISSAJOUS_GOLDENS } from './helpers/lissajous_goldens.js';

// Top-level await fails this file loudly if the module can't instantiate.
const M = await createHolosphereModule({ print() {}, printErr() {} });

test('WASM parity module is present with the exports this suite pins', () => {
  for (const name of [
    'srgb_to_linear_float', 'linear_to_srgb_float', 'srgb_to_linear_interp',
    'linear_rgb_to_oklab', 'oklab_to_linear_rgb', 'hsv_to_rgb', 'gamut_max_chroma',
    'procedural_palette_linear', 'named_procedural_palettes',
    'lissajous', 'mobius_transform',
    'PaletteOps',
  ]) {
    assert.equal(typeof M[name], 'function',
      `generated/holosphere_wasm.js is missing export ${name} — parity check would not run`);
  }
});

// Float-vs-double tolerance. The Mobius WASM side also reads its coefficients
// at float32 precision.
const FLOAT_EPS = 5e-6;
const near = (a, b, eps = FLOAT_EPS) => Math.abs(a - b) <= eps;

/**
 * Asserts each named component of two vectors agrees within FLOAT_EPS.
 * @param {Record<string, number>} actual - Measured components.
 * @param {Record<string, number>} expected - Reference components.
 * @param {string[]} keys - Component names to compare.
 * @param {string} message - Failure message.
 */
const assertNear = (actual, expected, keys, message) =>
  assert.ok(keys.every((key) => near(actual[key], expected[key])), message);

/** Verifies the sRGB transfer function and its inverse match color.js. */
test('sRGB transfer parity (srgb_to_linear / linear_to_srgb)', () => {
  for (const s of [0, 0.01, 0.04045, 0.05, 0.2, 0.5, 0.8, 1]) {
    assert.ok(near(M.srgb_to_linear_float(s), C.srgbToLinearFloat(s)),
      `srgb_to_linear(${s})`);
  }
  for (const l of [0, 0.001, 0.003, 0.0031308, 0.01, 0.05, 0.2, 0.5, 0.8, 1]) {
    assert.ok(near(M.linear_to_srgb_float(l), C.linearToSrgbFloat(l)),
      `linear_to_srgb(${l})`);
  }
});

/**
 * Pins the engine's OKLab transform to fixed golden values in both directions.
 * The forward red golden is Ottosson's published reference (L≈0.628, a≈0.225,
 * b≈0.126).
 */
test('OKLab golden values (absolute pin)', () => {
  const fwd1 = M.linear_rgb_to_oklab(0.1, 0.5, 0.9);
  assertNear(fwd1, { L: 0.757296, a: -0.067583, b: -0.101862 }, ['L', 'a', 'b'],
    `oklab(0.1,0.5,0.9): (${fwd1.L},${fwd1.a},${fwd1.b})`);
  const fwdRed = M.linear_rgb_to_oklab(1, 0, 0);
  assertNear(fwdRed, { L: 0.627955, a: 0.224863, b: 0.125846 }, ['L', 'a', 'b'],
    `oklab(1,0,0) vs Ottosson red: (${fwdRed.L},${fwdRed.a},${fwdRed.b})`);
  const inv = M.oklab_to_linear_rgb(0.7, 0.1, -0.05);
  assertNear(inv, { r: 0.57893, g: 0.228833, b: 0.50137 }, ['r', 'g', 'b'],
    `oklab_to_linear_rgb(0.7,0.1,-0.05): (${inv.r},${inv.g},${inv.b})`);
});

/**
 * Verifies palette_wheel.js's OKLCh→linear-sRGB port matches the engine's
 * inverse OKLab transform. The port folds the polar-to-Cartesian step into the
 * same body as the matrix, so it is compared against the engine fed the same
 * (a, b). The sweep covers the wheel at three lightnesses and out to chroma 0.2,
 * including out-of-gamut samples.
 */
test('OKLCh transform parity (oklab_to_linear_rgb)', () => {
  for (const lightness of [0.15, 0.5, 0.85]) {
    for (const chroma of [0, 0.08, 0.2]) {
      for (let step = 0; step < 8; step++) {
        const turns = step / 8;
        const angle = turns * Math.PI * 2;
        const w = M.oklab_to_linear_rgb(
          lightness, chroma * Math.cos(angle), chroma * Math.sin(angle));
        const [r, g, b] = oklchLinearRgb(lightness, chroma, turns);
        assertNear(w, { r, g, b }, ['r', 'g', 'b'],
          `oklch(${lightness},${chroma},${turns}): `
          + `wasm(${w.r},${w.g},${w.b}) js(${r},${g},${b})`);
      }
    }
  }
});

test('widest sRGB gamut chroma tracks the engine boundary solver', () => {
  for (const lightness of [0, 0.01, 0.05, 0.15, 0.3, 0.5, 0.7, 0.85, 0.95, 0.99, 1]) {
    let maximum = 0;
    for (let hue = 0; hue < 360; hue++) {
      const angle = hue / 360 * Math.PI * 2;
      maximum = Math.max(maximum,
        M.gamut_max_chroma(lightness, Math.cos(angle), Math.sin(angle)));
    }
    // The engine refines a quantized LUT bracket; the wheel bisects a fixed interval.
    assert.ok(near(maxSrgbGamutChroma(lightness), maximum, 0.001),
      `gamut boundary at lightness ${lightness}: wheel=${maxSrgbGamutChroma(lightness)}, engine=${maximum}`);
  }
});

/**
 * Checks the engine's integer HSV conversion (hsv_to_rgb) against the defining
 * properties of HSV: the largest channel is the value, the smallest falls by
 * the saturation, the primaries sit on the sextant boundaries 0/86/172, and the
 * uint8_t hue wraps mod 256.
 */
test('HSV conversion keeps value, saturation, primaries and hue wrap (hsv_to_rgb)', () => {
  const channels = (h, s, v) => {
    const w = M.hsv_to_rgb(h, s, v);
    return [w.r, w.g, w.b];
  };
  for (let h = 0; h < 256; h += 5) {
    for (const s of [0, 1, 64, 128, 200, 255]) {
      for (const v of [0, 1, 50, 128, 200, 255]) {
        const rgb = channels(h, s, v);
        const label = `hsv_to_rgb(${h},${s},${v}) = ${rgb}`;
        assert.equal(Math.max(...rgb), v, label);
        assert.ok(Math.abs(Math.min(...rgb) - v * (255 - s) / 255) <= 1.5, label);
        assert.deepEqual(channels(h + 256, s, v), rgb, label);
        assert.deepEqual(channels(h - 256, s, v), rgb, label);
      }
    }
  }
  assert.deepEqual(channels(0, 255, 255), [255, 0, 0]);
  assert.deepEqual(channels(86, 255, 255), [0, 255, 0]);
  assert.deepEqual(channels(172, 255, 255), [0, 0, 255]);
});

/**
 * Verifies the ProceduralPalette cosine formula matches the engine. The engine's
 * get() clamps the cosine to sRGB then quantizes through the interpolated linear
 * LUT; the JS port computes the same clamped sRGB cosine, so feeding it through
 * the engine's srgb_to_linear_interp must land on the engine's 16-bit linear
 * value (within one 16-bit linear LSB from float-versus-double rounding).
 */
test('ProceduralPalette cosine parity (procedural_palette_linear)', () => {
  const a = [0.5, 0.5, 0.5], b = [0.5, 0.5, 0.5], c = [1, 1, 1], d = [0, 0.33, 0.67];
  const pal = new P.ProceduralPalette(a, b, c, d);
  for (const t of [0, 0.15, 0.25, 0.5, 0.75, 1]) {
    const w = M.procedural_palette_linear(
      a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], t);
    const wCh = [w.r, w.g, w.b];
    for (let ch = 0; ch < 3; ch++) {
      const srgb = Math.max(0, Math.min(1, pal.getChannelValues(t)[ch]));
      const jsLinear = M.srgb_to_linear_interp(srgb);
      // Within one 16-bit linear LSB for float-versus-double cosine rounding.
      assert.ok(Math.abs(jsLinear - wCh[ch]) <= 1,
        `palette t=${t} ch=${ch}: wasm=${wCh[ch]} js=${jsLinear}`);
    }
  }
});

/**
 * Checks procedural_palette_linear against the cosine formula
 * clamp(a + b cos(2π(c t + d)), 0, 1), evaluated in the test, for coefficient
 * sets that clamp at both ends, wrap the phase, flip the amplitude and run at
 * high frequency. The engine's 16-bit linear output must land within one 8-bit
 * sRGB code of the formula.
 */
test('ProceduralPalette follows the clamped cosine formula (procedural_palette_linear)', () => {
  const sets = {
    clampHigh: { a: [0.9, 0.8, 0.7], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.25, 0.5] },
    clampLow: { a: [0.1, 0.2, 0.3], b: [0.5, 0.5, 0.5], c: [1, 1, 1], d: [0, 0.25, 0.5] },
    phaseWrap: { a: [0.5, 0.5, 0.5], b: [0.4, 0.4, 0.4], c: [1, 1, 1], d: [1.3, -0.6, 2.75] },
    negativeB: { a: [0.5, 0.5, 0.5], b: [-0.45, -0.3, -0.15], c: [1, 2, 0.5], d: [0.1, 0.2, 0.3] },
    highFrequency: { a: [0.5, 0.5, 0.5], b: [0.5, 0.5, 0.5], c: [7.3, 11, 16], d: [0, 0.33, 0.67] },
  };
  const clamped = { low: 0, high: 0 };
  for (const [name, { a, b, c, d }] of Object.entries(sets)) {
    for (let i = 0; i <= 256; i++) {
      const t = i / 256;
      const w = M.procedural_palette_linear(
        a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d[0], d[1], d[2], t);
      [w.r, w.g, w.b].forEach((linear, ch) => {
        const raw = a[ch] + b[ch] * Math.cos(2 * Math.PI * (c[ch] * t + d[ch]));
        if (raw < 0) clamped.low++;
        if (raw > 1) clamped.high++;
        const expected = Math.min(1, Math.max(0, raw));
        const actual = C.linearToSrgbFloat(linear / 65535);
        assert.ok(Math.abs(actual - expected) * 255 <= 1,
          `${name} t=${t} ch=${ch}: engine ${actual} formula ${expected}`);
      });
    }
  }
  assert.ok(clamped.low > 0 && clamped.high > 0, 'the sets reach both clamps');
});

test('the exported named procedural palettes are uniquely named, labelled and render a gradient', () => {
  const palettes = M.named_procedural_palettes();
  assert.ok(palettes.length > 0);
  assert.equal(new Set(palettes.map(({ name }) => name)).size, palettes.length, 'repeated name');
  for (const { name, a, b, c, d } of palettes) {
    assert.match(name, /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/);
    assert.doesNotMatch(P.prettyPaletteName(name), /_/, name);
    for (const vec3 of [a, b, c, d]) {
      assert.ok(vec3.length === 3 && vec3.every(Number.isFinite), name);
    }
    const palette = new P.ProceduralPalette(a, b, c, d);
    const ramp = [];
    for (let i = 0; i <= 32; i++) ramp.push(palette.get(i / 32));
    const bad = ramp.flat().find((channel) => !(Number.isFinite(channel) && channel >= 0 && channel <= 1));
    assert.equal(bad, undefined, `${name} renders ${bad} outside [0, 1]`);
    const spans = [0, 1, 2].map((channel) => {
      const samples = ramp.map((rgb) => rgb[channel]);
      return Math.max(...samples) - Math.min(...samples);
    });
    assert.ok(Math.max(...spans) > 0.05, `${name} renders a flat ramp`);
  }
});

// Recipe-field ordinals the engine names when it refuses an enum value.
const PALETTE_V4_ENUM_FIELDS = Object.freeze({
  hueMode: 4, harmony: 5, direction: 6, curve: 14, chromaCurve: 21, chromaBasis: 22,
  colorPath: 3, domain: 1, easing: 2,
});

// Persisted spellings and ordinals: deep links and saved recipes store them.
const PALETTE_V4_ENUM_ROSTER = Object.freeze({
  hueMode: [['HARMONY', 0], ['SWEEP', 1], ['CUSTOM', 2]],
  harmony: [['MONOCHROMATIC', 0], ['ANALOGOUS', 1], ['ACCENTED_ANALOGOUS', 2],
    ['COMPLEMENTARY', 3], ['SPLIT_COMPLEMENTARY', 4], ['TRIADIC', 5], ['TETRADIC', 6],
    ['SQUARE', 7]],
  direction: [['SHORTEST', 0], ['CLOCKWISE', 1], ['COUNTERCLOCKWISE', 2]],
  curve: [['CONSTANT', 0], ['ASCENDING', 1], ['DESCENDING', 2], ['BELL', 3], ['CUP', 4],
    ['CUSTOM', 5]],
  chromaCurve: [['CONSTANT', 0], ['ASCENDING', 1], ['DESCENDING', 2], ['BELL', 3], ['CUP', 4],
    ['CUSTOM', 5]],
  chromaBasis: [['LOCAL_GAMUT', 0], ['PATH_MINIMUM', 1], ['ABSOLUTE', 2]],
  colorPath: [['OKLCH_ARC', 0], ['OKLAB_CARTESIAN', 1]],
  domain: [['STRAIGHT', 0], ['MIRROR', 1], ['VIGNETTE', 2], ['FALLOFF', 3], ['LOOP', 4]],
  easing: [['LINEAR', 0], ['COSINE', 1], ['SMOOTHSTEP', 2]],
});

test('Palette V4 enum spellings and ordinals match the public roster', () => {
  for (const [group, roster] of Object.entries(PALETTE_V4_ENUM_ROSTER)) {
    const enumGroup = group === 'chromaCurve' ? 'curve' : group;
    assert.deepEqual(Object.entries(PaletteV4[enumGroup]), roster, `${group} public roster`);
    assert.deepEqual(roster.map(([, ordinal]) => paletteEnumName(enumGroup, ordinal)),
      roster.map(([name]) => name), `${group} inverse roster`);
  }
});

const TURN = 2 * Math.PI;
const SPREAD_TURNS = 0.1;
const BASE_TURNS = 0.1;
const LIGHTNESS = { center: 0.5, range: 0.4, custom: [0.2, 0.75, 0.35, 0.65] };
const CHROMA = { center: 0.45, range: 0.3, custom: [0.15, 0.7, 0.3, 0.6] };
const SWEEP_TURNS = 0.6;
const CUSTOM_TURNS = [0.05, 0.3, 0.7, 0];
const ABSOLUTE_CHROMA = 0.08;
const HEADROOM = 0.94;
const FALLOFF_START = 0.85;

/**
 * The test-owned probe recipe: an analogous harmony over linear segments with
 * mid-gamut lightness and chroma axes, so each enum member's effect is
 * measurable in the inspected diagnostics.
 * @param {(recipe: Object) => void} edit - Sets the member under test.
 * @returns {Object} The recipe.
 */
function probeRecipe(edit) {
  const recipe = defaultPaletteRecipe();
  recipe.easing = PaletteV4.easing.LINEAR;
  Object.assign(recipe.hue, {
    baseTurns: BASE_TURNS, spreadTurns: SPREAD_TURNS, sweepTurns: SWEEP_TURNS,
    customTurns: [...CUSTOM_TURNS],
  });
  Object.assign(recipe.lightness, { ...LIGHTNESS, custom: [...LIGHTNESS.custom] });
  Object.assign(recipe.chroma, { ...CHROMA, custom: [...CHROMA.custom], headroom: HEADROOM });
  recipe.falloffStart = FALLOFF_START;
  edit(recipe);
  return recipe;
}

/**
 * Inspects a recipe and splits its per-entry diagnostics into columns.
 * @param {Object} ops - A PaletteOps handle.
 * @param {Object} recipe - The recipe to inspect.
 * @returns {Object} Status, LUT bytes and the L, C, q, Cmax and hue columns.
 */
function inspectColumns(ops, recipe) {
  const result = ops.inspectV4(recipe);
  if (result.status.code !== M.PaletteCompileCode.OK) return { status: result.status };
  const diagnostics = Array.from(result.diagnostics);
  const column = (k) => Array.from({ length: 256 }, (_, j) => diagnostics[j * 6 + k]);
  return {
    status: result.status, lut: Array.from(result.lut), fallback: Array.from(result.fallback),
    L: column(0), C: column(1), q: column(2), Cmax: column(3), hue: column(4),
  };
}

const within = (a, b, eps) => Math.abs(a - b) <= eps;
/** @param {number[]} values @param {number} t - Position in [0, 1]. @returns {number} The value at t. */
const sampleAt = (values, t) => {
  const x = t * 255;
  const lo = Math.floor(x), hi = Math.ceil(x);
  return values[lo] + (values[hi] - values[lo]) * (x - lo);
};
/** @param {number} radians @returns {number} The angle in turns, wrapped into [0, 1). */
const turnsOf = (radians) => ((radians / TURN) % 1 + 1) % 1;
/** @param {number} a @param {number} b @returns {number} Shortest distance between two turn values. */
const turnGap = (a, b) => Math.abs(((a - b) % 1 + 1.5) % 1 - 0.5);
/** @param {number[]} hue @returns {number} Net winding of a hue column, in turns. */
const winding = (hue) => hue.slice(1).reduce((sum, h, i) => {
  const step = ((h - hue[i]) % TURN + TURN * 1.5) % TURN - TURN / 2;
  return sum + step;
}, 0) / TURN;
const monotone = (values, sign) => values.slice(1).every((v, i) => sign * (v - values[i]) >= -1e-4);
const rgbAt = (lut, j) => lut.slice(j * 3, j * 3 + 3);

// Each member's defining property, checked on the probe recipe with only that
// enum changed. Harmony offsets are the key hues relative to the base, in turns.
const HARMONY_OFFSETS = {
  MONOCHROMATIC: [0, 0],
  ANALOGOUS: [-SPREAD_TURNS, 0, SPREAD_TURNS],
  ACCENTED_ANALOGOUS: [-SPREAD_TURNS, 0, SPREAD_TURNS, 0.5],
  COMPLEMENTARY: [0, 0.5],
  SPLIT_COMPLEMENTARY: [0, 0.5 - SPREAD_TURNS, 0.5 + SPREAD_TURNS],
  TRIADIC: [0, 1 / 3, 2 / 3],
  TETRADIC: [0, SPREAD_TURNS, 0.5, 0.5 + SPREAD_TURNS],
  SQUARE: [0, 0.25, 0.5, 0.75],
};
const keysAt = (offsets) => offsets.map((offset, i) => [i / (offsets.length - 1), offset]);
const assertKeyHues = (b, keys, base, label) => {
  for (const [t, turns] of keys) {
    assert.ok(turnGap(turnsOf(sampleAt(b.hue, t)), base + turns) < 0.005,
      `${label}: hue at ${t} is ${turnsOf(sampleAt(b.hue, t))}, expected ${(base + turns) % 1}`);
  }
};
const low = (axis) => axis.center - axis.range / 2;
const high = (axis) => axis.center + axis.range / 2;
const assertCurve = (values, axis, member, label) => {
  const at = (t) => sampleAt(values, t);
  const eps = 0.005;
  const shapes = {
    CONSTANT: () => values.every((v) => within(v, axis.center, eps)),
    ASCENDING: () => monotone(values, 1) && within(at(0), low(axis), eps) && within(at(1), high(axis), eps),
    DESCENDING: () => monotone(values, -1) && within(at(0), high(axis), eps) && within(at(1), low(axis), eps),
    BELL: () => within(at(0), low(axis), eps) && within(at(1), low(axis), eps)
      && within(at(0.5), high(axis), eps),
    CUP: () => within(at(0), high(axis), eps) && within(at(1), high(axis), eps)
      && within(at(0.5), low(axis), eps),
    CUSTOM: () => [0, 0.5, 1].every((t, i) => within(at(t), axis.custom[i], eps)),
  };
  assert.ok(shapes[member](), `${label}: ${[0, 0.25, 0.5, 0.75, 1].map(at)}`);
};
const easeOf = {
  LINEAR: (p) => p,
  COSINE: (p) => 0.5 - 0.5 * Math.cos(Math.PI * p),
  SMOOTHSTEP: (p) => p * p * (3 - 2 * p),
};

const PALETTE_V4_PROPERTIES = {
  hueMode: {
    HARMONY: (b) => assertKeyHues(b, keysAt(HARMONY_OFFSETS.ANALOGOUS), BASE_TURNS, 'HARMONY'),
    SWEEP: (b) => {
      assert.ok(within(sampleAt(b.hue, 1) - sampleAt(b.hue, 0), SWEEP_TURNS * TURN, 0.01));
      assertKeyHues(b, [[0, 0], [0.5, SWEEP_TURNS / 2], [1, SWEEP_TURNS]], BASE_TURNS, 'SWEEP');
    },
    CUSTOM: (b) => assertKeyHues(b, [[0, CUSTOM_TURNS[0]], [0.5, CUSTOM_TURNS[1]],
      [1, CUSTOM_TURNS[2]]], 0, 'CUSTOM'),
  },
  harmony: Object.fromEntries(Object.entries(HARMONY_OFFSETS).map(([name, offsets]) =>
    [name, (b) => assertKeyHues(b, keysAt(offsets), BASE_TURNS, name)])),
  direction: {
    SHORTEST: (b) => assert.ok(within(winding(b.hue), 0, 0.01), `winding ${winding(b.hue)}`),
    CLOCKWISE: (b) => assert.ok(within(winding(b.hue), -1, 0.01), `winding ${winding(b.hue)}`),
    COUNTERCLOCKWISE: (b) => assert.ok(within(winding(b.hue), 1, 0.01), `winding ${winding(b.hue)}`),
  },
  curve: Object.fromEntries(Object.keys(PaletteV4.curve).map((member) =>
    [member, (b) => assertCurve(b.L, LIGHTNESS, member, `lightness ${member}`)])),
  chromaCurve: Object.fromEntries(Object.keys(PaletteV4.curve).map((member) =>
    [member, (b) => {
      assertCurve(b.q, CHROMA, member, `chroma ${member}`);
      assert.ok(b.C.every((c, j) => c <= b.Cmax[j] + 1e-6), `chroma ${member} leaves the gamut`);
    }])),
  chromaBasis: {
    LOCAL_GAMUT: (b) => assert.ok(b.C.every((c, j) =>
      within(c, Math.min(b.q[j], HEADROOM) * b.Cmax[j], 1e-3)), 'chroma is relative to the local gamut'),
    PATH_MINIMUM: null,
    ABSOLUTE: (b) => assert.ok(b.C.every((c, j) => b.fallback[j] !== 0 || within(c, ABSOLUTE_CHROMA, 1e-3)),
      'chroma is the absolute OKLCh chroma'),
  },
  colorPath: {
    OKLCH_ARC: (b) => assert.ok(b.C.every((c) => within(c, ABSOLUTE_CHROMA, 1e-3)),
      'an arc keeps chroma between complementary keys'),
    OKLAB_CARTESIAN: (b) => assert.ok(Math.min(...b.C) < ABSOLUTE_CHROMA / 10,
      'a straight Lab segment passes near grey between complementary keys'),
  },
  domain: {
    STRAIGHT: (b) => assert.ok(within(winding(b.hue), 2 * SPREAD_TURNS, 0.01),
      'hue runs across the keys once'),
    MIRROR: (b) => {
      for (let j = 0; j < 128; j++) assert.deepEqual(rgbAt(b.lut, j), rgbAt(b.lut, 255 - j), `entry ${j}`);
    },
    VIGNETTE: (b) => {
      assert.deepEqual([rgbAt(b.lut, 0), rgbAt(b.lut, 255)], [[0, 0, 0], [0, 0, 0]]);
      assert.ok(Math.max(...rgbAt(b.lut, 128)) > 0);
    },
    FALLOFF: (b) => {
      const start = Math.ceil(FALLOFF_START * 255);
      for (let j = start; j < 256; j++) assert.deepEqual(rgbAt(b.lut, j), [0, 0, 0], `entry ${j}`);
      assert.ok(Math.max(...rgbAt(b.lut, Math.floor(255 * 2 / 3))) > 0);
    },
    LOOP: (b) => {
      assert.deepEqual(rgbAt(b.lut, 255), rgbAt(b.lut, 0), 'the loop closes on its first color');
      assert.ok(turnGap(turnsOf(b.hue[255]), turnsOf(b.hue[0])) < 0.005);
    },
  },
  easing: Object.fromEntries(Object.entries(easeOf).map(([member, ease]) => [member, (b) => {
    const [first, middle] = [sampleAt(b.hue, 0), sampleAt(b.hue, 0.5)];
    for (const j of [16, 32, 64, 96]) {
      const expected = first + (middle - first) * ease((j / 255) / 0.5);
      assert.ok(within(b.hue[j], expected, 0.002), `${member} entry ${j}: ${b.hue[j]} vs ${expected}`);
    }
  }])),
};

const PROBE_SETUP = {
  direction: (recipe) => { recipe.domain = PaletteV4.domain.LOOP; },
  chromaBasis: (recipe) => {
    Object.assign(recipe.chroma, { center: ABSOLUTE_CHROMA, range: 0 });
  },
  colorPath: (recipe) => {
    recipe.hue.harmony = PaletteV4.harmony.COMPLEMENTARY;
    Object.assign(recipe.chroma, { basis: PaletteV4.chromaBasis.ABSOLUTE, center: ABSOLUTE_CHROMA, range: 0 });
  },
};

function setPaletteEnum(recipe, group, ordinal) {
  if (group === 'hueMode') recipe.hue.mode = ordinal;
  else if (group === 'harmony') recipe.hue.harmony = ordinal;
  else if (group === 'direction') recipe.hue.direction = ordinal;
  else if (group === 'curve') recipe.lightness.curve = ordinal;
  else if (group === 'chromaCurve') recipe.chroma.curve = ordinal;
  else if (group === 'chromaBasis') recipe.chroma.basis = ordinal;
  else recipe[group] = ordinal;
}

test('each Palette V4 enum member bakes its defining property in the shipped engine', () => {
  const ops = new M.PaletteOps();
  try {
    for (const [group, roster] of Object.entries(PALETTE_V4_ENUM_ROSTER)) {
      const luts = [];
      for (const [name, ordinal] of roster) {
        const baked = inspectColumns(ops, probeRecipe((recipe) => {
          PROBE_SETUP[group]?.(recipe);
          setPaletteEnum(recipe, group, ordinal);
        }));
        const property = PALETTE_V4_PROPERTIES[group][name];
        if (property === null) {
          assert.deepEqual([baked.status.code, baked.status.field.value],
            [M.PaletteCompileCode.INVALID_ENUM, PALETTE_V4_ENUM_FIELDS[group]],
            `${group} ${name} is a reserved ordinal the engine refuses`);
          continue;
        }
        assert.equal(baked.status.code, M.PaletteCompileCode.OK, `${group} ${name}`);
        property(baked);
        luts.push(baked.lut.join());
      }
      assert.equal(new Set(luts).size, luts.length, `${group} members bake distinctly`);

      const rejected = ops.inspectV4(probeRecipe((recipe) => setPaletteEnum(recipe, group, roster.length)));
      assert.deepEqual([rejected.status.code, rejected.status.field.value],
        [M.PaletteCompileCode.INVALID_ENUM, PALETTE_V4_ENUM_FIELDS[group]], `${group} engine roster length`);
    }
  } finally {
    ops.delete();
  }
});


test('every effect-owned GenerativePalette recipe the engine exports compiles and is unique', () => {
  const ops = new M.PaletteOps();
  try {
    const presets = Array.from(ops.effectPresetsV4());
    assert.ok(presets.length > 0);
    assert.equal(new Set(presets.map((preset) => preset.name)).size, presets.length, 'repeated name');
    assert.equal(new Set(presets.map((preset) => JSON.stringify(preset.recipe))).size, presets.length,
      'repeated recipe');
    for (const preset of presets) {
      assert.equal(typeof preset.randomHue, 'boolean', preset.name);
      assert.equal(preset.recipe.schemaVersion, 4, preset.name);
      assert.equal(ops.inspectV4(preset.recipe).status.code, M.PaletteCompileCode.OK, preset.name);
    }
  } finally {
    ops.delete();
  }
});

test('palettes.html recipe sliders compile at both ends of their ranges', () => {
  const html = readFileSync(new URL('../tools/palettes.html', import.meta.url), 'utf8');
  /** @param {string} id @returns {number[]} The slider's declared min and max. */
  const range = (id) => {
    const m = new RegExp(`<input type="range" id="${id}" min="([^"]+)" max="([^"]+)"`).exec(html);
    assert.ok(m, `palettes.html has no ${id} range slider`);
    return [Number(m[1]), Number(m[2])];
  };
  const ops = new M.PaletteOps();
  try {
    for (const [id, set] of [
      ['gen_sweep', (recipe, v) => { recipe.hue.mode = PaletteV4.hueMode.SWEEP; recipe.hue.sweepTurns = v; }],
      ['gen_torsion', (recipe, v) => { recipe.hueTorsion = v; }],
      ['gen_falloff', (recipe, v) => { recipe.domain = PaletteV4.domain.FALLOFF; recipe.falloffStart = v; }],
    ]) {
      for (const v of range(id)) {
        const recipe = defaultPaletteRecipe();
        set(recipe, v);
        const { status } = ops.inspectV4(recipe);
        assert.equal(status.code, M.PaletteCompileCode.OK, `${id} = ${v}`);
        assert.equal(status.clampedFields, 0, `${id} = ${v}`);
      }
    }
  } finally {
    ops.delete();
  }
});

test('PaletteOps compiles deterministic V4 recipe LUTs', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  let baked;
  try {
    const first = ops.compileAndBakeV4(recipe);
    baked = Uint8Array.from(first.lut);
    const second = ops.compileAndBakeV4(recipe);
    assert.equal(first.status.code, M.PaletteCompileCode.OK);
    assert.equal(first.canonicalRecipe.schemaVersion, 4);
    assert.equal('keyCount' in first.canonicalRecipe, false);
    assert.equal(first.lut.length, 256 * 3);
    assert.deepEqual(Uint8Array.from(second.lut), baked);
  } finally {
    ops.delete();
  }
  const fresh = new M.PaletteOps();
  try {
    assert.deepEqual(Uint8Array.from(fresh.compileAndBakeV4(recipe).lut), baked);
  } finally {
    fresh.delete();
  }
});

test('a zoom ending at the right edge needs no input span adjustment', () => {
  const ops = new M.PaletteOps();
  try {
    const recipe = defaultPaletteRecipe();
    recipe.input = zoomRecipeWindow(recipe.input, 0.8, 1);
    const { status } = ops.compileAndBakeV4(recipe);
    assert.equal(status.code, M.PaletteCompileCode.OK);
    assert.equal(status.clampedFields, 0);
  } finally {
    ops.delete();
  }
});

test('dragging the first custom key across the seam needs no engine canonicalization', () => {
  const ops = new M.PaletteOps();
  try {
    const model = new PaletteRecipeModel();
    model.applyHueModeTransition('CUSTOM');
    model.setBaseHue(0.98);
    model.moveHueKey(0, 0.02);
    const { status } = ops.compileAndBakeV4(model.recipe());
    assert.equal(status.code, M.PaletteCompileCode.OK);
    assert.equal(status.canonicalizedFields, 0);
  } finally {
    ops.delete();
  }
});

test('PaletteOps enforces exact mirror and loop seams', () => {
  const ops = new M.PaletteOps();
  try {
    const mirror = defaultPaletteRecipe();
    mirror.domain = PaletteV4.domain.MIRROR;
    const mirrorBake = ops.compileAndBakeV4(mirror);
    assert.equal(mirrorBake.status.code, M.PaletteCompileCode.OK);
    const mirrored = Uint8Array.from(mirrorBake.lut);
    assert.notDeepEqual(Array.from(mirrored.slice(0, 3)), Array.from(mirrored.slice(127 * 3, 128 * 3)),
      'the mirrored palette rises before it returns');
    for (let index = 0; index < 128; index += 1) {
      assert.deepEqual(
        Array.from(mirrored.slice(index * 3, index * 3 + 3)),
        Array.from(mirrored.slice((255 - index) * 3, (256 - index) * 3)));
    }

    const loop = defaultPaletteRecipe();
    loop.domain = PaletteV4.domain.LOOP;
    loop.hue.mode = PaletteV4.hueMode.SWEEP;
    const loopBake = ops.compileAndBakeV4(loop);
    assert.equal(loopBake.status.code, M.PaletteCompileCode.OK);
    const looped = Uint8Array.from(loopBake.lut);
    assert.notDeepEqual(Array.from(looped.slice(384, 387)), Array.from(looped.slice(0, 3)),
      'the looped palette varies between its seams');
    assert.deepEqual(Array.from(looped.slice(765)), Array.from(looped.slice(0, 3)));
  } finally {
    ops.delete();
  }
});

test('GenerativePalette removes the saturated-blue gamut seam', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  recipe.hue.mode = PaletteV4.hueMode.SWEEP;
  recipe.hue.baseTurns = 98 / 256;
  recipe.chroma.center = 1;
  recipe.chroma.headroom = 1;
  recipe.lightness.curve = PaletteV4.curve.ASCENDING;
  recipe.lightness.center = 0.495;
  recipe.lightness.range = 0.41;

  try {
    const result = ops.inspectV4(recipe);
    const lut = Uint8Array.from(result.lut);
    let largestChannelStep = 0;
    for (let index = 75; index <= 95; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        largestChannelStep = Math.max(largestChannelStep,
          Math.abs(lut[index * 3 + channel] - lut[(index - 1) * 3 + channel]));
      }
    }
    assert.ok(largestChannelStep < 21,
      `saturated-blue region contains a ${largestChannelStep}-level channel seam`);
    assert.ok(Array.from(result.fallback).every((mapped) => mapped === 0));
  } finally {
    ops.delete();
  }
});

test('Complementary harmony progresses once from the seed to its opposite', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  recipe.hue.harmony = PaletteV4.harmony.COMPLEMENTARY;
  recipe.hue.baseTurns = 200 / 256;

  try {
    const result = ops.inspectV4(recipe);
    const diagnostics = result.diagnostics;
    const firstHue = diagnostics[4];
    const quarterHue = diagnostics[64 * 6 + 4];
    const middleHue = 0.5 * (diagnostics[127 * 6 + 4] +
      diagnostics[128 * 6 + 4]);
    const threeQuarterHue = diagnostics[191 * 6 + 4];
    const lastHue = diagnostics[255 * 6 + 4];
    assert.ok(quarterHue > firstHue + 0.35 && quarterHue < firstHue + 0.65);
    assert.ok(Math.abs(middleHue - firstHue - Math.PI / 2) < 0.03);
    assert.ok(threeQuarterHue > firstHue + 2.45 &&
      threeQuarterHue < firstHue + 2.8);
    assert.ok(Math.abs(lastHue - firstHue - Math.PI) < 0.02);
    assert.ok(result.lut[2] > result.lut[0] && result.lut[2] > result.lut[1]);
    assert.ok(result.lut[765] > result.lut[767]);
    assert.ok(result.lut[766] > result.lut[767]);
  } finally {
    ops.delete();
  }
});

test('hue control keys match the engine palette path', () => {
  const ops = new M.PaletteOps();
  const hueAt = (diagnostics, position) => {
    const scaled = position * 255;
    const left = Math.floor(scaled);
    const right = Math.ceil(scaled);
    const mix = scaled - left;
    return diagnostics[left * 6 + 4] * (1 - mix) +
      diagnostics[right * 6 + 4] * mix;
  };
  const assertRecipe = (recipe, name) => {
    const state = hueKeyState(recipe);
    const diagnostics = ops.inspectV4(recipe).diagnostics;
    const divisor = recipe.domain === PaletteV4.domain.LOOP
      ? state.offsets.length : state.offsets.length - 1;
    state.offsets.forEach((offset, index) => {
      const expected = (state.baseTurns + offset) * Math.PI * 2;
      const actual = hueAt(diagnostics, index / divisor);
      const delta = actual - expected;
      assert.ok(Math.abs(delta - Math.round(delta / (Math.PI * 2)) * Math.PI * 2) < 0.005,
        `${name} key ${index}: engine=${actual} ` +
        `tool=${expected}`);
    });
  };

  try {
    for (const harmony of Object.values(PaletteV4.harmony)) {
      for (const direction of Object.values(PaletteV4.direction)) {
        const recipe = defaultPaletteRecipe();
        recipe.hue.harmony = harmony;
        recipe.hue.direction = direction;
        recipe.domain = PaletteV4.domain.STRAIGHT;
        recipe.easing = PaletteV4.easing.LINEAR;
        assertRecipe(recipe, `harmony=${harmony} direction=${direction}`);
      }
    }
    for (const domain of [PaletteV4.domain.STRAIGHT, PaletteV4.domain.LOOP]) {
      const recipe = defaultPaletteRecipe();
      recipe.hue.mode = PaletteV4.hueMode.SWEEP;
      recipe.domain = domain;
      recipe.easing = PaletteV4.easing.LINEAR;
      assertRecipe(recipe, `sweep domain=${domain}`);
    }
  } finally {
    ops.delete();
  }
});

test('recipe window crops every axis before the domain is applied', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  recipe.hue.harmony = PaletteV4.harmony.TRIADIC;
  recipe.input = { offset: 0.2, span: 0.4 };
  recipe.lightness.curve = PaletteV4.curve.ASCENDING;
  recipe.lightness.center = 0.5;
  recipe.lightness.range = 0.6;

  try {
    const result = ops.inspectV4(recipe);
    const diagnostics = Array.from(result.diagnostics);
    assert.ok(Math.abs(diagnostics[0] - 0.32) < 1e-5);
    assert.ok(Math.abs(diagnostics[255 * 6] - 0.56) < 1e-5);

    const full = structuredClone(recipe);
    full.input = { offset: 0, span: 1 };
    full.lightness.curve = PaletteV4.curve.CONSTANT;
    const fullDiagnostics = Array.from(ops.inspectV4(full).diagnostics);
    assert.ok(Math.abs(diagnostics[4] - fullDiagnostics[51 * 6 + 4]) < 0.03);
    assert.ok(Math.abs(diagnostics[255 * 6 + 4] -
      fullDiagnostics[153 * 6 + 4]) < 0.03);
  } finally {
    ops.delete();
  }
});

test('browser GenerativePalette owns the real bridge result', () => {
  const ops = new M.PaletteOps();
  P.setPaletteOps(ops, M);
  try {
    const recipe = defaultPaletteRecipe();
    recipe.hue.baseTurns = 0.37;
    const direct = ops.compileAndBakeV4(recipe);
    const baked = Uint8Array.from(direct.lut);
    const palette = new P.GenerativePalette(recipe);
    assert.deepEqual(palette.lut, baked);
    assert.deepEqual(palette.canonicalRecipe, direct.canonicalRecipe);
    recipe.hue.baseTurns = 0.7;
    const changed = ops.compileAndBakeV4(recipe);
    assert.notDeepEqual(Uint8Array.from(changed.lut), palette.lut);
    assert.deepEqual(palette.lut, baked);
  } finally {
    P.setPaletteOps(null);
    ops.delete();
  }
});

test('PATH_MINIMUM is rejected until its certified solver is available', () => {
  const ops = new M.PaletteOps();
  const recipe = defaultPaletteRecipe();
  recipe.chroma.basis = PaletteV4.chromaBasis.PATH_MINIMUM;
  try {
    const result = ops.compileAndBakeV4(recipe);
    assert.notEqual(result.status.code, M.PaletteCompileCode.OK);
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
    assertNear(w, j, ['x', 'y', 'z'],
      `lissajous(${m1},${m2},${a},${t}): wasm(${w.x},${w.y},${w.z}) js(${j.x},${j.y},${j.z})`);
  }
});

/**
 * Pins the lissajous curve to fixed golden points, each on the unit sphere.
 */
test('lissajous golden points (absolute pin)', () => {
  for (const [args, expected] of LISSAJOUS_GOLDENS) {
    const p = M.lissajous(...args);
    assertNear(p, expected, ['x', 'y', 'z'], `lissajous(${args}): (${p.x},${p.y},${p.z})`);
    assert.ok(near(Math.hypot(p.x, p.y, p.z), 1),
      `lissajous point off the unit sphere: (${p.x},${p.y},${p.z})`);
  }
});

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
 * f(z) = (Az + B) / (Cz + D), unproject. Runs the tool's JS stereo and
 * projectDiv with the engine's point-at-infinity conventions; GLSL has its own port.
 * @param {number[]} p - Unit sphere point as [x, y, z].
 * @param {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} coeffs - The Mobius coefficients.
 * @returns {{x:number, y:number, z:number}} The transformed sphere point.
 */
function mobiusSphereJs([x, y, z], { A, B, C, D }) {
  const w = MB.stereo({ x, y, z });
  return invStereo(MB.projectDiv(MB.cadd(MB.cmult(A, w), B), MB.cadd(MB.cmult(C, w), D)));
}

/**
 * Splits mobiusCodeString's C++ initializer back into its eight floats, so the
 * WASM call is fed in exactly the order the generated MobiusParams literal uses.
 * Each literal reads back as the same float32 as the coefficient it came from,
 * so float precision is the only difference between the two sides of the
 * comparison.
 * @param {{A:{re:number,im:number}, B:{re:number,im:number}, C:{re:number,im:number}, D:{re:number,im:number}}} coeffs - The Mobius coefficients.
 * @returns {number[]} The eight floats, in emission order.
 */
function mobiusArgs({ A, B, C, D }) {
  const body = MB.mobiusCodeString(A, B, C, D).replace(/^math::MobiusParams\{|\}$/g, '');
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
      assertNear(w, j, ['x', 'y', 'z'],
        `${name}(t=${t}) at (${p}): wasm(${w.x},${w.y},${w.z}) js(${j.x},${j.y},${j.z})`);
      assert.ok(near(Math.hypot(w.x, w.y, w.z), 1),
        `${name}(t=${t}) at (${p}) left the unit sphere`);
    }
  }
});

/**
 * Pins the Mobius map to analytically derived images. Identity fixes every
 * point; f(z) = 1/z is a 180°
 * rotation about x under this stereographic convention.
 */
test('mobius golden images (absolute pin)', () => {
  for (const [x, y, z] of MOBIUS_POINTS) {
    const id = M.mobius_transform(x, y, z, 1, 0, 0, 0, 0, 0, 1, 0);
    assertNear(id, { x, y, z }, ['x', 'y', 'z'],
      `identity moved (${x},${y},${z}) to (${id.x},${id.y},${id.z})`);
    const inv = M.mobius_transform(x, y, z, 0, 0, 1, 0, 1, 0, 0, 0);
    assertNear(inv, { x, y: -y, z: -z }, ['x', 'y', 'z'],
      `1/z mapped (${x},${y},${z}) to (${inv.x},${inv.y},${inv.z}), want (${x},${-y},${-z})`);
  }
});

test('every named procedural palette evaluates within one linear LSB', () => {
  for (const { name, a, b, c, d } of M.named_procedural_palettes()) {
    const palette = new P.ProceduralPalette(a, b, c, d);
    for (const t of [-1, 0, 0.25, 0.5, 0.75, 1, 2]) {
      const color = M.procedural_palette_linear(...a, ...b, ...c, ...d, t);
      for (const [channel, expected] of [color.r, color.g, color.b].entries()) {
        const srgb = Math.max(0, Math.min(1, palette.getChannelValues(t)[channel]));
        assert.ok(Math.abs(M.srgb_to_linear_interp(srgb) - expected) <= 1,
          `${name} t=${t} channel=${channel}`);
      }
    }
  }
});
