/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */
import {createCommitQueue, createChainValidator, createOpGate} from './solid_validation.js';
import {loadSavedSolids, resolveSavedSolidsStorage} from './solid_saved_store.js';

/** @typedef {{op: string, params: Record<string, number>}} SolidsOp */
/** @typedef {import('../../../generated/holosphere_wasm.js').MainModule} WasmModule */
/**
 * @typedef {object} SolidsActions
 * @property {(next: SolidsOp[]) => void} setOps
 * @property {(fn: () => unknown) => Promise<void>} queueCommit
 * @property {ReturnType<typeof createChainValidator>['chainIsValid']} chainIsValid
 * @property {ReturnType<typeof import('../../shared/page_lifecycle.js').createFrameScheduler>} scheduleUpdate
 * @property {() => Promise<boolean>} initializeSolidEngine
 * @property {() => void} updateArenaMetrics
 * @property {(message: string) => void} standDown
 * @property {() => void} freezeEditing
 * @property {(error: unknown) => boolean} engineTrapped
 * @property {(message: string) => void} showMeshError
 * @property {(message: string) => void} showThumbnailError
 * @property {(onError?: (message: string) => void) => import('./solid_build.js').MeshBuildContext} buildContext
 * @property {() => void} update
 * @property {() => void} mountSolidScene
 * @property {() => void} wireViewToggles
 * @property {() => void} updateToggles
 * @property {(on: boolean) => void} setAutoRotate
 * @property {(canvas: HTMLCanvasElement) => void} wireCanvasTap
 * @property {(capped: boolean) => void} updateIndexLabelNotice
 * @property {() => void} renderMesh
 * @property {() => boolean} labelCameraMoved
 * @property {() => void} updateLabels
 * @property {(from: number, to: number, revision: number) => void} reorderOp
 * @property {() => void} renderOps
 * @property {(index: number, key: string, value: string, revision: number) => void} updateOpParam
 * @property {(index: number, revision: number) => void} removeOp
 * @property {(event: Event) => void} activateAddOp
 * @property {(name: string) => void} addOp
 * @property {() => void} resetOps
 * @property {() => void} wireOpControls
 * @property {(from: number, target: number) => Promise<void>} checkDropSlot
 * @property {(event: PointerEvent, list: HTMLElement) => number} getDragTargetIndex
 * @property {(gesture: import('./solids_row_drag.js').RowGesture, event: PointerEvent) => void} moveRowDragPreview
 * @property {(grip: HTMLElement, index: number, row: HTMLElement, list: HTMLElement, revision: number) => void} wireRowDrag
 * @property {(text: string, options?: {persist?: boolean}) => void} showGateMsg
 * @property {(button: HTMLElement, reason: string|null) => void} setOpBlocked
 * @property {(reason: string) => void} openOpGate
 * @property {() => Promise<void>} refreshOpGating
 * @property {() => void} wireSavedSolidControls
 * @property {(event: StorageEvent) => void} reloadSavedSolids
 * @property {() => void} persistSavedSolids
 * @property {() => void} exportSavedSolids
 * @property {(text: string) => void} importSavedSolids
 * @property {() => string} captureSavedThumbnail
 * @property {() => void} saveSolid
 * @property {(item: import('./solids_saved_controller.js').SavedSolid) => string|null} savedFuncName
 * @property {() => void} renderSavedList
 * @property {(index: number) => void} deleteSolid
 * @property {(index: number, lang: string, button: HTMLButtonElement) => Promise<void>} copyCode
 * @property {(button: HTMLButtonElement, message: string) => void} showCopyFailure
 * @property {(item: import('./solids_saved_controller.js').SavedSolid) => void} restoreSolid
 * @property {(item: import('./solids_saved_controller.js').SavedSolid) => void} applyRestore
 * @property {() => void} clearSavedSolids
 * @property {(event: KeyboardEvent) => void} handleBaseSolidKeyDown
 * @property {() => ReturnType<ReturnType<typeof import('./solids_base_picker.js').createSolidsBasePicker>['createThumbnailScene']>} createThumbnailScene
 * @property {(signal: AbortSignal) => Promise<void>} generateThumbnails
 * @property {(button: HTMLButtonElement, key: string) => void} configureBaseSolidThumbnail
 * @property {(key: string, button: HTMLElement) => void} selectBaseSolid
 * @property {() => void} highlightBaseSolid
 * @property {() => void} renderBaseSolid
 */
/** @typedef {ReturnType<typeof initialPage>} SolidsPage */

/** View toggle IDs and their state keys. */
export const VIEW_TOGGLES = /** @type {const} */ ({
  toggleRotate: 'autoRotate', toggleGeo: 'showGeodesics', toggleFaces: 'showFaces',
  toggleColorize: 'colorizeFaces', toggleVerts: 'showVertices', toggleNormals: 'showNormals',
  toggleIndices: 'showIndices',
});

