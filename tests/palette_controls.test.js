import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const PALETTES_HTML = readFileSync(new URL('../tools/palettes.html', import.meta.url), 'utf8');

const {
  paletteTabFromSearch, paletteTabUrl, tablistKeyTarget,
  createPaletteViewport, axisEndpoints, axisFromEndpoints,
  axisControlState, PALETTE_AXIS_CONTROLS,
  clampRecipeWindow, zoomRecipeWindow, stripDragIntent, paletteStripView,
  waveGraphLabel,
  STRIP_DRAG_THRESHOLD,
  lockedGroupMove,
  PaletteV4, defaultPaletteRecipe, paletteRecipeFromControls,
  PALETTE_CONTROL_IDS, paletteControlReadings, paletteControlsFromRecipe,
  paletteEnumName, paletteEnumOrdinal,
  PALETTE_RECIPE_PRESETS,
  paletteRecipeAvailability, wrapTurns, signedTurnDelta, equivalentTurnNear,
  hitTestHueKeyMarker, oklchLinearRgb, maxSrgbGamutChroma,
  hueKeyState, customHueKeyState, customHueTurns, moveCustomHueKey,
} =
  await import('../tools/palette_controls.js');

test('palette tab deep links select only known tabs', () => {
  assert.equal(paletteTabFromSearch('?tab=generative'), 'generative');
  assert.equal(paletteTabFromSearch('?tab=procedural'), 'procedural');
  assert.equal(paletteTabFromSearch('?tab=unknown'), 'procedural');
  assert.equal(paletteTabFromSearch(''), 'procedural');
});

test('palette tab URLs preserve other query state and the hash', () => {
  const href = paletteTabUrl(
    'https://example.test/tools/palettes.html?foo=1#export', 'generative');
  assert.equal(href,
    'https://example.test/tools/palettes.html?foo=1&tab=generative#export');
  assert.throws(() => paletteTabUrl('https://example.test/', 'unknown'),
    /Unknown palette tab/);
});

test('tablist arrow keys wrap and Home/End reach the ends', () => {
  assert.equal(tablistKeyTarget('ArrowRight', 0, 2), 1);
  assert.equal(tablistKeyTarget('ArrowRight', 1, 2), 0);
  assert.equal(tablistKeyTarget('ArrowLeft', 0, 2), 1);
  assert.equal(tablistKeyTarget('ArrowLeft', 1, 2), 0);
  assert.equal(tablistKeyTarget('Home', 2, 3), 0);
  assert.equal(tablistKeyTarget('End', 0, 3), 2);
});

test('tablist keys other than the navigation contract are left alone', () => {
  assert.equal(tablistKeyTarget('Enter', 0, 2), null);
  assert.equal(tablistKeyTarget('Tab', 0, 2), null);
  assert.equal(tablistKeyTarget('ArrowRight', 0, 0), null);
});

test('the palette viewport maps strip positions onto its visible phase window', () => {
  const viewport = createPaletteViewport();
  assert.equal(viewport.map(0.25), 0.25);
  assert.equal(viewport.zoomed, false);

  viewport.zoom(0.2, 0.6);
  assert.deepEqual(viewport.value, { start: 0.2, end: 0.6 });
  assert.equal(viewport.map(0.25), 0.3);
  assert.equal(viewport.zoomed, true);
});

test('successive palette viewport zooms compose in either drag direction', () => {
  const viewport = createPaletteViewport();
  viewport.zoom(0.2, 0.8);
  viewport.zoom(0.75, 0.25);
  assert.ok(Math.abs(viewport.value.start - 0.35) < 1e-12);
  assert.ok(Math.abs(viewport.value.end - 0.65) < 1e-12);
});

test('reset restores the full palette viewport', () => {
  const viewport = createPaletteViewport();
  viewport.zoom(0.5, 0.5);
  assert.deepEqual(viewport.value, { start: 0, end: 1 });
  viewport.zoom(0.2, 0.6);
  viewport.reset();
  assert.deepEqual(viewport.value, { start: 0, end: 1 });
  assert.equal(viewport.zoomed, false);
});

test('axis endpoints round-trip through center and range', () => {
  assert.deepEqual(axisFromEndpoints(0.16, 0.88), { center: 0.52, range: 0.72 });
  assert.deepEqual(axisEndpoints({ center: 0.52, range: 0.72 }), {
    minimum: 0.16000000000000003,
    maximum: 0.88,
  });
  assert.deepEqual(axisFromEndpoints(0.88, 0.16), { center: 0.52, range: 0.72 });
});

test('axis endpoints clamp authored extrema to the unit interval', () => {
  assert.deepEqual(axisEndpoints({ center: 0.1, range: 0.6 }), {
    minimum: 0,
    maximum: 0.4,
  });
});

/** A locked group of three sliders sharing raw bounds, at the given start values. */
const group = (starts, min = 0, max = 1000) =>
  ['A_R', 'A_G', 'A_B'].map((param, i) => ({ param, start: starts[i], min, max }));

