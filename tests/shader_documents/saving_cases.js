import { ENGINE_CATALOG, onChange, CHAIN_STUDY, editorWorkbench, clickPlaneBandEntry, stripChips, expectStageAbsent } from "../helpers/shader_document_harness.js";
import { compileShaderDocument, exportShaderDocumentJson, validateShaderDocument } from "../../generated/shader/shader_workbench.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { STUDY_CHAIN } from "./fixture.js";

// Save has one format, and it is the canonicalizer's.
test('Save writes the canonical v2 serialization', async () => {
  const harness = await editorWorkbench();

  assert.equal(harness.controller.save(), true);
  const [filename, source] = harness.downloads.at(-1);
  assert.equal(filename, 'study.shader.json');
  assert.equal(source, exportShaderDocumentJson(compileShaderDocument(
    CHAIN_STUDY, {catalog: JSON.parse(ENGINE_CATALOG)}).document));
});

// Save As is a copy, not a rename - the loaded document and the
// name plain Save re-exports over are both left alone.
test('Save As writes a new document id and leaves the loaded one alone', async () => {
  const harness = await editorWorkbench();

  assert.equal(await harness.controller.saveAs(), true);
  const [copyName, copySource] = harness.downloads.at(-1);
  const copy = JSON.parse(copySource);
  assert.equal(copy.document_id, 'chain-study-copy1');
  assert.equal(copyName, 'chain-study-copy1.shader.json');
  assert.equal(copySource, exportShaderDocumentJson(copy),
    'a copy is written in the same canonical serialization as Save');

  assert.equal(harness.controller.save(), true);
  const [savedName, savedSource] = harness.downloads.at(-1);
  assert.equal(savedName, 'study.shader.json');
  assert.equal(JSON.parse(savedSource).document_id, 'chain-study');

  assert.equal(await harness.controller.saveAs(), true);
  assert.equal(JSON.parse(harness.downloads.at(-1)[1]).document_id,
    'chain-study-copy2', 'each copy takes an id of its own');
});

for (const picker of [false, true]) test(`cancelled Save As preserves the next copy number (picker=${picker})`, async () => {
  const h = await editorWorkbench();
  h.win.prompt = () => null;
  if (picker) h.win.showSaveFilePicker = async () => {
    throw new DOMException('Cancelled', 'AbortError');
  };
  assert.equal(await h.controller.saveAs(), false);
  assert.equal(await h.controller.saveAs(), false);
  delete h.win.showSaveFilePicker;
  h.win.prompt = (message, filename) => filename;
  assert.equal(await h.controller.saveAs(), true);
  assert.equal(JSON.parse(h.downloads.at(-1)[1]).document_id, 'chain-study-copy1');
});

test('a Save As copy carries the edits made since the load', async () => {
  const harness = await editorWorkbench();
  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(await harness.controller.saveAs(), true);
  const copy = JSON.parse(harness.downloads.at(-1)[1]);
  assert.equal(copy.descriptor.chain.length, STUDY_CHAIN.length + 1);
  assert.deepEqual(
    validateShaderDocument(copy, { catalog: JSON.parse(ENGINE_CATALOG) }), []);
});

test('Save and Save As omit bypassed stages and keep them in the editor', async () => {
  const harness = await editorWorkbench();
  const bypass = () => stripChips(harness).find((chip) => chip.dataset.label === 'lens')
    .querySelector('.chain-chip-bypass').dispatch('click');
  bypass();

  assert.equal(harness.controller.save(), true);
  expectStageAbsent(JSON.parse(harness.downloads.at(-1)[1]), 'lens');
  assert.equal(await harness.controller.saveAs(), true);
  expectStageAbsent(JSON.parse(harness.downloads.at(-1)[1]), 'lens');
  assert.equal(stripChips(harness).find((chip) => chip.dataset.label === 'lens')
    .classList.contains('chain-chip--bypassed'), true);

  bypass();
  assert.equal(harness.controller.save(), true);
  assert.equal(JSON.parse(harness.downloads.at(-1)[1]).descriptor.chain
    .some((entry) => entry.label === 'lens'), true);
});

test('Save omits a modulation stage only when every preset disables it', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  const [first, second] = document.preset_bank.presets;
  first.values['modulation.modulation-enabled'] = 'disabled';
  const source = exportShaderDocumentJson(document);
  const harness = await editorWorkbench({ source });

  assert.equal(harness.controller.save(), true);
  assert.equal(JSON.parse(harness.downloads.at(-1)[1]).descriptor.chain
    .some((entry) => entry.label === 'modulation'), true);

  second.values['modulation.modulation-enabled'] = 'disabled';
  const disabled = exportShaderDocumentJson(document);
  const disabledHarness = await editorWorkbench({ source: disabled });
  assert.equal(disabledHarness.controller.save(), true);
  expectStageAbsent(JSON.parse(disabledHarness.downloads.at(-1)[1]), 'modulation');
});

