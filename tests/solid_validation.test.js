import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChainValidator, createOpGate } from '../src/workbench/solids/solid_validation.js';
import { fakeModule } from './helpers/fake_meshops.js';

test('a rejected validator task leaves subsequent tasks usable', async () => {
  const { Mod } = fakeModule();
  const validator = createChainValidator(async () => Mod);
  await assert.rejects(validator.withValidator(() => { throw new Error('task failed'); }),
    /task failed/);
  assert.equal(await validator.withValidator((module) => module), Mod);
});

test('validator reports a thrown string and frees its standing mesh', async () => {
  const { Mod, state } = fakeModule({ onOp(token) {
    if (token === 'kis') throw 'op refused';
  } });
  const verdict = await createChainValidator(async () => Mod).chainIsValid('cube', ['kis']);
  assert.deepEqual(verdict, { ok: false, message: 'Op "kis" failed: op refused' });
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

test('gate blocks a classification refusal without reclaiming an unexhausted arena', async () => {
  const { Mod, state } = fakeModule({
    rejects: new Set(['classifyFaces']), reason: 'CONNECTIVITY_OVERFLOW',
  });
  const verdict = await createOpGate(createChainValidator(async () => Mod))
    .refresh('cube', [], ['kis']);
  assert.deepEqual(verdict, { blocked: new Set(['kis']), complete: true, abandoned: false });
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

test('gate frees a candidate whose classification throws without halting', async () => {
  const { Mod, state } = fakeModule({ onOp(token) {
    if (token === 'classifyFaces') throw new Error('classification failed');
  } });
  const verdict = await createOpGate(createChainValidator(async () => Mod))
    .refresh('cube', [], ['kis']);
  assert.deepEqual(verdict, { blocked: new Set(['kis']), complete: true, abandoned: false });
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 1);
});

test('gate returns an incomplete verdict when arena recovery cannot rebuild the base', async () => {
  const rejects = new Set(['classifyFaces']);
  const { Mod, state } = fakeModule({ rejects, onOp(token) {
    if (token === 'classifyFaces') rejects.add('base:cube');
  } });
  const verdict = await createOpGate(createChainValidator(async () => Mod))
    .refresh('cube', [], ['kis']);
  assert.deepEqual(verdict, { blocked: new Set(), complete: false, abandoned: false });
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 2);
});

test('a chain change during a probe frees the stale standing mesh before the next pass', async () => {
  let next;
  let gate;
  const { Mod, state } = fakeModule({ onOp(token) {
    if (token === 'kis' && !next) next = gate.refresh('octahedron', [], ['dual']);
  } });
  gate = createOpGate(createChainValidator(async () => Mod));
  assert.equal(await gate.refresh('cube', [], ['kis', 'ambo']), null);
  assert.deepEqual(await next, { blocked: new Set(), complete: true, abandoned: false });
  assert.equal(state.calls.includes('ambo'), false);
  assert.equal(state.live, 0);
  assert.equal(state.cleared, 2);
});
