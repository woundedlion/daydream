import {
  BAKED_CONSTANT_IDS, bakedTopologyFields, fixedDerivedBinding, engineControlNames,
  compileShaderDocument, DEFAULT_LIMITS, exportShaderDocumentJson, validateShaderDocument,
} from '../../generated/shader/shader_workbench.mjs';
import {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { scratchChainDocument } from '../../src/workbench/shader/chain_document_store.js';
import { chainStudyDocument, withPreset } from './chain_study.js';

import {applyFixedShaderDocument, createShaderDocumentController} from '../../src/workbench/shader/shader_documents.js';
import {FakeChainEngine, ParamSetResult, ChainSnapshotRestoreResult} from './fake_engine.js';
import {
  documentEvents, fakeElement, installAnimationFrames, installDocument,
  restoreDocumentAfterEach,
} from './fake_dom.js';

const primaryName = (id, descriptor) => engineControlNames(id, descriptor)[0];

const ownedEditors = new Set();

afterEach(async () => {
  for (const controller of ownedEditors) await controller.dispose();
  ownedEditors.clear();
});

const INDEX = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

const WORKBENCH = readFileSync(new URL('../../tools/shader.html', import.meta.url), 'utf8');

const ENGINE_CATALOG = readFileSync(
  new URL('../../generated/shader/engine_catalog.json', import.meta.url), 'utf8');

// The document the workbench opens on, built from the same catalog the
// page fetches, so the fakes register exactly what the scratch chain would.
const SCRATCH = scratchChainDocument(JSON.parse(ENGINE_CATALOG));

restoreDocumentAfterEach();

let animationFrames;

beforeEach(() => { animationFrames = installAnimationFrames(); });

afterEach(() => { animationFrames.restore(); });

/** @param {string} field The plain Title Case control name an alias-free label yields. */
const plainName = (field) => field.split('-').map((part) => part.length === 0
  ? part : part[0].toUpperCase() + part.slice(1)).join(' ');

const MODULE = { ParamSetResult, ChainSnapshotRestoreResult, ShaderChainBindings: { getShaderChainCatalog: () => ENGINE_CATALOG } };

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
    getDocumentParameterDefinitions: () => [],
    setDocumentParameter: () => ParamSetResult.UNKNOWN_PARAM,
    setParameter: (name, value) => {
      writes.push([name, value]);
      return ParamSetResult.APPLIED;
    },
  };
}

const PATTERNS = new URL('../../generated/shader/patterns/', import.meta.url);

/** @param {string} filename */
const promotedDocument = (filename) => {
  const document = JSON.parse(readFileSync(new URL(filename, PATTERNS), 'utf8'));
  return document.descriptor ? compileShaderDocument(document, {catalog: JSON.parse(ENGINE_CATALOG)}).document : document;
};

const PROMOTED = promotedDocument('catalog.json').source_documents;

const affinePeriodDocument = (period, scale = 2) => ({ document: {
  descriptor: { chain: [
    { label: 'warp1', operator: 'warp.affine.v4' },
    { label: 'cells', operator: 'sample.tessellation.v3' },
  ] },
  preset_bank: { presets: [{ preset_id: 'noon', values: {
    'cells.cell-scale': scale,
    'warp1.lattice-period': period,
  } }] },
} });

const PATTERN_CATALOG = singlePatternCatalog('KaleidoscopeFlowers', 'kaleidoscope_flowers.shader.json', 'Kaleidoscope Flowers');

