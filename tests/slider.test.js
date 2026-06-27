// @ts-nocheck
//
// createSlider's validation branches: NaN/order guards on min/max/step/scale,
// and the scaled-step rounding guard that rejects a step that collapses to 0.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createSlider } = await import('../tools/slider.js');

/** A fake range input recording the attributes createSlider sets. */
const fakeInput = () => ({
  type: '', id: '', min: '', max: '', step: '', value: '', className: '',
  addEventListener() {},
});

/** A fake span element. */
const fakeSpan = () => ({ id: '', className: '', textContent: '' });

/** A fake container collecting appended children. */
const fakeContainer = () => ({
  children: [],
  replaceChildren() { this.children = []; },
  append(...nodes) { this.children.push(...nodes); },
});

let container;

beforeEach(() => {
  container = fakeContainer();
  globalThis.document = {
    getElementById: () => container,
    createElement: (tag) => (tag === 'input' ? fakeInput() : fakeSpan()),
  };
});

afterEach(() => {
  delete globalThis.document;
});

/** A valid config; tests override single fields to exercise one guard at a time. */
const base = { id: 's', label: 'L', min: 0, max: 10, step: 1, value: 5 };

/** Verifies a missing container short-circuits to null before any validation. */
test('returns null when the container element is absent', () => {
  globalThis.document = { getElementById: () => null };
  assert.equal(createSlider('missing', base, null), null);
});

/** Verifies the `!(min < max)` guard rejects an inverted range and a NaN bound. */
test('throws when min is not less than max (including NaN bounds)', () => {
  assert.throws(() => createSlider('c', { ...base, min: 10, max: 0 }), /min .* must be < max/);
  assert.throws(() => createSlider('c', { ...base, min: 5, max: 5 }), /min .* must be < max/);
  assert.throws(() => createSlider('c', { ...base, min: NaN }), /min .* must be < max/);
  assert.throws(() => createSlider('c', { ...base, max: NaN }), /min .* must be < max/);
});

/** Verifies the `!(step > 0)` guard rejects non-positive and NaN steps. */
test('throws when step is not greater than zero', () => {
  assert.throws(() => createSlider('c', { ...base, step: 0 }), /step .* must be > 0/);
  assert.throws(() => createSlider('c', { ...base, step: -1 }), /step .* must be > 0/);
  assert.throws(() => createSlider('c', { ...base, step: NaN }), /step .* must be > 0/);
});

/** Verifies the `!(scale > 0)` guard rejects non-positive and NaN scales. */
test('throws when scale is not greater than zero', () => {
  assert.throws(() => createSlider('c', { ...base, scale: 0 }), /scale .* must be > 0/);
  assert.throws(() => createSlider('c', { ...base, scale: -2 }), /scale .* must be > 0/);
  assert.throws(() => createSlider('c', { ...base, scale: NaN }), /scale .* must be > 0/);
});

/** Verifies a step that rounds to 0 in scaled (integer) units is rejected. */
test('throws when step * scale rounds below 1 in scaled units', () => {
  assert.throws(() => createSlider('c', { ...base, step: 0.4, scale: 1 }),
    /rounds to 0 in scaled units; must be >= 1/);
});

/** Verifies a valid config builds the control and snaps its attributes to scaled units. */
test('builds a slider, scaling bounds and rounding the step to integer units', () => {
  const { slider, valueSpan } = createSlider('c', { ...base, scale: 10, decimals: 1 }, null);
  assert.equal(slider.min, '0');
  assert.equal(slider.max, '100');
  assert.equal(slider.step, '10');
  assert.equal(slider.value, '50');
  assert.equal(valueSpan.textContent, '5.0');
  assert.equal(container.children.length, 3);
});
