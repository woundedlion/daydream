import { paramRow, SCRATCH, promotedDocument, editorWorkbench, stripChips, displayedParameter, stageEditor, savedValues } from ".././helpers/shader_document_harness.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeShaderStateHash } from "../../src/workbench/shader/shader_deeplink.js";
import { ParamSetResult } from ".././helpers/fake_engine.js";
import { BAKED_MODULATION_SCALE_MAX, MODULATION_OPERATOR, PALETTE_OPERATOR, UNIT_MODULATION_AMOUNT_MAX } from "../../src/workbench/shader/chain_presentation.js";
import { STUDY_CHAIN, optionIndex } from "./fixture.js";

test('stage controls stay expanded and source function is directly selectable', async () => {
  const harness = await editorWorkbench();
  const lens = stripChips(harness).find((chip) => chip.dataset.label === 'lens');
  const lensRows = lens.querySelectorAll('.chain-param').map((row) => row.dataset.parameter);
  assert.ok(lensRows.length > 0, 'the lens chip renders its rows expanded');
  assert.ok(lensRows.every((id) => id.startsWith('lens.')));

  const source = stripChips(harness).find((chip) => chip.dataset.label === 'sample');
  const select = source.querySelector('.chain-chip-replace');
  assert.equal(select.getAttribute('aria-label'), 'Source function');
  assert.equal(select.options.every((option) => option.value.startsWith('sample.')), true);
  select.value = 'sample.spiral.v3';
  select.dispatch('change');

  assert.ok(harness.engine.chainCalls.at(-1)
    .some((entry) => entry.operator === 'sample.spiral.v3'));
});

test('an add menu omits stages that are invalid at its gap', async () => {
  const harness = await editorWorkbench();
  const plane = harness.elements.get('chain-strip').querySelectorAll('.chain-band')
    .find((band) => band.dataset.carrier === 'plane');
  plane.querySelector('.chain-band-add').dispatch('click');
  const entries = harness.elements.get('chain-strip')
    .querySelectorAll('.chain-palette-entry');
  assert.ok(entries.length > 0, 'the gap offers valid stages');
  assert.equal(entries.some((entry) => entry.dataset.operator === 'sphere.rotate.v2'),
    false);
  assert.equal(entries.every((entry) => entry.getAttribute('aria-disabled') === null),
    true);
});

test('a bypass reshapes the engine program and skips the bypassed parameters', async () => {
  const harness = await editorWorkbench();
  const writesBefore = harness.engine.writes.length;
  stripChips(harness).find((chip) => chip.dataset.label === 'lens')
    .querySelector('.chain-chip-bypass').dispatch('click');

  const shape = harness.engine.chainCalls.at(-1);
  assert.equal(shape.length, STUDY_CHAIN.length - 1);
  assert.ok(!shape.some((entry) => entry.instance === 'lens'));
  assert.ok(harness.engine.writes.length > writesBefore,
    'the re-apply rewrote the surviving instances');
  assert.ok(!harness.engine.writes.slice(writesBefore)
    .some(([name]) => name.startsWith('lens.')),
  'a bypassed instance registers no parameters, so its values are skipped');
});

test('a card reset applies defaults to the preview, Save and link with one undo', async () => {
  const harness = await editorWorkbench({ source: null });
  stageEditor(harness, 'sample')('sample.pattern-freq', 7);
  stageEditor(harness, 'colorize')('colorize.palette-mapping', 'reverse');
  const before = savedValues(harness);
  const original = SCRATCH.preset_bank.presets[0].values;
  harness.elements.get('shader-animation-toggle').dispatch('click');
  stripChips(harness).find((chip) => chip.dataset.label === 'sample')
    .querySelector('.chain-chip-reset').dispatch('click');
  const after = savedValues(harness);
  for (const [id, value] of Object.entries(original)) {
    if (id.startsWith('sample.'))
      assert.equal(after[id], typeof value === 'number' ? Math.fround(value) : value, id);
  }
  assert.equal(after['colorize.palette-mapping'], 'reverse');
  assert.equal(harness.animationsPaused(), true);
  assert.ok(harness.engine.writes.some(([name, value]) =>
    name === 'sample.pattern-freq' && value === original['sample.pattern-freq']));
  await harness.controller.flushDeepLink();
  const linked = await decodeShaderStateHash(harness.win.location.hash);
  assert.deepEqual(Object.fromEntries(Object.entries(linked.document.preset_bank.presets[0].values)
    .map(([id, value]) => [id, typeof value === 'number' ? Math.fround(value) : value])), after);
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(savedValues(harness), before);
});