/** Verifies an in-range delta passes through and moves every member by the same amount. */
test('an in-range delta moves the whole group rigidly', () => {
  const { delta, values } = lockedGroupMove(100, group([200, 400, 600]));
  assert.equal(delta, 100);
  assert.deepEqual(values, { A_R: 300, A_G: 500, A_B: 700 });
});

/** Verifies the member nearest the upper bound caps the group instead of clipping alone. */
test('the member closest to the maximum caps a positive delta', () => {
  const { delta, values } = lockedGroupMove(500, group([200, 400, 900]));
  assert.equal(delta, 100);
  assert.deepEqual(values, { A_R: 300, A_G: 500, A_B: 1000 });
});

/** Verifies the member nearest the lower bound caps the group for a negative delta. */
test('the member closest to the minimum caps a negative delta', () => {
  const { delta, values } = lockedGroupMove(-500, group([200, 400, 900]));
  assert.equal(delta, -200);
  assert.deepEqual(values, { A_R: 0, A_G: 200, A_B: 700 });
});

/** Verifies a group already spanning its whole range cannot move in either direction. */
test('a group spanning the full range is pinned', () => {
  assert.equal(lockedGroupMove(50, group([0, 500, 1000])).delta, 0);
  assert.equal(lockedGroupMove(-50, group([0, 500, 1000])).delta, 0);
});

/** Verifies members whose start value could not be read are left out entirely. */
test('members with no start value are ignored', () => {
  const members = group([200, undefined, 900]);
  const { delta, values } = lockedGroupMove(500, members);
  // A_G contributes no bound and receives no value; A_B still caps the group.
  assert.equal(delta, 100);
  assert.deepEqual(values, { A_R: 300, A_B: 1000 });
});

/** Verifies negative raw bounds (the frequency/phase groups) cap the same way. */
test('negative raw bounds cap correctly', () => {
  const members = ['C_R', 'C_G', 'C_B'].map((param, i) => ({
    param, start: [-4000, 0, 4000][i], min: -5000, max: 5000,
  }));
  assert.equal(lockedGroupMove(-2000, members).delta, -1000);
  assert.equal(lockedGroupMove(2000, members).delta, 1000);
});

test('the default recipe is a detached, complete V4 value', () => {
  const first = defaultPaletteRecipe();
  const second = defaultPaletteRecipe();
  first.hue.customTurns[0] = 0.5;

  assert.equal(first.schemaVersion, 4);
  assert.equal('keyCount' in first, false);
  assert.deepEqual(first.input, { offset: 0, span: 1 });
  assert.equal(first.chroma.basis, PaletteV4.chromaBasis.LOCAL_GAMUT);
  assert.equal(second.hue.customTurns[0], 0);
});

test('custom hue offsets stay signed and continuous across the wrap seam', () => {
  assert.equal(wrapTurns(-0.02), 0.98);
  assert.ok(Math.abs(signedTurnDelta(0.02 - 0.98) - 0.04) < 1e-12);
  assert.ok(Math.abs(equivalentTurnNear(0.02, 0.98) - 1.02) < 1e-12);
  assert.ok(Math.abs(equivalentTurnNear(0.98, 0.02) + 0.02) < 1e-12);
});

test('hue key hit testing ignores blank wheel space', () => {
  const points = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 50, y: 80 }];

  assert.equal(hitTestHueKeyMarker(22, 21, points, 12), 0);
  assert.equal(hitTestHueKeyMarker(68, 20, points, 12), 1);
  assert.equal(hitTestHueKeyMarker(50, 50, points, 12), null);
});

test('oklchLinearRgb fills a caller-owned triple in place', () => {
  const out = [9, 9, 9];
  const returned = oklchLinearRgb(0.62, 0.1, 0.25, out);

  assert.equal(returned, out, 'the caller-owned array is what comes back');
  assert.deepEqual(out, oklchLinearRgb(0.62, 0.1, 0.25),
    'filling in place must not change the conversion');
});

test('gamut chroma scale finds the widest OKLCH hue boundary', () => {
  const maximum = maxSrgbGamutChroma(0.5);
  const hueSamples = 360;
  let widestSample = 0;
  let beyondBoundarySample = 0;

  for (let hue = 0; hue < hueSamples; hue++) {
    const rgb = oklchLinearRgb(0.5, maximum, hue / hueSamples);
    if (rgb.every((channel) => channel >= -0.0002 && channel <= 1.0002))
      widestSample++;
    const beyondRgb = oklchLinearRgb(0.5, maximum + 0.002, hue / hueSamples);
    if (beyondRgb.every((channel) => channel >= 0 && channel <= 1))
      beyondBoundarySample++;
  }

  assert.ok(maximum > 0.28 && maximum < 0.31);
  assert.ok(widestSample > 0);
  assert.equal(beyondBoundarySample, 0);
});

