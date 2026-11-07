/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { canonicalEffectId, effectDisplayName } from "../../effects/effect_identity.js";
import { engineHalted } from '../../shared/engine_halt.js';
import { callWorkbenchBinding, getChainSnapshot, restoreChainSnapshot, shaderChainCatalog } from '../../engine/workbench_bindings.js';
import { enumConstantName, replayParameterWrites } from '../../effects/param_sync.js';
import {
  BAKED_MODULATION_SCALE_MAX, fieldOf as fieldSegment, MODULATION_OPERATOR,
  UNIT_MODULATION_AMOUNT_MIN, UNIT_MODULATION_AMOUNT_MAX,
} from './chain_presentation.js';
import { errorDetail } from '../../shared/banner.js';
import { applyChainDocument, resolveParameterWrite } from './chain_apply.js';
import {
  createChainDocumentStore, documentFromChainSnapshot, scratchChainDocument,
} from './chain_document_store.js';
import { createChainStrip } from './chain_strip.js';
import { BAKED_CONSTANT_IDS, bakedTopologyFields, documentModulationBinding, promotedControlNames } from '../../../generated/shader/shader_workbench.mjs';
import { CHAIN_SNAPSHOT_STORAGE_KEY } from '../../effects/effect_persistence.js';
import { copyToClipboard } from '../../shared/copy_text.js';
import { downloadBlob } from '../../shared/download_file.js';
import {
  decodeShaderStateHash, encodeShaderStateHash, replaceShaderStateHash,
} from './shader_deeplink.js';

const PATTERN_CATALOG_URL = '../../../generated/shader/patterns/catalog.json';
const CATALOG_URL = '../../../generated/shader/engine_catalog.json';

// The engine's chain interpreter, programmed through setShaderChain.
const CHAIN_EFFECT = canonicalEffectId('ShaderChain');

// Digest characters the toolbar shows; the button copies all of it.
const DIGEST_ABBREVIATION = 12;

// The download name used by Save for the scratch document.
const SCRATCH_FILENAME = 'scratch.shader.json';

export const SHADER_LINK_DEBOUNCE_MS = 200;
export const SHADER_LINK_MAX_WAIT_MS = 1000;

/** @param {*} expected @param {*} actual @returns {boolean} Float32 snapshot equality. */
function snapshotValueEqual(expected, actual) {
  if (typeof expected === 'number' && typeof actual === 'number')
    return Math.fround(expected) === Math.fround(actual);
  if (expected === null || actual === null || typeof expected !== 'object'
      || typeof actual !== 'object') return expected === actual;
  if (Array.isArray(expected) !== Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length
    && keys.every((key) => Object.hasOwn(actual, key) && snapshotValueEqual(expected[key], actual[key]));
}

/** @typedef {import('./chain_apply.js').ParameterDefinition} ParameterDefinition */
/** @typedef {import('./chain_apply.js').CompiledDocument} CompiledDocument */
/** @typedef {{effectId: string, descriptorDigest?: string, presetIds: string[]}} OfficialDocument */
/** @typedef {{compiled: CompiledDocument, filename: string, official: OfficialDocument|null, compiledSide: boolean, presetId: string|null, referencePresetIds: string[], savedDocument?: string|null}} ActiveDocument */

/**
 * @param {string} parameterId
 * @param {ParameterDefinition[]} definitions
 * @param {Set<string>} baked
 * @param {*} descriptor
 * @param {*} catalog
 * @returns {{name: string|null, refusal: string|null}} Compiled control or refusal.
 */
function compiledControlFor(parameterId, definitions, baked, descriptor, catalog = null) {
  const name = promotedControlNames(parameterId, descriptor, catalog)
    .find((candidate) => definitions.some((definition) =>
      definition.name === candidate && !definition.readonly));
  if (name) return { name, refusal: null };
  if (BAKED_CONSTANT_IDS.has(parameterId) || baked.has(fieldSegment(parameterId)))
    return { name: null, refusal: null };
  return { name: null, refusal: `no engine parameter matches "${parameterId}"` };
}

/**
 * @param {string} id @param {*} control @param {ParameterDefinition[]} definitions
 * @param {{unregistered?: true}} binding - An `unregistered` binding is live wherever a control resolves.
 */
function liveDerivedControl(id, control, definitions, binding) {
  if (control.name === null) return false;
  if (binding.unregistered) return true;
  const label = id.slice(0, id.indexOf('.'));
  const resource = control.name.slice(0, control.name.lastIndexOf('.'));
  return control.name === fieldSegment(id) || control.name.endsWith('.' + fieldSegment(id))
    || definitions.some((definition) => !definition.readonly
      && [label + '.modulation-source', resource + '.modulation-source', 'modulation-source',
        label + '.coverage-mode', resource + '.coverage-mode', 'coverage-mode']
        .includes(definition.name));
}

/** @param {*} engine @param {*} module @param {Array<{name: string, stored: number}>} writes */
function performEngineWrites(engine, module, writes) {
  const rejected = replayParameterWrites(writes.map(({name, stored}) => ({name, value: stored})),
    (name, value) => engine.setParameter(name, value), module.ParamSetResult);
  const refusal = rejected[0];
  return refusal ? `"${refusal.name}" was refused: ${enumConstantName(module.ParamSetResult, refusal.result)}` : null;
}

/** @param {*} descriptor @param {string} parameterId @param {*[]} definitions */
function documentControlFor(descriptor, parameterId, definitions) {
  const binding = documentModulationBinding(descriptor, parameterId);
  return binding && definitions.find((definition) => definition.resource === binding.resource
    && definition.id === binding.id);
}

/** @param {*} definition @param {*} value @returns {*|string|null} */
function resolveDocumentWrite(definition, value) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return `"${definition.id}" has no numeric value`;
  if (definition.readonly) return snapshotValueEqual(value, definition.value)
    ? null : `"${definition.id}" must match the fixed build's value ${definition.value}`;
  return {resource: definition.resource, id: definition.id, stored: value};
}

/** @param {*} engine @param {*} module @param {*[]} writes @returns {string|null} */
function performDocumentWrites(engine, module, writes) {
  for (const {resource, id, stored} of writes) {
    const result = engine.setDocumentParameter(resource, id, stored);
    if (result !== module.ParamSetResult.APPLIED)
      return `"${resource}.${id}" was refused: ${enumConstantName(module.ParamSetResult, result)}`;
  }
  return null;
}

