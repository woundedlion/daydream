import { paramRow, SCRATCH, workbench, onChange, chooseCatalogSource, CHAIN_STUDY, KALEIDOSCOPE_STAINED_GLASS, STUDY_PATTERN_CATALOG, editorWorkbench, clickPlaneBandEntry, stripChips, sampleFrequencySlider } from "../helpers/shader_document_harness.js";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { decodeShaderStateHash, encodeShaderStateHash } from "../../src/workbench/shader/shader_deeplink.js";
import { SHADER_LINK_DEBOUNCE_MS, SHADER_LINK_MAX_WAIT_MS } from "../../src/workbench/shader/shader_documents.js";
import { ParamSetResult } from "../helpers/fake_engine.js";
import { STUDY_CHAIN } from "./fixture.js";

// The scratch source is a document like any other — returning to it
// reopens the default chain on the interpreter, rendering from the first frame.
test('returning to the scratch source reopens the default chain', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  const select = harness.elements.get('shader-document-select');
  select.value = '';

  await onChange(select)();

  assert.deepEqual(harness.selections, ['shader-chain', 'shader-chain', 'shader-chain']);
  const presets = harness.elements.get('shader-preset-select');
  assert.deepEqual(presets.options.map((option) => option.textContent),
    ['Catalog Defaults']);
  assert.equal(presets.disabled, false);
  assert.equal(harness.elements.get('shader-document-save').disabled, false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Scratch Chain · Catalog Defaults/);
});

// The workbench opens on a valid, rendering document with the whole
// authoring surface live — the scratch chain is edited exactly like a load.
test('the scratch document opens as a live, editable chain', async () => {
  const harness = await editorWorkbench({ source: null });

  assert.deepEqual(harness.selections, ['shader-chain']);
  assert.deepEqual(harness.engine.chainCalls.at(-1).map((entry) => entry.operator),
    SCRATCH.descriptor.chain.map((entry) => entry.operator));
  assert.deepEqual(stripChips(harness).map((chip) => chip.dataset.label),
    SCRATCH.descriptor.chain.map((entry) => entry.label));
  assert.deepEqual(
    harness.elements.get('shader-preset-select').options.map((o) => o.value),
    ['catalog-defaults']);
  assert.ok(harness.engine.writes.some(([name]) => name === 'colorize.palette-chroma'),
    'the opening preview carries the catalog defaults');

  clickPlaneBandEntry(harness, 'warp.affine.v4');

  assert.equal(harness.engine.chainCalls.at(-1).length, SCRATCH.descriptor.chain.length + 1);
});

// The load that replaces a document tears its editor down; a load the preview
// engine then refuses would otherwise leave the workbench with none.
test('an effect the engine rejects leaves the loaded chain editor standing', async () => {
  let installs = true;
  const harness = await editorWorkbench({ selectEffect: () => installs });
  const before = stripChips(harness).map((chip) => chip.dataset.label);
  assert.ok(before.length > 0, 'the fixture must open with an editor to keep');

  installs = false;
  assert.equal(
    await harness.controller.loadSource(CHAIN_STUDY, 'other.shader.json'), false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /rejected effect "ShaderChain"/);
  assert.deepEqual(stripChips(harness).map((chip) => chip.dataset.label), before,
    'the refused load must leave the editor it would have replaced');
});

// The toolbar names the link's document only once it has loaded: a link that
// decodes but is refused falls through to the scratch chain, and the select has
// to fall through with it.
test('a refused shader link leaves the source select on the scratch chain', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  const hash = await encodeShaderStateHash({
    document, preset: 'no-such-preset', bypassed: [], paused: false,
  });
  const harness = await editorWorkbench(
    { source: null, hash, patternCatalog: STUDY_PATTERN_CATALOG });

  assert.equal(harness.elements.get('shader-document-select').value, '');
  const message = harness.elements.get('shader-document-status').textContent;
  assert.match(message, /shader link could not be restored: .*no-such-preset/);
  assert.doesNotMatch(message, /\.\.$|Error: The/);
  await harness.controller.flushDeepLink();
  assert.equal(harness.win.location.hash, hash);
});

