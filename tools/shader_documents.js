/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { engineHalted } from './engine_halt.js';
import { enumConstantName } from '../param_sync.js';
import { errorDetail } from './banner.js';
import { applyChainDocument } from './chain_apply.js';
import { createChainDocumentStore, scratchChainDocument } from './chain_document_store.js';
import { createChainStrip } from './chain_strip.js';
import { engineControlNames } from '../shader/shader_workbench.mjs';
import { copyToClipboard } from './copy_text.js';
import { downloadBlob } from './download_file.js';
import {
  decodeShaderStateHash, encodeShaderStateHash, replaceShaderStateHash,
} from './shader_deeplink.js';

const MIGRATION_URL = '../shader/patterns/shaderball_migration.json';
const DIGEST_MIGRATION_URL = '../shader/patterns/digest_migration.v1v2.json';
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

/** @param {string} parameterId @returns {string} The primary engine control name. */
export function engineParameterName(parameterId) {
  return engineControlNames(parameterId)[0];
}

export { engineControlNames as engineParameterNames };

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
    const stored = optionIndex(definition, value);
    if (stored < 0) return `"${name}" has no option "${value}"`;
    return { name, stored };
  }
  return { name, stored: value };
}

/**
 * Performs one resolved write.
 * @param {*} engine
 * @param {*} module - The loaded WASM module, for its ParamSetResult enum.
 *   setParameter answers one of its values; every value is a truthy object, so
 *   the outcome only reads as applied against APPLIED itself.
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
 * @param {*} engine @param {*} module @param {CompiledDocument} compiled
 * @param {string} presetId
 * @param {Set<string>} baked - The topology fields the effect bakes in.
 * @param {Set<string>} derived - Validated fields computed by the fixed effect.
 * @returns {string|null} Refusal reason, or null once every value is written.
 *   Every value is resolved before the first write, so an id the engine does
 *   not register refuses without a partial write.
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
    if (BAKED_CONSTANT_IDS.has(parameterId)) continue;
    if (baked.has(fieldSegment(parameterId))) continue;
    const name = engineControlNames(parameterId)
      .find((candidate) => definitions.some(
        (/** @type {ParameterDefinition} */ definition) => definition.name === candidate));
    if (!name) return `no engine parameter matches "${parameterId}"`;
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
 * @param {Set<string>} baked - The topology fields the effect bakes in, from
 *   bakedTopologyFields.
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
  // A page without the strip mount (or a compiler without the validator)
  // previews documents but offers no structural editing.
  const stripMount = doc.getElementById('chain-strip');

  /** @type {*} */
  let compiler;
  /** @type {*|null} */
  let active = null;
  let selectedSource = '';
  /** @type {Map<string, *>} */
  let sourceCatalog = new Map();
  /** @type {Record<string, string>} */
  let digestMigration = {};
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
    status.setAttribute('role', error ? 'alert' : 'status');
    status.setAttribute('aria-live', error ? 'assertive' : 'polite');
    status.dataset.status = error ? 'error' : 'ok';
    status.textContent = message;
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
    try {
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
      // Only an armed toggle leaves which build is rendering in question.
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
   * registers each id verbatim, while the compiled build takes its own control
   * names and bakes the topology fields and the constant ids in, so those reach
   * no control there.
   * @param {string} parameterId - A chain parameter id.
   * @param {ParameterDefinition[]} definitions - The engine's definitions.
   * @returns {string|null} The control name, or null where none takes the value.
   */
  const engineControlName = (parameterId, definitions) => {
    const label = parameterId.slice(0, parameterId.indexOf('.'));
    if (active?.compiledSide !== true) {
      return chainUi?.store.bypassedLabels().includes(label) ? null : parameterId;
    }
    if (BAKED_CONSTANT_IDS.has(parameterId)) return null;
    if (bakedFields.has(fieldSegment(parameterId))) return null;
    return engineControlNames(parameterId).find((candidate) =>
      definitions.some((definition) => definition.name === candidate)) ?? null;
  };

  /**
   * Routes an inline stage-control edit into the active preset: the document is
   * the source of truth and the engine write is its side effect.
   * @param {string} parameterId - The edited parameter's id.
   * @param {*} value - The document value: a number, or an enum8 option id.
   * @returns {boolean|void}
   */
  const writeStageEdit = (parameterId, value) => {
    try {
      if (chainUi === null || active === null || active.presetId === null) return;
      const result = chainUi.store.setPresetValue(active.presetId, parameterId, value, () => {
        const engine = getEngine();
        const module = getModule();
        if (!engine || !module) return { ok: true };
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
   * Builds the pipeline strip over one document store, wiring every structural
   * edit, undo and bypass toggle back through the one apply path. The stages'
   * parameters render on the strip's chips, so the effect GUI panel is told to
   * build none of them.
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
    const imported = typeof source === 'string' ? JSON.parse(source) : source;
    const promotedDigest = imported.schema_version === 1
      ? digestMigration[compiler.v1DescriptorDigest(imported)] : undefined;
    const official = [...sourceCatalog.values()].find((candidate) =>
      candidate.descriptorDigest === compiled.descriptor_digest
      || candidate.descriptorDigest === promotedDigest) ?? null;
    // Ahead of the teardown: a refusal here must leave the editor it would
    // have replaced standing.
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
     * Puts the toolbar back on the document the engine is rendering. A refusal
     * before the program write leaves the engine untouched; applyPreset is
     * itself the write, so a refusal from there has already moved the canvas
     * onto the abandoned chain and the previous program is written back.
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
      if (written && previous) {
        const refusal = status.textContent;
        applyPreset(previous.presetId ?? presetSelect.value);
        show(refusal ?? '', true);
      }
      return false;
    };
    if (candidateMount && typeof compiler.validateShaderDocument === 'function') {
      try {
        chainUi = await buildChainUi(compiled.document, candidateMount);
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
    if (!applyPreset(presetId)) return abandon(true);
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
      const runningCatalog = JSON.parse(getModule().HolosphereEngine.getShaderChainCatalog());
      if (JSON.stringify(operatorCatalog) !== JSON.stringify(runningCatalog))
        throw new Error('Operator catalog does not match the loaded engine');
      bakedFields = bakedTopologyFields(operatorCatalog);
      digestMigration = JSON.parse(await fetchText(DIGEST_MIGRATION_URL));
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
        sourceSelect.value = sourceCatalog.has(effectId) ? effectId : '';
        selectedSource = sourceSelect.value;
        return true;
      }
      linkError = status.textContent || 'the linked state was refused';
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
        if (await loadScratch()) selectedSource = sourceSelect.value;
        else sourceSelect.value = selectedSource;
        await flushDeepLink();
        return;
      }
      const entry = sourceCatalog.get(option.value);
      if (!entry) {
        show(`The source catalog carries no document for "${option.value}".`, true);
        return;
      }
      if (await loadSource(entry.source, entry.filename, entry.compiled))
        selectedSource = sourceSelect.value;
      else sourceSelect.value = selectedSource;
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
      if (await loadSource(await file.text(), file.name)) {
        sourceSelect.value = '';
        selectedSource = '';
      }
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
