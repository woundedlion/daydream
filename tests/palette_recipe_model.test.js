import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaletteRecipeModel } from '../src/workbench/palettes/palette_recipe_model.js';
import {
  PaletteV4, PALETTE_RECIPE_PRESETS, customHueKeyState, defaultPaletteRecipe,
  movedHueKeyOffset, wrapTurns, zoomRecipeWindow,
} from '../src/workbench/palettes/palette_controls.js';
import { generativePaletteCpp } from '../src/workbench/palettes/palette_math.js';

/**
 * @param {PaletteRecipeModel} model - The model to export.
 * @returns {string} The code the export panel shows for it.
 */
const exported = (model) => generativePaletteCpp(model.recipe());

test('a new model holds the default recipe', () => {
  assert.deepEqual(new PaletteRecipeModel().snapshot(), defaultPaletteRecipe());
});

test('a loaded preset exports as itself', () => {
  for (const [name, preset] of Object.entries(PALETTE_RECIPE_PRESETS)) {
    const model = new PaletteRecipeModel(preset());
    assert.equal(exported(model), generativePaletteCpp(preset()), name);
  }
});

test('views keep their identity across operations', () => {
  const model = new PaletteRecipeModel();
  const recipe = model.recipe();
  const offsets = model.customHueOffsets();
  const window = model.window;
  const lightness = model.axisEndpoints('lightness');
  model.setWindow(0.2, 0.5);
  model.applyHueModeTransition('CUSTOM');
  model.moveHueKey(1, 0.4);
  model.setAxisEndpoints('lightness', 0.3, 0.3);
  assert.equal(model.recipe(), recipe);
  assert.equal(model.customHueOffsets(), offsets);
  assert.equal(model.window, window);
  assert.equal(model.axisEndpoints('lightness'), lightness);
  assert.equal(recipe.input.offset, 0.2);
  assert.equal(recipe.hue.mode, PaletteV4.hueMode.CUSTOM);
  assert.equal(lightness.minimum, 0.3);
});

test('a snapshot taken before an operation is unchanged after it', () => {
  const model = new PaletteRecipeModel();
  const before = model.snapshot();
  model.setChoice('domain', 'MIRROR');
  model.setWindow(0.1, 0.5);
  model.applyHueModeTransition('CUSTOM');
  model.moveHueKey(0, 0.5);
  assert.deepEqual(before, defaultPaletteRecipe());
  assert.notDeepEqual(model.snapshot(), before);
  before.hue.customTurns[0] = 9;
  assert.notEqual(model.recipe().hue.customTurns[0], 9);
});

test('a controller built before loadRecipe sees the loaded state', () => {
  const model = new PaletteRecipeModel();
  const controller = { domain: () => model.recipe().domain, base: () => model.baseHueTurns };
  const preset = PALETTE_RECIPE_PRESETS.isolightSpectralLoop();
  preset.hue.baseTurns = 0.3;
  model.loadRecipe(preset);
  assert.equal(controller.domain(), PaletteV4.domain.LOOP);
  assert.equal(controller.base(), 0.3);
});

test('loading copies the recipe it is given', () => {
  const recipe = defaultPaletteRecipe();
  const model = new PaletteRecipeModel(recipe);
  recipe.domain = PaletteV4.domain.LOOP;
  recipe.hue.customTurns[3] = 0.5;
  model.setWindow(0, 1);
  assert.equal(model.recipe().domain, PaletteV4.domain.STRAIGHT);
  assert.equal(model.recipe().hue.customTurns[3], 0);
});

test('a recipe with an unknown ordinal is refused and the model kept', () => {
  const model = new PaletteRecipeModel();
  const recipe = defaultPaletteRecipe();
  recipe.domain = 42;
  assert.throws(() => model.loadRecipe(recipe), /Unknown domain value: 42/);
  assert.deepEqual(model.snapshot(), defaultPaletteRecipe());
});

test('choices and amounts write their readings and reject the wrong kind', () => {
  const model = new PaletteRecipeModel();
  model.setChoice('harmony', 'TRIADIC');
  model.setChoice('easing', 'LINEAR');
  model.setAmount('hueTorsion', 1.5);
  model.setAmount('spreadTurns', 0.2);
  assert.equal(model.reading('harmony'), 'TRIADIC');
  assert.equal(model.recipe().hue.harmony, PaletteV4.harmony.TRIADIC);
  assert.equal(model.recipe().easing, PaletteV4.easing.LINEAR);
  assert.equal(model.recipe().hueTorsion, 1.5);
  assert.equal(model.reading('spreadTurns'), 0.2);
  assert.equal(model.recipe().hue.spreadTurns, defaultPaletteRecipe().hue.spreadTurns,
    'a fixed-fraction harmony canonicalizes its spread');

  assert.throws(() => model.setChoice(/** @type {any} */ ('hueMode'), 'SWEEP'),
    /Not a palette choice reading: hueMode/);
  assert.throws(() => model.setChoice('harmony', 'TRIADIQUE'), /Unknown harmony member/);
  assert.throws(() => model.setAmount(/** @type {any} */ ('baseTurns'), 0.5),
    /Not a palette amount reading: baseTurns/);
  assert.equal(model.reading('hueMode'), 'HARMONY');
  assert.equal(model.baseHueTurns, 0);
});

