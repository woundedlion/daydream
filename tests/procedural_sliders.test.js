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
  assert.equal(input('D_G').value, '330');
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
  assert.equal(input('C_G').value, '-2000');
  assert.equal(input('D_B').value, '1500');
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
  assert.equal(input('C_B').value, '1500');
  move(input('C_R'), 1700);
  assert.equal(values.C_G, 1.7);
});

test('a locked group stops when a sibling reaches its bound', () => {
  const { sliders, input } = mount({ D: true });
  input('D_G').dispatch('keydown');
  move(input('D_G'), 2000);
  const values = sliders.values();
  assert.ok(Math.abs(values.D_B - 2) < 1e-12, 'blue caps the rise');
  assert.ok(Math.abs(values.D_G - 1.66) < 1e-12);
  assert.ok(Math.abs(values.D_R - 1.33) < 1e-12);
  assert.equal(input('D_G').value, '1660', 'the dragged slider is pulled back');
  input('D_G').dispatch('keyup');
  move(input('D_B'), -1000);
  assert.ok(Math.abs(values.D_R - (-1)) < 1e-12, 'red caps the drop');
  assert.ok(Math.abs(values.D_G - (-0.67)) < 1e-12);
  assert.ok(Math.abs(values.D_B - (-0.33)) < 1e-12);
  assert.equal(input('D_B').value, '-330', 'the dragged slider is pulled back');
});

test('a slider whose group lock is missing moves alone', () => {
  const { sliders, input, locks } = mount();
  locks.delete('lock_B');
  input('B_R').dispatch('mousedown');
  move(input('B_R'), 900);
  assert.equal(sliders.values().B_R, 0.9);
  assert.equal(sliders.values().B_G, 0.5);
});

test('dispose removes the seed and release listeners', () => {
  const { sliders, input } = mount({ A: true });
  const slider = input('A_R');
  const types = (node) => node.listeners.map((listener) => listener.type).sort();
  assert.deepEqual(types(slider), ['blur', 'input', 'keydown', 'keyup', 'mousedown',
    'mouseup', 'touchend', 'touchstart', 'wheel']);
  sliders.dispose();
  for (const definition of PROCEDURAL_SLIDER_DEFINITIONS)
    assert.deepEqual(types(input(definition.param)), ['input'], definition.param);
  sliders.dispose();
  slider.dispatch('mousedown');
  move(slider, 800);
  assert.equal(sliders.values().A_G, 0.8, 'the slider still edits its group');
});
