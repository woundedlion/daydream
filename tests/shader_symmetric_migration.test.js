import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  decodeShaderStateHash, encodeShaderStateHash, migrateLegacyChainSnapshot,
  migrateLegacySymmetricDocument,
} from '../src/workbench/shader/shader_deeplink.js';

const OLD = 'sphere.displace.symmetric.v1';
const CURRENT = 'sphere.displace.symmetric.v2';
const PI = Math.fround(Math.PI);
const LIMIT = Math.fround(4 * Math.PI);
const parameter = (id, value) => ({id, classification: 'preset', storage: 'binary32',
  unit: 'ratio', domain: {minimum: id.endsWith('.strength') ? -PI : -4,
    maximum: id.endsWith('.strength') ? PI : 4}, interpolation: {kind: 'SNAP'}, default: value});

function legacyDocument(strength = 0.25, amplitude = -2) {
  const parameters = [parameter('flow.strength', strength), parameter('flow.amplitude', amplitude),
    parameter('other.amplitude', 0.75)];
  return {schema_version: 2, catalog_version: 2, document_id: 'symmetric-study',
    descriptor: {chain: [{label: 'flow', operator: OLD}, {label: 'other', operator: 'untouched.v1'}],
      parameters, serialization: {schema_version: 1, fields: parameters.map(({id}) => id)}},
    preset_bank: {presets: [
      {preset_id: 'inherited', values: {'other.amplitude': 0.5}},
      {preset_id: 'strength-only', values: {'flow.strength': -0.5}},
      {preset_id: 'amplitude-only', values: {'flow.amplitude': 3}},
      {preset_id: 'zero', values: {'flow.strength': -0.5, 'flow.amplitude': 0}},
    ]}};
}

function legacySnapshot({speed = false, clock = false} = {}) {
  return {schemaVersion: 5,
    chain: [{instance: 'flow', operator: OLD}, {instance: 'other', operator: 'untouched.v1'}],
    parameters: [{name: 'flow.strength', value: 0.25}, {name: 'flow.amplitude', value: -2},
      ...(speed ? [{name: 'flow.speed', value: 0.03}] : []), {name: 'other.amplitude', value: 0.75}],
    runtime: [{instance: 'other', kind: 'phase-clock-v1', state: {phase: 0.4}},
      ...(clock ? [{instance: 'flow', kind: 'source-clock-v1', state: {primary: -1.25, secondary: 0, angle: 0}}] : [])],
    modulation: [], animationsPaused: true};
}

test('Symmetric document migration combines inherited defaults and each preset without changing the source', () => {
  const original = legacyDocument();
  const before = structuredClone(original);
  const migrated = migrateLegacySymmetricDocument(original);
  assert.deepEqual(original, before);
  assert.equal(migrated.descriptor.chain[0].operator, CURRENT);
  assert.deepEqual(migrated.descriptor.chain[1], original.descriptor.chain[1]);
  assert.deepEqual(migrated.descriptor.parameters[0],
    {...parameter('flow.strength', -0.5), domain: {minimum: -LIMIT, maximum: LIMIT}});
  assert.deepEqual(migrated.descriptor.parameters.map(({id}) => id), ['flow.strength', 'other.amplitude']);
  assert.deepEqual(migrated.descriptor.serialization.fields, ['flow.strength', 'other.amplitude']);
  assert.deepEqual(migrated.preset_bank.presets.map(({preset_id, values}) =>
    [preset_id, values['flow.strength']]), [
    ['inherited', -0.5], ['strength-only', 1], ['amplitude-only', 0.75], ['zero', -0],
  ]);
  assert.equal(migrated.preset_bank.presets[0].values['other.amplitude'], 0.5);
  assert.ok(migrated.preset_bank.presets.every(({values}) => !Object.hasOwn(values, 'flow.amplitude')));
  assert.equal(migrateLegacySymmetricDocument(migrated), migrated);
});

test('Symmetric migration supplies undeclared defaults while retaining authored Speed', () => {
  const original = legacyDocument();
  original.descriptor.parameters = [parameter('flow.speed', 0.03)];
  original.descriptor.serialization.fields = ['flow.speed'];
  original.preset_bank.presets = [{preset_id: 'default', values: {'flow.speed': -0.04}}];
  const migrated = migrateLegacySymmetricDocument(original);
  assert.equal(migrated.descriptor.parameters.find(({id}) => id === 'flow.strength').default, Math.fround(0.05));
  assert.equal(migrated.preset_bank.presets[0].values['flow.strength'], Math.fround(0.05));
  assert.equal(migrated.preset_bank.presets[0].values['flow.speed'], -0.04);
  assert.equal(migrated.descriptor.parameters.find(({id}) => id === 'flow.speed').default, 0.03);
});