test('the base hue wraps and nudges', () => {
  const model = new PaletteRecipeModel();
  model.setBaseHue(1.25);
  assert.equal(model.baseHueTurns, 0.25);
  assert.equal(model.recipe().hue.baseTurns, 0.25);
  model.nudgeBaseHue(-0.5);
  assert.equal(model.baseHueTurns, 0.75);
});

test('the span limits the window offset', () => {
  const model = new PaletteRecipeModel();
  model.setWindow(0.7, 0.2);
  assert.deepEqual({ ...model.window }, { offset: 0.7, span: 0.2 });
  model.setWindow(model.window.offset, 0.5);
  assert.deepEqual({ ...model.window }, { offset: 0.5, span: 0.5 });
  model.setWindow(-1, 0);
  assert.deepEqual({ ...model.window }, { offset: 0, span: 0.01 });
  assert.deepEqual({ ...model.recipe().input }, { offset: 0, span: 0.01 });
});

test('a CONSTANT curve collapses its endpoints and keeps them together', () => {
  const model = new PaletteRecipeModel(PALETTE_RECIPE_PRESETS.tonalMonochrome());
  model.setAxisEndpoints('lightness', 0.2, 0.6);
  assert.deepEqual({ ...model.axisEndpoints('lightness') }, { minimum: 0.2, maximum: 0.6 });
  model.setAxisCurve('lightness', 'CONSTANT');
  assert.deepEqual({ ...model.axisEndpoints('lightness') }, { minimum: 0.4, maximum: 0.4 });
  model.setAxisEndpoints('lightness', 0.7, 0.1);
  assert.deepEqual({ ...model.axisEndpoints('lightness') }, { minimum: 0.7, maximum: 0.7 });
  assert.equal(model.recipe().lightness.center, 0.7);
  assert.equal(model.recipe().lightness.range, 0);
  model.setAxisCurve('chroma', 'CUP');
  assert.equal(model.reading('chromaCurve'), 'CUP');
  assert.equal(model.recipe().chroma.curve, PaletteV4.curve.CUP);

  assert.throws(() => model.setAxisCurve('lightness', 'S_CURVE'), /Unknown curve member/);
  assert.throws(() => model.axisEndpoints(/** @type {any} */ ('hue')), /Unknown palette axis: hue/);
  assert.throws(() => model.setAxisEndpoints(/** @type {any} */ ('hue'), 0, 1), /Unknown palette axis/);
});

test('hue mode transitions hand off into CUSTOM unless a loop sweep would be lost', () => {
  const model = new PaletteRecipeModel();
  assert.equal(model.applyHueModeTransition('HARMONY'), true);
  assert.equal(model.applyHueModeTransition('SWEEP'), true);
  assert.equal(model.recipe().hue.mode, PaletteV4.hueMode.SWEEP);

  const sweep = PALETTE_RECIPE_PRESETS.isolightSpectralLoop();
  sweep.hue.sweepTurns = 3;
  model.loadRecipe(sweep);
  const before = model.snapshot();
  assert.equal(model.applyHueModeTransition('CUSTOM'), false);
  assert.equal(model.activateCustomHues(), false);
  assert.deepEqual(model.snapshot(), before);

  model.loadRecipe(defaultPaletteRecipe());
  const state = customHueKeyState(model.snapshot());
  assert.equal(model.applyHueModeTransition('CUSTOM'), true);
  assert.equal(model.reading('hueMode'), 'CUSTOM');
  assert.deepEqual([...model.customHueOffsets()], state.offsets);
  assert.equal(model.baseHueTurns, state.baseTurns);
  model.moveHueKey(2, 0.6);
  const authored = [...model.customHueOffsets()];
  assert.equal(model.applyHueModeTransition('CUSTOM'), true);
  assert.deepEqual([...model.customHueOffsets()], authored, 'staying in CUSTOM keeps the authored keys');
  assert.throws(() => model.applyHueModeTransition('SPIRAL'), /Unknown hueMode member/);
});

