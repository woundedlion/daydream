import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './helpers/fake_dom.js';
import { createHueKeyWheel } from '../src/workbench/palettes/hue_key_wheel_controller.js';
import { PaletteRecipeModel } from '../src/workbench/palettes/palette_recipe_model.js';
import {
  PaletteV4, PALETTE_RECIPE_PRESETS, customHueKeyState, defaultPaletteRecipe, hueKeyState,
  movedHueKeyOffset, wrapTurns,
} from '../src/workbench/palettes/palette_controls.js';
import { hueKeyDegrees, hueKeyMarkerPoints, wheelTurnAt } from '../src/workbench/palettes/palette_wheel.js';

restoreDocumentAfterEach();

const SIZE = 200;

/**
 * Builds a wheel over a fake canvas, with a painter that reports the markers
 * the real geometry places.
 * @param {object} [recipe] - The recipe the model starts from.
 * @returns {object} The wheel and everything it was wired to.
 */
function setup(recipe = defaultPaletteRecipe()) {
  const body = fakeElement('body', { connected: true });
  installDocument({ createElement: (tag) => fakeElement(tag), activeElement: null, body });
  const canvas = Object.assign(fakeElement('canvas', { connected: true }), {
    width: SIZE, height: SIZE, clientWidth: SIZE, clientHeight: SIZE,
    offsetWidth: SIZE, offsetHeight: SIZE,
  });
  const group = fakeElement('div', { connected: true });
  const status = fakeElement('p');
  const model = new PaletteRecipeModel(recipe);
  const draws = [];
  const painter = {
    draw: (view) => {
      draws.push({ ...view, state: { baseTurns: view.state.baseTurns, offsets: [...view.state.offsets] } });
      return {
        points: hueKeyMarkerPoints(view.state, SIZE, SIZE),
        degrees: hueKeyDegrees(view.state), scale: 1,
      };
    },
  };
  const counts = { updates: 0, recipeChanges: 0 };
  const wheel = createHueKeyWheel({
    model, canvas, group, status, painter,
    scheduleUpdate: () => { counts.updates++; },
    onRecipeChange: () => { counts.recipeChanges++; },
  });
  const handles = group.children;
  return { wheel, model, canvas, group, status, draws, counts, handles };
}

/**
 * @param {number} turn - A hue.
 * @returns {{clientX: number, clientY: number}} The pointer position of a marker at it.
 */
function pointAt(turn) {
  const [point] = hueKeyMarkerPoints({ baseTurns: turn, offsets: [0] }, SIZE, SIZE);
  return { clientX: point.x, clientY: point.y };
}

/**
 * @param {any} target - Element to dispatch on.
 * @param {string} type - Pointer event type.
 * @param {{clientX: number, clientY: number}} position - Where.
 * @returns {void}
 */
function pointer(target, type, position) {
  target.dispatch(type, { pointerId: 1, isPrimary: true, button: 0, ...position });
}

/**
 * @param {any} handle - A key handle.
 * @param {string} key - The key pressed.
 * @param {boolean} [shiftKey] - Whether Shift was held.
 * @returns {{prevented: boolean}} Whether the press was claimed.
 */
function press(handle, key, shiftKey = false) {
  return { prevented: handle.dispatch('keydown', { key, shiftKey }).defaultPrevented };
}

test('the wheel draws harmony anchors as compiled and CUSTOM keys from the model', () => {
  const { wheel, model, draws, handles } = setup();
  wheel.draw(model.recipe());
  assert.deepEqual(draws[0].state, hueKeyState(defaultPaletteRecipe()));
  assert.equal(draws[0].lightness, 0.62);
  assert.equal(handles.length, 4);
  assert.deepEqual(handles.map((handle) => handle.hidden), [false, false, false, true]);

  model.applyHueModeTransition('SWEEP');
  wheel.draw(model.recipe());
  assert.deepEqual(handles.map((handle) => handle.hidden), [false, false, true, true],
    'a two-key sweep hides the third handle');
  assert.equal(handles[1].getAttribute('aria-valuetext'), `${hueKeyDegrees(draws[1].state)[1]} degrees`);

  model.applyHueModeTransition('HARMONY');
  model.applyHueModeTransition('CUSTOM');
  model.moveHueKey(1, 0.5);
  const recipe = structuredClone(model.snapshot());
  recipe.lightness.curve = PaletteV4.curve.CUSTOM;
  recipe.lightness.custom = [0.1, 0.4, 0.7, 0];
  recipe.hue.customTurns = [0.9, 0.9, 0.9, 0];
  wheel.draw(recipe);
  assert.deepEqual(draws[2].state.offsets, [...model.customHueOffsets()]);
  assert.equal(draws[2].state.baseTurns, model.baseHueTurns);
  assert.ok(Math.abs(draws[2].lightness - 0.4) < 1e-12, 'CUSTOM lightness averages the authored keys');
});

