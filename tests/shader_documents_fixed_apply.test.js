import {BAKED_CONSTANT_IDS} from '../generated/shader/shader_workbench.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {applyFixedShaderDocument} from '../src/workbench/shader/shader_documents.js';
import {ParamSetResult} from './helpers/fake_engine.js';

import {
  primaryName, ENGINE_CATALOG, MODULE, BAKED, fixedDocument, fixedEngine, promotedDocument,
  PROMOTED, affinePeriodDocument, applyFixed,
} from './helpers/shader_document_harness.js';

// The writes also pin the topology skip: sample.weight-mode selects a baked
// structural variant, so the fixed path never offers it to the engine.
test('a fixed-pipeline preset is staged on the engine preset it names', () => {
  const engine = fixedEngine(() => true);

  assert.equal(applyFixed(engine, fixedDocument(), 'dusk', ['noon', 'dusk']), null);
  assert.deepEqual(engine.selected, ['dusk']);
  assert.deepEqual(engine.writes, [['Pattern Freq', 5]]);
});

test('compiled modulation fields use exact resources and retain readonly values', () => {
  const engine = fixedEngine(() => true);
  const definitions = [
    {resource: 'ink', id: 'grid-axis-b-x', readonly: true, value: Math.fround(0.3)},
    {resource: 'ink', id: 'pattern-scale', readonly: false, value: 1},
  ];
  engine.getDocumentParameterDefinitions = () => definitions;
  engine.setDocumentParameter = (resource, id, value) => {
    engine.writes.push([resource, id, value]);
    return ParamSetResult.APPLIED;
  };
  const compiled = {document: {
    descriptor: {chain: [{label: 'ink', operator: 'color.modulate.v1'}]},
    preset_bank: {presets: [{preset_id: 'one', values: {
      'ink.grid-axis-b-x': 0.3, 'ink.pattern-scale': 2,
    }}]},
  }};
  const apply = () => applyFixedShaderDocument(engine, MODULE, compiled, 'one', ['one'],
    BAKED, () => null);
  assert.equal(apply(), null);
  assert.deepEqual(engine.writes, [['ink', 'pattern-scale', 2]]);
  engine.writes.length = 0;
  definitions[0].value = 0.4;
  assert.match(apply(), /must match the fixed build/);
  assert.deepEqual(engine.writes, []);
  definitions[0].resource = 'other';
  assert.match(apply(), /no engine parameter matches/);
});

// The document's presets and the effect's reference presets are separate banks:
// an authored preset the effect never had still has to land on some reference
// state, or the values are written over whatever the last preview left behind.
test('a preset the effect does not carry falls back to its first reference', () => {
  const engine = fixedEngine(() => true);

  assert.equal(applyFixed(engine, fixedDocument(), 'dusk', ['noon']), null);
  assert.deepEqual(engine.selected, ['noon']);
  assert.deepEqual(engine.writes, [['Pattern Freq', 5]]);
});

// Every writable id is resolved before the first write: a refusal after one write would
// leave the engine on a state that is neither the reference preset nor the
// document's.
test('an unmatched id refuses the fixed apply before any value is written', () => {
  const engine = fixedEngine(() => true);
  const values = { 'sample.pattern-freq': 3, 'sample.no-such-field': 1 };
  const presets = [{ preset_id: 'noon', values }];

  assert.equal(applyFixed(engine, { document: { preset_bank: { presets } } }, 'noon', ['noon']),
  'no engine parameter matches "sample.no-such-field"');
  assert.deepEqual(engine.writes, []);
});

test('fixed apply refuses a missing document preset without changing the engine', () => {
  const engine = fixedEngine(() => true);

  assert.equal(
    applyFixed(engine, fixedDocument(), 'missing', ['noon']),
    'the document has no preset "missing"');
  assert.deepEqual(engine.selected, []);
  assert.deepEqual(engine.writes, []);
});

