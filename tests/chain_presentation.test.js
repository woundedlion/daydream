import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainPresentation } from '../src/workbench/shader/chain_presentation.js';
import { titleCase } from '../src/shared/labels.js';

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

test('shared labels preserve empty segments and single-letter words', () => {
  assert.equal(titleCase(''), '');
  assert.equal(titleCase('x-offset'), 'X Offset');
  assert.equal(titleCase('edge--fade'), 'Edge  Fade');
});
