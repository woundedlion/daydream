import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveParamSync,
  enumChoices,
  paramControlKind,
  engineParamValue,
  paramValueSkew,
  paramExportBlocker,
  paramGenerationStale,
  selectorControlValue,
  enumConstantName,
} from '../param_sync.js';

// resolveParamSync is the DOM-free core of sync()'s per-controller "fight-the-
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

test('selector state follows a request before the rendered value advances', () => {
  assert.equal(selectorControlValue({ value: 1, requestedValue: 0 }), 0);
  assert.equal(selectorControlValue({ value: 2 }), 2);
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

test('enum: a label matching an Object.prototype member keeps its own name', () => {
  const choices = enumChoices(['toString', 'Warp', 'valueOf']);
  assert.deepEqual(choices, { toString: 0, Warp: 1, valueOf: 2 });
  assert.deepEqual(Object.keys(choices), ['toString', 'Warp', 'valueOf']);
});

// paramControlKind picks the lil-gui control the effect GUI builds for one
// engine parameter definition.

test('a boolean value is a toggle', () => {
  assert.equal(paramControlKind({ value: true }), 'boolean');
  assert.equal(paramControlKind({ value: false }), 'boolean');
});

test('an options list is a dropdown', () => {
  assert.equal(paramControlKind({ value: 0, options: ['A', 'B'] }), 'enum');
});

test('anything else is a slider', () => {
  assert.equal(paramControlKind({ value: 0.5, min: 0, max: 1 }), 'number');
  // An empty or absent options list carries no labels to offer.
  assert.equal(paramControlKind({ value: 0, options: [] }), 'number');
  assert.equal(paramControlKind({ value: 0, options: null }), 'number');
});

test('a unit step with no labels is an integer control', () => {
  assert.equal(paramControlKind({ value: 4, min: 1, max: 32, step: 1 }), 'integer');
});

test('labels outrank a step, so a stepped enum stays a dropdown', () => {
  // The engine emits step 1 for every whole-number target, enums included.
  assert.equal(
    paramControlKind({ value: 0, options: ['A', 'B'], step: 1 }), 'enum');
});

test('a boolean carrying labels stays a toggle', () => {
  // A dropdown would write the option index, not the 0/1 the flag expects.
  assert.equal(paramControlKind({ value: true, options: ['Off', 'On'] }), 'boolean');
});

// engineParamValue coerces a GUI value to the float setParameter takes, for both
// the deep-link seeding pass and the per-change write.

test('a boolean becomes 1.0/0.0', () => {
  assert.equal(engineParamValue(true), 1.0);
  assert.equal(engineParamValue(false), 0.0);
});

test('a number passes through unchanged', () => {
  assert.equal(engineParamValue(0.375), 0.375);
  assert.equal(engineParamValue(0), 0);
  assert.equal(engineParamValue(-2.5), -2.5);
});

test('an enum index passes through as its own float', () => {
  assert.equal(engineParamValue(2), 2);
});

// paramValueSkew guards sync()/exportParams() from pairing a drifted param-name
// list with the engine's value stream by index.

test('equal lengths do not skew', () => {
  assert.equal(paramValueSkew(3, 3), false);
  assert.equal(paramValueSkew(0, 0), false);
});

test('unequal lengths skew (either direction)', () => {
  assert.equal(paramValueSkew(3, 4), true);
  assert.equal(paramValueSkew(4, 3), true);
  assert.equal(paramValueSkew(0, 1), true);
});

// paramExportBlocker is the Export action's precondition check: it names the one
// reason a copy cannot proceed, or clears it.

test('a matching value stream with a copy operation is not blocked', () => {
  assert.equal(paramExportBlocker([0.25, 1, 0], 3, true), null);
});

test('a missing or detached value stream blocks the copy', () => {
  const expected =
    'Export: no parameter values matching the current effect; skipping copy';
  assert.equal(paramExportBlocker(null, 3, true), expected);
  assert.equal(paramExportBlocker(undefined, 3, true), expected);
  // A heap-growth detach leaves the WASM view zero-length.
  assert.equal(paramExportBlocker(new Float32Array(0), 3, true), expected);
});

test('a skewed value stream blocks the copy and reports both lengths', () => {
  assert.equal(paramExportBlocker([0.5, 0.5], 3, true),
    'Export: param/value length skew (3 vs 2); skipping copy');
});

test('a missing copy operation blocks the copy', () => {
  assert.equal(paramExportBlocker([0.5], 1, false),
    'Export: clipboard copy unavailable');
});

test('a value-stream fault outranks copy availability', () => {
  // The stream is read first, so a null stream without a copy operation reports
  // the stream — one flash, one warning, whichever came first.
  assert.match(paramExportBlocker(null, 1, false), /^Export: no parameter values/);
  assert.match(paramExportBlocker([0.5, 0.5], 1, false), /^Export: param\/value/);
});

// paramGenerationStale is the identity half of the same guard: it catches an
// effect switch the length comparison cannot see.

test('a snapshot read at the engine\'s current generation is not stale', () => {
  assert.equal(paramGenerationStale(0, 0), false);
  assert.equal(paramGenerationStale(7, 7), false);
});

test('any generation move makes the snapshot stale', () => {
  assert.equal(paramGenerationStale(7, 8), true);
  assert.equal(paramGenerationStale(8, 7), true);
  assert.equal(paramGenerationStale(0, 1), true);
});

test('an engine reporting no generation is never stale', () => {
  assert.equal(paramGenerationStale(undefined, undefined), false);
});

test('an engine enum value is logged by its constant name', () => {
  const RESULTS = { OK: 0, READONLY: 1, OUT_OF_RANGE: 2 };
  assert.equal(enumConstantName(RESULTS, 1), 'READONLY');
  assert.equal(enumConstantName(RESULTS, 9), 'unrecognized result',
    'a value the mirrored table lacks still names something in the log line');
});
