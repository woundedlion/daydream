import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisKeyValue } from '../src/workbench/mobius/mobius_transforms.js';
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

test('axis arrows apply the real component snap, clamp and shift step', () => {
  for (const key of ['ArrowRight', 'ArrowUp']) {
    assert.equal(axisKeyValue(key, 0, false, 4), 0.05);
    assert.equal(axisKeyValue(key, 0, true, 4), 0.2);
    assert.equal(axisKeyValue(key, 0.96, false, 4), 1);
    assert.equal(axisKeyValue(key, 3.99, true, 4), 4);
  }
  for (const key of ['ArrowLeft', 'ArrowDown']) {
    assert.equal(axisKeyValue(key, 0, false, 4), -0.05);
    assert.equal(axisKeyValue(key, 0, true, 4), -0.2);
    assert.equal(axisKeyValue(key, 0.04, false, 4), 0);
    assert.equal(axisKeyValue(key, -3.99, true, 4), -4);
  }
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

test('Home and End map to the component bounds', () => {
  assert.equal(axisKeyValue('Home', 0.5, false, 4), -4);
  assert.equal(axisKeyValue('End', 0.25, false, 4), 4);
});

test('0 recenters the coefficient and other keys pass through', () => {
  assert.equal(axisKeyValue('0', 0.5, false, 4), 'recenter');
  assert.equal(axisKeyValue('a', 0.25, false, 4), null);
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
