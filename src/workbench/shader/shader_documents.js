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
import { BAKED_CONSTANT_IDS, bakedTopologyFields } from '../../../generated/shader/shader_workbench.mjs';
import { CHAIN_SNAPSHOT_STORAGE_KEY } from '../../effects/effect_persistence.js';
import { copyToClipboard } from '../../shared/copy_text.js';
import { downloadBlob } from '../../shared/download_file.js';
import {
  decodeShaderStateHash,
} from './shader_deeplink.js';

import {createShaderStageEditor, compiledControlFor, documentControlFor, applyFixedShaderDocument} from './shader_document_edits.js';
import {CHAIN_EFFECT, SCRATCH_FILENAME, createShaderDocumentLoader, createShaderDocumentLinks, diagnosticText} from './shader_document_loader.js';
import {createShaderDocumentPersistence} from './shader_document_persistence.js';
export {applyFixedShaderDocument};

export { SHADER_LINK_DEBOUNCE_MS, SHADER_LINK_MAX_WAIT_MS } from './shader_deeplink.js';

const PATTERN_CATALOG_URL = '../../../generated/shader/patterns/catalog.json';
const CATALOG_URL = '../../../generated/shader/engine_catalog.json';

// Digest characters the toolbar shows; the button copies all of it.
const DIGEST_ABBREVIATION = 12;

/** @typedef {import('./chain_apply.js').ParameterDefinition} ParameterDefinition */
/** @typedef {import('./chain_apply.js').CompiledDocument} CompiledDocument */
/** @typedef {{effectId: string, descriptorDigest?: string, presetIds: string[]}} OfficialDocument */
/** @typedef {{active: ActiveDocument|null, chainUi: {store: import('./chain_document_store.js').ChainStore, strip: *}|null,
 * compiler: *, operatorCatalog: *, sourceCatalog: Map<string, *>, cachedDocumentDefinitions: *|null,
 * rebuildAfterParameterCommit: boolean, linkWriter: ReturnType<typeof import('./shader_deeplink.js').createShaderLinkWriter>}} DocumentControllerState */
