import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shaderWorkbenchUrl, start } from '../daydream.js';
import {
  findWorkbenchFolder,
  revealWorkbenchFolder,
  wireShaderWorkbenchNav,
} from '../tools/shader_workbench_nav.js';
import {
  applyDynamicShaderDocument,
  applyFixedShaderDocument,
  createShaderDocumentController,
  engineParameterName,
} from '../tools/shader_documents.js';
import { ParamSetResult, unpinnedEngineMethods } from './fake_engine.js';
import { fakeElement } from './fake_dom.js';

const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WORKBENCH = readFileSync(new URL('../tools/shader.html', import.meta.url), 'utf8');
const WORKBENCH_CSS = readFileSync(new URL('../tools/shader.css', import.meta.url), 'utf8');

test('simulator exposes Shader as a standalone tool', () => {
  assert.match(INDEX, /href="tools\/shader\.html"[^>]*>Shader/);
  assert.match(WORKBENCH, /data-daydream-mode="shader-workbench"/);
  assert.match(WORKBENCH, /src="\.\.\/main\.js"/);
  assert.match(WORKBENCH, /id="shader-workbench-nav"/);
  assert.match(WORKBENCH, /id="shader-document-select"/);
  assert.match(WORKBENCH, /id="shader-preset-select"/);
  assert.match(WORKBENCH, /id="shader-document-open"/);
  assert.match(WORKBENCH, /id="shader-document-save"/);
  assert.match(WORKBENCH, /src="shader_workbench_nav\.js"/);
  assert.doesNotMatch(WORKBENCH, />Simulator<\/a>/);
  assert.doesNotMatch(WORKBENCH, /id="effect-sidebar"/);
  assert.match(WORKBENCH_CSS, /\.lil-controller\.lil-option option\s*\{/);
  assert.match(WORKBENCH_CSS, /color-scheme:\s*dark/);
  assert.match(WORKBENCH_CSS, /background-color:\s*var\(--background-color\)/);
});

// The alias table serves effects promoted before the chain schema: a v2
// parameter id is <label>.<field>, and the label picks the family whose
// registered control names the field maps onto.
test('v2 document parameter IDs map to pre-spec promoted controls', () => {
  assert.equal(engineParameterName('sample.pattern-freq'), 'Pattern Freq');
  assert.equal(engineParameterName('sample.angle-speed'), 'Source Angle Speed');
  assert.equal(engineParameterName('sample.edge-width'), 'Edge Fade Width');
  assert.equal(engineParameterName('warp1.cell-x'), 'Planar Warp 1 Cell X');
  assert.equal(engineParameterName('warp2.speed'), 'Planar Warp 2 Speed');
  assert.equal(engineParameterName('project.pole-fade'), 'Pole Fade');
  assert.equal(engineParameterName('project.camera-wander'), 'Camera Wander');
  assert.equal(engineParameterName('surface.scale'), 'Surface Noise Scale');
  assert.equal(engineParameterName('lens.a-re'), 'Mobius A Re');
  assert.equal(engineParameterName('transfer.iso-level'), 'Iso Contour Level');
  assert.equal(engineParameterName('colorize.palette-mapping'), 'Palette Mapping');
  assert.equal(engineParameterName('colorize.hue-shift-amount'), 'Hue Shift Amount');
});

const MODULE = { ParamSetResult };

/** @param {(name: string) => Object} answer */
function dynamicEngine(answer) {
  const definitions = [{ name: 'Pattern Freq' }];
  const writes = [];
  return {
    writes,
    getParameterDefinitions: () => definitions,
    setParameter: (name, value) => { writes.push([name, value]); return answer(name); },
  };
}

// A chain document has no structural dropdowns to write; its dynamic preview
// goes through setShaderChain, which lands with the D2 engine update, so until
// then the dynamic path refuses before touching the engine.
test('a chain document is refused pending the chain engine', () => {
  const engine = dynamicEngine(() => ParamSetResult.APPLIED);
  const compiled = { document: {
    descriptor: { chain: [{ label: 'camera', operator: 'sphere.rotate.v2' }] },
    preset_bank: { presets: [{ preset_id: 'study', values: {} }] },
  } };

  const refusal = applyDynamicShaderDocument(engine, MODULE, compiled, 'study');
  assert.equal(typeof refusal, 'string');
  assert.match(refusal, /chain engine/);
  assert.deepEqual(engine.writes, []);
});

const fixedDocument = () => ({ document: {
  preset_bank: { presets: [
    { preset_id: 'noon', values: { 'sample.pattern-freq': 2, 'sample.weight-mode': 'projection' } },
    { preset_id: 'dusk', values: { 'sample.pattern-freq': 5, 'sample.weight-mode': 'projection' } },
  ] },
} });

/** @param {(id: string) => boolean} answer */
function fixedEngine(answer) {
  const selected = [];
  const writes = [];
  return {
    selected,
    writes,
    selectPresetById: (id) => { selected.push(id); return answer(id); },
    getParameterDefinitions: () => [{ name: 'Pattern Freq' }],
    setParameter: (name, value) => {
      writes.push([name, value]);
      return ParamSetResult.APPLIED;
    },
  };
}

test('the shader-document engine fakes mock nothing outside the engine surface', () => {
  assert.deepEqual(unpinnedEngineMethods(fixedEngine(() => true)), []);
  assert.deepEqual(unpinnedEngineMethods(dynamicEngine(() => ParamSetResult.APPLIED)), []);
});

// The writes also pin the topology skip: sample.weight-mode selects a baked
// structural variant, so the fixed path never offers it to the engine.
test('a fixed-pipeline preset is staged on the engine preset it names', () => {
  const engine = fixedEngine(() => true);

  assert.equal(applyFixedShaderDocument(
    engine, MODULE, fixedDocument(), 'dusk', ['noon', 'dusk']), null);
  assert.deepEqual(engine.selected, ['dusk']);
  assert.deepEqual(engine.writes, [['Pattern Freq', 5]]);
});

// The document's presets and the effect's reference presets are separate banks:
// an authored preset the effect never had still has to land on some reference
// state, or the values are written over whatever the last preview left behind.
test('a preset the effect does not carry falls back to its first reference', () => {
  const engine = fixedEngine(() => true);

  assert.equal(applyFixedShaderDocument(
    engine, MODULE, fixedDocument(), 'study', ['noon']), null);
  assert.deepEqual(engine.selected, ['noon']);
  assert.deepEqual(engine.writes, [['Pattern Freq', 2]]);
});

test('an effect with no reference preset is refused before any engine write', () => {
  const engine = fixedEngine(() => true);

  assert.equal(
    applyFixedShaderDocument(engine, MODULE, fixedDocument(), 'noon', []),
    'the effect has no reference preset');
  assert.deepEqual(engine.selected, []);
  assert.deepEqual(engine.writes, []);
});

test('a refused reference preset names the preset the engine rejected', () => {
  const engine = fixedEngine(() => false);

  assert.equal(
    applyFixedShaderDocument(engine, MODULE, fixedDocument(), 'noon', ['noon']),
    'the engine refused reference preset "noon"');
  assert.deepEqual(engine.writes, []);
});

// selectPresetById is reached through an optional call, so an engine build
// without it answers undefined rather than throwing; only the !== true test
// keeps that from reading as a staged preset.
test('an engine without selectPresetById is refused, not written through', () => {
  const engine = fixedEngine(() => true);
  delete engine.selectPresetById;

  assert.match(
    String(applyFixedShaderDocument(engine, MODULE, fixedDocument(), 'noon', ['noon'])),
    /refused reference preset "noon"/);
  assert.deepEqual(engine.writes, []);
});

test('stage navigation opens and reveals the selected GUI folder', () => {
  let clicked = false;
  let scrolled = false;
  const title = {
    textContent: 'Projection',
    click: () => { clicked = true; },
    getAttribute: () => 'false',
  };
  const folder = {
    querySelector: () => title,
    scrollIntoView: () => { scrolled = true; },
  };
  title.parentElement = folder;
  const root = { querySelectorAll: () => [{ textContent: 'Camera' }, title] };

  assert.equal(findWorkbenchFolder(root, 'Projection'), folder);
  assert.equal(revealWorkbenchFolder(root, 'Projection'), true);
  assert.equal(clicked, true);
  assert.equal(scrolled, true);
  assert.equal(revealWorkbenchFolder(root, 'Missing'), false);
});

/**
 * Nav-wiring double: a document whose folder titles the test grows, a nav of
 * two stage buttons, and a MutationObserver stand-in the test fires by hand.
 * @param {string[]} names - Folder titles present at wire time.
 * @returns {Object} The doc, the buttons, the observer record and a sweep count.
 */
function navHarness(names) {
  const titles = names.map((name) => ({ textContent: name, parentElement: { name } }));
  const button = (name) => ({
    dataset: { workbenchFolder: name },
    disabled: false,
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
  });
  const buttons = [button('Projection'), button('Lens')];
  const nav = { querySelectorAll: () => buttons };
  const gui = {};
  const record = { observed: 0, disconnected: 0, callback: null, sweeps: 0 };
  const doc = {
    getElementById: (id) => (id === 'shader-workbench-nav' ? nav
      : id === 'gui-container' ? gui : null),
    querySelectorAll: () => { record.sweeps++; return titles; },
  };
  return { doc, buttons, record, titles };
}

test('the workbench nav stops observing once every stage folder exists', () => {
  const savedObserver = globalThis.MutationObserver;
  const savedWindow = globalThis.window;
  try {
    const { doc, buttons, record, titles } = navHarness(['Projection']);
    globalThis.window = { addEventListener() {} };
    globalThis.MutationObserver = class {
      /** @param {Function} cb - Mutation callback. */
      constructor(cb) { record.callback = cb; }
      observe() { record.observed++; }
      disconnect() { record.disconnected++; }
    };

    const observer = wireShaderWorkbenchNav(doc);
    assert.ok(observer, 'a missing folder must leave the observer watching the mount');
    assert.equal(record.observed, 1);
    assert.equal(buttons[1].disabled, true, 'the absent stage stays disabled');
    assert.equal(record.sweeps, 1, 'one DOM sweep per sync, not one per button');

    titles.push({ textContent: 'Lens', parentElement: {} });
    record.callback();
    assert.equal(buttons[1].disabled, false);
    assert.equal(record.disconnected, 1,
      'the observer sweeps the GUI for the page lifetime after the last folder lands');
  } finally {
    globalThis.MutationObserver = savedObserver;
    globalThis.window = savedWindow;
  }
});

test('the workbench nav never observes when the GUI is already built', () => {
  const savedObserver = globalThis.MutationObserver;
  const savedWindow = globalThis.window;
  try {
    const { doc, record } = navHarness(['Projection', 'Lens']);
    globalThis.window = { addEventListener() {} };
    globalThis.MutationObserver = class {
      /** @param {Function} cb - Mutation callback. */
      constructor(cb) { record.callback = cb; }
      observe() { record.observed++; }
      disconnect() { record.disconnected++; }
    };

    assert.equal(wireShaderWorkbenchNav(doc), null);
    assert.equal(record.observed, 0);
  } finally {
    globalThis.MutationObserver = savedObserver;
    globalThis.window = savedWindow;
  }
});

const MIGRATION = JSON.stringify({
  source_documents: { EquatorGrid: 'equator_grid.shader.json' },
  product_group: { children: [{ effect_id: 'EquatorGrid', display_name: 'Equator Grid' }] },
});

/** @param {{digest?: string, status?: string, diagnostics?: *}} [shape] */
const shaderDocument = ({ digest = 'digest-equator', status = 'VALID',
                          diagnostics = undefined } = {}) => JSON.stringify({
  status,
  diagnostics,
  descriptor_digest: digest,
  document: {
    effect_id: 'EquatorGrid',
    effect_metadata: { display_name: 'Equator Grid' },
    descriptor: { chain: [] },
    preset_bank: { presets: [
      { preset_id: 'noon', display_name: 'Noon', values: { 'sample.pattern-freq': 2 } },
      { preset_id: 'dusk', display_name: 'Dusk', values: { 'sample.pattern-freq': 5 } },
    ] },
  },
});

/** @returns {Object} An engine whose parameter definitions follow its writes. */
function workbenchEngine() {
  const definitions = [
    { name: 'Pattern Freq', value: 1 },
  ];
  const writes = [];
  const selected = [];
  return {
    definitions,
    writes,
    selected,
    selectPresetById: (id) => { selected.push(id); return true; },
    getParameterDefinitions: () => definitions,
    setParameter: (name, value) => {
      writes.push([name, value]);
      const definition = definitions.find((candidate) => candidate.name === name);
      if (definition) definition.value = value;
      return ParamSetResult.APPLIED;
    },
  };
}

/**
 * Builds the workbench document controller over the shader.html control set.
 * @param {{files?: Object, engine?: *, selectEffect?: (effect: string) => boolean}} [seams]
 * @returns {Object} The controller and everything it wrote to.
 */
function workbench({ files = { 'equator_grid.shader.json': shaderDocument() },
                     engine = workbenchEngine(),
                     selectEffect = () => true } = {}) {
  const elements = new Map(['shader-document-select', 'shader-preset-select',
    'shader-document-open', 'shader-document-save', 'shader-document-file',
    'shader-document-status',
  ].map((id) => [id, fakeElement(id.endsWith('select') ? 'select' : 'div')]));
  const scratch = fakeElement('option');
  scratch.value = '';
  scratch.textContent = 'Scratch shader';
  elements.get('shader-document-select').appendChild(scratch);
  elements.get('shader-document-save').disabled = true;

  const downloads = [];
  const selections = [];
  const ran = { gui: 0, invalidated: 0 };
  const controller = createShaderDocumentController({
    doc: {
      getElementById: (id) => elements.get(id) ?? null,
      createElement: (tag) => fakeElement(tag),
    },
    getEngine: () => engine,
    getModule: () => MODULE,
    selectEffect: (effect) => { selections.push(effect); return selectEffect(effect); },
    syncEffectGui: () => { ran.gui += 1; },
    invalidate: () => { ran.invalidated += 1; },
    fetchText: async (url) => {
      const name = String(url).split('/').pop();
      if (name === 'shaderball_migration.json') return MIGRATION;
      if (name === 'engine_catalog.json') return '{"catalog_version": 2}';
      const source = files[name];
      if (source === undefined) throw new Error(`404 ${name}`);
      return source;
    },
    importCompiler: async () => ({ compileShaderDocument: (s) => JSON.parse(s) }),
    download: (filename, source) => downloads.push([filename, source]),
  });
  return { controller, elements, downloads, selections, engine, ran };
}

/** @param {Object} element @returns {Function} The element's change handler. */
const onChange = (element) =>
  element.listeners.find((listener) => listener.type === 'change').handler;

/** @param {Object} harness @returns {Promise<void>} */
async function chooseCatalogSource({ elements, controller }) {
  await controller.init();
  const select = elements.get('shader-document-select');
  select.value = 'EquatorGrid';
  await onChange(select)();
}

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
  assert.deepEqual(select.options.map((option) => option.value), ['', 'EquatorGrid']);
  assert.deepEqual(select.options.map((option) => option.textContent),
    ['Scratch shader', 'Equator Grid']);
  const status = elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'ok');
  assert.match(status.textContent, /Choose a source document/);
});

