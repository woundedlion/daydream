import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  ProceduralPalette, GenerativePalette, compilePaletteRecipe,
  mapValue, waveGraphBand, WAVE_GRAPH_VALUE_RANGE,
  proceduralPaletteCpp, proceduralParamsForViewport,
  generativePaletteCpp, paletteRecipeJson, setPaletteOps,
  NAMED_PROCEDURAL_PALETTES, proceduralPaletteParams,
} = await import('../tools/palette_math.js');
const { defaultPaletteRecipe, PaletteV4 } = await import('../tools/palette_controls.js');

function mockBakeLut() {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    lut[3 * i] = i;
    lut[3 * i + 1] = 255 - i;
    lut[3 * i + 2] = 128;
  }
  return lut;
}

function mockPaletteOps(overrides = {}) {
  const compile = (recipe) => ({
    status: { code: 0, field: 0, wrappedFields: 0, clampedFields: 0, canonicalizedFields: 0 },
    canonicalRecipe: structuredClone(recipe),
    lut: mockBakeLut(),
    diagnostics: new Float32Array(256 * 6),
    fallback: new Uint8Array(256),
  });
  return {
    compileAndBakeV4: compile,
    inspectV4: compile,
    ...overrides,
  };
}
setPaletteOps(mockPaletteOps());

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
  for (const ch of at0) assert.ok(Math.abs(ch - 1) < NEAR);
  assert.ok(Math.abs(at0[0] - 1.0) < NEAR);

  const at05 = p.get(0.5);
  for (const ch of at05) assert.ok(Math.abs(ch) < NEAR);
  assert.ok(Math.abs(at05[0] - 0.0) < NEAR);

  const at025 = p.get(0.25);
  for (let ch = 0; ch < 3; ch++) {
    assert.ok(Math.abs(at025[ch] - 0.21404114048223255) < NEAR,
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

test('proceduralParamsForViewport reparameterizes the exported phase window', () => {
  const parameters = {
    A_R: 0.5, A_G: 0.5, A_B: 0.5,
    B_R: 0.5, B_G: 0.5, B_B: 0.5,
    C_R: 1, C_G: 2, C_B: -1,
    D_R: 0, D_G: 0.25, D_B: 0.75,
  };
  const result = proceduralParamsForViewport(parameters, { start: 0.2, end: 0.6 });
  assert.deepEqual(result, {
    ...parameters,
    C_R: 0.39999999999999997,
    C_G: 0.7999999999999999,
    C_B: -0.39999999999999997,
    D_R: 0.2,
    D_G: 0.65,
    D_B: 0.55,
  });
  assert.equal(parameters.C_R, 1);
});

test('the reparameterized palette samples the window it stands for', () => {
  const fromParams = (p) => new ProceduralPalette(
    [p.A_R, p.A_G, p.A_B], [p.B_R, p.B_G, p.B_B],
    [p.C_R, p.C_G, p.C_B], [p.D_R, p.D_G, p.D_B]);
  const viewport = { start: 0.2, end: 0.6 };
  const span = viewport.end - viewport.start;

  for (const entry of NAMED_PROCEDURAL_PALETTES) {
    const parameters = proceduralPaletteParams(entry);
    const full = fromParams(parameters);
    const windowed = fromParams(proceduralParamsForViewport(parameters, viewport));
    for (let step = 0; step <= 8; step++) {
      const position = step / 8;
      const inWindow = full.getChannelValues(viewport.start + position * span);
      const plotted = windowed.getChannelValues(position);
      for (let channel = 0; channel < 3; channel++) {
        assert.ok(Math.abs(plotted[channel] - inWindow[channel]) < 1e-12,
          `${entry.name} channel ${channel} at ${position}: `
            + `${plotted[channel]} vs ${inWindow[channel]}`);
      }
    }
  }
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

/**
 * Verifies GenerativePalette.get's upper boundary. get clamps t to [0,1] and
 * maps it onto the 256-entry LUT: t === 1.0 lands exactly on the final entry
 * (no lo+1 overrun), and t > 1.0 clamps to that same entry — it must return the
 * final color, not NaN or a wrapped value, and be continuous with the interior
 * limit approaching it.
 */
test('GenerativePalette.get clamps to the final LUT entry', () => {
  const pal = new GenerativePalette(defaultPaletteRecipe());

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

test('generativePaletteCpp serializes the complete V4 recipe', () => {
  const recipe = defaultPaletteRecipe();
  recipe.domain = 4;
  recipe.hue.harmony = 5;
  recipe.lightness.curve = 1;
  const source = generativePaletteCpp(recipe);

  assert.match(source, /recipe\.schema_version = 4;/);
  assert.doesNotMatch(source, /key_count/);
  assert.match(source, /recipe\.input\.offset = 0\.0f;/);
  assert.match(source, /recipe\.input\.span = 1\.0f;/);
  assert.match(source, /PaletteDomain::LOOP/);
  assert.match(source, /PaletteHarmony::TRIADIC/);
  assert.match(source, /AxisCurve::ASCENDING/);
  assert.match(source, /ChromaBasis::LOCAL_GAMUT/);
  assert.match(source, /GenerativePalette::try_compile\(recipe, palette, canonical, status\)/);
});

test('generativePaletteCpp names every supported color harmony', () => {
  const recipe = defaultPaletteRecipe();
  for (const [name, value] of Object.entries(PaletteV4.harmony)) {
    recipe.hue.harmony = value;
    const source = generativePaletteCpp(recipe);
    assert.match(source, new RegExp(`PaletteHarmony::${name}`));
    assert.doesNotMatch(source, /undefined/);
  }
});

test('paletteRecipeJson preserves a Complementary recipe without derived state', () => {
  const recipe = defaultPaletteRecipe();
  recipe.hue.harmony = PaletteV4.harmony.COMPLEMENTARY;
  const exported = JSON.parse(paletteRecipeJson(recipe));

  assert.equal(exported.schemaVersion, 4);
  assert.equal('keyCount' in exported, false);
  assert.equal(exported.hue.harmony, PaletteV4.harmony.COMPLEMENTARY);
});

test('generativePaletteCpp rejects unknown enum values', () => {
  const recipe = defaultPaletteRecipe();
  recipe.domain = 99;
  assert.throws(() => generativePaletteCpp(recipe), /unknown domain enum value 99/);
});

test('paletteRecipeJson preserves the complete recipe', () => {
  const recipe = defaultPaletteRecipe();
  assert.deepEqual(JSON.parse(paletteRecipeJson(recipe)), recipe);
});

test('compilePaletteRecipe selects the requested bridge operation and owns its buffers', () => {
  const recipe = defaultPaletteRecipe();
  const lut = mockBakeLut();
  const diagnostics = new Float32Array(256 * 6).fill(0.25);
  const fallback = new Uint8Array(256).fill(1);
  const calls = [];
  const compile = (kind) => (input) => {
    calls.push([kind, input]);
    return {
      status: { code: 0, field: 0 },
      canonicalRecipe: input,
      lut,
      diagnostics,
      fallback,
    };
  };
  setPaletteOps({ compileAndBakeV4: compile('compile'), inspectV4: compile('inspect') });
  try {
    const inspected = compilePaletteRecipe(recipe);
    const compiled = compilePaletteRecipe(recipe, false);
    assert.deepEqual(calls.map(([kind]) => kind), ['inspect', 'compile']);
    assert.notEqual(inspected.lut, lut);
    assert.notEqual(inspected.diagnostics, diagnostics);
    assert.notEqual(inspected.fallback, fallback);
    assert.notEqual(inspected.canonicalRecipe, recipe);
    assert.deepEqual(compiled.lut, lut);
  } finally {
    setPaletteOps(mockPaletteOps());
  }
});

test('GenerativePalette reports compiler failures', () => {
  setPaletteOps(mockPaletteOps({
    inspectV4: () => ({ status: { code: 2, field: 7 } }),
  }));
  try {
    assert.throws(() => new GenerativePalette(defaultPaletteRecipe()),
      /Palette recipe error 2 at field 7/);
  } finally {
    setPaletteOps(mockPaletteOps());
  }
});

test('GenerativePalette uses the canonical recipe and exposes diagnostics', () => {
  const recipe = defaultPaletteRecipe();
  const diagnostics = new Float32Array(256 * 6);
  diagnostics.set([0.6, 0.2, 0.75, 0.25, 0.1, 0.12], 6 * 128);
  const fallback = new Uint8Array(256);
  fallback[128] = 1;
  setPaletteOps(mockPaletteOps({
    inspectV4: (input) => ({
      status: { code: 0, field: 0 },
      canonicalRecipe: { ...structuredClone(input), falloffStart: 0.8 },
      lut: mockBakeLut(),
      diagnostics,
      fallback,
    }),
  }));
  try {
    const palette = new GenerativePalette(recipe);
    assert.equal(palette.canonicalRecipe.falloffStart, 0.8);
    assert.deepEqual(palette.diagnosticAt(128 / 255), {
      t: 128 / 255,
      rgb: [128, 127, 128],
      L: diagnostics[768],
      C: diagnostics[769],
      q: diagnostics[770],
      Cmax: diagnostics[771],
      hPath: diagnostics[772],
      hFinal: diagnostics[773],
      fallbackMapped: true,
    });
  } finally {
    setPaletteOps(mockPaletteOps());
  }
});

test('GenerativePalette.get blends adjacent entries in linear light', () => {
  const lut = new Uint8Array(256 * 3);
  lut.fill(128, 3);
  setPaletteOps(mockPaletteOps({
    inspectV4: (recipe) => ({
      status: { code: 0, field: 0 },
      canonicalRecipe: recipe,
      lut,
      diagnostics: new Float32Array(256 * 6),
      fallback: new Uint8Array(256),
    }),
  }));
  try {
    const palette = new GenerativePalette(defaultPaletteRecipe());
    const grey = 0.21586050011389926;
    for (const [t, fraction] of [[0.5 / 255, 0.5], [0.25 / 255, 0.25]]) {
      for (const channel of palette.get(t)) {
        assert.ok(Math.abs(channel - grey * fraction) < NEAR);
      }
    }
    assert.deepEqual(palette.get(2), palette.get(1));
    assert.deepEqual(palette.get(-1), palette.get(0));
    assert.deepEqual(palette.get(Number.NaN), palette.get(1));
  } finally {
    setPaletteOps(mockPaletteOps());
  }
});