test('an effect with no reference preset is refused before any engine write', () => {
  const engine = fixedEngine(() => true);

  assert.equal(
    applyFixed(engine, fixedDocument(), 'noon', []),
    'the effect has no reference preset');
  assert.deepEqual(engine.selected, []);
  assert.deepEqual(engine.writes, []);
});

test('a refused reference preset names the preset the engine rejected', () => {
  const engine = fixedEngine(() => false);

  assert.equal(
    applyFixed(engine, fixedDocument(), 'noon', ['noon']),
    'the engine refused reference preset "noon"');
  assert.deepEqual(engine.writes, []);
});

// selectPresetById is reached through an optional call, so an engine build
// without it answers undefined rather than throwing.
test('an engine without selectPresetById is refused, not written through', () => {
  const engine = fixedEngine(() => true);
  delete engine.selectPresetById;

  assert.match(
    String(applyFixed(engine, fixedDocument(), 'noon', ['noon'])),
    /refused reference preset "noon"/);
  assert.deepEqual(engine.writes, []);
});

// The skip set is the catalog's own topology flag. Palette mapping is the one
// flagged field a fixed build keeps live, as an ordinary dropdown.
test('the fixed path skips every topology field the catalog flags', () => {
  const catalog = JSON.parse(ENGINE_CATALOG);
  const flagged = catalog.operators.flatMap((/** @type {*} */ operator) =>
    operator.params.filter((/** @type {*} */ parameter) => parameter.topology === true));
  const values = Object.fromEntries(flagged
    .filter((/** @type {*} */ parameter) => parameter.id !== 'palette-mapping')
    .map((/** @type {*} */ parameter) => [`warp1.${parameter.id}`, parameter.default]));
  const engine = fixedEngine(() => true);
  const presets = [{ preset_id: 'noon', values }];

  assert.ok(Object.keys(values).length > 0, 'the catalog flags topology fields');
  assert.equal(applyFixed(engine, { document: { preset_bank: { presets } } }, 'noon', ['noon']), null);
  assert.deepEqual(engine.writes, []);
  assert.ok(flagged.some((/** @type {*} */ parameter) =>
    parameter.id === 'palette-mapping'));
  assert.equal(BAKED.has('palette-mapping'), false);
});

// The compiled build hard-codes these values, so it registers no control for
// them.
test('the fixed path skips the ids the compiled build bakes in as constants', () => {
  const engine = fixedEngine(() => true);
  const values = { 'camera.spin-speed': 0.01975, 'sample.pattern-freq': 3 };
  const presets = [{ preset_id: 'noon', values }];

  assert.ok(BAKED_CONSTANT_IDS.has('camera.spin-speed'));
  assert.equal(applyFixed(engine, { document: { preset_bank: { presets } } }, 'noon', ['noon']), null);
  assert.deepEqual(engine.writes, [['Pattern Freq', 3]]);
});

// Ash Cloud's preset carries `camera.spin-speed`, a baked constant with no registered control.
test('fixed apply orchestration writes matching controls in document order', () => {
  const ashCloud = promotedDocument(PROMOTED['ash-cloud']);
  assert.equal(ashCloud.preset_bank.presets[0].values['modulate.modulation-source'], 'displacement');
  const dormant = new Set(['modulate.pattern-scale', 'modulate.pattern-speed', 'modulate.pattern-contrast']);
  const ids = Object.keys(ashCloud.preset_bank.presets[0].values);
  const definitions = ids
    .filter((id) => !BAKED.has(id.slice(id.indexOf('.') + 1)))
    .map((id) => {
      const value = ashCloud.preset_bank.presets[0].values[id];
      return {name: primaryName(id, ashCloud.descriptor), ...(typeof value === 'string'
        ? {options: [value], optionValues: [0]} : {})};
    })
    .filter((definition) => definition.name !== 'Camera Spin Speed');
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => definitions;

  assert.ok(ids.includes('camera.spin-speed'));
  assert.equal(applyFixed(engine, { document: ashCloud }, 'ash-cloud', ['ash-cloud']), null);
  assert.equal(engine.writes.some(([name]) => name === 'Camera Spin Speed'), false);
  const expectedWrites = Object.entries(ashCloud.preset_bank.presets[0].values)
    .filter(([id]) => !dormant.has(id))
    .map(([id, value]) => [primaryName(id, ashCloud.descriptor), typeof value === 'string' ? 0 : value])
    .filter(([name]) => definitions.some((definition) => definition.name === name));
  assert.deepEqual(engine.writes, expectedWrites);
});