test('Symmetric migration multiplies the stored binary32 operands', () => {
  const migrated = migrateLegacySymmetricDocument(legacyDocument(0.1, 0.3));
  assert.equal(migrated.descriptor.parameters[0].default, 0.030000001192092896);
  assert.equal(migrated.preset_bank.presets[0].values['flow.strength'], 0.030000001192092896);
});

for (const strength of [-PI, PI]) {
  for (const amplitude of [-4, 0, 4]) {
    test(`Symmetric migration preserves the binary32 range endpoint ${strength} * ${amplitude}`, () => {
      const original = legacyDocument(strength, amplitude);
      const migrated = migrateLegacySymmetricDocument(original);
      assert.equal(migrated.descriptor.parameters[0].default, Math.fround(strength * amplitude));
      assert.ok(Math.abs(migrated.descriptor.parameters[0].default) <= LIMIT);
    });
  }
}

for (const [strength, amplitude] of [[NaN, 1], [Infinity, 1], [null, 1], [4, 1],
  [1, NaN], [1, Infinity], [1, null], [1, 4.01], [1e40, 1]]) {
  test(`Symmetric migration refuses invalid operands ${strength}, ${amplitude}`, () => {
    assert.throws(() => migrateLegacySymmetricDocument(legacyDocument(strength, amplitude)),
      /Cannot migrate Symmetric lens.*invalid strength or amplitude/);
    const snapshot = legacySnapshot();
    snapshot.parameters[0].value = strength;
    snapshot.parameters[1].value = amplitude;
    assert.throws(() => migrateLegacyChainSnapshot(snapshot), /Cannot migrate Symmetric lens/);
  });
}

test('Symmetric snapshot migration preserves Speed and accumulated rotation', () => {
  const original = legacySnapshot({speed: true, clock: true});
  const before = structuredClone(original);
  const migrated = migrateLegacyChainSnapshot(original);
  assert.deepEqual(original, before);
  assert.equal(migrated.chain[0].operator, CURRENT);
  assert.deepEqual(migrated.parameters, [{name: 'flow.strength', value: -0.5},
    {name: 'flow.speed', value: 0.03}, {name: 'other.amplitude', value: 0.75}]);
  assert.deepEqual(migrated.runtime, original.runtime);
  assert.equal(migrateLegacyChainSnapshot(migrated), migrated);
});

test('stateless Symmetric snapshots gain zero Speed and a zero rotation clock', () => {
  const original = legacySnapshot();
  const migrated = migrateLegacyChainSnapshot(original);
  assert.deepEqual(migrated.parameters.at(-1), {name: 'flow.speed', value: 0});
  assert.deepEqual(migrated.runtime.at(-1), {instance: 'flow', kind: 'source-clock-v1',
    state: {primary: 0, secondary: 0, angle: 0}});
  assert.deepEqual(migrated.runtime[0], original.runtime[0]);
  const withSpeed = migrateLegacyChainSnapshot(legacySnapshot({speed: true}));
  assert.equal(withSpeed.runtime.length, 1, 'a missing required modern clock remains invalid');
});

test('Symmetric migration retains an absent optional runtime payload', () => {
  const snapshot = legacySnapshot();
  delete snapshot.runtime;
  assert.equal(Object.hasOwn(migrateLegacyChainSnapshot(snapshot), 'runtime'), false);
});

test('v2 deep links upgrade legacy Symmetric documents and snapshots together', async () => {
  const document = legacyDocument();
  const snapshot = legacySnapshot({speed: true, clock: true});
  const payload = {d: document, p: 'inherited', b: [], a: true, s: snapshot};
  const hash = '#shader=v2.' + gzipSync(JSON.stringify(payload)).toString('base64url');
  const decoded = await decodeShaderStateHash(hash);
  assert.equal(decoded.document.descriptor.chain[0].operator, CURRENT);
  assert.equal(decoded.document.preset_bank.presets[0].values['flow.strength'], -0.5);
  assert.equal(decoded.chainSnapshot.chain[0].operator, CURRENT);
  assert.equal(decoded.chainSnapshot.parameters.find(({name}) => name === 'flow.strength').value, -0.5);
  assert.deepEqual(decoded.chainSnapshot.runtime, snapshot.runtime);
  assert.deepEqual(JSON.parse(JSON.stringify(await decodeShaderStateHash(await encodeShaderStateHash(decoded)))),
    JSON.parse(JSON.stringify(decoded)));
  assert.equal(document.descriptor.chain[0].operator, OLD);
});
