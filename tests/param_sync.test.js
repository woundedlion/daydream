// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveParamSync } from '../param_sync.js';

// resolveParamSync is the DOM-free core of syncGUI()'s per-controller "fight-the-
// slider" decision: coerce the engine's raw value, never clobber a controller the
// user is editing, and skip a redundant write when the value is unchanged.

test('numeric: a changed value updates', () => {
  assert.deepEqual(resolveParamSync(0.5, 0.8, false, false),
    { update: true, value: 0.8 });
});

test('numeric: an unchanged value does not update (no redundant write)', () => {
  assert.deepEqual(resolveParamSync(0.8, 0.8, false, false),
    { update: false, value: 0.8 });
});

test('numeric: editing suppresses the update but still reports the coerced value', () => {
  assert.deepEqual(resolveParamSync(0.5, 0.8, false, true),
    { update: false, value: 0.8 });
});

test('boolean: incoming is thresholded at 0.5 into a real boolean', () => {
  assert.equal(resolveParamSync(false, 1, true, false).value, true);
  assert.equal(resolveParamSync(true, 0, true, false).value, false);
  assert.equal(resolveParamSync(false, 0.6, true, false).value, true);
  assert.equal(resolveParamSync(true, 0.4, true, false).value, false);
});

test('boolean: a flip updates; a matching state does not', () => {
  assert.deepEqual(resolveParamSync(false, 1, true, false),
    { update: true, value: true });
  assert.deepEqual(resolveParamSync(true, 1, true, false),
    { update: false, value: true });
});

test('boolean: editing suppresses a flip', () => {
  assert.deepEqual(resolveParamSync(false, 1, true, true),
    { update: false, value: true });
});

test('numeric: a NaN engine value never updates (no per-frame churn)', () => {
  // NaN !== anything, so without the guard this would update every frame and
  // write NaN into the controller.
  assert.deepEqual(resolveParamSync(0.5, NaN, false, false),
    { update: false, value: NaN });
  // Even when the controller already holds NaN, still no update.
  assert.deepEqual(resolveParamSync(NaN, NaN, false, false),
    { update: false, value: NaN });
});
