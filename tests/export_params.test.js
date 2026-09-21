import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatExportParams } = await import('../tools/export_params.js');

/** Each value renders through the shared formatFloatCpp (trailing zeros trimmed,
 *  whole values keep one fractional digit) inside a brace-init list. */
test('formatExportParams: emits a C++ float brace-init list', () => {
  const params = [{ name: 'A' }, { name: 'B' }];
  assert.equal(formatExportParams(params, [0.85, 1]), '{ 0.85f, 1.0f }');
});

/** Readonly params (e.g. MindSplatter's engine-written active_count) are dropped
 *  so their live per-frame values never bake into the preset. */
test('formatExportParams: skips readonly params', () => {
  const params = [
    { name: 'Friction' },
    { name: 'Well Str' },
    { name: 'Init Spd' },
    { name: 'Ang Spd' },
    { name: 'Particles', readonly: true },
  ];
  const values = [0.85, 1.0, 0.025, 0.2, 37];
  assert.equal(formatExportParams(params, values),
    '{ 0.85f, 1.0f, 0.025f, 0.2f }');
});

/** A readonly param in the middle must drop only its own value; the surviving
 *  values stay indexed by their param position, not a filtered position. */
test('formatExportParams: skips a middle readonly param', () => {
  const params = [{ name: 'A' }, { name: 'B', readonly: true }, { name: 'C' }];
  assert.equal(formatExportParams(params, [0.1, 0.2, 0.3]), '{ 0.1f, 0.3f }');
});

test('formatExportParams: skips params excluded from presets', () => {
  const params = [
    { name: 'Shape', options: ['Star', 'Heart'], step: 1 },
    { name: 'Global Alpha', preset: false },
    { name: 'Scale' },
  ];
  assert.equal(formatExportParams(params, [1, 0.75, 2]), '{ 1, 2.0f }');
});

test('formatExportParams: emits the selected enum symbol exactly', () => {
  const params = [{
    name: 'Shape',
    options: ['Star', 'Heart', 'Polygon'],
    exportOptions: ['Shape::STAR', 'Shape::HEART', 'Shape::POLYGON'],
  }];
  assert.equal(formatExportParams(params, [1]), '{ Shape::HEART }');
});

test('formatExportParams: rejects an enum index with no export symbol', () => {
  const params = [{ name: 'Shape', exportOptions: ['Shape::STAR'] }];
  assert.throws(() => formatExportParams(params, [1]),
    /No export option for Shape index 1/);
});

/** A float-backed enum names no C++ enum type, so it exports its index. */
test('formatExportParams: emits the index when an enum carries no export metadata', () => {
  const params = [{ name: 'Shape', options: ['Star', 'Heart'], step: 1 }];
  assert.equal(formatExportParams(params, [1]), '{ 1 }');
});

/** A float literal into a uint8_t brace-init member is a narrowing error. */
test('formatExportParams: emits a whole-number param as an integer literal', () => {
  const params = [{ name: 'Burst', step: 1, min: 1, max: 32 }];
  assert.equal(formatExportParams(params, [18]), '{ 18 }');
});

/** Only a float-backed enum can hold a fraction under a step of 1, and its
 *  target is a float. */
test('formatExportParams: keeps a fractional stepped value a float literal', () => {
  const params = [{ name: 'Shape', options: ['Star', 'Heart'], step: 1 }];
  assert.equal(formatExportParams(params, [0.5]), '{ 0.5f }');
});

/** The engine streams a toggle as 0/1; a float literal into a bool brace-init
 *  member is a narrowing error. */
test('formatExportParams: emits a toggle as a C++ bool literal', () => {
  const params = [{ name: 'Debug BB', value: false }, { name: 'Trails', value: true }];
  assert.equal(formatExportParams(params, [0, 1]), '{ false, true }');
});

/** An all-readonly param set yields empty braces rather than a malformed list. */
test('formatExportParams: all-readonly yields empty braces', () => {
  const params = [{ name: 'X', readonly: true }];
  assert.equal(formatExportParams(params, [1]), '{  }');
});

/** A tiny nonzero value keeps a meaningful significand instead of collapsing to
 *  0.0000f the way the old fixed 4-decimal formatter did. */
test('formatExportParams: preserves small-magnitude significand', () => {
  const params = [{ name: 'Tiny' }];
  assert.equal(formatExportParams(params, [0.00001]), '{ 0.00001f }');
});