test('custom hue state derives three sensible keys from authored harmonies', () => {
  const recipe = defaultPaletteRecipe();
  recipe.hue.baseTurns = 0.98;
  recipe.hue.harmony = PaletteV4.harmony.TRIADIC;
  const state = customHueKeyState(recipe);

  assert.equal(state.baseTurns, 0.98);
  assert.ok(Math.abs(state.offsets[1] - 1 / 3) < 1e-12);
  assert.ok(Math.abs(state.offsets[2] - 2 / 3) < 1e-12);
});

test('hue key state exposes all four tetradic and square anchors', () => {
  const recipe = defaultPaletteRecipe();
  recipe.hue.baseTurns = 0.1;
  recipe.hue.spreadTurns = 0.08;
  recipe.hue.harmony = PaletteV4.harmony.TETRADIC;

  const tetradic = hueKeyState(recipe).offsets;
  const expectedTetradic = [0, 0.08, 0.5, 0.58];
  assert.equal(tetradic.length, 4);
  for (let index = 0; index < tetradic.length; index++)
    assert.ok(Math.abs(tetradic[index] - expectedTetradic[index]) < 1e-12);

  recipe.hue.harmony = PaletteV4.harmony.SQUARE;
  const square = hueKeyState(recipe).offsets;
  const expectedSquare = [0, 0.25, 0.5, 0.75];
  assert.equal(square.length, 4);
  for (let index = 0; index < square.length; index++)
    assert.ok(Math.abs(square[index] - expectedSquare[index]) < 1e-12);
});

test('custom hue state samples a sweep into three editable keys', () => {
  const recipe = defaultPaletteRecipe();
  recipe.hue.mode = PaletteV4.hueMode.SWEEP;
  recipe.hue.baseTurns = 0.9;
  recipe.hue.sweepTurns = 1;
  recipe.hue.direction = PaletteV4.direction.CLOCKWISE;

  assert.deepEqual(customHueKeyState(recipe), {
    baseTurns: 0.9,
    offsets: [0, -0.5, -1],
  });
});

test('custom hue state preserves unwrapped offsets from existing custom recipes', () => {
  const recipe = defaultPaletteRecipe();
  recipe.hue.mode = PaletteV4.hueMode.CUSTOM;
  recipe.hue.customTurns = [0.98, 1.02, 0.73, 0];

  assert.deepEqual(customHueKeyState(recipe), {
    baseTurns: 0.98,
    offsets: [0, 0.040000000000000036, -0.25],
  });
});

test('moving the custom base hue rotates every key without changing offsets', () => {
  const offsets = [0, 0.04, -0.25];
  const before = customHueTurns(0.98, offsets);
  const after = customHueTurns(0.03, offsets);

  assert.deepEqual(before.slice(0, 3), [0.98, 1.02, 0.73]);
  assert.deepEqual(after.slice(0, 2), [0.03, 0.07]);
  assert.ok(Math.abs(after[2] + 0.22) < 1e-12);
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs((after[i] - before[i]) + 0.95) < 1e-12);
});

test('moving custom key A leaves the base and other authored keys unchanged', () => {
  const offsets = [0, 0.25, -0.125];
  const moved = moveCustomHueKey(0.2, offsets, 0, 0.3);

  assert.deepEqual(offsets, [0, 0.25, -0.125]);
  assert.ok(Math.abs(moved[0] - 0.1) < 1e-12);
  assert.deepEqual(moved.slice(1), offsets.slice(1));
  const turns = customHueTurns(0.2, moved);
  assert.equal(turns[1], 0.45);
  assert.ok(Math.abs(turns[2] - 0.075) < 1e-12);
});

test('moving custom key A across the seam follows the nearby turn', () => {
  const offsets = [0, 0.14, -0.1];
  const moved = moveCustomHueKey(0.98, offsets, 0, 0.02);
  const turns = customHueTurns(0.98, moved);

  assert.ok(Math.abs(turns[0] - 1.02) < 1e-12);
  assert.ok(Math.abs(turns[1] - 1.12) < 1e-12);
  assert.equal(turns[2], 0.88);
  assert.ok(Math.abs(turns[1] - turns[0] - 0.1) < 1e-12);
  assert.deepEqual(moved.slice(1), offsets.slice(1));
});

test('moving custom key B retains its seam-safe independent behavior', () => {
  const offsets = [0, -0.96, -0.25];
  const moved = moveCustomHueKey(0.98, offsets, 1, 0.03);

  assert.equal(moved[0], offsets[0]);
  assert.ok(Math.abs(moved[1] + 0.95) < 1e-12);
  assert.equal(moved[2], offsets[2]);
});

test('recipe presets express distinct high-level intents', () => {
  const loop = PALETTE_RECIPE_PRESETS.isolightSpectralLoop();
  const tonal = PALETTE_RECIPE_PRESETS.tonalMonochrome();

  assert.equal(loop.domain, PaletteV4.domain.LOOP);
  assert.equal(loop.hue.mode, PaletteV4.hueMode.SWEEP);
  assert.equal(tonal.hue.harmony, PaletteV4.harmony.MONOCHROMATIC);
  assert.equal(tonal.lightness.curve, PaletteV4.curve.ASCENDING);
});