// init() reports through the status element and a return value the page drops,
// so a catalog that never loaded is a line of prose on an otherwise live page:
// the boolean is the only channel a caller can act on.
test('a catalog document that fails to compile reports its diagnostic', async () => {
  const { controller, elements } = workbench({ files: {
    'equator_grid.shader.json': shaderDocument({
      status: 'INVALID',
      diagnostics: [{ code: 'E_ROLE', path: '/descriptor', message: 'unknown role' }],
    }),
  } });

  assert.equal(await controller.init(), false);
  const status = elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /E_ROLE at \/descriptor: unknown role/);
  assert.equal(elements.get('shader-document-select').options.length, 1);
});

test('a catalog that cannot be fetched is reported, not left half-listed', async () => {
  const { controller, elements } = workbench({ files: {} });

  assert.equal(await controller.init(), false);
  assert.match(elements.get('shader-document-status').textContent,
    /Source catalog failed to load: 404/);
  assert.equal(elements.get('shader-document-select').options.length, 1);
});

test('choosing a catalog source stages its effect and previews its first preset', async () => {
  const harness = workbench();

  await chooseCatalogSource(harness);

  assert.deepEqual(harness.selections, ['EquatorGrid']);
  assert.deepEqual(harness.engine.selected, ['noon']);
  assert.deepEqual(harness.engine.writes, [['Pattern Freq', 2]]);
  const presets = harness.elements.get('shader-preset-select');
  assert.deepEqual(presets.options.map((option) => option.value), ['noon', 'dusk']);
  assert.equal(presets.disabled, false);
  assert.equal(harness.elements.get('shader-document-save').disabled, false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Equator Grid · Noon/);
  assert.deepEqual(harness.ran, { gui: 1, invalidated: 1 });
});

