import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  ProceduralPalette, seededRandInt, GenerativePalette,
  mapValue, waveGraphBand, WAVE_GRAPH_VALUE_RANGE,
  proceduralPaletteCpp, generativePaletteCpp, setPaletteOps,
  NAMED_PROCEDURAL_PALETTES, proceduralPaletteParams, zoomedProceduralParams,
} = await import('../tools/palette_math.js');

// Mock bakeLut (smooth in-range sRGB ramp) records its last args so the
// delegation (shape enum int + nine [0,255] HSV values) can be asserted.
let lastBakeArgs = null;
function mockBakeLut(...args) {
  lastBakeArgs = args;
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    lut[3 * i] = i;
    lut[3 * i + 1] = 255 - i;
    lut[3 * i + 2] = 128;
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

/**
 * Verifies ProceduralPalette.get clamps and linearizes the cosine output, and
 * that getChannelValue exposes the raw cosine. t=0 and t=0.5 land on the sRGB
 * transfer's fixpoints, where it is the identity; t=0.25 samples the mid-range,
 * where dropping the linearization changes the result.
 */
test('ProceduralPalette.get at t=0, t=0.25 and t=0.5 for a known coefficient set', () => {
  const p = new ProceduralPalette([0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0]);

  const at0 = p.get(0);
  for (const ch of at0) assert.ok(Math.abs(ch - srgbToLinear(1.0)) < NEAR);
  assert.ok(Math.abs(at0[0] - 1.0) < NEAR);

  const at05 = p.get(0.5);
  for (const ch of at05) assert.ok(Math.abs(ch - srgbToLinear(0.0)) < NEAR);
  assert.ok(Math.abs(at05[0] - 0.0) < NEAR);

  const at025 = p.get(0.25);
  for (let ch = 0; ch < 3; ch++) {
    assert.ok(Math.abs(at025[ch] - srgbToLinear(p.getChannelValue(0.25, ch))) < NEAR,
      `channel ${ch} linearized at t=0.25: ${at025[ch]}`);
  }
  assert.ok(Math.abs(p.getChannelValue(0.25, 0) - 0.5) < NEAR, 'raw cosine at t=0.25');
  assert.ok(Math.abs(at025[0] - 0.21404114) < NEAR, `linear at t=0.25: ${at025[0]}`);

  assert.ok(Math.abs(p.getChannelValue(0, 0) - 1.0) < NEAR);
  assert.ok(Math.abs(p.getChannelValue(0.5, 0) - 0.0) < NEAR);
});

/** Verifies the named-palette table is a non-empty set of uniquely named {name, a,b,c,d} vec3 entries. */
test('NAMED_PROCEDURAL_PALETTES is a well-formed table of coefficient vec3s', () => {
  assert.ok(Array.isArray(NAMED_PROCEDURAL_PALETTES) && NAMED_PROCEDURAL_PALETTES.length > 0);
  const names = new Set();
  for (const entry of NAMED_PROCEDURAL_PALETTES) {
    assert.equal(typeof entry.name, 'string');
    assert.ok(entry.name.length > 0);
    assert.ok(!names.has(entry.name), `duplicate palette name ${entry.name}`);
    names.add(entry.name);
    for (const key of ['a', 'b', 'c', 'd']) {
      assert.ok(Array.isArray(entry[key]) && entry[key].length === 3, `${entry.name}.${key} is a vec3`);
      for (const ch of entry[key]) assert.ok(Number.isFinite(ch), `${entry.name}.${key} channel finite`);
    }
  }
  assert.ok(names.has('DARK_RAINBOW'));
});

/** Verifies the mirror carries the engine's whole named-palette roster, in core/color/palettes.h declaration order. */
test('NAMED_PROCEDURAL_PALETTES mirrors the engine roster', () => {
  assert.deepEqual(NAMED_PROCEDURAL_PALETTES.map(entry => entry.name), [
    'DARK_RAINBOW', 'BLOOD_STREAM', 'VINTAGE_SUNSET', 'RICH_SUNSET', 'UNDERSEA',
    'LATE_SUNSET', 'MANGO_PEEL', 'ICE_MELT', 'LEMON_LIME', 'ALGAE', 'EMBERS',
    'FIRE_GLOW', 'DARK_PRIMARY', 'MAUVE_FADE', 'LAVENDER_LAKE', 'DESERT_ROSE',
    'BRUISED_MOSS', 'BRUISED_BANANA', 'BRIGHT_SUNRISE', 'FIRE_AND_ICE',
    'PEACH_POP', 'POPPED_PEACH', 'BLUE_LAGOON', 'ORANGE_CRUSH', 'PLUM_SUNRISE',
  ]);
});

/** Verifies every named palette, including the negative-frequency entries, renders finite in-range linear color across the domain. */
test('NAMED_PROCEDURAL_PALETTES all render across the domain', () => {
  for (const entry of NAMED_PROCEDURAL_PALETTES) {
    const pal = new ProceduralPalette(entry.a, entry.b, entry.c, entry.d);
    for (let i = 0; i <= 32; i++) {
      for (const ch of pal.get(i / 32)) {
        assert.ok(Number.isFinite(ch) && ch >= 0 && ch <= 1, `${entry.name} at t=${i / 32}: ${ch}`);
      }
    }
  }
});

/**
 * Verifies the cosine's range reduction handles negative frequencies: POPPED_PEACH
 * is PEACH_POP with C negated and D advanced by C, i.e. the same sweep reversed,
 * so it must equal PEACH_POP sampled at 1 - t.
 */
test('ProceduralPalette negative frequency reverses the positive-frequency twin', () => {
  const byName = (name) => NAMED_PROCEDURAL_PALETTES.find(entry => entry.name === name);
  const forward = byName('PEACH_POP');
  const reverse = byName('POPPED_PEACH');
  const fwd = new ProceduralPalette(forward.a, forward.b, forward.c, forward.d);
  const rev = new ProceduralPalette(reverse.a, reverse.b, reverse.c, reverse.d);
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const a = rev.get(t);
    const b = fwd.get(1 - t);
    for (let ch = 0; ch < 3; ch++) {
      assert.ok(Math.abs(a[ch] - b[ch]) < NEAR, `channel ${ch} at t=${t}: ${a[ch]} vs ${b[ch]}`);
    }
  }
});

