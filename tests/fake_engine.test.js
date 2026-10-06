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