/** @param {MediaQueryList|undefined} reducedMotion */
function initialPage(reducedMotion) {
  return {
    engine: {
      wasmModule: /** @type {WasmModule|null} */ (null),
      meshOpsWasm: /** @type {WasmModule['MeshOps']|null} */ (null),
      createHolosphereModule: /** @type {typeof import('../../../generated/holosphere_wasm.js').default|null} */ (null),
      validator: /** @type {ReturnType<typeof createChainValidator>|null} */ (null),
      opGate: /** @type {ReturnType<typeof createOpGate>|null} */ (null),
      arenaMetricsTimer: /** @type {number|null} */ (null),
    },
    doc: {
      base: 'cube', ops: /** @type {SolidsOp[]} */ ([]), opsRevision: 0,
      parameterEdits: /** @type {Map<string, symbol>} */ (new Map()),
      dropSlotChecks: /** @type {Map<number, {ok: boolean, message: string}|null>} */ (new Map()),
      dropSlotGen: 0,
      savedStore: resolveSavedSolidsStorage(),
      savedStorage: /** @type {ReturnType<typeof loadSavedSolids>} */ ({entries: [], rejected: [], notice: '', backupNotice: ''}),
      savedSolids: /** @type {import('./solids_saved_controller.js').SavedSolid[]} */ ([]),
      savedStorageStatus: /** @type {HTMLElement|null} */ (null),
    },
    view: {
      autoRotate: reducedMotion?.matches !== true, showGeodesics: true, showFaces: true,
      colorizeFaces: false, showVertices: false, showNormals: false, showIndices: false,
      reducedMotion, gateMsgTimer: /** @type {number|null} */ (null),
    },
    mesh: {
      currentMesh: /** @type {import('./solid_render.js').SolidMeshData|null} */ (null),
      currentMeshIsCurrent: false, currentFaceClasses: /** @type {Int32Array|null} */ (null),
      currentClassifyFailure: /** @type {string|null} */ (null),
    },
    scene: {
      camera: /** @type {import('three').PerspectiveCamera|null} */ (null),
      scene: /** @type {import('three').Scene|null} */ (null),
      renderer: /** @type {import('three').WebGLRenderer|null} */ (null),
      controls: /** @type {import('three/addons/controls/OrbitControls.js').OrbitControls|null} */ (null),
      meshRenderer: /** @type {ReturnType<typeof import('./solid_render.js').createMeshRenderer>|null} */ (null),
      labelsContainer: /** @type {HTMLElement|null} */ (null), labelsNeedReproject: false,
    },
    registry: {
      baseThumbnails: /** @type {Record<string, string>} */ ({}), simpleSolids: /** @type {string[]} */ ([]),
      islamicStarPatterns: /** @type {string[]} */ ([]), registrySolidNames: new Set(/** @type {string[]} */ ([])),
    },
  };
}

/** @param {MediaQueryList|undefined} reducedMotion @returns {SolidsPage} */
export function createSolidsPage(reducedMotion) {
  return initialPage(reducedMotion);
}

/** Replaces the op list and invalidates rendered row indices.
 * @param {SolidsPage} page @param {SolidsOp[]} next @returns {void} */
export function setOps(page, next) {
  page.doc.ops = next;
  page.doc.parameterEdits.clear();
  page.doc.opsRevision++;
}

/** @param {SolidsPage} page @param {SolidsActions} actions @returns {void} */
export function initializeSolidsState(page, actions) {
  page.doc.savedStorage = loadSavedSolids(page.doc.savedStore.storage);
  page.doc.savedSolids = page.doc.savedStorage.entries;
  page.doc.savedStorageStatus = document.getElementById('savedStorageStatus');
  if (page.doc.savedStorageStatus) page.doc.savedStorageStatus.textContent =
    [page.doc.savedStore.notice, page.doc.savedStorage.notice, page.doc.savedStorage.backupNotice].filter(Boolean).join(' ');
  page.engine.validator = createChainValidator(() => {
    if (!page.engine.createHolosphereModule) throw new Error('Solids engine is not initialized');
    return page.engine.createHolosphereModule();
  });
  page.engine.opGate = createOpGate(page.engine.validator);
  actions.chainIsValid = page.engine.validator.chainIsValid;
  const commit = createCommitQueue(error => {
    console.error(error);
    actions.showGateMsg(`Operation failed: ${error instanceof Error ? error.message : error}`);
  });
  actions.queueCommit = fn => commit(() => page.engine.wasmModule ? fn() : undefined);
}
