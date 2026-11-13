import {
  singlePatternCatalog, paramRow, primaryName, ownedEditors, INDEX, WORKBENCH, ENGINE_CATALOG,
  SCRATCH, plainName, MODULE,
  fixedEngine, promotedDocument, PROMOTED, PATTERN_CATALOG, shaderDocument, workbenchEngine,
  patternFetch, workbench, onChange, SCRATCH_WRITES, chooseCatalogSource,
  withoutEmbeddedModulation, CHAIN_STUDY, KALEIDOSCOPE_STAINED_GLASS,
  STUDY_PATTERN_CATALOG, compiledBuildEngine, editorWorkbench, clickPlaneBandEntry, stripChips,
  displayedParameter, sampleFrequencySlider, expectStageAbsent, stageEditor, savedValues,
  affineLatticeStudy,
} from './helpers/shader_document_harness.js';
import { canonicalEffectId } from '../src/effects/effect_identity.js';
import {
  BAKED_CONSTANT_IDS, engineControlNames, compileShaderDocument, DEFAULT_LIMITS,
  exportShaderDocumentJson, validateShaderDocument,
} from '../generated/shader/shader_workbench.mjs';
import {mock, test} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import { shaderWorkbenchUrl, start } from '../src/app/daydream.js';
import { WORKBENCH_EFFECTS } from '../src/effects/effect_roster.js';
import { applyChainDocument } from '../src/workbench/shader/chain_apply.js';
import { callWorkbenchBinding } from '../src/engine/workbench_bindings.js';
import { scratchChainDocument } from '../src/workbench/shader/chain_document_store.js';
import {
  CHAIN_SNAPSHOT_SCHEMA_VERSION, decodeShaderStateHash, encodeShaderStateHash,
} from '../src/workbench/shader/shader_deeplink.js';
import {createShaderDocumentController, SHADER_LINK_DEBOUNCE_MS, SHADER_LINK_MAX_WAIT_MS} from '../src/workbench/shader/shader_documents.js';
import {
  FakeChainEngine, ParamSetResult, ChainSnapshotRestoreResult, unpinnedEngineMethods,
} from './helpers/fake_engine.js';
import {fakeElement} from './helpers/fake_dom.js';
import {
  BAKED_MODULATION_SCALE_MAX, MODULATION_OPERATOR, PALETTE_OPERATOR, UNIT_MODULATION_AMOUNT_MAX,
} from '../src/workbench/shader/chain_presentation.js';

const STUDY_CHAIN = JSON.parse(CHAIN_STUDY).descriptor.chain;

/** @param {string} operator @param {string} param @param {string} option @returns {number} */
const optionIndex = (operator, param, option) => JSON.parse(ENGINE_CATALOG).operators
  .find((entry) => entry.id === operator).params.find((entry) => entry.id === param)
  .values.indexOf(option);

test('simulator exposes Shader as a standalone tool', () => {
  assert.match(INDEX, /href="tools\/shader\.html"[^>]*>Shader/);
  assert.match(WORKBENCH, /data-daydream-mode="shader-workbench"/);
  assert.match(WORKBENCH, /src="\.\.\/src\/app\/main\.js"/);
  assert.match(WORKBENCH, /id="chain-strip"/);
  assert.doesNotMatch(WORKBENCH, /id="chain-library"/);
  assert.match(WORKBENCH, /id="gui-container"/);
  assert.match(WORKBENCH, /id="shader-document-select"/);
  assert.match(WORKBENCH, /id="shader-preset-select"/);
  assert.match(WORKBENCH, /id="shader-document-open"/);
  assert.match(WORKBENCH, /id="shader-document-save"/);
  assert.match(WORKBENCH, /id="shader-document-save-as"/);
  assert.match(WORKBENCH, /id="shader-parity-toggle"/);
  assert.match(WORKBENCH, /id="shader-animation-toggle"/);
  assert.match(WORKBENCH, /id="shader-document-digest"/);
});

// The alias table serves effects promoted before the chain schema: a document
// parameter id is <label>.<field>, and the label picks the family whose
// registered control names the field maps onto.
test('document parameter IDs map to their aliased promoted controls', () => {
  assert.equal(primaryName('sample.pattern-freq'), 'Pattern Freq');
  assert.equal(primaryName('sample.angle-speed'), 'Source Angle Speed');
  assert.equal(primaryName('warp1.cell-x'), 'Planar Warp 1 Cell X');
  assert.equal(primaryName('warp2.speed'), 'Planar Warp 2 Speed');
  assert.equal(primaryName('camera.wander'), 'Camera Wander');
  assert.equal(primaryName('surface.scale'), 'Surface Noise Scale');
  assert.equal(primaryName('colorize.value-opacity-low'), 'Opacity at Value 0');
  assert.equal(primaryName('colorize.value-opacity-high'), 'Opacity at Value 1');
});

// A label outside the alias set maps to the plain Title Case of its field, so
// a newly promoted document needs no table entry to land on its controls.
test('labels outside the alias table need no entry', () => {
  assert.equal(primaryName('project.pole-fade'), 'Pole Fade');
  assert.equal(primaryName('lens.mobius-a-re'), 'Mobius A Re');
  assert.equal(primaryName('transfer.iso-level'), 'Iso Level');
  assert.equal(primaryName('colorize.palette-mapping'), 'Palette Mapping');
  assert.equal(primaryName('halo.glow-strength'), 'Glow Strength');
  assert.equal(primaryName('no-dot-id'), 'No Dot Id');
});

// Across every shipped pattern document, the labels whose mapping differs from
// the plain field spelling stay within this frozen set.
test('the alias table keys never grow', () => {
  const patternCatalog = JSON.parse(readFileSync(
    new URL('../generated/shader/patterns/catalog.json', import.meta.url), 'utf8'));
  const aliased = new Set();
  for (const filename of Object.values(patternCatalog.source_documents)) {
    const doc = JSON.parse(readFileSync(
      new URL(`../generated/shader/patterns/${filename}`, import.meta.url), 'utf8'));
    for (const preset of doc.preset_bank.presets) {
      for (const id of Object.keys(preset.values ?? {})) {
        const dot = id.indexOf('.');
        if (primaryName(id) !== plainName(id.slice(dot + 1)))
          aliased.add(id.slice(0, dot));
      }
    }
  }
  const frozen = new Set(['camera', 'colorize', 'sample', 'surface', 'warp1', 'warp2']);
  assert.ok(aliased.size > 0, 'the shipped patterns still exercise the alias table');
  for (const label of aliased) assert.ok(frozen.has(label), `"${label}" joined the alias table`);
});

