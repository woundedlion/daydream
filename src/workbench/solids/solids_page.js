/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/solids.html.
 */
import * as THREE from 'three';
import { initScene, copyWithFeedback, showFatalError, bootstrapTool, formatKB } from '../shared.js';
import { standDownIfHalted } from '../../shared/engine_halt.js';
import {
  OP_DEFS,
  SAVED_SOLIDS_MAX,
  captureSavedSolidThumbnail,
  queueSavedSolidRestore,
  savedChainShapeError, savedSolidExportError,
  CATALAN_BASES,
  formatSolidName,
  generateFuncAndRecipe,
  generateRecipeCpp,
  snapToStep,
  seedOpParams,
  fanTriangulateFace,
  uniqueEdges,
  dropSlotIndex,
  dropTargetIndex,
  reorderPreviewShift,
  movedOps,
  opTopologyKey,
  createCommitQueue,
  createChainValidator,
  createOpGate,
} from './solid_codegen.js';
import { buildBaseMesh, buildChainMesh } from './solid_build.js';
import { generateRegistryCpp, validateRegistryFaces, MAX_RECIPE_STEPS } from './solid_registry_codegen.js';
import { buildOpRow, formatParamValue, syncSweepWarning } from './solid_op_rows.js';
import { createMeshRenderer, meshStatsLine, meshCanvasLabel, MAX_INDEX_LABELS }
  from './solid_render.js';
import {
  createFrameScheduler, onPageTeardown, watchMediaMatch,
} from '../../shared/page_lifecycle.js';
import { showCopyFeedback } from '../../shared/clipboard.js';
import { createPointerDrag } from '../../shared/pointer_drag.js';
import { downloadBlob } from '../../shared/download_file.js';

let camera, scene, renderer, controls;
let meshRenderer = null;
let labelsContainer;
let createHolosphereModule = null;

const faceMaterial = new THREE.MeshPhongMaterial({
  color: 0x3b82f6,
  transparent: true,
  opacity: 0.9,
  side: THREE.DoubleSide,
  flatShading: true,
  shininess: 50,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1
});
// Same config as faceMaterial, but sourcing color from the per-vertex
// topology-class attribute generated when Colorize Faces is on.
const faceColorizeMaterial = new THREE.MeshPhongMaterial({
  color: 0xffffff,
  vertexColors: true,
  transparent: true,
  opacity: 0.9,
  side: THREE.DoubleSide,
  flatShading: true,
  shininess: 50,
  polygonOffset: true,
  polygonOffsetFactor: 1,
  polygonOffsetUnits: 1
});
const vertMaterial = new THREE.PointsMaterial({ color: 0xa5b4fc, size: 0.05 });
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
const normalMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 });

// Coalesce update() calls into one recompute per animation frame.
const scheduleUpdate = createFrameScheduler(update);
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// WASM Module
let wasmModule = null;
let meshOpsWasm = null;

const state = {
  base: 'cube',
  ops: [], // Array of objects { op: string, params: object }
  autoRotate: reducedMotion?.matches !== true,
  showGeodesics: true,
  showFaces: true,
  colorizeFaces: false,
  showVertices: false,
  showNormals: false,
  showIndices: false
};

const baseThumbnails = {};

// JS mesh readback for stats, index labels, and internal angles.
let currentMesh = null;
let currentMeshIsCurrent = false;
// Per-face topology class ids for the Colorize Faces toggle, cached from the
// last recompute: classifyFaces() needs the live WASM mesh, which update() frees.
let currentFaceClasses = null;

// Lists (populated from WASM)
let simpleSolids = [];
let islamicStarPatterns = [];
// Every name the engine registry defines; empty until the registry loads.
let registrySolidNames = new Set();