/** Verifies proceduralPaletteParams flattens a/b/c/d vec3s into the 12-key parameters object in channel order. */
test('proceduralPaletteParams flattens a coefficient set into A_R..D_B', () => {
  const params = proceduralPaletteParams({
    a: [0.1, 0.2, 0.3], b: [0.4, 0.5, 0.6], c: [1.1, 1.2, 1.3], d: [0.7, 0.8, 0.9],
  });
  assert.deepEqual(params, {
    A_R: 0.1, A_G: 0.2, A_B: 0.3,
    B_R: 0.4, B_G: 0.5, B_B: 0.6,
    C_R: 1.1, C_G: 1.2, C_B: 1.3,
    D_R: 0.7, D_G: 0.8, D_B: 0.9,
  });
});

/**
 * Pins seededRandInt to the values GenerativePalette::seeded_rand_int
 * (core/color/color.h) produces for the same arguments. The expected column was
 * evaluated independently from the C++ source — hash01's 32-bit unsigned mix
 * (core/math/3dmath.h), then the single-precision `min + int(u * (max - min))`
 * scale — so a JS mirror that drifts from the header fails here, and the
 * exported palette no longer matches the preview.
 */
test('seededRandInt reproduces the engine draws for known (seed, site, range)', () => {
  const cases = [
    [0, 0, -7, 8, -7],
    [0, 1, 0, 2, 0],
    [0, 4, 153, 204, 183],
    [10, 0, -7, 8, -1],
    [10, 2, 11, 22, 12],
    [10, 3, 11, 22, 21],
    [128, 7, 25, 76, 26],
    [128, 8, 127, 178, 149],
    [128, 9, 204, 256, 248],
    [200, 4, 153, 204, 170],
    [200, 5, 153, 204, 165],
    [200, 6, 153, 204, 202],
    [255, 7, 178, 256, 213],
    [255, 8, 51, 127, 75],
  ];
  for (const [seed, site, min, max, expected] of cases) {
    assert.equal(seededRandInt(seed, site, min, max), expected,
      `seededRandInt(${seed}, ${site}, ${min}, ${max})`);
  }
});

/**
 * Verifies seededRandInt's range contract over every hue the tool can pass and
 * every site the palette draws from: an integer in [min, max), and min for an
 * empty range (the C++ guard against max <= min).
 */