/** @typedef {{compiled: CompiledDocument, filename: string, official: OfficialDocument|null, compiledSide: boolean, presetId: string|null, referencePresetIds: string[], savedDocument?: string|null}} ActiveDocument */

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
  /** @type {{store: import('./chain_document_store.js').ChainStore, strip: *}|null} */
  let chainUi = null;
  let rebuildAfterParameterCommit = false;

  /** @type {DocumentControllerState} */
  const controllerState = {
    get active() { return active; },
    set active(value) { active = value; },
    get chainUi() { return chainUi; },
    set chainUi(value) { chainUi = value; },
    get compiler() { return compiler; },
    set compiler(value) { compiler = value; },
    get operatorCatalog() { return operatorCatalog; },
    set operatorCatalog(value) { operatorCatalog = value; },
    get sourceCatalog() { return sourceCatalog; },
    set sourceCatalog(value) { sourceCatalog = value; },
    get cachedDocumentDefinitions() { return cachedDocumentDefinitions; },
    set cachedDocumentDefinitions(value) { cachedDocumentDefinitions = value; },
    get rebuildAfterParameterCommit() { return rebuildAfterParameterCommit; },
    set rebuildAfterParameterCommit(value) { rebuildAfterParameterCommit = value; },
    get linkWriter() { return linkWriter; },
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
  /** @param {string} detail Refusal text, with or without its closing period. */
  const showLinkError = (detail) =>
    showError(`The shader link could not be restored: ${detail.replace(/\.$/, '')}.`);

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
      if (!engine || !module || !active) {
        showError('The preview engine is not ready.');
        return false;
      }
      // With the editor live, the store's document is authoritative and its
      // program shape carries the session bypasses.
      const store = chainUi?.store ?? null;
      const paused = getAnimationsPaused();
      cachedDocumentDefinitions = null;
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
      restoreAnimationsPaused(paused);
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
      linkWriter.schedule();
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
    const label = labelOf(parameterId);
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
  /** @type {ReturnType<NonNullable<ReturnType<typeof getEngine>>['getDocumentParameterDefinitions']>|null} */
  let cachedDocumentDefinitions = null;
  const liveDefinitions = () => {
    const engine = getEngine();
    const generation = engine?.getParamGeneration?.();
    if (engine !== definitionEngine || generation !== definitionGeneration) {
      definitionEngine = engine;
      definitionGeneration = generation;
      cachedDefinitions = engine?.getParameterDefinitions() ?? [];
      cachedDocumentDefinitions = null;
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
        cachedDocumentDefinitions ??= definitionEngine?.getDocumentParameterDefinitions?.() ?? []);
      if (definition) return !definition.readonly;
    }
    return !BAKED_CONSTANT_IDS.has(parameterId) && !bakedFields.has(fieldSegment(parameterId))
      && !compiler.fixedDerivedBinding?.(descriptor, parameterId, {});
  };

  const {writeStageEdit} = createShaderStageEditor({state: controllerState,
    parameterLive, getEngine, getModule, getAnimationsPaused, engineControlName,
    restoreAnimationsPaused, invalidate, announce, syncParity, applyPreset,
    showParityDropStatus, showPreviewStatus, status, markHalted, showError});

  /**
   * Builds the pipeline strip over one document store, wiring structural
   * edits, undo and bypass toggles back through applyPreset. The effect GUI
   * panel builds none of the stage parameters.
   * @param {*} document - The compiled (valid) v2 document to edit.
   * @param {HTMLElement} container - Detached mount for the candidate editor.
   */
  const buildChainUi = async (document, container) => {
    const store = await createChainDocumentStore({
      document, catalog: operatorCatalog, importCompiler,
    });
    const strip = /** @type {*} */ (createChainStrip({
      doc,
      container,
      store,
      catalog: operatorCatalog,
      announce,
      onApply: () => {
        linkWriter.releaseOriginalLink();
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

  const {linkWriter, flushDeepLink} = createShaderDocumentLinks({state: controllerState,
    currentDocument, getEngine, getAnimationsPaused, win, showError, onOriginalLinkReleased});

  const {loadSource, loadLinkedSource} = createShaderDocumentLoader({
    state: controllerState, doc, stripMount, presetSelect, saveButton, saveAsButton,
    status, importCompiler, flushDeepLink, getEngine, getModule, selectEffect,
    teardownChainUi, setParamFilter, populatePresets, showDigest, syncParity,
    applyPreset, buildChainUi, showError, setAnimationsPaused, showAnimationState,
    syncEffectGui, invalidate, currentDocument,
    selectLoadedSource: (effect, filename, kind) => selectLoadedSource(effect, filename, kind),
  });
  const {save, saveAs} = createShaderDocumentPersistence({state: controllerState,
    win, flushDeepLink, currentDocument, exportableDocument, download, showStatus, showError});

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

  /**
   * Adopt a chain snapshot from the page query, rolling the engine back on refusal.
   * @param {string} chainText JSON chain snapshot.
   * @returns {Promise<string>} Empty on success, else the refusal detail.
   */
  const importChainSnapshot = async (chainText) => {
    try {
      const snapshot = JSON.parse(chainText);
      const imported = documentFromChainSnapshot(snapshot, operatorCatalog);
      const previous = getChainSnapshot(getEngine());
      if (!await loadSource(imported, 'imported.shader.json'))
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
      linkWriter.refuseLink();
    }
    const query = new URLSearchParams(win.location?.search ?? '');
    const chainText = query.get(`fx.${CHAIN_SNAPSHOT_STORAGE_KEY}`);
    if (!linked && !linkError && chainText !== null) {
      linkError = await importChainSnapshot(chainText);
      if (!linkError) return true;
      linkWriter.refuseLink();
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
    linkWriter.releaseOriginalLink();
    linkWriter.schedule();
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
    linkWriter.releaseOriginalLink();
    setAnimationsPaused(!paused);
    showAnimationState();
    invalidate();
    linkWriter.schedule();
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
  saveButton.addEventListener('click', save);
  saveAsButton?.addEventListener('click', saveAs);
  animationToggle?.addEventListener('click', onAnimationToggle);
  parityToggle?.addEventListener('click', onParityToggle);
  digestButton?.addEventListener('click', onDigest);

  const dispose = () => {
    chainUi?.strip.flushParameterEdit();
    const finalLinkWrite = linkWriter.dispose();
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
    preservesOriginalLink: linkWriter.preservesOriginalLink,
  };
}