test('Grid Space switches modulation source and sampling atomically with one undo', async () => {
  const harness = await editorWorkbench({ source: JSON.stringify(promotedDocument('grid_space.shader.json')) });
  const original = savedValues(harness);
  const batches = [];
  const apply = harness.engine.bindings.setShaderChainParameters;
  harness.engine.bindings.setShaderChainParameters = (writes) => {
    batches.push(writes);
    return apply(writes);
  };
  harness.engine.setParameter = () => ParamSetResult.INADMISSIBLE;
  const edit = stageEditor(harness, 'modulation');
  const chip = stripChips(harness).find((chip) => chip.dataset.label === 'modulation');
  edit('modulation.modulation-source', 'sphere-interference');
  assert.ok(stripChips(harness).find((chip) => chip.dataset.label === 'modulation') === chip,
    'the active Color stage stays mounted');
  assert.deepEqual(batches, [[
    { name: 'modulation.modulation-source',
      value: optionIndex(MODULATION_OPERATOR, 'modulation-source', 'sphere-interference') },
    { name: 'modulation.modulation-evaluation',
      value: optionIndex(MODULATION_OPERATOR, 'modulation-evaluation', 'direct') },
  ]]);
  const values = savedValues(harness);
  assert.equal(values['modulation.modulation-source'], 'sphere-interference');
  assert.equal(values['modulation.modulation-evaluation'], 'direct');
  const colorRows = stripChips(harness).find((chip) => chip.dataset.label === 'modulation')
    .querySelectorAll('.chain-param');
  assert.equal(colorRows.find((row) => row.dataset.parameter === 'modulation.modulation-evaluation')
    .querySelector('.chain-param-control').value, 'direct');
  await harness.controller.flushDeepLink();
  const linked = await decodeShaderStateHash(harness.win.location.hash);
  assert.equal(linked.document.preset_bank.presets[0].values['modulation.modulation-source'],
    'sphere-interference');
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(savedValues(harness), original);
});

test('a refused modulation source batch preserves both fields and the visible Noise controls', async () => {
  const harness = await editorWorkbench({source: JSON.stringify(promotedDocument('grid_space.shader.json'))});
  const original = savedValues(harness);
  harness.engine.bindings.setShaderChainParameters = () => ParamSetResult.INADMISSIBLE;
  stageEditor(harness, 'modulation')('modulation.modulation-source', 'sphere-interference');
  assert.match(harness.elements.get('shader-document-status').textContent, /INADMISSIBLE/);
  assert.deepEqual(savedValues(harness), original);
  const colorRows = stripChips(harness).find((chip) => chip.dataset.label === 'modulation')
    .querySelectorAll('.chain-param');
  assert.equal(colorRows.find((row) => row.dataset.parameter === 'modulation.modulation-source')
    .querySelector('.chain-param-control').value, original['modulation.modulation-source']);
  const groups = stripChips(harness).find((chip) => chip.dataset.label === 'modulation')
    .querySelectorAll('.chain-param-group');
  assert.equal(groups.filter((group) => group.getAttribute('aria-label') === 'Noise').at(-1).hidden, false);
  assert.equal(groups.find((group) => group.getAttribute('aria-label') === 'Interference · wave A').hidden, true);
});

test('lightness lift preserves the noise recipe and clamps only strength in one undo', async () => {
  const harness = await editorWorkbench();
  const edit = stageEditor(harness, 'modulation');
  edit('modulation.modulation-amount', 2);
  edit('modulation.pattern-noise-variant', 'octave-contour');
  edit('modulation.pattern-noise-basis', 'fbm3');
  edit('modulation.pattern-contrast', 2);
  const original = savedValues(harness);
  const batches = [];
  const apply = harness.engine.bindings.setShaderChainParameters;
  harness.engine.bindings.setShaderChainParameters = (writes) => {
    batches.push(writes);
    return apply(writes);
  };
  edit('modulation.modulation-mechanic', 'positive-lightness-lift');
  assert.deepEqual(batches, [[
    { name: 'modulation.modulation-mechanic',
      value: optionIndex(MODULATION_OPERATOR, 'modulation-mechanic', 'positive-lightness-lift') },
    { name: 'modulation.modulation-amount', value: UNIT_MODULATION_AMOUNT_MAX },
  ]]);
  const values = savedValues(harness);
  assert.equal(values['modulation.modulation-mechanic'], 'positive-lightness-lift');
  assert.equal(values['modulation.modulation-amount'], UNIT_MODULATION_AMOUNT_MAX);
  assert.equal(values['modulation.pattern-noise-variant'], 'octave-contour');
  assert.equal(values['modulation.pattern-noise-basis'], 'fbm3');
  assert.equal(values['modulation.pattern-contrast'], 2);
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(savedValues(harness), original);
});

