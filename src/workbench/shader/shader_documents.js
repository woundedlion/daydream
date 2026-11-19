/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { canonicalEffectId, effectDisplayName } from "../../effects/effect_identity.js";
import { engineHalted } from '../../shared/engine_halt.js';
import { callWorkbenchBinding, getChainSnapshot, restoreChainSnapshot, shaderChainCatalog } from '../../engine/workbench_bindings.js';
import {
  fieldOf as fieldSegment, labelOf,
} from './chain_presentation.js';
import { errorDetail } from '../../shared/banner.js';
import { applyChainDocument } from './chain_apply.js';
import {
  createChainDocumentStore, documentFromChainSnapshot, scratchChainDocument,
} from './chain_document_store.js';
import { createChainStrip } from './chain_strip.js';
import * as composedRoster from '../../../generated/shader/composed_effect_roster.mjs';
import { BAKED_CONSTANT_IDS, bakedTopologyFields } from '../../../generated/shader/shader_workbench.mjs';
import { CHAIN_SNAPSHOT_STORAGE_KEY } from '../../effects/effect_persistence.js';
import { copyToClipboard } from '../../shared/copy_text.js';
import {
  decodeShaderStateHash,
} from './shader_deeplink.js';

import {createShaderStageEditor, compiledControlFor, documentControlFor, applyFixedShaderDocument} from './shader_document_edits.js';
import {CHAIN_EFFECT, SCRATCH_FILENAME, createShaderDocumentLoader, createShaderDocumentLinks, diagnosticText} from './shader_document_loader.js';
import {createShaderDocumentPersistence} from './shader_document_persistence.js';
import {createShaderPresetEditor} from './shader_preset_editor.js';
import {createDocumentControllerState} from './shader_document_state.js';
export {applyFixedShaderDocument};

export { SHADER_LINK_DEBOUNCE_MS, SHADER_LINK_MAX_WAIT_MS } from './shader_deeplink.js';

const PATTERN_CATALOG_URL = '../../../generated/shader/patterns/catalog.json';
const CATALOG_URL = '../../../generated/shader/engine_catalog.json';

// Digest characters the toolbar shows; the button copies all of it.
const DIGEST_ABBREVIATION = 12;

/** @typedef {import('./chain_apply.js').ParameterDefinition} ParameterDefinition */
/** @typedef {import('./chain_apply.js').CompiledDocument} CompiledDocument */
/** @typedef {import('./shader_document_state.js').OfficialDocument} OfficialDocument */
/** @typedef {import('./shader_document_state.js').ActiveDocument} ActiveDocument */

