import { ownedEditors, MODULE, workbench, onChange, CHAIN_STUDY, STUDY_PATTERN_CATALOG, editorWorkbench, sampleFrequencySlider, stageEditor, savedValues } from ".././helpers/shader_document_harness.js";
import { DEFAULT_LIMITS } from "../../generated/shader/shader_workbench.mjs";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { shaderWorkbenchUrl, start } from "../../src/app/daydream.js";
import { decodeShaderStateHash, encodeShaderStateHash } from "../../src/workbench/shader/shader_deeplink.js";
import { SHADER_LINK_MAX_WAIT_MS } from "../../src/workbench/shader/shader_documents.js";

test('the workbench route carries the requested shader document', () => {
  assert.equal(
    shaderWorkbenchUrl('https://example.test/daydream/index.html?effect=alien-brain', 'alien-brain'),
    '/daydream/tools/shader.html?effect=alien-brain',
  );
});

// A document id is a workbench effect the simulator's favorites never list, so
// without the route it fails validation and the page opens on its default.
test('the Ash Cloud document deep link routes the simulator to the workbench', () => {
  const replaced = [];
  const win = {
    location: { href: 'https://example.test/daydream/index.html?effect=ash-cloud',
                search: '?effect=ash-cloud',
                replace: (url) => replaced.push(url) },
    addEventListener() {}, removeEventListener() {},
  };
  const doc = { documentElement: { dataset: {} } };
  start({ doc, win });
  assert.deepEqual(replaced, ['/daydream/tools/shader.html?effect=ash-cloud']);
});

test('a rejected file read is announced and the same file can be picked again', async () => {
  const { controller, elements } = workbench();
  await controller.init();
  const input = elements.get('shader-document-file');
  input.value = 'broken.shader.json';
  input.files = [{ name: 'broken.shader.json', size: 100, text: async () => { throw new Error('read failed'); } }];
  await onChange(input)();
  assert.equal(input.value, '');
  const status = elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /Could not open shader document.*read failed/);
  input.value = 'broken.shader.json';
  await onChange(input)();
  assert.equal(input.value, '');
});

test('an oversized file is rejected before reading and clears the picker', async () => {
  const { controller, elements, selections } = workbench();
  await controller.init();
  const previousSelections = [...selections];
  const source = elements.get('shader-document-select');
  const previousSource = source.value;
  const input = elements.get('shader-document-file');
  let reads = 0;
  input.value = 'huge.shader.json';
  input.files = [{
    name: 'huge.shader.json', size: DEFAULT_LIMITS.bytes + 1,
    text: async () => { ++reads; throw new Error('must not read'); },
  }];
  await onChange(input)();
  assert.equal(reads, 0);
  assert.equal(input.value, '');
  assert.equal(source.value, previousSource);
  assert.deepEqual(selections, previousSelections);
  const status = elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /document byte limit was exceeded/);
});