test('configured-single resets its coupled noise fields in one admitted batch and undo', async () => {
  const harness = await editorWorkbench();
  const edit = stageEditor(harness, 'modulation');
  edit('modulation.pattern-noise-variant', 'octave-contour');
  edit('modulation.pattern-noise-basis', 'fbm3');
  edit('modulation.pattern-contrast', 2);
  const original = savedValues(harness);
  const batches = [];
  const apply = harness.engine.bindings.setShaderChainParameters;
  harness.engine.bindings.setShaderChainParameters = (writes) => {
    const result = apply(writes);
    batches.push({writes, result});
    return result;
  };
  edit('modulation.pattern-noise-variant', 'configured-single');
  assert.deepEqual(batches, [{writes: [
    {name: 'modulation.pattern-noise-variant',
      value: optionIndex(MODULATION_OPERATOR, 'pattern-noise-variant', 'configured-single')},
    {name: 'modulation.pattern-noise-basis',
      value: optionIndex(MODULATION_OPERATOR, 'pattern-noise-basis', 'simplex')},
    {name: 'modulation.pattern-contrast', value: 0},
  ], result: ParamSetResult.APPLIED}]);
  const values = savedValues(harness);
  assert.equal(values['modulation.pattern-noise-variant'], 'configured-single');
  assert.equal(values['modulation.pattern-noise-basis'], 'simplex');
  assert.equal(values['modulation.pattern-contrast'], 0);
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(savedValues(harness), original);
});

test('baked sampling clamps an existing direct Noise scale in the same edit', async () => {
  const harness = await editorWorkbench();
  const edit = stageEditor(harness, 'modulation');
  edit('modulation.modulation-evaluation', 'direct');
  edit('modulation.pattern-scale', 32);
  edit('modulation.modulation-evaluation', 'baked-cube');
  assert.equal(savedValues(harness)['modulation.pattern-scale'], BAKED_MODULATION_SCALE_MAX);
  assert.equal(displayedParameter(harness, 'modulation', 'modulation.pattern-scale'),
    String(BAKED_MODULATION_SCALE_MAX));
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  const values = savedValues(harness);
  assert.equal(values['modulation.pattern-scale'], 32);
  assert.equal(values['modulation.modulation-evaluation'], 'direct');
});

// A chip control's edit is a document edit, and the engine write is its
// side effect, so Save reads the document and nothing else.
test('a chip control writes the active preset and survives Save without an engine read', async () => {
  const harness = await editorWorkbench();
  const mark = harness.engine.writes.length;

  stageEditor(harness, 'sample')('sample.pattern-freq', 7);
  stageEditor(harness, 'colorize')('colorize.palette-mapping', 'reverse');
  const writes = harness.engine.writes.slice(mark);
  assert.ok(writes.some(
    ([name, value]) => name === 'sample.pattern-freq' && value === 7),
  'the engine takes the edit as it lands');
  assert.ok(writes.some(
    ([name, value]) => name === 'colorize.palette-mapping'
      && value === optionIndex(PALETTE_OPERATOR, 'palette-mapping', 'reverse')),
  'an enum reaches the engine as its option index');
  harness.engine.getParameterDefinitions = () => {
    throw new Error('Save must not read the engine');
  };

  const values = savedValues(harness);
  assert.equal(values['sample.pattern-freq'], 7);
  assert.equal(values['colorize.palette-mapping'], 'reverse',
    'the document stores the option id');
});