async function init() {
  // Load WASM
  try {
    ({ default: createHolosphereModule } = await import('../../../generated/holosphere_wasm.js'));
    wasmModule = await createHolosphereModule();
    meshOpsWasm = wasmModule.MeshOps;

    // Populate Registry from WASM
    const registry = meshOpsWasm.getRegistry();
    // registry is array of {name, category}
    simpleSolids = [];
    islamicStarPatterns = [];
    registrySolidNames = new Set();

    for (let i = 0; i < registry.length; i++) {
      const item = registry[i];
      const name = item.name;
      const cat = item.category; // "Simple" or "Complex"

      registrySolidNames.add(name);
      if (cat === "Complex") {
        islamicStarPatterns.push(name);
      } else {
        simpleSolids.push(name);
      }
    }

  } catch (e) {
    console.error('Failed to load WASM:', e);
    showFatalError('Failed to load the Holosphere WASM engine — the solids '
      + 'tool needs the built holosphere_wasm artifacts. Build the WASM '
      + 'target and reload.');
    return;
  }

  // Start Memory Metrics Loop.
  let arenaMetricsTimer = null;
  function updateArenaMetrics() {
    if (!meshOpsWasm) return;
    arenaMetricsTimer = null;
    try {
      const m = meshOpsWasm.getArenaMetrics();
      // Peak over the module's life: clearToolingMemory() zeroes the windowed
      // high_water_mark.
      const fmt = (x) => `${formatKB(x.lifetime_high_water_mark, 0)} / ${formatKB(x.capacity, 0)}KB`;
      const statsEl = document.getElementById('arenaStats');
      if (statsEl) {
        statsEl.innerText = `Live ${fmt(m.tooling_arena)} · `
          + `Scratch A ${fmt(m.tooling_scratch_a)} · Scratch B ${fmt(m.tooling_scratch_b)}`;
      }
    } catch (error) {
      if (engineTrapped(error)) return;
      console.warn('Arena metrics unavailable:', error);
    }
    arenaMetricsTimer = setTimeout(updateArenaMetrics, 500); // 2fps update is enough
  }
  const thumbnailAbort = new AbortController();
  onPageTeardown(() => {
    thumbnailAbort.abort();
    if (arenaMetricsTimer !== null) { clearTimeout(arenaMetricsTimer); arenaMetricsTimer = null; }
  });
  updateArenaMetrics();
  if (!wasmModule) return;

  const result = initScene('canvas-container', 'canvas', {
    cameraPosition: [2, 1.5, 2],
    far: 100,
    minDistance: 0,
    maxDistance: Infinity,
    autoRotate: state.autoRotate,
    autoRotateSpeed: 2.0,
    lights: true,
    showSphere: false,
    onAfterRender: updateLabels,
    onAfterResize: () => { labelsNeedReproject = true; },
  });
  scene = result.scene;
  camera = result.camera;
  renderer = result.renderer;
  controls = result.controls;
  const stopWatchingReducedMotion = watchMediaMatch(
    reducedMotion, () => setAutoRotate(false));

  // Cancel the pending frame so a queued recompute never runs on the disposed scene.
  onPageTeardown(() => {
    stopWatchingReducedMotion();
    scheduleUpdate.cancel();
    meshRenderer?.disposeGeometry();
    faceMaterial.dispose();
    faceColorizeMaterial.dispose();
    vertMaterial.dispose();
    edgeMaterial.dispose();
    normalMaterial.dispose();
    result.dispose();
  });

  // Presentation toggles: redraw the cached mesh via renderMesh().
  document.getElementById('toggleRotate').addEventListener('click', () => {
    setAutoRotate(!state.autoRotate);
  });
  document.getElementById('toggleGeo').addEventListener('click', () => {
    state.showGeodesics = !state.showGeodesics;
    updateToggles();
    renderMesh();
  });
  document.getElementById('toggleFaces').addEventListener('click', () => {
    state.showFaces = !state.showFaces;
    updateToggles();
    renderMesh();
  });
  document.getElementById('toggleColorize').addEventListener('click', () => {
    state.colorizeFaces = !state.colorizeFaces;
    updateToggles();
    renderMesh();
  });
  document.getElementById('toggleVerts').addEventListener('click', () => {
    state.showVertices = !state.showVertices;
    updateToggles();
    renderMesh();
  });
  document.getElementById('toggleNormals').addEventListener('click', () => {
    state.showNormals = !state.showNormals;
    updateToggles();
    renderMesh();
  });
  document.getElementById('toggleIndices').addEventListener('click', () => {
    state.showIndices = !state.showIndices;
    updateToggles();
    renderMesh();
  });

  wireCanvasTap(document.getElementById('canvas'));

  labelsContainer = document.getElementById('labels');
  meshRenderer = createMeshRenderer({
    THREE,
    scene,
    materials: {
      face: faceMaterial,
      faceColorize: faceColorizeMaterial,
      vert: vertMaterial,
      edge: edgeMaterial,
      normal: normalMaterial,
    },
    labelsContainer,
  });

  document.getElementById('saveBtn').addEventListener('click', saveSolid);

  // Static control buttons. The add-op grid uses one delegated listener that
  // resolves the clicked button with closest().
  document.getElementById('clearOpsBtn').addEventListener('click', resetOps);
  document.getElementById('exportSavedBtn').addEventListener('click', exportSavedSolids);
  const importFile = document.getElementById('importSavedFile');
  document.getElementById('importSavedBtn').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    try {
      if (file) importSavedSolids(await file.text());
    } catch (error) {
      showGateMsg(`import failed: ${error.message}`);
    } finally {
      importFile.value = '';
    }
  });
  document.getElementById('clearSavedBtn').addEventListener('click', clearSavedSolids);
  document.getElementById('addOpGrid').addEventListener('click', activateAddOp);

  generateThumbnails(thumbnailAbort.signal).catch(e => {
    if (engineTrapped(e)) return;
    console.error('Thumbnail generation failed:', e);
  });

  renderSavedList();
  updateToggles();
  update();
  renderBaseSolid();
}

async function generateThumbnails(signal) {
  const footer = document.getElementById('footer');

  // Gather all solid names from exported lists
  const thumbKeys = [...simpleSolids, ...islamicStarPatterns];

  const width = 256; // High-res for larger thumbs
  const height = 256;
  const offRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  offRenderer.setSize(width, height);
  offRenderer.setClearColor(0x000000, 0); // Transparent

  const offScene = new THREE.Scene();
  const offCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 10);
  offCamera.position.set(1.5, 1.5, 1.5);
  offCamera.lookAt(0, 0, 0);

  const light = new THREE.DirectionalLight(0xffffff, 1.5);
  light.position.set(2, 5, 3);
  const ambient = new THREE.AmbientLight(0xffffff, 0.5);
  offScene.add(light);
  offScene.add(ambient);

  // Material for thumbnails
  const mat = new THREE.MeshPhongMaterial({
    color: 0x3b82f6,
    flatShading: true,
    shininess: 30
  });
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });

  try {
    for (const key of thumbKeys) {
      // Yield between thumbnails.
      await new Promise(resolve => setTimeout(resolve));
      if (signal.aborted || !meshOpsWasm) break;

      // Reset to just the lights.
      offScene.clear();
      offScene.add(light);
      offScene.add(ambient);

      const meshData = buildBaseMesh(key, `Thumbnail for "${key}"`, buildContext(showThumbnailError));
      if (!meshData) continue;

      // Triangulate
      const vertices = [];
      const emitTri = (a, b, c) => {
        vertices.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      };
      meshData.faces.forEach(f => fanTriangulateFace(meshData.vertices, f, emitTri));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, mat);
      offScene.add(mesh);

      // Edges
      const linePoints = [];
      for (const [ai, bi] of uniqueEdges(meshData.faces, meshData.vertices.length)) {
        linePoints.push(meshData.vertices[ai], meshData.vertices[bi]);
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
      const lines = new THREE.LineSegments(lineGeo, lineMat);
      offScene.add(lines);

      // Render
      offRenderer.render(offScene, offCamera);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `thumb-btn ${state.base === key ? 'active' : ''}`;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', state.base === key ? 'true' : 'false');
      btn.tabIndex = state.base === key ? 0 : -1;
      btn.addEventListener('keydown', (event) => {
        const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1
          : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
        if (!delta) return;
        event.preventDefault();
        const choices = [...document.querySelectorAll('.thumb-btn')];
        const next = choices[(choices.indexOf(btn) + delta + choices.length) % choices.length];
        next.focus();
        next.click();
      });
      btn.dataset.solid = key; // identify the base so restoreSolid can re-highlight it
      btn.addEventListener('click', () => {
        queueCommit(async () => {
          // The op stack is kept across a base switch.
          if (state.ops.length) {
            const check = await chainIsValid(key, state.ops);
            if (!check.ok) {
              showGateMsg(`rejected: the op stack fails on this solid — ${check.message}`);
              if (document.activeElement === btn) {
                document.querySelector('.thumb-btn[aria-checked="true"]')?.focus();
              }
              return;
            }
          }
          state.base = key;
          update();
          renderBaseSolid();
          highlightBaseSolid();
        });
      });

      const img = document.createElement('img');
      img.alt = '';
      const dataURL = offRenderer.domElement.toDataURL();
      img.src = dataURL;
      baseThumbnails[key] = dataURL;

      // Refresh the selected preview when its thumbnail becomes available.
      if (key === state.base) {
        document.getElementById('baseThumb').src = dataURL;
      }

      const title = formatSolidName(key);
      btn.title = title;
      const span = document.createElement('span');
      span.className = 'thumb-label';
      span.textContent = title;
      const fullName = document.createElement('span');
      fullName.className = 'thumb-name-full';
      fullName.setAttribute('aria-hidden', 'true');
      fullName.textContent = title;

      btn.appendChild(img);
      btn.appendChild(span);
      btn.appendChild(fullName);
      footer.appendChild(btn);

      // Free the per-iteration geometry GPU buffers.
      geo.dispose();
      lineGeo.dispose();
    }
  } finally {
    mat.dispose();
    lineMat.dispose();
    offRenderer.dispose();
    offRenderer.forceContextLoss();
  }
}

