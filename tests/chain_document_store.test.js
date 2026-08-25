//
// tools/chain_document_store.js is the chain editor's document state machine:
// one span-replacement primitive generates insert, remove, replace and move,
// every commit reconciles the whole document (preset backfill, serialization
// fields, staggered groups, degenerate transition edges) and must leave it
// green under the v2 validator, undo restores a whole structural edit, and the
// session bypass set shapes the engine program without ever touching the
// document or its digest. The fixture is a real multi-preset pattern document
// compiled against the pinned engine catalog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_SCRATCH_CHAIN,
  UNDO_DEPTH,
  chainArenaBytes,
  createChainDocumentStore,
  scratchChainDocument,
} from '../tools/chain_document_store.js';
import {
  compileShaderDocument,
  validateShaderDocument,
} from '../shader/shader_workbench.mjs';

const CATALOG = JSON.parse(readFileSync(
  new URL('../shader/engine_catalog.json', import.meta.url), 'utf8'));
const BASE = compileShaderDocument(readFileSync(
  new URL('../shader/patterns/kaleidoscope_hex_bright.shader.json', import.meta.url), 'utf8'),
{ catalog: CATALOG });
assert.equal(BASE.status, 'VALID');
const STAINED_GLASS = compileShaderDocument(readFileSync(
  new URL('../shader/patterns/kaleidoscope_stained_glass.shader.json', import.meta.url), 'utf8'),
{ catalog: CATALOG });
assert.equal(STAINED_GLASS.status, 'VALID');

// kaleidoscope_hex_bright chain order: camera, lens, project, warp2, sample, transfer,
// colorize — sphere endos, a sphere->plane crossing, a plane endo, a
// plane->field crossing, a field endo, the field->color exit.
const PROJECT = 2;
const WARP = 3;
const SAMPLE = 4;

/**
 * A store over a fresh copy of the fixture document.
 * @param {Object} [options]
 * @param {(document: Object) => void} [options.mutate] - Edits the fixture copy.
 * @param {Object} [options.catalog] - Overrides the pinned catalog.
 */
const makeStore = ({ mutate, catalog = CATALOG } = {}) => {
  const document = structuredClone(BASE.document);
  if (mutate) mutate(document);
  return createChainDocumentStore({ document, catalog });
};

/** Asserts the store's current document passes the v2 validator. */
const assertGreen = (store) =>
  assert.deepEqual(validateShaderDocument(store.document(), { catalog: CATALOG }), []);

/** Adds a STAGGERED_ORDERED policy scheduling every interpolation group. */
const addStaggered = (document) => {
  document.descriptor.path_policies.push({
    id: 'staggered',
    kind: 'STAGGERED_ORDERED',
    groups: [...new Set(document.descriptor.parameters.map(
      (parameter) => parameter.interpolation.group ?? parameter.id))],
  });
};

/**
 * Makes the two presets differ in exactly the given values and wires a
 * transition edge each way between them.
 */
const presetsDifferBy = (document, values) => {
  const [a, b] = document.preset_bank.presets;
  b.values = { ...structuredClone(a.values), ...values };
  document.preset_bank.edges = [
    { from: a.preset_id, to: b.preset_id, path_policy: 'parallel', easing: 'LINEAR', duration: 120 },
    { from: b.preset_id, to: a.preset_id, path_policy: 'parallel', easing: 'LINEAR', duration: 120 },
  ];
};

const labels = (store) => store.chain().map((entry) => entry.label);

test('the store refuses an invalid starting document', async () => {
  await assert.rejects(
    makeStore({ mutate: (document) => {
      delete document.preset_bank.presets[0].values['sample.pattern-freq'];
    } }),
    /MISSING_PRESET_VALUE/);
  await assert.rejects(
    createChainDocumentStore({ document: BASE.document, catalog: { operators: [] } }),
    /operator catalog/);
});

