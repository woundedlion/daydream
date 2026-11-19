import { singlePatternCatalog, ENGINE_CATALOG, SCRATCH, onChange, CHAIN_STUDY, KALEIDOSCOPE_STAINED_GLASS, STUDY_PATTERN_CATALOG, editorWorkbench, clickPlaneBandEntry, stripChips, stripChip, paramControl, displayedParameter, stageEditor, exportedValues } from "../helpers/shader_document_harness.js";
import { canonicalEffectId } from "../../src/effects/effect_identity.js";
import { engineControlNames, compileShaderDocument } from "../../generated/shader/shader_workbench.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scratchChainDocument } from "../../src/workbench/shader/chain_document_store.js";
import { ParamSetResult } from "../helpers/fake_engine.js";
import { STUDY_CHAIN } from "./fixture.js";

test('a dynamic document builds the strip, and edits re-apply through the engine', async () => {
  const harness = await editorWorkbench();
  assert.deepEqual(harness.selections, [canonicalEffectId('shader-chain'), canonicalEffectId('shader-chain')]);
  assert.equal(harness.engine.chainCalls.length, 2);
  assert.equal(harness.engine.chainCalls.at(-1).length, STUDY_CHAIN.length);
  assert.equal(stripChips(harness).length, STUDY_CHAIN.length);
  const digest = compileShaderDocument(CHAIN_STUDY,
    { catalog: JSON.parse(ENGINE_CATALOG) }).descriptor_digest;
  assert.equal(harness.elements.get('shader-document-digest').dataset.digest, digest,
    'the toolbar carries the whole descriptor digest');
  assert.equal(harness.elements.get('shader-document-digest').textContent,
    digest.slice(0, 12), 'the toolbar shows the digest abbreviated');

  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(harness.engine.chainCalls.length, 3);
  assert.equal(harness.engine.chainCalls.at(-1).length, STUDY_CHAIN.length + 1);
  assert.ok(harness.engine.writes.some(([name]) => name === 'warp.strength'),
    'the re-apply carries the backfilled catalog defaults');

  assert.equal(await harness.controller.exportShader(), true);
  const saved = JSON.parse(harness.copied[0]);
  assert.equal(saved.descriptor.chain.length, STUDY_CHAIN.length + 1);
  assert.ok(Object.keys(saved.preset_bank.presets[0].values)
    .some((id) => id.startsWith('warp.')));
});

test('Kaleidoscope Stained Glass loads its effect preset into the interpreter controls', async () => {
  const harness = await editorWorkbench({ source: KALEIDOSCOPE_STAINED_GLASS });
  const document = JSON.parse(KALEIDOSCOPE_STAINED_GLASS);
  const values = document.preset_bank.presets[0].values;
  const labels = new Set(document.descriptor.chain.map((entry) => entry.label));

  assert.deepEqual(harness.engine.chainCalls.at(-1).map((entry) => entry.operator),
    document.descriptor.chain.map((entry) => entry.operator));
  const numeric = Object.entries(values).filter(([parameterId, value]) =>
    typeof value === 'number' && labels.has(parameterId.slice(0, parameterId.indexOf('.'))));
  assert.ok(numeric.length > 0, 'the preset carries numeric stage values');
  for (const [parameterId, value] of numeric) {
    const label = parameterId.slice(0, parameterId.indexOf('.'));
    assert.ok(Math.abs(Number(displayedParameter(harness, label, parameterId)) - value) <= 1e-6,
      `${parameterId} displays the effect preset`);
    assert.ok(harness.engine.writes.some(([name, written]) =>
      name === parameterId && written === value),
    `${parameterId} reaches the interpreter`);
  }
});