function updateToggles() {
  // The on/off look is the `.toggle-switch.is-on` class.
  const toggleState = {
    toggleRotate: state.autoRotate,
    toggleGeo: state.showGeodesics,
    toggleFaces: state.showFaces,
    toggleColorize: state.colorizeFaces,
    toggleVerts: state.showVertices,
    toggleNormals: state.showNormals,
    toggleIndices: state.showIndices,
  };
  for (const [id, on] of Object.entries(toggleState)) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.classList.toggle('is-on', !!on);
    btn.setAttribute('aria-checked', on ? 'true' : 'false'); // role="switch" state
  }
}

function setAutoRotate(on) {
  state.autoRotate = on;
  controls.autoRotate = on;
  updateToggles();
}

function wireCanvasTap(canvasEl) {
  let x = 0, y = 0, moved = false;
  const tap = createPointerDrag({
    element: canvasEl,
    onStart: (event) => { x = event.clientX; y = event.clientY; moved = false; },
    onMove: (event) => { moved ||= Math.hypot(event.clientX - x, event.clientY - y) >= 5; },
    onEnd: (event) => {
      if (!moved && event && Math.hypot(event.clientX - x, event.clientY - y) < 5)
        setAutoRotate(!state.autoRotate);
    },
    onCancel: () => {},
  });
  onPageTeardown(() => { tap.stop(); tap.remove(); });
}

const SAVED_SOLIDS_KEY = 'daydream.savedSolids.v1';
const REJECTED_SOLIDS_KEY = 'daydream.savedSolids.rejected.v1';
const SAVED_THUMB_SIZE = 256;
function loadSavedSolids() {
  const entries = [], rejected = [];
  let reason = '';
  let raw;
  try {
    raw = localStorage.getItem(SAVED_SOLIDS_KEY) || '[]';
    const parsed = JSON.parse(raw);
    for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
      const error = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? savedSolidExportError(entry.base, entry.ops) : 'not a saved-solid object';
      if (error) {
        rejected.push(entry);
        reason ||= error;
      } else entries.push(entry);
    }
  } catch (error) {
    console.warn('Could not restore saved solids:', error);
    if (raw !== undefined) rejected.push(raw);
    reason = 'invalid saved-solid JSON';
  }
  return { entries, rejected, notice: rejected.length
    ? `${rejected.length} saved solids could not be loaded: ${reason}. Rejected data is retained in browser storage.` : '' };
}

const savedStorage = loadSavedSolids();
const savedSolids = savedStorage.entries;
const savedStorageStatus = document.getElementById('savedStorageStatus');
if (savedStorageStatus) savedStorageStatus.textContent = savedStorage.notice;

function persistSavedSolids() {
  const status = document.getElementById('savedStorageStatus');
  try {
    if (savedStorage.rejected.length) {
      const previous = JSON.parse(localStorage.getItem(REJECTED_SOLIDS_KEY) || '[]');
      if (!Array.isArray(previous)) throw new Error('Rejected-solid backup is not an array');
      localStorage.setItem(REJECTED_SOLIDS_KEY, JSON.stringify([...previous, ...savedStorage.rejected]));
      savedStorage.rejected.length = 0;
    }
    localStorage.setItem(SAVED_SOLIDS_KEY, JSON.stringify(savedSolids));
    if (status) status.textContent = savedStorage.notice;
  } catch (error) {
    console.warn('Could not persist saved solids:', error);
    if (status) status.textContent = [savedStorage.notice,
      'Changes apply to this session only: browser storage refused the write.'].filter(Boolean).join(' ');
  }
}