// The digest is what tells an authored study from a shipped pattern: matching
// one routes the preview onto the concrete effect, and anything else needs the
// chain engine, which lands with the D2 engine update.
test('an imported study the catalog does not carry is parked on the D2 status', async () => {
  const harness = workbench();
  await harness.controller.init();

  assert.equal(await harness.controller.loadSource(
    shaderDocument({ digest: 'digest-study' }), 'study.shader.json'), false);
  assert.deepEqual(harness.selections, []);
  assert.deepEqual(harness.engine.selected, []);
  assert.deepEqual(harness.engine.writes, []);
  const status = harness.elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /chain engine \(D2\)/);
  assert.equal(harness.elements.get('shader-document-save').disabled, true);
});

test('choosing a preset previews it without reloading the document', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  const presets = harness.elements.get('shader-preset-select');
  presets.value = 'dusk';

  onChange(presets)();

  assert.deepEqual(harness.engine.selected, ['noon', 'dusk']);
  assert.deepEqual(harness.engine.writes.at(-1), ['Pattern Freq', 5]);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Equator Grid · Dusk/);
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
    /rejected effect "EquatorGrid"/);
  assert.equal(harness.elements.get('shader-document-save').disabled, true);
  assert.equal(harness.controller.save(), false);
});

test('saving exports the live engine values, not the ones the document arrived with', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  harness.engine.definitions.find((d) => d.name === 'Pattern Freq').value = 9;

  assert.equal(harness.controller.save(), true);
  const [filename, source] = harness.downloads[0];
  assert.equal(filename, 'equator_grid.shader.json');
  const saved = JSON.parse(source);
  assert.equal(saved.preset_bank.presets[0].values['sample.pattern-freq'], 9);
  assert.equal(saved.preset_bank.presets[1].values['sample.pattern-freq'], 5,
    'the presets the session never previewed must survive the round trip');
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Saved equator_grid\.shader\.json/);
});

