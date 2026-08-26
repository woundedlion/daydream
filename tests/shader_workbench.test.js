import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { shaderWorkbenchUrl, start, WORKBENCH_EFFECTS } from '../daydream.js';
import {
  compileShaderDocument, DEFAULT_LIMITS, exportShaderDocumentJson, validateShaderDocument,
} from '../shader/shader_workbench.mjs';
import { scratchChainDocument } from '../tools/chain_document_store.js';
import {
  decodeShaderStateHash, encodeShaderStateHash, replaceShaderStateHash,
} from '../tools/shader_deeplink.js';
import {
  applyFixedShaderDocument,
  BAKED_CONSTANT_IDS,
  bakedTopologyFields,
  createShaderDocumentController,
  engineParameterName,
  SHADER_LINK_DEBOUNCE_MS,
  SHADER_LINK_MAX_WAIT_MS,
} from '../tools/shader_documents.js';
import {
  FakeChainEngine, ParamSetResult, unpinnedEngineMethods,
} from './fake_engine.js';
import {
  documentEvents, fakeElement, installAnimationFrames, installDocument,
  restoreDocumentAfterEach,
} from './fake_dom.js';

const INDEX = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const WORKBENCH = readFileSync(new URL('../tools/shader.html', import.meta.url), 'utf8');
const WORKBENCH_CSS = readFileSync(new URL('../tools/shader.css', import.meta.url), 'utf8');
const ENGINE_CATALOG = readFileSync(
  new URL('../shader/engine_catalog.json', import.meta.url), 'utf8');
// §4.5: the document the workbench opens on, built from the same catalog the
// page fetches, so the fakes register exactly what the scratch chain would.
const SCRATCH = scratchChainDocument(JSON.parse(ENGINE_CATALOG));

restoreDocumentAfterEach();

let animationFrames;
beforeEach(() => { animationFrames = installAnimationFrames(); });
afterEach(() => { animationFrames.restore(); });

