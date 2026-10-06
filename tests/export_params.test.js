import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatExportParams } = await import('../src/shared/export_params.js');

/** Trailing zeros trimmed; whole values keep one fractional digit. */
test('formatExportParams: emits a C++ float brace-init list', () => {
  const params = [{ name: 'A' }, { name: 'B' }];
  assert.equal(formatExportParams(params, [0.85, 1]), '{ 0.85f, 1.0f }');
});

/** Readonly params hold engine-written live values and never bake into a preset. */
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

/** Surviving values stay indexed by their param position. */
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

test('formatExportParams: all-readonly yields empty braces', () => {
  const params = [{ name: 'X', readonly: true }];
  assert.equal(formatExportParams(params, [1]), '{  }');
});

/** A tiny nonzero value keeps a meaningful significand. */
test('formatExportParams: preserves small-magnitude significand', () => {
  const params = [{ name: 'Tiny' }];
  assert.equal(formatExportParams(params, [0.00001]), '{ 0.00001f }');
});


test('sparse enum exports resolve numeric IDs to symbols and refuse gaps', () => {
  const params = [{ name: 'Pattern', optionValues: [0, 1, 6],
    exportOptions: ['Pattern::CUBIC', 'Pattern::OCTET', 'Pattern::SHELLS'] }];
  for (const [value, symbol] of [[0, 'CUBIC'], [1, 'OCTET'], [6, 'SHELLS']])
    assert.equal(formatExportParams(params, [value]), `{ Pattern::${symbol} }`);
  assert.throws(() => formatExportParams(params, [2]), /No enum option for Pattern value 2/);
  assert.equal(formatExportParams([{ name: 'Pattern', step: 1, optionValues: [0, 1, 6] }], [6]), '{ 6 }');
});


test('numeric sparse enums without export symbols still reject gaps', () => {
  const params = [{ name: 'Pattern', step: 1, optionValues: [0, 1, 6] }];
  assert.equal(formatExportParams(params, [6]), '{ 6 }');
  assert.throws(() => formatExportParams(params, [2]), /No enum option for Pattern value 2/);
});