test('seededRandInt stays in [min, max) for every seed and site', () => {
  for (let seed = 0; seed < 256; seed++) {
    for (let site = 0; site < 10; site++) {
      const v = seededRandInt(seed, site, 153, 204);
      assert.ok(Number.isInteger(v) && v >= 153 && v < 204, `seed ${seed} site ${site}`);
    }
  }
  assert.equal(seededRandInt(7, 0, 42, 42), 42);
  assert.equal(seededRandInt(7, 0, 42, 10), 42);
});

/** Verifies mapValue linearly remaps a value from one numeric range to another. */
test('mapValue computes the expected interpolations', () => {
  assert.equal(mapValue(0.5, 0, 1, 0, 100), 50);
  assert.equal(mapValue(2, 0, 4, 10, 20), 15);
});

/** Verifies the wave graph's band sits at 10%/90% of the canvas height with the range's ends at its edges. */
test('waveGraphBand puts the value range on the 10%-90% band, value up', () => {
  const { yTop, yBottom, toY } = waveGraphBand(300);
  assert.equal(yTop, 30);
  assert.equal(yBottom, 270);
  assert.equal(toY(WAVE_GRAPH_VALUE_RANGE.max), yTop);
  assert.equal(toY(WAVE_GRAPH_VALUE_RANGE.min), yBottom);
  // Canvas y grows downward, so a larger value maps higher up the canvas.
  assert.ok(toY(1) < toY(0));
});

/** Verifies the plotted range brackets the [0, 1] output range, so clamped excursions stay on-canvas. */
test('waveGraphBand plots the clamped [0, 1] output range strictly inside the band', () => {
  const { yTop, yBottom, toY } = waveGraphBand(300);
  assert.ok(WAVE_GRAPH_VALUE_RANGE.min < 0 && WAVE_GRAPH_VALUE_RANGE.max > 1);
  assert.equal(toY(0.5), 150); // the band's midpoint, matching the graph's centre line
  for (const value of [0, 1]) {
    assert.ok(toY(value) > yTop && toY(value) < yBottom);
  }
});

/** Verifies the mapping scales with the canvas, so a resized graph stays proportional. */
test('waveGraphBand scales with the canvas height', () => {
  assert.equal(waveGraphBand(600).toY(0.5), 300);
  assert.equal(waveGraphBand(0).toY(0.5), 0);
});

/** Verifies proceduralPaletteCpp emits the ProceduralPalette initializer with f-suffixed floats and per-vector comments. */
test('proceduralPaletteCpp emits a valid C++ initializer', () => {
  const params = {
    A_R: 0.5, A_G: 0.5, A_B: 0.5,
    B_R: 0.5, B_G: 0.5, B_B: 0.5,
    C_R: 1.0, C_G: 1.0, C_B: 1.0,
    D_R: 0.0, D_G: 0.33, D_B: 0.67,
  };
  const s = proceduralPaletteCpp(params);
  assert.ok(s.includes('ProceduralPalette palette('));
  assert.ok(s.includes('f}'));
  assert.ok(s.includes('// A'));
  assert.ok(s.includes('// B'));
  assert.ok(s.includes('// C'));
  assert.ok(s.includes('// D'));
  assert.ok(s.includes('{0.5f, 0.5f, 0.5f}'));
});

/** Verifies generativePaletteCpp emits the GenerativePalette block with the chosen enum tokens and base hue. */
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
  assert.ok(!s.includes('//'), 'no caveat comment: the pinned hue reproduces the preview');
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

/** Verifies generativePaletteCpp rejects a hueValue that would paste invalid C++. */
test('generativePaletteCpp rejects an out-of-range or non-integer hue', () => {
  const ok = { shape: 'STRAIGHT', harmony: 'TRIADIC', brightness: 'FLAT', sat: 'MID', hueValue: 0 };
  assert.throws(() => generativePaletteCpp({ ...ok, hueValue: NaN }), /hueValue/);
  assert.throws(() => generativePaletteCpp({ ...ok, hueValue: 256 }), /hueValue/);
  assert.throws(() => generativePaletteCpp({ ...ok, hueValue: -1 }), /hueValue/);
  assert.throws(() => generativePaletteCpp({ ...ok, hueValue: 1.5 }), /hueValue/);
  assert.doesNotThrow(() => generativePaletteCpp({ ...ok, hueValue: 255 }));
});

