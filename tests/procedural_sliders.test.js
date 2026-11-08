import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './helpers/fake_dom.js';
import {
  PROCEDURAL_SLIDER_DEFINITIONS, mountProceduralSliders,
} from '../src/workbench/palettes/procedural_sliders.js';

restoreDocumentAfterEach();

const DEFAULTS = Object.freeze({
  A_R: 0.5, A_G: 0.5, A_B: 0.5,
  B_R: 0.5, B_G: 0.5, B_B: 0.5,
  C_R: 1, C_G: 1, C_B: 1,
  D_R: 0, D_G: 0.33, D_B: 0.67,
});

/**
 * Installs a document holding every slider container and the four lock
 * checkboxes, and mounts the sliders into it.
 * @param {Object<string, boolean>} [locked] - Which groups are locked.
 * @returns {{sliders: ReturnType<typeof mountProceduralSliders>, input: (id: string) => any,
 *   locks: Map<string, {checked: boolean}>, updates: () => number}} The mounted sliders.
 */
function mount(locked = {}) {
  const containers = new Map(PROCEDURAL_SLIDER_DEFINITIONS.map(
    (definition) => [definition.container, fakeElement()]));
  const locks = new Map(['A', 'B', 'C', 'D'].map(
    (group) => [`lock_${group}`, { checked: Boolean(locked[group]) }]));
  installDocument({
    createElement: (tag) => fakeElement(tag),
    getElementById: (id) => {
      if (containers.has(id)) return containers.get(id);
      if (locks.has(id)) return locks.get(id);
      for (const container of containers.values()) {
        const found = container.childNodes.find((node) => node.id === id);
        if (found) return found;
      }
      return null;
    },
  });
  let updates = 0;
  const sliders = mountProceduralSliders({ defaults: DEFAULTS, scheduleUpdate: () => { updates++; } });
  const input = (param) => globalThis.document.getElementById(`${param}_slider`);
  return { sliders, input, locks, updates: () => updates };
}

/**
 * @param {string} param - A coefficient.
 * @returns {ProceduralSliderDefinition} Its slider definition.
 */
const definitionOf = (param) => PROCEDURAL_SLIDER_DEFINITIONS.find((d) => d.param === param);

/**
 * @param {string} param - A coefficient.
 * @param {number} value - A coefficient value.
 * @returns {string} The raw slider value that shows it.
 */
const rawOf = (param, value) => String(Math.round(value * definitionOf(param).scale));

/**
 * Moves a slider the way the browser does: value first, then its input event.
 * @param {any} slider - The fake range input.
 * @param {number} raw - The raw value it moves to.
 * @returns {void}
 */
function move(slider, raw) {
  slider.value = String(raw);
  slider.dispatch('input');
}

test('the sliders open on a copy of the defaults', () => {
  const { sliders, input } = mount();
  assert.deepEqual({ ...sliders.values() }, DEFAULTS);
  assert.notEqual(sliders.values(), DEFAULTS);
  assert.equal(input('D_G').value, rawOf('D_G', DEFAULTS.D_G));
  assert.equal(input('C_B').getAttribute('aria-label'), 'Frequency blue');
  assert.equal(input('A_R').getAttribute('aria-label'), 'Offset red');
});

test('an unlocked input moves one coefficient and asks for a redraw', () => {
  const { sliders, input, updates } = mount();
  const values = sliders.values();
  move(input('B_G'), 250);
  assert.equal(values.B_G, 0.25);
  assert.equal(values.B_R, 0.5);
  assert.equal(sliders.values(), values, 'values() is a view, not a copy');
  assert.equal(updates(), 1);
});

test('setAll replaces every coefficient and moves its slider', () => {
  const { sliders, input } = mount();
  const next = { ...DEFAULTS, A_R: 0.1, C_G: -2, D_B: 1.5 };
  sliders.setAll(next);
  assert.deepEqual({ ...sliders.values() }, next);
  assert.equal(input('C_G').value, rawOf('C_G', -2));
  assert.equal(input('D_B').value, rawOf('D_B', 1.5));
});

test('a previous slider blur preserves the new locked drag', () => {
  const { sliders, input } = mount({ A: true });
  // Off the slider grid, so a drag seeded from the thumbs differs from one
  // started from the committed coefficients.
  sliders.setAll({ ...DEFAULTS, A_R: 0.3334 });
  input('A_R').dispatch('mousedown');
  input('A_G').dispatch('mousedown');
  input('A_R').dispatch('blur');
  move(input('A_G'), 600);
  const values = sliders.values();
  assert.ok(Math.abs(values.A_R - 0.433) < 1e-12, 'the drag moves from the thumbs it seeded');
  assert.ok(Math.abs(values.A_G - 0.6) < 1e-12);
  assert.ok(Math.abs(values.A_B - 0.6) < 1e-12);
  assert.equal(values.B_R, 0.5, 'another group stays put');
  input('A_G').dispatch('blur');
  move(input('A_G'), 700);
  assert.ok(Math.abs(values.A_R - 0.533) < 1e-12, 'the released drag restarts from the committed group');
});

test('an unseeded slider input moves the whole locked group', () => {
  const { sliders, input } = mount({ C: true });
  move(input('C_R'), 1500);
  const values = sliders.values();
  assert.equal(values.C_R, 1.5);
  assert.equal(values.C_G, 1.5);
  assert.equal(input('C_B').value, rawOf('C_B', values.C_B));
  move(input('C_R'), 1700);
  assert.equal(values.C_G, 1.7);
});