// The chain program is written last, so a refusal between the adoption and the
// program leaves the engine on the document that was already loaded; the
// toolbar has to keep naming that one.
test('a link whose bypass the store refuses leaves the toolbar on the loaded document', async () => {
  const harness = await editorWorkbench();
  const chips = stripChips(harness);
  const digest = harness.elements.get('shader-document-digest').dataset.digest;
  const presets = harness.elements.get('shader-preset-select').options.map((o) => o.value);
  const programs = harness.engine.chainCalls.length;

  const document = JSON.parse(CHAIN_STUDY);
  const copy = structuredClone(document.preset_bank.presets[0]);
  copy.preset_id = 'second';
  document.preset_bank.presets.push(copy);
  document.preset_bank.choreography.dwell.second =
    document.preset_bank.choreography.dwell[document.preset_bank.presets[0].preset_id];
  document.preset_bank.choreography.generated_order.push('second');

  assert.equal(await harness.controller.loadSource(document, 'other.shader.json', null,
    { preset: 'second', bypassed: ['nosuchstage'], paused: false }), false);

  assert.match(harness.elements.get('shader-document-status').textContent,
    /could not bypass "nosuchstage"/);
  assert.deepEqual(stripChips(harness), chips);
  assert.equal(harness.engine.chainCalls.length, programs,
    'the refused load must not reprogram the engine');
  assert.equal(harness.elements.get('shader-document-digest').dataset.digest, digest);
  assert.deepEqual(
    harness.elements.get('shader-preset-select').options.map((o) => o.value), presets,
    'the preset list must still be the loaded document, not the refused one');
  harness.controller.save();
  assert.equal(harness.downloads.at(-1)[0], 'study.shader.json',
    'Save must still write the document the engine is rendering');
});

// applyPreset is itself the program write: a refusal from inside it has already
// put the engine on the abandoned chain, so the previous program is written back.
test('a load whose preset the engine refuses puts the program back', async () => {
  const harness = await editorWorkbench();
  const chips = stripChips(harness);
  const digest = harness.elements.get('shader-document-digest').dataset.digest;
  const presets = harness.elements.get('shader-preset-select').options.map((o) => o.value);
  const program = harness.engine.chainCalls.at(-1);

  const write = harness.engine.bindings.setShaderChainParameters;
  let refuse = true;
  harness.engine.bindings.setShaderChainParameters = (writes) => {
    if (!refuse) return write(writes);
    refuse = false;
    return ParamSetResult.READONLY;
  };

  assert.equal(await harness.controller.loadSource(
    KALEIDOSCOPE_STAINED_GLASS, 'other.shader.json'), false);

  assert.match(harness.elements.get('shader-document-status').textContent,
    /could not be applied: .*READONLY/,
    'the status names the refusal the engine answered');
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'error');
  assert.deepEqual(stripChips(harness), chips);
  assert.deepEqual(harness.engine.chainCalls.at(-1), program,
    'the canvas must be back on the chain the toolbar names');
  assert.equal(harness.elements.get('shader-document-digest').dataset.digest, digest);
  assert.deepEqual(
    harness.elements.get('shader-preset-select').options.map((o) => o.value), presets);
});