test('a chip slider stops at its domain limit without a rejection', async () => {
  const harness = await editorWorkbench();
  const maximum = harness.engine.getParameterDefinitions()
    .find((parameter) => parameter.name === 'sample.pattern-freq').max;

  stageEditor(harness, 'sample')('sample.pattern-freq', 500);

  const status = harness.elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'ok');
  assert.equal(savedValues(harness)['sample.pattern-freq'], maximum);
});

test('chip ranges remain fixed during edits and refresh on commit and undo', async () => {
  let maximum = 6;
  const harness = await editorWorkbench({prepare(engine) {
    engine.bindings.getShaderChainParameterRanges = () => [
      {name: 'sample.pattern-freq', min: 1, max: maximum},
    ];
  }});
  const currentSlider = () => paramRow(harness, 'sample', 'sample.pattern-freq')
    .querySelector('.chain-param-control');
  assert.equal(Number(currentSlider().max), 6);
  const edit = stageEditor(harness, 'sample');
  const slider = currentSlider();
  edit('sample.pattern-freq', 20);
  assert.equal(savedValues(harness)['sample.pattern-freq'], 6);
  maximum = 12;
  edit('sample.pattern-freq', 5);
  assert.equal(Number(slider.max), 6);
  slider.dispatch('change');
  assert.equal(Number(slider.max), 12);
  edit('sample.pattern-freq', 10);
  assert.equal(savedValues(harness)['sample.pattern-freq'], 10);
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  const restored = paramRow(harness, 'sample', 'sample.pattern-freq')
    .querySelector('.chain-param-control');
  assert.equal(Number(restored.max), 12);
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'ok');
});

test('smooth-grid axes can be edited independently without an orthogonality refusal', async () => {
  const harness = await editorWorkbench();
  const edit = stageEditor(harness, 'modulation');
  edit('modulation.modulation-source', 'sphere-smooth-grid');
  edit('modulation.grid-axis-b-y', 0.5);
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'ok');
  assert.equal(savedValues(harness)['modulation.grid-axis-b-y'], 0.5);
  assert.ok(harness.engine.writes.some(([name, value]) =>
    name === 'modulation.grid-axis-b-y' && value === 0.5));
});

test('a native refusal preserves saved values, links and coalesced undo history', async () => {
  const harness = await editorWorkbench();
  const before = savedValues(harness)['sample.pattern-freq'];
  const edit = stageEditor(harness, 'sample');
  edit('sample.pattern-freq', 6);
  const original = harness.engine.setParameter.bind(harness.engine);
  harness.engine.setParameter = (name, value) => value === 7
    ? ParamSetResult.INADMISSIBLE : original(name, value);

  edit('sample.pattern-freq', 7);

  assert.match(harness.elements.get('shader-document-status').textContent, /INADMISSIBLE/);
  assert.equal(savedValues(harness)['sample.pattern-freq'], 6);
  assert.equal(Number(displayedParameter(harness, 'sample', 'sample.pattern-freq')), 6);
  await harness.controller.flushDeepLink();
  const shared = await decodeShaderStateHash(harness.win.location.hash);
  assert.equal(shared.document.preset_bank.presets[0].values['sample.pattern-freq'], 6);
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.equal(savedValues(harness)['sample.pattern-freq'], before);
});

// One history: the strip's Undo covers a chip control's edit, and a drag's
// stream of writes is one step in it.
test('a chip control edit joins the structural history and coalesces per control', async () => {
  const harness = await editorWorkbench();
  const strip = harness.elements.get('chain-strip');
  assert.equal(strip.querySelector('.chain-undo').disabled, true);
  const opening = savedValues(harness)['sample.pattern-freq'];

  const edit = stageEditor(harness, 'sample');
  for (const value of [2, 3, 4]) edit('sample.pattern-freq', value);
  assert.equal(savedValues(harness)['sample.pattern-freq'], 4);
  assert.equal(strip.querySelector('.chain-undo').disabled, false,
    'the write that opens the run enables the strip Undo');

  const mark = harness.engine.writes.length;
  strip.querySelector('.chain-undo').dispatch('click');

  assert.equal(savedValues(harness)['sample.pattern-freq'], opening);
  assert.equal(strip.querySelector('.chain-undo').disabled, true);
  assert.ok(harness.engine.writes.slice(mark).some(
    ([name, value]) => name === 'sample.pattern-freq' && value === opening),
  'undoing the edit re-applies the restored value to the engine');
});
