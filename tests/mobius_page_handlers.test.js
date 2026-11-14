import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
const handler = pageHandlers(new URL('../src/workbench/mobius/mobius_page.js', import.meta.url));

test('animated snippets throttle formatting and flush the final stopped value', () => {
  let now = 0, formats = 0;
  const output = { textContent: '' };
  const context = { isAnimating: true, lastCode: null, codeOutput: null, lastCodeTime: -Infinity,
    config: {}, performance: { now: () => now },
    document: { getElementById: () => output },
    mobiusCodeString: () => String(++formats) };
  const update = handler('updateCodeSnippet', context);
  update();
  update();
  assert.equal(formats, 1, 'a frame at the same instant reuses the snippet');
  now = 10_000;
  update();
  assert.equal(formats, 2);
  assert.equal(output.textContent, '2');
  context.isAnimating = false;
  now = 10_001;
  update();
  assert.equal(output.textContent, '3');
});

test('an axis key leaves the other coefficient component unchanged', () => {
  const paramObj = { re: 0, im: 0.05 };
  const context = {paramObj, activePreset: null, maxExtent: 4,
    snapCoefficientComponent: (v, threshold) => Math.abs(v) < 2 * threshold ? 0 : v,
    updateUI() {}, onChange() {}, stopAnimation() {}};
  context.clampSnap = handler('clampSnap', context);
  context.commit = handler('commit', context);
  const keydown = handler('onAxisKeyDown', context);
  keydown('re')({ key: 'ArrowRight', shiftKey: true, preventDefault() {} });
  assert.ok(paramObj.re > 0);
  assert.equal(paramObj.im, 0.05);
});


test('identity reset copies fresh coefficients into the pad-owned objects', () => {
  const identity = handler('identityCoefficients', {});
  const config = identity();
  const refs = Object.values(config);
  config.A.re = 7;
  const reset = identity();
  assert.equal(reset.A.re, 1);
  handler('applyConfig', {config, uiUpdaters: {}, updateMobiusUniforms() {}})(reset);
  assert.equal(config.A.re, 1);
  Object.values(config).forEach((value, i) => assert.equal(value, refs[i]));
});

/**
 * Builds the pad's axis keydown handler over one coefficient at the given value.
 * @param {number} re - Starting real part.
 * @param {number} im - Starting imaginary part.
 * @returns {{paramObj: {re: number, im: number}, press: (axis: string, key: string) => boolean}}
 *   The coefficient and a key press that reports whether it was consumed.
 */
function axisPad(re, im) {
  const paramObj = { re, im };
  const context = {paramObj, activePreset: null, maxExtent: 4,
    snapCoefficientComponent: (v) => v, updateUI() {}, onChange() {}, stopAnimation() {}};
  context.clampSnap = handler('clampSnap', context);
  context.commit = handler('commit', context);
  const keydown = handler('onAxisKeyDown', context);
  const press = (axis, key) => {
    let prevented = false;
    keydown(axis)({ key, shiftKey: false, preventDefault() { prevented = true; } });
    return prevented;
  };
  return { paramObj, press };
}

test('Home and End move only the focused part to its slider bounds', () => {
  const pad = axisPad(0.5, 0.25);
  assert.equal(pad.press('re', 'Home'), true);
  assert.deepEqual(pad.paramObj, { re: -4, im: 0.25 });
  assert.equal(pad.press('im', 'End'), true);
  assert.deepEqual(pad.paramObj, { re: -4, im: 4 });
  pad.press('re', 'End');
  pad.press('im', 'Home');
  assert.deepEqual(pad.paramObj, { re: 4, im: -4 });
});

test('0 recenters both parts and other keys pass through', () => {
  const pad = axisPad(0.5, 0.25);
  assert.equal(pad.press('re', 'a'), false);
  assert.deepEqual(pad.paramObj, { re: 0.5, im: 0.25 });
  assert.equal(pad.press('im', '0'), true);
  assert.deepEqual(pad.paramObj, { re: 0, im: 0 });
});

test('the axis handles advertise Home, End and 0', () => {
  const keys = [];
  const element = () => ({ setAttribute() {}, append() {}, replaceChildren() {} });
  handler('createComplexPlaneElements', {
    document: { getElementById: element, createElement: element },
    createSliderProxy: (options) => { keys.push(options.keys.split(' ')); return element(); },
  })('A', 4);
  assert.equal(keys.length, 2);
  for (const shortcuts of keys) {
    for (const key of ['Home', 'End', '0']) assert.ok(shortcuts.includes(key), key);
  }
});