test('disposing a document controller flushes edits and releases its whole UI', async () => {
  const harness = await editorWorkbench({ source: null });
  const events = [
    ['shader-document-select', 'change'], ['shader-preset-select', 'change'],
    ['shader-document-open', 'click'], ['shader-document-file', 'change'],
    ['shader-document-save', 'click'], ['shader-document-save-as', 'click'],
    ['shader-animation-toggle', 'click'], ['shader-parity-toggle', 'click'],
    ['shader-document-digest', 'click'],
  ];
  for (const [id, type] of events)
    assert.equal(harness.elements.get(id).listeners.filter((entry) => entry.type === type).length, 1, id);
  const lateAnimation = harness.elements.get('shader-animation-toggle').listeners
    .find((entry) => entry.type === 'click').handler;
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    harness.urls.length = 0;
    const slider = sampleFrequencySlider(harness);
    slider.value = '8';
    slider.dispatch('input');
    await harness.controller.dispose();
    ownedEditors.delete(harness.controller);
    assert.equal(harness.urls.length, 1);
    const linked = await decodeShaderStateHash(harness.win.location.hash);
    assert.equal(linked.document.preset_bank.presets[0].values['sample.pattern-freq'], 8);
    for (const [id, type] of events)
      assert.equal(harness.elements.get(id).listeners.filter((entry) => entry.type === type).length, 0, id);
    assert.equal(harness.elements.get('chain-strip').querySelectorAll('.chain-chip').length, 0);
    assert.equal(harness.elements.get('chain-strip').children[0].listeners.length, 0);
    assert.equal(harness.filters.at(-1), null);
    lateAnimation();
    const reads = harness.pausedReads();
    mock.timers.tick(SHADER_LINK_MAX_WAIT_MS * 2);
    assert.equal(harness.pausedReads(), reads, 'a disposed link writer schedules no later writes');
    assert.equal(harness.urls.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('catalog skew refuses initialization before any chain is applied', async () => {
  const original = MODULE.ShaderChainBindings.getShaderChainCatalog;
  MODULE.ShaderChainBindings.getShaderChainCatalog = () => '{}';
  try {
    const page = workbench();
    assert.equal(await page.controller.init(), false);
    assert.match(page.elements.get('shader-document-status').textContent, /does not match/);
    assert.equal(page.engine.chained.length, 0);
  } finally {
    MODULE.ShaderChainBindings.getShaderChainCatalog = original;
  }
});

test('source and file switches preserve edits when discard is refused', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  let confirmations = 0;
  harness.win.confirm = () => { confirmations += 1; return false; };
  stageEditor(harness, 'sample')('sample.pattern-freq', 3.5);
  await harness.controller.flushDeepLink();
  const hash = harness.win.location.hash;
  const source = harness.elements.get('shader-document-select');
  const before = source.value;
  source.value = source.options.find((option) => option.value !== before).value;
  assert.notEqual(source.value, before);
  await onChange(source)();
  assert.equal(source.value, before);
  assert.equal(harness.win.location.hash, hash);
  const file = harness.elements.get('shader-document-file');
  let reads = 0;
  file.files = [{ size: 100, name: 'new.shader.json', text: async () => {
    reads += 1;
    return CHAIN_STUDY;
  } }];
  await onChange(file)();
  assert.equal(reads, 0);
  assert.equal(confirmations, 2);
  assert.equal(harness.win.location.hash, hash);
  harness.controller.save();
  await onChange(source)();
  assert.equal(confirmations, 2, 'saving clears the dirty marker');
});

test('refused replacement restores the previous compiled preset after switching effects', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  harness.elements.get('shader-parity-toggle').dispatch('click');
  harness.compiledEngine.selected.length = 0;
  assert.equal(await harness.controller.loadSource(
    JSON.parse(CHAIN_STUDY), 'refused.shader.json', null,
    { preset: JSON.parse(CHAIN_STUDY).preset_bank.presets[0].preset_id, bypassed: ['missing-stage'], paused: false }), false);
  assert.equal(harness.selections.at(-1), 'ChainStudy');
  assert.deepEqual(harness.compiledEngine.selected, [JSON.parse(CHAIN_STUDY).preset_bank.presets[0].preset_id]);
  assert.match(harness.elements.get('shader-document-status').textContent, /missing-stage/);
});

test('a refused interpreter re-apply keeps the error after parity drops', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  harness.elements.get('shader-parity-toggle').dispatch('click');
  harness.engine.bindings.setShaderChain = () => ({ code: 'ARENA_OVERFLOW', entryIndex: -1 });
  stageEditor(harness, 'sample')('sample.edge-width', 0.25);
  const status = harness.elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /ARENA_OVERFLOW/);
});