function exportSavedSolids() {
  const blob = new Blob([JSON.stringify(savedSolids, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(document, blob, 'daydream-solids.json');
}

/** Flags a saved card carries, each absent from a card saved before it existed. */
const SAVED_FLAGS = ['geodesics', 'faces', 'colorize', 'vertices', 'normals', 'indices'];

/**
 * Rebuilds one imported entry as a saved card, field by field.
 * @param {Object} entry - A shape-checked entry from an exported file.
 * @returns {Object} The card to hold in the saved list.
 * @details Only the fields the card and the C++ export read are carried across;
 * a flag the entry does not hold is left absent. A thumbnail is taken only as a
 * data image.
 */
function importedSavedSolid(entry) {
  const text = (value) => (typeof value === 'string' ? value : '');
  const item = {
    base: entry.base,
    ops: structuredClone(entry.ops),
    thumb: text(entry.thumb).startsWith('data:image/') ? entry.thumb : '',
    title: text(entry.title) || formatSolidName(entry.base),
    desc: text(entry.desc),
    stats: text(entry.stats),
  };
  for (const flag of SAVED_FLAGS) {
    if (typeof entry[flag] === 'boolean') item[flag] = entry[flag];
  }
  for (const count of ['vCount', 'fCount', 'iCount']) {
    if (Number.isFinite(entry[count])) item[count] = entry[count];
  }
  return item;
}

/**
 * Merges an exported saved-solids file into the list.
 * @param {string} text - The file's contents.
 * @returns {void}
 * @details Each card is checked with savedSolidExportError before import.
 */
function importSavedSolids(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    showGateMsg(`import rejected: ${error.message}`);
    return;
  }
  if (!Array.isArray(parsed)) {
    showGateMsg('import rejected: the file holds no list of saved solids');
    return;
  }

  let refused = 0;
  let firstRefusal = null;
  let full = 0;
  const before = savedSolids.length;
  for (const entry of parsed) {
    const reason = !entry || typeof entry !== 'object' || Array.isArray(entry)
      ? 'entry is not a saved-solid object' : savedSolidExportError(entry.base, entry.ops);
    if (reason) {
      refused++;
      firstRefusal ??= reason;
      continue;
    }
    if (savedSolids.length >= SAVED_SOLIDS_MAX) {
      full++;
      continue;
    }
    savedSolids.push(importedSavedSolid(entry));
  }

  const added = savedSolids.length - before;
  if (added > 0) {
    persistSavedSolids();
    renderSavedList();
  }
  const skipped = [];
  if (refused > 0) skipped.push(`${refused} invalid entries (${firstRefusal})`);
  if (full > 0) skipped.push(`${full} past the ${SAVED_SOLIDS_MAX}-card limit`);
  showGateMsg(`imported ${added} solid${added === 1 ? '' : 's'}`
    + (skipped.length > 0 ? ` — skipped ${skipped.join(' and ')}` : ''));
}

function captureSavedThumbnail() {
  renderer.render(scene, camera);
  const source = renderer.domElement;
  const canvas = document.createElement('canvas');
  canvas.width = SAVED_THUMB_SIZE;
  canvas.height = SAVED_THUMB_SIZE;
  const context = canvas.getContext('2d');
  const scale = Math.min(canvas.width / source.width, canvas.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2,
    width, height);
  return canvas.toDataURL('image/png');
}

function saveSolid() {
  // Nothing to save until the first successful update() has produced a mesh.
  if (!currentMesh || !currentMeshIsCurrent) {
    showGateMsg("rejected: the current chain has no successful preview to save");
    return;
  }

  // A base with no ops has no exportable recipe.
  if (state.ops.length === 0) {
    showGateMsg('rejected: add at least one op — a bare seed has no recipe to export');
    return;
  }

  const thumbnail = captureSavedSolidThumbnail(
    savedSolids.length, captureSavedThumbnail);
  if (thumbnail.full) {
    showGateMsg(`rejected: the saved list is full at ${SAVED_SOLIDS_MAX} — `
      + 'export it, then delete a card to make room');
    return;
  }

  const dataURL = thumbnail.dataURL;

  const title = formatSolidName(state.base);

  // Derive the edge count from the readback copy.
  const vCount = currentMesh.vertices.length;
  const fCount = currentMesh.faces.length;
  const eCount = uniqueEdges(currentMesh.faces, vCount).length;
  let iCount = 0;
  currentMesh.faces.forEach(f => iCount += f.length);

  // Generate summary
  const opsSummary = state.ops.map(o => {
    if (o.op === 'truncate') return `Tr(${o.params.t})`;
    if (o.op === 'hankin') return `Hk(${o.params.angle.toFixed(2)})`;
    const name = o.op.charAt(0).toUpperCase() + o.op.slice(1);
    const params = Object.entries(o.params ?? {}).map(([key, value]) => `${key}=${value}`);
    return params.length ? `${name}(${params.join(', ')})` : name;
  }).join(', ');

  const item = {
    base: state.base,
    ops: structuredClone(state.ops), // Deep copy (ops are plain data)
    geodesics: state.showGeodesics,
    faces: state.showFaces,
    colorize: state.colorizeFaces,
    vertices: state.showVertices,
    normals: state.showNormals,
    indices: state.showIndices,
    thumb: dataURL,
    title: title,
    desc: opsSummary,
    stats: `${vCount}V ${eCount}E ${fCount}F ${iCount}I`,
    vCount, fCount, iCount
  };

  // A name matching an engine registry entry would redefine it at paste time.
  const funcName = savedFuncName(item);
  if (funcName && registrySolidNames.has(funcName)) {
    showGateMsg(`saved: "${funcName}" is already in the engine registry — `
      + `the exported C++ would redefine it; vary an op parameter`);
  } else if (funcName && savedSolids.some(s => savedFuncName(s) === funcName)) {
    showGateMsg(`saved: "${funcName}" collides with another saved solid — `
      + `vary an op parameter to keep the exported C++ names unique`);
  }

  savedSolids.push(item);
  persistSavedSolids();
  renderSavedList();
}

// The exported C++ function name, or null for an unexportable recipe.
function savedFuncName(item) {
  try {
    return generateFuncAndRecipe(item).funcName;
  } catch {
    return null;
  }
}

function renderSavedList() {
  const list = document.getElementById('savedList');
  list.replaceChildren();

  // Flag every member of a colliding funcName set, and any name the engine
  // registry holds.
  const nameCounts = new Map();
  savedSolids.forEach(item => {
    const name = savedFuncName(item);
    if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  });

  savedSolids.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'saved-item relative pr-6';
    const funcName = savedFuncName(item);
    const cardName = `${funcName ?? item.title} (card ${savedSolids.length - index})`;
    const inRegistry = funcName !== null && registrySolidNames.has(funcName);
    if (funcName && (inRegistry || nameCounts.get(funcName) > 1)) {
      el.classList.add('name-clash');
      el.title = inRegistry
        ? `Exports as ${funcName}, which the engine registry already defines`
        : `Exports as ${funcName}, which another saved solid also exports`;
    }

    if (el.classList.contains('name-clash')) {
      const warning = document.createElement('span');
      warning.textContent = '!';
      warning.setAttribute('role', 'img');
      warning.setAttribute('aria-label', el.title);
      el.appendChild(warning);
    }
    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'action-btn del-btn absolute top-2 right-2 flex items-center justify-center w-5 h-5 text-sm';
    deleteButton.textContent = '×';

    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.className = 'saved-restore';
    restoreButton.disabled = !wasmModule;
    const image = document.createElement('img');
    if (typeof item.thumb === 'string' && item.thumb.startsWith('data:image/')) image.src = item.thumb;
    image.alt = '';
    const summary = document.createElement('span');
    summary.className = 'flex justify-between items-start mt-1';
    const title = document.createElement('span');
    title.className = 'title capitalize';
    title.textContent = item.title;
    const stats = document.createElement('span');
    stats.className = 'saved-stats text-[0.55rem] font-mono';
    stats.textContent = item.stats;
    summary.append(title, stats);
    const details = document.createElement('span');
    details.className = 'details block uppercase';
    details.textContent = item.desc;
    restoreButton.append(image, summary, details);

    const actions = document.createElement('div');
    actions.className = 'saved-actions';
    const actionStack = document.createElement('div');
    actionStack.className = 'flex flex-col gap-1 w-full';
    for (const [label, kind, ariaLabel] of [
      ['Recipe', 'recipe_cpp', 'Copy recipe C++'],
      ['Registry', 'registry', 'Copy registry C++'],
    ]) {
      const row = document.createElement('div');
      row.className = 'flex gap-1 justify-end';
      const rowLabel = document.createElement('span');
      rowLabel.className = 'saved-row-label text-[0.5rem] uppercase font-bold self-center mr-1';
      rowLabel.textContent = label;
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'action-btn';
      copyButton.dataset.copy = kind;
      copyButton.setAttribute('aria-label', `${ariaLabel} for ${cardName}`);
      copyButton.textContent = 'C++';
      row.append(rowLabel, copyButton);
      actionStack.appendChild(row);
    }
    actions.appendChild(actionStack);
    el.append(deleteButton, restoreButton, actions);

    restoreButton.addEventListener('click', () => restoreSolid(item));
    deleteButton.setAttribute('aria-label', `Delete ${cardName}`);
    deleteButton.addEventListener('click', () => {
      deleteSolid(index);
    });
    el.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', () => {
        copyCode(index, btn.dataset.copy, btn);
      });
    });

    list.insertBefore(el, list.firstChild); // Newest first
  });
}