test('a LOOP sweep rounds to whole turns inside the domain, mode and sweep operations', () => {
  const model = new PaletteRecipeModel();
  model.setAmount('sweepTurns', 2.4);
  model.applyHueModeTransition('SWEEP');
  assert.equal(model.reading('sweepTurns'), 2.4);
  model.setChoice('domain', 'LOOP');
  assert.equal(model.reading('sweepTurns'), 2);
  model.setAmount('sweepTurns', -2.5);
  assert.equal(model.reading('sweepTurns'), -3);
  model.setChoice('domain', 'MIRROR');
  model.setAmount('sweepTurns', 1.5);
  assert.equal(model.recipe().hue.sweepTurns, 1.5);
  model.applyHueModeTransition('HARMONY');
  model.setChoice('domain', 'LOOP');
  assert.equal(model.reading('sweepTurns'), 1.5, 'only a sweep closes on a whole turn');
  model.applyHueModeTransition('SWEEP');
  assert.equal(model.reading('sweepTurns'), 2);
});

test('hue keys move to the nearest representative and nudge by turns', () => {
  const model = new PaletteRecipeModel();
  model.setBaseHue(0.98);
  model.applyHueModeTransition('CUSTOM');
  const base = model.baseHueTurns;
  const offset = model.customHueOffsets()[0];
  model.moveHueKey(0, 0.02);
  assert.equal(model.customHueOffsets()[0], movedHueKeyOffset(base, offset, 0.02));
  const moved = model.customHueOffsets()[0];
  model.nudgeHueKey(0, 0.1);
  assert.equal(model.customHueOffsets()[0],
    movedHueKeyOffset(base, moved, wrapTurns(base + moved + 0.1)));
  assert.equal(model.recipe().hue.customTurns[0], wrapTurns(base) + model.customHueOffsets()[0]);
  model.applyHueModeTransition('HARMONY');
  assert.deepEqual([...model.recipe().hue.customTurns], [0, 0, 0, 0],
    'leaving CUSTOM restores the template keys');
});

test('scenario: preset, CONSTANT axis curve, zoomed window, export', () => {
  const model = new PaletteRecipeModel();
  model.loadRecipe(PALETTE_RECIPE_PRESETS.tonalMonochrome());
  model.setAxisCurve('lightness', 'CONSTANT');
  const zoom = zoomRecipeWindow(model.window, 0.25, 0.75);
  model.setWindow(zoom.offset, zoom.span);

  const expected = PALETTE_RECIPE_PRESETS.tonalMonochrome();
  expected.lightness.curve = PaletteV4.curve.CONSTANT;
  expected.lightness.center = 0.52;
  expected.lightness.range = 0;
  expected.input = { offset: 0.25, span: 0.5 };
  const code = exported(model);
  assert.equal(code, generativePaletteCpp(expected));
  assert.match(code, /recipe\.lightness\.curve = AxisCurve::CONSTANT;/);
  assert.match(code, /recipe\.input\.offset = 0\.25f;\nrecipe\.input\.span = 0\.5f;/);
});

test('scenario: CUSTOM hue mode, key drag, base nudge, export', () => {
  const model = new PaletteRecipeModel();
  const start = customHueKeyState(defaultPaletteRecipe());
  model.applyHueModeTransition('CUSTOM');
  model.moveHueKey(1, 0.5);
  model.nudgeBaseHue(0.1);

  const offsets = [...start.offsets];
  offsets[1] = movedHueKeyOffset(start.baseTurns, offsets[1], 0.5);
  const base = wrapTurns(start.baseTurns + 0.1);
  const expected = defaultPaletteRecipe();
  expected.hue.mode = PaletteV4.hueMode.CUSTOM;
  expected.hue.customTurns = [base + offsets[0], base + offsets[1], base + offsets[2], 0];
  const code = exported(model);
  assert.equal(code, generativePaletteCpp(expected));
  assert.match(code, /recipe\.hue\.mode = HueMode::CUSTOM;/);
  assert.match(code, /recipe\.hue\.base_turns = 0\.0f;/);
  assert.deepEqual([...model.customHueOffsets()], offsets);
});

test('scenario: LOOP domain under SWEEP, then the preset reloads clean', () => {
  const preset = PALETTE_RECIPE_PRESETS.balancedAnalogous();
  const model = new PaletteRecipeModel(preset);
  model.setChoice('domain', 'LOOP');
  model.applyHueModeTransition('SWEEP');
  model.setAmount('sweepTurns', 2.4);
  assert.match(exported(model), /recipe\.domain = PaletteDomain::LOOP;/);
  assert.match(exported(model), /recipe\.hue\.sweep_turns = 2\.0f;/);

  model.loadRecipe(preset);
  assert.equal(exported(model), generativePaletteCpp(preset));
  assert.equal(model.reading('domain'), 'STRAIGHT');
  assert.equal(model.reading('hueMode'), 'HARMONY');
});