test('recipe availability exposes only controls that can affect the result', () => {
  const recipe = defaultPaletteRecipe();
  assert.deepEqual(paletteRecipeAvailability(recipe), {
    baseHue: true,
    hueMode: true,
    harmony: true,
    hueSpread: true,
    hueSweep: false,
    hueTorsion: true,
    colorPath: true,
    hueDirection: true,
    chromaHeadroom: true,
    falloffStart: false,
    chromaEndpoints: true,
    chromaMaximum: false,
    lightnessEndpoints: true,
    lightnessMaximum: false,
  });

  recipe.hue.mode = PaletteV4.hueMode.SWEEP;
  assert.equal(paletteRecipeAvailability(recipe).harmony, false);
  assert.equal(paletteRecipeAvailability(recipe).hueSpread, false);
  assert.equal(paletteRecipeAvailability(recipe).hueSweep, true);

  recipe.hue.mode = PaletteV4.hueMode.HARMONY;
  recipe.hue.harmony = PaletteV4.harmony.MONOCHROMATIC;
  assert.equal(paletteRecipeAvailability(recipe).colorPath, false);
  assert.equal(paletteRecipeAvailability(recipe).hueDirection, false);
  assert.equal(paletteRecipeAvailability(recipe).hueSpread, false,
    'a monochromatic harmony places its one anchor without a spread');
  assert.equal(paletteRecipeAvailability(recipe).hueSweep, false);

  recipe.hue.harmony = PaletteV4.harmony.SPLIT_COMPLEMENTARY;
  assert.equal(paletteRecipeAvailability(recipe).hueSpread, true);
  recipe.hue.harmony = PaletteV4.harmony.SQUARE;
  assert.equal(paletteRecipeAvailability(recipe).hueSpread, false,
    'a square harmony is fixed quarter-turns, whatever the spread says');
  recipe.hue.harmony = PaletteV4.harmony.MONOCHROMATIC;

  recipe.domain = PaletteV4.domain.FALLOFF;
  assert.equal(paletteRecipeAvailability(recipe).falloffStart, true);
  recipe.domain = PaletteV4.domain.STRAIGHT;
  assert.equal(paletteRecipeAvailability(recipe).falloffStart, false);

  recipe.chroma.center = 1;
  assert.equal(paletteRecipeAvailability(recipe).chromaHeadroom, false,
    'a fully saturated center takes the whole headroom');
  recipe.chroma.center = 0.62;
  recipe.chroma.basis = PaletteV4.chromaBasis.ABSOLUTE;
  assert.equal(paletteRecipeAvailability(recipe).chromaHeadroom, false);
  recipe.chroma.basis = PaletteV4.chromaBasis.LOCAL_GAMUT;

  recipe.chroma.center = 0;
  let availability = paletteRecipeAvailability(recipe);
  assert.equal(availability.baseHue, false);
  assert.equal(availability.hueMode, false);

  recipe.chroma.curve = PaletteV4.curve.BELL;
  recipe.chroma.range = 0.2;
  availability = paletteRecipeAvailability(recipe);
  assert.equal(availability.baseHue, true);
  assert.equal(availability.chromaMaximum, true);

  recipe.lightness.curve = PaletteV4.curve.ASCENDING;
  assert.equal(paletteRecipeAvailability(recipe).lightnessMaximum, true);

  recipe.hue.mode = PaletteV4.hueMode.CUSTOM;
  recipe.lightness.curve = PaletteV4.curve.CUSTOM;
  recipe.chroma.curve = PaletteV4.curve.CUSTOM;
  availability = paletteRecipeAvailability(recipe);
  assert.equal(availability.baseHue, true);
  assert.equal(availability.hueDirection, false);
  assert.equal(availability.lightnessEndpoints, false);
  assert.equal(availability.chromaEndpoints, false);
});

// A full set of control readings, as the generative tab reads them.
const CONTROL_READINGS = {
  window: { offset: 0.1, span: 0.8 },
  domain: 'MIRROR',
  colorPath: 'OKLAB_CARTESIAN',
  hueMode: 'HARMONY',
  harmony: 'TRIADIC',
  direction: 'CLOCKWISE',
  baseTurns: 0.25,
  customHueOffsets: [0, 0.07, 0.14],
  lightnessCurve: 'ASCENDING',
  chromaCurve: 'BELL',
  lightness: { minimum: 0.2, maximum: 0.8 },
  chroma: { minimum: 0.3, maximum: 0.5 },
  easing: 'SMOOTHSTEP',
  spreadTurns: 0.11,
  sweepTurns: 2.5,
  headroom: 0.8,
  hueTorsion: 1.5,
  falloffStart: 0.85,
};