test('shader state hashes round-trip the complete authoring state', async () => {
  const state = {
    document: { document_id: 'study-λ', descriptor: { chain: [] } },
    preset: 'night',
    bypassed: ['camera', 'warp1'],
    paused: true,
  };
  const hash = await encodeShaderStateHash(state);

  assert.match(hash, /^#shader=v1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(await decodeShaderStateHash(hash), state);
  assert.equal(await decodeShaderStateHash('#unrelated'), null);
  await assert.rejects(decodeShaderStateHash('#shader=v1.not-gzip'),
    /invalid shader link payload/);
});

test('a deep-linked document is held to the reader string limit', async () => {
  const overlong = 'x'.repeat(DEFAULT_LIMITS.stringLength + 1);
  const linked = async (/** @type {*} */ document) => {
    const hash = await encodeShaderStateHash(
      { document, preset: 'night', bypassed: [], paused: false });
    const state = await decodeShaderStateHash(hash);
    return compileShaderDocument(state.document);
  };
  const codes = (/** @type {*} */ compiled) =>
    compiled.diagnostics.map((/** @type {*} */ diagnostic) => diagnostic.code);

  const nested = { document_id: 'study', descriptor: { chain: [{ label: overlong }] } };
  assert.equal((await linked(nested)).status, 'INVALID');
  assert.deepEqual(codes(await linked(nested)), ['STRING_LIMIT']);
  assert.deepEqual(codes(await linked({ document_id: 'study', [overlong]: 1 })),
    ['STRING_LIMIT']);
  // The text path is the reference the deep link has to answer with.
  assert.deepEqual(codes(compileShaderDocument(JSON.stringify(nested))), ['STRING_LIMIT']);
});

test('shader state hash replacement preserves the route and query', () => {
  const writes = [];
  const win = {
    location: { pathname: '/tools/shader.html', search: '?effect=KaleidoscopeStainedGlass' },
    history: { replaceState: (_state, _title, url) => writes.push(url) },
  };

  assert.equal(replaceShaderStateHash('#shader=v1.payload', win), true);
  assert.deepEqual(writes, [
    '/tools/shader.html?effect=KaleidoscopeStainedGlass#shader=v1.payload',
  ]);
});

test('simulator exposes Shader as a standalone tool', () => {
  assert.match(INDEX, /href="tools\/shader\.html"[^>]*>Shader/);
  assert.match(WORKBENCH, /data-daydream-mode="shader-workbench"/);
  assert.match(WORKBENCH, /src="\.\.\/main\.js"/);
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
  assert.doesNotMatch(WORKBENCH, /data-workbench-folder/,
    'the folder banks are replaced by the pipeline strip');
  assert.doesNotMatch(WORKBENCH, /shader_workbench_nav/);
  assert.doesNotMatch(WORKBENCH, />Simulator<\/a>/);
  assert.doesNotMatch(WORKBENCH, /id="effect-sidebar"/);
  assert.doesNotMatch(WORKBENCH, /id="chain-editor"|id="chain-catalog"/,
    'the sidebar rail and its catalog panel are retired');
  assert.doesNotMatch(WORKBENCH, /parameter-dock/,
    'stage parameters live on the strip\'s chips, not in a dock');
  assert.doesNotMatch(WORKBENCH, /shader-workbench-nav/);
  assert.match(WORKBENCH_CSS, /\.lil-controller\.lil-option option\s*\{/);
  assert.match(WORKBENCH_CSS, /color-scheme:\s*dark/);
  assert.match(WORKBENCH_CSS, /background-color:\s*var\(--background-color\)/);
  assert.match(WORKBENCH_CSS, /\.chain-param\[data-deactivated="true"\]\s*\{/);
  assert.match(WORKBENCH_CSS, /\.chain-param-note\s*\{[^}]*grid-column:\s*1 \/ -1/,
    'the reason node takes a row of its own instead of a parameter grid cell');
});

test('transition cards use opaque surfaces', () => {
  assert.match(WORKBENCH_CSS,
    /\.chain-chip--socket\s*\{[^}]*background:\s*var\(--panel-bg\)/,
    'transition headers keep an opaque reading surface');
  assert.match(WORKBENCH_CSS,
    /\.chain-palette\s*\{[^}]*background:\s*var\(--panel-bg\)/,
    'transition palettes keep an opaque panel surface');
  assert.match(WORKBENCH_CSS,
    /\.chain-palette-entry\s*\{[^}]*background:\s*#[0-9a-f]{6}/i,
    'transition choices keep opaque raised rows');
  assert.match(WORKBENCH_CSS,
    /\.chain-palette-entry:hover,[^{]+\{[^}]*background:\s*#[0-9a-f]{6}/i,
    'transition choice hover remains opaque');
});

test('closed and open cards share one header layout', () => {
  assert.match(WORKBENCH_CSS,
    /\.chain-chip-params\s*\{[^}]*display:\s*grid[^}]*width:\s*max-content/,
    'hidden parameter grids reserve the open card width');
  assert.match(WORKBENCH_CSS,
    /\.chain-chip:not\(\.chain-chip--expanded\) \.chain-chip-params\s*\{[^}]*height:\s*0[^}]*visibility:\s*hidden/,
    'closed cards collapse only the parameter body');
  assert.doesNotMatch(WORKBENCH_CSS,
    /\.chain-chip[^{]*(?:chain-chip--expanded|:not\(\.chain-chip--expanded\))[^{]*\.chain-chip-(?:name|label|pair|function-label)[^{]*\{/,
    'header content does not depend on the card state');
});

// §4.1: the toolbar's slim row over a main area the canvas fills, with the
// pipeline strip overlaying that area's top edge so the preview keeps the
// height the strip would otherwise take. The toolbar keeps the engine stats
// row, and the document status output is the one live region the strip and
// library announce through. The global controls keep the floating panel every
// other page mounts, inside the main area so it covers the canvas and nothing
// else.
test('the workbench page lays out the toolbar, pipeline and canvas', () => {
  // search() answers -1 for a missing match, which orders ahead of every real
  // offset: an ordering assertion whose left operand is deleted would pass.
  const region = (/** @type {RegExp} */ pattern) => {
    const at = WORKBENCH.search(pattern);
    assert.ok(at >= 0, `the workbench page must carry ${pattern}`);
    return at;
  };
  assert.ok(region(/id="shader-toolbar"/) < region(/id="chain-strip"/));
  assert.ok(region(/<main class="main-area"/) < region(/id="chain-strip"/)
    && region(/id="chain-strip"/) < region(/id="canvas-container"/),
  'the pipeline sits inside the main area, ahead of the canvas it overlays');
  assert.match(WORKBENCH_CSS,
    /\.chain-strip-region\s*\{[^}]*position:\s*absolute[^}]*top:\s*0/,
    'anchored to that area rather than stacked above it');
  assert.ok(region(/id="canvas-container"/) < region(/<\/main>/),
    'the canvas is what the main area holds');
  assert.ok(region(/id="canvas-container"/) < region(/id="gui-container"/)
    && region(/id="gui-container"/) < region(/<\/main>/),
  'the global controls float inside the main area, over the canvas alone');
  assert.ok(WORKBENCH_CSS.includes('#gui-container > .lil-gui {'),
    'and are capped by that area rather than the viewport');
  assert.ok(region(/id="shader-toolbar"/) < region(/id="global-stats-desktop"/)
    && region(/id="global-stats-desktop"/) < region(/id="chain-strip"/),
  'the engine memory and compute stats stay in the toolbar row');
  assert.match(WORKBENCH,
    /id="shader-document-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(WORKBENCH_CSS, /\.chain-strip-viewport\s*\{[^}]*overflow-x:\s*auto/,
    'expanded chips scroll rather than crushing the bands');
  assert.match(WORKBENCH_CSS,
    /\.chain-strip-viewport::-webkit-scrollbar\s*\{[^}]*display:\s*none/,
  'the pipeline scrollbar stays hidden');
  assert.match(WORKBENCH_CSS, /\.chain-strip\s*\{[^}]*align-items:\s*flex-start/,
    'short domain bands do not stretch to the tallest stage');
  assert.match(WORKBENCH_CSS, /\.chain-band\s*\{[^}]*flex:\s*0 0 auto/,
    'domain bands size to their contents');
  assert.match(WORKBENCH_CSS, /\.chain-chip-header\s*\{[^}]*display:\s*flex/,
    'the card header lays its controls out in one row');
  assert.match(WORKBENCH_CSS,
    /\.chain-chip-remove,\s*\.chain-chip-bypass,\s*\.chain-chip-move\s*\{[^}]*display:\s*inline-grid/,
  'bypass, reorder and delete size alike inside it');
  assert.doesNotMatch(WORKBENCH_CSS,
    /\.chain-chip-params\s*\{[^}]*(?:max-height|overflow-y|scrollbar-gutter):/,
  'stage parameters remain fully visible without their own scroller');
  assert.match(WORKBENCH_CSS,
    /\.chain-chip--expanded\s*\{[^}]*width:\s*max-content/,
  'expanded cards grow to fit their controls');
  assert.doesNotMatch(WORKBENCH_CSS,
    /\.chain-chip--expanded\s*\{[^}]*max-width:/,
  'the horizontal pipeline viewport, not the card, handles narrow screens');
  assert.match(WORKBENCH_CSS,
    /\.chain-chip-params\s*\{[^}]*grid-template-columns:\s*max-content 6rem 4rem/,
  'parameter labels, sliders, and numeric inputs stay inside the card');
  assert.match(WORKBENCH_CSS, /\[data-carrier="color"\]/,
    'each carrier domain carries its own hue');
});

// The alias table serves effects promoted before the chain schema: a v2
// parameter id is <label>.<field>, and the label picks the family whose
// registered control names the field maps onto.
test('v2 document parameter IDs map to pre-spec promoted controls', () => {
  assert.equal(engineParameterName('sample.pattern-freq'), 'Pattern Freq');
  assert.equal(engineParameterName('sample.angle-speed'), 'Source Angle Speed');
  assert.equal(engineParameterName('warp1.cell-x'), 'Planar Warp 1 Cell X');
  assert.equal(engineParameterName('warp2.speed'), 'Planar Warp 2 Speed');
  assert.equal(engineParameterName('camera.wander'), 'Camera Wander');
  assert.equal(engineParameterName('surface.scale'), 'Surface Noise Scale');
});

/** @param {string} field The plain Title Case control name an alias-free label yields. */
const plainName = (field) => field.split('-').map((part) => part.length === 0
  ? part : part[0].toUpperCase() + part.slice(1)).join(' ');

// A label outside the alias set maps to the plain Title Case of its field, so
// a newly promoted document needs no table entry to land on its controls.
test('labels outside the alias table need no entry', () => {
  assert.equal(engineParameterName('project.pole-fade'), 'Pole Fade');
  assert.equal(engineParameterName('lens.mobius-a-re'), 'Mobius A Re');
  assert.equal(engineParameterName('transfer.iso-level'), 'Iso Level');
  assert.equal(engineParameterName('colorize.palette-mapping'), 'Palette Mapping');
  assert.equal(engineParameterName('halo.glow-strength'), 'Glow Strength');
  assert.equal(engineParameterName('no-dot-id'), 'No Dot Id');
});

// Convergence pin: across every shipped pattern document, the labels whose
// mapping differs from the plain field spelling stay this frozen set. A new
// label showing up here means an alias entry crept in for a post-spec effect.
test('the alias table keys stay frozen to the pre-spec promoted labels', () => {
  const migration = JSON.parse(readFileSync(
    new URL('../shader/patterns/shaderball_migration.json', import.meta.url), 'utf8'));
  const aliased = new Set();
  for (const filename of Object.values(migration.source_documents)) {
    const doc = JSON.parse(readFileSync(
      new URL(`../shader/patterns/${filename}`, import.meta.url), 'utf8'));
    for (const preset of doc.preset_bank.presets) {
      for (const id of Object.keys(preset.values ?? {})) {
        const dot = id.indexOf('.');
        if (engineParameterName(id) !== plainName(id.slice(dot + 1)))
          aliased.add(id.slice(0, dot));
      }
    }
  }
  assert.deepEqual([...aliased].sort(),
    ['camera', 'sample', 'surface', 'warp1', 'warp2']);
});

const MODULE = { ParamSetResult };
const BAKED = bakedTopologyFields(JSON.parse(ENGINE_CATALOG));

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
  for (const [name, double] of [
    ['fixedEngine', fixedEngine(() => true)],
    ['workbenchEngine', workbenchEngine()],
    ['compiledBuildEngine', compiledBuildEngine()],
  ]) assert.deepEqual(unpinnedEngineMethods(double), [], name);
});

// The writes also pin the topology skip: sample.weight-mode selects a baked
// structural variant, so the fixed path never offers it to the engine.
test('a fixed-pipeline preset is staged on the engine preset it names', () => {
  const engine = fixedEngine(() => true);

  assert.equal(applyFixedShaderDocument(
    engine, MODULE, fixedDocument(), 'dusk', ['noon', 'dusk'], BAKED), null);
  assert.deepEqual(engine.selected, ['dusk']);
  assert.deepEqual(engine.writes, [['Pattern Freq', 5]]);
});

// The document's presets and the effect's reference presets are separate banks:
// an authored preset the effect never had still has to land on some reference
// state, or the values are written over whatever the last preview left behind.
test('a preset the effect does not carry falls back to its first reference', () => {
  const engine = fixedEngine(() => true);

  assert.equal(applyFixedShaderDocument(
    engine, MODULE, fixedDocument(), 'study', ['noon'], BAKED), null);
  assert.deepEqual(engine.selected, ['noon']);
  assert.deepEqual(engine.writes, [['Pattern Freq', 2]]);
});

test('an effect with no reference preset is refused before any engine write', () => {
  const engine = fixedEngine(() => true);

  assert.equal(
    applyFixedShaderDocument(engine, MODULE, fixedDocument(), 'noon', [], BAKED),
    'the effect has no reference preset');
  assert.deepEqual(engine.selected, []);
  assert.deepEqual(engine.writes, []);
});

test('a refused reference preset names the preset the engine rejected', () => {
  const engine = fixedEngine(() => false);

  assert.equal(
    applyFixedShaderDocument(engine, MODULE, fixedDocument(), 'noon', ['noon'], BAKED),
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
    String(applyFixedShaderDocument(
      engine, MODULE, fixedDocument(), 'noon', ['noon'], BAKED)),
    /refused reference preset "noon"/);
  assert.deepEqual(engine.writes, []);
});

// The skip set is the catalog's own topology flag rather than a hand list, so
// every flagged field is skipped instead of chasing a control the fixed build
// never registered and aborting the apply. Palette mapping is the one flagged
// field a fixed build keeps live, as an ordinary dropdown.
test('the fixed path skips every topology field the catalog flags', () => {
  const catalog = JSON.parse(ENGINE_CATALOG);
  const flagged = catalog.operators.flatMap((/** @type {*} */ operator) =>
    operator.params.filter((/** @type {*} */ parameter) => parameter.topology === true));
  const values = Object.fromEntries(flagged
    .filter((/** @type {*} */ parameter) => parameter.id !== 'palette-mapping')
    .map((/** @type {*} */ parameter) => [`warp1.${parameter.id}`, parameter.default]));
  const engine = fixedEngine(() => true);
  const presets = [{ preset_id: 'noon', values }];

  assert.ok(Object.keys(values).length > 0, 'the catalog flags topology fields');
  assert.equal(applyFixedShaderDocument(
    engine, MODULE, { document: { preset_bank: { presets } } },
    'noon', ['noon'], BAKED), null);
  assert.deepEqual(engine.writes, []);
  assert.ok(flagged.some((/** @type {*} */ parameter) =>
    parameter.id === 'palette-mapping'));
  assert.equal(BAKED.has('palette-mapping'), false);
});

const PATTERNS = new URL('../shader/patterns/', import.meta.url);
/** @param {string} filename */
const promotedDocument = (filename) =>
  JSON.parse(readFileSync(new URL(filename, PATTERNS), 'utf8'));
const PROMOTED = promotedDocument('shaderball_migration.json').source_documents;

// The compiled build hard-codes these values, so it registers no control for
// them; without the skip the apply refuses on the first one and writes nothing.
test('the fixed path skips the ids the compiled build bakes in as constants', () => {
  const engine = fixedEngine(() => true);
  const values = { 'camera.spin-speed': 0.01975, 'sample.pattern-freq': 3 };
  const presets = [{ preset_id: 'noon', values }];

  assert.ok(BAKED_CONSTANT_IDS.has('camera.spin-speed'));
  assert.equal(applyFixedShaderDocument(
    engine, MODULE, { document: { preset_bank: { presets } } },
    'noon', ['noon'], BAKED), null);
  assert.deepEqual(engine.writes, [['Pattern Freq', 3]]);
});

// Ash Cloud is the document that carries a baked constant, against an engine
// standing in for its compiled build: every other id resolves, and AshCloud
// registers no Camera Spin Speed because CAMERA_SPIN_RATE is a constant.
test('every ash-cloud preset value reaches its compiled build', () => {
  const ashCloud = promotedDocument(PROMOTED['ash-cloud']);
  const ids = Object.keys(ashCloud.preset_bank.presets[0].values);
  const definitions = ids
    .filter((id) => !BAKED.has(id.slice(id.indexOf('.') + 1)))
    .map((id) => ({ name: engineParameterName(id) }))
    .filter((definition) => definition.name !== 'Camera Spin Speed');
  const engine = fixedEngine(() => true);
  engine.getParameterDefinitions = () => definitions;

  assert.ok(ids.includes('camera.spin-speed'));
  assert.equal(applyFixedShaderDocument(
    engine, MODULE, { document: ashCloud }, 'ash-cloud', ['ash-cloud'], BAKED), null);
  assert.equal(engine.writes.some(([name]) => name === 'Camera Spin Speed'), false);
  assert.equal(engine.writes.length, definitions.length);
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

const MIGRATION = JSON.stringify({
  source_documents: { KaleidoscopeFlowers: 'kaleidoscope_flowers.shader.json' },
  product_group: { children: [{ effect_id: 'KaleidoscopeFlowers', display_name: 'Kaleidoscope Flowers' }] },
});

/** @param {{digest?: string, status?: string, diagnostics?: *}} [shape] */
const shaderDocument = ({ digest = 'digest-equator', status = 'VALID',
                          diagnostics = undefined } = {}) => JSON.stringify({
  status,
  diagnostics,
  descriptor_digest: digest,
  document: {
    effect_id: 'KaleidoscopeFlowers',
    effect_metadata: { display_name: 'Kaleidoscope Flowers' },
    descriptor: { chain: [{ label: 'sample', operator: 'sample.grid.v2' }] },
    preset_bank: { presets: [
      { preset_id: 'noon', display_name: 'Noon', values: { 'sample.pattern-freq': 2 } },
      { preset_id: 'dusk', display_name: 'Dusk', values: { 'sample.pattern-freq': 5 } },
    ] },
  },
});

/** @returns {Object} An engine whose parameter definitions follow its writes. */
function workbenchEngine() {
  // 'Pattern Freq' serves the fixed path's alias lookup; the raw parameter ids
  // are what a setShaderChain-programmed chain registers, and the scratch
  // document is the chain the page opens on.
  const definitions = [
    { name: 'Pattern Freq', value: 1 },
    { name: 'sample.pattern-freq', value: 1 },
    ...SCRATCH.descriptor.parameters.map((parameter) => parameter.storage === 'enum8'
      ? { name: parameter.id, value: parameter.domain.values.indexOf(parameter.default),
          options: [...parameter.domain.values] }
      : { name: parameter.id, value: parameter.default }),
  ];
  const writes = [];
  const selected = [];
  const chained = [];
  return {
    definitions,
    writes,
    selected,
    chained,
    selectPresetById: (id) => { selected.push(id); return true; },
    setShaderChain: (entries) => {
      chained.push(entries);
      return { code: 'APPLIED', entryIndex: -1 };
    },
    getParamGeneration: () => chained.length,
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
 * @param {{files?: Object, engine?: *, selectEffect?: (effect: string) => boolean,
 *   initialEffect?: string|null}} [seams]
 * @returns {Object} The controller and everything it wrote to.
 */
function workbench({ files = { 'kaleidoscope_flowers.shader.json': shaderDocument() },
                     engine = workbenchEngine(),
                     selectEffect = () => true,
                     initialEffect = null } = {}) {
  const elements = new Map(['shader-document-select', 'shader-preset-select',
    'shader-document-open', 'shader-document-save', 'shader-document-file',
    'shader-document-status', 'shader-parity-toggle', 'shader-document-save-as',
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
      if (name === 'engine_catalog.json') return ENGINE_CATALOG;
      const source = files[name];
      if (source === undefined) throw new Error(`404 ${name}`);
      return source;
    },
    // The fixtures are compiler results already; a document object is the
    // scratch build, which the fake passes through as its own compile.
    importCompiler: async () => ({
      compileShaderDocument: (s) => typeof s === 'string'
        ? JSON.parse(s)
        : { status: 'VALID', descriptor_digest: 'digest-scratch', document: s },
      // The fixtures are not whole documents, so the canonicalizer would refuse
      // them; the real module's export is pinned in editorWorkbench.
      exportShaderDocumentJson: (document) =>
        `${JSON.stringify(document, null, 2)}\n`,
    }),
    download: (filename, source) => downloads.push([filename, source]),
    initialEffect,
  });
  return { controller, elements, downloads, selections, engine, ran };
}

/** @param {Object} element @returns {Function} The element's change handler. */
const onChange = (element) =>
  element.listeners.find((listener) => listener.type === 'change').handler;

// §4.5: init() opens the scratch document, so every later assertion about the
// engine reads past the writes that opening preview made.
const SCRATCH_WRITES = SCRATCH.descriptor.parameters.length;

/** @param {Object} harness @returns {Promise<void>} */
async function chooseCatalogSource({ elements, controller }) {
  await controller.init();
  const select = elements.get('shader-document-select');
  select.value = 'KaleidoscopeFlowers';
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
  assert.deepEqual(select.options.map((option) => option.value), ['', 'KaleidoscopeFlowers']);
  assert.deepEqual(select.options.map((option) => option.textContent),
    ['Scratch shader', 'Kaleidoscope Flowers']);
  const status = elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'ok');
  assert.match(status.textContent, /Scratch Chain · Catalog Defaults/,
    'the page opens rendering the scratch chain');
});

// init() reports through the status element and a return value the page drops,
// so a catalog that never loaded is a line of prose on an otherwise live page:
// the boolean is the only channel a caller can act on.
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

// The simulator redirects a shader-document deep link here, so the id it
// carries has to open that document rather than the scratch chain.
test('a deep-linked document id opens that document', async () => {
  const harness = workbench({ initialEffect: 'KaleidoscopeFlowers' });

  assert.equal(await harness.controller.init(), true);

  assert.equal(harness.elements.get('shader-document-select').value, 'KaleidoscopeFlowers');
  assert.deepEqual(harness.engine.chained.at(-1),
    [{ instance: 'sample', operator: 'sample.grid.v2' }]);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Kaleidoscope Flowers · Noon/);
});

// §4.5: the legacy Shader route names no document, and neither does a
// stale id, so both open the scratch chain.
test('a deep link naming no catalog document opens the scratch chain', async () => {
  for (const initialEffect of ['Shader', 'retired-pattern', null]) {
    const harness = workbench({ initialEffect });

    assert.equal(await harness.controller.init(), true);

    assert.equal(harness.elements.get('shader-document-select').value, '');
    assert.match(harness.elements.get('shader-document-status').textContent,
      /Scratch Chain · Catalog Defaults/);
  }
});

// §4.6: no separate read-only mode. A shipped pattern previews through
// the interpreter exactly as a scratch chain does; the digest match only arms
// the parity toggle to the promoted build.
test('choosing a catalog source previews it through the interpreter', async () => {
  const harness = workbench();

  await chooseCatalogSource(harness);

  assert.deepEqual(harness.selections, ['ShaderChain', 'ShaderChain']);
  assert.deepEqual(harness.engine.selected, [],
    'no fixed-effect reference preset is staged for an interpreted load');
  assert.deepEqual(harness.engine.chained.at(-1),
    [{ instance: 'sample', operator: 'sample.grid.v2' }]);
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

  assert.equal(harness.selections.at(-1), 'ShaderChain');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(harness.engine.writes.at(-1), ['sample.pattern-freq', 2]);
});

// A study no shipped pattern digests to has no promoted build to compare
// against, so it loads on the interpreter with the toggle disarmed.
test('an imported study the catalog does not carry has no parity build', async () => {
  const harness = workbench();
  await harness.controller.init();

  assert.equal(await harness.controller.loadSource(
    shaderDocument({ digest: 'digest-study' }), 'study.shader.json'), true);
  assert.deepEqual(harness.selections, ['ShaderChain', 'ShaderChain']);
  assert.deepEqual(harness.engine.selected, [],
    'the dynamic path stages no fixed-effect reference preset');
  assert.deepEqual(harness.engine.chained.at(-1),
    [{ instance: 'sample', operator: 'sample.grid.v2' }]);
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

test('a setShaderChain refusal is surfaced with its code', async () => {
  const engine = workbenchEngine();
  engine.setShaderChain = (entries) => {
    engine.chained.push(entries);
    return { code: 'ARENA_OVERFLOW', entryIndex: -1 };
  };
  const harness = workbench({ engine });
  await harness.controller.init();

  assert.equal(await harness.controller.loadSource(
    shaderDocument({ digest: 'digest-study' }), 'study.shader.json'), false);
  assert.deepEqual(harness.engine.writes, []);
  const status = harness.elements.get('shader-document-status');
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

// README §9: unknown or invalid semantics leave the current preview untouched,
// so a compiler that throws on the input rather than diagnosing it must not
// take the loaded document down with it either.
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

// §4.4: every edit is a document edit, so Save serializes the document
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

// The workbench roster is what the page's deep-link validator and its
// resolution correction are both built from, so an effect the controller
// selects but the roster omits survives the load and is dropped on the next
// reload or resolution change.
test('the workbench roster admits every effect the controller selects', async () => {
  const harness = workbench();
  await harness.controller.init();
  await harness.controller.loadSource(
    shaderDocument({ digest: 'digest-study' }), 'study.shader.json');
  const select = harness.elements.get('shader-document-select');
  select.value = '';
  await onChange(select)();

  assert.deepEqual(harness.selections, ['ShaderChain', 'ShaderChain', 'ShaderChain']);
  for (const effect of harness.selections) {
    assert.ok(WORKBENCH_EFFECTS.includes(effect),
      `the workbench page must know the effect "${effect}"`);
  }
});

// §4.5: the scratch source is a document like any other — returning to it
// reopens the default chain on the interpreter, rendering from the first frame.
test('returning to the scratch source reopens the default chain', async () => {
  const harness = workbench();
  await chooseCatalogSource(harness);
  const select = harness.elements.get('shader-document-select');
  select.value = '';

  await onChange(select)();

  assert.deepEqual(harness.selections, ['ShaderChain', 'ShaderChain', 'ShaderChain']);
  const presets = harness.elements.get('shader-preset-select');
  assert.deepEqual(presets.options.map((option) => option.textContent),
    ['Catalog Defaults']);
  assert.equal(presets.disabled, false);
  assert.equal(harness.elements.get('shader-document-save').disabled, false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /Scratch Chain · Catalog Defaults/);
});

// ── The pipeline strip over the real store, compiler and engine catalog ────

const KALEIDOSCOPE_HEX_BRIGHT = readFileSync(
  new URL('../shader/patterns/kaleidoscope_hex_bright.shader.json', import.meta.url), 'utf8');
const KALEIDOSCOPE_STAINED_GLASS = readFileSync(
  new URL('../shader/patterns/kaleidoscope_stained_glass.shader.json', import.meta.url), 'utf8');
// No source documents: every load misses the fixed-effect digest catalog and
// routes onto the chain engine, where the strip mounts.
const EMPTY_MIGRATION = JSON.stringify({
  source_documents: {}, product_group: { children: [] },
});
// kaleidoscope_hex_bright as a shipped pattern: loading it digests onto a promoted effect, so
// the toolbar's parity toggle arms.
const HEX_MIGRATION = JSON.stringify({
  source_documents: { KaleidoscopeHexBright: 'kaleidoscope_hex_bright.shader.json' },
  product_group: { children: [{ effect_id: 'KaleidoscopeHexBright', display_name: 'Kaleidoscope Hex Bright' }] },
});

/**
 * The promoted build's engine surface: its own reference presets and the
 * alias-named controls kaleidoscope_hex_bright's parameter ids map onto, which is what makes
 * it a different engine surface from the chain interpreter's.
 * @returns {Object} The engine.
 */
function compiledBuildEngine() {
  const definitions = JSON.parse(KALEIDOSCOPE_HEX_BRIGHT).descriptor.parameters.map((parameter) => ({
    name: engineParameterName(parameter.id),
    ...(parameter.storage === 'enum8' ? { options: [...parameter.domain.values] } : {}),
  }));
  const selected = [];
  const writes = [];
  return {
    selected,
    writes,
    selectPresetById: (id) => { selected.push(id); return true; },
    getParameterDefinitions: () => definitions,
    setParameter: (name, value) => {
      writes.push([name, value]);
      return ParamSetResult.APPLIED;
    },
  };
}

/**
 * The document controller over the real compiler, the real chain store, and a
 * FakeChainEngine, with the workbench mounts present and kaleidoscope_hex_bright loaded over
 * the scratch document the page opens on.
 * @param {{source?: string|null, migration?: string, hash?: string,
 *   paused?: boolean}} [seams] - source null
 *   leaves the scratch document loaded.
 * @returns {Promise<Object>} The controller and everything it wrote to.
 */
async function editorWorkbench({
  source = KALEIDOSCOPE_HEX_BRIGHT, migration = EMPTY_MIGRATION, hash = '', paused = false,
  selectEffect = () => true,
} = {}) {
  const engine = new FakeChainEngine();
  const compiledEngine = compiledBuildEngine();
  let animationsPaused = paused;
  // writeDeepLink builds its link state synchronously, reading the pause seam
  // once, so the count tells a write a timer started from one still pending.
  let pausedReads = 0;
  const animationWrites = [];
  const writeParameter = engine.setParameter.bind(engine);
  engine.setParameter = (name, value) => {
    animationsPaused = true;
    return writeParameter(name, value);
  };
  let current = engine;
  const ids = ['shader-document-select', 'shader-preset-select',
    'shader-document-open', 'shader-document-save', 'shader-document-file',
    'shader-document-status', 'shader-document-digest', 'shader-parity-toggle',
    'shader-animation-toggle', 'shader-document-save-as'];
  const elements = new Map(ids.map((id) =>
    [id, fakeElement(id.endsWith('select') ? 'select' : 'div')]));
  for (const mount of ['chain-strip']) {
    const element = fakeElement('section');
    element.setPointerCapture = () => {};
    element.hasPointerCapture = () => true;
    element.releasePointerCapture = () => {};
    elements.set(mount, element);
  }
  const doc = installDocument({
    body: fakeElement('body'),
    activeElement: null,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => fakeElement(tag),
    ...documentEvents(),
  });
  const downloads = [];
  const selections = [];
  const filters = [];
  const urls = [];
  const location = {
    pathname: '/tools/shader.html', search: '?effect=Shader', hash,
  };
  const win = {
    location,
    history: {
      replaceState: (_state, _title, url) => {
        urls.push(url);
        const next = new URL(url, 'https://example.test');
        location.pathname = next.pathname;
        location.search = next.search;
        location.hash = next.hash;
      },
    },
  };
  const ran = { gui: 0, invalidated: 0 };
  const controller = createShaderDocumentController({
    doc,
    getEngine: () => current,
    getModule: () => MODULE,
    selectEffect: (effect) => {
      selections.push(effect);
      if (!selectEffect(effect)) return false;
      current = effect === 'ShaderChain' ? engine : compiledEngine;
      return true;
    },
    syncEffectGui: () => { ran.gui += 1; },
    invalidate: () => { ran.invalidated += 1; },
    getAnimationsPaused: () => { pausedReads += 1; return animationsPaused; },
    setAnimationsPaused: (paused) => {
      animationsPaused = paused;
      animationWrites.push(paused);
    },
    setParamFilter: (filter) => filters.push(filter),
    fetchText: async (url) => {
      const name = String(url).split('/').pop();
      if (name === 'shaderball_migration.json') return migration;
      if (name === 'engine_catalog.json') return ENGINE_CATALOG;
      if (name === 'kaleidoscope_hex_bright.shader.json') return KALEIDOSCOPE_HEX_BRIGHT;
      throw new Error(`404 ${name}`);
    },
    importCompiler: () => import('../shader/shader_workbench.mjs'),
    download: (filename, source) => downloads.push([filename, source]),
    win,
  });
  assert.equal(await controller.init(), true);
  if (source !== null)
    assert.equal(await controller.loadSource(source, 'study.shader.json'), true);
  await controller.flushDeepLink();
  return {
    controller, engine, compiledEngine, elements, downloads, selections, filters, ran,
    animationFrames, animationWrites, animationsPaused: () => animationsPaused,
    pausedReads: () => pausedReads, urls, win,
  };
}

/**
 * Activates one operator's entry in the plane band's + palette: an entry the
 * gap accepts commits the insertion, one it refuses announces its reason.
 * @param {Object} harness - An editorWorkbench() result.
 * @param {string} operatorId - The catalog operator to activate.
 * @returns {void}
 */
function clickPlaneBandEntry(harness, operatorId) {
  const mount = harness.elements.get('chain-strip');
  mount.querySelectorAll('.chain-band')
    .find((band) => band.dataset.carrier === 'plane')
    .querySelector('.chain-band-add').dispatch('click');
  mount.querySelectorAll('.chain-palette-entry')
    .find((entry) => entry.dataset.operator === operatorId)
    .dispatch('click');
}

const stripChips = (harness) =>
  harness.elements.get('chain-strip').querySelectorAll('.chain-chip');

const displayedParameter = (harness, label, parameterId) => stripChips(harness)
  .find((chip) => chip.dataset.label === label)
  .querySelectorAll('.chain-param')
  .find((row) => row.dataset.parameter === parameterId)
  .querySelector('.chain-param-value').value;

// §4.5: the workbench opens on a valid, rendering document with the whole
// authoring surface live — the scratch chain is edited exactly like a load.
test('the scratch document opens as a live, editable chain', async () => {
  const harness = await editorWorkbench({ source: null });

  assert.deepEqual(harness.selections, ['ShaderChain']);
  assert.deepEqual(harness.engine.chainCalls.at(-1).map((entry) => entry.operator),
    ['sphere.rotate.v2', 'project.stereographic.v2', 'sample.grid.v2',
      'colorize.generated-palette.v2']);
  assert.deepEqual(stripChips(harness).map((chip) => chip.dataset.label),
    ['rotate', 'project', 'sample', 'colorize']);
  assert.deepEqual(
    harness.elements.get('shader-preset-select').options.map((o) => o.value),
    ['catalog-defaults']);
  assert.ok(harness.engine.writes.some(([name]) => name === 'colorize.palette-chroma'),
    'the opening preview carries the catalog defaults');

  clickPlaneBandEntry(harness, 'warp.affine.v2');

  assert.equal(harness.engine.chainCalls.at(-1).length, 5);
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
    await harness.controller.loadSource(KALEIDOSCOPE_HEX_BRIGHT, 'other.shader.json'), false);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /rejected effect "ShaderChain"/);
  assert.deepEqual(stripChips(harness).map((chip) => chip.dataset.label), before,
    'the refused load must leave the editor it would have replaced');
});

// The chain program is written last, so a refusal between the adoption and the
// program leaves the engine on the document that was already loaded; the
// toolbar has to keep naming that one.
test('a link whose bypass the store refuses leaves the toolbar on the loaded document', async () => {
  const harness = await editorWorkbench();
  const digest = harness.elements.get('shader-document-digest').dataset.digest;
  const presets = harness.elements.get('shader-preset-select').options.map((o) => o.value);
  const programs = harness.engine.chainCalls.length;

  const document = JSON.parse(KALEIDOSCOPE_HEX_BRIGHT);
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

test('a shader state link restores its document, preset, bypasses, and pause', async () => {
  const document = JSON.parse(KALEIDOSCOPE_HEX_BRIGHT);
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
    ['lens', 'project', 'warp2', 'sample', 'colorize']);
  assert.equal(stripChips(harness).find((chip) => chip.dataset.label === 'camera')
    .querySelector('.chain-chip-bypass').getAttribute('aria-pressed'), 'true');
});

test('shader edits keep the full state hash current', async () => {
  const harness = await editorWorkbench({ source: null });
  clickPlaneBandEntry(harness, 'warp.affine.v2');
  stripChips(harness).find((chip) => chip.dataset.label === 'rotate')
    .querySelector('.chain-chip-bypass').dispatch('click');
  const value = stripChips(harness).find((chip) => chip.dataset.label === 'sample')
    .querySelectorAll('.chain-param')
    .find((row) => row.dataset.parameter === 'sample.pattern-freq')
    .querySelector('.chain-param-value');
  value.value = '3.5';
  value.dispatch('change');
  harness.elements.get('shader-animation-toggle').dispatch('click');
  await harness.controller.flushDeepLink();

  const state = await decodeShaderStateHash(harness.win.location.hash);
  assert.equal(state.document.descriptor.chain.length, 5);
  assert.equal(state.preset, 'catalog-defaults');
  assert.deepEqual(state.bypassed, ['rotate']);
  assert.equal(state.paused, true);
  assert.equal(state.document.preset_bank.presets[0]
    .values['sample.pattern-freq'], 3.5);
});

const sampleFrequencySlider = (harness) => stripChips(harness)
  .find((chip) => chip.dataset.label === 'sample')
  .querySelectorAll('.chain-param')
  .find((row) => row.dataset.parameter === 'sample.pattern-freq')
  .querySelector('.chain-param-control');

// The chips carry the inline stage controls, and they render one preset's
// values. Eight shipped documents have more than one.
test('a deep-linked preset builds the strip from the preset it renders', async () => {
  const document = JSON.parse(KALEIDOSCOPE_HEX_BRIGHT);
  document.preset_bank.presets[0].values['sample.pattern-freq'] = 1.5;
  const preset = document.preset_bank.presets[1];
  preset.values['sample.pattern-freq'] = 7.25;
  const hash = await encodeShaderStateHash({
    document, preset: preset.preset_id, bypassed: [], paused: false,
  });

  const harness = await editorWorkbench({ source: null, hash });

  assert.equal(sampleFrequencySlider(harness).value, '7.25');
  assert.equal(stripChips(harness).find((chip) => chip.dataset.label === 'sample')
    .querySelectorAll('.chain-param')
    .find((row) => row.dataset.parameter === 'sample.pattern-freq')
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
      mock.timers.tick(50);
    }

    assert.equal(harness.urls.length, 0);
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
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    harness.urls.length = 0;
    const slider = sampleFrequencySlider(harness);
    for (let value = 2; value <= 8; value += 1) {
      slider.value = String(value);
      slider.dispatch('input');
      harness.animationFrames.flush();
      if (value < 8) mock.timers.tick(150);
    }
    const reads = harness.pausedReads();
    mock.timers.tick(SHADER_LINK_MAX_WAIT_MS - 900);
    assert.ok(harness.pausedReads() > reads, 'the max-wait timer started the write');
    mock.timers.reset();
    await harness.controller.flushDeepLink();

    assert.equal(harness.urls.length, 1);
  } finally {
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

    slider.dispatch('change');
    await harness.controller.flushDeepLink();

    assert.equal(harness.urls.length, 1);
    const state = await decodeShaderStateHash(harness.win.location.hash);
    assert.equal(state.document.preset_bank.presets[0]
      .values['sample.pattern-freq'], 6.25);
  } finally {
    mock.timers.reset();
  }
});

test('save flushes the last slider input before its animation frame', async () => {
  const harness = await editorWorkbench({ source: null });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    harness.urls.length = 0;
    const slider = sampleFrequencySlider(harness);
    slider.value = '7.5';
    slider.dispatch('input');

    assert.equal(harness.controller.save(), true);
    await harness.controller.flushDeepLink();

    assert.equal(harness.urls.length, 1);
    const state = await decodeShaderStateHash(harness.win.location.hash);
    assert.equal(state.document.preset_bank.presets[0]
      .values['sample.pattern-freq'], 7.5);
  } finally {
    mock.timers.reset();
  }
});

test('a malformed shader state link falls back to an editable scratch chain', async () => {
  const harness = await editorWorkbench({
    source: null, hash: '#shader=v1.not-gzip',
  });

  assert.deepEqual(harness.engine.chainCalls.at(-1).map((entry) => entry.operator),
    ['sphere.rotate.v2', 'project.stereographic.v2', 'sample.grid.v2',
      'colorize.generated-palette.v2']);
  assert.match(harness.elements.get('shader-document-status').textContent,
    /shader link could not be restored: invalid shader link payload/i);
});

test('a dynamic document builds the strip, and edits re-apply through the engine', async () => {
  const harness = await editorWorkbench();
  assert.deepEqual(harness.selections, ['ShaderChain', 'ShaderChain']);
  assert.equal(harness.engine.chainCalls.length, 2);
  assert.equal(harness.engine.chainCalls.at(-1).length, 6);
  assert.equal(stripChips(harness).length, 6);
  const digest = compileShaderDocument(KALEIDOSCOPE_HEX_BRIGHT,
    { catalog: JSON.parse(ENGINE_CATALOG) }).descriptor_digest;
  assert.equal(harness.elements.get('shader-document-digest').dataset.digest, digest,
    'the toolbar carries the whole descriptor digest');
  assert.equal(harness.elements.get('shader-document-digest').textContent,
    digest.slice(0, 12), 'the toolbar shows the digest abbreviated');

  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(harness.engine.chainCalls.length, 3);
  assert.equal(harness.engine.chainCalls.at(-1).length, 7);
  assert.ok(harness.engine.writes.some(([name]) => name === 'wave-shear1.strength'),
    'the re-apply carries the backfilled catalog defaults');

  // Save exports the store's edited document, not the load-time compile.
  assert.equal(harness.controller.save(), true);
  const saved = JSON.parse(harness.downloads[0][1]);
  assert.equal(saved.descriptor.chain.length, 7);
  assert.ok(Object.keys(saved.preset_bank.presets[0].values)
    .some((id) => id.startsWith('wave-shear1.')));
});

test('Kaleidoscope Stained Glass loads its effect preset into the interpreter controls', async () => {
  const harness = await editorWorkbench({ source: KALEIDOSCOPE_STAINED_GLASS });
  const values = JSON.parse(KALEIDOSCOPE_STAINED_GLASS).preset_bank.presets[0].values;

  assert.deepEqual(harness.engine.chainCalls.at(-1).map((entry) => entry.operator), [
    'sphere.rotate.v2',
    'sphere.lens.kaleidoscope.v2',
    'project.gnomonic.v2',
    'warp.vector-noise.v2',
    'warp.mirror-tile.v2',
    'sample.grid.v2',
    'colorize.generated-palette.v2',
  ]);
  for (const [label, parameterId] of [
    ['camera', 'camera.wander'],
    ['project', 'project.singularity-fade'],
    ['warp1', 'warp1.strength'],
    ['warp2', 'warp2.speed'],
    ['sample', 'sample.pattern-freq'],
    ['colorize', 'colorize.brightness-depth'],
  ]) {
    assert.ok(Math.abs(Number(displayedParameter(harness, label, parameterId))
      - Number(values[parameterId])) <= 1e-6,
    `${parameterId} displays the effect preset`);
    assert.ok(harness.engine.writes.some(([name, value]) =>
      name === parameterId && value === Number(values[parameterId])),
    `${parameterId} reaches the interpreter`);
  }
});

test('preset and stage writes preserve the animation state', async () => {
  const harness = await editorWorkbench();
  const toggle = harness.elements.get('shader-animation-toggle');
  assert.equal(harness.animationsPaused(), false,
    'preset writes do not leave the chain frozen');
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.textContent, 'Pause animation');

  stageEditor(harness, 'sample')('sample.pattern-freq', 7);
  assert.equal(harness.animationsPaused(), false,
    'an inline stage edit restores the running state after the engine write');

  toggle.dispatch('click');
  assert.equal(harness.animationsPaused(), true);
  assert.equal(toggle.textContent, 'Resume animation');
  stageEditor(harness, 'sample')('sample.pattern-freq', 8);
  assert.equal(harness.animationsPaused(), true,
    'an edit also preserves an intentional pause');
});

// §4.6/§4.8: a descriptor edit breaks the match with the promoted
// build and disarms the toggle. A bypass is a program-shape override and a dock
// edit writes a preset value, so neither touches the descriptor digest.
test('the parity toggle disarms on a descriptor edit, not on a bypass', async () => {
  const harness = await editorWorkbench({ migration: HEX_MIGRATION });
  const toggle = harness.elements.get('shader-parity-toggle');
  assert.equal(toggle.disabled, false, 'the loaded digest matches a promoted effect');
  assert.deepEqual(harness.selections, ['ShaderChain', 'ShaderChain'],
    'a shipped pattern still previews through the interpreter');

  stripChips(harness).find((chip) => chip.dataset.label === 'lens')
    .querySelector('.chain-chip-bypass').dispatch('click');
  assert.equal(toggle.disabled, false);

  stageEditor(harness, 'sample')('sample.pattern-freq', 7);
  assert.equal(toggle.disabled, false);

  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(toggle.disabled, true);
});

test('a descriptor edit under the compiled build returns the preview to the interpreter', async () => {
  const harness = await editorWorkbench({ migration: HEX_MIGRATION });
  const status = harness.elements.get('shader-document-status');
  const toggle = harness.elements.get('shader-parity-toggle');

  toggle.dispatch('click');

  assert.equal(harness.selections.at(-1), 'KaleidoscopeHexBright');
  assert.deepEqual(harness.compiledEngine.selected, ['hex-twin-wave']);
  assert.ok(harness.compiledEngine.writes.some(([name]) => name === 'Camera Wander'),
    'the compiled build takes the preset through its own control names');
  assert.match(status.textContent, /compiled build/);

  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(harness.selections.at(-1), 'ShaderChain');
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(harness.engine.chainCalls.at(-1).length, 7,
    'the edited chain is what renders');
  assert.match(status.textContent, /back on the interpreter/);
});

// §4.5: Save has one format, and it is the canonicalizer's.
test('Save writes the canonical v2 serialization', async () => {
  const harness = await editorWorkbench();

  assert.equal(harness.controller.save(), true);
  const [filename, source] = harness.downloads.at(-1);
  assert.equal(filename, 'study.shader.json');
  assert.equal(source, exportShaderDocumentJson(JSON.parse(KALEIDOSCOPE_HEX_BRIGHT)));
});

// §4.6: Save As is a copy, not a rename - the loaded document and the
// name plain Save re-exports over are both left alone.
test('Save As writes a new document id and leaves the loaded one alone', async () => {
  const harness = await editorWorkbench();

  assert.equal(harness.controller.saveAs(), true);
  const [copyName, copySource] = harness.downloads.at(-1);
  const copy = JSON.parse(copySource);
  assert.equal(copy.document_id, 'kaleidoscope-hex-bright-v1-copy1');
  assert.equal(copyName, 'kaleidoscope-hex-bright-v1-copy1.shader.json');
  assert.equal(copySource, exportShaderDocumentJson(copy),
    'a copy is written in the same canonical serialization as Save');

  assert.equal(harness.controller.save(), true);
  const [savedName, savedSource] = harness.downloads.at(-1);
  assert.equal(savedName, 'study.shader.json');
  assert.equal(JSON.parse(savedSource).document_id, 'kaleidoscope-hex-bright-v1');

  assert.equal(harness.controller.saveAs(), true);
  assert.equal(JSON.parse(harness.downloads.at(-1)[1]).document_id,
    'kaleidoscope-hex-bright-v1-copy2', 'each copy takes an id of its own');
});

test('a Save As copy carries the edits made since the load', async () => {
  const harness = await editorWorkbench();
  clickPlaneBandEntry(harness, 'warp.wave-shear.v2');

  assert.equal(harness.controller.saveAs(), true);
  const copy = JSON.parse(harness.downloads.at(-1)[1]);
  assert.equal(copy.descriptor.chain.length, 7);
  assert.deepEqual(
    validateShaderDocument(copy, { catalog: JSON.parse(ENGINE_CATALOG) }), []);
});

test('stage controls stay expanded and source function is directly selectable', async () => {
  const harness = await editorWorkbench();
  const lens = stripChips(harness).find((chip) => chip.dataset.label === 'lens');
  assert.deepEqual(lens.querySelectorAll('.chain-param')
    .map((row) => row.dataset.parameter), ['lens.symmetry']);

  const source = stripChips(harness).find((chip) => chip.dataset.label === 'sample');
  const select = source.querySelector('.chain-chip-replace');
  assert.equal(select.getAttribute('aria-label'), 'Source function');
  assert.equal(select.options.every((option) => option.value.startsWith('sample.')), true);
  select.value = 'sample.rings.v2';
  select.dispatch('change');

  assert.ok(harness.engine.chainCalls.at(-1)
    .some((entry) => entry.operator === 'sample.rings.v2'));
});

test('an add menu omits stages that are invalid at its gap', async () => {
  const harness = await editorWorkbench();
  const plane = harness.elements.get('chain-strip').querySelectorAll('.chain-band')
    .find((band) => band.dataset.carrier === 'plane');
  plane.querySelector('.chain-band-add').dispatch('click');
  const entries = harness.elements.get('chain-strip')
    .querySelectorAll('.chain-palette-entry');
  assert.equal(entries.some((entry) => entry.dataset.operator === 'sphere.rotate.v2'),
    false);
  assert.equal(entries.every((entry) => entry.getAttribute('aria-disabled') === null),
    true);
});

test('a bypass reshapes the engine program while the saved document keeps the stage', async () => {
  const harness = await editorWorkbench();
  const writesBefore = harness.engine.writes.length;
  stripChips(harness).find((chip) => chip.dataset.label === 'lens')
    .querySelector('.chain-chip-bypass').dispatch('click');

  const shape = harness.engine.chainCalls.at(-1);
  assert.equal(shape.length, 5);
  assert.ok(!shape.some((entry) => entry.instance === 'lens'));
  assert.ok(harness.engine.writes.length > writesBefore,
    'the re-apply rewrote the surviving instances');
  assert.ok(!harness.engine.writes.slice(writesBefore)
    .some(([name]) => name.startsWith('lens.')),
  'a bypassed instance registers no parameters, so its values are skipped');

  assert.equal(harness.controller.save(), true);
  const saved = JSON.parse(harness.downloads.at(-1)[1]);
  assert.equal(saved.descriptor.chain.length, 6);
  assert.ok(saved.descriptor.chain.some((entry) => entry.label === 'lens'),
    'bypass is session state, never serialized');
});

/**
 * Selects a chip and hands back a writer over its inline controls, driving the
 * control the way a pointer does.
 * @param {Object} harness - An editorWorkbench() result.
 * @param {string} label - The instance to select.
 * @returns {(parameterId: string, value: *) => void} The control writer.
 */
function stageEditor(harness, label) {
  stripChips(harness).find((chip) => chip.dataset.label === label).dispatch('click');
  return (parameterId, value) => {
    const control = stripChips(harness)
      .find((chip) => chip.dataset.label === label)
      .querySelectorAll('.chain-param')
      .find((row) => row.dataset.parameter === parameterId)
      .querySelector('.chain-param-control');
    control.value = String(value);
    const eventType = control.tagName === 'SELECT' ? 'change' : 'input';
    control.dispatch(eventType);
    if (eventType === 'input') harness.animationFrames.flush();
  };
}

const savedValues = (harness) => {
  assert.equal(harness.controller.save(), true);
  return JSON.parse(harness.downloads.at(-1)[1]).preset_bank.presets[0].values;
};

// §4.4: a chip control's edit is a document edit, and the engine write is its
// side effect, so Save reads the document and nothing else.
test('a chip control writes the active preset and survives Save without an engine read', async () => {
  const harness = await editorWorkbench();

  stageEditor(harness, 'sample')('sample.pattern-freq', 7);
  stageEditor(harness, 'colorize')('colorize.palette-mapping', 'bell');
  assert.ok(harness.engine.writes.some(
    ([name, value]) => name === 'sample.pattern-freq' && value === 7),
  'the engine takes the edit as it lands');
  assert.ok(harness.engine.writes.some(
    ([name, value]) => name === 'colorize.palette-mapping' && value === 1),
  'an enum reaches the engine as its option index');
  harness.engine.getParameterDefinitions = () => {
    throw new Error('Save must not read the engine');
  };

  const values = savedValues(harness);
  assert.equal(values['sample.pattern-freq'], 7);
  assert.equal(values['colorize.palette-mapping'], 'bell',
    'the document stores the option id');
});

test('a chip control edit outside the parameter domain is announced, not stored', async () => {
  const harness = await editorWorkbench();
  const before = savedValues(harness)['sample.pattern-freq'];

  stageEditor(harness, 'sample')('sample.pattern-freq', 500);

  const status = harness.elements.get('shader-document-status');
  assert.equal(status.dataset.status, 'error');
  assert.match(status.textContent, /sample\.pattern-freq.*bounds/);
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

  strip.querySelector('.chain-undo').dispatch('click');

  assert.equal(savedValues(harness)['sample.pattern-freq'], opening);
  assert.equal(strip.querySelector('.chain-undo').disabled, true);
  assert.ok(harness.engine.writes.some(
    ([name, value]) => name === 'sample.pattern-freq' && value === opening),
  'undoing the edit re-applies the restored value to the engine');
});

test('legacy custom Shader URLs preserve their state on the workbench route', () => {
  assert.equal(
    shaderWorkbenchUrl('https://example.test/daydream/index.html?effect=ShaderBall&fx.Speed=2#preview'),
    '/daydream/tools/shader.html?effect=Shader&fx.Speed=2#preview',
  );
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