test('insertion backfills presets, fields and staggered groups atomically', async () => {
  const store = await makeStore({ mutate: addStaggered });
  const result = store.replaceSpan(WARP, 0, [{ operator: 'warp.wave-shear.v2' }]);
  assert.equal(result.ok, true);
  assert.deepEqual(labels(store),
    ['camera', 'lens', 'project', 'warp1', 'warp2', 'sample', 'colorize']);
  const document = store.document();
  const ids = ['speed', 'strength', 'frequency', 'field-angle', 'edge-width', 'envelope']
    .map((field) => `warp1.${field}`);
  const declared = new Set(document.descriptor.parameters.map((parameter) => parameter.id));
  for (const id of ids) assert.ok(declared.has(id), `${id} is declared`);
  for (const id of ids)
    assert.ok(document.descriptor.serialization.fields.includes(id), `${id} serialized`);
  const staggered = document.descriptor.path_policies.find((policy) => policy.id === 'staggered');
  for (const id of ids) assert.ok(staggered.groups.includes(id), `${id} scheduled`);
  for (const preset of document.preset_bank.presets) {
    assert.equal(preset.values['warp1.speed'], 0);
    assert.equal(preset.values['warp1.frequency'], 1);
    assert.equal(preset.values['warp1.edge-width'], 0.1);
    assert.equal(preset.values['warp1.envelope'], 'flat');
  }
  const frequency = document.descriptor.parameters.find(
    (parameter) => parameter.id === 'warp1.frequency');
  assert.equal(frequency.interpolation.kind, 'LOG_POSITIVE');
  const angle = document.descriptor.parameters.find(
    (parameter) => parameter.id === 'warp1.field-angle');
  assert.equal(angle.interpolation.kind, 'SHORTEST_PERIODIC');
  assert.equal(angle.interpolation.period, angle.domain.maximum);
  assertGreen(store);
});

test('an operator with a snap-curve field commits', async () => {
  const store = await makeStore();
  const candidate = store.legalReplacements(SAMPLE, 1).find(
    (entry) => entry.operator.id === 'sample.fractal.v2');
  assert.equal(candidate.legal, true);
  assert.deepEqual(store.replaceSpan(SAMPLE, 1, [{ operator: 'sample.fractal.v2' }]), { ok: true });
  const iterations = store.document().descriptor.parameters.find(
    (parameter) => parameter.id === 'sample1.fractal-iterations');
  assert.equal(iterations.interpolation.kind, 'SNAP');
  assertGreen(store);
});

test('insertion bounds accommodate binary32 catalog defaults', async () => {
  const catalog = structuredClone(CATALOG);
  catalog.operators = catalog.operators.filter(
    (operator) => operator.id !== 'sphere.displace.ripple.v2');
  catalog.operators.push({
    id: 'sphere.displace.ripple.v2', name: 'Ripple Displace',
    input: 'sphere', output: 'sphere',
    blocks: {
      param: { size: 4, align: 4 }, prepared: { size: 4, align: 4 },
      state: { size: 4, align: 4 },
    },
    params: [{
      id: 'strength', name: 'Ripple Strength', min: 0, max: 0.15,
      default: 0.15, curve: 'lerp',
    }],
  });
  const store = await makeStore({ catalog });

  const result = store.replaceSpan(PROJECT, 0,
    [{ operator: 'sphere.displace.ripple.v2' }]);
  assert.equal(result.ok, true);
  const document = store.document();
  const parameter = document.descriptor.parameters.find(
    (entry) => entry.id === 'sphere1.strength');
  const stored = Math.fround(0.15);
  assert.equal(parameter.domain.maximum, stored);
  assert.equal(parameter.default, 0.15);
  assert.equal(document.preset_bank.presets[0].values['sphere1.strength'], 0.15);
  assert.deepEqual(validateShaderDocument(document, { catalog }), []);
});

test('a shortest-turn field backfills as a period-1 periodic parameter', async () => {
  const store = await makeStore();
  const legal = store.legalInsertions(PROJECT)
    .find((entry) => entry.operator.id === 'sphere.displace.direct.v2');
  assert.equal(legal.legal, true);

  const result = store.replaceSpan(PROJECT, 0,
    [{ operator: 'sphere.displace.direct.v2' }]);
  assert.equal(result.ok, true);
  const direction = store.document().descriptor.parameters.find(
    (parameter) => parameter.id === 'sphere1.direction');
  assert.equal(direction.unit, 'turn');
  assert.deepEqual(direction.interpolation, { kind: 'SHORTEST_PERIODIC', period: 1 });
  assertGreen(store);
});

test('auto labels take the family stem with the lowest free suffix', async () => {
  const store = await makeStore();
  assert.equal(store.replaceSpan(WARP, 0, [{ operator: 'warp.wave-shear.v2' }]).ok, true);
  assert.equal(store.replaceSpan(WARP, 0, [{ operator: 'warp.curl-flow.v2' }]).ok, true);
  assert.deepEqual(labels(store).slice(3, 6), ['warp3', 'warp1', 'warp2']);
  assertGreen(store);
});

