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
  now = 16;
  update();
  now = 100;
  update();
  assert.equal(formats, 2);
  assert.equal(output.textContent, '2');
  context.isAnimating = false;
  now = 101;
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
  assert.equal(paramObj.re, 0.2);
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