test('preset and stage writes preserve the animation state', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  const presets = harness.elements.get('shader-preset-select');
  presets.value = presets.options.at(-1).value;
  await onChange(presets)();
  assert.equal(harness.animationsPaused(), false);
  harness.elements.get('shader-parity-toggle').dispatch('click');
  assert.equal(harness.animationsPaused(), false,
    'preset writes do not leave the chain frozen');
  const toggle = harness.elements.get('shader-animation-toggle');
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.textContent, 'Pause Presets');

  stageEditor(harness, 'sample')('sample.pattern-freq', 7);
  assert.equal(harness.animationsPaused(), false,
    'an inline stage edit restores the running state after the engine write');

  toggle.dispatch('click');
  assert.equal(harness.animationsPaused(), true);
  assert.equal(toggle.textContent, 'Pause Presets');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  stageEditor(harness, 'sample')('sample.pattern-freq', 8);
  assert.equal(harness.animationsPaused(), true,
    'an edit also preserves an intentional pause');
});

test('parity requires the bank digest and re-arms after undo', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  const toggle = harness.elements.get('shader-parity-toggle');
  assert.equal(toggle.disabled, false, 'the loaded digest matches a promoted effect');
  assert.deepEqual(harness.selections, [canonicalEffectId('shader-chain'), canonicalEffectId('shader-chain')],
    'a shipped pattern still previews through the interpreter');

  stripChip(harness, 'lens')
    .querySelector('.chain-chip-bypass').dispatch('click');
  assert.equal(toggle.disabled, false);

  const digest = harness.elements.get('shader-document-digest').dataset.digest;
  stageEditor(harness, 'sample')('sample.pattern-freq', 7);
  assert.equal(harness.elements.get('shader-document-digest').dataset.digest, digest);
  assert.equal(toggle.disabled, true);
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.equal(toggle.disabled, false);

  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(toggle.disabled, true);
});

test('compiled stage edits reach stages bypassed in the interpreter', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  stripChip(harness, 'warp2')
    .querySelector('.chain-chip-bypass').dispatch('click');
  harness.elements.get('shader-parity-toggle').dispatch('click');
  harness.compiledEngine.writes.length = 0;
  stageEditor(harness, 'warp2')('warp2.speed', 0.01);
  assert.deepEqual(harness.compiledEngine.writes, [['Planar Warp 2 Speed', 0.01]]);
});

test('compiled Twist stage edits resolve an arbitrary instance label', async () => {
  const document = scratchChainDocument(JSON.parse(ENGINE_CATALOG), [
    {label: 'whorl', operator: 'sphere.lens.twist.v2'}, ...SCRATCH.descriptor.chain,
  ]);
  const source = JSON.stringify(document);
  const harness = await editorWorkbench({source, sourceFiles: {'twist_study.shader.json': source},
    patternCatalog: singlePatternCatalog('twist-study', 'twist_study.shader.json', 'Twist Study')});
  const toggle = harness.elements.get('shader-parity-toggle');
  assert.equal(toggle.disabled, false);
  toggle.dispatch('click');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  harness.compiledEngine.writes.length = 0;
  const edit = stageEditor(harness, 'whorl');
  edit('whorl.twist-angle', 7.25);
  edit('whorl.twist-distribution', 0.625);
  edit('whorl.speed', 0.035);
  edit('whorl.drift', 0.006);
  assert.deepEqual(harness.compiledEngine.writes, [['whorl.Twist Angle (rad)', 7.25]]);
  assert.equal(toggle.disabled, true);
  const saved = await exportedValues(harness);
  assert.equal(saved['whorl.twist-angle'], 7.25);
  assert.equal(saved['whorl.twist-distribution'], 0.625);
  assert.equal(saved['whorl.speed'], Math.fround(0.035));
  assert.equal(saved['whorl.drift'], Math.fround(0.006));
});

test('an accepted compiled edit clears the previous refusal', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  harness.elements.get('shader-parity-toggle').dispatch('click');
  const definitions = harness.compiledEngine.getParameterDefinitions();
  const original = [...definitions];
  definitions.length = 0;
  harness.compiledEngine.writes.length = 0;
  stageEditor(harness, 'warp2')('warp2.speed', 0.01);
  assert.deepEqual(harness.compiledEngine.writes, []);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /no engine parameter matches "warp2.speed"/);
  definitions.push(...original);
  stageEditor(harness, 'warp2')('warp2.speed', 0.01);
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'ok');
  assert.match(harness.elements.get('shader-document-status').textContent, /back on the interpreter/);
  assert.equal(harness.elements.get('shader-document-error').textContent, '');
});

