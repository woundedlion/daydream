// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { formatExportParams } = await import('../tools/export_params.js');

/** Each value renders as a 4-decimal float literal inside a brace-init list. */
test('formatExportParams: emits a C++ float brace-init list', () => {
  const params = [{ name: 'A' }, { name: 'B' }];
  assert.equal(formatExportParams(params, [0.85, 1]), '{ 0.8500f, 1.0000f }');
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
    '{ 0.8500f, 1.0000f, 0.0250f, 0.2000f }');
});

/** An all-readonly param set yields empty braces rather than a malformed list. */
test('formatExportParams: all-readonly yields empty braces', () => {
  const params = [{ name: 'X', readonly: true }];
  assert.equal(formatExportParams(params, [1]), '{  }');
});
