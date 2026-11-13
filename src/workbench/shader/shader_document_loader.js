/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {canonicalEffectId, effectDisplayName} from '../../effects/effect_identity.js';
import {getChainSnapshot, restoreChainSnapshot} from '../../engine/workbench_bindings.js';
import {errorDetail} from '../../shared/banner.js';
import {createShaderLinkWriter, replaceShaderStateHash} from './shader_deeplink.js';
import {scratchChainDocument} from './chain_document_store.js';
import {snapshotValueEqual} from './shader_document_edits.js';
/** @typedef {import('./chain_apply.js').CompiledDocument} CompiledDocument */
/** @typedef {import('./shader_documents.js').ActiveDocument} ActiveDocument */
export const CHAIN_EFFECT = canonicalEffectId('ShaderChain');
export const SCRATCH_FILENAME = 'scratch.shader.json';

/**
 * Every diagnostic the compile collected, one per line.
 * @param {CompiledDocument} compiled
 */
export function diagnosticText(compiled) {
  const diagnostics = /** @type {*[]} */ (compiled.diagnostics ?? []);
  if (diagnostics.length === 0) return compiled.status ?? 'INVALID';
  return diagnostics
    .map((diagnostic) => `${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`)
    .join('\n');
}

/** Creates serialized document loads and linked-session adoption.
 * @param {{state: import('./shader_documents.js').DocumentControllerState,
 * doc: Document, stripMount: HTMLElement|null, presetSelect: HTMLSelectElement,
 * saveButton: HTMLButtonElement, saveAsButton: HTMLButtonElement|null, status: HTMLOutputElement,
 * importCompiler: () => Promise<*>, flushDeepLink: () => Promise<*>, getEngine: () => *, getModule: () => *,
 * selectEffect: (effect: string) => boolean, teardownChainUi: () => void,
 * setParamFilter: (filter: {external: true}|null) => void,
 * populatePresets: (compiled: CompiledDocument) => void, showDigest: () => void, syncParity: () => boolean,
 * applyPreset: (id: string) => boolean, buildChainUi: (document: *, container: HTMLElement) => Promise<*>,
 * showError: (message: string) => void, setAnimationsPaused: (paused: boolean) => void,
 * showAnimationState: () => void, syncEffectGui: () => void, invalidate: () => void,
 * currentDocument: () => *, selectLoadedSource: (effect: string|null, filename: string, kind: string) => void}} dependencies */
export function createShaderDocumentLoader({state, doc, stripMount, presetSelect,
  saveButton, saveAsButton, status, importCompiler, flushDeepLink, getEngine, getModule,
  selectEffect, teardownChainUi, setParamFilter, populatePresets, showDigest, syncParity,
  applyPreset, buildChainUi, showError, setAnimationsPaused, showAnimationState,
  syncEffectGui, invalidate, currentDocument, selectLoadedSource}) {
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
    state.linkWriter.invalidate();
    state.compiler ??= await importCompiler();
    let compiled = precompiled;
    if (compiled === null) {
      // A malformed document yields diagnostics; a throw is a compiler failure.
      try {
        compiled = state.compiler.compileShaderDocument(source, { catalog: state.operatorCatalog });
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
    const official = [...state.sourceCatalog.values()].find((candidate) =>
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
    const previous = state.active;
    const previousUi = state.chainUi;
    const candidateMount = stripMount ? doc.createElement('div') : null;
    if (candidateMount) candidateMount.style.display = 'contents';
    state.chainUi = null;
    state.active = {
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
      state.active = previous;
      state.chainUi = previousUi;
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
    if (candidateMount && typeof state.compiler.validateShaderDocument === 'function') {
      try {
        state.chainUi = await buildChainUi(compiled.document, candidateMount);
      } catch (error) {
        const detail = errorDetail(error);
        showError(`The chain editor could not adopt the document: ${detail}`);
        return abandon({ written: true });
      }
    }
    if (session && state.chainUi) {
      for (const label of session.bypassed) {
        const result = state.chainUi.store.setBypassed(label, true);
        if (!result.ok) {
          showError(`The shader link could not bypass "${label}": `
            + `${result.diagnostics[0].message}.`);
          return abandon();
        }
      }
      state.chainUi.strip.render();
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
    state.active.savedDocument = JSON.stringify(currentDocument());
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

  /** @param {NonNullable<Awaited<ReturnType<typeof import('./shader_deeplink.js').decodeShaderStateHash>>>} linked */
  const loadLinkedSource = async (linked) => {
    const effectId = linked.document.effect_id;
    const entry = [...state.sourceCatalog.values()].find(
      (candidate) => candidate.compiled.document.effect_id === effectId);
    const scratch = effectId === 'scratch';
    const filename = entry?.filename ?? (scratch ? SCRATCH_FILENAME : 'linked.shader.json');
    if (await loadSource(linked.document, filename, null, linked)) {
      (/** @type {ActiveDocument} */ (state.active)).savedDocument = entry ? JSON.stringify(entry.compiled.document)
        : scratch ? JSON.stringify(state.compiler.compileShaderDocument(
          scratchChainDocument(state.operatorCatalog), { catalog: state.operatorCatalog }).document) : null;
      selectLoadedSource(scratch ? '' : entry?.effectId ?? null, filename, scratch ? '' : 'Linked');
      return true;
    }
    return false;
  };
  return {loadSource, loadLinkedSource};
}

/** Creates link serialization and flushes pending stage edits before writing.
 * @param {{state: import('./shader_documents.js').DocumentControllerState,
 * currentDocument: () => *, getEngine: () => *, getAnimationsPaused: () => boolean|null,
 * win: *, showError: (message: string) => void, onOriginalLinkReleased: () => void}} dependencies */
export function createShaderDocumentLinks({state, currentDocument, getEngine,
  getAnimationsPaused, win, showError, onOriginalLinkReleased}) {
  const linkWriter = createShaderLinkWriter({
    canWrite: () => state.active !== null && state.active.presetId !== null,
    readState: () => {
      const chainSnapshot = getChainSnapshot(getEngine());
      return {
        document: currentDocument(),
        preset: state.active?.presetId,
        bypassed: state.chainUi?.store.bypassedLabels() ?? [],
        paused: getAnimationsPaused() === true,
        ...(chainSnapshot ? {chainSnapshot} : {}),
      };
    },
    replace: (hash) => replaceShaderStateHash(hash, win),
    onError: (error) => showError(`The shader link could not be updated: ${errorDetail(error)}.`),
    onOriginalLinkReleased,
  });

  const flushDeepLink = () => {
    state.chainUi?.strip.flushParameterEdit();
    return linkWriter.flush();
  };

  return {linkWriter, flushDeepLink};
}
