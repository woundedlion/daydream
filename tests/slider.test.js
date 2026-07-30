// @ts-nocheck
//
// createSlider's validation branches: NaN/order guards on min/max/step/scale,
// and the scaled-step rounding guard that rejects a step that collapses to 0.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

const { createSlider } = await import('../tools/slider.js');

restoreDocumentAfterEach();

/** A fake range input recording the attributes createSlider sets.
 * @returns {Object} Fake input element.
 */
const fakeInput = () => {
  const listeners = new Map();
  return Object.assign(fakeElement('input'), {
    type: '', min: '', max: '', step: '', value: '',
    addEventListener: (type, listener) => listeners.set(type, listener),
    dispatch: (type) => listeners.get(type)?.(),
  });
};

let container;

beforeEach(() => {
  container = fakeElement('div');
  installDocument({
    getElementById: () => container,
    createElement: (tag) => (tag === 'input' ? fakeInput() : fakeElement(tag)),
  });
});

/** A valid config; tests override single fields to exercise one guard at a time. */
const base = { id: 's', label: 'L', min: 0, max: 10, step: 1, value: 5 };

/** Verifies a missing container throws a named error before any validation. */
test('throws when the container element is absent', () => {
  installDocument({ getElementById: () => null });
  assert.throws(() => createSlider('missing', base, null),
                /container #missing not found/);
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

/** Verifies the value guard rejects a non-finite initial value. */
test('throws when the initial value is not finite', () => {
  assert.throws(() => createSlider('c', { ...base, value: NaN }), /value .* must be a finite number/);
  assert.throws(() => createSlider('c', { ...base, value: undefined }), /value .* must be a finite number/);
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
  assert.equal(container.children[0].tagName, 'LABEL');
  assert.equal(container.children[0].htmlFor, slider.id);
});

/** Verifies input synchronizes both readouts before invoking the caller. */
test('input updates the readout and aria-valuetext before onInput', () => {
  let observed;
  const { slider, valueSpan } = createSlider(
    'c',
    { ...base, scale: 10, decimals: 1 },
    (raw) => {
      observed = {
        raw,
        text: valueSpan.textContent,
        aria: slider.getAttribute('aria-valuetext'),
      };
    },
  );

  slider.value = '73';
  slider.dispatch('input');

  assert.deepEqual(observed, { raw: 73, text: '7.3', aria: '7.3' });
});

/**
 * Verifies setValue writes all three parts of the control at once — thumb,
 * readout, and aria-valuetext — without firing onInput, since the caller
 * already holds the value it is pushing.
 */
test('setValue drives thumb, readout and aria-valuetext without firing onInput', () => {
  let calls = 0;
  const { slider, valueSpan, setValue } = createSlider(
    'c', { ...base, scale: 10, decimals: 1 }, () => { calls += 1; });

  assert.equal(setValue(7.26), 7.3);
  assert.equal(slider.value, '73');
  assert.equal(valueSpan.textContent, '7.3');
  assert.equal(slider.getAttribute('aria-valuetext'), '7.3');
  assert.equal(calls, 0);
});

/** Verifies setValue clamps to the configured range instead of moving the thumb off it. */
test('setValue clamps to the slider range', () => {
  const { slider, valueSpan, setValue } = createSlider(
    'c', { ...base, scale: 10, decimals: 1 }, null);

  assert.equal(setValue(42), 10);
  assert.equal(slider.value, '100');
  assert.equal(valueSpan.textContent, '10.0');
  assert.equal(setValue(-3), 0);
  assert.equal(slider.value, '0');
  assert.equal(valueSpan.textContent, '0.0');
});

/** Verifies the visible label is the accessible name when no override is supplied. */
test('omitting ariaLabel leaves the visible label as the accessible name', () => {
  const { slider } = createSlider('c', base, null);
  assert.equal(slider.getAttribute('aria-label'), null);
  assert.equal(container.children[0].textContent, 'L:');
});

/**
 * Verifies ariaLabel names the input without touching the visible label, which is
 * how a grid of sliders labelled only R/G/B gets one distinct name per control.
 */
test('ariaLabel names the input and leaves the visible label short', () => {
  const { slider } = createSlider('c',
    { ...base, label: 'R', labelSuffix: '', ariaLabel: 'Base red' }, null);
  assert.equal(slider.getAttribute('aria-label'), 'Base red');
  assert.equal(container.children[0].textContent, 'R');
});

/** Verifies an empty ariaLabel is treated as absent rather than set as a blank name. */
test('an empty ariaLabel sets no attribute', () => {
  const { slider } = createSlider('c', { ...base, ariaLabel: '' }, null);
  assert.equal(slider.getAttribute('aria-label'), null);
});
