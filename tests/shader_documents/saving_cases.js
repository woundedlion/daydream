import { ENGINE_CATALOG, onChange, CHAIN_STUDY, editorWorkbench, clickPlaneBandEntry, stripChip, expectStageAbsent } from "../helpers/shader_document_harness.js";
import { compileShaderDocument, exportShaderDocumentJson, validateShaderDocument } from "../../generated/shader/shader_workbench.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDY_CHAIN } from "./fixture.js";

test('Export copies the canonical v2 serialization', async () => {
  const harness = await editorWorkbench();

  const button = harness.elements.get('shader-document-export');
  await button.listeners.find(({ type }) => type === 'click').handler();
  const source = harness.copied.at(-1);
  assert.equal(source, exportShaderDocumentJson(compileShaderDocument(
    CHAIN_STUDY, {catalog: JSON.parse(ENGINE_CATALOG)}).document));
});

test('Export carries the edits made since the load', async () => {
  const harness = await editorWorkbench();
  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(await harness.controller.exportShader(), true);
  const copy = JSON.parse(harness.copied.at(-1));
  assert.equal(copy.descriptor.chain.length, STUDY_CHAIN.length + 1);
  assert.deepEqual(
    validateShaderDocument(copy, { catalog: JSON.parse(ENGINE_CATALOG) }), []);
});

test('Export omits bypassed stages and keeps them in the editor', async () => {
  const harness = await editorWorkbench();
  const bypass = () => stripChip(harness, 'lens')
    .querySelector('.chain-chip-bypass').dispatch('click');
  bypass();

  assert.equal(await harness.controller.exportShader(), true);
  expectStageAbsent(JSON.parse(harness.copied.at(-1)), 'lens');
  assert.equal(stripChip(harness, 'lens')
    .classList.contains('chain-chip--bypassed'), true);

  bypass();
  assert.equal(await harness.controller.exportShader(), true);
  assert.equal(JSON.parse(harness.copied.at(-1)).descriptor.chain
    .some((entry) => entry.label === 'lens'), true);
});

test('Export omits a modulation stage only when every preset disables it', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  const [first, second] = document.preset_bank.presets;
  first.values['modulation.modulation-enabled'] = 'disabled';
  const source = exportShaderDocumentJson(document);
  const harness = await editorWorkbench({ source });

  assert.equal(await harness.controller.exportShader(), true);
  assert.equal(JSON.parse(harness.copied.at(-1)).descriptor.chain
    .some((entry) => entry.label === 'modulation'), true);

  second.values['modulation.modulation-enabled'] = 'disabled';
  const disabled = exportShaderDocumentJson(document);
  const disabledHarness = await editorWorkbench({ source: disabled });
  assert.equal(await disabledHarness.controller.exportShader(), true);
  expectStageAbsent(JSON.parse(disabledHarness.copied.at(-1)), 'modulation');
});

test('clipboard failure leaves shader edits unexported', async () => {
  const harness = await editorWorkbench({ copyText: async () => false });
  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');
  assert.equal(await harness.controller.exportShader(), false);
  const status = harness.elements.get('shader-document-status');
  assert.match(status.textContent, /could not be copied to the clipboard/);
  assert.equal(status.dataset.status, 'error');

  let confirmations = 0;
  harness.win.confirm = () => { confirmations += 1; return false; };
  await onChange(harness.elements.get('shader-document-select'))();
  assert.equal(confirmations, 1);
});

test('Export leaves edits made during the clipboard write unexported', async () => {
  let finish;
  const writing = new Promise((resolve) => { finish = resolve; });
  const harness = await editorWorkbench({ copyText: () => writing });
  const pending = harness.controller.exportShader();
  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');
  finish(true);
  assert.equal(await pending, true);

  let confirmations = 0;
  harness.win.confirm = () => { confirmations += 1; return false; };
  await onChange(harness.elements.get('shader-document-select'))();
  assert.equal(confirmations, 1);
});