/** Verifies GenerativePalette resolves the profiles into a valid bakeLut call: the GradientShape enum int and nine in-range HSV values. */
test('GenerativePalette delegates resolved (shape, h,s,v x3) to bakeLut', () => {
  lastBakeArgs = null;
  new GenerativePalette('VIGNETTE', 'TRIADIC', 'FLAT', 'VIBRANT', 100);
  assert.ok(Array.isArray(lastBakeArgs) && lastBakeArgs.length === 10, 'bakeLut called with 10 args');
  // VIGNETTE is index 2 in core/color/color.h GradientShape order.
  assert.equal(lastBakeArgs[0], 2, 'shape enum int');
  for (let i = 1; i < 10; i++) {
    assert.ok(Number.isInteger(lastBakeArgs[i]), `arg ${i} integer`);
    assert.ok(lastBakeArgs[i] >= 0 && lastBakeArgs[i] <= 255, `arg ${i} in [0,255]`);
  }
  // FLAT/VIBRANT are RNG-free: value and saturation pin to 255 on all three keys.
  assert.deepEqual([lastBakeArgs[3], lastBakeArgs[6], lastBakeArgs[9]], [255, 255, 255], 'FLAT values');
  assert.deepEqual([lastBakeArgs[2], lastBakeArgs[5], lastBakeArgs[8]], [255, 255, 255], 'VIBRANT saturations');
});

/**
 * Resolves a palette and returns the (s1,s2,s3) and (v1,v2,v3) bakeLut carries.
 * @param {string} brightness - Brightness profile under test.
 * @param {string} sat - Saturation profile under test.
 * @param {number} hueValue - Base hue, which is also the draw seed.
 * @returns {{sats:number[], values:number[]}} The resolved saturations and values.
 */
function resolveKeys(brightness, sat, hueValue) {
  new GenerativePalette('STRAIGHT', 'TRIADIC', brightness, sat, hueValue);
  return {
    sats: [lastBakeArgs[2], lastBakeArgs[5], lastBakeArgs[8]],
    values: [lastBakeArgs[3], lastBakeArgs[6], lastBakeArgs[9]],
  };
}

// Base hues the generative goldens below are pinned at; 0 and 200 cover the
// bottom of the wheel and a harmony that wraps past 256, 42 is the tool's default.
const GENERATIVE_SEEDS = [0, 10, 42, 128, 137, 200];

// Saturation keys (s1,s2,s3) the engine's GenerativePalette resolves per seed,
// captured by running the core/color/color.h constructor.
const ENGINE_SATS = {
  PASTEL: { 0: [100, 100, 100], 10: [100, 100, 100], 42: [100, 100, 100], 128: [100, 100, 100], 137: [100, 100, 100], 200: [100, 100, 100] },
  MID: { 0: [183, 186, 167], 10: [165, 190, 187], 42: [186, 160, 159], 128: [197, 185, 180], 137: [193, 153, 179], 200: [170, 165, 202] },
  VIBRANT: { 0: [255, 255, 255], 10: [255, 255, 255], 42: [255, 255, 255], 128: [255, 255, 255], 137: [255, 255, 255], 200: [255, 255, 255] },
};

// Brightness keys (v1,v2,v3) the same constructor resolves per seed.
const ENGINE_VALUES = {
  ASCENDING: { 0: [44, 153, 239], 10: [39, 131, 210], 42: [57, 151, 254], 128: [26, 149, 248], 137: [62, 138, 234], 200: [36, 156, 230] },
  DESCENDING: { 0: [223, 153, 59], 10: [219, 131, 31], 42: [236, 151, 74], 128: [205, 149, 68], 137: [241, 138, 55], 200: [215, 156, 50] },
  FLAT: { 0: [255, 255, 255], 10: [255, 255, 255], 42: [255, 255, 255], 128: [255, 255, 255], 137: [255, 255, 255], 200: [255, 255, 255] },
  BELL: { 0: [79, 218, 79], 10: [73, 184, 73], 42: [98, 215, 98], 128: [52, 212, 52], 137: [106, 196, 106], 200: [67, 223, 67] },
  CUP: { 0: [207, 90, 207], 10: [200, 57, 200], 42: [226, 87, 226], 128: [180, 84, 180], 137: [234, 68, 234], 200: [195, 95, 195] },
};