test('compiled stage rows share one document-definition read and refresh it after a write', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  const engine = harness.compiledEngine;
  const {descriptor, preset_bank} = JSON.parse(CHAIN_STUDY);
  const parameterId = 'modulation.pattern-scale';
  const names = engineControlNames(parameterId, descriptor);
  const definitions = engine.getParameterDefinitions();
  engine.getParameterDefinitions = () => definitions.filter(({name}) => !names.includes(name));
  const {resource_key: resource = 'modulation'} = descriptor.chain.find(({label}) => label === 'modulation');
  let reads = 0;
  let readonly = false;
  let scale = preset_bank.presets[0].values[parameterId];
  engine.getParamGeneration = () => 1;
  engine.getDocumentParameterDefinitions = () => {
    reads += 1;
    return [{resource, id: 'pattern-scale', value: scale, readonly}];
  };
  engine.setDocumentParameter = (_resource, _id, value) => {
    scale = value;
    return ParamSetResult.APPLIED;
  };
  harness.elements.get('shader-parity-toggle').dispatch('click');
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'ok');
  assert.ok(reads <= 3, `parity render and preset used ${reads} document-definition reads`);
  const control = () => paramControl(harness, 'modulation', parameterId);
  assert.equal(control().disabled, false);

  const write = engine.setParameter;
  engine.setParameter = (...args) => {
    readonly = true;
    return write(...args);
  };
  const edit = stageEditor(harness, 'sample');
  const before = reads;
  edit('sample.pattern-freq', preset_bank.presets[0].values['sample.pattern-freq']);

  assert.equal(reads - before, 2, 'the write and its row refresh each read once');
  assert.equal(control().disabled, true);
});

test('a descriptor edit under the compiled build returns the preview to the interpreter', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  const status = harness.elements.get('shader-document-status');
  const toggle = harness.elements.get('shader-parity-toggle');

  toggle.dispatch('click');

  assert.equal(harness.selections.at(-1), 'ChainStudy');
  assert.deepEqual(harness.compiledEngine.selected, [JSON.parse(CHAIN_STUDY).preset_bank.presets[0].preset_id]);
  assert.ok(harness.compiledEngine.writes.some(([name]) => name === 'Camera Wander'),
    'the compiled build takes the preset through its own control names');
  assert.match(status.textContent, /compiled build/);

  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(harness.selections.at(-1), 'shader-chain');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(harness.engine.chainCalls.at(-1).length, STUDY_CHAIN.length + 1,
    'the edited chain is what renders');
  assert.match(status.textContent, /back on the interpreter/);
});


test('a refused compiled coupled edit restores the unchanged document preset', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  harness.elements.get('shader-parity-toggle').dispatch('click');
  const engine = harness.compiledEngine;
  engine.getParameterDefinitions().push({name: 'Modulation Mechanic',
    options: ['hue-rotation', 'positive-lightness-lift', 'opacity']});
  const before = await exportedValues(harness);
  const selectionCount = engine.selected.length;
  const write = engine.setParameter;
  let refused = false;
  engine.setParameter = (name, value) => {
    if (!refused && name.includes('Modulation Amount')) {
      refused = true;
      return ParamSetResult.UNKNOWN_PARAM;
    }
    return write(name, value);
  };
  stageEditor(harness, 'modulation')('modulation.modulation-mechanic', 'opacity');
  assert.equal(refused, true);
  assert.equal(engine.selected.length, selectionCount + 1);
  assert.match(harness.elements.get('shader-document-status').textContent, /was refused/);
  assert.deepEqual(await exportedValues(harness), before);
});
