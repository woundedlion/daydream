import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { convertLegacyShaderSnapshot, documentFromChainSnapshot } from '../src/effects/legacy_shader_snapshot.js';
import { LEGACY_SHADER_FIELDS } from '../src/effects/legacy_shader_schema.js';
import { compileShaderDocument } from '../generated/shader/shader_workbench.mjs';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/legacy_shader_snapshots.json', import.meta.url)));
const catalog = JSON.parse(readFileSync(new URL('../generated/shader/engine_catalog.json', import.meta.url)));
const baseline = () => structuredClone(fixtures[0].presets[0].snapshot);
const fieldId = (name) => LEGACY_SHADER_FIELDS.indexOf(name);
const floatBits = (value) => { const bytes = new DataView(new ArrayBuffer(4)); bytes.setFloat32(0, value, true); return bytes.getUint32(0, true); };
const change = (snapshot, name, value) => { const id = fieldId(name); snapshot.accepted[id] = value; snapshot.requested[id] = value; };

for (const row of fixtures) {
  test(`all 24 captured legacy presets compile as editable chains at ${row.width}x${row.height}`, () => {
    assert.equal(row.presets.length, 24);
    for (const preset of row.presets) {
      const original = structuredClone(preset.snapshot);
      const converted = convertLegacyShaderSnapshot(original, catalog);
      assert.equal(converted.ok, true, `preset ${preset.index}: ${converted.reason}`);
      assert.deepEqual(original, preset.snapshot, 'conversion leaves the archive intact');
      assert.deepEqual(converted.legacy.original, original);
      const document = documentFromChainSnapshot(converted.snapshot, catalog);
      const compiled = compileShaderDocument(document, {catalog});
      assert.equal(compiled.status, 'VALID', `preset ${preset.index}: ${JSON.stringify(compiled.diagnostics)}`);
      assert.equal(converted.snapshot.parameters.length, document.descriptor.parameters.length);
      const source = converted.snapshot.chain.find((entry) => entry.instance === 'sample');
      assert.ok(source.operator.startsWith('sample.'));
      const chroma = converted.snapshot.parameters.find((entry) => entry.name === 'colorize.palette-chroma');
      const bytes = new DataView(new ArrayBuffer(4));
      bytes.setUint32(0, original.accepted[fieldId('params.color.palette_chroma')], true);
      assert.equal(chroma.value, bytes.getFloat32(0, true));
    }
  });
}

test('archive storage IDs preserve Polar Chart, Vector Noise, and dodecahedral symmetry', () => {
  const polar = convertLegacyShaderSnapshot(fixtures[0].presets[9].snapshot, catalog).snapshot;
  assert.equal(polar.chain.find((entry) => entry.instance === 'outer').operator, 'warp.polar-chart.v2');
  const vector = convertLegacyShaderSnapshot(fixtures[0].presets[10].snapshot, catalog).snapshot;
  assert.equal(vector.chain.find((entry) => entry.instance === 'outer').operator, 'warp.vector-noise.v2');
  const original = baseline();
  change(original, 'slots.surface_lens', 8);
  const lens = convertLegacyShaderSnapshot(original, catalog).snapshot;
  assert.equal(lens.parameters.find((entry) => entry.name === 'lens.symmetry').value, 3);
});

test('version 10 and pending requests preserve their complete archive while importing accepted state', () => {
  const original = baseline();
  original.schemaVersion = 10;
  original.accepted.push(2);
  original.requested.push(3);
  original.pendingFieldIds = [152];
  const chroma = fieldId('params.color.palette_chroma');
  original.requested[chroma] = floatBits(0.3);
  original.pendingFieldIds.push(chroma);
  const result = convertLegacyShaderSnapshot(original, catalog);
  assert.equal(result.ok, true);
  assert.deepEqual(result.legacy.original, original);
  assert.deepEqual(result.legacy.pendingFieldIds, [152, chroma]);
  assert.match(result.notice, /Pending edits remain preserved/);
  assert.notEqual(result.snapshot.parameters.find((entry) => entry.name === 'colorize.palette-chroma').value, Math.fround(0.3));
});

test('unsupported layouts and malformed archives retain the original with an actionable refusal', () => {
  const edits = [
    (value) => { value.schemaVersion = 12; },
    (value) => { value.accepted.pop(); },
    (value) => { value.requested[0] = -1; },
    (value) => { value.pendingFieldIds = [0, 0]; },
    (value) => { value.pendingFieldIds = [0]; },
    (value) => { value.hasRuntime = true; value.runtime = [NaN]; },
    (value) => change(value, 'slots.surface_lens', 5),
    (value) => change(value, 'slots.warp_program.outer.kind', 1),
    (value) => { change(value, 'slots.projection', 4); change(value, 'slots.peirce_layout', 4); },
    (value) => change(value, 'params.color.palette_chroma', floatBits(NaN)),
    (value) => change(value, 'params.color.palette_chroma', floatBits(2)),
  ];
  for (const edit of edits) {
    const original = baseline();
    edit(original);
    const result = convertLegacyShaderSnapshot(original, catalog);
    assert.equal(result.ok, false);
    assert.equal(result.original, original);
    assert.ok(result.reason.length > 10);
  }
  assert.equal(convertLegacyShaderSnapshot(null, catalog).ok, false);
});

test('runtime conversion receives the authoritative clocks and signed seed words', () => {
  const original = baseline();
  original.hasRuntime = true;
  original.runtime = Array.from({length: 12}, (_, index) => index * 0.25);
  change(original, 'params.source.noise_seed', 0xffffffff);
  let observed;
  const result = convertLegacyShaderSnapshot(original, catalog, (chain, values, clocks, hasRuntime) => {
    observed = {chain, values, clocks, hasRuntime};
    return [{instance: 'sample', kind: 'source-clock-v1', state: {primary: clocks[0], secondary: clocks[1], angle: clocks[2]}}];
  });
  assert.equal(result.ok, true);
  assert.deepEqual(observed.clocks, original.runtime);
  assert.equal(observed.values['params.source.noise_seed'], 0xffffffff);
  assert.equal(observed.hasRuntime, true);
  assert.equal(result.snapshot.runtime[0].state.primary, 0);
});

test('a spherical-rings archive restores the shared walk seed and its own phase without a planar crossing', () => {
  const original = baseline();
  change(original, 'slots.function', 7);
  change(original, 'slots.warp_program.outer.kind', 0);
  change(original, 'slots.warp_program.inner.kind', 0);
  original.hasRuntime = true;
  original.runtime = Array.from({length: 12}, (_, index) => index * 0.25);
  const converted = convertLegacyShaderSnapshot(original, catalog);
  assert.equal(converted.ok, true, converted.reason);
  assert.ok(!converted.snapshot.chain.some((entry) => entry.operator.startsWith('project.')));
  const camera = converted.snapshot.runtime.find((entry) => entry.instance === 'camera');
  const rings = converted.snapshot.runtime.find((entry) => entry.instance === 'sample');
  assert.equal(rings.kind, 'spherical-rings-v1');
  assert.equal(rings.state.walk.noiseSeed, camera.state.noiseSeed);
  assert.equal(rings.state.walk.spinPhase, original.runtime[2]);
  assert.equal(rings.state.phase, original.runtime[0]);
  assert.deepEqual(rings.state.walk.rawOrientation, [1, 0, 0, 0]);
  const document = documentFromChainSnapshot(converted.snapshot, catalog);
  assert.equal(compileShaderDocument(document, {catalog}).status, 'VALID');
});
