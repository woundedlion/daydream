// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveParamSync, enumChoices } from '../param_sync.js';

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
  assert.equal(resolveParamSync(true, 0.5, true, false).value, false);
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
  // NaN !== anything, so without the guard this would update (and write NaN) every frame.
  assert.deepEqual(resolveParamSync(0.5, NaN, false, false),
    { update: false, value: NaN });
  assert.deepEqual(resolveParamSync(NaN, NaN, false, false),
    { update: false, value: NaN });
});

test('boolean: a NaN engine value never flips the toggle', () => {
  // NaN coerces to false; without the guard a `true` toggle would write a spurious false every frame.
  assert.deepEqual(resolveParamSync(true, NaN, true, false),
    { update: false, value: false });
});

// enumChoices maps engine enum labels to the lil-gui choices object whose
// values are the option indices setParameter expects.

test('enum: labels map to their option indices in order', () => {
  assert.deepEqual(enumChoices(['None', 'Warp', 'Sparkle']),
    { None: 0, Warp: 1, Sparkle: 2 });
});

test('enum: a single option still yields a valid choices object', () => {
  assert.deepEqual(enumChoices(['Only']), { Only: 0 });
});

test('enum: duplicate labels are disambiguated, never dropped', () => {
  const choices = enumChoices(['Mode', 'Mode', 'Mode']);
  const values = Object.values(choices).sort();
  // All three indices remain selectable under distinct keys.
  assert.deepEqual(values, [0, 1, 2]);
  assert.equal(choices['Mode'], 0);
});