test('a locked group stops when a sibling reaches its bound', () => {
  const { sliders, input } = mount({ D: true });
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: ${actual} vs ${expected}`);
  const keepsOffsets = () => {
    near(values.D_G - values.D_R, DEFAULTS.D_G - DEFAULTS.D_R, 'red keeps its offset');
    near(values.D_B - values.D_G, DEFAULTS.D_B - DEFAULTS.D_G, 'blue keeps its offset');
  };
  const values = sliders.values();
  input('D_G').dispatch('keydown');
  move(input('D_G'), definitionOf('D_G').max * definitionOf('D_G').scale);
  near(values.D_B, definitionOf('D_B').max, 'blue caps the rise');
  keepsOffsets();
  assert.equal(input('D_G').value, rawOf('D_G', values.D_G), 'the dragged slider is pulled back');
  assert.ok(values.D_G < definitionOf('D_G').max);
  input('D_G').dispatch('keyup');
  move(input('D_B'), definitionOf('D_B').min * definitionOf('D_B').scale);
  near(values.D_R, definitionOf('D_R').min, 'red caps the drop');
  keepsOffsets();
  assert.equal(input('D_B').value, rawOf('D_B', values.D_B), 'the dragged slider is pulled back');
  assert.ok(values.D_B > definitionOf('D_B').min);
});

test('locked edits use the mounted sliders even after their ids change', () => {
  const { sliders, input } = mount({ A: true });
  const [red, green, blue] = ['A_R', 'A_G', 'A_B'].map(input);
  sliders.setAll({ ...DEFAULTS, A_R: 0.3334 });
  for (const slider of [red, green, blue]) slider.id += '_renamed';
  green.dispatch('mousedown');
  move(green, 600);
  assert.equal(sliders.values().A_R, 0.433);
  assert.equal(sliders.values().A_G, 0.6);
  assert.equal(sliders.values().A_B, 0.6);
  assert.equal(red.value, rawOf('A_R', sliders.values().A_R));
  assert.equal(blue.value, rawOf('A_B', sliders.values().A_B));
});

test('a slider whose group lock is missing moves alone', () => {
  const { sliders, input, locks } = mount();
  locks.delete('lock_B');
  input('B_R').dispatch('mousedown');
  move(input('B_R'), 900);
  assert.equal(sliders.values().B_R, 0.9);
  assert.equal(sliders.values().B_G, 0.5);
});

test('seed events start a locked drag, release events end it, and dispose removes both', () => {
  const { sliders, input } = mount({ A: true, C: true });
  const values = sliders.values();
  const near = (actual, expected, message) =>
    assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} vs ${expected}`);
  /**
   * Drags a locked group's green slider one hundred raw steps from an
   * off-grid red coefficient, so a drag seeded from the thumbs and one started
   * from the committed coefficients land on different red values.
   * @param {string} group - A locked group.
   * @param {string|null} seed - The event dispatched before the move.
   * @param {string|null} release - The event dispatched after the seed.
   * @returns {{red: number, seeded: number, unseeded: number, blue: number, blueMoved: number}}
   *   Where red landed and where each start would put it; blue and where it should land.
   */
  const drag = (group, seed, release = null) => {
    sliders.setAll({ ...DEFAULTS, A_R: 0.3334, C_R: 1.0004 });
    const red = input(`${group}_R`);
    const green = input(`${group}_G`);
    const { scale } = PROCEDURAL_SLIDER_DEFINITIONS.find((d) => d.param === `${group}_R`);
    const thumb = Number(red.value);
    const committed = values[`${group}_R`];
    if (seed) green.dispatch(seed);
    if (release) green.dispatch(release);
    move(green, Number(green.value) + 100);
    return {
      red: values[`${group}_R`],
      seeded: (thumb + 100) / scale,
      unseeded: committed + 100 / scale,
      blue: values[`${group}_B`],
      blueMoved: DEFAULTS[`${group}_B`] + 100 / scale,
    };
  };
  const SEEDS = ['mousedown', 'touchstart', 'keydown', 'wheel'];
  const RELEASES = ['mouseup', 'touchend', 'keyup', 'blur'];

  for (const seed of SEEDS) {
    const result = drag('A', seed);
    assert.ok(Math.abs(result.seeded - result.unseeded) > 1e-6, 'the two starts differ');
    near(result.red, result.seeded, `${seed} seeds the drag from the thumbs`);
    for (const release of RELEASES) input('A_G').dispatch(release);
  }
  for (const release of RELEASES) {
    const result = drag('A', 'mousedown', release);
    near(result.red, result.unseeded, `${release} releases the drag`);
  }

  drag('A', 'mousedown');
  sliders.dispose();
  for (const definition of PROCEDURAL_SLIDER_DEFINITIONS)
    assert.deepEqual(input(definition.param).listeners.map((l) => l.type), ['input'],
      definition.param);
  sliders.dispose();
  for (const release of RELEASES) {
    const result = drag('A', null, release);
    near(result.red, result.seeded, `${release} no longer releases the drag`);
  }
  for (const seed of SEEDS) {
    const result = drag('C', seed);
    near(result.red, result.unseeded, `${seed} no longer seeds a drag`);
    near(result.blue, result.blueMoved, 'the slider still edits its group');
  }
});