test('a refused preset restores the preview and dropdown while preserving the refusal', async () => {
  const harness = await editorWorkbench();
  const select = harness.elements.get('shader-preset-select');
  const previous = select.value;
  const previousWrites = harness.engine.writes.slice();
  const write = harness.engine.bindings.setShaderChainParameters;
  let refused = false;
  harness.engine.bindings.setShaderChainParameters = (writes) => {
    if (refused) return write(writes);
    refused = true;
    return ParamSetResult.INADMISSIBLE;
  };
  select.value = select.options.find((option) => option.value !== previous).value;
  select.dispatch('change');
  assert.equal(select.value, previous);
  const restored = harness.engine.writes.slice(previousWrites.length);
  assert.ok(restored.length > 0, 'the previous preset must be applied again');
  const expected = new Map(previousWrites);
  for (const [id, value] of restored) assert.equal(value, expected.get(id), id);
  assert.ok(restored.some(([id]) => id === 'sample.pattern-freq'));
  assert.match(harness.elements.get('shader-document-status').textContent, /INADMISSIBLE/);
});

test('a shader state link restores its document, preset, bypasses, and pause', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  const preset = document.preset_bank.presets[1];
  preset.values['sample.pattern-freq'] = 7.25;
  const hash = await encodeShaderStateHash({
    document,
    preset: preset.preset_id,
    bypassed: ['camera'],
    paused: true,
  });

  const harness = await editorWorkbench({ source: null, hash });

  assert.equal(harness.elements.get('shader-preset-select').value, preset.preset_id);
  assert.equal(harness.animationsPaused(), true);
  assert.ok(harness.engine.writes.some(
    ([name, value]) => name === 'sample.pattern-freq' && value === 7.25));
  assert.deepEqual(harness.engine.chainCalls.at(-1).map((entry) => entry.instance),
    STUDY_CHAIN.map((entry) => entry.label).filter((label) => label !== 'camera'));
  assert.equal(stripChips(harness).find((chip) => chip.dataset.label === 'camera')
    .querySelector('.chain-chip-bypass').getAttribute('aria-pressed'), 'true');
});

test('a modulation bypass link is refused without adopting a stuck stage', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  const harness = await editorWorkbench();
  const chips = stripChips(harness);
  const programs = harness.engine.chainCalls.length;
  assert.equal(await harness.controller.loadSource(document, 'modulation.shader.json', null,
    {preset: document.preset_bank.presets[0].preset_id, bypassed: ['modulation'], paused: false}), false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /uses its modulation-enabled parameter/);
  assert.deepEqual(stripChips(harness), chips);
  assert.equal(harness.engine.chainCalls.length, programs);
});

test('a disabled modulation link restores a stage that its toggle can enable', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  const preset = document.preset_bank.presets[0];
  preset.values['modulation.modulation-enabled'] = 'disabled';
  const hash = await encodeShaderStateHash({document, preset: preset.preset_id,
    bypassed: [], paused: false});
  const harness = await editorWorkbench({source: null, hash});
  const chip = stripChips(harness).find((entry) => entry.dataset.label === 'modulation');
  assert.equal(chip.classList.contains('chain-chip--bypassed'), true);
  assert.equal(chip.querySelector('.chain-modulation-enabled').getAttribute('aria-pressed'), 'true');
  chip.querySelector('.chain-modulation-enabled').dispatch('click');
  await harness.controller.flushDeepLink();
  const restored = await decodeShaderStateHash(harness.win.location.hash);
  assert.equal(restored.document.preset_bank.presets[0].values['modulation.modulation-enabled'], 'enabled');
  assert.deepEqual(restored.bypassed, []);
  const enabled = stripChips(harness).find((entry) => entry.dataset.label === 'modulation');
  assert.equal(enabled.classList.contains('chain-chip--bypassed'), false);
  assert.equal(enabled.querySelector('.chain-modulation-enabled').getAttribute('aria-pressed'), 'false');
});