test('the GridWorms compiled preset preserves dormant noise settings without noise controls', () => {
  const document = promotedDocument(PROMOTED['grid-worms']);
  const before = structuredClone(document);
  const preset = document.preset_bank.presets[0];
  assert.equal(preset.values['modulation.modulation-source'], 'directional-sine');
  const dormant = new Set(['modulation.pattern-scale', 'modulation.pattern-speed']);
  for (const id of dormant) assert.ok(Number.isFinite(preset.values[id]), id);
  const definitions = Object.entries(preset.values)
    .filter(([id]) => !dormant.has(id) && id !== 'sample.edge-width'
      && !BAKED_CONSTANT_IDS.has(id) && !BAKED.has(id.slice(id.indexOf('.') + 1)))
    .map(([id, value]) => ({name: primaryName(id, document.descriptor),
      ...(typeof value === 'string' ? {options: [value], optionValues: [0]} : {})}));
  assert.equal(definitions.some(({name}) => /^Pattern (Scale|Speed)$/.test(name)), false);
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => definitions;
  assert.equal(applyFixed(engine, {document}, preset.preset_id, [preset.preset_id]), null);
  assert.deepEqual(engine.writes.filter(([name]) => name.startsWith('Pattern ')),
    [['Pattern Frequency', preset.values['modulation.sine-frequency']]]);
  assert.ok(engine.writes.some(([name, value]) => name === 'lens1.Twist Angle (rad)'
    && value === preset.values['lens1.twist-angle']));
  assert.deepEqual(document, before);
});

test('a fixed affine fallback period applies through its own control', () => {
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => [{ name: 'Cell Scale' },
    { name: 'outer_warp.Lattice Period' }];
  assert.equal(applyFixed(engine, affinePeriodDocument(0.75), 'noon', ['noon']), null);
  assert.deepEqual(engine.selected, ['noon']);
  assert.deepEqual(engine.writes, [['Cell Scale', 2], ['outer_warp.Lattice Period', 0.75]]);
});

test('a fixed affine field without its control holds its compiled-out identity', () => {
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => [{ name: 'Cell Scale' }];
  assert.equal(applyFixed(engine, affinePeriodDocument(0.75), 'noon', ['noon']), null);
  assert.deepEqual(engine.writes, [['Cell Scale', 2]]);
  const rotating = affinePeriodDocument(0.75);
  rotating.document.preset_bank.presets[0].values['warp1.rotation-rate'] = 0.5;
  engine.writes.length = 0;
  assert.equal(applyFixed(engine, rotating, 'noon', ['noon']),
  `"warp1.rotation-rate" must match the fixed build's derived value 0`);
  assert.deepEqual(engine.writes, []);
});

test('fixed document presets preserve sparse option IDs and refuse numeric gaps', () => {
  for (const value of ['Shells', 6, 2]) {
    const engine = fixedEngine(() => true);
    engine.getParameterDefinitions = () => [{ name: 'Pattern Freq',
      options: ['Cubic', 'Octet Truss', 'Shells'], optionValues: [0, 1, 6] }];
    const compiled = fixedDocument();
    compiled.document.preset_bank.presets[0].values = { 'sample.pattern-freq': value };
    const result = applyFixed(engine, compiled, 'noon', ['noon']);
    if (value === 2) {
      assert.match(result, /has no option value 2/);
      assert.deepEqual(engine.writes, []);
    } else {
      assert.equal(result, null);
      assert.deepEqual(engine.writes, [['Pattern Freq', 6]]);
    }
  }
});