// Hue triples (h1,h2,h3) the engine's calc_hues derives per seed, jitter included.
const ENGINE_HUES = {
  TRIADIC: { 0: [0, 85, 170], 10: [10, 95, 180], 42: [42, 127, 212], 128: [128, 213, 42], 137: [137, 222, 51], 200: [200, 29, 114] },
  SPLIT_COMPLEMENTARY: { 0: [0, 107, 149], 10: [10, 117, 159], 42: [42, 149, 191], 128: [128, 235, 21], 137: [137, 244, 30], 200: [200, 51, 93] },
  COMPLEMENTARY: { 0: [0, 128, 249], 10: [10, 138, 9], 42: [42, 170, 39], 128: [128, 0, 131], 137: [137, 9, 138], 200: [200, 72, 197] },
  ANALOGOUS: { 0: [0, 21, 42], 10: [10, 22, 43], 42: [42, 60, 74], 128: [128, 145, 162], 137: [137, 149, 160], 200: [200, 213, 226] },
};

/**
 * Pins the saturation and brightness keys palette_math.js resolves to the keys
 * the engine's GenerativePalette resolves for the same profiles and base hue.
 * The goldens are absolute values captured from that constructor, so a shifted
 * draw site, a moved range bound or a drifted hash all show up here — a
 * comparison rebuilt from the mirror's own seededRandInt would agree with
 * itself instead.
 */
test('GenerativePalette saturation and brightness keys match the engine', () => {
  for (const seed of GENERATIVE_SEEDS) {
    for (const sat of Object.keys(ENGINE_SATS)) {
      for (const brightness of Object.keys(ENGINE_VALUES)) {
        const { sats, values } = resolveKeys(brightness, sat, seed);
        assert.deepEqual(sats, ENGINE_SATS[sat][seed], `${sat} saturations at hue ${seed}`);
        assert.deepEqual(values, ENGINE_VALUES[brightness][seed], `${brightness} values at hue ${seed}`);
      }
    }
  }
});

/**
 * Pins the harmony hue triples palette_math.js derives to the ones the engine's
 * calc_hues derives, covering the deterministic offsets, the 256 wrap and the
 * seeded jitter of COMPLEMENTARY and ANALOGOUS in one set of absolute goldens.
 */
test('GenerativePalette harmony hues match the engine', () => {
  const hues = (harmony, hueValue) => {
    new GenerativePalette('STRAIGHT', harmony, 'FLAT', 'VIBRANT', hueValue);
    return [lastBakeArgs[1], lastBakeArgs[4], lastBakeArgs[7]];
  };
  for (const harmony of Object.keys(ENGINE_HUES)) {
    for (const seed of GENERATIVE_SEEDS) {
      assert.deepEqual(hues(harmony, seed), ENGINE_HUES[harmony][seed],
        `${harmony} at hue ${seed}`);
    }
  }
});

/**
 * Verifies the preview tracks the base hue the export pins: the engine derives
 * every draw from that hue, so two hues must resolve different key triples
 * rather than sharing one profile-string-seeded structure.
 */
test('GenerativePalette key draws move with the base hue', () => {
  const keys = (hueValue) => {
    const { sats, values } = resolveKeys('ASCENDING', 'MID', hueValue);
    return [...sats, ...values];
  };
  assert.notDeepEqual(keys(10), keys(11));
  assert.deepEqual(keys(10), keys(10));
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

  assert.equal(atOne.length, 3);
  for (const ch of atOne) {
    assert.ok(Number.isFinite(ch), `channel finite at t=1.0`);
    assert.ok(ch >= -1e-6 && ch <= 1 + 1e-6, `channel ${ch} in [0,1] at t=1.0`);
  }

  assert.deepEqual(beyond, atOne);

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
  const vig = new GenerativePalette('VIGNETTE', 'COMPLEMENTARY', 'BELL', 'MID', 200);
  const mid = vig.get(0.5);
  for (const ch of mid) assert.ok(Number.isFinite(ch));
});

/**
 * Pins GenerativePalette.get's interpolation DOMAIN, which is the whole point of
 * the reconstruction: BakedPalette::get (core/color/composition.h) lerps
 * linear-light entries, so a sample between two LUT stops must be the linear-light
 * blend of them, not the sRGB blend.
 */