for (const operation of ['selectEffect', 'setShaderChainParameters', 'stage edit']) {
  test(`a halted ${operation} reports failure and blocks later engine calls`, async (t) => {
    t.after(() => { delete MODULE.HS_MODULE_DEAD; });
    let calls = 0;
    const halt = () => {
      calls += 1;
      MODULE.HS_MODULE_DEAD = true;
      throw new Error('engine halted during edit');
    };
    let shouldHalt = false;
    const harness = await editorWorkbench({
      selectEffect: () => shouldHalt ? halt() : true,
    });
    if (operation === 'selectEffect') shouldHalt = true;
    if (operation === 'setShaderChainParameters')
      harness.engine.bindings.setShaderChainParameters = halt;
    if (operation === 'stage edit') {
      harness.engine.setParameter = halt;
      stageEditor(harness, 'sample')('sample.pattern-freq', 7);
    } else {
      assert.equal(await harness.controller.loadSource(
        KALEIDOSCOPE_STAINED_GLASS, 'other.shader.json'), false);
    }
    assert.equal(MODULE.HS_MODULE_DEAD, true);
    assert.equal(calls, 1);
    assert.match(harness.elements.get('shader-document-status').textContent, /engine halted/);
    const selections = harness.selections.length;
    const chainCalls = harness.engine.chainCalls.length;
    assert.equal(await harness.controller.loadSource(
      KALEIDOSCOPE_STAINED_GLASS, 'later.shader.json'), false);
    assert.equal(calls, 1);
    assert.equal(harness.selections.length, selections, 'the later load selected no effect');
    assert.equal(harness.engine.chainCalls.length, chainCalls, 'the later load wrote no chain');
  });
}

test('the shader-document engine fakes mock nothing outside the engine surface', () => {
  for (const [name, double] of [
    ['fixedEngine', fixedEngine(() => true)],
    ['workbenchEngine', workbenchEngine()],
    ['compiledBuildEngine', compiledBuildEngine()],
  ]) {
    assert.deepEqual(unpinnedEngineMethods(double), [], name);
    double.obsoleteEngineMethod = () => {};
    const bindings = double.getShaderChainBindings?.() ?? {};
    double.getShaderChainBindings = () => ({...bindings, obsoleteBindingMethod() {}});
    assert.deepEqual(unpinnedEngineMethods(double),
      ['ShaderChainBindings.obsoleteBindingMethod', 'obsoleteEngineMethod'], name);
  }
});

// A stale exemption would silently cover an id that has since become
// registrable, so it only holds while a promoted document still carries it.
test('every baked-constant exemption is still carried by a promoted document', () => {
  const carried = new Set();
  for (const filename of Object.values(PROMOTED)) {
    for (const preset of promotedDocument(String(filename)).preset_bank.presets)
      for (const id of Object.keys(preset.values)) carried.add(id);
  }

  assert.ok(carried.size > 0);
  for (const id of BAKED_CONSTANT_IDS)
    assert.ok(carried.has(id), `no promoted document carries "${id}"`);
});

test('a page missing the document controls builds no controller', () => {
  assert.equal(createShaderDocumentController({
    doc: { getElementById: () => null, createElement: () => fakeElement('div') },
    getEngine: () => null,
    getModule: () => null,
    selectEffect: () => true,
    syncEffectGui: () => {},
    invalidate: () => {},
  }), null);
});

test('the source catalog lists each document by its product display name', async () => {
  const { controller, elements } = workbench();

  assert.equal(await controller.init(), true);
  const select = elements.get('shader-document-select');
  assert.deepEqual(select.options.map((option) => option.value), ['', 'KaleidoscopeFlowers']);
  assert.deepEqual(select.options.map((option) => option.textContent),
    ['Scratch Chain', 'Kaleidoscope Flowers']);
  const status = elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'ok');
  assert.match(status.textContent, /Scratch Chain · Catalog Defaults/,
    'the page opens rendering the scratch chain');
});

test('catalog requests revalidate cached catalogs and source documents', async (t) => {
  const read = patternFetch({ 'kaleidoscope_flowers.shader.json': shaderDocument() });
  const staleCatalog = JSON.parse(PATTERN_CATALOG);
  staleCatalog.source_documents.KaleidoscopeFlowers = 'removed.shader.json';
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url.pathname.split('/generated/')[1], options?.cache]);
    if (url.pathname.endsWith('/patterns/catalog.json') && options?.cache !== 'no-cache')
      return new Response(JSON.stringify(staleCatalog));
    return new Response(await read(url.href));
  });
  const { controller, elements } = workbench({ useDefaultFetch: true });

  assert.equal(await controller.init(), true);
  assert.deepEqual(requests, [
    ['shader/engine_catalog.json', 'no-cache'],
    ['shader/patterns/catalog.json', 'no-cache'],
    ['shader/patterns/kaleidoscope_flowers.shader.json', 'no-cache'],
  ]);
  assert.equal(elements.get('shader-document-select').options.length, 2);
});

test('a failed catalog request identifies its asset path', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const { controller, elements } = workbench({ useDefaultFetch: true });

  assert.equal(await controller.init(), false);
  assert.match(elements.get('shader-document-error').textContent,
    /Source catalog failed to load: Error: 404 .*\(.*\/generated\/shader\/engine_catalog\.json\)/);
});

test('a catalog document that fails to compile reports its diagnostic', async () => {
  const { controller, elements } = workbench({ files: {
    'kaleidoscope_flowers.shader.json': shaderDocument({
      status: 'INVALID',
      diagnostics: [{ code: 'E_ROLE', path: '/descriptor', message: 'unknown role' }],
    }),
  } });

  assert.equal(await controller.init(), false);
  const status = elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.equal(elements.get('shader-document-error').textContent, status.textContent);
  assert.equal(elements.get('shader-document-notice').textContent, '');
  assert.match(status.textContent, /E_ROLE at \/descriptor: unknown role/);
  assert.equal(elements.get('shader-document-select').options.length, 1);
});

