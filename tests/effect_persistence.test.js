import test from 'node:test';
import assert from 'node:assert/strict';
import {CHAIN_SNAPSHOT_STORAGE_KEY, createEffectPersistence} from '../src/effects/effect_persistence.js';

const RESULTS = Object.freeze({APPLIED: {}, INVALID_VALUE: {}, UNSUPPORTED_VERSION: {}});

function fixture({chain = false, definitions = [], snapshot = {schemaVersion: 1}, storage = new Map()} = {}) {
  const state = {definitions, snapshot, outcome: RESULTS.APPLIED, apply: null};
  const calls = {parameters: [], snapshots: [], notices: [], warnings: [], writes: []};
  const api = {
    getParameterDefinitions: () => state.definitions,
    setParam: (name, value) => {
      calls.parameters.push([name, value]);
      if (state.apply) return state.apply(name, value);
      const definition = state.definitions.find((entry) => entry.name === name);
      if (!definition) return false;
      definition.acceptedValue = value;
      return true;
    },
    usesChainSnapshot: () => chain,
    getSnapshot: () => structuredClone(state.snapshot),
    restoreSnapshot: (candidate) => {
      calls.snapshots.push(structuredClone(candidate));
      if (state.outcome === RESULTS.APPLIED) state.snapshot = structuredClone(candidate);
      return state.outcome;
    },
    restoreResults: () => RESULTS,
  };
  const ui = {
    showImportNotice: (notice) => calls.notices.push(notice),
    logWarn: (...warning) => calls.warnings.push(warning),
  };
  const gui = {
    readStoredNumber: (name) => {
      const value = storage.get(name);
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    },
    readStoredString: (name) => typeof storage.get(name) === 'string' ? storage.get(name) : undefined,
    writeStoredValue: (name, value) => { calls.writes.push([name, value]); storage.set(name, value); },
  };
  return {state, calls, gui, storage, ...createEffectPersistence(api, ui)};
}

test('accepted parameters round-trip without requested, readonly or boolean drift', () => {
  const definitions = [
    {name: 'speed', value: 1, requestedValue: 9, acceptedValue: 3},
    {name: 'enabled', value: false, acceptedValue: true},
    {name: 'fallback', value: 2, requestedValue: 4},
    {name: 'locked', value: 7, readonly: true},
  ];
  const source = fixture({definitions});
  source.persist(source.gui);
  assert.deepEqual([...source.storage], [['__accepted.speed', 3], ['__accepted.enabled', 1],
    ['__accepted.fallback', 4]]);
  const target = fixture({definitions: definitions.map((entry) => ({...entry, acceptedValue: 0})),
    storage: new Map(source.storage)});
  target.restore(target.gui);
  assert.deepEqual(target.calls.parameters, [['speed', 3], ['enabled', 1], ['fallback', 4]]);
  assert.equal(target.state.definitions[3].acceptedValue, 0);
});

test('one edited accepted value persists without rewriting other companions', () => {
  const f = fixture({definitions: [{name: 'speed', value: 9}]});
  f.persist(f.gui, {edited: {name: 'enabled', accepted: false}});
  assert.deepEqual([...f.storage], [['__accepted.enabled', 0]]);
});

test('restore rereads topology and retries a dependent value only after progress', () => {
  const f = fixture({definitions: [{name: 'dependent', value: 0}, {name: 'mode', value: 0}],
    storage: new Map([['__accepted.dependent', 8], ['__accepted.mode', 1], ['__accepted.new', 6]])});
  let ready = false;
  f.state.apply = (name) => {
    if (name === 'mode') {
      ready = true;
      f.state.definitions.push({name: 'new', value: 0});
    }
    return name !== 'dependent' || ready;
  };
  f.restore(f.gui);
  assert.deepEqual(f.calls.parameters, [['dependent', 8], ['mode', 1], ['new', 6], ['dependent', 8]]);
});