test('auto labels reuse suffixes released by the replaced span', async () => {
  const store = await makeStore();

  const result = store.replaceSpan(WARP, 1, [{ operator: 'warp.wave-shear.v2' }]);

  assert.equal(result.ok, true);
  assert.equal(labels(store)[WARP], 'warp1');
  assertGreen(store);
});

test('a duplicate explicit label is refused before commit', async () => {
  const store = await makeStore();
  const before = store.document();
  const result = store.replaceSpan(WARP, 0,
    [{ label: 'sample', operator: 'warp.wave-shear.v2' }]);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'DUPLICATE_LABEL');
  assert.deepEqual(store.document(), before);
  assert.equal(store.canUndo(), false);
});

test('an unknown operator is refused', async () => {
  const store = await makeStore();
  const result = store.replaceSpan(WARP, 0, [{ operator: 'warp.nope.v2' }]);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'UNKNOWN_OPERATOR');
});

test('removing an endomorphism drops its instance everywhere', async () => {
  const store = await makeStore({ mutate: addStaggered });
  assert.equal(store.replaceSpan(WARP, 1, []).ok, true);
  const document = store.document();
  const stray = (id) => id.startsWith('warp2.');
  assert.equal(document.descriptor.parameters.some((parameter) => stray(parameter.id)), false);
  assert.equal(document.descriptor.serialization.fields.some(stray), false);
  const staggered = document.descriptor.path_policies.find((policy) => policy.id === 'staggered');
  assert.equal(staggered.groups.some(stray), false);
  for (const preset of document.preset_bank.presets)
    assert.equal(Object.keys(preset.values).some(stray), false);
  assertGreen(store);
});

test('removing an instance drops the staggered groups it shared', async () => {
  const store = await makeStore({ mutate: (document) => {
    const shared = document.descriptor.parameters
      .filter((parameter) => parameter.id.startsWith('warp2.')
        && parameter.storage === 'binary32')
      .slice(0, 2);
    for (const parameter of shared)
      parameter.interpolation = { ...parameter.interpolation, group: 'warp-mix' };
    addStaggered(document);
  } });
  const staggeredGroups = () => store.document().descriptor.path_policies
    .find((policy) => policy.id === 'staggered').groups;
  assert.ok(staggeredGroups().includes('warp-mix'));
  assert.equal(store.replaceSpan(WARP, 1, []).ok, true);
  assert.equal(staggeredGroups().includes('warp-mix'), false,
    'a group no surviving parameter declares is not schedulable');
  assertGreen(store);
});

test('a crossing cannot be removed, only replaced', async () => {
  const store = await makeStore();
  const before = store.document();
  const removal = store.replaceSpan(PROJECT, 1, []);
  assert.equal(removal.ok, false);
  assert.ok(removal.diagnostics.some((diagnostic) =>
    diagnostic.code === 'CARRIER_MISMATCH' || diagnostic.code === 'FAMILY_ORDER'));
  assert.deepEqual(store.document(), before);

  const replacement = store.replaceSpan(PROJECT, 3, [
    { operator: 'project.equirectangular.v2' },
    { operator: 'sample.grid.v2' },
  ]);
  assert.equal(replacement.ok, true);
  assert.deepEqual(labels(store),
    ['camera', 'lens', 'project1', 'sample1', 'colorize']);
  const document = store.document();
  for (const preset of document.preset_bank.presets) {
    assert.equal(preset.values['sample1.complexity'], 0);
    assert.equal(preset.values['project1.singularity-fade'], 1);
    assert.equal('warp2.rotation' in preset.values, false);
  }
  assertGreen(store);
});

test('a move is an m-for-m replacement that keeps instance values', async () => {
  const store = await makeStore();
  const before = store.document();
  const result = store.replaceSpan(0, 2, [
    { label: 'lens', operator: 'sphere.lens.kaleidoscope.v2' },
    { label: 'camera', operator: 'sphere.rotate.v2' },
  ]);
  assert.equal(result.ok, true);
  const document = store.document();
  assert.deepEqual(labels(store).slice(0, 2), ['lens', 'camera']);
  assert.deepEqual(document.preset_bank, before.preset_bank);
  assert.deepEqual(document.descriptor.parameters, before.descriptor.parameters);
  assertGreen(store);
});

test('a move that breaks carrier agreement is refused', async () => {
  const store = await makeStore();
  const [project, warp] = store.chain().slice(PROJECT, PROJECT + 2);
  const result = store.replaceSpan(PROJECT, 2, [warp, project]);
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.length > 0);
});