/**
 * Resolves fixed-build values before any engine or document write is performed.
 * @param {Record<string, *>} values
 * @param {ParameterDefinition[]} definitions
 * @param {*[]} documentDefinitions
 * @param {*} descriptor
 * @param {(id: string) => {name: string|null, refusal: string|null}} resolveControl
 * @param {(id: string, control: {name: string|null, refusal: string|null}) => boolean} skip
 * @returns {{writes: Array<{name: string, stored: *}>, documentWrites: *[], refusal: string|null}}
 */
function resolveFixedWrites(values, definitions, documentDefinitions, descriptor, resolveControl, skip) {
  const writes = [];
  const documentWrites = [];
  for (const [id, value] of Object.entries(values)) {
    const control = resolveControl(id);
    if (skip(id, control)) continue;
    if (control.refusal) {
      const definition = documentControlFor(descriptor, id, documentDefinitions);
      if (!definition) return {writes, documentWrites, refusal: control.refusal};
      const write = resolveDocumentWrite(definition, value);
      if (typeof write === 'string') return {writes, documentWrites, refusal: write};
      if (write) documentWrites.push(write);
    } else if (control.name !== null) {
      const write = resolveParameterWrite(definitions, control.name, value);
      if (typeof write === 'string') return {writes, documentWrites, refusal: write};
      writes.push(write);
    }
  }
  return {writes, documentWrites, refusal: null};
}

/**
 * @param {import('../../../generated/holosphere_wasm.js').HolosphereEngine} engine @param {import('../../../generated/holosphere_wasm.js').HolosphereModule} module @param {CompiledDocument} compiled
 * @param {Record<string, *>} values - Values from the selected document preset.
 * @param {Set<string>} baked - The topology fields the effect bakes in.
 * @param {Set<string>} derived - Validated fields computed by the fixed effect.
 * @param {*} catalog
 * @returns {string|null} Refusal reason, or null once every writable value is written.
 *   Baked and derived values are skipped; an unregistered id refuses before any write.
 */
function applyDocumentValues(engine, module, compiled, values, baked, derived, catalog) {
  const definitions = engine.getParameterDefinitions();
  const resolved = resolveFixedWrites(values, definitions,
    engine.getDocumentParameterDefinitions?.() ?? [], compiled.document.descriptor,
    (id) => compiledControlFor(id, definitions, baked, compiled.document.descriptor, catalog),
    (id) => derived.has(id));
  return resolved.refusal ?? performEngineWrites(engine, module, resolved.writes)
    ?? performDocumentWrites(engine, module, resolved.documentWrites);
}

/**
 * Applies one authored preset to a matching concrete fixed-pipeline effect.
 * @param {import('../../../generated/holosphere_wasm.js').HolosphereEngine} engine
 * @param {import('../../../generated/holosphere_wasm.js').HolosphereModule} module
 * @param {CompiledDocument} compiled
 * @param {string} presetId
 * @param {string[]} referencePresetIds
 * @param {Set<string>} baked - The topology fields the effect bakes in.
 * @param {(descriptor: *, parameterId: string, values: *) => *} deriveBinding - Compiler binding resolver.
 * @param {*} [catalog] - Operator fields used by the native controls.
 * @returns {string|null} Refusal reason, or null once applied.
 */
export function applyFixedShaderDocument(engine, module, compiled, presetId,
                                         referencePresetIds, baked, deriveBinding, catalog = null) {
  const referenceId = referencePresetIds.includes(presetId)
    ? presetId : referencePresetIds[0];
  if (typeof referenceId !== 'string') return 'the effect has no reference preset';
  const preset = compiled.document.preset_bank.presets
    .find((/** @type {*} */ candidate) => candidate.preset_id === presetId);
  if (!preset) return `the document has no preset "${presetId}"`;
  const values = preset.values ?? {};
  const derived = new Set();
  const definitions = engine.getParameterDefinitions();
  for (const parameterId of Object.keys(values)) {
    const binding = deriveBinding(compiled.document.descriptor, parameterId, values);
    if (!binding) continue;
    const control = compiledControlFor(parameterId, definitions, baked, compiled.document.descriptor, catalog);
    if (liveDerivedControl(parameterId, control, definitions, binding)) continue;
    if (!binding.valid)
      return `"${parameterId}" must match the fixed build's derived value ${binding.expected}`;
    derived.add(parameterId);
  }
  if (engine.selectPresetById?.(referenceId) !== true)
    return `the engine refused reference preset "${referenceId}"`;
  return applyDocumentValues(engine, module, compiled, values, baked, derived, catalog);
}

/**
 * Every diagnostic the compile collected, one per line.
 * @param {CompiledDocument} compiled
 */
function diagnosticText(compiled) {
  const diagnostics = /** @type {*[]} */ (compiled.diagnostics ?? []);
  if (diagnostics.length === 0) return compiled.status ?? 'INVALID';
  return diagnostics
    .map((diagnostic) => `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`)
    .join('\n');
}

/** @param {Document} doc @param {string} filename @param {string} source */
function defaultDownload(doc, filename, source) {
  downloadBlob(doc, new Blob([source], { type: 'application/json' }), filename);
}

/**
 * Owns document import, validation, preview selection, editing, and export UI.
 * @param {{doc: Document, getEngine: () => *, getModule: () => *,
 * selectEffect: (effect: string) => boolean,
 * syncEffectGui: () => void, invalidate: () => void,
 * getAnimationsPaused?: () => boolean|null,
 * setAnimationsPaused?: (paused: boolean) => void,
 * setParamFilter?: (filter: {external: true}|null) => void,
 * onOriginalLinkReleased?: () => void,
 * fetchText?: (url: string) => Promise<string>, importCompiler?: () => Promise<*>,
 * download?: (filename: string, source: string) => void,
 * initialEffect?: string|null, win?: *}} dependencies - initialEffect is the effect the
 *   page was opened on, which init() honors when it names a catalog source.
 */
