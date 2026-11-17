/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */
import { buildSavedCard } from './solid_saved_cards.js';
import { savedChainShapeError } from './solid_validation.js';
import { copyWithFeedback } from '../shared.js';
import { CATALAN_BASES } from './solid_op_params.js';
import { formatSolidName, generateFuncAndRecipe, generateRecipeCpp } from './solid_codegen.js';
import {
  SAVED_SOLIDS_KEY, SAVED_SOLIDS_MAX, captureSavedSolidThumbnail, queueSavedSolidRestore,
  loadSavedSolids, persistSavedSolids as persistSavedStore, mergeSavedSolids,
} from './solid_saved_store.js';
import { registryDisplayName, generateRegistryCpp, validateRegistryFaces } from './solid_registry_codegen.js';
import { meshCounts } from './solid_render.js';
import { showCopyFeedback } from '../../shared/clipboard.js';
import { downloadBlob } from '../../shared/download_file.js';
/** Thumbnail dimensions in pixels. */
const SAVED_THUMB_SIZE = 256;

/** Saved recipe metadata and view flags.
 * @typedef {{base: string, ops: Array<{op: string, params: Record<string, number>}>,
 * title?: string, desc?: string, stats?: string, thumb?: string|null,
 * vCount?: number, fCount?: number, iCount?: number,
 * geodesics?: boolean, faces?: boolean, colorize?: boolean,
 * vertices?: boolean, normals?: boolean, indices?: boolean}} SavedSolid */
/** @typedef {{wireSavedSolidControls: () => void, reloadSavedSolids: (event: StorageEvent) => void,
 * persistSavedSolids: () => void, exportSavedSolids: () => void, importSavedSolids: (text: string) => void,
 * captureSavedThumbnail: () => string, saveSolid: () => void, savedFuncName: (item: SavedSolid) => string|null,
 * renderSavedList: () => void, deleteSolid: (index: number) => void,
 * copyCode: (index: number, lang: string, btn: HTMLButtonElement) => Promise<void>,
 * showCopyFailure: (button: HTMLButtonElement, message: string) => void,
 * restoreSolid: (item: SavedSolid) => void, applyRestore: (item: SavedSolid) => void,
 * clearSavedSolids: () => void}} SolidsSavedController */

/** Default browser and saved-card dependencies. @returns Browser and saved-card services. */
function savedDependencies() {
  return {
    document: globalThis.document, window: globalThis.window, console,
    SAVED_SOLIDS_KEY, SAVED_SOLIDS_MAX, SAVED_THUMB_SIZE, CATALAN_BASES,
    loadSavedSolids, persistSavedStore, downloadBlob, mergeSavedSolids,
    savedChainShapeError, captureSavedSolidThumbnail, formatSolidName, meshCounts,
    structuredClone: globalThis.structuredClone.bind(globalThis), registryDisplayName, generateFuncAndRecipe, buildSavedCard,
    generateRecipeCpp, generateRegistryCpp, validateRegistryFaces,
    copyWithFeedback, showCopyFeedback, queueSavedSolidRestore,
  };
}

/** Creates saved-card controls and import/export actions.
 * @param {import('./solids_state.js').SolidsPage} page - Shared page state.
 * @param {import('./solids_state.js').SolidsActions} actions - Page collaborators.
 * @param {Partial<ReturnType<typeof savedDependencies>>} [dependencies] - Browser and saved-card services.
 * @returns {SolidsSavedController} Saved-card actions.
 */