test('removing and reinserting one operator preserves its descriptor digest', async () => {
  const store = await createChainDocumentStore({
    document: structuredClone(STAINED_GLASS.document), catalog: CATALOG,
  });
  const digest = store.compile().descriptor_digest;

  assert.equal(store.replaceSpan(WARP, 1, []).ok, true);
  assert.equal(store.replaceSpan(WARP, 0, [
    { label: 'warp1', operator: 'warp.vector-noise.v2' },
  ]).ok, true);

  assert.equal(store.compile().descriptor_digest, digest);
  assertGreen(store);
});

test('reusing a label under a new operator re-seeds it from catalog defaults', async () => {
  const store = await makeStore();
  const before = store.document();
  assert.notEqual(before.preset_bank.presets[0].values['sample.pattern-freq'], 1);
  assert.equal('sample.edge-width' in before.preset_bank.presets[0].values, false);
  const result = store.replaceSpan(SAMPLE, 1, [{ label: 'sample', operator: 'sample.grid.v2' }]);
  assert.equal(result.ok, true);
  const document = store.document();
  for (const preset of document.preset_bank.presets) {
    assert.equal(preset.values['sample.pattern-freq'], 1);
    assert.equal(preset.values['sample.edge-width'], 0.1);
    assert.equal(preset.values['sample.complexity'], 0);
  }
  assertGreen(store);
});

test('relabel rewrites every derived id in place', async () => {
  const store = await makeStore({ mutate: addStaggered });
  const rotationBefore =
    store.document().preset_bank.presets[0].values['warp2.rotation'];
  assert.equal(store.setSelectedLabel('warp2'), true);
  const result = store.relabel('warp2', 'mirror');
  assert.equal(result.ok, true);
  const document = store.document();
  const stray = (id) => id.startsWith('warp2.');
  assert.deepEqual(labels(store)[WARP], 'mirror');
  assert.equal(document.descriptor.parameters.some((parameter) => stray(parameter.id)), false);
  assert.equal(document.descriptor.serialization.fields.some(stray), false);
  assert.ok(document.descriptor.serialization.fields.includes('mirror.rotation'));
  const staggered = document.descriptor.path_policies.find((policy) => policy.id === 'staggered');
  assert.ok(staggered.groups.includes('mirror.rotation'));
  assert.equal(staggered.groups.some(stray), false);
  for (const preset of document.preset_bank.presets) {
    assert.equal(Object.keys(preset.values).some(stray), false);
    assert.equal(preset.values['mirror.rotation'], rotationBefore);
  }
  assert.equal(store.selectedLabel(), 'mirror');
  assertGreen(store);
});

test('relabel refuses collisions, unknown labels and malformed labels', async () => {
  const store = await makeStore();
  assert.equal(store.relabel('warp2', 'sample').diagnostics[0].code, 'DUPLICATE_LABEL');
  assert.equal(store.relabel('nope', 'fine').diagnostics[0].code, 'UNKNOWN_LABEL');
  assert.equal(store.relabel('warp2', 'Not.Valid').diagnostics[0].code, 'INVALID_LABEL');
  assert.equal(store.relabel('warp2', 'warp2').ok, true);
  assert.equal(store.canUndo(), false);
});

test('undo reverts a whole structural edit atomically', async () => {
  const store = await makeStore({ mutate: addStaggered });
  const before = store.document();
  assert.equal(store.undo(), false);
  assert.equal(store.replaceSpan(WARP, 0, [{ operator: 'warp.wave-shear.v2' }]).ok, true);
  const after = store.document();
  assert.notDeepEqual(after, before);
  assert.equal(store.undo(), true);
  assert.deepEqual(store.document(), before);
  assert.equal(store.canRedo(), true);
  assert.equal(store.redo(), true);
  assert.deepEqual(store.document(), after);
  assert.equal(store.redo(), false);
  assertGreen(store);
});

test('a new edit clears the redo history', async () => {
  const store = await makeStore();
  assert.equal(store.replaceSpan(WARP, 0, [{ operator: 'warp.wave-shear.v2' }]).ok, true);
  assert.equal(store.undo(), true);
  assert.equal(store.replaceSpan(WARP, 0, [{ operator: 'warp.curl-flow.v2' }]).ok, true);
  assert.equal(store.canRedo(), false);
});

