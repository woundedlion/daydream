import { primaryName, INDEX, WORKBENCH, plainName, MODULE, fixedEngine, promotedDocument, PROMOTED, PATTERN_CATALOG, shaderDocument, workbenchEngine, patternFetch, workbench, onChange, SCRATCH_WRITES, chooseCatalogSource, KALEIDOSCOPE_STAINED_GLASS, compiledBuildEngine, editorWorkbench, stageEditor } from "../helpers/shader_document_harness.js";
import { canonicalEffectId } from "../../src/effects/effect_identity.js";
import { BAKED_CONSTANT_IDS } from "../../generated/shader/shader_workbench.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORKBENCH_EFFECTS } from "../../src/effects/effect_roster.js";
import { createShaderDocumentController } from "../../src/workbench/shader/shader_documents.js";
import { unpinnedEngineMethods } from "../helpers/fake_engine.js";
import { fakeElement } from "../helpers/fake_dom.js";

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
    new URL("../../generated/shader/patterns/catalog.json", import.meta.url), 'utf8'));
  const aliased = new Set();
  for (const filename of Object.values(patternCatalog.source_documents)) {
    const doc = JSON.parse(readFileSync(
      new URL(`../../generated/shader/patterns/${filename}`, import.meta.url), 'utf8'));
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