test('control readings marshal into a recipe by enum name', () => {
  const recipe = paletteRecipeFromControls(defaultPaletteRecipe(), CONTROL_READINGS);

  assert.deepEqual(recipe.input, { offset: 0.1, span: 0.8 });
  assert.equal(recipe.domain, PaletteV4.domain.MIRROR);
  assert.equal(recipe.colorPath, PaletteV4.colorPath.OKLAB_CARTESIAN);
  assert.equal(recipe.hue.mode, PaletteV4.hueMode.HARMONY);
  assert.equal(recipe.hue.harmony, PaletteV4.harmony.TRIADIC);
  assert.equal(recipe.hue.direction, PaletteV4.direction.CLOCKWISE);
  assert.equal(recipe.hue.baseTurns, 0.25);
  assert.equal(recipe.lightness.curve, PaletteV4.curve.ASCENDING);
  assert.equal(recipe.chroma.curve, PaletteV4.curve.BELL);
});

/**
 * The tab exports every field of the recipe, so a reading that never reaches
 * one leaves the control it belongs to decorative and the recipe stuck at the
 * template's value.
 */
test('every recipe field a control carries is marshalled', () => {
  const recipe = paletteRecipeFromControls(defaultPaletteRecipe(), CONTROL_READINGS);

  assert.equal(recipe.easing, PaletteV4.easing.SMOOTHSTEP);
  assert.equal(recipe.hue.spreadTurns, 0.11);
  assert.equal(recipe.hue.sweepTurns, 2.5);
  assert.equal(recipe.chroma.headroom, 0.8);
  assert.equal(recipe.hueTorsion, 1.5);
});

/**
 * The readings name their controls by element id, so an id the page does not
 * carry reads as a missing control rather than as a NaN or an undefined enum the
 * engine bridge rejects several steps later.
 */
test('the generative tab carries every control the readings name', () => {
  const ids = Object.values(PALETTE_CONTROL_IDS);
  assert.ok(ids.length >= 20, 'the roster must still name the tab\'s controls');
  for (const id of ids) {
    assert.match(PALETTES_HTML, new RegExp(`<(?:input|select)[^>]*\\bid="${id}"`),
      `palettes.html must carry a ${id} control`);
  }
});

/**
 * The tab reads its recipe off the controls, so a markup default that disagrees
 * with the default recipe silently authors a different palette at load.
 */
test('the generative tab opens on the default recipe', () => {
  const recipe = defaultPaletteRecipe();
  const sliderValue = (id) => {
    const tag = PALETTES_HTML.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `palettes.html must carry a ${id} control`);
    return Number(tag.match(/value="([^"]*)"/)[1]);
  };

  assert.ok(Math.abs(sliderValue('gen_spread') / 360 - recipe.hue.spreadTurns) < 1e-9);
  assert.equal(sliderValue('gen_sweep'), recipe.hue.sweepTurns);
  assert.equal(sliderValue('gen_torsion'), recipe.hueTorsion);
  assert.equal(sliderValue('gen_headroom'), recipe.chroma.headroom);
  assert.equal(sliderValue('gen_falloff'), recipe.falloffStart);
  const easing = PALETTES_HTML.match(/<option value="(\w+)" selected>/)?.[1];
  assert.equal(PaletteV4.easing[easing], recipe.easing,
    'the easing option marked selected must be the default recipe\'s');
});

/** Verifies the two fields the engine canonicalizes are canonical before it sees them. */
test('a falloff start and a loop sweep are canonicalized by domain', () => {
  const straight = paletteRecipeFromControls(defaultPaletteRecipe(), CONTROL_READINGS);
  assert.equal(straight.falloffStart, 0.9, 'only a FALLOFF domain carries its own start');

  const falloff = paletteRecipeFromControls(defaultPaletteRecipe(),
    { ...CONTROL_READINGS, domain: 'FALLOFF' });
  assert.equal(falloff.falloffStart, 0.85);

  const loop = paletteRecipeFromControls(defaultPaletteRecipe(),
    { ...CONTROL_READINGS, domain: 'LOOP', hueMode: 'SWEEP' });
  assert.equal(loop.hue.sweepTurns, 3, 'a loop closes only on whole turns');

  const open = paletteRecipeFromControls(defaultPaletteRecipe(),
    { ...CONTROL_READINGS, hueMode: 'SWEEP' });
  assert.equal(open.hue.sweepTurns, 2.5);
});

test('an axis endpoint pair becomes its center and range', () => {
  const recipe = paletteRecipeFromControls(defaultPaletteRecipe(), CONTROL_READINGS);

  assert.deepEqual(recipe.lightness, { ...defaultPaletteRecipe().lightness,
    curve: PaletteV4.curve.ASCENDING, ...axisFromEndpoints(0.2, 0.8) });
  assert.equal(recipe.chroma.center, 0.4);
  assert.equal(recipe.chroma.range, 0.2);
});