export function createShaderDocumentController({
  doc,
  getEngine: readEngine,
  getModule,
  selectEffect: readSelectEffect,
  syncEffectGui,
  invalidate,
  getAnimationsPaused: readAnimationsPaused = () => null,
  setAnimationsPaused = () => {},
  setParamFilter = () => {},
  onOriginalLinkReleased = () => {},
  fetchText = async (url) => {
    const assetUrl = new URL(url, import.meta.url);
    const response = await fetch(assetUrl, { cache: 'no-cache' });
    if (!response.ok)
      throw new Error(`${response.status} ${response.statusText} (${assetUrl.pathname})`);
    return response.text();
  },
  importCompiler = () => import('../../../generated/shader/shader_workbench.mjs'),
  download = (filename, source) => defaultDownload(doc, filename, source),
  initialEffect = null,
  win = globalThis,
}) {
  /** @param {unknown} error */
  const markHalted = (error) => {
    const module = getModule();
    if (module && engineHalted(error, module)) module.HS_MODULE_DEAD = true;
  };
  const selectEffect = (/** @type {string} */ effect) => {
    const module = getModule();
    if (module?.HS_MODULE_DEAD) return false;
    try { return readSelectEffect(effect); }
    catch (error) {
      markHalted(error);
      throw error;
    }
  };
  const getEngine = () => getModule()?.HS_MODULE_DEAD ? null : readEngine();
  const getAnimationsPaused = () => getModule()?.HS_MODULE_DEAD ? null : readAnimationsPaused();
  const sourceSelect = /** @type {HTMLSelectElement|null} */ (
    doc.getElementById('shader-document-select'));
  const presetSelect = /** @type {HTMLSelectElement|null} */ (
    doc.getElementById('shader-preset-select'));
  const openButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-open'));
  const saveButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-save'));
  const saveAsButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-save-as'));
  const fileInput = /** @type {HTMLInputElement|null} */ (
    doc.getElementById('shader-document-file'));
  const status = /** @type {HTMLOutputElement|null} */ (
    doc.getElementById('shader-document-status'));
  const notice = doc.getElementById('shader-document-notice');
  const errorNotice = doc.getElementById('shader-document-error');
  const digestButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-digest'));
  const parityToggle = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-parity-toggle'));
  const animationToggle = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-animation-toggle'));
  if (!sourceSelect || !presetSelect || !openButton || !saveButton
      || !fileInput || !status) return null;
  const stripMount = doc.getElementById('chain-strip');

  /** @type {*} */
  let compiler;
  /** @type {ActiveDocument|null} */
  let active = null;
  let selectedSource = '';
  /** @type {Map<string, *>} */
  let sourceCatalog = new Map();
  /** @type {*|null} */
  let operatorCatalog = null;
  /** @type {Set<string>} The catalog's topology fields, once it has loaded. */
  let bakedFields = new Set();
  /** @type {{store: *, strip: *}|null} */
  let chainUi = null;
  let rebuildAfterParameterCommit = false;
  /** @type {number} Save As copies this session, which their ids count off. */
  let copies = 0;
  let linkGeneration = 0;
  /** @type {Promise<void>} */
  let linkWrite = Promise.resolve();
  /** @type {ReturnType<typeof setTimeout>|null} */
  let linkDebounceTimer = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let linkMaxTimer = null;
  let linkPending = false;
  let linkDisposed = false;
  let preserveRefusedLink = false;
  const releaseOriginalLink = () => {
    if (!preserveRefusedLink) return;
    preserveRefusedLink = false;
    onOriginalLinkReleased();
  };

  /** @param {string} message @param {boolean} error */
  const writeStatus = (message, error) => {
    if (notice) notice.textContent = error ? '' : message;
    if (errorNotice) errorNotice.textContent = error ? message : '';
    status.dataset.status = error ? 'error' : 'ok';
    status.textContent = message;
  };
  /** @param {string} message */
  const showStatus = (message) => writeStatus(message, false);
  const showParityDropStatus = () => showStatus(
    'The edit changed the descriptor: the preview is back on the '
    + 'interpreter and the parity toggle is disarmed.');
  /** @param {string} message */
  const showError = (message) => writeStatus(message, true);

  // An empty message clears both announcements.
  /** @param {string} message */
  const announce = (message) => writeStatus(message, message !== '');

  /**
   * The descriptor digest of whichever document is authoritative: the store's
   * once the editor is live, else the load-time compile.
   * @returns {string|undefined} The digest.
   */
  const liveDigest = () => chainUi
    ? chainUi.store.compile().descriptor_digest
    : active?.compiled.descriptor_digest;

  /**
   * Whether the loaded chain still digests to the promoted effect it opened as.
   * Bypass never touches the document, so it leaves this true.
   * @returns {boolean} Whether the parity toggle is armed.
   */
  const parityArmed = () =>
    active?.official != null
    && liveDigest() === active.official.descriptorDigest;

  /**
   * Repaints the parity toggle and, once a descriptor edit has broken the
   * match, returns the preview to the interpreter so the render is the document
   * being edited.
   * @returns {boolean} Whether the compiled build was dropped.
   */
  const syncParity = () => {
    const armed = parityArmed();
    const dropped = !armed && active?.compiledSide === true;
    if (dropped && active) {
      active.compiledSide = false;
      selectEffect(CHAIN_EFFECT);
    }
    if (parityToggle) {
      parityToggle.disabled = !armed;
      parityToggle.setAttribute('aria-pressed', String(active?.compiledSide === true));
    }
    return dropped;
  };

  /**
   * Repaints the toolbar digest.
   * @returns {void}
   */
  const showDigest = () => {
    if (!digestButton) return;
    const digest = liveDigest();
    digestButton.dataset.digest = digest ?? '';
    digestButton.textContent = digest ? digest.slice(0, DIGEST_ABBREVIATION) : '—';
    digestButton.setAttribute('aria-label', `Copy the descriptor digest ${digestButton.textContent}`);
    digestButton.disabled = !digest;
  };

  const showAnimationState = () => {
    if (!animationToggle) return;
    const paused = getAnimationsPaused();
    animationToggle.disabled = paused === null;
    animationToggle.setAttribute('aria-pressed', String(paused === true));
  };

  /** @param {CompiledDocument} compiled */
  const populatePresets = (compiled) => {
    presetSelect.replaceChildren();
    for (const preset of compiled.document.preset_bank.presets) {
      const option = doc.createElement('option');
      option.value = preset.preset_id;
      option.textContent = preset.display_name ?? preset.preset_id;
      presetSelect.appendChild(option);
    }
    presetSelect.disabled = presetSelect.options.length === 0;
  };

  const showPreviewStatus = () => {
    if (!active) return;
    const title = active.compiled.document.effect_metadata?.display_name
      ?? active.compiled.document.document_id;
    const preset = presetSelect.selectedOptions[0]?.textContent ?? active.presetId;
    const side = !parityArmed() ? ''
      : active.compiledSide ? ' · compiled build' : ' · interpreter';
    showStatus(`${title} · ${preset}${side}`);
  };

  /** @param {string} presetId */
  const applyPreset = (presetId) => {
    try {
      const engine = getEngine();
      const module = getModule();
      if (!engine || !module || !active) {
        showError('The preview engine is not ready.');
        return false;
      }
      // With the editor live, the store's document is authoritative and its
      // program shape carries the session bypasses.
      const store = chainUi?.store ?? null;
      const paused = getAnimationsPaused();
      const refusal = active.compiledSide
        ? applyFixedShaderDocument(
          engine, module, store ? { document: store.document() } : active.compiled,
          presetId, active.referencePresetIds, bakedFields, compiler.fixedDerivedBinding, operatorCatalog)
        : applyChainDocument({
          engine, module,
          compiled: store ? { document: store.document() } : active.compiled,
          programShape: store ? store.programShape() : null,
          presetId, syncEffectGui, invalidate,
        });
      if (paused !== null) {
        setAnimationsPaused(paused);
        syncEffectGui();
      }
      showAnimationState();
      if (active.compiledSide) {
        syncEffectGui();
        invalidate();
      }
      if (refusal) {
        showError(`Preset "${presetId}" could not be applied: ${refusal}`);
        return false;
      }
      active.presetId = presetId;
      chainUi?.strip.syncParameterRows();
      showPreviewStatus();
      showDigest();
      scheduleDeepLink();
      return true;
    } catch (error) {
      markHalted(error);
      showError(`The preview edit failed: ${errorDetail(error)}`);
      return false;
    }
  };

  const teardownChainUi = () => {
    if (chainUi === null) return;
    chainUi.strip.destroy();
    chainUi = null;
    rebuildAfterParameterCommit = false;
    setParamFilter(null);
  };

  /**
   * Resolves document ids against the active engine's registered controls.
   * @param {string} parameterId - A chain parameter id.
   * @param {ParameterDefinition[]} definitions - The engine's definitions.
   * @returns {{name: string|null, refusal: string|null}} The control or refusal.
   */
  const engineControlName = (parameterId, definitions) => {
    const label = parameterId.slice(0, parameterId.indexOf('.'));
    if (active?.compiledSide !== true) {
      return { name: chainUi?.store.bypassedLabels().includes(label) ? null : parameterId,
        refusal: null };
    }
    return compiledControlFor(parameterId, definitions, bakedFields, active.compiled.document.descriptor, operatorCatalog);
  };

  /** @type {ReturnType<typeof getEngine>} */
  let definitionEngine = null;
  /** @type {number|undefined} */
  let definitionGeneration;
  /** @type {ParameterDefinition[]} */
  let cachedDefinitions = [];
  const liveDefinitions = () => {
    const engine = getEngine();
    const generation = engine?.getParamGeneration?.();
    if (engine !== definitionEngine || generation !== definitionGeneration) {
      definitionEngine = engine;
      definitionGeneration = generation;
      cachedDefinitions = engine?.getParameterDefinitions() ?? [];
    }
    return cachedDefinitions;
  };

  /** @param {string} parameterId @returns {boolean} */
  const parameterLive = (parameterId) => {
    if (active?.compiledSide !== true) return true;
    const descriptor = { chain: chainUi?.store.chainView()
      ?? active?.compiled.document.descriptor.chain ?? [] };
    const control = engineControlName(parameterId, liveDefinitions());
    if (control.name !== null) return true;
    if (control.refusal) {
      const definition = documentControlFor(descriptor, parameterId,
        getEngine()?.getDocumentParameterDefinitions?.() ?? []);
      if (definition) return !definition.readonly;
    }
    return !BAKED_CONSTANT_IDS.has(parameterId) && !bakedFields.has(fieldSegment(parameterId))
      && !compiler.fixedDerivedBinding?.(descriptor, parameterId, {});
  };

  /**
   * Routes an inline stage-control edit into the active preset: the document is
   * the source of truth and the engine write is its side effect.
   * @param {string} parameterId - The edited parameter's id.
   * @param {*} value - The document value: a number, or an enum8 option id.
   * @returns {boolean}
   */
  const writeStageEdit = (parameterId, value) => {
    if (!parameterLive(parameterId)) return false;
    try {
      if (chainUi === null || active === null || active.presetId === null) return false;
      const presetId = active.presetId;
      const compiledSide = active.compiledSide;
      const store = chainUi.store;
      const presetValues = store.presetValuesView(presetId);
      if (presetValues === null) return false;
      const descriptor = { chain: store.chainView() };
      const values = { [parameterId]: value };
      const label = parameterId.slice(0, parameterId.indexOf('.'));
      const field = fieldSegment(parameterId);
      const modulated = descriptor.chain.some((/** @type {*} */ entry) =>
        entry.label === label && entry.operator === MODULATION_OPERATOR);
      if (modulated && field === 'modulation-source' && value !== 'noise')
        values[`${label}.modulation-evaluation`] = 'direct';
      if (modulated && field === 'modulation-mechanic' && value !== 'hue-rotation') {
        const amount = Number(presetValues[`${label}.modulation-amount`] ?? 0);
        values[`${label}.modulation-amount`] = Math.max(UNIT_MODULATION_AMOUNT_MIN,
          Math.min(UNIT_MODULATION_AMOUNT_MAX, amount));
      }
      if (modulated && values[`${label}.modulation-evaluation`] === 'baked-cube'
          && Number(presetValues[`${label}.pattern-scale`] ?? 1) > BAKED_MODULATION_SCALE_MAX)
        values[`${label}.pattern-scale`] = BAKED_MODULATION_SCALE_MAX;
      const addsDeclaration = Object.keys(values).some(id => !store.declares(id));
      const coupled = Object.keys(values).length > 1;
      const result = store.setPresetValues(presetId, values, () => {
        if (addsDeclaration && compiledSide) return { ok: true };
        const engine = getEngine();
        const module = getModule();
        if (!engine || !module) return { ok: true };
        const definitions = engine.getParameterDefinitions();
        const control = engineControlName(parameterId, definitions);
        const paused = getAnimationsPaused();
        let refusal = control.refusal;
        if (compiledSide || (refusal === null && control.name !== null)) {
          if (coupled && !compiledSide) {
            const writes = [];
            for (const [id, next] of Object.entries(values)) {
              const write = resolveParameterWrite(definitions, id, next);
              if (typeof write === 'string') { refusal = write; break; }
              writes.push({ name: write.name, value: write.stored });
            }
            if (refusal === null) {
              const written = callWorkbenchBinding(engine, 'setShaderChainParameters', [writes],
                module.ParamSetResult.NO_EFFECT);
              if (written !== module.ParamSetResult.APPLIED)
                refusal = `"${parameterId}" was refused: ${enumConstantName(module.ParamSetResult, written)}`;
            }
          } else if (compiledSide) {
            const resolved = resolveFixedWrites(values, definitions,
              engine.getDocumentParameterDefinitions?.() ?? [], descriptor,
              (id) => engineControlName(id, definitions),
              (id, control) => {
                const binding = compiler.fixedDerivedBinding?.(descriptor, id, {...presetValues, ...values});
                return Boolean(binding && !liveDerivedControl(id, control, definitions, binding));
              });
            refusal = resolved.refusal ?? performEngineWrites(engine, module, resolved.writes)
              ?? performDocumentWrites(engine, module, resolved.documentWrites);
          } else if (control.name !== null) {
            const write = resolveParameterWrite(definitions, control.name, value);
            refusal = typeof write === 'string' ? write : performEngineWrites(engine, module, [write]);
          }
        }
        if (paused !== null) {
          setAnimationsPaused(paused);
          syncEffectGui();
        }
        showAnimationState();
        invalidate();
        return refusal ? { ok: false, diagnostics: [{
          severity: 'error', phase: 'apply', code: 'ENGINE_REFUSAL',
          path: parameterId, message: refusal,
        }] } : { ok: true };
      });
      if (!result.ok) {
        const diagnostic = result.diagnostics[0];
        announce(diagnostic.code === 'ENGINE_REFUSAL' ? diagnostic.message
          : `"${parameterId}" was refused: ${diagnostic.message}`);
        return false;
      }
      releaseOriginalLink();
      let applied = true;
      if (addsDeclaration) {
        const dropped = syncParity();
        applied = applyPreset(active.presetId);
        if (dropped && applied) {
          rebuildAfterParameterCommit = true;
          showParityDropStatus();
        }
      }
      if (Object.keys(values).length > 1) chainUi.strip.syncParameterValues(values);
      chainUi.strip.syncHistory();
      if (applied && status.dataset.status === 'error') showPreviewStatus();
      scheduleDeepLink();
      return true;
    } catch (error) {
      markHalted(error);
      showError(`The preview edit failed: ${errorDetail(error)}`);
      return false;
    }
  };

  /**
   * Builds the pipeline strip over one document store, wiring structural
   * edits, undo and bypass toggles back through applyPreset. The effect GUI
   * panel builds none of the stage parameters.
   * @param {*} document - The compiled (valid) v2 document to edit.
   * @param {HTMLElement} container - Detached mount for the candidate editor.
   */
  const buildChainUi = async (document, container) => {
    const store = /** @type {*} */ (await createChainDocumentStore({
      document, catalog: operatorCatalog, importCompiler,
    }));
    const strip = /** @type {*} */ (createChainStrip({
      doc,
      container,
      store,
      catalog: operatorCatalog,
      announce,
      onApply: () => {
        releaseOriginalLink();
        const dropped = syncParity();
        const applied = applyPreset(active?.presetId ?? presetSelect.value);
        if (dropped) {
          chainUi?.strip.render();
          if (applied) showParityDropStatus();
        }
      },
      presetId: () => active?.presetId ?? null,
      onEditParameter: writeStageEdit,
      parameterLive,
      parameterRanges: () => chainUi?.store === store && active?.compiledSide !== true
        ? callWorkbenchBinding(getEngine(), 'getShaderChainParameterRanges', [], []) : [],
      onCommitParameter: () => {
        if (rebuildAfterParameterCommit) {
          rebuildAfterParameterCommit = false;
          chainUi?.strip.render();
        }
        void flushDeepLink();
      },
      bypassAvailable: () => active?.compiledSide !== true,
    }));
    setParamFilter({ external: true });
    return { store, strip };
  };

  /**
   * @param {string|*} source - Document JSON, or the document itself.
   * @param {string} [filename]
   * @param {*} [precompiled] - The catalog's already-compiled document, when the
   *   source is a catalog entry rather than an imported study.
   * @param {*|null} [session] - Deep-linked preset, bypass, and pause state.
   */
  const loadSourceNow = async (source, filename = 'import.shader.json',
                               precompiled = null, session = null) => {
    await flushDeepLink();
    linkGeneration += 1;
    compiler ??= await importCompiler();
    let compiled = precompiled;
    if (compiled === null) {
      // A malformed document yields diagnostics; a throw is a compiler failure.
      try {
        compiled = compiler.compileShaderDocument(source, { catalog: operatorCatalog });
      } catch (error) {
        const detail = errorDetail(error);
        showError(`The document could not be compiled: ${detail}`);
        return false;
      }
    }
    if (compiled.status !== 'VALID') {
      showError(diagnosticText(compiled));
      return false;
    }
    // Resolved before anything is built: the strip renders the active preset's values.
    const presetId = session?.preset
      ?? compiled.document.preset_bank.presets[0]?.preset_id;
    if (!presetId) {
      showError('The document is valid, but it carries no preset to preview.');
      return false;
    }
    if (!compiled.document.preset_bank.presets.some(
      (/** @type {*} */ preset) => preset.preset_id === presetId)) {
      showError(`The shader link names no document preset "${presetId}".`);
      return false;
    }
    // Every load previews through the interpreter; a digest match arms the parity toggle.
    const previousSnapshot = getChainSnapshot(getEngine());
    const official = [...sourceCatalog.values()].find((candidate) =>
      candidate.descriptorDigest === compiled.descriptor_digest) ?? null;
    // Ahead of the teardown, so a refusal leaves the current editor standing.
    try {
      if (!selectEffect(CHAIN_EFFECT)) {
        showError(`The preview engine rejected effect "${effectDisplayName(CHAIN_EFFECT)}".`);
        return false;
      }
    } catch (error) {
      showError(`The preview edit failed: ${errorDetail(error)}`);
      return false;
    }
    const previous = active;
    const previousUi = chainUi;
    const candidateMount = stripMount ? doc.createElement('div') : null;
    if (candidateMount) candidateMount.style.display = 'contents';
    chainUi = null;
    active = {
      compiled,
      filename,
      official,
      compiledSide: false,
      presetId,
      referencePresetIds: official?.presetIds ?? [],
    };
    /**
     * Puts the toolbar back on the document the engine is rendering, writing the
     * previous program back when the refused load had already written its own.
     * @param {Object} [options]
     * @param {boolean} [options.written=false] - Whether the program write has run.
     * @returns {boolean} The load's refusal.
     */
    const abandon = ({ written = false } = {}) => {
      teardownChainUi();
      active = previous;
      chainUi = previousUi;
      setParamFilter(previousUi ? { external: true } : null);
      if (previous) {
        populatePresets(previous.compiled);
        presetSelect.value = previous.presetId ?? '';
        showDigest();
        syncParity();
      }
      if (previous?.compiledSide && previous.official)
        selectEffect(previous.official.effectId);
      if (previous && (written || previous.compiledSide)) {
        const refusal = status.textContent;
        applyPreset(previous.presetId ?? presetSelect.value);
        if (previousSnapshot) restoreChainSnapshot(getEngine(), getModule(), previousSnapshot);
        showError(refusal ?? '');
      }
      return false;
    };
    if (candidateMount && typeof compiler.validateShaderDocument === 'function') {
      try {
        chainUi = await buildChainUi(compiled.document, candidateMount);
      } catch (error) {
        const detail = errorDetail(error);
        showError(`The chain editor could not adopt the document: ${detail}`);
        return abandon({ written: true });
      }
    }
    if (session && chainUi) {
      for (const label of session.bypassed) {
        const result = chainUi.store.setBypassed(label, true);
        if (!result.ok) {
          showError(`The shader link could not bypass "${label}": `
            + `${result.diagnostics[0].message}.`);
          return abandon();
        }
      }
      chainUi.strip.render();
    }
    populatePresets(compiled);
    presetSelect.value = presetId;
    saveButton.disabled = false;
    if (saveAsButton) saveAsButton.disabled = false;
    showDigest();
    syncParity();
    if (!applyPreset(presetId)) return abandon({ written: true });
    if (session?.chainSnapshot) {
      const expected = getChainSnapshot(getEngine());
      const snapshot = session.chainSnapshot;
      const values = new Map(snapshot.parameters.map((/** @type {*} */ entry) => [entry.name, entry.value]));
      if (!expected || JSON.stringify(expected.chain) !== JSON.stringify(snapshot.chain)
          || !snapshotValueEqual(expected.modulation, snapshot.modulation)
          || expected.parameters.length !== values.size
          || expected.parameters.some((/** @type {*} */ entry) => entry.value !== Math.fround(values.get(entry.name)))) {
        showError('The shader link snapshot does not match its document and preset.');
        return abandon({ written: true });
      }
      if (restoreChainSnapshot(getEngine(), getModule(), snapshot)
          !== getModule().ChainSnapshotRestoreResult.APPLIED) {
        showError('The shader link runtime snapshot was rejected.');
        return abandon({ written: true });
      }
    }
    if (session) {
      setAnimationsPaused(session.paused);
      showAnimationState();
      syncEffectGui();
      invalidate();
    }
    active.savedDocument = JSON.stringify(currentDocument());
    previousUi?.strip.destroy();
    if (stripMount && candidateMount) stripMount.replaceChildren(candidateMount);
    return true;
  };

  /** @type {Promise<void>} */
  let loadQueue = Promise.resolve();
  /** @type {typeof loadSourceNow} */
  const loadSource = (source, filename, precompiled, session) => {
    const queued = loadQueue.then(() =>
      loadSourceNow(source, filename, precompiled, session));
    loadQueue = queued.then(() => undefined, () => undefined);
    return queued;
  };

  /**
   * The document as it stands: the store's once the editor is live, else the
   * load-time compile.
   * @returns {*} An isolated copy.
   */
  const currentDocument = () => chainUi
    ? chainUi.store.document()
    : structuredClone((/** @type {ActiveDocument} */ (active)).compiled.document);

  /**
   * The document Save writes: the current one without its disabled stages.
   * @returns {*} An isolated copy.
   * @throws {Error} If the document without those stages fails validation.
   */
  const exportableDocument = () => chainUi
    ? chainUi.store.exportDocument()
    : structuredClone((/** @type {ActiveDocument} */ (active)).compiled.document);

  const clearLinkTimers = () => {
    if (linkDebounceTimer !== null) clearTimeout(linkDebounceTimer);
    if (linkMaxTimer !== null) clearTimeout(linkMaxTimer);
    linkDebounceTimer = null;
    linkMaxTimer = null;
  };

  const writeDeepLink = () => {
    clearLinkTimers();
    if (!linkPending || !active || active.presetId === null) return linkWrite;
    linkPending = false;
    const generation = ++linkGeneration;
    const chainSnapshot = getChainSnapshot(getEngine());
    const state = {
      document: currentDocument(),
      preset: active.presetId,
      bypassed: chainUi?.store.bypassedLabels() ?? [],
      paused: getAnimationsPaused() === true,
      ...(chainSnapshot ? {chainSnapshot} : {}),
    };
    linkWrite = encodeShaderStateHash(state).then((hash) => {
      if (generation === linkGeneration) replaceShaderStateHash(hash, win);
    }).catch((error) => {
      if (generation !== linkGeneration) return;
      replaceShaderStateHash('', win);
      const detail = errorDetail(error);
      showError(`The shader link could not be updated: ${detail}.`);
    });
    return linkWrite;
  };

  const flushDeepLink = () => {
    chainUi?.strip.flushParameterEdit();
    return writeDeepLink();
  };

  const scheduleDeepLink = () => {
    if (linkDisposed || preserveRefusedLink || !active || active.presetId === null) return;
    linkPending = true;
    if (linkDebounceTimer !== null) clearTimeout(linkDebounceTimer);
    linkDebounceTimer = setTimeout(writeDeepLink, SHADER_LINK_DEBOUNCE_MS);
    linkMaxTimer ??= setTimeout(writeDeepLink, SHADER_LINK_MAX_WAIT_MS);
  };

  /**
   * @param {*} document - The document to write.
   * @param {string} filename - The download name.
   * @returns {boolean} Always true.
   */
  const exportDocument = (document, filename) => {
    download(filename, compiler.exportShaderDocumentJson(document));
    (/** @type {ActiveDocument} */ (active)).savedDocument = JSON.stringify(currentDocument());
    showStatus(`Saved ${filename}.`);
    return true;
  };

  const save = () => {
    if (!active) return false;
    void flushDeepLink();
    let document;
    try {
      document = exportableDocument();
    } catch (error) {
      showError(`The shader document could not be saved: ${errorDetail(error)}.`);
      return false;
    }
    return exportDocument(document, active.filename.endsWith('.shader.json')
      ? active.filename : `${document.effect_id ?? document.document_id}.shader.json`);
  };

  /**
   * Writes a copy under a fresh document id. The loaded document keeps its own
   * id and download name, so a following Save still re-exports the original.
   * @returns {Promise<boolean>} Whether a document was written.
   */
  const saveAs = async () => {
    if (!active) return false;
    void flushDeepLink();
    const savedActive = active;
    const savedDocument = JSON.stringify(currentDocument());
    try {
      const document = exportableDocument();
      document.document_id = `${document.document_id}-copy${copies + 1}`;
      let filename = `${document.document_id}.shader.json`;
      const source = compiler.exportShaderDocumentJson(document);
      if (typeof win.showSaveFilePicker === 'function') {
        const file = await win.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Shader document', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await file.createWritable();
        try {
          await writable.write(source);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
        filename = file.name;
      } else {
        const entered = win.prompt('Save shader as:', filename);
        if (entered === null) return false;
        filename = entered.trim();
        if (!filename) {
          showError('Enter a filename for the shader document.');
          return false;
        }
        if (!filename.toLowerCase().endsWith('.json')) filename += '.shader.json';
        download(filename, source);
      }
      copies += 1;
      if (active === savedActive) {
        active.savedDocument = savedDocument;
        showStatus(`Saved ${filename}.`);
      }
      return true;
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError'))
        showError(`The shader document could not be saved: ${errorDetail(error)}.`);
      return false;
    }
  };

  /**
   * Opens the default chain on catalog defaults through the ordinary load path.
   * @returns {Promise<boolean>} Whether the scratch document is on screen.
   */
  const loadScratch = () =>
    loadSource(scratchChainDocument(operatorCatalog), SCRATCH_FILENAME);

  const refuseLink = () => {
    preserveRefusedLink = true;
    clearLinkTimers();
    linkPending = false;
    linkGeneration += 1;
  };

  /** @type {HTMLOptionElement | null} */
  let loadedSourceOption = null;
  /**
   * @param {string | null} effectId Catalog identity, empty for scratch, null for a file.
   * @param {string} filename Loaded document filename.
   * @param {string} kind Display label for an imported or linked document.
   */
  const selectLoadedSource = (effectId, filename, kind) => {
    loadedSourceOption?.remove();
    loadedSourceOption = null;
    if (effectId === null) {
      loadedSourceOption = doc.createElement('option');
      loadedSourceOption.value = '__loaded-document__';
      loadedSourceOption.textContent = `${kind}: ${filename}`;
      loadedSourceOption.disabled = true;
      sourceSelect.appendChild(loadedSourceOption);
    }
    sourceSelect.value = effectId ?? '__loaded-document__';
    selectedSource = sourceSelect.value;
  };

  /** @param {NonNullable<Awaited<ReturnType<typeof decodeShaderStateHash>>>} linked */
  const loadLinkedSource = async (linked) => {
      const effectId = linked.document.effect_id;
      const entry = [...sourceCatalog.values()].find(
        (candidate) => candidate.compiled.document.effect_id === effectId);
      const scratch = effectId === 'scratch';
      const filename = entry?.filename ?? (scratch ? SCRATCH_FILENAME : 'linked.shader.json');
      if (await loadSource(linked.document, filename, null, linked)) {
        (/** @type {ActiveDocument} */ (active)).savedDocument = entry ? JSON.stringify(entry.compiled.document)
          : scratch ? JSON.stringify(compiler.compileShaderDocument(
            scratchChainDocument(operatorCatalog), { catalog: operatorCatalog }).document) : null;
        selectLoadedSource(scratch ? '' : entry?.effectId ?? null, filename, scratch ? '' : 'Linked');
        return true;
      }
    return false;
  };

  const init = async () => {
    try {
      compiler = await importCompiler();
      operatorCatalog = JSON.parse(await fetchText(CATALOG_URL));
      const runningCatalog = JSON.parse(shaderChainCatalog(getModule()));
      if (JSON.stringify(operatorCatalog) !== JSON.stringify(runningCatalog))
        throw new Error('Operator catalog does not match the loaded engine');
      bakedFields = bakedTopologyFields(operatorCatalog);
      const patternCatalog = JSON.parse(await fetchText(PATTERN_CATALOG_URL));
      const entries = await Promise.all(Object.entries(patternCatalog.source_documents)
        .map(async ([effectId, filename]) => {
          const source = await fetchText(`../../../generated/shader/patterns/${filename}`);
          const compiled = compiler.compileShaderDocument(source,
            { catalog: operatorCatalog });
          if (compiled.status !== 'VALID')
            throw new Error(`${filename}: ${diagnosticText(compiled)}`);
          return {
            effectId,
            filename,
            source,
            compiled,
            descriptorDigest: compiled.descriptor_digest,
            presetIds: compiled.document.preset_bank.presets.map(
              (/** @type {*} */ preset) => preset.preset_id),
          };
        }));
      sourceCatalog = new Map(entries.map((entry) => [entry.effectId, entry]));
      for (const { effectId } of entries) {
        const option = doc.createElement('option');
        option.value = effectId;
        option.textContent = patternCatalog.product_group.children
          .find((/** @type {*} */ child) => child.effect_id === effectId)?.display_name
          ?? effectId;
        sourceSelect.appendChild(option);
      }
    } catch (error) {
      const detail = errorDetail(error);
      showError(`Source catalog failed to load: ${detail}`);
      return false;
    }
    let linked = null;
    let linkError = '';
    try {
      linked = await decodeShaderStateHash(win.location?.hash ?? '');
    } catch (error) {
      linkError = errorDetail(error);
    }
    if (linked) {
      if (await loadLinkedSource(linked)) return true;
      linkError = status.textContent || 'the linked state was refused';
    }
    if (linkError) {
      refuseLink();
    }
    const query = new URLSearchParams(win.location?.search ?? '');
    const chainText = query.get(`fx.${CHAIN_SNAPSHOT_STORAGE_KEY}`);
    if (!linked && !linkError && chainText !== null) {
      try {
        const snapshot = JSON.parse(chainText);
        const imported = documentFromChainSnapshot(snapshot, operatorCatalog);
        const previous = getChainSnapshot(getEngine());
        if (!await loadSource(imported, 'imported.shader.json'))
          throw new Error(status.textContent || 'the imported chain could not be adopted');
        const outcome = restoreChainSnapshot(getEngine(), getModule(), snapshot);
        if (outcome !== getModule().ChainSnapshotRestoreResult.APPLIED) {
          if (previous) restoreChainSnapshot(getEngine(), getModule(), previous);
          throw new Error('the imported chain snapshot was rejected');
        }
        const paused = getAnimationsPaused();
        if (paused !== null) setAnimationsPaused(paused);
        showAnimationState();
        selectLoadedSource(null, 'imported.shader.json', 'Imported');
        syncEffectGui();
        invalidate();
        scheduleDeepLink();
        await flushDeepLink();
        showStatus('Restored the chain snapshot.');
        return true;
      } catch (error) {
        linkError = errorDetail(error);
        refuseLink();
      }
    }
    const requested = sourceCatalog.get(canonicalEffectId(initialEffect ?? ''))
      ?? sourceCatalog.get(initialEffect ?? '');
    let loaded;
    if (requested === undefined) loaded = await loadScratch();
    else {
      loaded = await loadSource(requested.source, requested.filename, requested.compiled);
      if (loaded) sourceSelect.value = requested.effectId;
    }
    selectedSource = sourceSelect.value;
    if (linkError) showError(`The shader link could not be restored: ${linkError}.`);
    return loaded;
  };

  /** @param {string|null} effectId @param {string} filename @param {string} kind */
  const adoptLoadedSource = async (effectId, filename, kind) => {
    selectLoadedSource(effectId, filename, kind);
    releaseOriginalLink();
    scheduleDeepLink();
    await flushDeepLink();
  };

  const allowSourceChange = () => {
    chainUi?.strip.flushParameterEdit();
    return !active || JSON.stringify(currentDocument()) === active.savedDocument
      || win.confirm('Discard unsaved shader edits?');
  };

  const onSourceChange = async () => {
    if (!allowSourceChange()) {
      sourceSelect.value = selectedSource;
      return;
    }
    try {
      const option = sourceSelect.selectedOptions[0];
      if (!option?.value) {
        if (!await loadScratch()) {
          sourceSelect.value = selectedSource;
          return;
        }
        await adoptLoadedSource('', SCRATCH_FILENAME, '');
        return;
      }
      const entry = sourceCatalog.get(option.value);
      if (!entry) {
        showError(`The source catalog carries no document for "${option.value}".`);
        return;
      }
      if (!await loadSource(entry.source, entry.filename, entry.compiled)) {
        sourceSelect.value = selectedSource;
        return;
      }
      await adoptLoadedSource(entry.effectId, entry.filename, '');
    } catch (error) {
      showError(`Could not load shader source: ${errorDetail(error)}`);
    }
  };
  const onPresetChange = () => {
    if (!applyPreset(presetSelect.value)) {
      const refusal = status.textContent ?? 'The preset could not be applied.';
      presetSelect.value = active?.presetId ?? '';
      if (active) applyPreset(/** @type {string} */ (active.presetId));
      showError(refusal);
      return;
    }
    releaseOriginalLink();
    scheduleDeepLink();
    chainUi?.strip.render();
    void flushDeepLink();
  };
  const onOpen = () => fileInput.click();
  const onFileChange = async () => {
    try {
      const file = fileInput.files?.[0];
      if (!file) return;
      compiler ??= await importCompiler();
      if (file.size > compiler.DEFAULT_LIMITS.bytes) {
        showError('The document byte limit was exceeded.');
        return;
      }
      if (!allowSourceChange()) return;
      if (!await loadSource(await file.text(), file.name)) return;
      await adoptLoadedSource(null, file.name, 'Imported');
    } catch (error) {
      showError(`Could not open shader document: ${errorDetail(error)}`);
    } finally {
      fileInput.value = '';
    }
  };
  const onAnimationToggle = () => {
    const paused = getAnimationsPaused();
    if (paused === null) return;
    releaseOriginalLink();
    setAnimationsPaused(!paused);
    showAnimationState();
    invalidate();
    scheduleDeepLink();
  };
  const onParityToggle = () => {
    if (active === null || !parityArmed()) return;
    try {
      const official = /** @type {OfficialDocument} */ (active.official);
      const compiledSide = !active.compiledSide;
      const effect = compiledSide ? official.effectId : CHAIN_EFFECT;
      if (!selectEffect(effect)) {
        announce(`The preview engine rejected effect "${effectDisplayName(effect)}".`);
        return;
      }
      active.compiledSide = compiledSide;
      syncParity();
      chainUi?.strip.render();
      const presetId = active.presetId ?? presetSelect.value;
      if (!applyPreset(presetId)) {
        const refusal = status.textContent ?? 'The preset could not be applied.';
        const previousEffect = compiledSide ? CHAIN_EFFECT : official.effectId;
        if (!selectEffect(previousEffect)) {
          announce(`The preview engine rejected effect "${effectDisplayName(previousEffect)}".`);
          return;
        }
        active.compiledSide = !compiledSide;
        syncParity();
        chainUi?.strip.render();
        applyPreset(presetId);
        showError(refusal);
      }
    } catch (error) {
      showError(`The preview edit failed: ${errorDetail(error)}`);
      showAnimationState();
    }
  };
  const onDigest = async () => {
    const digest = digestButton?.dataset.digest;
    if (!digest) return;
    if (await copyToClipboard(digest)) showStatus(`Copied the descriptor digest ${digest}.`);
    else announce('The descriptor digest could not be copied.');
  };

  const onHashChange = async () => {
    if (!(win.location?.hash ?? '').startsWith('#shader=')) return;
    try {
      const linked = await decodeShaderStateHash(win.location.hash);
      if (!linked) return;
      if (!allowSourceChange()) {
        scheduleDeepLink();
        return;
      }
      if (!await loadLinkedSource(linked))
        throw new Error(status.textContent || 'the linked state was refused');
    } catch (error) {
      showError(`The shader link could not be restored: ${errorDetail(error)}.`);
    }
  };
  win.addEventListener?.('hashchange', onHashChange);

  sourceSelect.addEventListener('change', onSourceChange);
  presetSelect.addEventListener('change', onPresetChange);
  openButton.addEventListener('click', onOpen);
  fileInput.addEventListener('change', onFileChange);
  saveButton.addEventListener('click', save);
  saveAsButton?.addEventListener('click', saveAs);
  animationToggle?.addEventListener('click', onAnimationToggle);
  parityToggle?.addEventListener('click', onParityToggle);
  digestButton?.addEventListener('click', onDigest);

  const dispose = () => {
    const finalLinkWrite = flushDeepLink();
    linkDisposed = true;
    win.removeEventListener?.('hashchange', onHashChange);
    sourceSelect.removeEventListener('change', onSourceChange);
    presetSelect.removeEventListener('change', onPresetChange);
    openButton.removeEventListener('click', onOpen);
    fileInput.removeEventListener('change', onFileChange);
    saveButton.removeEventListener('click', save);
    saveAsButton?.removeEventListener('click', saveAs);
    animationToggle?.removeEventListener('click', onAnimationToggle);
    parityToggle?.removeEventListener('click', onParityToggle);
    digestButton?.removeEventListener('click', onDigest);
    teardownChainUi();
    return finalLinkWrite;
  };

  return {
    init, loadSource, save, saveAs, applyPreset,
    dispose,
    flushDeepLink,
    preservesOriginalLink: () => preserveRefusedLink,
  };
}