test('an oversized document clears the previous shader state hash', async () => {
  const harness = await editorWorkbench({ source: null });
  assert.match(harness.win.location.hash, /^#shader=/);
  const document = JSON.parse(CHAIN_STUDY);
  document.preset_bank.presets = Array.from({ length: 140 }, (_, index) => ({
    ...document.preset_bank.presets[0], preset_id: `large-${index}`, description: 'x'.repeat(4000),
  }));
  document.preset_bank.edges = [];
  document.preset_bank.choreography = {
    generated_order: document.preset_bank.presets.map((preset) => preset.preset_id),
  };
  assert.equal(await harness.controller.loadSource(JSON.stringify(document), 'large.shader.json'), true,
    harness.elements.get('shader-document-status').textContent);
  await harness.controller.flushDeepLink();
  assert.equal(harness.win.location.hash, '');
});

test('shader edits keep the full state hash current', async () => {
  const harness = await editorWorkbench({ source: null });
  clickPlaneBandEntry(harness, 'warp.affine.v4');
  stripChips(harness).find((chip) => chip.dataset.label === 'rotate')
    .querySelector('.chain-chip-bypass').dispatch('click');
  const value = paramRow(harness, 'sample', 'sample.pattern-freq')
    .querySelector('.chain-param-value');
  value.value = '3.5';
  value.dispatch('change');
  harness.elements.get('shader-animation-toggle').dispatch('click');
  await harness.controller.flushDeepLink();

  const state = await decodeShaderStateHash(harness.win.location.hash);
  assert.equal(state.document.descriptor.chain.length, SCRATCH.descriptor.chain.length + 1);
  assert.equal(state.preset, 'catalog-defaults');
  assert.deepEqual(state.bypassed, ['rotate']);
  assert.equal(state.paused, true);
  assert.equal(state.document.preset_bank.presets[0]
    .values['sample.pattern-freq'], 3.5);
});

// The chips carry the inline stage controls, and they render one preset's
// values.
test('a deep-linked preset builds the strip from the preset it renders', async () => {
  const document = JSON.parse(CHAIN_STUDY);
  document.preset_bank.presets[0].values['sample.pattern-freq'] = 1.5;
  const preset = document.preset_bank.presets[1];
  preset.values['sample.pattern-freq'] = 7.25;
  const hash = await encodeShaderStateHash({
    document, preset: preset.preset_id, bypassed: [], paused: false,
  });

  const harness = await editorWorkbench({ source: null, hash });

  assert.equal(sampleFrequencySlider(harness).value, '7.25');
  assert.equal(paramRow(harness, 'sample', 'sample.pattern-freq')
    .querySelector('.chain-param-value').value, '7.25');
});

test('continuous shader edits debounce link writes and keep the latest state', async () => {
  const harness = await editorWorkbench({ source: null });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    harness.urls.length = 0;
    const slider = sampleFrequencySlider(harness);
    for (const value of [2, 3, 4, 5]) {
      slider.value = String(value);
      slider.dispatch('input');
      harness.animationFrames.flush();
      const edited = harness.pausedReads();
      mock.timers.tick(50);
      assert.equal(harness.pausedReads(), edited, 'a write started before the debounce elapsed');
    }

    const reads = harness.pausedReads();
    mock.timers.tick(SHADER_LINK_DEBOUNCE_MS);
    assert.ok(harness.pausedReads() > reads, 'the debounce timer started the write');
    mock.timers.reset();
    await harness.controller.flushDeepLink();

    assert.equal(harness.urls.length, 1);
    const state = await decodeShaderStateHash(harness.win.location.hash);
    assert.equal(state.document.preset_bank.presets[0]
      .values['sample.pattern-freq'], 5);
  } finally {
    mock.timers.reset();
  }
});

