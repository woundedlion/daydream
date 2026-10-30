import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeChainEngine, ChainStatus, ParamSetResult, ChainSnapshotRestoreResult, unpinnedEngineMethods,
} from './helpers/fake_engine.js';

const CHAIN = [
  { label: 'camera', operator: 'sphere.rotate.v2' },
  { label: 'project', operator: 'project.stereographic.v2' },
  { label: 'sample', operator: 'sample.grid.v3' },
  { label: 'colorize', operator: 'colorize.generated-palette.v3' },
];

test('FakeChainEngine mocks nothing outside the pinned engine surface', () => {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  assert.deepEqual(unpinnedEngineMethods(engine), []);
  const bindings = engine.getShaderChainBindings();
  engine.getShaderChainBindings = () => ({...bindings, obsoleteBindingMethod() {}});
  assert.deepEqual(unpinnedEngineMethods(engine), ['ShaderChainBindings.obsoleteBindingMethod']);
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
  assert.equal(engine.bindings.setShaderChain(
    Array.from({ length: engine.catalog.budgets.max_chain_ops + 1 }, () => ({}))).status,
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
    assert.equal(bindings.restoreSnapshot(snapshot), ChainSnapshotRestoreResult.INVALID_VALUE);
    assert.deepEqual(bindings.getSnapshot(), before);
  }
  assert.equal(bindings.restoreSnapshot(target), ChainSnapshotRestoreResult.APPLIED);
  assert.deepEqual(bindings.getSnapshot(), target);
});

test('an injected APPLIED cannot report success without applying the chain', () => {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  const generation = engine.getParamGeneration();
  const program = engine.program;
  const definitions = engine.definitions;
  engine.nextChainResult = { code: 'APPLIED', entryIndex: -1 };
  assert.throws(() => engine.bindings.setShaderChain(CHAIN.slice(1)
    .map(({ label, operator }) => ({ instance: label, operator }))),
  /Injected chain results must be refusals/);
  assert.equal(engine.getParamGeneration(), generation);
  assert.equal(engine.program, program);
  assert.equal(engine.definitions, definitions);
});

test('fake snapshots refuse invalid modulation recipes without changing state', () => {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  const bindings = engine.getShaderChainBindings();
  const before = bindings.getSnapshot();
  for (const change of [
    (value) => { value.modulation[0].recipe = {}; },
    (value) => { value.modulation[0].recipe.mechanic.amount = 10; },
    (value) => { value.modulation[0].recipe.sine.offset = 1000; },
    (value) => { value.modulation[0].recipe.noise.variant = 7; },
    (value) => { value.modulation[0].recipe.sine.axis = [0, 1]; },
    (value) => { value.modulation[0].recipe.noise.basis = 1; },
    (value) => { value.modulation[0].recipe.mechanic = {kind: 2, amount: -0.1}; },
    (value) => { value.modulation[0].recipe.version = 2; },
    (value) => { value.modulation[0].recipe.seed = 2 ** 31; },
    (value) => { value.parameters.push({name: 'colorize.pattern-speed', value: 0}); },
    (value) => { value.runtime.find((entry) => entry.kind === 'color-clock-v2').state.modulation.source = 1; },
  ]) {
    const candidate = structuredClone(before);
    change(candidate);
    assert.equal(bindings.restoreSnapshot(candidate), ChainSnapshotRestoreResult.INVALID_VALUE);
    assert.deepEqual(bindings.getSnapshot(), before);
  }
  const valid = structuredClone(before);
  valid.modulation[0].recipe.mechanic.amount = 3;
  assert.equal(bindings.restoreSnapshot(valid), ChainSnapshotRestoreResult.APPLIED);
  assert.deepEqual(bindings.getSnapshot(), valid);
});

test('fake source writes synchronize the snapshot clock with the selected recipe', () => {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  assert.equal(engine.setParameter('colorize.modulation-evaluation', 0), ParamSetResult.APPLIED);
  assert.equal(engine.setParameter('colorize.modulation-source', 1), ParamSetResult.APPLIED);
  const bindings = engine.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  assert.equal(snapshot.modulation[0].recipe.source, 1);
  const clock = snapshot.runtime.find((entry) => entry.kind === 'color-clock-v2').state.modulation;
  assert.equal(clock.source, 1);
  assert.equal(clock.phaseTurns, 0);
  assert.equal(bindings.restoreSnapshot(snapshot), ChainSnapshotRestoreResult.APPLIED);
});

test('the fake chain engine advances generations after repeated application', () => {
  const engine = new FakeChainEngine();
  engine.setEffect('ShaderChain');
  const installed = CHAIN.reduce((count, { operator: id }) =>
    count + engine.catalog.operators.find(operator => operator.id === id).params.length, 0);
  assert.ok(installed > 0);
  assert.equal(engine.getParameterDefinitions().length, installed);
  const chain = CHAIN.map(({ label, operator }) => ({ instance: label, operator }));
  let generation = engine.getParamGeneration();
  for (let i = 0; i < 2; i++) {
    assert.equal(engine.bindings.setShaderChain(chain).status, ChainStatus.OK);
    assert.notEqual(engine.getParamGeneration(), generation);
    assert.ok(engine.getParameterDefinitions()
      .some(definition => definition.name === 'sample.pattern-freq'));
    generation = engine.getParamGeneration();
  }
});