test('returning to the scratch source drops the loaded document', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  const select = harness.elements.get('shader-document-select');
  select.value = '';

  await onChange(select)();

  assert.deepEqual(harness.selections, ['EquatorGrid', 'Shader']);
  const presets = harness.elements.get('shader-preset-select');
  assert.equal(presets.options.length, 0);
  assert.equal(presets.disabled, true);
  assert.equal(harness.elements.get('shader-document-save').disabled, true);
  assert.equal(harness.controller.save(), false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Scratch Shader is active/);
});

test('legacy custom Shader URLs preserve their state on the workbench route', () => {
  assert.equal(
    shaderWorkbenchUrl('https://example.test/daydream/index.html?effect=ShaderBall&fx.Speed=2#preview'),
    '/daydream/tools/shader.html?effect=Shader&fx.Speed=2#preview',
  );
});

test('the workbench route carries the requested shader document', () => {
  assert.equal(
    shaderWorkbenchUrl('https://example.test/daydream/index.html?effect=signal-weave', 'signal-weave'),
    '/daydream/tools/shader.html?effect=signal-weave',
  );
});

// A document id is a workbench effect the simulator's favorites never list, so
// without the route it fails validation and the page opens on its default.
test('a shader-document deep link routes the simulator to the workbench', () => {
  const replaced = [];
  const win = {
    location: { href: 'https://example.test/daydream/index.html?effect=alien-ocean',
                search: '?effect=alien-ocean',
                replace: (url) => replaced.push(url) },
    addEventListener() {}, removeEventListener() {},
  };
  const doc = { documentElement: { dataset: {} } };
  start({ doc, win });
  assert.deepEqual(replaced, ['/daydream/tools/shader.html?effect=alien-ocean']);
});
