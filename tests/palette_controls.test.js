import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  paletteTabFromSearch, paletteTabUrl,
  createPaletteViewport, recipeForViewport, axisEndpoints, axisFromEndpoints,
  lockedGroupMove,
  PaletteV4, defaultPaletteRecipe, PALETTE_RECIPE_PRESETS, createPaletteRecipeState,
  paletteRecipeAvailability,
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

test('a palette viewport composes into a detached recipe input window', () => {
  const recipe = defaultPaletteRecipe();
  recipe.input = { offset: 0.1, span: 0.8 };
  const exported = recipeForViewport(recipe, { start: 0.25, end: 0.75 });

  assert.deepEqual(exported.input, { offset: 0.30000000000000004, span: 0.4 });
  assert.deepEqual(recipe.input, { offset: 0.1, span: 0.8 });
  assert.notEqual(exported, recipe);
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
    colorPath: true,
    hueDirection: true,
    chromaEndpoints: true,
    chromaMaximum: false,
    lightnessEndpoints: true,
    lightnessMaximum: false,
  });

  recipe.hue.mode = PaletteV4.hueMode.SWEEP;
  assert.equal(paletteRecipeAvailability(recipe).harmony, false);

  recipe.hue.mode = PaletteV4.hueMode.HARMONY;
  recipe.hue.harmony = PaletteV4.harmony.MONOCHROMATIC;
  assert.equal(paletteRecipeAvailability(recipe).colorPath, false);
  assert.equal(paletteRecipeAvailability(recipe).hueDirection, false);

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
  assert.equal(availability.baseHue, false);
  assert.equal(availability.hueDirection, false);
  assert.equal(availability.lightnessEndpoints, false);
  assert.equal(availability.chromaEndpoints, false);
});

test('recipe state rejects stale compiler results', () => {
  const state = createPaletteRecipeState();
  const oldRevision = state.value.revision;
  const revision = state.edit(recipe => { recipe.hue.baseTurns = 0.25; });

  assert.equal(state.applyCompileResult(oldRevision, {
    status: { code: 0 }, canonicalRecipe: defaultPaletteRecipe(),
  }), false);
  assert.equal(state.applyCompileResult(revision, {
    status: { code: 0 }, canonicalRecipe: state.value.draft,
  }), true);
  assert.equal(state.value.canonical.hue.baseTurns, 0.25);
});

test('recipe state never exposes mutable internal values', () => {
  const state = createPaletteRecipeState();
  const view = state.value;
  view.draft.hue.baseTurns = 0.75;
  assert.equal(state.value.draft.hue.baseTurns, 0);

  state.replace(PALETTE_RECIPE_PRESETS.tonalMonochrome());
  assert.equal(state.value.canonical, null);
  assert.equal(state.value.status, null);
});