test('bypass shapes the program without touching the document', async () => {
  const store = await makeStore();
  const digestBefore = store.compile().descriptor_digest;
  assert.match(digestBefore, /^[0-9a-f]{64}$/);
  assert.equal(store.setBypassed('lens', true).ok, true);
  assert.deepEqual(store.bypassedLabels(), ['lens']);
  assert.deepEqual(store.programShape().map((entry) => entry.instance),
    ['camera', 'project', 'warp2', 'sample', 'colorize']);
  assert.deepEqual(store.programShape()[0],
    { instance: 'camera', operator: 'sphere.rotate.v2' });
  assert.ok(store.chain().some((entry) => entry.label === 'lens'));
  assert.equal(store.compile().descriptor_digest, digestBefore);
  assert.equal(store.setBypassed('lens', false).ok, true);
  assert.deepEqual(store.bypassedLabels(), []);
});

test('a crossing gets no bypass toggle', async () => {
  const store = await makeStore();
  const result = store.setBypassed('project', true);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0].code, 'BYPASS_CROSSING');
  assert.equal(store.setBypassed('nope', true).diagnostics[0].code, 'UNKNOWN_LABEL');
  assert.equal(store.programShape().length, store.chain().length);
});

test('bypass is pruned by removal and not restored by undo', async () => {
  const store = await makeStore();
  assert.equal(store.setBypassed('lens', true).ok, true);
  assert.equal(store.replaceSpan(1, 1, []).ok, true);
  assert.deepEqual(store.bypassedLabels(), []);
  assert.equal(store.undo(), true);
  assert.ok(store.chain().some((entry) => entry.label === 'lens'));
  assert.deepEqual(store.bypassedLabels(), []);
});

const presetValue = (store, presetId, parameterId) => store.document()
  .preset_bank.presets.find((preset) => preset.preset_id === presetId)
  .values[parameterId];

