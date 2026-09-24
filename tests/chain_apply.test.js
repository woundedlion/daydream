//
// tools/chain_apply.js applies a compiled chain document to the chain engine
// in one fixed order: setShaderChain, then the preset values by parameter id
// (enum8s as the option index the post-APPLIED definitions resolve), then the
// GUI resync and repaint. The engine double is tests/fake_engine.js's
// FakeChainEngine, which rebuilds definitions from the pinned catalog and
// bumps the param generation on every APPLIED exactly as the module does.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyChainDocument } from '../tools/chain_apply.js';
import {
  FakeChainEngine, ParamSetResult, unpinnedEngineMethods,
} from './fake_engine.js';

const MODULE = { ParamSetResult };

const CHAIN = [
  { label: 'camera', operator: 'sphere.rotate.v2' },
  { label: 'project', operator: 'project.stereographic.v2' },
  { label: 'sample', operator: 'sample.grid.v2' },
  { label: 'colorize', operator: 'colorize.generated-palette.v3' },
];

/**
 * A compiled-document shape carrying the minimal chain and presets.
 * @param {Object} [values] - First preset's values.
 * @param {Object} [second] - Optional second preset's values.
 */
const compiledDocument = (values = {}, second = null) => ({
  document: {
    descriptor: { chain: CHAIN.map((entry) => ({ ...entry })) },
    preset_bank: { presets: [
      { preset_id: 'noon', values },
      ...(second === null ? [] : [{ preset_id: 'dusk', values: second }]),
    ] },
  },
});

/** A harness over one FakeChainEngine, recording the call order. */
function harness() {
  const engine = new FakeChainEngine();
  const order = [];
  const originalChain = engine.setShaderChain.bind(engine);
  engine.setShaderChain = (entries) => {
    order.push('setShaderChain');
    return originalChain(entries);
  };
  const originalWrite = engine.setShaderChainParameters.bind(engine);
  engine.setShaderChainParameters = (writes) => {
    order.push('setShaderChainParameters');
    return originalWrite(writes);
  };
  const run = (compiled, presetId = 'noon') => applyChainDocument({
    engine,
    module: MODULE,
    compiled,
    presetId,
    syncEffectGui: () => order.push('syncEffectGui'),
    invalidate: () => order.push('invalidate'),
  });
  return { engine, order, run };
}

test('FakeChainEngine mocks nothing outside the pinned engine surface', () => {
  assert.deepEqual(unpinnedEngineMethods(new FakeChainEngine()), []);
});

test('unknown preset refuses before installing the chain', () => {
  const { run, order } = harness();
  assert.match(run(compiledDocument(), 'missing'), /no preset "missing"/);
  assert.deepEqual(order, []);
});

test('apply runs setShaderChain, the writes, the resync and the repaint in order', () => {
  const { engine, order, run } = harness();

  assert.equal(run(compiledDocument({
    'sample.pattern-freq': 3,
    'camera.wander': 0.5,
  })), null);
  assert.deepEqual(order, [
    'setShaderChain',
    'setShaderChainParameters',
    'syncEffectGui',
    'invalidate',
  ]);
  assert.deepEqual(engine.chainCalls, [CHAIN.map(
    (entry) => ({ instance: entry.label, operator: entry.operator }))]);
  assert.deepEqual(engine.writes,
    [['sample.pattern-freq', 3], ['camera.wander', 0.5]]);
});

test('an enum8 value is written as its option index from the fresh definitions', () => {
  const { engine, run } = harness();

  assert.equal(run(compiledDocument({
    'sample.coverage-mode': 'weight-squared',
    'colorize.palette-mode': 'analogous',
  })), null);
  const options = engine.getParameterDefinitions()
    .find((definition) => definition.name === 'sample.coverage-mode').options;
  assert.deepEqual(options, ['none', 'weight', 'weight-squared', 'edge-fade'],
    'the catalog enum values are the option roster, in order');
  assert.deepEqual(engine.writes,
    [['sample.coverage-mode', 2], ['colorize.palette-mode', 2]]);
});

test('the named preset is the one applied', () => {
  const first = harness();
  assert.equal(first.run(compiledDocument(
    { 'sample.speed': 0.1 }, { 'sample.speed': 0.9 }), 'dusk'), null);
  assert.deepEqual(first.engine.writes, [['sample.speed', 0.9]]);

});

test('a setShaderChain refusal is surfaced verbatim and stops the apply', () => {
  const { engine, order, run } = harness();
  engine.nextChainResult = { code: 'ARENA_OVERFLOW', entryIndex: -1 };

  const refusal = run(compiledDocument({ 'sample.speed': 0.5 }));
  assert.match(refusal, /ARENA_OVERFLOW/);
  assert.doesNotMatch(refusal, /entry/,
    'entryIndex -1 blames the whole chain, not an entry');
  assert.deepEqual(order, ['setShaderChain'],
    'a refused chain writes no values and repaints nothing');
});

