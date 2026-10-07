/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { engineHalted } from '../../shared/engine_halt.js';
import { callWorkbenchBinding, shaderChainCatalog } from '../../engine/workbench_bindings.js';
import { enumConstantName, optionValue } from '../../effects/param_sync.js';
import { fieldOf as fieldSegment } from './chain_presentation.js';
import { errorDetail } from '../../shared/banner.js';
import { applyChainDocument } from './chain_apply.js';
import { createChainDocumentStore, documentFromChainSnapshot, scratchChainDocument } from './chain_document_store.js';
import { createChainStrip } from './chain_strip.js';
import { BAKED_CONSTANT_IDS, bakedTopologyFields, engineControlNames } from '../../../generated/shader/shader_workbench.mjs';
export { BAKED_CONSTANT_IDS, bakedTopologyFields } from '../../../generated/shader/shader_workbench.mjs';
import { CHAIN_SNAPSHOT_STORAGE_KEY } from '../../effects/effect_persistence.js';
import { copyToClipboard } from '../../shared/copy_text.js';
import { downloadBlob } from '../../shared/download_file.js';
import {
  decodeShaderStateHash, encodeShaderStateHash, replaceShaderStateHash,
} from './shader_deeplink.js';

const PATTERN_CATALOG_URL = '../../../generated/shader/patterns/catalog.json';
const CATALOG_URL = '../../../generated/shader/engine_catalog.json';
const COMPILER_URL = new URL('../../../generated/shader/shader_workbench.mjs', import.meta.url).href;

// The engine's chain interpreter, programmed through setShaderChain.
const CHAIN_EFFECT = 'ShaderChain';

// Digest characters the toolbar shows; the button copies all of it.
const DIGEST_ABBREVIATION = 12;

// The download name used by Save for the scratch document.
const SCRATCH_FILENAME = 'scratch.shader.json';

export const SHADER_LINK_DEBOUNCE_MS = 200;
export const SHADER_LINK_MAX_WAIT_MS = 1000;

/** @typedef {{name: string, value?: *, readonly?: boolean, options?: string[], optionValues?: number[]}} ParameterDefinition */
/** @typedef {{document: *, descriptor_digest?: string, diagnostics?: *, status?: string}} CompiledDocument */

/** @param {string} parameterId @returns {string} The primary engine control name. */
export function engineParameterName(parameterId) {
  return engineControlNames(parameterId)[0];
}


/**
 * Resolves one engine parameter write without performing it.
 * @param {ParameterDefinition[]} definitions
 * @param {string} name
 * @param {*} value
 * @returns {{name: string, stored: *}|string} The write, or the refusal reason.
 */
function resolveEngineValue(definitions, name, value) {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) return `the engine has no parameter "${name}"`;
  if (definition.readonly) return `"${name}" is read-only`;
  if (definition.options && typeof value !== 'number') {
    const stored = optionValue(definition, value);
    if (stored === null) return `"${name}" has no option "${value}"`;
    return { name, stored };
  }
  if (definition.optionValues && !definition.optionValues.includes(value))
    return `"${name}" has no option value ${value}`;
  return { name, stored: value };
}

/**
 * Performs one resolved write.
 * @param {*} engine
 * @param {*} module - The loaded WASM module, for its ParamSetResult enum.
 *   Every enum value is a truthy object; compare against APPLIED.
 * @param {{name: string, stored: *}} write
 * @returns {string|null} Refusal reason, or null once written.
 */
function performEngineWrite(engine, module, { name, stored }) {
  const result = engine.setParameter(name, stored);
  if (result === module.ParamSetResult.APPLIED) return null;
  return `"${name}" was refused: ${enumConstantName(module.ParamSetResult, result)}`;
}

/**
 * Writes one engine parameter.
 * @param {*} engine
 * @param {*} module
 * @param {ParameterDefinition[]} definitions
 * @param {string} name
 * @param {*} value
 * @returns {string|null} Refusal reason, or null once written.
 */