test('GenerativePalette.get blends adjacent LUT entries in linear light', () => {
  // Entry 0 black, every later entry mid grey: the 0->1 step is a wide gap, where
  // the linear and sRGB domains disagree by ~0.14 rather than by rounding.
  setPaletteOps(() => {
    const lut = new Uint8Array(256 * 3);
    lut.fill(128, 3);
    return lut;
  });
  try {
    const pal = new GenerativePalette('STRAIGHT', 'TRIADIC', 'FLAT', 'VIBRANT', 0);
    const grey = srgbToLinear(128 / 255);

    for (const [t, frac] of [[0.5 / 255, 0.5], [0.25 / 255, 0.25], [0.75 / 255, 0.75]]) {
      for (const ch of pal.get(t)) {
        assert.ok(Math.abs(ch - grey * frac) < NEAR, `linear blend at frac ${frac}: ${ch}`);
        assert.ok(Math.abs(ch - (128 / 255) * frac) > 0.05, `not the sRGB blend: ${ch}`);
      }
    }

    for (const ch of pal.get(0)) assert.ok(Math.abs(ch) < NEAR, 'entry 0 is black');
    for (const ch of pal.get(1)) assert.ok(Math.abs(ch - grey) < NEAR, 'entry 255 is linearized grey');
  } finally {
    setPaletteOps(mockBakeLut);
  }
});

/**
 * Verifies the zoom window maps onto the whole strip: the color at phase p of
 * the zoomed palette equals the color at t_start + p*(t_end - t_start) of the
 * original, for every channel.
 */
test('zoomedProceduralParams reparameterizes the window onto the full strip', () => {
  const base = {
    A_R: 0.5, A_G: 0.5, A_B: 0.5,
    B_R: 0.5, B_G: 0.5, B_B: 0.5,
    C_R: 1.0, C_G: 1.0, C_B: 1.0,
    D_R: 0.0, D_G: 0.33, D_B: 0.67,
  };
  const tStart = 0.2;
  const tEnd = 0.6;
  const zoomed = { ...base, ...zoomedProceduralParams(base, tStart, tEnd) };

  const before = new ProceduralPalette(
    [base.A_R, base.A_G, base.A_B], [base.B_R, base.B_G, base.B_B],
    [base.C_R, base.C_G, base.C_B], [base.D_R, base.D_G, base.D_B]);
  const after = new ProceduralPalette(
    [zoomed.A_R, zoomed.A_G, zoomed.A_B], [zoomed.B_R, zoomed.B_G, zoomed.B_B],
    [zoomed.C_R, zoomed.C_G, zoomed.C_B], [zoomed.D_R, zoomed.D_G, zoomed.D_B]);

  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    const want = before.get(tStart + p * (tEnd - tStart));
    const got = after.get(p);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(want[i] - got[i]) < 1e-9,
        `channel ${i} at p=${p}: ${got[i]} != ${want[i]}`);
    }
  }
});

/** Verifies frequency scales by the window width and phase wraps into [0, 1). */
test('zoomedProceduralParams scales frequency and wraps phase', () => {
  const out = zoomedProceduralParams(
    { C_R: 2, C_G: 4, C_B: 0, D_R: 0.9, D_G: 0.1, D_B: 0.4 }, 0.25, 0.75);
  assert.equal(out.C_R, 1);
  assert.equal(out.C_G, 2);
  assert.equal(out.C_B, 0);
  // (0.9 + 2*0.25) % 1 = 0.4
  assert.ok(Math.abs(out.D_R - 0.4) < 1e-12);
  assert.ok(Math.abs(out.D_G - 0.1) < 1e-12);
  assert.equal(out.D_B, 0.4);
});

/** Verifies the A/B (bias/amplitude) triples are left untouched by a zoom. */
test('zoomedProceduralParams touches only the C and D triples', () => {
  const out = zoomedProceduralParams({ C_R: 1, C_G: 1, C_B: 1, D_R: 0, D_G: 0, D_B: 0 }, 0, 0.5);
  assert.deepEqual(Object.keys(out).sort(), ['C_B', 'C_G', 'C_R', 'D_B', 'D_G', 'D_R']);
});