test('existing-only persistence rewrites restored keys while preserving corrupt and refused storage', () => {
  const storage = new Map([['__accepted.restored', 5], ['__accepted.refused', 9],
    ['__accepted.corrupt', 'not a number']]);
  const f = fixture({definitions: ['restored', 'refused', 'corrupt', 'new']
    .map((name) => ({name, value: 2})), storage});
  f.state.apply = (name) => name !== 'refused';
  f.restore(f.gui);
  f.persist(f.gui, {existingOnly: true});
  assert.deepEqual(f.calls.parameters, [['restored', 5], ['refused', 9], ['refused', 9]]);
  assert.deepEqual(f.calls.writes, [['__accepted.restored', 2]]);
  assert.equal(storage.get('__accepted.refused'), 9);
  assert.equal(storage.get('__accepted.corrupt'), 'not a number');
  assert.equal(storage.has('__accepted.new'), false);
});

test('chain snapshots round-trip through their dedicated storage key', () => {
  const snapshot = {schemaVersion: 1, chain: [{instance: 'camera', operator: 'sphere.rotate.v2'}],
    parameters: [{name: 'camera.wander', value: 0.5}], animationsPaused: true};
  const source = fixture({chain: true, snapshot});
  source.persist(source.gui);
  assert.deepEqual([...source.storage], [[CHAIN_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot)]]);
  const target = fixture({chain: true, storage: new Map(source.storage)});
  target.restore(target.gui);
  assert.deepEqual(target.calls.snapshots, [snapshot]);
  assert.deepEqual(target.state.snapshot, snapshot);
  assert.deepEqual(target.calls.notices, [null]);
  assert.deepEqual(target.calls.parameters, []);
});

for (const corrupt of ['{', 'null', '[]', 'false', '42']) {
  test(`corrupt chain storage ${corrupt} remains intact and blocks persistence`, () => {
    const f = fixture({chain: true, storage: new Map([[CHAIN_SNAPSHOT_STORAGE_KEY, corrupt]])});
    f.restore(f.gui);
    f.persist(f.gui);
    assert.deepEqual(f.calls.snapshots, []);
    assert.deepEqual(f.calls.writes, []);
    assert.match(f.calls.notices[0], /invalid.*preserved/);
    assert.equal(f.calls.warnings.length, 1);
    assert.ok(f.calls.warnings[0][1] instanceof Error);
    assert.equal(f.storage.get(CHAIN_SNAPSHOT_STORAGE_KEY), corrupt);
  });
}

for (const name of ['INVALID_VALUE', 'UNSUPPORTED_VERSION']) {
  test(`an engine ${name} refusal preserves the stored snapshot until a later successful restore`, () => {
    const stored = {schemaVersion: 1, parameters: []};
    const f = fixture({chain: true, storage: new Map([[CHAIN_SNAPSHOT_STORAGE_KEY, JSON.stringify(stored)]])});
    f.state.outcome = RESULTS[name];
    f.restore(f.gui);
    f.persist(f.gui);
    assert.deepEqual(f.calls.snapshots, [stored]);
    assert.deepEqual(f.calls.writes, []);
    assert.match(f.calls.warnings[0][0], new RegExp(name));
    assert.match(f.calls.notices[0], /rejected.*preserved/);
    f.state.outcome = RESULTS.APPLIED;
    f.restore(f.gui);
    f.state.snapshot = {schemaVersion: 1, animationsPaused: true};
    f.persist(f.gui);
    assert.deepEqual(JSON.parse(f.storage.get(CHAIN_SNAPSHOT_STORAGE_KEY)), f.state.snapshot);
    assert.equal(f.calls.notices.at(-1), null);
  });
}

test('missing stored snapshots and absent live snapshots cause no writes or restores', () => {
  const f = fixture({chain: true, snapshot: null});
  f.restore(f.gui);
  f.persist(f.gui);
  assert.deepEqual(f.calls.snapshots, []);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.notices, []);
});