/** @param {{digest?: string, status?: string, diagnostics?: *}} [shape] */
const shaderDocument = ({ digest = 'digest-equator', status = 'VALID',
                          diagnostics = undefined } = {}) => JSON.stringify({
  status,
  diagnostics,
  descriptor_digest: digest,
  document: {
    effect_id: 'KaleidoscopeFlowers',
    effect_metadata: { display_name: 'Kaleidoscope Flowers' },
    descriptor: { chain: [{ label: 'sample', operator: 'sample.grid.v4' }] },
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
  const engine = {
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
    setShaderChainParameters: (batch) => {
      for (const { name, value } of batch) {
        writes.push([name, value]);
        const definition = definitions.find((candidate) => candidate.name === name);
        if (definition) definition.value = value;
      }
      return ParamSetResult.APPLIED;
    },
    setParameter: (name, value) => {
      writes.push([name, value]);
      const definition = definitions.find((candidate) => candidate.name === name);
      if (definition) definition.value = value;
      return ParamSetResult.APPLIED;
    },
  };
  const bindings = {
    setShaderChain: engine.setShaderChain,
    setShaderChainParameters: engine.setShaderChainParameters,
    getSnapshot: () => null,
    delete: () => {},
  };
  delete engine.setShaderChain;
  delete engine.setShaderChainParameters;
  engine.bindings = bindings;
  engine.getShaderChainBindings = () => ({...bindings});
  return engine;
}

/**
 * The shader.html toolbar mounts by id, with the blank scratch entry the
 * source select opens on: without it a select with nothing selected reports
 * the first document the page appends.
 * @returns {Map<string, Object>} Element id to fake element.
 */
function workbenchMounts() {
  const elements = new Map(['shader-document-select', 'shader-preset-select',
    'shader-document-open', 'shader-document-save', 'shader-document-file',
    'shader-document-status', 'shader-document-notice', 'shader-document-error',
    'shader-document-digest', 'shader-parity-toggle',
    'shader-animation-toggle', 'shader-document-save-as',
  ].map((id) => [id, fakeElement(id.endsWith('select') ? 'select' : 'div')]));
  const scratch = fakeElement('option');
  scratch.value = '';
  scratch.textContent = 'Scratch Chain';
  elements.get('shader-document-select').appendChild(scratch);
  elements.get('shader-animation-toggle').textContent = 'Pause Presets';
  return elements;
}

/**
 * A fetchText seam over the pattern directory: the pattern catalog, the
 * engine catalog, and the given documents by file name.
 * @param {Object<string, string>} files - Document source by file name.
 * @param {string} [patternCatalog] - The pattern catalog.
 * @param {string} [engineCatalog] - The engine catalog.
 * @returns {(url: string) => Promise<string>} The router.
 */
function patternFetch(files, patternCatalog = PATTERN_CATALOG, engineCatalog = ENGINE_CATALOG) {
  return async (url) => {
    const name = String(url).split('/').pop();
    if (name === 'catalog.json') return patternCatalog;
    if (name === 'engine_catalog.json') return engineCatalog;
    const source = files[name];
    if (source === undefined) throw new Error(`404 ${name}`);
    return source;
  };
}

/**
 * Builds the workbench document controller over the shader.html control set.
 * @param {{files?: Object, engine?: *, patternCatalog?: string, selectEffect?: (effect: string) => boolean,
 *   initialEffect?: string|null, useDefaultFetch?: boolean,
 *   getAnimationsPaused?: () => boolean,
 *   wrapImportCompiler?: (importer: Function) => Function}} [seams]
 * @returns {Object} The controller and everything it wrote to.
 */
function workbench({ files = { 'kaleidoscope_flowers.shader.json': shaderDocument() },
                     engine = workbenchEngine(),
                     patternCatalog = PATTERN_CATALOG,
                     selectEffect = () => true,
                     getAnimationsPaused,
                     initialEffect = null,
                     useDefaultFetch = false,
                     wrapImportCompiler = (f) => f } = {}) {
  const elements = workbenchMounts();
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
    getAnimationsPaused,
    syncEffectGui: () => { ran.gui += 1; },
    invalidate: () => { ran.invalidated += 1; },
    fetchText: useDefaultFetch ? undefined : patternFetch(files, patternCatalog),
    // The fixtures are compiler results already; a document object is the
    // scratch build, which the fake passes through as its own compile.
    importCompiler: wrapImportCompiler(async () => ({
      DEFAULT_LIMITS,
      fixedDerivedBinding: () => null,
      compileShaderDocument: (s) => typeof s === 'string'
        ? JSON.parse(s)
        : { status: 'VALID', descriptor_digest: 'digest-scratch', document: s },
      // The fixtures are not whole documents, so the canonicalizer would refuse
      // them.
      exportShaderDocumentJson: (document) =>
        `${JSON.stringify(document, null, 2)}\n`,
    })),
    download: (filename, source) => downloads.push([filename, source]),
    initialEffect,
  });
  ownedEditors.add(controller);
  return { controller, elements, downloads, selections, engine, ran };
}

/** @param {Object} element @returns {Function} The element's change handler. */
const onChange = (element) =>
  element.listeners.find((listener) => listener.type === 'change').handler;

// init() opens the scratch document, so every later assertion about the
// engine reads past the writes that opening preview made.
const SCRATCH_WRITES = SCRATCH.descriptor.parameters.length;

/** @param {Object} harness @returns {Promise<void>} */
async function chooseCatalogSource({ elements, controller }) {
  await controller.init();
  const select = elements.get('shader-document-select');
  select.value = 'KaleidoscopeFlowers';
  await onChange(select)();
}

// ── The pipeline strip over the real store, compiler and engine catalog ────

function withoutEmbeddedModulation(source) {
  const document = JSON.parse(source);
  for (const parameter of document.descriptor.parameters) {
    if (parameter.id.endsWith('.modulation-amount'))
      parameter.default = 0;
  }
  for (const preset of document.preset_bank.presets) {
    for (const id of Object.keys(preset.values)) {
      if (id.endsWith('.modulation-amount')) preset.values[id] = 0;
    }
  }
  return exportShaderDocumentJson(document);
}