/**
 * Owns document import, validation, preview selection, editing, and export UI.
 * @param {{doc: Document, getEngine: () => *, getModule: () => *,
 * selectEffect: (effect: string) => boolean,
 * syncEffectGui: () => void, invalidate: () => void,
 * requestPreviewFrame?: () => void,
 * getAnimationsPaused?: () => boolean|null,
 * setAnimationsPaused?: (paused: boolean) => void,
 * setParamFilter?: (filter: {external: true}|null) => void,
 * onOriginalLinkReleased?: () => void,
 * fetchText?: (url: string) => Promise<string>, importCompiler?: () => Promise<*>,
 * copyText?: (source: string) => Promise<boolean>,
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
  requestPreviewFrame = invalidate,
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
  copyText = copyToClipboard,
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
  const exportButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-export'));
  const clearButton = /** @type {HTMLButtonElement|null} */ (
    doc.getElementById('shader-document-clear'));
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
  if (!sourceSelect || !presetSelect || !openButton || !exportButton || !clearButton
      || !fileInput || !status) return null;
  const stripMount = doc.getElementById('chain-strip');
  const railMount = doc.getElementById('shader-preset-rail');

  const state = createDocumentControllerState();
  let selectedSource = '';
  /** @type {Set<string>} The catalog's topology fields, once it has loaded. */
  let bakedFields = new Set();

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
    'The edit changed the descriptor or preset bank. Preview is back on the interpreter and the parity toggle is disarmed.');
  /** @param {string} message */
  const showError = (message) => writeStatus(message, true);
  /** @param {string} detail Refusal text, with or without its closing period. */
  const showLinkError = (detail) =>
    showError(`The shader link could not be restored: ${detail.replace(/\.$/, '')}.`);

  // An empty message clears both announcements.
  /** @param {string} message */
  const announce = (message) => writeStatus(message, message !== '');

  const liveCompile = () => state.chainUi?.store.compile() ?? state.active?.compiled;
  const liveDigest = () => liveCompile()?.descriptor_digest;
  const parityArmed = () => {
    if (state.active?.official == null) return false;
    const official = state.active.official;
    const compiled = liveCompile();
    return official.presetBankDigest !== undefined
      && compiled?.descriptor_digest === official.descriptorDigest
      && compiled?.preset_bank_digest === official.presetBankDigest;
  };

  /**
   * Repaints the parity toggle and, once a descriptor edit has broken the
   * match, returns the preview to the interpreter so the render is the document
   * being edited.
   * @returns {boolean} Whether the compiled build was dropped.
   */
  const syncParity = () => {
    const armed = parityArmed();
    const dropped = !armed && state.active?.compiledSide === true;
    if (dropped && state.active) {
      state.active.compiledSide = false;
      selectEffect(CHAIN_EFFECT);
    }
    if (parityToggle) {
      parityToggle.disabled = !armed;
      parityToggle.setAttribute('aria-pressed', String(state.active?.compiledSide === true));
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
    const bank = compiled.document.preset_bank;
    const order = bank.choreography?.generated_order
      ?? bank.presets.map((/** @type {*} */ preset) => preset.preset_id);
    for (const id of order) {
      const preset = bank.presets.find((/** @type {*} */ preset) => preset.preset_id === id);
      if (!preset) continue;
      const option = doc.createElement('option');
      option.value = preset.preset_id;
      option.textContent = preset.display_name ?? preset.preset_id;
      presetSelect.appendChild(option);
    }
    presetSelect.disabled = presetSelect.options.length === 0;
  };

  const showPreviewStatus = () => {
    if (!state.active) return;
    const title = state.active.compiled.document.effect_metadata?.display_name
      ?? state.active.compiled.document.document_id;
    const preset = presetSelect.selectedOptions[0]?.textContent ?? state.active.presetId;
    const side = !parityArmed() ? ''
      : state.active.compiledSide ? ' · compiled build' : ' · interpreter';
    showStatus(`${title} · ${preset}${side}`);
  };

  /** @param {boolean|null} paused - Pause state to restore. */
  const restoreAnimationsPaused = (paused) => {
    if (paused !== null) {
      setAnimationsPaused(paused);
      syncEffectGui();
    }
    showAnimationState();
  };

  /** @param {string} presetId */
  const applyPreset = (presetId) => {
    try {
      const engine = getEngine();
      const module = getModule();
      if (!engine || !module || !state.active) {
        showError('The preview engine is not ready.');
        return false;
      }
      // With the editor live, the store's document is authoritative and its
      // program shape carries the session bypasses.
      const store = state.chainUi?.store ?? null;
      const paused = getAnimationsPaused();
      state.cachedDocumentDefinitions = null;
      const refusal = state.active.compiledSide
        ? applyFixedShaderDocument(
          engine, module, store ? { document: store.document() } : state.active.compiled,
          presetId, state.active.referencePresetIds, bakedFields, state.compiler.fixedDerivedBinding, state.operatorCatalog)
        : applyChainDocument({
          engine, module,
          compiled: store ? { document: store.document() } : state.active.compiled,
          programShape: store ? store.programShape() : null,
          presetId, syncEffectGui, invalidate,
        });
      restoreAnimationsPaused(paused);
      if (state.active.compiledSide) {
        syncEffectGui();
        invalidate();
      }
      if (refusal) {
        showError(`Preset "${presetId}" could not be applied: ${refusal}`);
        return false;
      }
      state.active.presetId = presetId;
      presetSelect.value = presetId;
      state.chainUi?.strip.syncParameterRows();
      presetEditor.render();
      showPreviewStatus();
      showDigest();
      linkWriter.schedule();
      return true;
    } catch (error) {
      markHalted(error);
      showError(`The preview edit failed: ${errorDetail(error)}`);
      return false;
    }
  };

  const teardownChainUi = () => {
    presetEditor.reset();
    if (state.chainUi === null) return;
    state.chainUi.strip.destroy();
    state.chainUi = null;
    presetEditor.render();
    state.rebuildAfterParameterCommit = false;
    setParamFilter(null);
  };

  /**
   * Resolves document ids against the active engine's registered controls.
   * @param {string} parameterId - A chain parameter id.
   * @param {ParameterDefinition[]} definitions - The engine's definitions.
   * @returns {{name: string|null, refusal: string|null}} The control or refusal.
   */
  const engineControlName = (parameterId, definitions) => {
    const label = labelOf(parameterId);
    if (state.active?.compiledSide !== true) {
      return { name: state.chainUi?.store.bypassedLabels().includes(label) ? null : parameterId,
        refusal: null };
    }
    return compiledControlFor(parameterId, definitions, bakedFields, state.active.compiled.document.descriptor, state.operatorCatalog);
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
      state.cachedDocumentDefinitions = null;
    }
    return cachedDefinitions;
  };

  /** @param {string} parameterId @returns {boolean} */
  const parameterLive = (parameterId) => {
    if (state.active?.compiledSide !== true) return true;
    const descriptor = { chain: state.chainUi?.store.chainView()
      ?? state.active?.compiled.document.descriptor.chain ?? [] };
    const control = engineControlName(parameterId, liveDefinitions());
    if (control.name !== null) return true;
    if (control.refusal) {
      const definition = documentControlFor(descriptor, parameterId,
        state.cachedDocumentDefinitions ??= definitionEngine?.getDocumentParameterDefinitions?.() ?? []);
      if (definition) return !definition.readonly;
    }
    return !BAKED_CONSTANT_IDS.has(parameterId) && !bakedFields.has(fieldSegment(parameterId))
      && !state.compiler.fixedDerivedBinding?.(descriptor, parameterId, {});
  };

  /**
   * Builds the pipeline strip over one document store, wiring structural
   * edits, undo and bypass toggles back through applyPreset. The effect GUI
   * panel builds none of the stage parameters.
   * @param {*} document - The compiled (valid) v2 document to edit.
   * @param {HTMLElement} container - Detached mount for the candidate editor.
   */
  const buildChainUi = async (document, container) => {
    const store = await createChainDocumentStore({
      document, catalog: state.operatorCatalog, importCompiler,
    });
    const strip = createChainStrip({
      doc,
      container,
      store,
      catalog: state.operatorCatalog,
      announce,
      onApply: () => refreshAfterEdit(undefined, false),
      presetId: () => state.active?.presetId ?? null,
      onEditParameter: writeStageEdit,
      beforeEditParameter: presetEditor.stopPreviewForEdit,
      parameterLive,
      parameterRanges: () => state.chainUi?.store === store && state.active?.compiledSide !== true
        ? callWorkbenchBinding(getEngine(), 'getShaderChainParameterRanges', [], []) : [],
      onCommitParameter: () => {
        if (state.rebuildAfterParameterCommit) {
          state.rebuildAfterParameterCommit = false;
          state.chainUi?.strip.render();
        }
        presetEditor.render();
        void flushDeepLink();
      },
      bypassAvailable: () => state.active?.compiledSide !== true,
    });
    setParamFilter({ external: true });
    return { store, strip };
  };

  /**
   * The document as it stands: the store's once the editor is live, else the
   * load-time compile.
   * @returns {*} An isolated copy.
   */
  const currentDocument = () => state.chainUi
    ? state.chainUi.store.document()
    : structuredClone((/** @type {ActiveDocument} */ (state.active)).compiled.document);

  /**
   * The current document without its disabled stages.
   * @returns {*} An isolated copy.
   * @throws {Error} If the document without those stages fails validation.
   */
  const exportableDocument = () => state.chainUi
    ? state.chainUi.store.exportDocument()
    : structuredClone((/** @type {ActiveDocument} */ (state.active)).compiled.document);

  const {linkWriter, flushDeepLink} = createShaderDocumentLinks({state,
    currentDocument, getEngine, getAnimationsPaused, win, showError, onOriginalLinkReleased,
    includeSnapshot: () => !presetEditor.transport.inProgress()});

  const {writeStageEdit} = createShaderStageEditor({state, linkWriter,
    parameterLive, getEngine, getModule, getAnimationsPaused, engineControlName,
    restoreAnimationsPaused, invalidate, announce, syncParity, applyPreset,
    showParityDropStatus, showPreviewStatus, status, markHalted, showError});

  /** @param {string} [id] @param {boolean} [renderStrip] */
  const refreshAfterEdit = (id, renderStrip = true) => {
    const current = state.chainUi?.store;
    if (!current || !state.active) return;
    presetEditor.transport.clear();
    const bank = current.presetBankView();
    const target = id ?? state.active.presetId;
    const next = target !== null && current.presetValuesView(target) !== null
      ? target : bank.choreography.generated_order[0];
    linkWriter.releaseOriginalLink();
    populatePresets(current.compile());
    const dropped = syncParity();
    const changedPreset = next !== state.active.presetId;
    const applied = applyPreset(next);
    if (renderStrip || dropped || changedPreset) state.chainUi?.strip.render();
    if (dropped && applied) showParityDropStatus();
  };

  const presetEditor = createShaderPresetEditor({
    state, doc, mount: railMount, getEngine, getModule, definitions: liveDefinitions,
    snap: applyPreset,
    adopt: (id) => {
      if (!state.active) return;
      state.active.presetId = id;
      presetSelect.value = id;
      state.chainUi?.strip.render();
      presetEditor.render();
      showPreviewStatus();
      linkWriter.schedule();
    },
    choose: (id) => { presetSelect.value = id; onPresetChange(); },
    onEdit: (result, id) => {
      if (!result.ok) {
        announce(result.diagnostics[0]?.message ?? 'The preset edit was refused.');
        presetEditor.render();
        return;
      }
      refreshAfterEdit(id);
    },
    toInterpreter: () => {
      if (!state.active?.compiledSide) return true;
      if (!selectEffect(CHAIN_EFFECT)) return false;
      state.active.compiledSide = false;
      syncParity();
      state.chainUi?.strip.render();
      return state.active.presetId !== null && applyPreset(state.active.presetId);
    },
    announce: showError, requestFrame: requestPreviewFrame,
  });

  const {loadSource, loadLinkedSource} = createShaderDocumentLoader({
    state, linkWriter, doc, stripMount, presetSelect, documentActions: [exportButton, clearButton],
    status, importCompiler, flushDeepLink, getEngine, getModule, selectEffect,
    teardownChainUi, setParamFilter, populatePresets, showDigest, syncParity,
    applyPreset, buildChainUi, clearPreview: presetEditor.reset, showError, setAnimationsPaused, showAnimationState,
    syncEffectGui, invalidate, currentDocument,
    selectLoadedSource: (effect, filename, kind) => selectLoadedSource(effect, filename, kind),
  });
  const exportShader = createShaderDocumentPersistence({state,
    flushDeepLink, currentDocument, exportableDocument, copyText, showStatus, showError});

  /**
   * Opens the default chain on catalog defaults through the ordinary load path.
   * @returns {Promise<boolean>} Whether the scratch document is on screen.
   */
  const loadScratch = () =>
    loadSource(scratchChainDocument(state.operatorCatalog));

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

  /**
   * Adopt a chain snapshot from the page query, rolling the engine back on refusal.
   * @param {string} chainText JSON chain snapshot.
   * @returns {Promise<string>} Empty on success, else the refusal detail.
   */
  const importChainSnapshot = async (chainText) => {
    try {
      const snapshot = JSON.parse(chainText);
      const imported = documentFromChainSnapshot(snapshot, state.operatorCatalog);
      const previous = getChainSnapshot(getEngine());
      if (!await loadSource(imported))
        return status.textContent || 'the imported chain could not be adopted';
      const outcome = restoreChainSnapshot(getEngine(), getModule(), snapshot);
      if (outcome !== getModule().ChainSnapshotRestoreResult.APPLIED) {
        if (previous) restoreChainSnapshot(getEngine(), getModule(), previous);
        return 'the imported chain snapshot was rejected';
      }
      const paused = getAnimationsPaused();
      if (paused !== null) setAnimationsPaused(paused);
      showAnimationState();
      selectLoadedSource(null, 'imported.shader.json', 'Imported');
      syncEffectGui();
      invalidate();
      linkWriter.schedule();
      await flushDeepLink();
      showStatus('Restored the chain snapshot.');
      return '';
    } catch (error) {
      return errorDetail(error);
    }
  };

  const init = async () => {
    try {
      state.compiler = await importCompiler();
      state.operatorCatalog = JSON.parse(await fetchText(CATALOG_URL));
      const runningCatalog = JSON.parse(shaderChainCatalog(getModule()));
      if (JSON.stringify(state.operatorCatalog) !== JSON.stringify(runningCatalog))
        throw new Error('Operator catalog does not match the loaded engine');
      bakedFields = bakedTopologyFields(state.operatorCatalog);
      const patternCatalog = JSON.parse(await fetchText(PATTERN_CATALOG_URL));
      const entries = await Promise.all(Object.entries(patternCatalog.source_documents)
        .map(async ([effectId, filename]) => {
          const source = await fetchText(`../../../generated/shader/patterns/${filename}`);
          const compiled = state.compiler.compileShaderDocument(source,
            { catalog: state.operatorCatalog });
          if (compiled.status !== 'VALID')
            throw new Error(`${filename}: ${diagnosticText(compiled)}`);
          return {
            effectId,
            filename,
            source,
            compiled,
            descriptorDigest: compiled.descriptor_digest,
            presetBankDigest: typeof getEngine()?.getPresetBankDigestForEffect === 'function'
              ? getEngine().getPresetBankDigestForEffect(effectId) : compiled.preset_bank_digest,
            ...composedRoster.SHADER_DOCUMENT_PROMOTION_OPTIONS?.[effectId],
            presetIds: compiled.document.preset_bank.presets.map(
              (/** @type {*} */ preset) => preset.preset_id),
          };
        }));
      state.sourceCatalog = new Map(entries.map((entry) => [entry.effectId, entry]));
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
      linkWriter.refuseLink();
    }
    const query = new URLSearchParams(win.location?.search ?? '');
    const chainText = query.get(`fx.${CHAIN_SNAPSHOT_STORAGE_KEY}`);
    if (!linked && !linkError && chainText !== null) {
      linkError = await importChainSnapshot(chainText);
      if (!linkError) return true;
      linkWriter.refuseLink();
    }
    const requested = state.sourceCatalog.get(canonicalEffectId(initialEffect ?? ''))
      ?? state.sourceCatalog.get(initialEffect ?? '');
    let loaded;
    if (requested === undefined) loaded = await loadScratch();
    else {
      loaded = await loadSource(requested.source, requested.compiled);
      if (loaded) sourceSelect.value = requested.effectId;
    }
    selectedSource = sourceSelect.value;
    if (linkError) showLinkError(linkError);
    return loaded;
  };

  /** @param {string|null} effectId @param {string} filename @param {string} kind */
  const adoptLoadedSource = async (effectId, filename, kind) => {
    selectLoadedSource(effectId, filename, kind);
    linkWriter.releaseOriginalLink();
    linkWriter.schedule();
    await flushDeepLink();
  };

  const allowSourceChange = () => {
    state.chainUi?.strip.flushParameterEdit();
    return !state.active || JSON.stringify(currentDocument()) === state.active.documentBaseline
      || win.confirm('Discard unexported shader edits?');
  };

  const onClearAll = async () => {
    if (!state.active || !allowSourceChange()) return;
    try {
      if (!await loadScratch()) return;
      restoreAnimationsPaused(false);
      invalidate();
      await adoptLoadedSource('', SCRATCH_FILENAME, '');
    } catch (error) {
      showError(`Could not reset the shader workbench: ${errorDetail(error)}`);
    }
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
      const entry = state.sourceCatalog.get(option.value);
      if (!entry) {
        showError(`The source catalog carries no document for "${option.value}".`);
        return;
      }
      if (!await loadSource(entry.source, entry.compiled)) {
        sourceSelect.value = selectedSource;
        return;
      }
      await adoptLoadedSource(entry.effectId, entry.filename, '');
    } catch (error) {
      showError(`Could not load shader source: ${errorDetail(error)}`);
    }
  };
  const onPresetChange = () => {
    presetEditor.transport.clear();
    if (!applyPreset(presetSelect.value)) {
      const refusal = status.textContent ?? 'The preset could not be applied.';
      presetSelect.value = state.active?.presetId ?? '';
      if (state.active) applyPreset(/** @type {string} */ (state.active.presetId));
      showError(refusal);
      return;
    }
    linkWriter.releaseOriginalLink();
    linkWriter.schedule();
    state.chainUi?.strip.render();
    void flushDeepLink();
  };
  const onOpen = () => fileInput.click();
  const onFileChange = async () => {
    try {
      const file = fileInput.files?.[0];
      if (!file) return;
      state.compiler ??= await importCompiler();
      if (file.size > state.compiler.DEFAULT_LIMITS.bytes) {
        showError('The document byte limit was exceeded.');
        return;
      }
      if (!allowSourceChange()) return;
      if (!await loadSource(await file.text())) return;
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
    linkWriter.releaseOriginalLink();
    setAnimationsPaused(!paused);
    showAnimationState();
    invalidate();
    linkWriter.schedule();
  };
  const onParityToggle = () => {
    if (state.active === null || !parityArmed()) return;
    try {
      if (presetEditor.transport.inProgress()) presetEditor.transport.stop();
      const official = /** @type {OfficialDocument} */ (state.active.official);
      const compiledSide = !state.active.compiledSide;
      const effect = compiledSide ? official.effectId : CHAIN_EFFECT;
      if (!selectEffect(effect)) {
        announce(`The preview engine rejected effect "${effectDisplayName(effect)}".`);
        return;
      }
      if (compiledSide && typeof getEngine()?.getPresetBankDigest === 'function'
          && getEngine().getPresetBankDigest() !== official.presetBankDigest) {
        selectEffect(CHAIN_EFFECT);
        applyPreset(state.active.presetId ?? presetSelect.value);
        showError('The compiled effect has a different preset bank digest.');
        return;
      }
      state.active.compiledSide = compiledSide;
      syncParity();
      state.chainUi?.strip.render();
      const presetId = state.active.presetId ?? presetSelect.value;
      if (!applyPreset(presetId)) {
        const refusal = status.textContent ?? 'The preset could not be applied.';
        const previousEffect = compiledSide ? CHAIN_EFFECT : official.effectId;
        if (!selectEffect(previousEffect)) {
          announce(`The preview engine rejected effect "${effectDisplayName(previousEffect)}".`);
          return;
        }
        state.active.compiledSide = !compiledSide;
        syncParity();
        state.chainUi?.strip.render();
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
        linkWriter.schedule();
        return;
      }
      if (!await loadLinkedSource(linked))
        showLinkError(status.textContent || 'the linked state was refused');
    } catch (error) {
      showLinkError(errorDetail(error));
    }
  };
  win.addEventListener?.('hashchange', onHashChange);

  sourceSelect.addEventListener('change', onSourceChange);
  presetSelect.addEventListener('change', onPresetChange);
  openButton.addEventListener('click', onOpen);
  fileInput.addEventListener('change', onFileChange);
  exportButton.addEventListener('click', exportShader);
  clearButton.addEventListener('click', onClearAll);
  animationToggle?.addEventListener('click', onAnimationToggle);
  parityToggle?.addEventListener('click', onParityToggle);
  digestButton?.addEventListener('click', onDigest);

  const dispose = () => {
    state.chainUi?.strip.flushParameterEdit();
    const finalLinkWrite = linkWriter.dispose();
    win.removeEventListener?.('hashchange', onHashChange);
    sourceSelect.removeEventListener('change', onSourceChange);
    presetSelect.removeEventListener('change', onPresetChange);
    openButton.removeEventListener('click', onOpen);
    fileInput.removeEventListener('change', onFileChange);
    exportButton.removeEventListener('click', exportShader);
    clearButton.removeEventListener('click', onClearAll);
    animationToggle?.removeEventListener('click', onAnimationToggle);
    parityToggle?.removeEventListener('click', onParityToggle);
    digestButton?.removeEventListener('click', onDigest);
    teardownChainUi();
    return finalLinkWrite;
  };

  return {
    init, loadSource, exportShader, applyPreset,
    stepPreview() {
      try {
        presetEditor.transport.tick();
      } catch (error) {
        markHalted(error);
        presetEditor.transport.clear();
        showError(`Preview failed: ${errorDetail(error)}`);
      }
    },
    dispose,
    flushDeepLink,
    preservesOriginalLink: linkWriter.preservesOriginalLink,
  };
}