test('an entry-level refusal names the offending chain entry', () => {
  const { run } = harness();
  const compiled = compiledDocument({});
  compiled.document.descriptor.chain[1] =
    { label: 'project', operator: 'project.unknown.v9' };

  const refusal = run(compiled);
  assert.match(refusal, /UNKNOWN_OPERATOR/);
  assert.match(refusal, /chain entry 1/);
});

test('a value the chain never registered still resyncs rebuilt definitions', () => {
  const { order, run } = harness();

  const refusal = run(compiledDocument({ 'ghost.speed': 0.5 }));
  assert.match(refusal, /no parameter "ghost\.speed"/);
  assert.ok(order.includes('syncEffectGui'));
  assert.ok(order.includes('invalidate'));
});

test('an enum value outside the option roster is refused by name', () => {
  const { engine, run } = harness();

  const refusal = run(compiledDocument({ 'sample.coverage-mode': 'shadow' }));
  assert.match(refusal, /"sample\.coverage-mode" has no option "shadow"/);
  assert.deepEqual(engine.writes, []);
});

test('an unresolvable value aborts before the first write', () => {
  const { engine, order, run } = harness();

  const refusal = run(compiledDocument({
    'sample.pattern-freq': 3,
    'sample.coverage-mode': 'shadow',
    'camera.wander': 0.5,
  }));
  assert.match(refusal, /"sample\.coverage-mode" has no option "shadow"/);
  assert.deepEqual(engine.writes, [],
    'the values resolve up front, so a late refusal writes none of them');
  assert.ok(!order.some((step) => step.startsWith('setParameter')));
});

test('a read-only parameter is refused before the first write', () => {
  const { engine, run } = harness();
  const original = engine.getParameterDefinitions.bind(engine);
  engine.getParameterDefinitions = () => original().map((definition) =>
    (definition.name === 'camera.wander'
      ? { ...definition, readonly: true } : definition));

  const refusal = run(compiledDocument({
    'sample.speed': 0.5, 'camera.wander': 0.5,
  }));
  assert.match(refusal, /"camera\.wander" is read-only/);
  assert.deepEqual(engine.writes, []);
});

test('a non-numeric value is refused before the first write', () => {
  const { engine, run } = harness();

  const refusal = run(compiledDocument({
    'sample.speed': 0.5, 'camera.wander': null,
  }));
  assert.match(refusal, /"camera\.wander" has no numeric value/);
  assert.deepEqual(engine.writes, []);
});

test('every APPLIED bumps the generation and refreshes the definitions', () => {
  const { engine, run } = harness();
  const before = engine.getParamGeneration();
  assert.deepEqual(engine.getParameterDefinitions(), [],
    'no definitions exist until a chain lands');

  assert.equal(run(compiledDocument({ 'sample.pattern-freq': 3 })), null);
  const after = engine.getParamGeneration();
  assert.notEqual(after, before,
    'an APPLIED setShaderChain must move the generation');
  assert.ok(engine.getParameterDefinitions()
    .some((definition) => definition.name === 'sample.pattern-freq'),
  'the applied values were resolved against the post-APPLIED snapshot');

  assert.equal(run(compiledDocument({ 'sample.pattern-freq': 5 })), null);
  assert.notEqual(engine.getParamGeneration(), after,
    'a re-chain bumps the generation again');
});

test('an inadmissible preset is submitted together and reports native refusal', () => {
  const { engine, order, run } = harness();
  const values = { 'sample.speed': 0.5, 'camera.wander': 0.75 };
  engine.setShaderChainParameters = (writes) => {
    assert.deepEqual(writes, Object.entries(values).map(([name, value]) => ({ name, value })));
    return ParamSetResult.INADMISSIBLE;
  };
  engine.setParameter = () => { throw new Error('preset fields must be admitted together'); };

  assert.match(run(compiledDocument(values)), /preset: INADMISSIBLE/);
  assert.deepEqual(engine.writes, []);
  assert.deepEqual(order.slice(-2), ['syncEffectGui', 'invalidate']);
});

test('fake parameter batches distinguish malformed and oversized payloads', () => {
  const engine = new FakeChainEngine();
  engine.setShaderChain(CHAIN.map(({ label, operator }) => ({ instance: label, operator })));
  const before = engine.getParameterDefinitions();
  for (const payload of [null, undefined, {}, [null], [undefined],
    [{ name: 1, value: 0 }], [{ name: 'camera.wander' }],
    [{ name: 'camera.wander', value: '0.5' }]]) {
    assert.equal(engine.setShaderChainParameters(payload), ParamSetResult.MALFORMED_PAYLOAD);
  }
  assert.equal(engine.setShaderChainParameters(
    Array(engine.catalog.budgets.max_params + 1).fill({ name: 'camera.wander', value: 0 })),
  ParamSetResult.TOO_LONG);
  assert.equal(engine.setShaderChainParameters([{ name: 'camera.wander', value: NaN }]),
    ParamSetResult.NON_FINITE);
  assert.deepEqual(engine.getParameterDefinitions(), before);
});