test('fixed apply resolves a registered secondary compiled control name', () => {
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => [{ name: 'Affine Scale X' }];
  const compiled = fixedDocument();
  compiled.document.preset_bank.presets[0].values = { 'warp1.scale-x': 2.5 };
  assert.equal(applyFixed(engine, compiled, 'noon', ['noon']), null);
  assert.deepEqual(engine.writes, [['Affine Scale X', 2.5]]);
});

test('authored native controls preserve resource identities and live topology readbacks', () => {
  const values = {'camera.wander': 0.3, 'camera.spin-speed': 0.02,
    'world.wander': 0.7, 'world.spin-speed': 0.04, 'plane.lattice-period': 0.413,
    'cells.cell-scale': 2, 'velocity.basis': 'ridged3',
    'cells.coverage-mode': 'edge-fade-squared', 'velocity.edge-width': 0.4};
  const descriptor = {chain: [
    {label: 'camera', operator: 'sphere.rotate.v2'},
    {label: 'world', operator: 'sphere.rotate.v2'},
    {label: 'plane', operator: 'warp.affine.v4'},
    {label: 'velocity', operator: 'warp.vector-noise.v2'},
    {label: 'cells', operator: 'sample.tessellation.v3'},
  ]};
  const definitions = [
    {name: 'Camera Wander', value: 0},
    ...['camera.Wander', 'camera.Spin Speed', 'world.Wander', 'world.Spin Speed',
      'plane.Lattice Period', 'Cell Scale', 'velocity.Warp Edge Width']
      .map((name) => ({name, value: 0})),
    {name: 'velocity.basis', options: ['Simplex', 'Fbm3', 'Ridged3'], optionValues: [2, 4, 9], value: 2},
    {name: 'coverage-mode', options: ['None', 'Weight', 'Weight Squared', 'Edge Fade', 'Edge Fade Squared'], value: 0},
  ];
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => definitions;
  engine.setParameter = (name, value) => {
    const definition = definitions.find((entry) => entry.name === name);
    assert.ok(definition);
    definition.value = Math.fround(value);
    engine.writes.push([name, value]);
    return ParamSetResult.APPLIED;
  };
  assert.equal(applyFixed(engine, {document: {descriptor, preset_bank: {presets: [{preset_id: 'live', values}]}}}, 'live', ['live'], JSON.parse(ENGINE_CATALOG)), null);
  assert.deepEqual(engine.writes, [
    ['camera.Wander', 0.3], ['camera.Spin Speed', 0.02], ['world.Wander', 0.7],
    ['world.Spin Speed', 0.04], ['plane.Lattice Period', 0.413], ['Cell Scale', 2],
    ['velocity.basis', 9], ['coverage-mode', 4], ['velocity.Warp Edge Width', 0.4],
  ]);
  for (const [name, value] of engine.writes)
    assert.equal(engine.getParameterDefinitions().find((entry) => entry.name === name).value, Math.fround(value));
  assert.equal(definitions[0].value, 0);
});

test('a live affine period remains independent when its sampler has no lattice cells', () => {
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => [{name: 'plane.Lattice Period'}];
  const descriptor = {chain: [
    {label: 'plane', operator: 'warp.affine.v4'},
    {label: 'sample', operator: 'sample.grid.v4'},
  ]};
  const values = {'plane.lattice-period': 2.5};
  assert.equal(applyFixed(engine, {document: {descriptor, preset_bank: {presets: [{preset_id: 'live', values}]}}}, 'live', ['live']), null);
  assert.deepEqual(engine.writes, [['plane.Lattice Period', 2.5]]);
});

test('native warp speed names follow instance labels', () => {
  for (const [label, name] of [
    ['warp', 'Planar Warp 1 Speed'],
    ['warp2', 'Planar Warp 2 Speed'],
    ['drift', 'drift.Planar Warp Speed'],
  ]) {
    const descriptor = {chain: [{label, operator: 'warp.affine.v4'}]};
    const engine = fixedEngine(() => true);
    engine.getParameterDefinitions = () => [{name}, {name: 'Speed'}];
    const values = {[`${label}.speed`]: 0.007};
    assert.equal(applyFixed(engine, {document: {descriptor, preset_bank: {presets: [{preset_id: 'one', values}]}}}, 'one', ['one']), null);
    assert.deepEqual(engine.writes, [[name, 0.007]]);
  }
});

