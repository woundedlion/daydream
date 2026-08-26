/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { enumConstantName } from '../param_sync.js';
import { applyChainDocument } from './chain_apply.js';
import { createChainDocumentStore, scratchChainDocument } from './chain_document_store.js';
import { createChainStrip, titleCase } from './chain_strip.js';
import { copyToClipboard } from './copy_text.js';
import { downloadBlob } from './download_file.js';
import {
  decodeShaderStateHash, encodeShaderStateHash, replaceShaderStateHash,
} from './shader_deeplink.js';

const MIGRATION_URL = '../shader/patterns/shaderball_migration.json';
const CATALOG_URL = '../shader/engine_catalog.json';
const COMPILER_URL = new URL('../shader/shader_workbench.mjs', import.meta.url).href;

// The effect the dynamic path previews on: the engine's chain interpreter,
// programmed through setShaderChain.
const CHAIN_EFFECT = 'ShaderChain';

// Digest characters the toolbar shows; the button copies all of it.
const DIGEST_ABBREVIATION = 12;

// The download name the scratch document exports under until Save As renames it.
const SCRATCH_FILENAME = 'scratch.shader.json';

export const SHADER_LINK_DEBOUNCE_MS = 200;
export const SHADER_LINK_MAX_WAIT_MS = 1000;

// The one topology parameter a fixed effect leaves live, as an ordinary
// dropdown, rather than baking its variant in.
const LIVE_TOPOLOGY_FIELD = 'palette-mapping';

/**
 * The topology fields a fixed effect bakes in, read off the catalog's per
 * parameter `topology` flag. Topology enum8 parameters select an operator's
 * structural variant, so a fixed build registers no control for them and the
 * fixed apply path skips their authored values.
 * @param {*} operatorCatalog - The engine operator catalog.
 * @returns {Set<string>} The field segments the fixed path skips.
 */
export function bakedTopologyFields(operatorCatalog) {
  const fields = new Set();
  for (const operator of operatorCatalog?.operators ?? []) {
    for (const parameter of operator.params ?? [])
      if (parameter.topology === true) fields.add(parameter.id);
  }
  fields.delete(LIVE_TOPOLOGY_FIELD);
  return fields;
}

/**
 * Document parameter ids a compiled build holds as a compile-time constant.
 * The interpreter registers an ordinary control and reads the authored value;
 * the compiled effect registers none, so the fixed apply skips the id instead
 * of reading it as unmatched. AshCloud's CAMERA_SPIN_RATE is the only one.
 *
 * Whole ids, not field segments: `sample.spherical-rings.v3` registers a live
 * `spin-speed` of its own.
 *
 * The engine's scripts/wasm_smoke_predicates.mjs holds the same set and gates
 * the promoted documents against it; that module is not installed here, so
 * tests/wasm_provenance.test.js pins this re-implementation to it.
 */
export const BAKED_CONSTANT_IDS = new Set(['camera.spin-speed']);

/** @param {string} parameterId */
const fieldSegment = (parameterId) =>
  parameterId.slice(parameterId.indexOf('.') + 1);

/** @typedef {{name: string, value?: *, readonly?: boolean, options?: string[]}} ParameterDefinition */
/** @typedef {{document: *, descriptor_digest?: string, diagnostics?: *, status?: string}} CompiledDocument */

/**
 * Maps a v2 document parameter identity (`<label>.<field>`) to the control
 * name a pre-spec promoted effect registered. Newly promoted effects register
 * label-derived names, so this alias table only serves the effects promoted
 * before the chain schema and shrinks as they are re-registered.
 * @param {string} parameterId
 */
export function engineParameterName(parameterId) {
  const dot = parameterId.indexOf('.');
  if (dot < 0) return titleCase(parameterId);
  const label = parameterId.slice(0, dot);
  const field = parameterId.slice(dot + 1);
  if (label === 'warp1') return `Planar Warp 1 ${titleCase(field)}`;
  if (label === 'warp2') return `Planar Warp 2 ${titleCase(field)}`;
  if (label === 'surface') return `Surface Noise ${titleCase(field)}`;
  if (label === 'camera') return `Camera ${titleCase(field)}`;
  if (label === 'sample' && field === 'angle-speed') return 'Source Angle Speed';
  return titleCase(field);
}

