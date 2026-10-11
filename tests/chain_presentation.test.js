import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainPresentation, formatNumericValue } from '../src/workbench/shader/chain_presentation.js';

test('numeric readouts retain the shortest binary32 spelling across scales', () => {
  for (const [value, text] of [
    [3.14159274, '3.1415927'], [0.100000001, '0.1'], [1 / 3, '0.33333333'],
    [1e-7, '1e-7'], [47.8000031, '47.800003'],
  ]) {
    assert.equal(formatNumericValue(value), text);
    assert.equal(Math.fround(Number(text)), Math.fround(value));
  }
});

const op = (id, input, output = input) => ({ id, input, output, name: id, params: [] });
const rotate = op('rotate', 'sphere');
const project = op('project', 'sphere', 'plane');
const sample = op('sample', 'plane', 'field');
const direct = op('direct', 'sphere', 'field');
const color = op('color', 'field', 'color');
const catalog = { carriers: ['sphere', 'plane', 'field', 'color'],
  operators: [rotate, project, sample, direct, color] };
const entry = (operator, label = operator.id) => ({ label, operator: operator.id });

test('band presentation reads the current chain and omits skipped carriers', () => {
  let chain = [entry(rotate), entry(project), entry(sample), entry(color)];
  const model = createChainPresentation({ catalog, chain: () => chain, legalSequences: () => [] });
  assert.deepEqual(model.bandLayout(), [
    { carrier: 'sphere', gaps: [0, 1], chips: [0], socket: 1 },
    { carrier: 'plane', gaps: [2], chips: [], socket: 2 },
    { carrier: 'field', gaps: [3], chips: [], socket: 3 },
  ]);
  chain = [entry(direct), entry(color)];
  assert.deepEqual(model.bandLayout(), [
    { carrier: 'sphere', gaps: [0], chips: [], socket: 0 },
    { carrier: 'field', gaps: [1], chips: [], socket: 1 },
  ]);
});

test('replacement offers preserve matching instance labels without inventing labels', () => {
  const chain = [entry(project, 'projection'), entry(sample, 'source'), entry(color)];
  const model = createChainPresentation({ catalog, chain: () => chain, legalSequences: () => [] });
  assert.deepEqual(model.choiceEntries({ start: 0, deleteCount: 2, operators: [project, sample, color] }),
    [entry(project, 'projection'), entry(sample, 'source'), { operator: 'color' }]);
  assert.deepEqual(model.choiceEntries({ start: 0, deleteCount: 2, operators: [direct] }),
    [{ operator: 'direct' }]);
});

test('socket choices prefer the narrowest span and stop collapse at an endomorphism', () => {
  const chain = [entry(rotate), entry(project), entry(sample), entry(color)];
  const calls = [];
  const model = createChainPresentation({ catalog, chain: () => chain,
    legalSequences: (start, count, max) => {
      calls.push([start, count, max]);
      return [{ operators: [direct] }];
    } });
  assert.deepEqual(model.socketChoices(2), [{ start: 2, deleteCount: 1, operators: [direct] }]);
  assert.deepEqual(calls, [[2, 1, 3], [1, 2, 1]]);
  assert.equal(model.sharesBand(0, 1), false);
});