function deleteSolid(index) {
  const position = savedSolids.length - index - 1;
  savedSolids.splice(index, 1);
  persistSavedSolids();
  renderSavedList();
  const rows = document.getElementById('savedList').children;
  (rows[Math.min(position, rows.length - 1)]?.querySelector('.del-btn')
    ?? document.getElementById('saveBtn'))?.focus();
}

async function copyCode(index, lang, btn) {
  const item = savedSolids[index];
  const shapeError = savedChainShapeError(item.base, item.ops);
  if (shapeError) {
    showCopyFailure(btn, `export failed: ${shapeError}`);
    return;
  }
  if (!registrySolidNames.has(item.base)) {
    showCopyFailure(btn, `export failed: unknown base solid ${item.base}`);
    return;
  }
  const baseIsStar = islamicStarPatterns.includes(item.base);

  // Namespace qualifying the seed call: Platonic bases share `Archimedean::`
  // (it `using`s Platonic); Catalan bases need their own.
  const seedNs = baseIsStar
    ? "IslamicStarPatterns"
    : (CATALAN_BASES.has(item.base) ? "Catalan" : "Archimedean");

  // A star-pattern base is not in simple_registry, so the Recipe flattens its chain.
  let code;
  try {
    if (lang === 'recipe_cpp') {
      code = generateRecipeCpp(item, seedNs);
    } else if (lang === 'registry') {
      let baseRecipe = null;
      if (baseIsStar) {
        if (!meshOpsWasm) {
          showCopyFailure(btn, 'export failed: the engine has stood down; reload to export a registry');
          return;
        }
        baseRecipe = meshOpsWasm.getRecipe(item.base);
        if (!baseRecipe) {
          showCopyFailure(btn, `export failed: no authored chain for "${item.base}" — `
            + 'its Recipe mirror cannot be generated');
          return;
        }
      }
      code = generateRegistryCpp(item, baseRecipe);
      await validateRegistryFaces(validator, item, baseRecipe);
    } else {
      console.warn("Unsupported export type.");
      return;
    }
  } catch (e) {
    if (engineTrapped(e)) return;
    showCopyFailure(btn, `export failed: ${e.message}`);
    return;
  }

  try {
    const copied = await copyWithFeedback(
      code, { element: btn, copiedClasses: ['text-green-400'],
        failedText: 'Failed', failedClasses: ['text-red-400'] });
    if (!copied) showGateMsg('copy failed: the browser refused clipboard access');
  } catch (e) {
    showCopyFailure(btn, `copy failed: ${e.message}`);
  }
}

/** Shows an export failure both beside its button and in the shared status line. */
function showCopyFailure(button, message) {
  showGateMsg(message);
  showCopyFeedback(false, { element: button, failedText: 'Failed',
    copiedClasses: ['text-green-400'], failedClasses: ['text-red-400'] });
}

function restoreSolid(item) {
  // Cards are shape-checked on load/import; also guard direct callers.
  const shapeError = queueSavedSolidRestore(item, () => queueCommit(async () => {
    // The engine may have changed limits since the save.
    const check = await chainIsValid(item.base, item.ops);
    if (!check.ok) {
      showGateMsg(`rejected: ${check.message}`);
      return;
    }
    applyRestore(item);
  }));
  if (shapeError) {
    showGateMsg(`cannot restore "${item.title || 'saved solid'}": ${shapeError}`
      + ' — delete this card and save the solid again');
  }
}

function applyRestore(item) {
  state.base = item.base;
  setOps(structuredClone(item.ops)); // Deep copy (ops are plain data)
  // A flag the card lacks lands on the page default.
  const flag = (value, fallback) => !!(value ?? fallback);
  state.showGeodesics = flag(item.geodesics, true);
  state.showFaces = flag(item.faces, true);
  state.colorizeFaces = flag(item.colorize, false);
  state.showVertices = flag(item.vertices, false);
  state.showNormals = flag(item.normals, false);
  state.showIndices = flag(item.indices, false);

  updateToggles();
  renderOps();

  // Highlight active base in footer
  highlightBaseSolid();

  update();
  renderBaseSolid();
}

function highlightBaseSolid() {
  document.querySelectorAll('.thumb-btn').forEach(b => {
    const selected = b.dataset.solid === state.base;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-checked', selected ? 'true' : 'false');
    b.tabIndex = selected ? 0 : -1;
  });
}

function renderBaseSolid() {
  const thumb = baseThumbnails[state.base];
  const title = formatSolidName(state.base);
  const image = document.getElementById('baseThumb');
  if (thumb) image.src = thumb;
  else image.removeAttribute('src');
  const titleEl = document.getElementById('baseTitle');
  titleEl.innerText = title;
  titleEl.title = title;
}