/** @param {string} parameterId @returns {string[]} Candidates, most specific first. */
export function engineParameterNames(parameterId) {
  const primary = engineParameterName(parameterId);
  const dot = parameterId.indexOf('.');
  if (dot < 0) return [primary];
  const label = parameterId.slice(0, dot);
  const field = parameterId.slice(dot + 1);
  if (label === 'warp1' || label === 'warp2') {
    const suffix = titleCase(field);
    if (['Rotation Rate', 'Translation X', 'Translation Y', 'Scale X', 'Scale Y', 'Shear']
        .includes(suffix)) return [primary, `Affine ${suffix}`];
    if (['Radial Scale', 'Radial Phase', 'Angular Phase'].includes(suffix))
      return [primary, `Polar ${suffix}`];
    if (['Rotation', 'Cell X', 'Cell Y', 'Offset X', 'Offset Y'].includes(suffix))
      return [primary, `Mirror ${suffix}`];
    if (['Strength', 'Frequency', 'Field Angle', 'Scale', 'Vector Angle'].includes(suffix))
      return [primary, `Warp ${suffix}`];
    return [primary, suffix];
  }
  return [primary];
}

/**
 * A document enum8 value's comparison key. A document spells an option in the
 * catalog's kebab case and the engine registers its own display spelling, so
 * case and the hyphen/space split are both normalized away.
 * @param {*} label - A document value or an engine option.
 * @returns {string} The key.
 */
function optionKey(label) {
  return String(label).toLowerCase().replace(/[\s-]+/g, ' ').trim();
}

/** @param {ParameterDefinition} definition @param {*} label */
function optionIndex(definition, label) {
  const wanted = optionKey(label);
  return definition.options?.findIndex((option) => optionKey(option) === wanted) ?? -1;
}

/**
 * Writes one engine parameter.
 * @param {*} engine
 * @param {*} module - The loaded WASM module, for its ParamSetResult enum.
 *   setParameter answers one of its values; every value is a truthy object, so
 *   the outcome only reads as applied against APPLIED itself.
 * @param {ParameterDefinition[]} definitions
 * @param {string} name
 * @param {*} value
 * @returns {string|null} Refusal reason, or null once written.
 */
function writeEngineValue(engine, module, definitions, name, value) {
  const definition = definitions.find((candidate) => candidate.name === name);
  if (!definition) return `the engine has no parameter "${name}"`;
  if (definition.readonly) return `"${name}" is read-only`;
  let stored = value;
  if (definition.options) {
    if (typeof value !== 'number') {
      stored = optionIndex(definition, value);
      if (stored < 0) return `"${name}" has no option "${value}"`;
    }
  }
  const result = engine.setParameter(name, stored);
  if (result === module.ParamSetResult.APPLIED) return null;
  return `"${name}" was refused: ${enumConstantName(module.ParamSetResult, result)}`;
}

/**
 * @param {*} engine @param {*} module @param {CompiledDocument} compiled
 * @param {string} presetId
 * @param {Set<string>} baked - The topology fields the effect bakes in.
 * @returns {string|null} Refusal reason, or null once every value is written.
 */