test('a catalog that cannot be fetched is reported, not left half-listed', async () => {
  const { controller, elements } = workbench({ files: {} });

  assert.equal(await controller.init(), false);
  assert.match(elements.get('shader-document-status').textContent,
    /Source catalog failed to load: Error: 404/);
  assert.equal(elements.get('shader-document-select').options.length, 1);
});

// The simulator redirects a shader-document deep link here, so the id it
// carries has to open that document rather than the scratch chain.
test('a deep-linked document id opens that document', async () => {
  const harness = workbench({ initialEffect: 'KaleidoscopeFlowers' });

  assert.equal(await harness.controller.init(), true);

  assert.equal(harness.elements.get('shader-document-select').value, 'KaleidoscopeFlowers');
  assert.deepEqual(harness.engine.chained.at(-1),
    [{ instance: 'sample', operator: 'sample.grid.v4' }]);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Kaleidoscope Flowers · Noon/);
});

// The scratch route names no document, and neither does a
// stale id, so both open the scratch chain.
test('a deep link naming no catalog document opens the scratch chain', async () => {
  for (const initialEffect of ['shader-chain', 'retired-pattern', null]) {
    const harness = workbench({ initialEffect });

    assert.equal(await harness.controller.init(), true);

    assert.equal(harness.elements.get('shader-document-select').value, '');
    assert.match(harness.elements.get('shader-document-status').textContent,
      /Scratch Chain · Catalog Defaults/);
  }
});

// A shipped pattern previews through
// the interpreter exactly as a scratch chain does; the digest match only arms
// the parity toggle to the promoted build.
test('choosing a catalog source previews it through the interpreter', async () => {
  const harness = workbench();

  await chooseCatalogSource(harness);

  assert.deepEqual(harness.selections, [canonicalEffectId('shader-chain'), canonicalEffectId('shader-chain')]);
  assert.deepEqual(harness.engine.selected, [],
    'no fixed-effect reference preset is staged for an interpreted load');
  assert.deepEqual(harness.engine.chained.at(-1),
    [{ instance: 'sample', operator: 'sample.grid.v4' }]);
  assert.deepEqual(harness.engine.writes.slice(SCRATCH_WRITES),
    [['sample.pattern-freq', 2]]);
  const presets = harness.elements.get('shader-preset-select');
  assert.deepEqual(presets.options.map((option) => option.value), ['noon', 'dusk']);
  assert.equal(presets.disabled, false);
  assert.equal(harness.elements.get('shader-document-save').disabled, false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Kaleidoscope Flowers · Noon · interpreter/);
  assert.equal(harness.elements.get('shader-parity-toggle').disabled, false,
    'the digest match arms the toggle');
  assert.deepEqual(harness.ran, { gui: 2, invalidated: 2 });
});

test('the parity toggle swaps the preview onto the compiled build and back', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  const toggle = harness.elements.get('shader-parity-toggle');

  toggle.dispatch('click');

  assert.equal(harness.selections.at(-1), 'KaleidoscopeFlowers');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(harness.engine.selected, ['noon']);
  assert.deepEqual(harness.engine.writes.at(-1), ['Pattern Freq', 2],
    'the compiled build takes the preset through the promoted control names');
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Kaleidoscope Flowers · Noon · compiled build/);

  toggle.dispatch('click');

  assert.equal(harness.selections.at(-1), 'shader-chain');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(harness.engine.writes.at(-1), ['sample.pattern-freq', 2]);
});

test('a refused parity preset restores the interpreter and preserves the refusal', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  harness.engine.selectPresetById = () => false;
  const toggle = harness.elements.get('shader-parity-toggle');

  toggle.dispatch('click');

  assert.deepEqual(harness.selections.slice(-2), ['KaleidoscopeFlowers', 'shader-chain']);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(harness.engine.writes.at(-1), ['sample.pattern-freq', 2]);
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'error');
  assert.match(harness.elements.get('shader-document-status').textContent,
    /refused reference preset "noon"/);
});

test('a parity trap updates the preview status and disables animation', async (t) => {
  t.after(() => { delete MODULE.HS_MODULE_DEAD; });
  const harness = workbench({
    getAnimationsPaused: () => false,
    selectEffect: (effect) => {
      if (effect === 'KaleidoscopeFlowers') {
        MODULE.HS_MODULE_DEAD = true;
        throw new Error('engine halted during parity switch');
      }
      return true;
    },
  });
  await chooseCatalogSource(harness);
  const animation = harness.elements.get('shader-animation-toggle');
  assert.equal(animation.disabled, false);

  harness.elements.get('shader-parity-toggle').dispatch('click');

  assert.equal(animation.disabled, true);
  const status = harness.elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /The preview edit failed: .*engine halted during parity switch/);
});

test('an imported study the catalog does not carry has no parity build', async () => {
  const harness = workbench();
  await harness.controller.init();

  assert.equal(await harness.controller.loadSource(
    shaderDocument({ digest: 'digest-study' }), 'study.shader.json'), true);
  assert.deepEqual(harness.selections, [canonicalEffectId('shader-chain'), canonicalEffectId('shader-chain')]);
  assert.deepEqual(harness.engine.selected, [],
    'the dynamic path stages no fixed-effect reference preset');
  assert.deepEqual(harness.engine.chained.at(-1),
    [{ instance: 'sample', operator: 'sample.grid.v4' }]);
  assert.deepEqual(harness.engine.writes.slice(SCRATCH_WRITES),
    [['sample.pattern-freq', 2]],
    'the preset lands by parameter id, not by alias name');
  const status = harness.elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'ok');
  assert.equal(status.textContent, 'Kaleidoscope Flowers · Noon');
  assert.equal(harness.elements.get('shader-parity-toggle').disabled, true);
  assert.equal(harness.elements.get('shader-document-save').disabled, false);
  assert.deepEqual(harness.ran, { gui: 2, invalidated: 2 });
});