test('a compiled slider declaration keeps its control through release and explains the parity drop', async () => {
  const harness = await editorWorkbench({patternCatalog: STUDY_PATTERN_CATALOG});
  const mount = harness.elements.get('chain-strip');
  const sliderFor = () => mount.querySelectorAll('.chain-param')
    .find((row) => row.dataset.parameter === 'sample.edge-width').querySelector('.chain-param-control');
  harness.elements.get('shader-parity-toggle').dispatch('click');
  const slider = sliderFor();
  for (const value of [0.25, 0.3]) {
    slider.value = String(value);
    slider.dispatch('input');
    harness.animationFrames.flush();
    assert.equal(sliderFor() === slider, true, 'the slider stays mounted during the drag');
    assert.ok(harness.engine.writes.some(([name, written]) =>
      name === 'sample.edge-width' && written === value));
  }
  assert.equal(harness.selections.at(-1), 'shader-chain');
  assert.match(harness.elements.get('shader-document-status').textContent,
    /back on the interpreter.*parity toggle is disarmed/);
  slider.dispatch('change');
  assert.equal(sliderFor() === slider, false, 'the panel refreshes after release');
  assert.equal(Number(sliderFor().value), 0.3);
});

for (const compiled of [false, true]) {
  test(`an omitted parameter edit declares it and updates parity from ${compiled ? 'compiled' : 'interpreter'} preview`, async () => {
    const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
    const toggle = harness.elements.get('shader-parity-toggle');
    const original = savedValues(harness);
    const before = JSON.parse(harness.downloads.at(-1)[1]);
    const digest = harness.elements.get('shader-document-digest').dataset.digest;
    assert.equal(toggle.disabled, false);
    assert.equal(Object.hasOwn(original, 'sample.edge-width'), false);
    if (compiled) toggle.dispatch('click');
    stageEditor(harness, 'sample')('sample.edge-width', 0.25);
    assert.equal(toggle.disabled, true);
    assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    assert.ok(harness.engine.writes.some(([name, value]) =>
      name === 'sample.edge-width' && value === 0.25));
    assert.equal(savedValues(harness)['sample.edge-width'], 0.25);
    assert.notEqual(harness.elements.get('shader-document-digest').dataset.digest, digest);
    harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
    assert.equal(toggle.disabled, false);
    savedValues(harness);
    assert.deepEqual(JSON.parse(harness.downloads.at(-1)[1]), before);
    assert.equal(harness.elements.get('shader-document-digest').dataset.digest, digest);
  });
}

test('restored edits require discard confirmation and save to the catalog filename', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  document.preset_bank.presets[0].values['sample.pattern-freq'] = 7.25;
  const hash = await encodeShaderStateHash({
    document, preset: document.preset_bank.presets[0].preset_id, bypassed: [], paused: false,
  });
  const harness = await editorWorkbench({ source: null, hash, patternCatalog: STUDY_PATTERN_CATALOG });
  let confirmations = 0;
  harness.win.confirm = () => { confirmations += 1; return false; };
  const source = harness.elements.get('shader-document-select');
  const before = source.value;
  source.value = '';
  await onChange(source)();
  assert.equal(confirmations, 1);
  assert.equal(source.value, before);
  harness.controller.save();
  assert.equal(harness.downloads.at(-1)[0], 'chain_study.shader.json');
});

test('imported documents have a named source and can switch directly to scratch', async () => {
  const harness = await editorWorkbench({ source: null });
  const input = harness.elements.get('shader-document-file');
  input.files = [{ name: 'study.shader.json', size: CHAIN_STUDY.length,
    text: async () => CHAIN_STUDY }];
  await onChange(input)();
  const source = harness.elements.get('shader-document-select');
  assert.equal(source.selectedOptions[0].textContent, 'Imported: study.shader.json');
  assert.equal(source.selectedOptions[0].disabled, true);
  assert.notEqual(source.value, '');
  source.value = '';
  await onChange(source)();
  assert.equal(source.value, '');
  assert.equal(source.selectedOptions[0].textContent, 'Scratch Chain');
  assert.equal(source.options.some((option) => option.value === '__loaded-document__'), false);
});

test('noncatalog shader links have their own source option', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  const hash = await encodeShaderStateHash({ document,
    preset: document.preset_bank.presets[0].preset_id, bypassed: [], paused: false });
  const harness = await editorWorkbench({ source: null, hash });
  const source = harness.elements.get('shader-document-select');
  assert.equal(source.selectedOptions[0].textContent, 'Linked: linked.shader.json');
  assert.equal(source.selectedOptions[0].disabled, true);
  assert.notEqual(source.value, '');
});