test('a CUSTOM axis keeps the template points its endpoints cannot describe', () => {
  const template = defaultPaletteRecipe();
  template.lightness.custom = [0.1, 0.2, 0.3, 0.4];
  template.lightness.center = 0.55;
  template.lightness.range = 0.3;
  const recipe = paletteRecipeFromControls(template,
    { ...CONTROL_READINGS, lightnessCurve: 'CUSTOM' });

  assert.deepEqual(recipe.lightness.custom, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(recipe.lightness.center, 0.55);
  assert.equal(recipe.lightness.range, 0.3);
});

test('custom hue turns are derived only in CUSTOM hue mode', () => {
  const offsets = [0, 0.07, 0.14];
  const harmony = paletteRecipeFromControls(defaultPaletteRecipe(), CONTROL_READINGS);
  const custom = paletteRecipeFromControls(defaultPaletteRecipe(),
    { ...CONTROL_READINGS, hueMode: 'CUSTOM' });

  assert.deepEqual(harmony.hue.customTurns, defaultPaletteRecipe().hue.customTurns);
  assert.deepEqual(custom.hue.customTurns,
    customHueTurns(0.25, offsets, defaultPaletteRecipe().hue.customTurns));
});

test('a fully saturated chroma center takes the full headroom', () => {
  const recipe = paletteRecipeFromControls(defaultPaletteRecipe(),
    { ...CONTROL_READINGS, chroma: { minimum: 1, maximum: 1 } });

  assert.equal(recipe.chroma.center, 1);
  assert.equal(recipe.chroma.headroom, 1);
});

test('marshalling never writes through to the template', () => {
  const template = defaultPaletteRecipe();
  const recipe = paletteRecipeFromControls(template, CONTROL_READINGS);
  recipe.hue.customTurns[0] = 0.5;

  assert.deepEqual(template, defaultPaletteRecipe());
  assert.equal(recipe.schemaVersion, template.schemaVersion);
});

/**
 * Compares two recipes field by field, with a tolerance on the numbers: an
 * endpoint pair that round-trips through a center and a range does not come back
 * bit-identical.
 * @param {any} actual - What came back.
 * @param {any} expected - What went in.
 * @param {string} [path] - Field path, for the failure message.
 * @returns {void}
 */
function assertRecipeClose(actual, expected, path = 'recipe') {
  if (typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) < 1e-9,
      `${path}: ${actual} is not ${expected}`);
    return;
  }
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${path}: length`);
    expected.forEach((value, index) =>
      assertRecipeClose(actual[index], value, `${path}[${index}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(),
      `${path}: fields`);
    for (const key of Object.keys(expected))
      assertRecipeClose(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  assert.equal(actual, expected, path);
}

/**
 * The control values a recipe loads as, as strings, the way the page's elements
 * hold them.
 * @param {Object} recipe - The recipe to load.
 * @returns {{values: Object<string, string>, customHueOffsets: number[]}} The
 *   control map, keyed by element id, and the key offsets the wheel holds.
 */
function controlsFor(recipe) {
  const controls = paletteControlsFromRecipe(recipe);
  const id = PALETTE_CONTROL_IDS;
  return {
    customHueOffsets: controls.customHueOffsets,
    values: {
      [id.offset]: String(controls.window.offset),
      [id.span]: String(controls.window.span),
      [id.easing]: controls.easing,
      [id.spreadDegrees]: String(controls.spreadTurns * 360),
      [id.sweepTurns]: String(controls.sweepTurns),
      [id.headroom]: String(controls.headroom),
      [id.hueTorsion]: String(controls.hueTorsion),
      [id.falloffStart]: String(controls.falloffStart),
      [id.domain]: controls.domain,
      [id.colorPath]: controls.colorPath,
      [id.hueMode]: controls.hueMode,
      [id.harmony]: controls.harmony,
      [id.direction]: controls.direction,
      [id.baseHueDegrees]: String(controls.baseTurns * 360),
      [id.lightnessCurve]: controls.lightnessCurve,
      [id.chromaCurve]: controls.chromaCurve,
      [id.lightnessMinimum]: String(controls.lightness.minimum),
      [id.lightnessMaximum]: String(controls.lightness.maximum),
      [id.chromaMinimum]: String(controls.chroma.minimum),
      [id.chromaMaximum]: String(controls.chroma.maximum),
    },
  };
}

test('every preset survives the trip out to the controls and back', () => {
  for (const [name, preset] of Object.entries(PALETTE_RECIPE_PRESETS)) {
    const recipe = preset();
    const { values, customHueOffsets } = controlsFor(recipe);
    const readings = paletteControlReadings((id) => values[id], customHueOffsets);

    assertRecipeClose(paletteRecipeFromControls(recipe, readings), recipe, name);
  }
});

test('an authored custom-hue recipe keeps its keys through the controls', () => {
  const recipe = defaultPaletteRecipe();
  recipe.hue.mode = PaletteV4.hueMode.CUSTOM;
  recipe.hue.customTurns = [0.98, 1.02, 0.73, 0.4];
  const { values, customHueOffsets } = controlsFor(recipe);
  const back = paletteRecipeFromControls(recipe,
    paletteControlReadings((id) => values[id], customHueOffsets));

  assertRecipeClose(back.hue.customTurns, recipe.hue.customTurns, 'customTurns');
  assert.ok(Math.abs(back.hue.baseTurns - 0.98) < 1e-9,
    'the base hue follows the first key the wheel edits');
});