export function createSolidsSavedController(page, actions, dependencies = {}) {
  const env = { ...savedDependencies(), ...dependencies };
  /** Wires save, restore-list and import/export controls. @returns {void} */
  function wireSavedSolidControls() {
    (/** @type {HTMLElement} */ (env.document.getElementById('saveBtn'))).addEventListener('click', actions.saveSolid);

    (/** @type {HTMLElement} */ (env.document.getElementById('exportSavedBtn'))).addEventListener('click', actions.exportSavedSolids);
    const importFile = /** @type {HTMLInputElement} */ (env.document.getElementById('importSavedFile'));
    (/** @type {HTMLElement} */ (env.document.getElementById('importSavedBtn'))).addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files?.[0];
      try {
        if (file) actions.importSavedSolids(await file.text());
      } catch (error) {
        actions.showGateMsg(`import failed: ${/** @type {Error} */ (error).message}`);
      } finally {
        importFile.value = '';
      }
    });
    (/** @type {HTMLElement} */ (env.document.getElementById('clearSavedBtn'))).addEventListener('click', actions.clearSavedSolids);
  }

  /** Reloads saved cards after a storage update. @param {StorageEvent} event @returns {void} */
  function reloadSavedSolids(event) {
    if (event.key !== env.SAVED_SOLIDS_KEY && event.key !== null) return;
    const loaded = env.loadSavedSolids(page.doc.savedStore.storage);
    page.doc.savedSolids.splice(0, page.doc.savedSolids.length, ...loaded.entries);
    page.doc.savedStorage.rejected.splice(0, page.doc.savedStorage.rejected.length, ...loaded.rejected);
    page.doc.savedStorage.notice = loaded.notice;
    page.doc.savedStorage.backupNotice = loaded.backupNotice;
    if (page.doc.savedStorageStatus) page.doc.savedStorageStatus.textContent =
      [page.doc.savedStore.notice, loaded.notice, loaded.backupNotice].filter(Boolean).join(' ');
    actions.renderSavedList();
  }

  /** Persists cards and refreshes the storage notice. @returns {void} */
  function persistSavedSolids() {
    const notice = env.persistSavedStore(page.doc.savedStore.storage, page.doc.savedSolids, page.doc.savedStorage);
    const status = env.document.getElementById('savedStorageStatus');
    if (status) status.textContent = [page.doc.savedStore.notice, notice].filter(Boolean).join(' ');
  }

  /** Downloads the saved-card list as JSON. @returns {void} */
  function exportSavedSolids() {
    const blob = new Blob([JSON.stringify(page.doc.savedSolids, null, 2)], {
      type: 'application/json',
    });
    env.downloadBlob(env.document, blob, 'daydream-solids.json');
  }

  /** Merges an exported saved-card list. @param {string} text @returns {void} */
  function importSavedSolids(text) {
    const result = env.mergeSavedSolids(text, page.doc.savedSolids);
    if (result.added > 0) {
      actions.persistSavedSolids();
      actions.renderSavedList();
    }
    actions.showGateMsg(result.message, { persist: result.persist });
  }

  /** Captures the current preview as a square PNG. @returns {string} Data URL. */
  function captureSavedThumbnail() {
    const renderer = /** @type {import('three').WebGLRenderer} */ (page.scene.renderer);
    renderer.render(/** @type {import('three').Scene} */ (page.scene.scene),
      /** @type {import('three').PerspectiveCamera} */ (page.scene.camera));
    const source = renderer.domElement;
    const canvas = env.document.createElement('canvas');
    canvas.width = env.SAVED_THUMB_SIZE;
    canvas.height = env.SAVED_THUMB_SIZE;
    const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
    const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2,
      width, height);
    return canvas.toDataURL('image/png');
  }

  /** Saves the current successful preview and its recipe. @returns {void} */
  function saveSolid() {
    if (!page.mesh.currentMesh || !page.mesh.currentMeshIsCurrent) {
      actions.showGateMsg("rejected: the current chain has no successful preview to save");
      return;
    }

    if (page.doc.ops.length === 0) {
      actions.showGateMsg('rejected: add at least one op — a bare seed has no recipe to export');
      return;
    }
    const shapeError = env.savedChainShapeError(page.doc.base, page.doc.ops);
    if (shapeError) {
      actions.showGateMsg(`rejected: the loaded or edited chain cannot be saved: ${shapeError}; `
        + "pattern values may fall outside the editor's save grid");
      return;
    }

    const thumbnail = env.captureSavedSolidThumbnail(
      page.doc.savedSolids.length, actions.captureSavedThumbnail);
    if (thumbnail.full) {
      actions.showGateMsg(`rejected: the saved list is full at ${env.SAVED_SOLIDS_MAX} — `
        + 'export it, then delete a card to make room');
      return;
    }

    const dataURL = thumbnail.dataURL;

    const title = env.formatSolidName(page.doc.base);

    const {vertices: vCount, edges: eCount, faces: fCount, indices: iCount} = env.meshCounts(page.mesh.currentMesh);

    const opsSummary = page.doc.ops.map(o => {
      if (o.op === 'truncate') return `Tr(${o.params.t})`;
      if (o.op === 'hankin') return `Hk(${o.params.angle.toFixed(2)})`;
      const name = o.op.charAt(0).toUpperCase() + o.op.slice(1);
      const params = Object.entries(o.params ?? {}).map(([key, value]) => `${key}=${value}`);
      return params.length ? `${name}(${params.join(', ')})` : name;
    }).join(', ');

    const item = {
      base: page.doc.base,
      ops: env.structuredClone(page.doc.ops),
      geodesics: page.view.showGeodesics,
      faces: page.view.showFaces,
      colorize: page.view.colorizeFaces,
      vertices: page.view.showVertices,
      normals: page.view.showNormals,
      indices: page.view.showIndices,
      thumb: dataURL,
      title: title,
      desc: opsSummary,
      stats: `${vCount}V ${eCount}E ${fCount}F ${iCount}I`,
      vCount, fCount, iCount
    };

    actions.showGateMsg('');
    const funcName = actions.savedFuncName(item);
    if (funcName && page.registry.registrySolidNames.has(env.registryDisplayName(item, funcName))) {
      actions.showGateMsg(`saved: "${funcName}" is already in the engine registry — `
        + `the exported C++ would redefine it; vary an op parameter`);
    } else if (funcName && page.doc.savedSolids.some(s => actions.savedFuncName(s) === funcName)) {
      actions.showGateMsg(`saved: "${funcName}" collides with another saved solid — `
        + `vary an op parameter to keep the exported C++ names unique`);
    }

    page.doc.savedSolids.push(item);
    actions.persistSavedSolids();
    actions.renderSavedList();
  }

  /** Resolves a saved recipe's C++ name. @param {SavedSolid} item @returns {string|null} */
  function savedFuncName(item) {
    try {
      return env.generateFuncAndRecipe(item).funcName;
    } catch {
      return null;
    }
  }

  /** Rebuilds saved cards and their collision notices. @returns {void} */
  function renderSavedList() {
    const list = /** @type {HTMLElement} */ (env.document.getElementById('savedList'));
    list.replaceChildren();

    const nameCounts = new Map();
    page.doc.savedSolids.forEach(item => {
      const name = actions.savedFuncName(item);
      if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    });

    page.doc.savedSolids.forEach((item, index) => {
      const funcName = actions.savedFuncName(item);
      const inRegistry = funcName !== null && page.registry.registrySolidNames.has(env.registryDisplayName(item, funcName));
      const clashMessage = funcName && (inRegistry || nameCounts.get(funcName) > 1)
        ? inRegistry
          ? `Exports as ${funcName}, which the engine registry already defines`
          : `Exports as ${funcName}, which another saved solid also exports`
        : '';
      const el = env.buildSavedCard(item, index, {
        count: page.doc.savedSolids.length, funcName, clashMessage, canRestore: Boolean(page.engine.wasmModule),
        on: {restore: actions.restoreSolid, remove: actions.deleteSolid, copy: actions.copyCode, explain: actions.showGateMsg},
        doc: env.document,
      });

      list.insertBefore(el, list.firstChild);
    });
  }

  /** Deletes a saved card and restores keyboard focus. @param {number} index @returns {void} */
  function deleteSolid(index) {
    const position = page.doc.savedSolids.length - index - 1;
    page.doc.savedSolids.splice(index, 1);
    actions.persistSavedSolids();
    actions.renderSavedList();
    actions.showGateMsg('');
    const rows = (/** @type {HTMLElement} */ (env.document.getElementById('savedList'))).children;
    const focusTarget = rows[Math.min(position, rows.length - 1)]?.querySelector('.del-btn')
      ?? env.document.getElementById('saveBtn');
    /** @type {HTMLElement|null|undefined} */ (focusTarget)?.focus();
  }

  /** Copies generated C++ after export validation.
   * @param {number} index @param {string} lang @param {HTMLButtonElement} btn @returns {Promise<void>} */
  async function copyCode(index, lang, btn) {
    const item = page.doc.savedSolids[index];
    const shapeError = env.savedChainShapeError(item.base, item.ops);
    if (shapeError) {
      actions.showCopyFailure(btn, `export failed: ${shapeError}`);
      return;
    }
    if (!page.registry.registrySolidNames.has(item.base)) {
      actions.showCopyFailure(btn, `export failed: unknown base solid ${item.base}`);
      return;
    }
    const baseIsStar = page.registry.islamicStarPatterns.includes(item.base);

    let code;
    let validationError = /** @type {Error|null} */ (null);
    try {
      if (lang === 'recipe_cpp') {
        if (baseIsStar) {
          actions.showCopyFailure(btn, 'export failed: a star-pattern base requires the Copy registry C++ export');
          return;
        }
        const seedNs = env.CATALAN_BASES.has(item.base) ? "Catalan" : "Archimedean";
        code = env.generateRecipeCpp(item, seedNs);
      } else if (lang === 'registry') {
        let baseRecipe = null;
        if (baseIsStar) {
          if (!page.engine.meshOpsWasm) {
            actions.showCopyFailure(btn, 'export failed: the engine has stood down; reload to export a registry');
            return;
          }
          baseRecipe = page.engine.meshOpsWasm.getRecipe(item.base);
          if (!baseRecipe) {
            actions.showCopyFailure(btn, `export failed: no authored chain for "${item.base}" — `
              + 'its registry recipe cannot be generated');
            return;
          }
        }
        const registryCode = env.generateRegistryCpp(item, baseRecipe);
        code = env.validateRegistryFaces(/** @type {import('./solid_validation.js').ChainValidator} */ (page.engine.validator), item, baseRecipe)
          .then(() => registryCode, (error) => { validationError = error; throw error; });
      } else {
        env.console.warn("Unsupported export type.");
        return;
      }
    } catch (e) {
      if (actions.engineTrapped(e)) return;
      actions.showCopyFailure(btn, `export failed: ${/** @type {Error} */ (e).message}`);
      return;
    }

    try {
      const copied = await env.copyWithFeedback(
        code, { element: btn, copiedClasses: ['text-green-400'],
          failedText: 'Failed', failedClasses: ['text-red-400'] });
      if (copied) actions.showGateMsg('');
      else actions.showGateMsg('copy failed: the browser refused clipboard access');
    } catch (e) {
      const failure = /** @type {Error|null} */ (validationError);
      if (failure) {
        if (actions.engineTrapped(failure)) return;
        actions.showCopyFailure(btn, `export failed: ${failure.message}`);
        return;
      }
      actions.showCopyFailure(btn, `copy failed: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** Shows an export failure beside its button and in the status line.
   * @param {HTMLButtonElement} button @param {string} message @returns {void} */
  function showCopyFailure(button, message) {
    actions.showGateMsg(message);
    env.showCopyFeedback(false, { element: button, failedText: 'Failed',
      copiedClasses: ['text-green-400'], failedClasses: ['text-red-400'] });
  }

  /** Queues a validated saved-card restore. @param {SavedSolid} item @returns {void} */
  function restoreSolid(item) {
    const shapeError = env.queueSavedSolidRestore(item, () => actions.queueCommit(async () => {
      if (page.doc.ops.length > 1 && !env.window.confirm(
        `Replace all ${page.doc.ops.length} operations with the saved "${item.title || 'saved solid'}" chain?`)) return;
      const check = await actions.chainIsValid(item.base, item.ops);
      if (!check.ok) {
        actions.showGateMsg(`rejected: ${check.message}`);
        return;
      }
      actions.applyRestore(item);
    }));
    if (shapeError) {
      actions.showGateMsg(`cannot restore "${item.title || 'saved solid'}": ${shapeError}`
        + ' — delete this card and save the solid again');
    }
  }

  /** Applies a saved recipe and view flags. @param {SavedSolid} item @returns {void} */
  function applyRestore(item) {
    actions.showGateMsg('');
    page.doc.base = item.base;
    actions.setOps(env.structuredClone(item.ops));
    const flag = (/** @type {boolean|undefined} */ value, /** @type {boolean} */ fallback) => !!(value ?? fallback);
    page.view.showGeodesics = flag(item.geodesics, true);
    page.view.showFaces = flag(item.faces, true);
    page.view.colorizeFaces = flag(item.colorize, false);
    page.view.showVertices = flag(item.vertices, false);
    page.view.showNormals = flag(item.normals, false);
    page.view.showIndices = flag(item.indices, false);

    actions.updateToggles();
    actions.renderOps();

    actions.highlightBaseSolid();

    actions.update();
    actions.renderBaseSolid();
  }

  /** Clears saved cards after confirmation. @returns {void} */
  function clearSavedSolids() {
    if (page.doc.savedSolids.length === 0 || !env.window.confirm(
      `Delete ${page.doc.savedSolids.length} saved solid${page.doc.savedSolids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    page.doc.savedSolids.length = 0;
    actions.persistSavedSolids();
    actions.renderSavedList();
  }
  return { wireSavedSolidControls, reloadSavedSolids, persistSavedSolids, exportSavedSolids, importSavedSolids, captureSavedThumbnail, saveSolid, savedFuncName, renderSavedList, deleteSolid, copyCode, showCopyFailure, restoreSolid, applyRestore, clearSavedSolids };
}