function writeEngineValue(engine, module, definitions, name, value) {
  const write = resolveEngineValue(definitions, name, value);
  return typeof write === 'string' ? write : performEngineWrite(engine, module, write);
}


/**
 * @param {string} parameterId
 * @param {ParameterDefinition[]} definitions
 * @param {Set<string>} baked
 * @returns {{name: string|null, refusal: string|null}} Compiled control or refusal.
 */
function compiledControlFor(parameterId, definitions, baked) {
  if (BAKED_CONSTANT_IDS.has(parameterId) || baked.has(fieldSegment(parameterId)))
    return { name: null, refusal: null };
  const name = engineControlNames(parameterId)
    .find((candidate) => definitions.some((definition) => definition.name === candidate));
  return name ? { name, refusal: null }
    : { name: null, refusal: `no engine parameter matches "${parameterId}"` };
}

/**
 * @param {*} engine @param {*} module @param {CompiledDocument} compiled
 * @param {string} presetId
 * @param {Set<string>} baked - The topology fields the effect bakes in.
 * @param {Set<string>} derived - Validated fields computed by the fixed effect.
 * @returns {string|null} Refusal reason, or null once every writable value is written.
 *   Baked and derived values are skipped; an unregistered id refuses before any write.
 */
function applyDocumentValues(engine, module, compiled, presetId, baked, derived) {
  const preset = compiled.document.preset_bank.presets
    .find((/** @type {*} */ candidate) => candidate.preset_id === presetId)
    ?? compiled.document.preset_bank.presets[0];
  const definitions = engine.getParameterDefinitions();
  /** @type {Array<{name: string, stored: *}>} */
  const writes = [];
  for (const [parameterId, value] of Object.entries(preset?.values ?? {})) {
    if (derived.has(parameterId)) continue;
    const { name, refusal } = compiledControlFor(parameterId, definitions, baked);
    if (refusal) return refusal;
    if (name === null) continue;
    const write = resolveEngineValue(definitions, name, value);
    if (typeof write === 'string') return write;
    writes.push(write);
  }
  for (const write of writes) {
    const refusal = performEngineWrite(engine, module, write);
    if (refusal) return refusal;
  }
  return null;
}

/**
 * Applies one authored preset to a matching concrete fixed-pipeline effect.
 * @param {*} engine
 * @param {*} module
 * @param {CompiledDocument} compiled
 * @param {string} presetId
 * @param {string[]} referencePresetIds
 * @param {Set<string>} baked - The topology fields the effect bakes in.
 * @param {(descriptor: *, parameterId: string, values: *) => *} deriveBinding - Compiler binding resolver.
 * @returns {string|null} Refusal reason, or null once applied.
 */