test('a hue-key drag grabs a marker, follows the pointer, and lets go', () => {
  const { wheel, model, canvas, counts, draws } = setup();
  model.applyHueModeTransition('CUSTOM');
  wheel.draw(model.recipe());
  const turn = model.baseHueTurns + model.customHueOffsets()[2];

  pointer(canvas, 'pointermove', pointAt(turn));
  assert.equal(canvas.style.cursor, 'grab');
  pointer(canvas, 'pointermove', pointAt(turn + 0.5));
  assert.equal(canvas.style.cursor, 'default');

  pointer(canvas, 'pointerdown', pointAt(turn));
  assert.equal(canvas.style.cursor, 'grabbing');
  wheel.draw(model.recipe());
  assert.equal(draws.at(-1).selectedKey, 2, 'the grabbed key is selected');
  assert.equal(draws.at(-1).activeKey, 2);
  const before = model.customHueOffsets()[2];
  const target = pointAt(wrapTurns(turn + 0.2));
  pointer(canvas, 'pointermove', target);
  const landed = wheelTurnAt(target.clientX, target.clientY, SIZE, SIZE);
  assert.equal(model.customHueOffsets()[2], movedHueKeyOffset(model.baseHueTurns, before, landed));
  pointer(canvas, 'pointerup', target);
  assert.equal(canvas.style.cursor, 'default');
  assert.equal(counts.recipeChanges, 0, 'a CUSTOM drag needs no handoff');

  const settled = [...model.customHueOffsets()];
  pointer(canvas, 'pointerdown', { clientX: SIZE / 2, clientY: SIZE / 2 });
  pointer(canvas, 'pointermove', pointAt(turn));
  assert.deepEqual([...model.customHueOffsets()], settled, 'a press off every marker grabs nothing');
});

test('dragging a harmony key hands the recipe off to CUSTOM', () => {
  const { wheel, model, canvas, counts, status } = setup();
  wheel.draw(model.recipe());
  const anchors = hueKeyState(defaultPaletteRecipe());
  pointer(canvas, 'pointerdown', pointAt(anchors.baseTurns + anchors.offsets[0]));
  pointer(canvas, 'pointermove', pointAt(0.3));
  assert.equal(model.reading('hueMode'), 'CUSTOM');
  assert.equal(counts.recipeChanges, 1);
  assert.equal(status.textContent, '');
});

test('a drag that cannot keep a loop sweep stops and says why', () => {
  const recipe = PALETTE_RECIPE_PRESETS.isolightSpectralLoop();
  recipe.hue.sweepTurns = 3;
  const { wheel, model, canvas, status } = setup(recipe);
  wheel.draw(model.recipe());
  const keys = hueKeyState(model.snapshot());
  const before = model.snapshot();
  pointer(canvas, 'pointerdown', pointAt(keys.baseTurns + keys.offsets[0]));
  pointer(canvas, 'pointermove', pointAt(0.3));
  assert.match(status.textContent, /loop sweep cannot be preserved/);
  assert.deepEqual(model.snapshot(), before);
  assert.equal(canvas.style.cursor, 'default', 'the stopped drag ends');
  pointer(canvas, 'pointermove', pointAt(0.5));
  assert.deepEqual(model.snapshot(), before);
  wheel.clearStatus();
  assert.equal(status.textContent, '');
});

test('a key handle nudges its key and focus selects it', () => {
  const { wheel, model, handles, counts } = setup();
  model.applyHueModeTransition('CUSTOM');
  wheel.draw(model.recipe());
  handles[1].dispatch('focus');
  assert.equal(counts.updates, 1);
  const before = model.customHueOffsets()[1];
  const turn = model.baseHueTurns + before;
  assert.equal(press(handles[1], 'ArrowRight', true).prevented, true);
  assert.equal(model.customHueOffsets()[1],
    movedHueKeyOffset(model.baseHueTurns, before, wrapTurns(turn + 10 / 360)));
  assert.equal(press(handles[1], 'Enter').prevented, false);
});

test('the selection stays on a key the wheel still draws', () => {
  const { wheel, model, handles, draws } = setup();
  wheel.draw(model.recipe());
  handles[2].dispatch('focus');
  model.applyHueModeTransition('SWEEP');
  wheel.draw(model.recipe());
  wheel.draw(model.recipe());
  assert.equal(draws.at(-1).selectedKey, 1);
});