function applyDocumentValues(engine, module, compiled, presetId, baked) {
  const preset = compiled.document.preset_bank.presets
    .find((/** @type {*} */ candidate) => candidate.preset_id === presetId)
    ?? compiled.document.preset_bank.presets[0];
  const definitions = engine.getParameterDefinitions();
  for (const [parameterId, value] of Object.entries(preset?.values ?? {})) {
    if (BAKED_CONSTANT_IDS.has(parameterId)) continue;
    if (baked.has(fieldSegment(parameterId))) continue;
    const name = engineParameterNames(parameterId)
      .find((candidate) => definitions.some(
        (/** @type {ParameterDefinition} */ definition) => definition.name === candidate));
    if (!name) return `no engine parameter matches "${parameterId}"`;
    const refusal = writeEngineValue(engine, module, definitions, name, value);
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
 * @param {Set<string>} baked - The topology fields the effect bakes in, from
 *   bakedTopologyFields.
 * @returns {string|null} Refusal reason, or null once applied.
 */
export function applyFixedShaderDocument(engine, module, compiled, presetId,
                                         referencePresetIds, baked) {
  const referenceId = referencePresetIds.includes(presetId)
    ? presetId : referencePresetIds[0];
  if (typeof referenceId !== 'string') return 'the effect has no reference preset';
  if (engine.selectPresetById?.(referenceId) !== true)
    return `the engine refused reference preset "${referenceId}"`;
  return applyDocumentValues(engine, module, compiled, presetId, baked);
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
 * fetchText?: (url: string) => Promise<string>, importCompiler?: () => Promise<*>,
 * download?: (filename: string, source: string) => void,
 * initialEffect?: string|null, win?: *}} dependencies - initialEffect is the effect the
 *   page was opened on, which init() honors when it names a catalog source.
 */
export function createShaderDocumentController({
  doc,
  getEngine,
  getModule,
  selectEffect,
  syncEffectGui,
  invalidate,
  getAnimationsPaused = () => null,
  setAnimationsPaused = () => {},
  setParamFilter = () => {},
  fetchText = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.text();
  },
  importCompiler = () => import(COMPILER_URL),
  download = (filename, source) => defaultDownload(doc, filename, source),
  initialEffect = null,
  win = globalThis,
}) {
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
  // A page without the strip mount (or a compiler without the validator)
  // previews documents but offers no structural editing.
  const stripMount = doc.getElementById('chain-strip');

  /** @type {*} */
  let compiler;
  /** @type {*|null} */
  let active = null;
  /** @type {Map<string, *>} */
  let catalog = new Map();
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

  /** @param {string} message @param {boolean} [error] */
  const show = (message, error = false) => {
    status.textContent = message;
    status.dataset.status = error ? 'error' : 'ok';
  };

  // The one shared live region: the page and the strip both report through it,
  // and an empty message clears it.
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
   * Bypass is a program-shape override that never touches the document, so it
   * leaves this true; the first descriptor-changing edit does not.
   * @returns {boolean} Whether the parity toggle is armed.
   */
  const parityArmed = () =>
    active?.official != null && liveDigest() === active.loadedDigest;

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
    digestButton.disabled = !digest;
  };

  const showAnimationState = () => {
    if (!animationToggle) return;
    const paused = getAnimationsPaused();
    animationToggle.disabled = paused === null;
    animationToggle.setAttribute('aria-pressed', String(paused === true));
    animationToggle.textContent = paused ? 'Resume animation' : 'Pause animation';
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
    const engine = getEngine();
    const module = getModule();
    if (!engine || !module || !active) {
      show('The preview engine is not ready.', true);
      return false;
    }
    // applyChainDocument owns the GUI resync and repaint (its apply order is
    // fixed); the fixed path runs them here. With the editor live, the store's
    // document is the authority (the imported compile goes stale on the first
    // structural edit) and its program shape carries the session bypasses.
    const store = chainUi?.store ?? null;
    const paused = getAnimationsPaused();
    const refusal = active.compiledSide
      ? applyFixedShaderDocument(
        engine, module, store ? { document: store.document() } : active.compiled,
        presetId, active.referencePresetIds, bakedFields)
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
    if (refusal) {
      show(`Preset "${presetId}" could not be applied: ${refusal}`, true);
      return false;
    }
    if (active.compiledSide) {
      syncEffectGui();
      invalidate();
    }
    active.presetId = presetId;
    const title = active.compiled.document.effect_metadata?.display_name
      ?? active.compiled.document.document_id;
    const preset = presetSelect.selectedOptions[0]?.textContent ?? presetId;
    // Only an armed toggle leaves which build is rendering in question.
    const side = !parityArmed() ? ''
      : active.compiledSide ? ' · compiled build' : ' · interpreter';
    show(`${title} · ${preset}${side}`);
    showDigest();
    scheduleDeepLink();
    return true;
  };

  const teardownChainUi = () => {
    if (chainUi === null) return;
    chainUi.strip.destroy();
    chainUi = null;
    setParamFilter(null);
  };

  /**
   * The live preview's control name for a document parameter: the interpreter
   * registers each id verbatim, while the compiled build takes its own control
   * names and bakes the topology fields and the constant ids in, so those reach
   * no control there.
   * @param {string} parameterId - A chain parameter id.
   * @param {ParameterDefinition[]} definitions - The engine's definitions.
   * @returns {string|null} The control name, or null where none takes the value.
   */
  const engineControlName = (parameterId, definitions) => {
    if (active?.compiledSide !== true) return parameterId;
    if (BAKED_CONSTANT_IDS.has(parameterId)) return null;
    if (bakedFields.has(fieldSegment(parameterId))) return null;
    return engineParameterNames(parameterId).find((candidate) =>
      definitions.some((definition) => definition.name === candidate)) ?? null;
  };

  /**
   * Routes an inline stage-control edit into the active preset: the document is
   * the source of truth and the engine write is its side effect.
   * @param {string} parameterId - The edited parameter's id.
   * @param {*} value - The document value: a number, or an enum8 option id.
   * @returns {void}
   */
  const writeStageEdit = (parameterId, value) => {
    if (chainUi === null || active === null || active.presetId === null) return;
    const result = chainUi.store.setPresetValue(active.presetId, parameterId, value);
    if (!result.ok) {
      announce(`"${parameterId}" was refused: ${result.diagnostics[0].message}`);
      return;
    }
    chainUi.strip.syncHistory();
    scheduleDeepLink();
    const engine = getEngine();
    const module = getModule();
    if (!engine || !module) return;
    const definitions = engine.getParameterDefinitions();
    const name = engineControlName(parameterId, definitions);
    const paused = getAnimationsPaused();
    const refusal = name === null ? null
      : writeEngineValue(engine, module, definitions, name, value);
    if (paused !== null) {
      setAnimationsPaused(paused);
      syncEffectGui();
    }
    showAnimationState();
    if (refusal) {
      announce(refusal);
      return;
    }
    invalidate();
  };

  /**
   * Builds the pipeline strip over one document store, wiring every structural
   * edit, undo and bypass toggle back through the one apply path. The stages'
   * parameters render on the strip's chips, so the effect GUI panel is told to
   * build none of them.
   * @param {*} document - The compiled (valid) v2 document to edit.
   */
  const buildChainUi = async (document) => {
    const store = /** @type {*} */ (await createChainDocumentStore({
      document, catalog: operatorCatalog, importCompiler,
    }));
    const strip = /** @type {*} */ (createChainStrip({
      doc,
      container: stripMount,
      store,
      catalog: operatorCatalog,
      announce,
      onApply: () => {
        const dropped = syncParity();
        applyPreset(active?.presetId ?? presetSelect.value);
        if (dropped) {
          // The return to the interpreter re-enables the bypass toggles the
          // rebuild that led here drew disabled.
          chainUi?.strip.render();
          show('The edit changed the descriptor: the preview is back on the '
            + 'interpreter and the parity toggle is disarmed.');
        }
      },
      presetId: () => active?.presetId ?? null,
      onEditParameter: writeStageEdit,
      onCommitParameter: () => { void flushDeepLink(); },
      // Only applyChainDocument is handed the program shape a bypass overrides.
      bypassAvailable: () => active?.compiledSide !== true,
    }));
    setParamFilter({ external: true });
    chainUi = { store, strip };
  };

  /**
   * @param {string|*} source - Document JSON, or the document itself.
   * @param {string} [filename]
   * @param {*} [precompiled] - The catalog's already-compiled document, when the
   *   source is a catalog entry rather than an imported study.
   * @param {*|null} [session] - Deep-linked preset, bypass, and pause state.
   */
  const loadSource = async (source, filename = 'import.shader.json',
                            precompiled = null, session = null) => {
    await flushDeepLink();
    linkGeneration += 1;
    compiler ??= await importCompiler();
    let compiled = precompiled;
    if (compiled === null) {
      // The compiler answers a malformed document with diagnostics, so anything
      // thrown here is the compiler itself failing on this input.
      try {
        compiled = compiler.compileShaderDocument(source, { catalog: operatorCatalog });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        show(`The document could not be compiled: ${detail}`, true);
        return false;
      }
    }
    if (compiled.status !== 'VALID') {
      show(diagnosticText(compiled), true);
      return false;
    }
    // Resolved before anything is built: the strip's inline chip controls render
    // the active preset's values, so a deep link into a non-first preset would
    // otherwise describe the first one under the render it names.
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
    // Every load previews through the interpreter, so a shipped pattern opens
    // as editable as a scratch chain; a digest match only arms the toolbar's
    // parity toggle to the promoted build.
    const official = [...catalog.values()].find((candidate) =>
      candidate.descriptorDigest === compiled.descriptor_digest) ?? null;
    // Ahead of the teardown: a refusal here must leave the editor it would
    // have replaced standing.
    if (!selectEffect(CHAIN_EFFECT)) {
      show(`The preview engine rejected effect "${CHAIN_EFFECT}".`, true);
      return false;
    }
    teardownChainUi();
    const previous = active;
    // The strip renders the active preset's values, so the document is adopted
    // before the editor is built.
    active = {
      compiled,
      filename,
      official,
      loadedDigest: compiled.descriptor_digest,
      compiledSide: false,
      presetId,
      referencePresetIds: official?.presetIds ?? [],
    };
    /**
     * Puts the toolbar back on the document the engine is still rendering: the
     * program is only written once every step below has succeeded, so a refusal
     * before that must not leave the two describing different documents.
     * @returns {boolean} The load's refusal.
     */
    const abandon = () => {
      teardownChainUi();
      active = previous;
      if (previous?.compiledSide && previous.official)
        selectEffect(previous.official.effectId);
      return false;
    };
    if (stripMount && typeof compiler.validateShaderDocument === 'function') {
      try {
        await buildChainUi(compiled.document);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
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
    if (session) setAnimationsPaused(session.paused);
    return applyPreset(presetId);
  };

  /**
   * The document as it stands: the store's once the editor is live, else the
   * load-time compile. Every edit is already a document edit, so nothing is
   * harvested back out of the engine.
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
    const state = {
      document: currentDocument(),
      preset: active.presetId,
      bypassed: chainUi?.store.bypassedLabels() ?? [],
      paused: getAnimationsPaused() === true,
    };
    linkWrite = encodeShaderStateHash(state).then((hash) => {
      if (generation === linkGeneration) replaceShaderStateHash(hash, win);
    }).catch((error) => {
      if (generation !== linkGeneration) return;
      const detail = error instanceof Error ? error.message : String(error);
      show(`The shader link could not be updated: ${detail}.`, true);
    });
    return linkWrite;
  };

  const flushDeepLink = () => {
    chainUi?.strip.flushParameterEdit();
    return writeDeepLink();
  };

  const scheduleDeepLink = () => {
    if (linkDisposed || !active || active.presetId === null) return;
    linkGeneration += 1;
    linkPending = true;
    if (linkDebounceTimer !== null) clearTimeout(linkDebounceTimer);
    linkDebounceTimer = setTimeout(writeDeepLink, SHADER_LINK_DEBOUNCE_MS);
    linkMaxTimer ??= setTimeout(writeDeepLink, SHADER_LINK_MAX_WAIT_MS);
  };

  /**
   * @param {*} document - The document to write.
   * @param {string} filename - The download name.
   * @returns {boolean} Always true; a valid-by-construction document has no
   *   export failure state.
   */
  const exportDocument = (document, filename) => {
    download(filename, compiler.exportShaderDocumentJson(document));
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
   * Opens the default chain on catalog defaults through the ordinary load path,
   * so an unnamed session authors against the same strip a loaded document
   * gets.
   * @returns {Promise<boolean>} Whether the scratch document is on screen.
   */
  const loadScratch = () =>
    loadSource(scratchChainDocument(operatorCatalog), SCRATCH_FILENAME);

  const init = async () => {
    try {
      compiler = await importCompiler();
      operatorCatalog = JSON.parse(await fetchText(CATALOG_URL));
      bakedFields = bakedTopologyFields(operatorCatalog);
      const migration = JSON.parse(await fetchText(MIGRATION_URL));
      const entries = await Promise.all(Object.entries(migration.source_documents)
        .map(async ([effectId, filename]) => {
          const source = await fetchText(`../shader/patterns/${filename}`);
          const compiled = compiler.compileShaderDocument(source,
            { catalog: operatorCatalog });
          if (compiled.status !== 'VALID')
            throw new Error(`${filename}: ${diagnosticText(compiled)}`);
          return [effectId, filename, source, compiled];
        }));
      catalog = new Map(entries.map(([effectId, filename, source, compiled]) =>
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
        option.textContent = migration.product_group.children
          .find((/** @type {*} */ child) => child.effect_id === effectId)?.display_name
          ?? effectId;
        sourceSelect.appendChild(option);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      show(`Source catalog failed to load: ${detail}`, true);
      return false;
    }
    let linked = null;
    let linkError = '';
    try {
      linked = await decodeShaderStateHash(win.location?.hash ?? '');
    } catch (error) {
      linkError = error instanceof Error ? error.message : String(error);
    }
    if (linked) {
      const effectId = linked.document.effect_id;
      const filename = typeof linked.document.document_id === 'string'
        ? `${linked.document.document_id}.shader.json` : 'linked.shader.json';
      // Named only once the load stands: a refused link falls through to the
      // requested effect or the scratch chain, which name themselves.
      if (await loadSource(linked.document, filename, null, linked)) {
        sourceSelect.value = catalog.has(effectId) ? effectId : '';
        return true;
      }
      linkError = status.textContent || 'the linked state was refused';
    }
    const requested = catalog.get(initialEffect ?? '');
    let loaded;
    if (requested === undefined) loaded = await loadScratch();
    else {
      loaded = await loadSource(requested.source, requested.filename, requested.compiled);
      if (loaded) sourceSelect.value = requested.effectId;
    }
    if (linkError) show(`The shader link could not be restored: ${linkError}.`, true);
    return loaded;
  };

  const onSourceChange = async () => {
    const option = sourceSelect.selectedOptions[0];
    if (!option?.value) {
      await loadScratch();
      await flushDeepLink();
      return;
    }
    const entry = catalog.get(option.value);
    if (!entry) {
      show(`The source catalog carries no document for "${option.value}".`, true);
      return;
    }
    await loadSource(entry.source, entry.filename, entry.compiled);
    await flushDeepLink();
  };
  const onPresetChange = () => {
    applyPreset(presetSelect.value);
    chainUi?.strip.render();
    void flushDeepLink();
  };
  const onOpen = () => fileInput.click();
  const onFileChange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    sourceSelect.value = '';
    await loadSource(await file.text(), file.name);
    await flushDeepLink();
    fileInput.value = '';
  };
  const onAnimationToggle = () => {
    const paused = getAnimationsPaused();
    if (paused === null) return;
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
    // The side decides whether the strip's bypass toggles do anything.
    chainUi?.strip.render();
    applyPreset(active.presetId ?? presetSelect.value);
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
  // A/B verification only: the toggle swaps which build renders the loaded
  // document and touches neither the document nor the editing surface.
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
  };
}