export function applyFixedShaderDocument(engine, module, compiled, presetId,
                                         referencePresetIds, baked, deriveBinding) {
  const referenceId = referencePresetIds.includes(presetId)
    ? presetId : referencePresetIds[0];
  if (typeof referenceId !== 'string') return 'the effect has no reference preset';
  const preset = compiled.document.preset_bank.presets
    .find((/** @type {*} */ candidate) => candidate.preset_id === presetId)
    ?? compiled.document.preset_bank.presets[0];
  const values = preset?.values ?? {};
  const derived = new Set();
  for (const parameterId of Object.keys(values)) {
    const binding = deriveBinding(compiled.document.descriptor, parameterId, values);
    if (!binding) continue;
    if (!binding.valid)
      return `"${parameterId}" must match the fixed build's derived value ${binding.expected}`;
    derived.add(parameterId);
  }
  if (engine.selectPresetById?.(referenceId) !== true)
    return `the engine refused reference preset "${referenceId}"`;
  return applyDocumentValues(engine, module, compiled, presetId, baked, derived);
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
    const response = await fetch(new URL(url, import.meta.url));
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  },
  importCompiler = () => import(COMPILER_URL),
  download = (filename, source) => defaultDownload(doc, filename, source),
  initialEffect = null,
  win = globalThis,
}) {
  const selectEffect = (/** @type {string} */ effect) => {
    const module = getModule();
    if (module?.HS_MODULE_DEAD) return false;
    try { return readSelectEffect(effect); }
    catch (error) {
      if (module && engineHalted(error, module)) module.HS_MODULE_DEAD = true;
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
  /** @type {*|null} */
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

  /** @param {string} message @param {boolean} [error] */
  const show = (message, error = false) => {
    status.setAttribute('role', error ? 'alert' : 'status');
    status.setAttribute('aria-live', error ? 'assertive' : 'polite');
    status.dataset.status = error ? 'error' : 'ok';
    status.textContent = message;
  };

  // The shared live region; an empty message clears it.
  /** @param {string} message */
  const announce = (message) => show(message, message !== '');

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
    animationToggle.textContent = 'Pause animation';
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

  /** @param {string} presetId */
  const applyPreset = (presetId) => {
    try {
      const engine = getEngine();
      const module = getModule();
      if (!engine || !module || !active) {
        show('The preview engine is not ready.', true);
        return false;
      }
      // With the editor live, the store's document is authoritative and its
      // program shape carries the session bypasses.
      const store = chainUi?.store ?? null;
      const paused = getAnimationsPaused();
      const refusal = active.compiledSide
        ? applyFixedShaderDocument(
          engine, module, store ? { document: store.document() } : active.compiled,
          presetId, active.referencePresetIds, bakedFields, compiler.fixedDerivedBinding)
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
        show(`Preset "${presetId}" could not be applied: ${refusal}`, true);
        return false;
      }
      active.presetId = presetId;
      const title = active.compiled.document.effect_metadata?.display_name
        ?? active.compiled.document.document_id;
      const preset = presetSelect.selectedOptions[0]?.textContent ?? presetId;
      const side = !parityArmed() ? ''
        : active.compiledSide ? ' · compiled build' : ' · interpreter';
      show(`${title} · ${preset}${side}`);
      showDigest();
      scheduleDeepLink();
      return true;
    } catch (error) {
      const module = getModule();
      if (module && engineHalted(error, module)) module.HS_MODULE_DEAD = true;
      show(`The preview edit failed: ${errorDetail(error)}`, true);
      return false;
    }
  };

  const teardownChainUi = () => {
    if (chainUi === null) return;
    chainUi.strip.destroy();
    chainUi = null;
    setParamFilter(null);
  };

  /**
   * The live preview's control name for a document parameter: the interpreter
   * registers each id verbatim; the compiled build bakes topology fields and
   * constant ids in.
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
    return compiledControlFor(parameterId, definitions, bakedFields);
  };

  /** @param {string} parameterId @returns {boolean} */
  const parameterLive = (parameterId) => active?.compiledSide !== true
    || (!BAKED_CONSTANT_IDS.has(parameterId) && !bakedFields.has(fieldSegment(parameterId))
      && !compiler.fixedDerivedBinding?.(
        { chain: chainUi?.store.chainView() ?? active.compiled.document.descriptor.chain },
        parameterId, {}));

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
      const addsDeclaration = !chainUi.store.declares(parameterId);
      const result = chainUi.store.setPresetValue(active.presetId, parameterId, value, () => {
        if (addsDeclaration && active.compiledSide) return { ok: true };
        const engine = getEngine();
        const module = getModule();
        if (!engine || !module) return { ok: true };
        const definitions = engine.getParameterDefinitions();
        const control = engineControlName(parameterId, definitions);
        const paused = getAnimationsPaused();
        const refusal = control.refusal ?? (control.name === null ? null
          : writeEngineValue(engine, module, definitions, control.name, value));
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
      if (addsDeclaration) {
        const dropped = syncParity();
        applyPreset(active.presetId);
        if (dropped) chainUi.strip.render();
      }
      chainUi.strip.syncHistory();
      scheduleDeepLink();
      return true;
    } catch (error) {
      const module = getModule();
      if (module && engineHalted(error, module)) module.HS_MODULE_DEAD = true;
      show(`The preview edit failed: ${errorDetail(error)}`, true);
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
        applyPreset(active?.presetId ?? presetSelect.value);
        if (dropped) {
          // Re-enables the bypass toggles on the interpreter.
          chainUi?.strip.render();
          show('The edit changed the descriptor: the preview is back on the '
            + 'interpreter and the parity toggle is disarmed.');
        }
      },
      presetId: () => active?.presetId ?? null,
      onEditParameter: writeStageEdit,
      parameterLive,
      onCommitParameter: () => { void flushDeepLink(); },
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
        show(`The document could not be compiled: ${detail}`, true);
        return false;
      }
    }
    if (compiled.status !== 'VALID') {
      show(diagnosticText(compiled), true);
      return false;
    }
    // Resolved before anything is built: the strip renders the active preset's values.
    const presetId = session?.preset
      ?? compiled.document.preset_bank.presets[0]?.preset_id;
    if (!presetId) {
      show('The document is valid, but it carries no preset to preview.', true);
      return false;
    }
    if (!compiled.document.preset_bank.presets.some(
      (/** @type {*} */ preset) => preset.preset_id === presetId)) {
      show(`The shader link names no document preset "${presetId}".`, true);
      return false;
    }
    // Every load previews through the interpreter; a digest match arms the parity toggle.
    const previousSnapshot = callWorkbenchBinding(getEngine(), 'getShaderChainBindings', 'getSnapshot', []);
    const official = [...sourceCatalog.values()].find((candidate) =>
      candidate.descriptorDigest === compiled.descriptor_digest) ?? null;
    // Ahead of the teardown, so a refusal leaves the current editor standing.
    try {
      if (!selectEffect(CHAIN_EFFECT)) {
        show(`The preview engine rejected effect "${CHAIN_EFFECT}".`, true);
        return false;
      }
    } catch (error) {
      show(`The preview edit failed: ${errorDetail(error)}`, true);
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
     * @param {boolean} [written] - Whether the program write has run.
     * @returns {boolean} The load's refusal.
     */
    const abandon = (written = false) => {
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
        if (previousSnapshot) callWorkbenchBinding(getEngine(), 'getShaderChainBindings', 'restoreSnapshot', [previousSnapshot]);
        show(refusal ?? '', true);
      }
      return false;
    };
    if (candidateMount && typeof compiler.validateShaderDocument === 'function') {
      try {
        chainUi = await buildChainUi(compiled.document, candidateMount);
      } catch (error) {
        const detail = errorDetail(error);
        show(`The chain editor could not adopt the document: ${detail}`, true);
        return abandon();
      }
    }
    if (session && chainUi) {
      for (const label of session.bypassed) {
        const result = chainUi.store.setBypassed(label, true);
        if (!result.ok) {
          show(`The shader link could not bypass "${label}": `
            + `${result.diagnostics[0].message}.`, true);
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
    if (!applyPreset(presetId)) return abandon(true);
    if (session?.chainSnapshot) {
      const expected = callWorkbenchBinding(getEngine(), 'getShaderChainBindings', 'getSnapshot', []);
      const snapshot = session.chainSnapshot;
      const values = new Map(snapshot.parameters.map((/** @type {*} */ entry) => [entry.name, entry.value]));
      if (!expected || JSON.stringify(expected.chain) !== JSON.stringify(snapshot.chain)
          || expected.parameters.length !== values.size
          || expected.parameters.some((/** @type {*} */ entry) => entry.value !== Math.fround(values.get(entry.name)))) {
        show('The shader link snapshot does not match its document and preset.', true);
        return abandon(true);
      }
      if (callWorkbenchBinding(getEngine(), 'getShaderChainBindings', 'restoreSnapshot', [snapshot])
          !== getModule().ChainSnapshotRestoreResult.APPLIED) {
        show('The shader link runtime snapshot was rejected.', true);
        return abandon(true);
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
    : structuredClone(active.compiled.document);

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
    const generation = linkGeneration;
    const chainSnapshot = callWorkbenchBinding(getEngine(), 'getShaderChainBindings', 'getSnapshot', []);
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
      show(`The shader link could not be updated: ${detail}.`, true);
    });
    return linkWrite;
  };

  const flushDeepLink = () => {
    chainUi?.strip.flushParameterEdit();
    return writeDeepLink();
  };

  const scheduleDeepLink = () => {
    if (linkDisposed || preserveRefusedLink || !active || active.presetId === null) return;
    linkGeneration += 1;
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
    active.savedDocument = JSON.stringify(currentDocument());
    show(`Saved ${filename}.`);
    return true;
  };

  const save = () => {
    if (!active) return false;
    void flushDeepLink();
    const document = currentDocument();
    return exportDocument(document, active.filename.endsWith('.shader.json')
      ? active.filename : `${document.effect_id ?? document.document_id}.shader.json`);
  };

  /**
   * Writes a copy under a fresh document id. The loaded document keeps its own
   * id and download name, so a following Save still re-exports the original.
   * @returns {boolean} Whether a document was written.
   */
  const saveAs = () => {
    if (!active) return false;
    void flushDeepLink();
    const document = currentDocument();
    copies += 1;
    document.document_id = `${document.document_id}-copy${copies}`;
    return exportDocument(document, `${document.document_id}.shader.json`);
  };

  /**
   * Opens the default chain on catalog defaults through the ordinary load path.
   * @returns {Promise<boolean>} Whether the scratch document is on screen.
   */
  const loadScratch = () =>
    loadSource(scratchChainDocument(operatorCatalog), SCRATCH_FILENAME);

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
          return [effectId, filename, source, compiled];
        }));
      sourceCatalog = new Map(entries.map(([effectId, filename, source, compiled]) =>
        [effectId, {
          effectId,
          filename,
          source,
          compiled,
          descriptorDigest: compiled.descriptor_digest,
          presetIds: compiled.document.preset_bank.presets.map(
            (/** @type {*} */ preset) => preset.preset_id),
        }]));
      for (const [effectId] of entries) {
        const option = doc.createElement('option');
        option.value = effectId;
        option.textContent = patternCatalog.product_group.children
          .find((/** @type {*} */ child) => child.effect_id === effectId)?.display_name
          ?? effectId;
        sourceSelect.appendChild(option);
      }
    } catch (error) {
      const detail = errorDetail(error);
      show(`Source catalog failed to load: ${detail}`, true);
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
      const effectId = linked.document.effect_id;
      const entry = [...sourceCatalog.values()].find(
        (candidate) => candidate.compiled.document.effect_id === effectId);
      const filename = entry?.filename ?? 'linked.shader.json';
      // Named only once the load stands.
      if (await loadSource(linked.document, filename, null, linked)) {
        active.savedDocument = entry ? JSON.stringify(entry.compiled.document) : null;
        selectLoadedSource(entry?.effectId ?? null, filename, 'Linked');
        return true;
      }
      linkError = status.textContent || 'the linked state was refused';
    }
    if (linkError) {
      preserveRefusedLink = true;
      clearLinkTimers();
      linkPending = false;
      linkGeneration += 1;
    }
    const query = new URLSearchParams(win.location?.search ?? '');
    const chainText = query.get(`fx.${CHAIN_SNAPSHOT_STORAGE_KEY}`);
    if (!linked && !linkError && chainText !== null) {
      try {
        const snapshot = JSON.parse(chainText);
        const imported = documentFromChainSnapshot(snapshot, operatorCatalog);
        const previous = callWorkbenchBinding(getEngine(), 'getShaderChainBindings', 'getSnapshot', []);
        if (!await loadSource(imported, 'imported.shader.json'))
          throw new Error(status.textContent || 'the imported chain could not be adopted');
        const outcome = callWorkbenchBinding(getEngine(), 'getShaderChainBindings', 'restoreSnapshot', [snapshot]);
        if (outcome !== getModule().ChainSnapshotRestoreResult.APPLIED) {
          if (previous) callWorkbenchBinding(getEngine(), 'getShaderChainBindings', 'restoreSnapshot', [previous]);
          throw new Error('the imported chain snapshot was rejected');
        }
        selectLoadedSource(null, 'imported.shader.json', 'Imported');
        syncEffectGui();
        invalidate();
        scheduleDeepLink();
        await flushDeepLink();
        show('Restored the chain snapshot.');
        return true;
      } catch (error) {
        linkError = errorDetail(error);
        preserveRefusedLink = true;
        clearLinkTimers();
        linkPending = false;
        linkGeneration += 1;
      }
    }
    const requested = sourceCatalog.get(initialEffect ?? '');
    let loaded;
    if (requested === undefined) loaded = await loadScratch();
    else {
      loaded = await loadSource(requested.source, requested.filename, requested.compiled);
      if (loaded) sourceSelect.value = requested.effectId;
    }
    selectedSource = sourceSelect.value;
    if (linkError) show(`The shader link could not be restored: ${linkError}.`, true);
    return loaded;
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
        selectLoadedSource('', SCRATCH_FILENAME, '');
        releaseOriginalLink();
        scheduleDeepLink();
        await flushDeepLink();
        return;
      }
      const entry = sourceCatalog.get(option.value);
      if (!entry) {
        show(`The source catalog carries no document for "${option.value}".`, true);
        return;
      }
      if (!await loadSource(entry.source, entry.filename, entry.compiled)) {
        sourceSelect.value = selectedSource;
        return;
      }
      selectLoadedSource(entry.effectId, entry.filename, '');
      releaseOriginalLink();
      scheduleDeepLink();
      await flushDeepLink();
    } catch (error) {
      show(`Could not load shader source: ${errorDetail(error)}`, true);
    }
  };
  const onPresetChange = () => {
    if (!applyPreset(presetSelect.value)) {
      presetSelect.value = active?.presetId ?? '';
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
        show('The document byte limit was exceeded.', true);
        return;
      }
      if (!allowSourceChange()) return;
      if (!await loadSource(await file.text(), file.name)) return;
      selectLoadedSource(null, file.name, 'Imported');
      releaseOriginalLink();
      scheduleDeepLink();
      await flushDeepLink();
    } catch (error) {
      show(`Could not open shader document: ${errorDetail(error)}`, true);
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
    const compiledSide = !active.compiledSide;
    const effect = compiledSide ? active.official.effectId : CHAIN_EFFECT;
    if (!selectEffect(effect)) {
      announce(`The preview engine rejected effect "${effect}".`);
      return;
    }
    active.compiledSide = compiledSide;
    syncParity();
    chainUi?.strip.render();
    const presetId = active.presetId ?? presetSelect.value;
    if (!applyPreset(presetId)) {
      const refusal = status?.textContent ?? 'The preset could not be applied.';
      const previousEffect = compiledSide ? CHAIN_EFFECT : active.official.effectId;
      if (!selectEffect(previousEffect)) {
        announce(`The preview engine rejected effect "${previousEffect}".`);
        return;
      }
      active.compiledSide = !compiledSide;
      syncParity();
      chainUi?.strip.render();
      applyPreset(presetId);
      show(refusal, true);
    }
  };
  const onDigest = async () => {
    const digest = digestButton?.dataset.digest;
    if (!digest) return;
    if (await copyToClipboard(digest)) show(`Copied the descriptor digest ${digest}.`);
    else announce('The descriptor digest could not be copied.');
  };

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