// The test-owned document the editor workbench opens: two presets that differ
// in one sample value.
const CHAIN_STUDY = exportShaderDocumentJson(withPreset(
  chainStudyDocument(JSON.parse(ENGINE_CATALOG)), 'study-alt', { 'sample.pattern-freq': 2 }));

const KALEIDOSCOPE_STAINED_GLASS = readFileSync(
  new URL('../../generated/shader/patterns/kaleidoscope_stained_glass.shader.json', import.meta.url), 'utf8');

// No source documents: no load matches a promoted digest, so parity stays disarmed.
const EMPTY_PATTERN_CATALOG = JSON.stringify({
  source_documents: {}, product_group: { children: [] },
});

// The study as a shipped pattern: loading it digests onto a promoted effect, so
// the toolbar's parity toggle arms.
const STUDY_PATTERN_CATALOG = singlePatternCatalog('ChainStudy', 'chain_study.shader.json', 'Chain Study');

/**
 * The promoted build's engine surface: its own reference presets and the
 * alias-named controls derived from the supplied fixture. This orchestration
 * double does not model the compiled engine's control set.
 * @returns {Object} The engine.
 */
function compiledBuildEngine(source = CHAIN_STUDY) {
  const document = JSON.parse(source);
  const fixed = (parameter) => {
    const binding = fixedDerivedBinding(document.descriptor, parameter.id,
      document.preset_bank.presets[0].values);
    return binding !== null && binding.unregistered !== true;
  };
  const definitions = document.descriptor.parameters.filter((parameter) =>
    !BAKED_CONSTANT_IDS.has(parameter.id) && !BAKED.has(parameter.id.slice(parameter.id.indexOf('.') + 1))
    && !fixed(parameter))
    .map((parameter) => ({
    name: primaryName(parameter.id, document.descriptor),
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
 * FakeChainEngine, with the workbench mounts present and the chain study loaded over
 * the scratch document the page opens on.
 * @param {{source?: string|null, patternCatalog?: string, hash?: string, search?: string, initialEffect?: string|null,
 *   paused?: boolean, pausedFromEngine?: boolean, selectEffect?: () => boolean,
 *   onOriginalLinkReleased?: () => void, prepare?: (engine: FakeChainEngine) => void,
 *   sourceFiles?: Record<string, string>, engineCatalog?: string,
 *   importCompiler?: () => Promise<typeof import("../../generated/shader/shader_workbench.mjs")>}} [seams] - source null
 *   leaves the scratch document loaded; pausedFromEngine reads the pause seam off the chain engine; prepare
 *   alters the engine before the controller starts.
 * @returns {Promise<Object>} The controller and everything it wrote to.
 */
async function editorWorkbench({
  source = CHAIN_STUDY, sourceFiles = {}, patternCatalog = EMPTY_PATTERN_CATALOG, hash = '', search = '?effect=ShaderChain', initialEffect = null, paused = false,
  engineCatalog = ENGINE_CATALOG,
  selectEffect = () => true,
  onOriginalLinkReleased = () => {},
  pausedFromEngine = false,
  prepare = () => {},
  importCompiler = () => import('../../generated/shader/shader_workbench.mjs'),
} = {}) {
  const engine = new FakeChainEngine();
  engine.catalog = JSON.parse(engineCatalog);
  const module = engineCatalog === ENGINE_CATALOG ? MODULE
    : {...MODULE, ShaderChainBindings: {getShaderChainCatalog: () => engineCatalog}};
  prepare(engine);
  const compiledEngine = compiledBuildEngine(source ?? CHAIN_STUDY);
  let animationsPaused = paused;
  // writeDeepLink builds its link state synchronously, reading the pause seam
  // once, so the count tells a write a timer started from one still pending.
  let pausedReads = 0;
  const animationWrites = [];
  for (const [target, method] of [[engine, 'setParameter'],
    [engine.bindings, 'setShaderChainParameters'], [compiledEngine, 'setParameter']]) {
    const write = target[method].bind(target);
    target[method] = (...args) => {
      animationsPaused = true;
      return write(...args);
    };
  }
  let current = engine;
  const elements = workbenchMounts();
  elements.set('chain-strip', fakeElement('section'));
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
    pathname: '/tools/shader.html', search, hash,
  };
  const win = {
    ...documentEvents(),
    prompt: (message, filename) => filename,
    location,
    history: {
      replaceState: (state, title, url) => {
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
    onOriginalLinkReleased,
    getEngine: () => current,
    getModule: () => module,
    selectEffect: (effect) => {
      selections.push(effect);
      if (!selectEffect(effect)) return false;
      current = effect === 'shader-chain' ? engine : compiledEngine;
      if (effect === 'shader-chain') engine.setEffect(effect);
      return true;
    },
    syncEffectGui: () => { ran.gui += 1; },
    invalidate: () => { ran.invalidated += 1; },
    getAnimationsPaused: () => {
      pausedReads += 1;
      return pausedFromEngine ? engine.getAnimationsPaused() : animationsPaused;
    },
    setAnimationsPaused: (paused) => {
      animationsPaused = paused;
      animationWrites.push(paused);
    },
    setParamFilter: (filter) => filters.push(filter),
    fetchText: patternFetch(
      { 'chain_study.shader.json': CHAIN_STUDY,
        ...sourceFiles }, patternCatalog, engineCatalog),
    importCompiler,
    download: (filename, source) => downloads.push([filename, source]),
    win,
    initialEffect,
  });
  ownedEditors.add(controller);
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

export const paramRow = (harness, label, parameterId) => stripChips(harness)
  .find(chip => chip.dataset.label === label).querySelectorAll('.chain-param')
  .find(row => row.dataset.parameter === parameterId);

const displayedParameter = (harness, label, parameterId) =>
  paramRow(harness, label, parameterId).querySelector('.chain-param-value').value;

const sampleFrequencySlider = harness =>
  paramRow(harness, 'sample', 'sample.pattern-freq').querySelector('.chain-param-control');

/** @param {*} document @param {string} label */
const expectStageAbsent = (document, label) => {
  const owned = (/** @type {string} */ id) => id.startsWith(`${label}.`);
  assert.equal(document.descriptor.chain.some((entry) => entry.label === label), false);
  assert.equal(document.descriptor.parameters.some((parameter) => owned(parameter.id)), false);
  assert.equal(document.descriptor.serialization.fields.some(owned), false);
  for (const preset of document.preset_bank.presets)
    assert.equal(Object.keys(preset.values).some(owned), false);
  assert.deepEqual(
    validateShaderDocument(document, { catalog: JSON.parse(ENGINE_CATALOG) }), []);
};

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
    const row = stripChips(harness)
      .find((chip) => chip.dataset.label === label)
      .querySelectorAll('.chain-param')
      .find((row) => row.dataset.parameter === parameterId);
    const control = row.querySelector('.chain-param-control');
    const readout = row.querySelector('.chain-param-value');
    control.value = String(control.type === 'range' && control.min !== readout.min
      ? Math.log2(Number(value)) : value);
    const eventType = control.tagName === 'SELECT' ? 'change' : 'input';
    control.dispatch(eventType);
    if (eventType === 'input') harness.animationFrames.flush();
  };
}

const savedValues = (harness) => {
  assert.equal(harness.controller.save(), true);
  return JSON.parse(harness.downloads.at(-1)[1]).preset_bank.presets[0].values;
};

const affineLatticeStudy = () => {
  const catalog = JSON.parse(ENGINE_CATALOG);
  const document = scratchChainDocument(catalog, [
    { label: 'project', operator: 'project.stereographic.v2' },
    { label: 'warp', operator: 'warp.affine.v4' },
    { label: 'sample', operator: 'sample.tessellation.v3' },
    { label: 'colorize', operator: 'colorize.generated-palette.v4' },
  ]);
  document.preset_bank.presets[0].values['sample.cell-scale'] = 4;
  return { source: JSON.stringify(document), engineCatalog: JSON.stringify(catalog) };
};

function applyFixed(engine, compiled, id, ids = [id], catalog) {
  return applyFixedShaderDocument(engine, MODULE, compiled, id, ids, BAKED, fixedDerivedBinding, catalog);
}
export {
  primaryName, ownedEditors, INDEX, WORKBENCH, ENGINE_CATALOG, SCRATCH, animationFrames,
  plainName, MODULE, BAKED, fixedDocument, fixedEngine, PATTERNS, promotedDocument, PROMOTED,
  affinePeriodDocument, PATTERN_CATALOG, shaderDocument, workbenchEngine, workbenchMounts,
  patternFetch, workbench, onChange, SCRATCH_WRITES, chooseCatalogSource,
  withoutEmbeddedModulation, CHAIN_STUDY,
  KALEIDOSCOPE_STAINED_GLASS, EMPTY_PATTERN_CATALOG, STUDY_PATTERN_CATALOG, compiledBuildEngine,
  editorWorkbench, clickPlaneBandEntry, stripChips, displayedParameter, sampleFrequencySlider,
  expectStageAbsent, stageEditor, savedValues, affineLatticeStudy, applyFixed,
};

export function singlePatternCatalog(effectId, file, name) {
  return JSON.stringify({source_documents: {[effectId]: file},
    product_group: {children: [{effect_id: effectId, display_name: name}]}});
}