test('continuous shader edits cannot postpone a link write indefinitely', async () => {
  const harness = await editorWorkbench({ source: null });
  let releaseEncode;
  const encodingGate = new Promise((resolve) => { releaseEncode = resolve; });
  let finishEncode;
  const encoded = new Promise((resolve) => { finishEncode = resolve; });
  const compression = mock.method(globalThis, 'CompressionStream', function () {
    const chunks = [];
    return new TransformStream({
      transform(chunk) { chunks.push(chunk); },
      async flush(controller) {
        await encodingGate;
        controller.enqueue(gzipSync(Buffer.concat(chunks)));
        finishEncode();
      },
    });
  });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    harness.urls.length = 0;
    const slider = sampleFrequencySlider(harness);
    const gap = SHADER_LINK_DEBOUNCE_MS - 1;
    const gaps = Math.floor((SHADER_LINK_MAX_WAIT_MS - 1) / gap);
    let reads;
    for (let index = 0; index <= gaps; index += 1) {
      slider.value = String(index + 2);
      slider.dispatch('input');
      harness.animationFrames.flush();
      reads = harness.pausedReads();
      if (index < gaps) {
        mock.timers.tick(gap);
        assert.equal(harness.pausedReads(), reads);
      }
    }
    mock.timers.tick(SHADER_LINK_MAX_WAIT_MS - gaps * gap);
    assert.ok(harness.pausedReads() > reads, 'the max-wait timer started the write');
    assert.equal(harness.urls.length, 0, 'the encoding is still in flight');

    slider.value = '9';
    slider.dispatch('input');
    harness.animationFrames.flush();
    releaseEncode();
    await encoded;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.urls.length, 1);
    const state = await decodeShaderStateHash(harness.win.location.hash);
    assert.equal(state.document.preset_bank.presets[0]
      .values['sample.pattern-freq'], gaps + 2);

    mock.timers.tick(SHADER_LINK_DEBOUNCE_MS);
    await harness.controller.flushDeepLink();
    assert.equal(harness.urls.length, 2);
    assert.equal((await decodeShaderStateHash(harness.win.location.hash))
      .document.preset_bank.presets[0].values['sample.pattern-freq'], 9);
  } finally {
    releaseEncode();
    compression.mock.restore();
    mock.timers.reset();
  }
});

test('ending a slider drag flushes its final link without waiting', async () => {
  const harness = await editorWorkbench({ source: null });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    harness.urls.length = 0;
    const slider = sampleFrequencySlider(harness);
    slider.value = '6.25';
    slider.dispatch('input');
    harness.animationFrames.flush();

    const reads = harness.pausedReads();
    slider.dispatch('change');
    assert.ok(harness.pausedReads() > reads, 'ending the drag started the write');
    await harness.controller.flushDeepLink();

    assert.equal(harness.urls.length, 1);
    const state = await decodeShaderStateHash(harness.win.location.hash);
    assert.equal(state.document.preset_bank.presets[0]
      .values['sample.pattern-freq'], 6.25);
  } finally {
    mock.timers.reset();
  }
});

for (const [action, title] of [['save', 'save'], ['saveAs', 'save as']]) {
  test(`${title} flushes the last slider input before its animation frame`, async () => {
    const harness = await editorWorkbench({ source: null });
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      harness.urls.length = 0;
      const slider = sampleFrequencySlider(harness);
      slider.value = '7.5';
      slider.dispatch('input');

      assert.equal(await harness.controller[action](), true);
      assert.equal(JSON.parse(harness.downloads.at(-1)[1]).preset_bank.presets[0]
        .values['sample.pattern-freq'], 7.5);
      await harness.controller.flushDeepLink();

      assert.equal(harness.urls.length, 1);
      const state = await decodeShaderStateHash(harness.win.location.hash);
      assert.equal(state.document.preset_bank.presets[0]
        .values['sample.pattern-freq'], 7.5);
    } finally {
      mock.timers.reset();
    }
  });
}

test('a malformed shader state link falls back to an editable scratch chain', async () => {
  const harness = await editorWorkbench({
    source: null, hash: '#shader=v2.not-gzip',
  });

  assert.deepEqual(harness.engine.chainCalls.at(-1).map((entry) => entry.operator),
    SCRATCH.descriptor.chain.map((entry) => entry.operator));
  assert.match(harness.elements.get('shader-document-status').textContent,
    /shader link could not be restored: Error: invalid shader link payload/i);
});