test('the readings convert the units the controls are labelled in', () => {
  const { values, customHueOffsets } = controlsFor(defaultPaletteRecipe());
  values[PALETTE_CONTROL_IDS.baseHueDegrees] = '90';
  values[PALETTE_CONTROL_IDS.spreadDegrees] = '36';
  const readings = paletteControlReadings((id) => values[id], customHueOffsets);

  assert.equal(readings.baseTurns, 0.25, 'degrees read as turns');
  assert.equal(readings.spreadTurns, 0.1);
  assert.deepEqual(readings.window, { offset: 0, span: 1 });
  assert.equal(readings.customHueOffsets, customHueOffsets,
    'the wheel keys are page state, not a control reading');
});

test('a control the page does not carry is refused rather than read as NaN', () => {
  const { values, customHueOffsets } = controlsFor(defaultPaletteRecipe());
  delete values[PALETTE_CONTROL_IDS.headroom];

  assert.throws(() => paletteControlReadings((id) => values[id], customHueOffsets),
    /Palette control gen_headroom is missing/);
});

test('every control on the roster is read, and no control is read twice', () => {
  const ids = Object.values(PALETTE_CONTROL_IDS);
  assert.equal(new Set(ids).size, ids.length, 'two readings cannot share a control');

  const { values, customHueOffsets } = controlsFor(defaultPaletteRecipe());
  const asked = [];
  paletteControlReadings((id) => {
    asked.push(id);
    return values[id];
  }, customHueOffsets);
  assert.deepEqual([...asked].sort(), [...ids].sort(),
    'a rostered control the readings never ask for is decorative');
});

test('enum ordinals name the option that carries them', () => {
  assert.equal(paletteEnumName('domain', PaletteV4.domain.LOOP), 'LOOP');
  assert.equal(paletteEnumName('curve', PaletteV4.curve.CUSTOM), 'CUSTOM');
  assert.equal(paletteEnumName('harmony', PaletteV4.harmony.MONOCHROMATIC),
    'MONOCHROMATIC');
});

test('an ordinal or a group the page has no option for is refused', () => {
  assert.throws(() => paletteEnumName('domain', 99), /Unknown domain value: 99/);
  assert.throws(() => paletteEnumName('cadence', 0), /Unknown palette enum: cadence/);

  const recipe = defaultPaletteRecipe();
  recipe.domain = 42;
  assert.throws(() => paletteControlsFromRecipe(recipe), /Unknown domain value: 42/);
});

test('a control value no enum member carries is refused, not marshalled', () => {
  assert.equal(paletteEnumOrdinal('domain', 'LOOP'), PaletteV4.domain.LOOP);
  assert.throws(() => paletteEnumOrdinal('domain', 'RENAMED'),
    /Unknown domain member: RENAMED/);
  assert.throws(() => paletteEnumOrdinal('cadence', 'LOOP'),
    /Unknown palette enum: cadence/);
  // Object.prototype carries a value under every inherited name.
  assert.throws(() => paletteEnumOrdinal('domain', 'constructor'),
    /Unknown domain member: constructor/);

  assert.throws(() => paletteRecipeFromControls(defaultPaletteRecipe(),
    { ...CONTROL_READINGS, harmony: 'TRIADIQUE' }),
  /Unknown harmony member: TRIADIQUE/);
  assert.throws(() => paletteRecipeFromControls(defaultPaletteRecipe(),
    { ...CONTROL_READINGS, chromaCurve: 'S_CURVE' }),
  /Unknown curve member: S_CURVE/);
});

// The marshal reads these option values straight through, so a renamed member
// or a typo in the markup only shows up as a refused recipe at export time.
const ENUM_SELECT_GROUPS = {
  gen_shape: 'domain',
  gen_path: 'colorPath',
  gen_hue_mode: 'hueMode',
  gen_harmony: 'harmony',
  gen_direction: 'direction',
  gen_easing: 'easing',
  gen_brightness: 'curve',
  gen_chroma_curve: 'curve',
};