test('potential nested native fields retain term identities across colliding resource names', () => {
  const catalog = JSON.parse(ENGINE_CATALOG);
  const fields = catalog.operators.find((entry) => entry.id === 'sphere.displace.potential.v1')
    .params.filter((field) => field.id.startsWith('term-'));
  assert.equal(fields.length, 24);
  const descriptor = {chain: [
    {label: 'surface', operator: 'sphere.displace.potential.v1'},
    {label: 'vector', operator: 'sphere.displace.curl.v2'},
    {label: 'warp', operator: 'warp.vector-noise.v2'},
    {label: 'sample', operator: 'sample.grid.v4'},
  ]};
  const values = {};
  const definitions = [];
  const expected = [];
  for (const field of fields) {
    const value = field.values?.at(-1) ?? (field.id.endsWith('phase') ? 2.7 : -1.25);
    const stored = field.values ? field.values.length - 1 : value;
    values[`surface.${field.id}`] = value;
    definitions.push({name: `surface.${field.id}`, value: 0,
      ...(field.values ? {options: field.values} : {})});
    expected.push([`surface.${field.id}`, stored]);
  }
  Object.assign(values, {'surface.drift': 0.01, 'sample.complexity': 0.75,
    'vector.basis': 'fbm3', 'warp.basis': 'ridged3'});
  definitions.push({name: 'surface.Drift', value: 0}, {name: 'source.Complexity', value: 0},
    {name: 'vector.basis', options: ['simplex', 'fbm3', 'ridged3'], value: 0},
    {name: 'outer_warp.basis', options: ['simplex', 'fbm3', 'ridged3'], value: 0});
  expected.push(['surface.Drift', 0.01], ['source.Complexity', 0.75],
    ['vector.basis', 1], ['outer_warp.basis', 2]);
  const decoys = ['Amplitude', 'Phase', 'surface.Amplitude', 'surface.Phase', 'Drift', 'basis']
    .map((name) => ({name, value: 123}));
  definitions.push(...decoys);
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => definitions;
  engine.setParameter = (name, value) => {
    definitions.find((definition) => definition.name === name).value = Math.fround(value);
    engine.writes.push([name, value]);
    return ParamSetResult.APPLIED;
  };
  assert.equal(applyFixed(engine, {document: {descriptor, preset_bank: {presets: [{preset_id: 'nested', values}]}}}, 'nested', ['nested'], catalog), null);
  assert.deepEqual(engine.writes, expected);
  for (const [name, value] of expected)
    assert.equal(definitions.find((definition) => definition.name === name).value, Math.fround(value));
  assert.ok(decoys.every((definition) => definition.value === 123));
});

test('fixed Twist presets use label identities', () => {
  for (const [label, prefix] of [
    ['lens', ''], ['whorl', 'whorl.'],
  ]) {
    const fields = [['twist-angle', 'Twist Angle (rad)', 7.25],
      ['twist-distribution', 'Twist Distribution', 0.625], ['speed', 'Speed', 0.035], ['drift', 'Drift', 0.006]];
    const engine = fixedEngine(() => true);
    engine.getParameterDefinitions = () => fields.map(([, name]) => ({name: prefix + name}));
    const compiled = fixedDocument();
    compiled.document.descriptor = {chain: [{label, operator: 'sphere.lens.twist.v2'}]};
    compiled.document.preset_bank.presets[0].values = Object.fromEntries(
      fields.map(([field, , value]) => [`${label}.${field}`, value]));
    assert.equal(applyFixed(engine, compiled, 'noon', ['noon']), null);
    assert.deepEqual(engine.writes, fields.map(([, name, value]) => [prefix + name, value]));
  }
});