function reorderOp(from, to, revision) {
  // Ahead of the state read: a stale index can sit past the end of the list.
  if (revision !== opsRevision) return;
  if (to < 0 || to >= state.ops.length || from === to) return;
  const opName = state.ops[from].op;
  queueCommit(async () => {
    if (revision !== opsRevision) return;
    const check = await chainIsValid(state.base, movedOps(state.ops, from, to));
    if (!check.ok) {
      showGateMsg(`rejected: ${check.message}`);
      return;
    }
    // Re-derived from the live ops: param edits land outside the commit queue.
    setOps(movedOps(state.ops, from, to));
    renderOps();
    update();
    showGateMsg(`moved ${opName} to position ${to + 1}`);
    const movedItem = document.getElementById('opsList').children[to];
    const focusTarget = [...movedItem.querySelectorAll('.move-op-btn')]
      .find(button => !button.disabled);
    focusTarget?.focus();
  });
}

let dropSlotChecks = new Map();
let dropSlotGen = 0;
async function checkDropSlot(fromIndex, target) {
  if (dropSlotChecks.has(target)) return;
  const gen = dropSlotGen;
  dropSlotChecks.set(target, null);
  const to = dropTargetIndex(target, fromIndex);
  if (to === fromIndex) {
    dropSlotChecks.set(target, { ok: true, message: '' });
    return;
  }
  const check = await chainIsValid(state.base, movedOps(state.ops, fromIndex, to));
  if (gen === dropSlotGen) dropSlotChecks.set(target, check);
}

// Pointer y in the list's own coordinate space (the container is relative).
function getDragTargetIndex(e, list) {
  const listRect = list.getBoundingClientRect();
  const mouseY = e.clientY - listRect.top + list.scrollTop;
  return dropSlotIndex(mouseY, [...list.children]);
}

const DRAG_SLOP_PX = 4;

/**
 * Wires one row's reorder drag onto its grip, with the pointer captured on the grip.
 * @param {HTMLElement} grip - The row's drag handle.
 * @param {number} index - The op's position in the chain.
 * @param {HTMLElement} el - The row element.
 * @param {HTMLElement} list - The #opsList container.
 * @param {number} revision - opsRevision this row was rendered against; the
 *   queued commit drops the drag when the list has changed since.
 * @returns {void}
 */
function wireRowDrag(grip, index, el, list, revision) {
  let originY = 0;
  let dragging = false;

  const clearPreview = () => {
    el.classList.remove('dragging');
    grip.classList.remove('drop-blocked');
    for (const item of list.children) item.style.transform = '';
  };

  createPointerDrag({
    element: grip,
    onStart: (e) => {
      if (!wasmModule) return;
      originY = e.clientY;
      dragging = false;
    },
    onMove: (e) => {
      if (!wasmModule) return;
      if (!dragging) {
        if (Math.abs(e.clientY - originY) < DRAG_SLOP_PX) return;
        dragging = true;
        el.classList.add('dragging');
        dropSlotGen += 1;
        dropSlotChecks = new Map();
      }

      const targetIndex = getDragTargetIndex(e, list);
      void checkDropSlot(index, targetIndex).catch(console.error);
      const items = [...list.children];
      const draggingItem = items[index];
      if (!draggingItem) return;

      // An engine-invalid slot gets no insertion preview and no drop cursor.
      const targetCheck = dropSlotChecks.get(targetIndex);
      const blocked = targetCheck?.ok === false;
      grip.classList.toggle('drop-blocked', blocked);
      if (blocked) {
        items.forEach((item, idx) => {
          if (idx !== index) item.style.transform = '';
        });
        return;
      }

      // Amount to visual shift: height of item + gap (space-y-1 is 0.25rem = 4px)
      const shiftAmount = draggingItem.offsetHeight + 4;
      items.forEach((item, idx) => {
        if (idx === index) return;
        const shift = reorderPreviewShift(index, targetIndex, idx);
        item.style.transform = shift === 0 ? '' : `translateY(${shift * shiftAmount}px)`;
      });
    },
    onEnd: (e) => {
      if (!dragging) return;
      dragging = false;
      clearPreview();
      if (!wasmModule) return;

      const rawTarget = getDragTargetIndex(e, list);
      const toIndex = dropTargetIndex(rawTarget, index);
      if (index === toIndex) {
        renderOps();
        return;
      }
      const slotCheck = dropSlotChecks.get(rawTarget);
      if (slotCheck && !slotCheck.ok) {
        showGateMsg(`rejected: ${slotCheck.message}`);
        renderOps();
        return;
      }
      renderOps(); // snap the drag preview back
      queueCommit(async () => {
        if (revision !== opsRevision) return;
        const check = await chainIsValid(
          state.base, movedOps(state.ops, index, toIndex));
        if (!check.ok) {
          showGateMsg(`rejected: ${check.message}`);
          return;
        }
        // Re-derived from the live ops: param edits land outside the commit queue.
        setOps(movedOps(state.ops, index, toIndex));
        renderOps();
        update();
      });
    },
    onCancel: () => {
      dragging = false;
      clearPreview();
    },
  });
}

function renderOps() {
  const list = document.getElementById('opsList');
  list.replaceChildren();

  const revision = opsRevision;
  state.ops.forEach((o, i) => {
    const el = buildOpRow(o, i, {
      opDef: OP_DEFS[o.op],
      count: state.ops.length,
      on: {
        wireDrag: (grip, row) => wireRowDrag(grip, i, row, list, revision),
        move: (from, to) => reorderOp(from, to, revision),
        remove: (at) => removeOp(at, revision),
        setParam: (index, key, value) => updateOpParam(index, key, value, revision),
      },
    });

    list.appendChild(el);
  });
}

const parameterEdits = new Map();