test('every generative <select> option names a PaletteV4 member', () => {
  let options = 0;
  for (const [id, group] of Object.entries(ENUM_SELECT_GROUPS)) {
    const block = PALETTES_HTML.match(
      new RegExp(`<select[^>]*\\bid="${id}"[\\s\\S]*?</select>`))?.[0];
    assert.ok(block, `palettes.html must carry a ${id} select`);
    const values = [...block.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(values.length > 0, `${id} carries no options`);
    for (const value of values) {
      assert.equal(typeof paletteEnumOrdinal(group, value), 'number',
        `${id} option "${value}" is not a PaletteV4.${group} member`);
    }
    options += values.length;
  }
  assert.ok(options >= 30, 'the enum selects must still cover the tab');
});

test('the recipe window is clamped to a span its controls can express', () => {
  assert.deepEqual(clampRecipeWindow(0.2, 0.5), { offset: 0.2, span: 0.5 });
  assert.deepEqual(clampRecipeWindow(0.9, 0.5), { offset: 0.5, span: 0.5 },
    'the window cannot start past the end of the palette');
  assert.deepEqual(clampRecipeWindow(-1, 2), { offset: 0, span: 1 });
  assert.deepEqual(clampRecipeWindow(0.5, 0), { offset: 0.5, span: 0.01 },
    'an empty span is widened to the narrowest the slider offers');
});

test('zooming the recipe window composes onto the window already shown', () => {
  const first = zoomRecipeWindow({ offset: 0, span: 1 }, 0.4, 0.6);
  assert.equal(first.offset, 0.4);
  assert.ok(Math.abs(first.span - 0.2) < 1e-12);

  const nested = zoomRecipeWindow({ offset: 0.4, span: 0.2 }, 0.5, 1);
  assert.ok(Math.abs(nested.offset - 0.5) < 1e-12);
  assert.ok(Math.abs(nested.span - 0.1) < 1e-12);
});

test('a recipe zoom reads the same in either drag direction and stays in range', () => {
  assert.deepEqual(zoomRecipeWindow({ offset: 0, span: 1 }, 0.6, 0.4),
    zoomRecipeWindow({ offset: 0, span: 1 }, 0.4, 0.6));
  assert.deepEqual(zoomRecipeWindow({ offset: 0, span: 1 }, -0.5, 1.5),
    { offset: 0, span: 1 }, 'a drag off either end still names the whole palette');
  assert.equal(zoomRecipeWindow({ offset: 0, span: 0.02 }, 0.5, 0.5).span, 0.01,
    'a zoom onto nothing keeps the narrowest window the controls hold');
});

test('a short strip drag copies a color and a long one zooms', () => {
  assert.deepEqual(stripDragIntent(0.5, 0.5 + STRIP_DRAG_THRESHOLD / 2),
    { intent: 'copy', start: 0.5, end: 0.5 + STRIP_DRAG_THRESHOLD / 2 });
  assert.equal(stripDragIntent(0.2, 0.8).intent, 'zoom');
  assert.deepEqual(stripDragIntent(0.8, 0.2),
    { intent: 'zoom', start: 0.2, end: 0.8 },
    'a right-to-left drag names the same window');
  assert.equal(stripDragIntent(0.2, 0.21, 0.05).intent, 'copy',
    'the threshold is the caller’s to set');
});

test('the strip says which window it is showing only once it is zoomed', () => {
  const full = paletteStripView({ start: 0, end: 1 });
  assert.equal(full.zoomed, false);
  assert.equal(full.heading, 'sRGB Palette (t ∈ [0, 1])');
  assert.match(full.ariaLabel, /^Palette strip, t 0\.000 to 1\.000\./);

  const zoomed = paletteStripView({ start: 0.25, end: 0.5 });
  assert.equal(zoomed.zoomed, true);
  assert.equal(zoomed.heading, 'sRGB Palette (t ∈ [0.250, 0.500])');
  assert.match(zoomed.ariaLabel, /t 0\.250 to 0\.500\. Press Enter/);
});

test('the channel-curve plot names the window it is plotting', () => {
  assert.equal(waveGraphLabel({ start: 0, end: 1 }),
    'Plot of the sRGB red, green and blue channel curves against normalized '
    + 'palette coordinate t, t 0.000 to 1.000.');
  assert.match(waveGraphLabel({ start: 0.25, end: 0.5 }), /t 0\.250 to 0\.500\.$/);
});

test('a constant axis is edited as one value spanning the whole range', () => {
  const state = axisControlState({
    curve: 'CONSTANT', minimum: '0.62', maximum: '0.62',
    label: 'Relative Chroma', shortLabel: 'Chroma',
  });

  assert.equal(state.constant, true);
  assert.equal(state.minimumLabel, 'Chroma');
  assert.equal(state.minimumName, 'Relative Chroma',
    'a single value is named for the axis, not for an end of it');
  assert.equal(state.maximumName, 'Maximum Relative Chroma');
  assert.deepEqual(
    [state.minimumMin, state.minimumMax, state.maximumMin, state.maximumMax],
    ['0', '1', '0', '1']);
});

test('a varying axis pins each endpoint against the other so they cannot cross', () => {
  const state = axisControlState({
    curve: 'ASCENDING', minimum: '0.2', maximum: '0.8',
    label: 'Lightness', shortLabel: 'Lightness',
  });

  assert.equal(state.constant, false);
  assert.equal(state.minimumName, 'Minimum Lightness');
  assert.deepEqual(
    [state.minimumMin, state.minimumMax, state.maximumMin, state.maximumMax],
    ['0', '0.8', '0.2', '1']);
  assert.deepEqual([state.minimumText, state.maximumText], ['0.20', '0.80']);
});

test('both axes the tab edits by their endpoints are on the roster', () => {
  assert.deepEqual(Object.keys(PALETTE_AXIS_CONTROLS), ['lightness', 'chroma']);
  for (const axis of Object.values(PALETTE_AXIS_CONTROLS)) {
    for (const id of [axis.curve, `${axis.prefix}_minimum`, `${axis.prefix}_maximum`])
      assert.match(PALETTES_HTML, new RegExp(`\\bid="${id}"`),
        `palettes.html must carry a ${id} control`);
  }
});