test('overlapping loads are serialized in request order', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let imports = 0;
  const harness = workbench({ wrapImportCompiler: (importer) => async () => {
    if (++imports === 1) await gate;
    return importer();
  } });
  const second = JSON.parse(shaderDocument({ digest: 'digest-second' }));
  second.document.preset_bank.presets[0].values['sample.pattern-freq'] = 9;

  const firstLoad = harness.controller.loadSource(
    shaderDocument({ digest: 'digest-first' }), 'first.shader.json');
  const secondLoad = harness.controller.loadSource(
    JSON.stringify(second), 'second.shader.json');
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await Promise.all([firstLoad, secondLoad]), [true, true]);
  assert.equal(imports, 1);

  assert.deepEqual(harness.engine.writes.at(-1), ['sample.pattern-freq', 9]);
  assert.equal(harness.controller.save(), true);
  assert.equal(harness.downloads.at(-1)[0], 'second.shader.json');
});

test('a setShaderChain refusal is surfaced with its code', async () => {
  const engine = workbenchEngine();
  const harness = workbench({ engine });
  assert.equal(await harness.controller.init(), true);
  const initialWrites = harness.engine.writes.length;
  const status = harness.elements.get('shader-document-status');
  assert.doesNotMatch(status.textContent, /ARENA_OVERFLOW/);
  engine.bindings.setShaderChain = (entries) => {
    engine.chained.push(entries);
    return { code: 'ARENA_OVERFLOW', entryIndex: -1 };
  };

  assert.equal(await harness.controller.loadSource(
    shaderDocument({ digest: 'digest-study' }), 'study.shader.json'), false);
  assert.deepEqual(harness.engine.writes.slice(initialWrites), []);
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /ARENA_OVERFLOW/);
});

test('choosing a preset previews it without reloading the document', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  const presets = harness.elements.get('shader-preset-select');
  presets.value = 'dusk';

  onChange(presets)();

  assert.deepEqual(harness.engine.selected, []);
  assert.deepEqual(harness.engine.writes.at(-1), ['sample.pattern-freq', 5]);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Kaleidoscope Flowers · Dusk/);
});

test('a preview with no engine names the engine rather than the preset', async () => {
  const harness = workbench({ engine: null });
  await harness.controller.init();

  assert.equal(harness.controller.applyPreset('noon'), false);
  const status = harness.elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.equal(status.textContent, 'The preview engine is not ready.');
});

test('an effect the preview engine rejects leaves the export disabled', async () => {
  const harness = workbench({ selectEffect: () => false });
  await harness.controller.init();

  assert.equal(await harness.controller.loadSource(shaderDocument()), false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /rejected effect "ShaderChain"/);
  assert.equal(harness.elements.get('shader-document-save').disabled, true);
  assert.equal(harness.controller.save(), false);
});

// Invalid semantics leave the current preview untouched, so a compiler that
// throws on the input must not take the loaded document down either.
test('a compile that throws is reported and leaves the loaded document previewing', async () => {
  const harness = workbench();
  await harness.controller.init();
  assert.equal(await harness.controller.loadSource(
    shaderDocument({ digest: 'digest-study' }), 'study.shader.json'), true);
  const installs = harness.selections.length;

  assert.equal(
    await harness.controller.loadSource('{ not json', 'broken.shader.json'), false);
  const status = harness.elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /could not be compiled/);
  assert.equal(harness.selections.length, installs,
    'a refused load must not reinstall the preview effect');
  assert.equal(harness.elements.get('shader-document-save').disabled, false,
    'the loaded document is still the one Save writes');
});

// Every edit is a document edit, so Save serializes the document
// rather than capturing state only the engine holds.
test('saving exports the document, harvesting nothing from the engine', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  harness.engine.definitions.find((d) => d.name === 'Pattern Freq').value = 9;
  harness.engine.getParameterDefinitions = () => {
    throw new Error('Save must not read the engine');
  };

  assert.equal(harness.controller.save(), true);
  const [filename, source] = harness.downloads[0];
  assert.equal(filename, 'kaleidoscope_flowers.shader.json');
  const saved = JSON.parse(source);
  assert.equal(saved.preset_bank.presets[0].values['sample.pattern-freq'], 2);
  assert.equal(saved.preset_bank.presets[1].values['sample.pattern-freq'], 5,
    'the presets the session never previewed must survive the round trip');
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Saved kaleidoscope_flowers\.shader\.json/);
});

// An effect the controller selects but the roster omits survives the load and
// is dropped on the next reload or resolution change.
test('the workbench roster admits every effect the controller selects', async () => {
  const harness = workbench({
    patternCatalog: PATTERN_CATALOG.replaceAll('KaleidoscopeFlowers', 'kaleidoscope-flowers'),
  });
  await harness.controller.init();
  await harness.controller.loadSource(
    shaderDocument({ digest: 'digest-study' }), 'study.shader.json');
  const select = harness.elements.get('shader-document-select');
  select.value = '';
  await onChange(select)();

  select.value = 'kaleidoscope-flowers';
  await onChange(select)();
  harness.elements.get('shader-parity-toggle').dispatch('click');
  assert.deepEqual(harness.selections, [
    'shader-chain', 'shader-chain', 'shader-chain', 'shader-chain', 'kaleidoscope-flowers',
  ]);
  for (const effect of harness.selections) {
    assert.ok(WORKBENCH_EFFECTS.map(canonicalEffectId).includes(effect),
      `the workbench page must know the effect "${effect}"`);
  }
});

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
  assert.match(harness.elements.get('shader-document-status').textContent,
    /shader link could not be restored/);
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

  // Save exports the store's edited document, not the load-time compile.
  assert.equal(harness.controller.save(), true);
  const saved = JSON.parse(harness.downloads[0][1]);
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

// A descriptor edit breaks the match with the promoted
// build and disarms the toggle. A bypass is a program-shape override and a chip
// control edit of a declared parameter writes a preset value; neither changes the descriptor digest.
test('the parity toggle disarms on a descriptor edit, not on a bypass', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  const toggle = harness.elements.get('shader-parity-toggle');
  assert.equal(toggle.disabled, false, 'the loaded digest matches a promoted effect');
  assert.deepEqual(harness.selections, [canonicalEffectId('shader-chain'), canonicalEffectId('shader-chain')],
    'a shipped pattern still previews through the interpreter');

  stripChips(harness).find((chip) => chip.dataset.label === 'lens')
    .querySelector('.chain-chip-bypass').dispatch('click');
  assert.equal(toggle.disabled, false);

  stageEditor(harness, 'sample')('sample.pattern-freq', 7);
  assert.equal(toggle.disabled, false);

  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(toggle.disabled, true);
});