function updateOpParam(index, key, value, revision) {
  if (revision !== opsRevision || !state.ops[index]) return;
  // Typed number inputs can bypass min/max/step; reject non-numbers and snap to the op grid.
  const def = OP_DEFS[state.ops[index].op]?.params?.[key];
  let val = parseFloat(value);
  if (Number.isNaN(val)) {
    val = state.ops[index].params[key];
  } else if (def) {
    val = snapToStep(val, def);
  }
  const editKey = `${revision}:${index}:${key}`;
  const edit = Symbol();
  parameterEdits.set(editKey, edit);
  const candidateOp = {
    op: state.ops[index].op,
    params: { ...state.ops[index].params, [key]: val },
  };

  // Sync UI elements by the row's data-key.
  const item = document.getElementById('opsList').children[index];
  const row = item && [...item.querySelectorAll('.op-param')].find(r => r.dataset.key === key);
  if (row) {
    const slider = row.querySelector('input[type="range"]');
    const input = row.querySelector('input[type="number"]');

    if (slider) slider.value = val;
    if (input) input.value = formatParamValue(val, def);
  }
  if (item) syncSweepWarning(item, candidateOp);
  const focusType = row && row.contains(document.activeElement) ? document.activeElement.type : null;

  // truncate and bevel short-circuit to ambo at t == 0.5, so a slider tick can
  // change the topology and goes through the gate.
  if (opTopologyKey(state.ops[index]) !== opTopologyKey(candidateOp)) {
    const candidate = structuredClone(state.ops);
    candidate[index] = candidateOp;
    scheduleUpdate.cancel();
    queueCommit(async () => {
      if (revision !== opsRevision || parameterEdits.get(editKey) !== edit) return;
      const check = await chainIsValid(state.base, candidate);
      if (revision !== opsRevision || parameterEdits.get(editKey) !== edit) return;
      if (check.ok) {
        state.ops[index].params[key] = val;
        update();
        return;
      }
      showGateMsg(`rejected: ${check.message}`);
      renderOps();
      if (focusType) {
        const restoredItem = document.getElementById('opsList').children[index];
        const restoredRow = [...restoredItem.querySelectorAll('.op-param')].find(r => r.dataset.key === key);
        restoredRow?.querySelector(`input[type="${focusType}"]`)?.focus();
      }
      update();
    });
    return;
  }
  state.ops[index].params[key] = val;
  scheduleUpdate();
}

const commitQueue = createCommitQueue((error) => {
  console.error(error);
  showGateMsg(`Operation failed: ${error instanceof Error ? error.message : error}`);
});
// Once the page has stood down, a commit still queued is dropped.
const queueCommit = (/** @type {() => any} */ fn) =>
  commitQueue(() => (wasmModule ? fn() : undefined));

// Row handlers reject stale membership/order revisions; parameter edits retain the revision.
let opsRevision = 0;

/** Replaces the op list and marks every render-time index stale.
 * @param {Array<{op: string, params: Object<string, number>}>} next - The new op list.
 * @returns {void} */
function setOps(next) {
  state.ops = next;
  parameterEdits.clear();
  opsRevision++;
}

function removeOp(index, revision) {
  queueCommit(async () => {
    if (revision !== opsRevision) return;
    // Removing an op can invalidate the remainder (e.g. the ambo between two hankins).
    const candidate = state.ops.filter((op, i) => i !== index);
    const check = await chainIsValid(state.base, candidate);
    if (!check.ok) {
      showGateMsg(`rejected: ${check.message}`);
      return;
    }
    setOps(candidate);
    renderOps();
    update();
    const rows = document.getElementById('opsList').children;
    (rows[Math.min(index, rows.length - 1)]?.querySelector('.remove-op-btn')
      ?? document.querySelector('#addOpGrid [data-op]:not(:disabled)'))?.focus();
  });
}

function activateAddOp(event) {
  const button = event.target.closest('[data-op]');
  if (!button) return;
  if (button.getAttribute('aria-disabled') === 'true') {
    showGateMsg(button.title);
    return;
  }
  addOp(button.dataset.op);
}

function addOp(opName) {
  // Bounds only the tool's share of a flattened star-base chain.
  if (state.ops.length >= MAX_RECIPE_STEPS) {
    showGateMsg(`rejected: a chain carries at most ${MAX_RECIPE_STEPS} ops`);
    return;
  }
  const newOp = { op: opName, params: seedOpParams(opName, currentMeshIsCurrent ? currentMesh : null) };
  queueCommit(async () => {
    // Gating is async, so validate the exact candidate.
    const check = await chainIsValid(state.base, [...state.ops, newOp]);
    if (!check.ok) {
      showGateMsg(`rejected: ${check.message}`);
      return;
    }
    setOps([...state.ops, newOp]);
    renderOps();
    update();
  });
}

function resetOps() {
  queueCommit(async () => {
    if (state.ops.length > 1 && !window.confirm(`Clear all ${state.ops.length} operations?`)) return;
    setOps([]);
    renderOps();
    update();
  });
}

function clearSavedSolids() {
  if (savedSolids.length === 0 || !window.confirm(
    `Delete all ${savedSolids.length} saved solids? This cannot be undone.`)) return;
  savedSolids.length = 0;
  persistSavedSolids();
  renderSavedList();
}

// Candidate chains are proven on a sacrificial module instance before the
// live module runs them.
const validator = createChainValidator(() => createHolosphereModule());
const { chainIsValid } = validator;
const opGate = createOpGate(validator);

let gateMsgTimer = null;
function showGateMsg(text) {
  const el = document.getElementById('opGateMsg');
  if (!el) return;
  el.innerText = text;
  clearTimeout(gateMsgTimer);
  gateMsgTimer = setTimeout(() => { el.innerText = ''; }, 3000);
}

/**
 * Re-enables every add-op button: a gate that stopped probing fails open.
 * @param {string} reason - Why the sweep stopped, shown to the user.
 * @returns {void}
 */
function openOpGate(reason) {
  if (!wasmModule) return;
  for (const btn of document.querySelectorAll('#addOpGrid [data-op]')) {
    btn.dataset.authoredDescription ??= btn.getAttribute('aria-describedby') ?? '';
    btn.removeAttribute('aria-disabled');
    if (btn.dataset.authoredDescription) btn.setAttribute('aria-describedby', btn.dataset.authoredDescription);
    else btn.removeAttribute('aria-describedby');
    btn.removeAttribute('title');
  }
  showGateMsg(`op availability is no longer checked: ${reason}`);
}