for (const [entered, filename] of [
  ['  Night study  ', 'Night study.shader.json'],
  ['Night study.json', 'Night study.json'],
]) {
  test(`Save As downloads the filename entered as ${JSON.stringify(entered)}`, async () => {
    const harness = await editorWorkbench();
    harness.win.prompt = (message, suggestedName) => {
      assert.equal(suggestedName, 'chain-study-copy1.shader.json');
      return entered;
    };
    assert.equal(await harness.controller.saveAs(), true);
    assert.equal(harness.downloads.at(-1)[0], filename);
    assert.equal(JSON.parse(harness.downloads.at(-1)[1]).document_id,
      'chain-study-copy1');
  });
}

for (const filename of [null, '   ']) {
  test(`Save As does not download after a ${filename === null ? 'cancelled' : 'blank'} filename`, async () => {
    const harness = await editorWorkbench();
    harness.win.prompt = () => filename;
    assert.equal(await harness.controller.saveAs(), false);
    assert.deepEqual(harness.downloads, []);
    assert.doesNotMatch(harness.elements.get('shader-document-status').textContent,
      /^Saved /);
  });
}

test('Save As opens the file picker immediately and writes to its chosen file', async () => {
  const harness = await editorWorkbench();
  const writes = [];
  let closed = false;
  let options;
  harness.win.prompt = () => assert.fail('the native picker chooses the filename');
  harness.win.showSaveFilePicker = (value) => {
    options = value;
    return Promise.resolve({
      name: 'My shader.json',
      createWritable: async () => ({
        write: async (source) => writes.push(source),
        close: async () => { closed = true; },
      }),
    });
  };
  const pending = harness.controller.saveAs();
  assert.equal(options.suggestedName, 'chain-study-copy1.shader.json');
  assert.deepEqual(options.types[0].accept, { 'application/json': ['.json'] });
  assert.equal(await pending, true);
  assert.deepEqual(harness.downloads, []);
  assert.equal(closed, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0], exportShaderDocumentJson(JSON.parse(writes[0])));
  assert.equal(JSON.parse(writes[0]).document_id, 'chain-study-copy1');
  assert.equal(harness.elements.get('shader-document-status').textContent,
    'Saved My shader.json.');
  assert.equal(harness.controller.save(), true);
  assert.equal(harness.downloads.at(-1)[0], 'study.shader.json');
  assert.equal(JSON.parse(harness.downloads.at(-1)[1]).document_id,
    'chain-study');
});

test('cancelling the Save As picker leaves the document unsaved without an error', async () => {
  const harness = await editorWorkbench();
  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');
  const status = harness.elements.get('shader-document-status').textContent;
  harness.win.showSaveFilePicker = async () => {
    throw new DOMException('Cancelled', 'AbortError');
  };
  assert.equal(await harness.controller.saveAs(), false);
  assert.deepEqual(harness.downloads, []);
  assert.equal(harness.elements.get('shader-document-status').textContent, status);
  let confirmations = 0;
  harness.win.confirm = () => { confirmations += 1; return false; };
  await onChange(harness.elements.get('shader-document-select'))();
  assert.equal(confirmations, 1);
});

test('a failed Save As write aborts the stream and reports the error', async () => {
  const harness = await editorWorkbench();
  let aborted = false;
  harness.win.showSaveFilePicker = async () => ({
    name: 'study.json',
    createWritable: async () => ({
      write: async () => { throw new Error('Disk full'); },
      close: async () => assert.fail('a failed write must not commit the file'),
      abort: async () => { aborted = true; },
    }),
  });
  assert.equal(await harness.controller.saveAs(), false);
  assert.equal(aborted, true);
  assert.deepEqual(harness.downloads, []);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /could not be saved: Error: Disk full/);
});

test('Save As leaves edits made during the write unsaved', async () => {
  const harness = await editorWorkbench();
  let finish;
  const writing = new Promise((resolve) => { finish = resolve; });
  harness.win.showSaveFilePicker = async () => ({
    name: 'study.json',
    createWritable: async () => ({ write: () => writing, close: async () => {} }),
  });
  const pending = harness.controller.saveAs();
  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');
  finish();
  assert.equal(await pending, true);
  let confirmations = 0;
  harness.win.confirm = () => { confirmations += 1; return false; };
  await onChange(harness.elements.get('shader-document-select'))();
  assert.equal(confirmations, 1);
});
