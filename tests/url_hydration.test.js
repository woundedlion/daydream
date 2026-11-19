import test from 'node:test';
import assert from 'node:assert/strict';
import { hydrate } from '../src/ui/url_hydration.js';

test('hydrate resolves typed values, corrections and enum diagnostics', () => {
  const button = () => {};
  const cases = [
    [null, 3, [], 'absent', 3, false],
    ['4', button, [], 'absent', button, false],
    ['2.5', 1, [0, 10], 'applied', 2.5, false],
    ['99', 1, [0, 10], 'applied', 10, true],
    ['-2', 1, [0, 10], 'applied', 0, true],
    ['2.7', 1, [0, 10, 0.5], 'applied', 2.5, true],
    ['1.25', 1, [0.25, 2, 0.5], 'applied', 1.25, false],
    ['1.9', 1, [0, 1.9, 1], 'applied', 1.9, false],
    ['0.3', 1, [0, 1, 0.1], 'applied', 0.30000000000000004, false],
    ['2.7', 1, [0, 10, 0], 'applied', 2.7, false],
    ['2.7', 1, [0, 10, Infinity], 'applied', 2.7, false],
    ['fast', 2, [], 'fallback', 2, true, ['non-numeric']],
    ['', 2, [], 'fallback', 2, true, ['non-numeric']],
    ['Infinity', 2, [], 'fallback', 2, true, ['non-numeric']],
    ['1junk', 2, [], 'fallback', 2, true, ['non-numeric']],
    ['true', false, [], 'applied', true, false],
    ['0', true, [], 'applied', false, false],
    ['maybe', true, [], 'fallback', true, true, ['boolean']],
    ['hello', 'default', [], 'applied', 'hello', false],
    ['', 'default', [], 'applied', '', false],
    ['6', 0, [{ Off: 0, Shell: 6 }], 'applied', 6, false],
    ['2', 0, [{ Off: 0, Shell: 6 }], 'ignored', 0, true, ['range']],
    ['yes', 'no', [['no', 'yes']], 'applied', 'yes', false],
    ['other', 'no', [['no', 'yes']], 'ignored', 'no', true, ['range']],
    ['1', 'x', [[1, '1']], 'applied', '1', false, ['duplicate']],
    ['bad', 1, [[1, '1']], 'fallback', 1, true, ['non-numeric', 'duplicate']],
    ['bad', 1, [[2, '2']], 'ignored', 1, true, ['non-numeric', 'duplicate', 'range']],
    ['true', false, [[false, true]], 'applied', true, false],
  ];
  for (const [index, [raw, current, args, kind, value, rewrite, warnings = []]] of cases.entries()) {
    const label = `case ${index + 1} (${JSON.stringify(raw)})`;
    const result = hydrate({ raw, current, args });
    assert.equal(result.kind, kind, label);
    assert.equal(result.value, value, label);
    assert.equal(result.rewrite, rewrite, label);
    assert.deepEqual(result.warning?.reasons ?? [], warnings, label);
    if (warnings.length) assert.equal(result.warning.raw, raw, label);
  }
});
