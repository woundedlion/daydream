//
// Tests for src/workbench/shader/chain_apply.js, which applies a compiled chain
// document to the chain engine: setShaderChain, then the preset values by
// parameter id, then the GUI resync and repaint.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyChainDocument } from '../src/workbench/shader/chain_apply.js';
import {
  FakeChainEngine, ChainStatus, ParamSetResult, ChainSnapshotRestoreResult, unpinnedEngineMethods,
} from './helpers/fake_engine.js';

const MODULE = { ParamSetResult };

const CHAIN = [
  { label: 'camera', operator: 'sphere.rotate.v2' },
  { label: 'project', operator: 'project.stereographic.v2' },
  { label: 'sample', operator: 'sample.grid.v3' },
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
  engine.setEffect('ShaderChain');
  const order = [];
  const originalChain = engine.bindings.setShaderChain.bind(engine);
  engine.bindings.setShaderChain = (entries) => {
    order.push('setShaderChain');
    return originalChain(entries);
  };
  const originalWrite = engine.bindings.setShaderChainParameters.bind(engine);
  engine.bindings.setShaderChainParameters = (writes) => {
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
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  assert.deepEqual(unpinnedEngineMethods(engine), []);
  const bindings = engine.getShaderChainBindings();
  engine.getShaderChainBindings = () => ({...bindings, obsoleteBindingMethod() {}});
  assert.deepEqual(unpinnedEngineMethods(engine), ['ShaderChainBindings.obsoleteBindingMethod']);
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
  for (const [preset, value] of [['noon', 0.1], ['dusk', 0.9]]) {
    const h = harness();
    assert.equal(h.run(compiledDocument({ 'sample.speed': 0.1 }, { 'sample.speed': 0.9 }), preset), null);
    assert.deepEqual(h.engine.writes, [['sample.speed', value]]);
  }
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

test('an injected APPLIED cannot report success without applying the chain', () => {
  const { engine, order, run } = harness();
  const generation = engine.generation;
  const program = engine.program;
  const definitions = engine.definitions;
  const compiled = compiledDocument();
  compiled.document.descriptor.chain.shift();
  engine.nextChainResult = { code: 'APPLIED', entryIndex: -1 };
  assert.throws(() => run(compiled), /Injected chain results must be refusals/);
  assert.equal(engine.generation, generation);
  assert.equal(engine.program, program);
  assert.equal(engine.definitions, definitions);
  assert.deepEqual(order, ['setShaderChain']);
});

test('an entry-level refusal names the offending chain entry', () => {
  for (const index of [0, 1]) {
    const { run } = harness();
    const compiled = compiledDocument({});
    compiled.document.descriptor.chain[index] = { label: 'unknown', operator: 'project.unknown.v9' };
    assert.match(run(compiled), new RegExp(`UNKNOWN_OPERATOR.*chain entry ${index}`));
  }
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
  assert.ok(!order.includes('setShaderChainParameters'));
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

test('the fake chain engine advances generations after repeated application', () => {
  const { engine, run } = harness();
  const before = engine.getParamGeneration();
  const installed = ['sphere.rotate.v2', 'project.stereographic.v2', 'sample.grid.v3',
    'colorize.generated-palette.v3'].reduce((count, id) =>
    count + engine.catalog.operators.find((operator) => operator.id === id).params.length, 0);
  assert.ok(installed > 0);
  assert.equal(engine.getParameterDefinitions().length, installed,
    'the default chain installs its definitions');

  assert.equal(run(compiledDocument({ 'sample.pattern-freq': 3 })), null);
  const after = engine.getParamGeneration();
  assert.notEqual(after, before,
    'an APPLIED setShaderChain must move the generation');
  assert.ok(engine.getParameterDefinitions()
    .some((definition) => definition.name === 'sample.pattern-freq'),
  'the fake exposes definitions after accepting the chain');

  assert.equal(run(compiledDocument({ 'sample.pattern-freq': 5 })), null);
  assert.notEqual(engine.getParamGeneration(), after,
    'a re-chain bumps the generation again');
});

test('an inadmissible preset is submitted together and reports native refusal', () => {
  const { engine, order, run } = harness();
  const values = { 'sample.speed': 0.5, 'camera.wander': 0.75 };
  engine.bindings.setShaderChainParameters = (writes) => {
    order.push('batch-refused');
    assert.deepEqual(writes, Object.entries(values).map(([name, value]) => ({ name, value })));
    return ParamSetResult.INADMISSIBLE;
  };
  engine.setParameter = () => { throw new Error('preset fields must be admitted together'); };

  assert.match(run(compiledDocument(values)), /preset: INADMISSIBLE/);
  assert.deepEqual(order, ['setShaderChain', 'batch-refused', 'syncEffectGui', 'invalidate']);
});

test('the fake chain engine exposes status identities on every return path', () => {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  assert.equal(engine.bindings.setShaderChain(null).status, ChainStatus.MALFORMED_PAYLOAD);
  assert.equal(engine.bindings.setShaderChain([{ instance: 'x', operator: 'unknown' }]).status,
    ChainStatus.UNKNOWN_OPERATOR);
  engine.nextChainResult = { code: 'ARENA_OVERFLOW', entryIndex: -1 };
  assert.equal(engine.bindings.setShaderChain([]).status, ChainStatus.ARENA_OVERFLOW);
  assert.equal(engine.bindings.setShaderChain([]).status, ChainStatus.EMPTY);
  assert.equal(engine.bindings.setShaderChain(Array.from({ length: 33 }, () => ({}))).status,
    ChainStatus.TOO_LONG);
  const duplicate = { instance: 'same', operator: 'sphere.rotate.v2' };
  assert.equal(engine.bindings.setShaderChain([duplicate, duplicate]).status, ChainStatus.DUPLICATE_INSTANCE);
  engine.setEffect('Comets');
  assert.equal(engine.bindings.setShaderChain([]).status, ChainStatus.NOT_CHAIN_EFFECT);
});

test('fake parameter batches distinguish malformed and oversized payloads', () => {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  engine.bindings.setShaderChain(CHAIN.map(({ label, operator }) => ({ instance: label, operator })));
  const before = engine.getParameterDefinitions();
  for (const payload of [null, undefined, {}, [null], [undefined],
    [{ name: 1, value: 0 }], [{ name: 'camera.wander' }],
    [{ name: 'camera.wander', value: '0.5' }]]) {
    assert.equal(engine.bindings.setShaderChainParameters(payload), ParamSetResult.MALFORMED_PAYLOAD);
  }
  assert.equal(engine.bindings.setShaderChainParameters(
    Array(engine.catalog.budgets.max_params + 1).fill({ name: 'camera.wander', value: 0 })),
  ParamSetResult.TOO_LONG);
  assert.equal(engine.bindings.setShaderChainParameters([{ name: 'camera.wander', value: NaN }]),
    ParamSetResult.NON_FINITE);
  assert.deepEqual(engine.getParameterDefinitions(), before);
});

test('FakeChainEngine refuses invalid snapshot writes and runtime atomically', () => {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  const before = bindings.getSnapshot();
  const target = structuredClone(before);
  target.chain[0].instance = 'replacement';
  target.parameters = target.parameters.map((write) => ({
    ...write, name: write.name.replace(/^camera\./, 'replacement.'),
  }));
  target.runtime[0].instance = 'replacement';
  const numeric = target.parameters.find((write) => write.name.endsWith('.speed'))
    ?? target.parameters[0];
  const invalid = [
    { ...target, parameters: [...target.parameters, target.parameters[0]] },
    { ...target, parameters: [{ name: 'unknown', value: 0 }] },
    { ...target, parameters: [{ ...numeric, value: 1e9 }] },
    { ...target, runtime: [] },
    { ...target, runtime: [...target.runtime, target.runtime[0]] },
    { ...target, runtime: [...target.runtime, { ...target.runtime[0], instance: 'unknown' }] },
  ];
  const enumDefinition = engine.definitions.find((definition) => definition.options);
  assert.ok(enumDefinition, 'the default chain exposes an enum parameter');
  invalid.push({ ...before, parameters: [{ name: enumDefinition.name, value: 0.5 }] });
  for (const snapshot of invalid) {
    assert.equal(bindings.restoreSnapshot(snapshot), ChainSnapshotRestoreResult.INVALID_CHAIN);
    assert.deepEqual(bindings.getSnapshot(), before);
  }
  assert.equal(bindings.restoreSnapshot(target), ChainSnapshotRestoreResult.APPLIED);
  assert.deepEqual(bindings.getSnapshot(), target);
});


test('chain presets write sparse option IDs and refuse numeric gaps before writing', () => {
  for (const value of ['Shells', 6, 2]) {
    const { engine, run } = harness();
    engine.getParameterDefinitions = () => [{ name: 'sample.pattern',
      options: ['Cubic', 'Octet Truss', 'Shells'], optionValues: [0, 1, 6] }];
    engine.bindings.setShaderChainParameters = writes => {
      engine.writes.push(...writes.map(({ name, value }) => [name, value]));
      return ParamSetResult.APPLIED;
    };
    const result = run(compiledDocument({ 'sample.pattern': value }));
    if (value === 2) {
      assert.match(result, /has no option value 2/);
      assert.deepEqual(engine.writes, []);
    } else {
      assert.equal(result, null);
      assert.deepEqual(engine.writes, [['sample.pattern', 6]]);
    }
  }
});