test('a preset value write lands in the document and is validated', async () => {
  const store = await makeStore();
  const untouched = presetValue(store, 'hex-twin-wave-alt', 'sample.pattern-freq');
  assert.equal(store.setPresetValue('hex-twin-wave', 'sample.pattern-freq', 7).ok, true);
  assert.equal(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'), 7);
  assert.equal(presetValue(store, 'hex-twin-wave-alt', 'sample.pattern-freq'), untouched,
    'the write names one preset, never the bank');
  assert.equal(store.setPresetValue('hex-twin-wave', 'colorize.palette-mapping', 'bell').ok,
    true);
  assert.equal(presetValue(store, 'hex-twin-wave', 'colorize.palette-mapping'), 'bell');
  assertGreen(store);
});

test('a write outside the parameter domain leaves the store untouched', async () => {
  const store = await makeStore();
  const before = store.document();

  const wide = store.setPresetValue('hex-twin-wave', 'sample.pattern-freq', 500);
  assert.equal(wide.ok, false);
  assert.equal(wide.diagnostics[0].code, 'VALUE_OUT_OF_RANGE');
  const option = store.setPresetValue('hex-twin-wave', 'colorize.palette-mapping', 'plaid');
  assert.equal(option.diagnostics[0].code, 'INVALID_ENUM_VALUE');
  assert.equal(store.setPresetValue('dawn', 'sample.pattern-freq', 2).diagnostics[0].code,
    'UNKNOWN_PRESET');
  assert.equal(store.setPresetValue('hex-twin-wave', 'sample.nope', 2).diagnostics[0].code,
    'UNKNOWN_PARAMETER');
  assert.deepEqual(store.document(), before);
  assert.equal(store.canUndo(), false);
});

// A drag emits an onChange per pointermove: the run is one undo step, and undo
// restores the value the control held before the drag started.
test('consecutive writes to one control coalesce into one undo step', async () => {
  const store = await makeStore();
  const opening = presetValue(store, 'hex-twin-wave', 'sample.pattern-freq');
  for (const value of [2, 3, 4, 5]) {
    assert.equal(store.setPresetValue('hex-twin-wave', 'sample.pattern-freq', value).ok, true);
  }
  assert.equal(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'), 5);

  assert.equal(store.undo(), true);
  assert.equal(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'), opening);
  assert.equal(store.canUndo(), false);
  assert.equal(store.redo(), true);
  assert.equal(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'), 5);
});

// Every entry is a whole document clone, so an unbounded history is a session
// that grows until the tab dies.
test('the history keeps UNDO_DEPTH entries and drops the oldest past it', async () => {
  const store = await makeStore();
  const overflow = 5;
  // The controls alternate so each write opens its own entry rather than
  // coalescing into the one before it; after each, the value the history should
  // walk back through.
  const walked = [];
  const refused = [];
  for (let step = 0; step < UNDO_DEPTH + overflow; step += 1) {
    const parameter = step % 2 === 0 ? 'sample.pattern-freq' : 'camera.wander';
    const value = step % 2 === 0 ? 2 + (step % 5) : (step % 10) / 10;
    if (!store.setPresetValue('hex-twin-wave', parameter, value).ok) refused.push(step);
    walked.push(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'));
  }
  assert.deepEqual(refused, [], 'every write must commit for the depth to be read');

  let undone = 0;
  while (store.undo()) undone += 1;
  assert.equal(undone, UNDO_DEPTH, 'the history must stop at its depth');
  assert.equal(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'),
    walked[overflow - 1],
    'the dropped entries are the oldest, so the opening document is unreachable');

  let redone = 0;
  while (store.redo()) redone += 1;
  assert.equal(redone, UNDO_DEPTH, 'every kept entry must reapply');
  assert.equal(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'),
    walked.at(-1));
});

test('another control, a structural edit, an undo or a redo ends the run', async () => {
  const store = await makeStore();
  assert.equal(store.setPresetValue('hex-twin-wave', 'sample.pattern-freq', 2).ok, true);
  assert.equal(store.setPresetValue('hex-twin-wave', 'camera.wander', 0.5).ok, true);
  assert.equal(store.setPresetValue('hex-twin-wave-alt', 'camera.wander', 0.25).ok, true);
  assert.equal(store.undo(), true);
  assert.equal(store.undo(), true);
  assert.equal(store.undo(), true);
  assert.equal(store.canUndo(), false);

  assert.equal(store.setPresetValue('hex-twin-wave', 'sample.pattern-freq', 3).ok, true);
  assert.equal(store.replaceSpan(WARP, 0, [{ operator: 'warp.wave-shear.v2' }]).ok, true);
  assert.equal(store.setPresetValue('hex-twin-wave', 'sample.pattern-freq', 4).ok, true);
  assert.equal(store.undo(), true);
  assert.equal(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'), 3);
  assert.equal(labels(store).includes('warp1'), true,
    'the structural edit opened its own entry and survives the value undo');

  assert.equal(store.redo(), true);
  assert.equal(store.setPresetValue('hex-twin-wave', 'sample.pattern-freq', 6).ok, true);
  assert.equal(store.undo(), true);
  assert.equal(presetValue(store, 'hex-twin-wave', 'sample.pattern-freq'), 4,
    'a redo ends the run, so the write after it opens a new entry');
});

test('legality lists every operator with reasons for the illegal', async () => {
  const store = await makeStore();
  const gap = store.legalInsertions(WARP);
  assert.equal(gap.length, CATALOG.operators.length);
  const byId = new Map(gap.map((entry) => [entry.operator.id, entry]));
  assert.deepEqual(byId.get('warp.wave-shear.v2'),
    { operator: byId.get('warp.wave-shear.v2').operator, legal: true });
  assert.equal(byId.get('sphere.rotate.v2').legal, false);
  assert.match(byId.get('sphere.rotate.v2').reason, /consumes the sphere carrier/);
  assert.equal(byId.get('sample.grid.v2').legal, false);
  assert.match(byId.get('sample.grid.v2').reason, /produces the field carrier/);

  const span = store.legalReplacements(PROJECT, 1);
  const spanById = new Map(span.map((entry) => [entry.operator.id, entry]));
  assert.equal(spanById.get('project.bonne.v2').legal, true);
  assert.equal(spanById.get('warp.affine.v2').legal, false);
  assert.throws(() => store.legalInsertions(99), RangeError);
});

test('legality agrees with replaceSpan', async () => {
  const store = await makeStore();
  for (const entry of store.legalInsertions(WARP)) {
    const probe = await makeStore();
    const result = probe.replaceSpan(WARP, 0, [{ operator: entry.operator.id }]);
    assert.equal(result.ok, entry.legal, entry.operator.id);
  }
});

test('an exhausted operator budget refuses insertion but not replacement', async () => {
  const catalog = structuredClone(CATALOG);
  catalog.budgets.max_chain_ops = 6;
  const store = await makeStore({ catalog });
  for (const entry of store.legalInsertions(WARP)) {
    assert.equal(entry.legal, false);
    assert.match(entry.reason, /carrier|operator budget/);
  }
  const insertion = store.replaceSpan(WARP, 0, [{ operator: 'warp.wave-shear.v2' }]);
  assert.equal(insertion.ok, false);
  assert.equal(insertion.diagnostics[0].code, 'BUDGET_EXCEEDED');
  const swap = store.legalReplacements(WARP, 1);
  assert.equal(swap.find((entry) => entry.operator.id === 'warp.affine.v2').legal, true);
});

test('arena accounting honors per_param_name_bytes when declared', async () => {
  // The 6-op fixture chain costs 3592 arena bytes under the engine budgets
  // (49-byte overhead + blocks + 34 schema params x 81 name bytes); the
  // wave-shear insertion brings it to 4168. A budget between the two refuses
  // the insertion only while the name figure is counted.
  const catalog = structuredClone(CATALOG);
  catalog.budgets.arena_bytes = 3800;
  const store = await makeStore({ catalog });
  const entry = store.legalInsertions(WARP)
    .find((candidate) => candidate.operator.id === 'warp.wave-shear.v2');
  assert.equal(entry.legal, false);
  assert.match(entry.reason, /arena bytes/);
  const unnamed = structuredClone(CATALOG);
  delete unnamed.budgets.per_param_name_bytes;
  unnamed.budgets.arena_bytes = 3800;
  const uncounted = await makeStore({ catalog: unnamed });
  assert.equal(uncounted.legalInsertions(WARP)
    .find((candidate) => candidate.operator.id === 'warp.wave-shear.v2').legal, true);
  const base = await makeStore();
  assert.equal(base.legalInsertions(WARP)
    .find((candidate) => candidate.operator.id === 'warp.wave-shear.v2').legal, true);
});

test('the store bills a chain the arena bytes the validator does', () => {
  // The validator's cursor lives inside validateChain and is not exported, so
  // the agreement is pinned against the figure it prints rather than a third
  // copy of the formula: a zero arena budget makes it print one for every
  // chain. Padding depends on everything ahead of a block, so runs of blocks
  // whose size is not a multiple of their alignment are what separate a cursor
  // from per-block rounding.
  const probe = structuredClone(CATALOG);
  probe.budgets.arena_bytes = 0;
  const operators = new Map(CATALOG.operators.map(
    (operator) => [operator.id, operator]));
  const validatorBytes = (chain) => {
    const diagnostic = validateShaderDocument(
      scratchChainDocument(probe, chain), { catalog: probe })
      .find((entry) => entry.message.includes('arena bytes'));
    assert.ok(diagnostic, 'the validator reports an arena figure');
    return Number(/needs (\d+) arena bytes/.exec(diagnostic.message)[1]);
  };
  const chains = [
    DEFAULT_SCRATCH_CHAIN,
    BASE.document.descriptor.chain,
    [
      { label: 'camera', operator: 'sphere.rotate.v2' },
      { label: 'glitch', operator: 'sphere.lens.glitch.v2' },
      { label: 'project', operator: 'project.stereographic.v2' },
      { label: 'sample', operator: 'sample.lattice.v2' },
      { label: 'colorize', operator: 'colorize.generated-palette.v2' },
    ],
  ];
  const endomorphisms = [
    'sphere.lens.glitch.v2', 'sphere.lens.twist.v2',
    'sphere.lens.kaleidoscope.v2', 'sphere.displace.curl.v2',
  ];
  for (const operator of endomorphisms) {
    for (const count of [1, 2, 3, 7, 13]) {
      chains.push([
        ...Array.from({ length: count },
          (unused, index) => ({ label: `endo${index}`, operator })),
        { label: 'project', operator: 'project.stereographic.v2' },
        { label: 'sample', operator: 'sample.grid.v2' },
        { label: 'colorize', operator: 'colorize.generated-palette.v2' },
      ]);
    }
  }
  for (const chain of chains) {
    const ops = chain.map((entry) => operators.get(entry.operator));
    assert.equal(chainArenaBytes(ops, probe.budgets), validatorBytes(chain),
      chain.map((entry) => entry.operator).join(' -> '));
  }
});

test('a removal drops transition edges it makes degenerate', async () => {
  const store = await makeStore({
    mutate: (document) => presetsDifferBy(document, { 'warp2.rotation': 1.5 }),
  });
  assert.equal(store.document().preset_bank.edges.length, 2);
  assert.equal(store.replaceSpan(WARP, 1, []).ok, true);
  assert.equal(store.document().preset_bank.edges.length, 0);
  assert.equal(store.document().preset_bank.presets.length, 2);
  assertGreen(store);
});

test('edges between presets that still differ survive a removal', async () => {
  const store = await makeStore({
    mutate: (document) => presetsDifferBy(document,
      { 'warp2.rotation': 1.5, 'sample.speed': 0.2 }),
  });
  assert.equal(store.replaceSpan(WARP, 1, []).ok, true);
  assert.equal(store.document().preset_bank.edges.length, 2);
  assertGreen(store);
});

test('selection tracks the live chain', async () => {
  const store = await makeStore();
  assert.equal(store.selectedLabel(), null);
  assert.equal(store.setSelectedLabel('nope'), false);
  assert.equal(store.setSelectedLabel('warp2'), true);
  assert.equal(store.selectedLabel(), 'warp2');
  assert.equal(store.replaceSpan(WARP, 1, []).ok, true);
  assert.equal(store.selectedLabel(), null);
  assert.equal(store.setSelectedLabel(null), true);
});

test('compile recomputes digests on demand', async () => {
  const store = await makeStore();
  const first = store.compile();
  assert.equal(first.status, 'VALID');
  assert.equal(first.descriptor_digest, BASE.descriptor_digest);
  assert.equal(store.replaceSpan(WARP, 0, [{ operator: 'warp.wave-shear.v2' }]).ok, true);
  const second = store.compile();
  assert.equal(second.status, 'VALID');
  assert.notEqual(second.descriptor_digest, first.descriptor_digest);
});

test('document() returns an isolated copy', async () => {
  const store = await makeStore();
  const copy = store.document();
  copy.descriptor.chain.length = 0;
  copy.preset_bank.presets[0].values['sample.speed'] = 99;
  assertGreen(store);
  assert.equal(store.chain().length, 6);
});

test('a malformed span or sequence is refused without side effects', async () => {
  const store = await makeStore();
  assert.equal(store.replaceSpan(-1, 0, []).diagnostics[0].code, 'INVALID_SPAN');
  assert.equal(store.replaceSpan(0, 99, []).diagnostics[0].code, 'INVALID_SPAN');
  assert.equal(store.replaceSpan(2.5, 0, []).diagnostics[0].code, 'INVALID_SPAN');
  assert.equal(store.replaceSpan(0, 0, 'nope').diagnostics[0].code, 'INVALID_SEQUENCE');
  assert.equal(store.replaceSpan(0, 0, [null]).diagnostics[0].code, 'INVALID_SEQUENCE');
  assert.equal(store.canUndo(), false);
  assertGreen(store);
});


// §4.5: the workbench opens on this document, so it has to be valid by
// construction — the builder is the only thing between a cold page and a
// rendering chain.
test('the scratch document compiles clean against the catalog', async () => {
  const compiled = compileShaderDocument(scratchChainDocument(CATALOG),
    { catalog: CATALOG });
  assert.equal(compiled.status, 'VALID');
  assert.deepEqual(compiled.diagnostics, []);
  assert.deepEqual(compiled.document.descriptor.chain, [
    { label: 'rotate', operator: 'sphere.rotate.v2' },
    { label: 'project', operator: 'project.stereographic.v2' },
    { label: 'sample', operator: 'sample.grid.v2' },
    { label: 'colorize', operator: 'colorize.generated-palette.v2' },
  ]);
  assert.equal(compiled.document.preset_bank.presets.length, 1);
  const values = compiled.document.preset_bank.presets[0].values;
  assert.equal(values['colorize.palette-chroma'], 0.62,
    'the one preset carries the catalog defaults');
  assert.deepEqual(Object.keys(values).sort(),
    compiled.document.descriptor.parameters.map((parameter) => parameter.id).sort());
  const units = new Map(compiled.document.descriptor.parameters.map(
    (parameter) => [parameter.id, parameter.unit]));
  for (const id of [
    'project.projection-spin-speed', 'sample.speed', 'sample.angle-speed',
    'colorize.hue-noise-speed', 'colorize.phase-oscillation-speed',
  ]) assert.equal(units.get(id), 'turn-per-frame', id);
  assert.equal(units.get('colorize.palette-mapping'), 'mapping');
});

test('the store adopts the scratch document and edits it', async () => {
  const store = await createChainDocumentStore({
    document: scratchChainDocument(CATALOG), catalog: CATALOG,
  });
  assert.deepEqual(labels(store), ['rotate', 'project', 'sample', 'colorize']);

  assert.equal(store.replaceSpan(1, 0, [{ operator: 'sphere.lens.mobius.v2' }]).ok, true);
  assertGreen(store);
  assert.deepEqual(labels(store),
    ['rotate', 'sphere1', 'project', 'sample', 'colorize']);
});

test('the scratch builder refuses an operator the catalog lacks', () => {
  assert.throws(() => scratchChainDocument(CATALOG,
    [...DEFAULT_SCRATCH_CHAIN, { label: 'ghost', operator: 'warp.nope.v2' }]),
  /carries no operator "warp\.nope\.v2"/);
});