test('a keyboard resample follows the selected hue key through later nudges', () => {
  const recipe = defaultPaletteRecipe();
  recipe.hue.mode = PaletteV4.hueMode.SWEEP;
  recipe.hue.sweepTurns = 0.5;
  const { wheel, model, handles, draws } = setup(recipe);
  wheel.draw(model.recipe());
  globalThis.document.activeElement = handles[1];
  press(handles[1], 'ArrowRight');
  assert.equal(model.reading('hueMode'), 'CUSTOM');
  const resampled = customHueKeyState(recipe);
  assert.equal(draws.at(-1).selectedKey, 2, 'the sweep end is the third custom key');
  assert.equal(globalThis.document.activeElement, handles[2]);
  assert.ok(Math.abs(model.customHueOffsets()[2] - (resampled.offsets[2] + 1 / 360)) < 1e-12);
  assert.equal(model.customHueOffsets()[1], resampled.offsets[1]);
});

test('a dropped hue selection is redrawn without nudging its replacement', () => {
  const recipe = defaultPaletteRecipe();
  recipe.hue.harmony = PaletteV4.harmony.SQUARE;
  const { wheel, model, handles, counts, status } = setup(recipe);
  wheel.draw(model.recipe());
  const before = model.snapshot();
  const record = press(handles[1], 'ArrowRight');
  assert.equal(record.prevented, true);
  assert.equal(model.reading('hueMode'), 'HARMONY');
  assert.deepEqual(model.snapshot(), before);
  assert.match(status.textContent, /Choose another key/);
  assert.equal(counts.updates, 1);
});

test('the hue dropdown keeps the previous mode after a refused handoff', () => {
  const recipe = PALETTE_RECIPE_PRESETS.isolightSpectralLoop();
  recipe.hue.sweepTurns = 3;
  const { wheel, model, status } = setup(recipe);
  wheel.onHueModeChange('CUSTOM');
  assert.equal(model.reading('hueMode'), 'SWEEP');
  assert.equal(model.reading('sweepTurns'), 3);
  assert.match(status.textContent, /loop sweep cannot be preserved/);
  wheel.onHueModeChange('HARMONY');
  assert.equal(model.reading('hueMode'), 'HARMONY');
});

test('the hue dropdown resamples an authored harmony into CUSTOM from the first key', () => {
  const recipe = defaultPaletteRecipe();
  Object.assign(recipe.hue, {
    harmony: PaletteV4.harmony.SPLIT_COMPLEMENTARY, spreadTurns: 0.2, baseTurns: 0.25,
  });
  const { wheel, model, canvas, counts, draws } = setup(recipe);
  wheel.draw(model.recipe());
  const anchors = hueKeyState(recipe);
  pointer(canvas, 'pointerdown', pointAt(anchors.baseTurns + anchors.offsets[2]));
  pointer(canvas, 'pointerup', pointAt(anchors.baseTurns + anchors.offsets[2]));
  wheel.onHueModeChange('CUSTOM');
  const expected = customHueKeyState(recipe);
  assert.equal(model.reading('hueMode'), 'CUSTOM');
  assert.deepEqual([...model.customHueOffsets()], expected.offsets);
  assert.equal(model.baseHueTurns, expected.baseTurns);
  assert.equal(counts.recipeChanges, 1);
  wheel.draw(model.recipe());
  assert.equal(draws.at(-1).selectedKey, 0);
  assert.equal(draws.at(-1).activeKey, null);
});

test('base hue arrow keys step in useful degrees without changing the recipe mode', () => {
  const { wheel, model, counts } = setup();
  model.setBaseHue(359.25 / 360);
  let prevented = 0;
  const keydown = (key, shiftKey = false) =>
    wheel.onBaseHueKeyDown(/** @type {any} */ ({ key, shiftKey, preventDefault() { prevented++; } }));
  const degrees = () => model.baseHueTurns * 360;
  keydown('ArrowRight');
  assert.ok(Math.abs(degrees() - 0.25) < 1e-8);
  keydown('ArrowRight', true);
  assert.ok(Math.abs(degrees() - 10.25) < 1e-8);
  keydown('ArrowLeft');
  assert.ok(Math.abs(degrees() - 9.25) < 1e-8);
  keydown('Enter');
  assert.equal(prevented, 3);
  assert.equal(counts.recipeChanges, 3);
  assert.equal(counts.updates, 3);
  assert.equal(model.reading('hueMode'), 'HARMONY');
});

test('dispose removes the pointer drag and the key handles', () => {
  const { wheel, canvas, group } = setup();
  assert.ok(canvas.listeners.length > 0);
  wheel.dispose();
  assert.equal(canvas.listeners.length, 0);
  assert.equal(group.children.length, 0);
});