// Gray out add-op buttons whose op would be refused or trap on the current mesh.
async function refreshOpGating() {
  const buttons = [...document.querySelectorAll('#addOpGrid [data-op]')];
  const probe = await opGate.refresh(state.base, state.ops,
    buttons.map((btn) => btn.dataset.op), currentMeshIsCurrent ? currentMesh : null);
  // A pass landing after the page stood down would re-enable the frozen grid.
  if (!probe || !wasmModule) return;

  if (probe.abandoned) {
    openOpGate('the validator module will not start');
    return;
  }

  for (const btn of buttons) {
    btn.dataset.authoredDescription ??= btn.getAttribute('aria-describedby') ?? '';
    const blocked = probe.blocked.has(btn.dataset.op);
    // An incomplete pass is a lower bound; unnamed ops keep their last state.
    if (!blocked && !probe.complete) continue;
    btn.setAttribute('aria-disabled', String(blocked));
    if (blocked) {
      btn.title = document.getElementById('opBlockedReason').textContent;
      btn.setAttribute('aria-describedby', [btn.dataset.authoredDescription, 'opBlockedReason'].filter(Boolean).join(' '));
    } else {
      if (btn.dataset.authoredDescription) btn.setAttribute('aria-describedby', btn.dataset.authoredDescription);
      else btn.removeAttribute('aria-describedby');
      btn.removeAttribute('title');
    }
  }
}

// Terminal state drops engine handles and freezes editing and preview.
function standDown(message) {
  meshOpsWasm = null;
  wasmModule = null;
  scheduleUpdate.cancel();
  freezeEditing();
  showFatalError(message);
}

// Disables every control that mutates or restores the chain; export, delete and
// copy stay live.
function freezeEditing() {
  const controls = document.querySelectorAll(
    '#sidebar button, #sidebar input, #footer .thumb-btn, #savedList .saved-restore, #saveBtn');
  for (const el of controls) el.disabled = true;
}

// The live module is unrecoverable after an engine trap; fail loudly once.
function engineTrapped(e) {
  return standDownIfHalted(e, wasmModule, standDown,
    '(The op that caused this slipped past validation; please report the chain.)');
}

// Reports a mesh failure on the stats line; the next recompute overwrites it.
function showMeshError(message) {
  console.error(message);
  const statsEl = document.getElementById('meshStats');
  if (statsEl) statsEl.textContent = message;
}

function showThumbnailError(message) {
  console.error(message);
  const status = document.getElementById('thumbnailStatus');
  if (status) status.textContent = message;
}

// Assembled per call: an engine halt nulls the module handles.
function buildContext(onError = showMeshError) {
  return {
    Mod: wasmModule,
    meshOps: meshOpsWasm,
    vector: (x, y, z) => new THREE.Vector3(x, y, z),
    onError,
    onFatal: standDown,
    onTrap: engineTrapped,
  };
}

function update() {
  currentMeshIsCurrent = false;
  if (!wasmModule || !meshOpsWasm) return;

  const built = buildChainMesh(state.base, state.ops, buildContext());
  if (!built) return;

  currentMesh = built.meshData;
  currentMeshIsCurrent = true;
  currentFaceClasses = built.faceClasses;

  renderMesh();
  if (built.classifyFailure) showMeshError(built.classifyFailure);

  // The mesh changed, so which ops would now overflow changed too.
  refreshOpGating().catch((e) => {
    console.error(e);
    openOpGate('the gate sweep failed');
  });
}

function updateIndexLabelNotice(capped) {
  const notice = document.getElementById('indexLabelNotice');
  const text = capped ? `Vertex indices require fewer than ${MAX_INDEX_LABELS} vertices.` : '';
  if (notice && notice.textContent !== text) notice.textContent = text;
}

/** Rebuild the scene from cached mesh data without replaying the op chain. */
function renderMesh() {
  const meshData = currentMesh;
  if (!meshData || !meshRenderer) return;

  const { edgeCount, labelsBuilt } = meshRenderer.render(
    meshData, state, currentFaceClasses);
  if (labelsBuilt) labelsNeedReproject = true;
  updateIndexLabelNotice(state.showIndices && meshData.vertices.length >= MAX_INDEX_LABELS);

  renderBaseSolid();
  const stats = document.getElementById('meshStats');
  const statsText = meshStatsLine(meshData, edgeCount);
  if (stats.textContent !== statsText) stats.textContent = statsText;
  document.getElementById('canvas').setAttribute('aria-label',
    meshCanvasLabel(formatSolidName(state.base), state.ops.map((o) => o.op),
      meshData, edgeCount));
}

// Set when labels or viewport change, even if the camera pose is unchanged.
let labelsNeedReproject = false;
// Camera transform from the last projection; updateLabels skips unchanged frames.
const labelCam = { px: NaN, py: NaN, pz: NaN, qx: NaN, qy: NaN, qz: NaN, qw: NaN };
function labelCameraMoved() {
  const p = camera.position, q = camera.quaternion;
  if (p.x === labelCam.px && p.y === labelCam.py && p.z === labelCam.pz &&
      q.x === labelCam.qx && q.y === labelCam.qy && q.z === labelCam.qz && q.w === labelCam.qw) {
    return false;
  }
  labelCam.px = p.x; labelCam.py = p.y; labelCam.pz = p.z;
  labelCam.qx = q.x; labelCam.qy = q.y; labelCam.qz = q.z; labelCam.qw = q.w;
  return true;
}

// Scratch vector the per-frame projection reads the renderer's size into.
const labelSize = new THREE.Vector2();

// Project vertex-index labels onto the canvas after each render; guarded
// because the loop starts before init finishes.
function updateLabels() {
  if (state.showIndices && currentMesh && labelsContainer && labelsContainer.children.length > 0) {
    const moved = labelCameraMoved();
    if (!moved && !labelsNeedReproject) return;
    labelsNeedReproject = false;

    // The renderer's own size: a bounding-rect read would flush layout.
    const size = renderer.getSize(labelSize);
    const tempV = new THREE.Vector3();
    const camPos = camera.position;

    Array.from(labelsContainer.children).forEach(el => {
      const i = parseInt(el.dataset.index);
      const v = currentMesh.vertices[i];
      if (v) {
        // Backface Culling for Labels
        const dot = v.dot(camPos) - v.lengthSq();

        if (dot < 0) {
          el.style.display = 'none';
          return;
        }

        tempV.copy(v);
        tempV.project(camera);

        if (tempV.z > 1) {
          el.style.display = 'none';
        } else {
          el.style.display = 'block';
          const x = (tempV.x * size.x / 2) + size.x / 2;
          const y = -(tempV.y * size.y / 2) + size.y / 2;
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        }
      }
    });
  }
}



bootstrapTool(init, 'solids tool');