test('compiled stage edits reach stages bypassed in the interpreter', async () => {
  const harness = await editorWorkbench({ patternCatalog: STUDY_PATTERN_CATALOG });
  stripChips(harness).find((chip) => chip.dataset.label === 'warp2')
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
  assert.deepEqual(harness.compiledEngine.writes, [
    ['whorl.Twist Angle (rad)', 7.25], ['whorl.Twist Distribution', 0.625],
    ['whorl.Speed', 0.035], ['whorl.Drift', 0.006],
  ]);
  assert.equal(savedValues(harness)['whorl.twist-angle'], 7.25);
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
  assert.match(harness.elements.get('shader-document-status').textContent, /compiled build/);
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
  const control = () => stripChips(harness).find((chip) => chip.dataset.label === 'modulation')
    .querySelectorAll('.chain-param').find((row) => row.dataset.parameter === parameterId)
    .querySelector('.chain-param-control');
  assert.equal(control().disabled, false);

  const write = engine.setParameter;
  engine.setParameter = (...args) => {
    readonly = true;
    return write(...args);
  };
  const edit = stageEditor(harness, 'sample');
  const before = reads;
  edit('sample.pattern-freq', 2.5);

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

test('a chain snapshot restores its program and accepted parameters into the editor', async () => {
  const engine = new FakeChainEngine();
  engine.setEffect('shader-chain');
  engine.setParameter('sample.pattern-freq', 2.25);
  engine.setAnimationsPaused(true);
  const bindings = engine.getShaderChainBindings();
  const snapshot = bindings.getSnapshot();
  bindings.delete();
  const harness = await editorWorkbench({source: null, pausedFromEngine: true,
    search: `?effect=ShaderChain&fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}`});
  assert.equal(harness.elements.get('shader-animation-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(harness.animationWrites.at(-1), true);
  const restored = harness.engine.getShaderChainBindings();
  assert.deepEqual(restored.getProgram(), snapshot.chain);
  assert.equal(harness.engine.getParameterDefinitions().find((entry) => entry.name === 'sample.pattern-freq').acceptedValue, 2.25);
  restored.delete();
  const linked = await decodeShaderStateHash(harness.win.location.hash);
  assert.deepEqual(JSON.parse(JSON.stringify(linked.chainSnapshot)), snapshot);
  assert.equal(linked.paused, snapshot.animationsPaused);
  assert.equal(harness.controller.preservesOriginalLink(), false);
});

for (const route of ['link', 'query']) {
  test(`schema ${CHAIN_SNAPSHOT_SCHEMA_VERSION} ${route} Twist snapshots restore total angles and runtime`, async () => {
    const catalog = JSON.parse(ENGINE_CATALOG);
    const twist = catalog.operators.find((operator) => operator.id === 'sphere.lens.twist.v2');
    const document = scratchChainDocument(catalog, [
      {label: 'lens', operator: twist.id}, ...SCRATCH.descriptor.chain,
    ]);
    const distribution = Math.fround(0.7);
    const angle = -9;
    Object.assign(document.preset_bank.presets[0].values,
      {'lens.twist-angle': angle, 'lens.twist-distribution': distribution});
    const engine = new FakeChainEngine();
    engine.catalog = catalog;
    engine.setEffect('shader-chain');
    const compiled = compileShaderDocument(document, {catalog});
    assert.equal(compiled.status, 'VALID');
    assert.equal(applyChainDocument({engine, module: MODULE, compiled, presetId: 'catalog-defaults',
      syncEffectGui() {}, invalidate() {}}), null);
    const snapshot = callWorkbenchBinding(engine, 'getSnapshot', []);
    snapshot.schemaVersion = CHAIN_SNAPSHOT_SCHEMA_VERSION;
    Object.assign(snapshot.runtime.find(({instance}) => instance === 'lens').state,
      {primary: 0.375, secondary: -0.625, angle: 1.25});
    snapshot.animationsPaused = true;
    const before = structuredClone(snapshot);
    const payload = gzipSync(JSON.stringify({d: document, p: 'catalog-defaults', b: [], a: true, s: snapshot})).toString('base64url');
    const hash = route === 'link' ? `#shader=v2.${payload}` : '';
    const search = route === 'query' ? `?fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}`
      : '?effect=ShaderChain';
    const harness = await editorWorkbench({source: null, hash, search,
      engineCatalog: JSON.stringify(catalog), pausedFromEngine: true});
    assert.equal(harness.controller.preservesOriginalLink(), false,
      harness.elements.get('shader-document-status').textContent);
    const restored = callWorkbenchBinding(harness.engine, 'getSnapshot', []);
    assert.equal(restored.parameters.find(({name}) => name === 'lens.twist-angle')?.value, angle);
    assert.deepEqual(restored.runtime, snapshot.runtime);
    assert.deepEqual(restored.paletteBank, snapshot.paletteBank);
    assert.equal(restored.animationsPaused, true);
    assert.equal(savedValues(harness)['lens.twist-angle'], angle);
    assert.deepEqual(snapshot, before);
  });
}

test('a refused chain snapshot rolls the engine back and keeps the link', async () => {
  const engine = new FakeChainEngine();
  engine.setEffect('shader-chain');
  const snapshot = { ...engine.getShaderChainBindings().getSnapshot(), runtime: [] };
  const restores = [];
  const harness = await editorWorkbench({ source: null,
    search: `?effect=ShaderChain&fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}`,
    prepare: (target) => {
      target.setEffect('shader-chain');
      target.setParameter('sample.pattern-freq', 2.25);
      const bindings = target.getShaderChainBindings.bind(target);
      target.getShaderChainBindings = () => {
        const live = bindings();
        if (!live) return live;
        const restore = live.restoreSnapshot;
        live.restoreSnapshot = (value) => {
          const outcome = restore(value);
          restores.push({ value: structuredClone(value), outcome });
          return outcome;
        };
        return live;
      };
    } });
  assert.deepEqual(restores.map(({ outcome }) => outcome),
    [ChainSnapshotRestoreResult.INVALID_VALUE, ChainSnapshotRestoreResult.APPLIED]);
  assert.deepEqual(restores[0].value, snapshot);
  assert.equal(restores[1].value.parameters.find(({ name }) => name === 'sample.pattern-freq').value, 2.25,
    'the rollback restores the engine state from before the import');
  assert.equal(harness.controller.preservesOriginalLink(), true);
  assert.match(harness.elements.get('shader-document-status').textContent, /imported chain snapshot was rejected/);
});

test('a chain snapshot naming an unknown parameter is refused before adoption', async () => {
  const engine = new FakeChainEngine();
  engine.setEffect('shader-chain');
  const snapshot = engine.getShaderChainBindings().getSnapshot();
  snapshot.parameters = [...snapshot.parameters, { name: 'missing.parameter', value: 0 }];
  const harness = await editorWorkbench({ source: null,
    search: `?effect=ShaderChain&fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}` });
  assert.equal(harness.controller.preservesOriginalLink(), true);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /unknown chain snapshot parameter: missing\.parameter/);
});

test('a linked runtime snapshot that disagrees with its document retains the original link', async () => {
  const seed = await editorWorkbench({source: null});
  const state = await decodeShaderStateHash(seed.win.location.hash);
  state.chainSnapshot.parameters[0].value += 1;
  state.paused = true;
  state.chainSnapshot.animationsPaused = true;
  const hash = await encodeShaderStateHash(state);
  const harness = await editorWorkbench({source: null, hash});
  assert.equal(harness.controller.preservesOriginalLink(), true);
  assert.equal(harness.win.location.hash, hash);
  assert.match(harness.elements.get('shader-document-status').textContent, /does not match/);
  assert.equal(harness.animationsPaused(), false, 'a refused link preserves the fallback pause state');
  await harness.controller.dispose();
  ownedEditors.delete(harness.controller);
  assert.equal(harness.win.location.hash, hash);
});

test('a linked modulation recipe must match its document before restoration', async () => {
  const seed = await editorWorkbench();
  const original = await decodeShaderStateHash(seed.win.location.hash);
  assert.ok(original.chainSnapshot.modulation.length > 0);
  for (const change of [
    (recipe) => { recipe.mechanic.amount += 0.25; },
    (recipe) => { recipe.sine.offset += 0.25; },
    (recipe) => { recipe.noise = null; },
  ]) {
    const state = structuredClone(original);
    change(state.chainSnapshot.modulation[0].recipe);
    const hash = await encodeShaderStateHash(state);
    const harness = await editorWorkbench({source: null, hash});
    assert.equal(harness.controller.preservesOriginalLink(), true);
    assert.equal(harness.win.location.hash, hash);
    assert.match(harness.elements.get('shader-document-status').textContent, /does not match/);
  }
  const rounded = structuredClone(original);
  const recipe = rounded.chainSnapshot.modulation[0].recipe;
  recipe.noise.scale += 1e-8;
  rounded.chainSnapshot.modulation[0].recipe = Object.fromEntries(Object.entries(recipe).reverse());
  const harness = await editorWorkbench({source: null, hash: await encodeShaderStateHash(rounded)});
  assert.equal(harness.controller.preservesOriginalLink(), false);
  assert.doesNotMatch(harness.elements.get('shader-document-status').textContent, /does not match/);
});

test('abandoning a refused link reports its release once', async () => {
  let releases = 0;
  const harness = await editorWorkbench({ source: null,
    search: '?effect=ShaderChain&fx.__chainSnapshot=%7Bbroken',
    onOriginalLinkReleased: () => { releases++; },
  });
  assert.equal(harness.controller.preservesOriginalLink(), true);
  assert.equal(releases, 0);
  const picker = harness.elements.get('shader-document-file');
  picker.files = [{ name: 'study.shader.json', size: CHAIN_STUDY.length,
    text: async () => CHAIN_STUDY }];
  await onChange(picker)();
  assert.equal(harness.controller.preservesOriginalLink(), false);
  assert.equal(releases, 1);
  assert.equal(await harness.controller.loadSource(CHAIN_STUDY), true);
  assert.equal(releases, 1);
});

test('the descriptor digest button copies the full digest and announces failures', async () => {
  const harness = await editorWorkbench();
  const button = harness.elements.get('shader-document-digest');
  const status = harness.elements.get('shader-document-status');
  const digest = button.dataset.digest;
  assert.ok(digest.length > button.textContent.length);
  const copied = [];
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const clipboard = { writeText: async (text) => { copied.push(text); } };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard } });
  const onClick = button.listeners.find((entry) => entry.type === 'click').handler;
  try {
    await onClick();
    assert.deepEqual(copied, [digest]);
    assert.equal(status.textContent, `Copied the descriptor digest ${digest}.`);
    clipboard.writeText = async () => { throw new Error('clipboard refused'); };
    document.execCommand = () => false;
    await onClick();
    assert.equal(status.textContent, 'The descriptor digest could not be copied.');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test('compiled lattice edits keep the authored fallback period and reapply', async () => {
  const source = withoutEmbeddedModulation(JSON.stringify(promotedDocument('grid_space.shader.json')));
  const harness = await editorWorkbench({ source, sourceFiles: {'grid_space.shader.json': source}, patternCatalog: singlePatternCatalog('grid-space', 'grid_space.shader.json', 'Grid Space') });
  const original = savedValues(harness);
  const toggle = harness.elements.get('shader-parity-toggle');
  assert.equal(toggle.disabled, false);
  toggle.dispatch('click');
  const edit = stageEditor(harness, 'sample');
  edit('sample.cell-scale', 2.7);
  edit('sample.cell-scale', 3.1);
  const values = savedValues(harness);
  assert.equal(Math.fround(values['sample.cell-scale']), Math.fround(3.1));
  assert.equal(values['warp1.lattice-period'], original['warp1.lattice-period']);
  const period = harness.elements.get('chain-strip').querySelectorAll('.chain-param')
    .find((row) => row.dataset.parameter === 'warp1.lattice-period')
    .querySelector('.chain-param-value');
  assert.equal(Math.fround(Number(period.value)), values['warp1.lattice-period']);
  await onChange(harness.elements.get('shader-preset-select'))();
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'ok');
  harness.elements.get('chain-strip').querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(savedValues(harness), original);
  harness.elements.get('chain-strip').querySelector('.chain-redo').dispatch('click');
  assert.deepEqual(savedValues(harness), values);
  toggle.dispatch('click');
  assert.equal(harness.elements.get('shader-document-status').dataset.status, 'ok');
});

test('an affine fallback period stays editable beside a lattice source', async () => {
  const harness = await editorWorkbench(affineLatticeStudy());
  assert.equal(savedValues(harness)['warp.lattice-period'], 1);
  const batches = [];
  const apply = harness.engine.bindings.setShaderChainParameters;
  harness.engine.bindings.setShaderChainParameters = (writes) => {
    batches.push(writes);
    return apply(writes);
  };
  stageEditor(harness, 'sample')('sample.cell-scale', 2.7);
  assert.ok(batches.flat().every(({ name }) => name !== 'warp.lattice-period'));
  assert.equal(savedValues(harness)['warp.lattice-period'], 1);
  stageEditor(harness, 'warp')('warp.lattice-period', 0.75);
  assert.equal(savedValues(harness)['warp.lattice-period'], 0.75);
  const row = paramRow(harness, 'warp', 'warp.lattice-period');
  assert.equal(row.querySelector('.chain-param-control').disabled, false);
});

test('authored compiled stage edits keep camera spin, coverage and independent affine period live', async () => {
  const source = JSON.stringify(scratchChainDocument(JSON.parse(ENGINE_CATALOG),
    promotedDocument('grid_space.shader.json').descriptor.chain.filter((entry) => entry.operator !== 'color.modulate.v1')));
  const harness = await editorWorkbench({source, sourceFiles: {'grid_space.shader.json': source},
    patternCatalog: singlePatternCatalog('grid-space', 'grid_space.shader.json', 'Grid Space')});
  const definitions = harness.compiledEngine.getParameterDefinitions();
  definitions.push({name: 'camera.Wander'}, {name: 'camera.Spin Speed'},
    {name: 'outer_warp.Lattice Period'},
    {name: 'coverage-mode', options: ['None', 'Weight', 'Weight Squared', 'Edge Fade']});
  harness.elements.get('shader-parity-toggle').dispatch('click');
  harness.compiledEngine.writes.length = 0;
  stageEditor(harness, 'camera')('camera.wander', 0.4);
  stageEditor(harness, 'camera')('camera.spin-speed', 0.03);
  stageEditor(harness, 'warp1')('warp1.lattice-period', 0.413);
  stageEditor(harness, 'sample')('sample.cell-scale', 3.1);
  stageEditor(harness, 'sample')('sample.coverage-mode', 'edge-fade');
  assert.deepEqual(harness.compiledEngine.writes, [
    ['camera.Wander', 0.4], ['camera.Spin Speed', 0.03],
    ['outer_warp.Lattice Period', 0.413], ['Cell Scale', 3.1], ['coverage-mode', 3],
  ]);
  const saved = savedValues(harness);
  assert.equal(saved['warp1.lattice-period'], Math.fround(0.413));
  assert.equal(saved['camera.spin-speed'], Math.fround(0.03));
  assert.equal(saved['sample.coverage-mode'], 'edge-fade');
});

test('authored compiled modulation edits replay coupled source and amount writes after admission dependencies', async () => {
  const source = JSON.stringify(promotedDocument('grid_space.shader.json'));
  const harness = await editorWorkbench({source, sourceFiles: {'grid_space.shader.json': source},
    patternCatalog: singlePatternCatalog('grid-space', 'grid_space.shader.json', 'Grid Space')});
  const definitions = harness.compiledEngine.getParameterDefinitions();
  const modulation = JSON.parse(ENGINE_CATALOG).operators.find((entry) => entry.id === 'color.modulate.v1');
  for (const field of modulation.params.filter((field) => field.topology))
    definitions.push({name: field.id, options: field.values});
  harness.elements.get('shader-parity-toggle').dispatch('click');
  assert.equal(harness.elements.get('shader-parity-toggle').getAttribute('aria-pressed'), 'true');
  const native = {'modulation-source': 0, 'modulation-evaluation': 1,
    'modulation-mechanic': 0, 'Modulation Amount': 2};
  const attempts = [];
  harness.compiledEngine.setParameter = (name, value) => {
    attempts.push([name, value]);
    if (name === 'modulation-source' && value !== 0 && native['modulation-evaluation'] !== 0)
      return ParamSetResult.INADMISSIBLE;
    if (name === 'modulation-mechanic' && value !== 0 && native['Modulation Amount'] > 1)
      return ParamSetResult.INADMISSIBLE;
    native[name] = value;
    return ParamSetResult.APPLIED;
  };
  const edit = stageEditor(harness, 'modulation');
  edit('modulation.modulation-source', 'sphere-interference');
  assert.deepEqual(attempts, [
    ['modulation-source', 2], ['modulation-evaluation', 0], ['modulation-source', 2],
  ]);
  attempts.length = 0;
  edit('modulation.modulation-amount', 2);
  attempts.length = 0;
  edit('modulation.modulation-mechanic', 'positive-lightness-lift');
  assert.deepEqual(attempts, [
    ['modulation-mechanic', 1], ['Modulation Amount', 1], ['modulation-mechanic', 1],
  ]);
  const saved = savedValues(harness);
  assert.equal(saved['modulation.modulation-source'], 'sphere-interference');
  assert.equal(saved['modulation.modulation-evaluation'], 'direct');
  assert.equal(saved['modulation.modulation-mechanic'], 'positive-lightness-lift');
  assert.equal(saved['modulation.modulation-amount'], 1);
  assert.equal(native['modulation-source'], 2);
  assert.equal(native['modulation-mechanic'], 1);
});

for (const failure of ['editor', 'runtime']) {
  test(`a ${failure} adoption failure restores the document, strip and program`, async () => {
    let refuseEditor = false;
    const compiler = await import('../generated/shader/shader_workbench.mjs');
    const harness = await editorWorkbench({ importCompiler: async () => ({ ...compiler,
      validateShaderDocument(...args) {
        if (refuseEditor) throw new Error('editor adoption refused');
        return compiler.validateShaderDocument(...args);
      },
    }) });
    const previous = savedValues(harness);
    const strip = harness.elements.get('chain-strip').children[0];
    const snapshot = callWorkbenchBinding(harness.engine, 'getSnapshot', []);
    const document = JSON.parse(CHAIN_STUDY);
    let session;
    if (failure === 'editor') refuseEditor = true;
    else {
      session = { preset: document.preset_bank.presets[0].preset_id, bypassed: [],
        paused: false, chainSnapshot: snapshot };
      const original = harness.engine.getShaderChainBindings.bind(harness.engine);
      let calls = 0;
      harness.engine.getShaderChainBindings = () => {
        const bindings = original();
        const restore = bindings.restoreSnapshot;
        bindings.restoreSnapshot = (value) => ++calls === 1
          ? ChainSnapshotRestoreResult.INVALID_VALUE : restore(value);
        return bindings;
      };
    }
    assert.equal(await harness.controller.loadSource(document, 'refused.shader.json', null, session), false);
    assert.match(harness.elements.get('shader-document-status').textContent,
      failure === 'editor' ? /editor adoption refused/ : /runtime snapshot was rejected/);
    assert.equal(harness.elements.get('chain-strip').children[0], strip);
    assert.deepEqual(savedValues(harness), previous);
    assert.deepEqual(callWorkbenchBinding(harness.engine, 'getSnapshot', []), snapshot);
  });
}

for (const operator of ['sphere.lens.mobius.v2', 'sphere.displace.symmetric.v1',
  'colorize.generated-palette.v3', 'modulate.field.v1', 'modulate.hue-shift.v1']) {
  test(`opening retired operator ${operator} preserves the current document`, async () => {
    const harness = await editorWorkbench();
    const before = callWorkbenchBinding(harness.engine, 'getSnapshot', [], null);
    const retired = JSON.parse(CHAIN_STUDY);
    retired.descriptor.chain[0].operator = operator;
    assert.equal(await harness.controller.loadSource(retired), false);
    assert.equal(harness.elements.get('shader-document-status').dataset.status, 'error');
    assert.match(harness.elements.get('shader-document-status').textContent,
      new RegExp(`UNKNOWN_OPERATOR .*"${operator.replaceAll('.', '\\.')}"`));
    assert.deepEqual(callWorkbenchBinding(harness.engine, 'getSnapshot', [], null), before);
    assert.equal(await harness.controller.loadSource(CHAIN_STUDY), true);
  });
}

for (const schemaVersion of [1, 3, 4, 10, 11]) {
  test(`stored snapshot version ${schemaVersion} is refused before engine restore`, async () => {
    const loaded = await editorWorkbench();
    const snapshot = callWorkbenchBinding(loaded.engine, 'getSnapshot', [], null);
    const current = structuredClone(snapshot);
    snapshot.schemaVersion = schemaVersion;
    const search = `?fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(snapshot))}`;
    let restores = 0;
    const refused = await editorWorkbench({source: null, search, prepare(target) {
      const bindings = target.getShaderChainBindings.bind(target);
      target.getShaderChainBindings = () => {
        const live = bindings();
        if (!live) return live;
        const restore = live.restoreSnapshot;
        live.restoreSnapshot = value => { restores++; return restore(value); };
        return live;
      };
    }});
    assert.match(refused.elements.get('shader-document-status').textContent, /unsupported chain snapshot/);
    assert.equal(restores, 0);
    assert.equal(refused.controller.preservesOriginalLink(), true);
    assert.equal(refused.win.location.search, search);
    const accepted = await editorWorkbench({source: null,
      search: `?fx.__chainSnapshot=${encodeURIComponent(JSON.stringify(current))}`});
    assert.match(accepted.elements.get('shader-document-status').textContent, /Restored the chain snapshot/);
  });
}

test('an untouched linked scratch chain keeps its source and saved baseline', async () => {
  const hash = await encodeShaderStateHash({ document: SCRATCH,
    preset: SCRATCH.preset_bank.presets[0].preset_id, bypassed: [], paused: false });
  const h = await editorWorkbench({ source: null, hash });
  const source = h.elements.get('shader-document-select');
  assert.equal(source.value, '');
  h.win.confirm = () => { throw new Error('unexpected discard prompt'); };
  source.value = '';
  await onChange(source)();
  h.controller.save();
  assert.equal(h.downloads.at(-1)[0], 'scratch.shader.json');
});

test('hash navigation loads a new shader and disposal removes its listener', async () => {
  const h = await editorWorkbench({ source: null });
  assert.equal(h.win.listenerCount('hashchange'), 1);
  const document = structuredClone(SCRATCH);
  document.preset_bank.presets[0].values['sample.pattern-freq'] = 3.5;
  h.win.location.hash = await encodeShaderStateHash({ document,
    preset: document.preset_bank.presets[0].preset_id, bypassed: [], paused: false });
  await h.win.listeners.find(listener => listener.type === 'hashchange').handler();
  h.controller.save();
  assert.equal(JSON.parse(h.downloads.at(-1)[1]).preset_bank.presets[0]
    .values['sample.pattern-freq'], 3.5);
  await h.controller.dispose();
  ownedEditors.delete(h.controller);
  assert.equal(h.win.listenerCount('hashchange'), 0);
});

test('declined hash navigation restores the kept edits in the session link', async () => {
  const h = await editorWorkbench();
  stageEditor(h, 'sample')('sample.pattern-freq', 3.5);
  await h.controller.flushDeepLink();
  const keptHash = h.win.location.hash;
  let confirmations = 0;
  h.win.confirm = () => { confirmations += 1; return false; };
  const document = structuredClone(SCRATCH);
  h.win.location.hash = await encodeShaderStateHash({document,
    preset: document.preset_bank.presets[0].preset_id, bypassed: [], paused: false});
  assert.notEqual(h.win.location.hash, keptHash);
  await h.win.listeners.find(listener => listener.type === 'hashchange').handler();
  await h.controller.flushDeepLink();
  assert.equal(confirmations, 1);
  assert.equal(h.win.location.hash, keptHash);
});
