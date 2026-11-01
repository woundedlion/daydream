import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callWorkbenchBinding, getChainSnapshot, restoreChainSnapshot, shaderChainCatalog, upgradeTwistSnapshot } from '../src/engine/workbench_bindings.js';

const ANGLE_CATALOG = {operators: [{id: 'sphere.lens.twist.v2', params: [{id: 'twist-angle'}]}]};
const legacyTwistSnapshot = () => ({schemaVersion: 4,
  chain: ['north', 'south', 'default'].map((instance) => ({instance, operator: 'sphere.lens.twist.v2'}))
    .concat([{instance: 'other', operator: 'sphere.rotate.v2'}]),
  parameters: [{name: 'north.twist-rate', value: 12}, {name: 'north.twist-distribution', value: 1},
    {name: 'south.twist-rate', value: -3}, {name: 'south.twist-distribution', value: 0},
    {name: 'default.twist-rate', value: 0.75}, {name: 'other.twist-rate', value: 4}],
  modulation: [], animationsPaused: true,
  runtime: [{instance: 'north', kind: 'twist-clock-v1', state: {phi: 0.4, lambda: -0.7}}],
  paletteBank: {chroma: 0.5},
});

test('Twist snapshot angles retain each instance distribution, runtime and unrelated values', () => {
  const snapshot = legacyTwistSnapshot();
  const before = structuredClone(snapshot);
  const upgraded = upgradeTwistSnapshot(snapshot, ANGLE_CATALOG);
  assert.notEqual(upgraded, snapshot);
  assert.deepEqual(snapshot, before);
  const values = Object.fromEntries(upgraded.parameters.map(({name, value}) => [name, value]));
  assert.equal(values['north.twist-angle'], Math.fround(24 * Math.atanh(0.999) / 0.999));
  assert.equal(values['south.twist-angle'], -6);
  const a = 0.999 * Math.fround(0.85);
  assert.equal(values['default.twist-angle'], Math.fround(1.5 * Math.atanh(a) / a));
  assert.equal(values['other.twist-rate'], 4);
  assert.deepEqual(upgraded, {...before, parameters: upgraded.parameters});
  assert.equal(upgradeTwistSnapshot(upgraded, ANGLE_CATALOG), upgraded);
  assert.equal(upgradeTwistSnapshot(snapshot, null), snapshot);
  assert.equal(upgradeTwistSnapshot(snapshot, {operators: [{id: 'sphere.lens.twist.v2', params: [{id: 'twist-rate'}]}]}), snapshot);
  assert.equal(upgradeTwistSnapshot({...snapshot, schemaVersion: 3}, ANGLE_CATALOG).schemaVersion, 3);
});

test('Twist snapshot migration leaves malformed and colliding inputs intact', () => {
  const changes = [
    (s) => { s.schemaVersion = 2; },
    (s) => { s.chain = null; },
    (s) => { s.modulation = null; },
    (s) => { s.chain.push({...s.chain[0]}); },
    (s) => { s.chain.push(null); },
    (s) => { s.parameters.push(null); },
    (s) => { s.parameters.push({...s.parameters[0]}); },
    (s) => { s.parameters.push({name: 'north.twist-angle', value: 4}); },
    ...[NaN, Infinity, '2', null, -12.1, 12.1].map((value) => (s) => { s.parameters[0].value = value; }),
    ...[NaN, Infinity, '0.5', null, -0.1, 1.1].map((value) => (s) => { s.parameters[1].value = value; }),
  ];
  for (const change of changes) {
    const snapshot = legacyTwistSnapshot();
    change(snapshot);
    const before = structuredClone(snapshot);
    assert.equal(upgradeTwistSnapshot(snapshot, ANGLE_CATALOG), snapshot);
    assert.deepEqual(snapshot, before);
  }
});

test('snapshot restore upgrades legacy Twist values against the module catalog', () => {
  const snapshot = legacyTwistSnapshot();
  let received;
  let releases = 0;
  const engine = {getShaderChainBindings: () => ({
    restoreSnapshot: (value) => { received = value; return 'applied'; },
    delete: () => { releases++; },
  })};
  const module = {ChainSnapshotRestoreResult: {NOT_SHADER_CHAIN: 'unavailable'},
    ShaderChainBindings: {getShaderChainCatalog: () => JSON.stringify(ANGLE_CATALOG)}};
  assert.equal(restoreChainSnapshot(engine, module, snapshot), 'applied');
  assert.equal(received.parameters[0].name, 'north.twist-angle');
  assert.equal(received.parameters[0].value, Math.fround(24 * Math.atanh(0.999) / 0.999));
  assert.deepEqual(received, upgradeTwistSnapshot(snapshot, ANGLE_CATALOG));
  assert.equal(releases, 1);
  delete module.ShaderChainBindings;
  assert.equal(restoreChainSnapshot(engine, module, snapshot), 'applied');
  assert.equal(received, snapshot);
});

test('snapshot helpers share typed restore refusal and release their handles', () => {
  const snapshot = {schemaVersion: 3};
  const unavailable = {};
  const applied = {};
  const module = {ChainSnapshotRestoreResult: {NOT_SHADER_CHAIN: unavailable}};
  let releases = 0;
  const engine = {getShaderChainBindings: () => ({
    getSnapshot: () => snapshot,
    restoreSnapshot: (value) => { assert.equal(value, snapshot); return applied; },
    delete: () => { releases++; },
  })};
  assert.equal(getChainSnapshot(engine), snapshot);
  assert.equal(restoreChainSnapshot(engine, module, snapshot), applied);
  assert.equal(releases, 2);
  assert.equal(getChainSnapshot(null), null);
  assert.equal(restoreChainSnapshot(null, module, snapshot), unavailable);
});

test('typed capability takes precedence over a forwarding engine method and releases its handle', () => {
  const calls = [];
  const engine = {
    setShaderChain: () => { throw new Error('forwarding method reached'); },
    getShaderChainBindings: () => ({
      setShaderChain: (entries) => { calls.push(entries); return 'accepted'; },
      delete: () => { calls.push('released'); },
    }),
  };
  assert.equal(callWorkbenchBinding(engine, 'setShaderChain', [[]]), 'accepted');
  assert.deepEqual(calls, [[], 'released']);
});

test('unsupported capabilities never fall through to an engine forwarding method', () => {
  const engine = {
    getShaderChainBindings: () => null,
    getSnapshot: () => { throw new Error('unsupported capability reached'); },
  };
  assert.equal(callWorkbenchBinding(engine, 'getSnapshot', []), null);
  assert.equal(callWorkbenchBinding(null, 'getSnapshot', []), null);
});

test('missing capabilities return unavailable without calling facade methods', () => {
  assert.equal(callWorkbenchBinding({ getSnapshot: () => 'snapshot' },
    'getSnapshot', []), null);
});

test('ordinary errors release handles; module traps leave the halted module alone', () => {
  for (const error of [new Error('decode'), new WebAssembly.RuntimeError('trap')]) {
    let released = false;
    const engine = {
      getShaderChainBindings: () => ({
        setShaderChain: () => { throw error; },
        delete: () => { released = true; },
      }),
    };
    assert.throws(() => callWorkbenchBinding(engine, 'setShaderChain', [[]]),
      (caught) => caught === error);
    assert.equal(released, !(error instanceof WebAssembly.RuntimeError));
  }
});

test('catalog export uses the typed adapter', () => {
  assert.equal(shaderChainCatalog({
    ShaderChainBindings: { getShaderChainCatalog: () => 'typed' },
    HolosphereEngine: { getShaderChainCatalog: () => 'forwarding' },
  }), 'typed');

});
