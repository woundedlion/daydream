/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/solids.html.
 */
import * as THREE from 'three';
import { initScene, copyWithFeedback, showFatalError, bootstrapTool, formatKB } from './shared.js';
import { standDownIfHalted } from './engine_halt.js';
// The shared op table and dispatch, the pure C++ export-string codegen
// (formatFloat/pctSuffix/recipe builders), the pure face-geometry helpers and
// the op-chain queue/validator machinery live in solid_codegen.js, and the
// registry-paste generator in solid_registry_codegen.js, so they can be unit
// tested without a DOM or the WASM module. DOM/WASM wiring stays inline.
import {
  OP_DEFS,
  SAVED_SOLIDS_MAX,
  captureSavedSolidThumbnail,
  queueSavedSolidRestore,
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
// The MeshOps call sequences — base solid, op chain, classify, readback and
// the arena flush that follows each — with the module, the vertex
// constructor and the error line injected, so they are exercised against a
// stand-in module rather than only in a browser.
import { buildBaseMesh, buildChainMesh } from './solid_build.js';
import { generateRegistryCpp, MAX_RECIPE_STEPS } from './solid_registry_codegen.js';
import { buildOpRow, formatParamValue, syncSweepWarning } from './solid_op_rows.js';
// Scene construction from the JS-side mesh copy, and the stats line it
// reports; the three.js namespace, the scene and the materials below are
// passed in, so the renderer is unit tested against a stand-in namespace.
import { createMeshRenderer, meshStatsLine, meshCanvasLabel, MAX_INDEX_LABELS }
  from './solid_render.js';
import {
  createFrameScheduler, onPageTeardown, watchMediaMatch,
} from './page_lifecycle.js';
import { createPointerDrag } from './pointer_drag.js';
import { downloadBlob } from './download_file.js';

let camera, scene, renderer, controls;
let meshRenderer = null;
let labelsContainer;
let createHolosphereModule = null;

// Render materials are configuration-only and identical across updates, so
// build them once and reuse. update() rebuilds geometry every call (it
// depends on the mesh) but must not churn — or leak — a fresh material per
// recompute, which previously happened on every op-slider tick.
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

// Coalesce update() calls into one recompute per animation frame: without
// this, every op-slider pointer tick replays the entire WASM op chain (relax
// alone is up to 500 iterations) on the main thread.
const scheduleUpdate = createFrameScheduler(update);
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

// WASM Module
let wasmModule = null;
let meshOpsWasm = null;

// --- STATE ---
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

// The most recently built mesh (JS-side copy), read by the stats panel,
// index labels, and the internal-angle helper. Module-scoped — every reader
// lives in this script (the window.* handlers below close over it), so it
// needs no global.
let currentMesh = null;
// Per-face topology class ids for the Colorize Faces toggle, cached from the
// last recompute. classifyFaces() needs the live WASM mesh, which update()
// frees, so we compute it once per recompute and reuse it when renderMesh()
// redraws after a presentation-only toggle.
let currentFaceClasses = null;

// Lists (populated from WASM)
let simpleSolids = [];
let islamicStarPatterns = [];
// Every name the engine registry already defines. A generated funcName equal
// to one of these is a redefinition once the C++ is pasted into solids.h.
// Empty until the registry loads, which leaves the saved-set check alone.
let registrySolidNames = new Set();

// Initialize
async function init() {
  // Load WASM
  try {
    ({ default: createHolosphereModule } = await import('../holosphere_wasm.js'));
    wasmModule = await createHolosphereModule();
    meshOpsWasm = wasmModule.MeshOps;
    console.log('WASM Module Loaded');

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

  // Start Memory Metrics Loop. Keep the timer handle so teardown can cancel
  // the self-rescheduling loop.
  let arenaMetricsTimer = null;
  function updateArenaMetrics() {
    // The engine nulls meshOpsWasm on halt; stop rather than reschedule forever.
    if (!meshOpsWasm) return;
    const m = meshOpsWasm.getArenaMetrics();
    // Peak over the module's life: every build ends in clearToolingMemory(),
    // which zeroes the windowed high_water_mark before the next poll reads it.
    const fmt = (x) => `${formatKB(x.lifetime_high_water_mark, 0)} / ${formatKB(x.capacity, 0)}KB`;
    const statsEl = document.getElementById('arenaStats');
    if (statsEl) {
      statsEl.innerText = `${fmt(m.tooling_arena)}`;
    }
    arenaMetricsTimer = setTimeout(updateArenaMetrics, 500); // 2fps update is enough
  }
  onPageTeardown(() => {
    if (arenaMetricsTimer !== null) { clearTimeout(arenaMetricsTimer); arenaMetricsTimer = null; }
  });
  updateArenaMetrics();

  // Initialize Three.js. The shared scaffold supplies the renderer / camera /
  // OrbitControls / resize / animation loop; the solids-specific bits (auto-
  // rotate, transparent buffer, light rig, free-zoom range, and the per-frame
  // index-label projection) are passed as options. Resize uses the scaffold's
  // default (canvas-container clientWidth) — a window-relative override
  // subtracting both sidebar widths went negative once the ≤640px layout
  // stacks the sidebars at width:100%.
  const result = initScene('canvas-container', 'canvas', {
    cameraPosition: [2, 1.5, 2],
    far: 100,
    minDistance: 0,
    maxDistance: Infinity,
    alpha: true,
    autoRotate: state.autoRotate,
    autoRotateSpeed: 2.0,
    lights: true,
    showSphere: false,
    onAfterRender: updateLabels,
  });
  scene = result.scene;
  camera = result.camera;
  renderer = result.renderer;
  controls = result.controls;
  const stopWatchingReducedMotion = watchMediaMatch(
    reducedMotion, () => setAutoRotate(false));

  // The scaffold's dispose() stops the render loop and detaches the resize
  // listener; cancelling the pending frame keeps a queued recompute from
  // running against the disposed scene.
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

  // Toggles
  // These toggles change only how the cached mesh is presented, so they
  // redraw via renderMesh() instead of update() — no WASM op-chain replay.
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

  // Canvas taps mirror the visible switch; orbit drags and secondary pointers
  // leave it unchanged.
  const canvasEl = document.getElementById('canvas');
  let pointerDownX = 0, pointerDownY = 0;
  canvasEl.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary) return;
    pointerDownX = e.clientX;
    pointerDownY = e.clientY;
  });
  canvasEl.addEventListener('pointerup', (e) => {
    if (!e.isPrimary) return;
    if (Math.hypot(e.clientX - pointerDownX, e.clientY - pointerDownY) < 5) {
      setAutoRotate(!state.autoRotate);
    }
  });

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

  // Static control buttons — wired here rather than via inline onclick so
  // their handlers stay module-scoped (no window.* globals). The add-op grid
  // uses one delegated listener that reads the clicked button's data-op
  // (closest() so a click on a tooltip span still resolves the button).
  document.getElementById('clearOpsBtn').addEventListener('click', resetOps);
  document.getElementById('exportSavedBtn').addEventListener('click', exportSavedSolids);
  document.getElementById('clearSavedBtn').addEventListener('click', clearSavedSolids);
  document.getElementById('addOpGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-op]');
    if (btn) addOp(btn.dataset.op);
  });

  generateThumbnails().catch(e => {
    if (engineTrapped(e)) return;
    console.error('Thumbnail generation failed:', e);
  });

  renderSavedList();
  updateToggles();
  update();
  renderBaseSolid();
}

async function generateThumbnails() {
  const footer = document.getElementById('footer');

  // Gather all solid names from exported lists
  const thumbKeys = [...simpleSolids, ...islamicStarPatterns];

  // Create offscreen renderer
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
      // Yield to the event loop before each solid. Each iteration is a full
      // WASM build + triangulation + WebGL render + toDataURL — heavy enough
      // that running the whole list synchronously froze first paint and input
      // during init(). Deferring each to its own macrotask lets the page paint
      // and stay responsive while the footer fills in progressively; this is
      // why generateThumbnails() is async and init() deliberately does not
      // await it.
      await new Promise(resolve => setTimeout(resolve));

      // Reset to just the lights; the previous iteration's mesh/lines are
      // detached here and their GPU buffers freed at the end of the loop body.
      offScene.clear();
      offScene.add(light);
      offScene.add(ambient);

      const meshData = buildBaseMesh(key, `Thumbnail for "${key}"`, buildContext());
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

      // Edges (optional, but looks nice)
      const linePoints = [];
      for (const [ai, bi] of uniqueEdges(meshData.faces, meshData.vertices.length)) {
        linePoints.push(meshData.vertices[ai], meshData.vertices[bi]);
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePoints);
      const lines = new THREE.LineSegments(lineGeo, lineMat);
      offScene.add(lines);

      // Render
      offRenderer.render(offScene, offCamera);

      // Create Button
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `thumb-btn ${state.base === key ? 'active' : ''}`;
      btn.setAttribute('aria-pressed', state.base === key ? 'true' : 'false');
      btn.dataset.solid = key; // identify the base so restoreSolid can re-highlight it
      btn.addEventListener('click', () => {
        queueCommit(async () => {
          // The op stack is kept across a base switch, so it must be valid
          // on the new solid too.
          if (state.ops.length) {
            const check = await chainIsValid(key, state.ops);
            if (!check.ok) {
              showGateMsg(`rejected: the op stack fails on this solid — ${check.message}`);
              return;
            }
          }
          state.base = key;
          update();
          renderBaseSolid();
          // Update active state
          document.querySelectorAll('.thumb-btn').forEach(b => {
            const selected = b === btn;
            b.classList.toggle('active', selected);
            b.setAttribute('aria-pressed', selected ? 'true' : 'false');
          });
        });
      });

      const img = document.createElement('img');
      img.alt = '';
      const dataURL = offRenderer.domElement.toDataURL();
      img.src = dataURL;
      baseThumbnails[key] = dataURL;

      // init() now renders the base preview before this (deferred) loop has
      // produced its thumbnail, so refresh it the moment its own thumb exists
      // rather than leaving the preview blank until the next selection.
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
      fullName.textContent = title;

      btn.appendChild(img);
      btn.appendChild(span);
      btn.appendChild(fullName);
      footer.appendChild(btn);

      // Free the per-iteration geometry GPU buffers; the thumbnail image is
      // already captured into dataURL above.
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
  // Each toggle's on/off look is driven by the shared `.toggle-switch.is-on`
  // CSS (tools.css), so syncing state is just toggling that one class.
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

// --- SAVED ITEMS ---
const SAVED_SOLIDS_KEY = 'daydream.savedSolids.v1';
const SAVED_THUMB_SIZE = 256;
function loadSavedSolids() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_SOLIDS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('Could not restore saved solids:', error);
    return [];
  }
}

const savedSolids = loadSavedSolids();

function persistSavedSolids() {
  try {
    localStorage.setItem(SAVED_SOLIDS_KEY, JSON.stringify(savedSolids));
  } catch (error) {
    console.warn('Could not persist saved solids:', error);
    showGateMsg('saved for this session only: browser storage refused the write');
  }
}

function exportSavedSolids() {
  const blob = new Blob([JSON.stringify(savedSolids, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(document, blob, 'daydream-solids.json');
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
  // Nothing to save until the first successful update() has produced a mesh
  // (clicking save before then would dereference an undefined currentMesh).
  if (!currentMesh) return;

  // A base with no ops has no exportable recipe: its generated function
  // would be named after the seed and call itself.
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

  // Get current counts from currentMesh. Derive the edge count directly from
  // the faces (not currentMesh.edgeCount, which is only set on a successful
  // renderMesh pass — after a failed op chain it would be stale/0).
  const vCount = currentMesh.vertices.length;
  const fCount = currentMesh.faces.length;
  const eCount = uniqueEdges(currentMesh.faces, vCount).length;
  let iCount = 0;
  currentMesh.faces.forEach(f => iCount += f.length);

  // Generate summary
  const opsSummary = state.ops.map(o => {
    if (o.op === 'truncate') return `Tr(${o.params.t})`;
    if (o.op === 'hankin') return `Hk(${o.params.angle.toFixed(2)})`;
    return o.op.charAt(0).toUpperCase() + o.op.slice(1);
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

  // Report a funcName collision rather than letting it overwrite silently:
  // generateFuncAndRecipe encodes op params at coarse granularity (pctSuffix
  // to 0.01, hankin to 1 deg), so two near-identical solids can share a
  // funcName and the later C++ paste would clobber the earlier definition.
  // The engine registry is the other half: a chain whose name matches an
  // entry solids.h already carries redefines it at paste time.
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

// The C++ function name a saved item exports as, or null when it can't be
// generated — generateFuncAndRecipe only throws on an invalid base/op, which
// the registry-backed state should never produce.
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

  // Two cards with the same funcName export definitions that overwrite each
  // other, so flag every member of a colliding set, not just the newest. A
  // name the engine registry already holds is flagged the same way.
  const nameCounts = new Map();
  savedSolids.forEach(item => {
    const name = savedFuncName(item);
    if (name) nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  });

  savedSolids.forEach((item, index) => {
    const el = document.createElement('div');
    el.className = 'saved-item relative pr-6';
    const funcName = savedFuncName(item);
    const inRegistry = funcName !== null && registrySolidNames.has(funcName);
    if (funcName && (inRegistry || nameCounts.get(funcName) > 1)) {
      el.classList.add('name-clash');
      el.title = inRegistry
        ? `Exports as ${funcName}, which the engine registry already defines`
        : `Exports as ${funcName}, which another saved solid also exports`;
    }

    const deleteButton = document.createElement('button');
    deleteButton.type = 'button';
    deleteButton.className = 'action-btn del-btn absolute top-2 right-2 flex items-center justify-center w-5 h-5 text-sm';
    deleteButton.textContent = '×';

    const restoreButton = document.createElement('button');
    restoreButton.type = 'button';
    restoreButton.className = 'saved-restore';
    const image = document.createElement('img');
    image.src = item.thumb;
    image.alt = '';
    const summary = document.createElement('span');
    summary.className = 'flex justify-between items-start mt-1';
    const title = document.createElement('span');
    title.className = 'title capitalize';
    title.textContent = item.title;
    const stats = document.createElement('span');
    stats.className = 'text-[0.55rem] font-mono text-indigo-400 opacity-60';
    stats.textContent = item.stats;
    summary.append(title, stats);
    const details = document.createElement('span');
    details.className = 'details block uppercase opacity-70';
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
      rowLabel.className = 'text-[0.5rem] uppercase text-slate-500 font-bold self-center mr-1';
      rowLabel.textContent = label;
      const copyButton = document.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'action-btn';
      copyButton.dataset.copy = kind;
      copyButton.setAttribute('aria-label', ariaLabel);
      copyButton.textContent = 'C++';
      row.append(rowLabel, copyButton);
      actionStack.appendChild(row);
    }
    actions.appendChild(actionStack);
    el.append(deleteButton, restoreButton, actions);

    restoreButton.addEventListener('click', () => restoreSolid(item));
    deleteButton.setAttribute('aria-label', `Delete ${item.title}`);
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

// These handlers are module-scoped and bound via addEventListener where the
// generated markup needs them (saved-solids cards and op-chain rows), so no
// function is pinned to window. Keep new handlers wired the same way.
function deleteSolid(index) {
  savedSolids.splice(index, 1);
  persistSavedSolids();
  renderSavedList();
}

async function copyCode(index, lang, btn) {
  const item = savedSolids[index];
  const baseIsStar = islamicStarPatterns.includes(item.base);

  // Namespace of the seed, which the emitted recipe calls. Archimedean and
  // Platonic bases share the `Archimedean::` qualifier (it `using`s
  // Platonic); Catalan bases need their own. The result can land in a
  // different namespace than its seed, so this qualifies the seed only.
  const seedNs = baseIsStar
    ? "IslamicStarPatterns"
    : (CATALAN_BASES.has(item.base) ? "Catalan" : "Archimedean");

  // A star-pattern base is not in simple_registry, so the emitted Recipe
  // has to flatten against the base's own authored chain.
  let baseRecipe = null;
  if (baseIsStar) {
    baseRecipe = meshOpsWasm ? meshOpsWasm.getRecipe(item.base) : null;
    if (!baseRecipe) {
      showGateMsg(`export failed: no authored chain for "${item.base}" — `
        + 'its Recipe mirror cannot be generated');
      return;
    }
  }

  let code;

  try {
    if (lang === 'recipe_cpp') {
      code = generateRecipeCpp(item, seedNs);
    } else if (lang === 'registry') {
      code = generateRegistryCpp(item, baseRecipe);
    } else {
      console.warn("Unsupported export type.");
      return;
    }
  } catch (e) {
    showGateMsg(`export failed: ${e.message}`);
    return;
  }

  try {
    const copied = await copyWithFeedback(
      code, { element: btn, copiedClasses: ['text-green-400'] });
    if (!copied) showGateMsg('copy failed: the browser refused clipboard access');
  } catch (e) {
    showGateMsg(`copy failed: ${e.message}`);
  }
}

function restoreSolid(item) {
  // localStorage is user-writable and its entries outlive any op-table
  // change, so the shape is checked against OP_DEFS before anything is
  // touched. The engine validator cannot stand in for this: it answers true
  // when its module fails to spawn, and an unrecognized op would then reach
  // renderOps as an undefined OP_DEFS entry and throw into the commit
  // queue's error handler, leaving the page showing the previous chain.
  const shapeError = queueSavedSolidRestore(item, () => queueCommit(async () => {
    // Saved items were valid when saved, but the engine may have been
    // rebuilt with different limits since; validate on the way back in.
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
  // A card saved before a flag existed carries none, and lands on the page's
  // own default for it rather than off.
  const flag = (value, fallback) => !!(value ?? fallback);
  state.showGeodesics = flag(item.geodesics, true);
  state.showFaces = flag(item.faces, true);
  state.colorizeFaces = flag(item.colorize, false);
  state.showVertices = flag(item.vertices, false);
  state.showNormals = flag(item.normals, false);
  state.showIndices = flag(item.indices, false);

  // Update UI
  updateToggles();
  renderOps();

  // Highlight active base in footer
  document.querySelectorAll('.thumb-btn').forEach(b => {
    const selected = b.dataset.solid === state.base;
    b.classList.toggle('active', selected);
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });

  update();
  renderBaseSolid();
}

function renderBaseSolid() {
  const thumb = baseThumbnails[state.base];
  const title = formatSolidName(state.base);
  document.getElementById('baseThumb').src = thumb || '';
  const titleEl = document.getElementById('baseTitle');
  titleEl.innerText = title;
  titleEl.title = title;
}

function reorderOp(from, to, revision) {
  // Ahead of the state read: a stale index can sit past the end of a list a
  // landed commit shrank.
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
    // Re-derived from the live ops: a param edit lands outside the commit
    // queue, so a clone taken before the await would drop it.
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

// The chainIsValid verdict for each raw drop slot (getDragTargetIndex
// value) of the op being dragged, so a blocked slot can name its reason.
// Filled asynchronously from dragstart; slots still pending hold no entry
// and stay droppable — the drop re-validates authoritatively before
// committing.
let dropSlotChecks = new Map();
let dropSlotGen = 0;
async function precomputeDropSlots(fromIndex) {
  const gen = ++dropSlotGen;
  dropSlotChecks = new Map();
  for (let t = 0; t <= state.ops.length; t++) {
    const to = dropTargetIndex(t, fromIndex);
    if (to === fromIndex) { dropSlotChecks.set(t, { ok: true, message: '' }); continue; }
    const check = await chainIsValid(state.base, movedOps(state.ops, fromIndex, to));
    if (gen !== dropSlotGen) return;
    dropSlotChecks.set(t, check);
  }
}

// Pointer y in the list's own coordinate space, which dropSlotIndex compares
// against each item's offsetTop (correct because the container is relative).
function getDragTargetIndex(e, list) {
  const listRect = list.getBoundingClientRect();
  const mouseY = e.clientY - listRect.top + list.scrollTop;
  return dropSlotIndex(mouseY, [...list.children]);
}

// Travel that separates a reorder drag from a press on the grip, replacing
// the threshold the browser used to apply before firing dragstart.
const DRAG_SLOP_PX = 4;

/**
 * Wires one row's reorder drag onto its grip. The pointer is captured on the
 * grip, so mouse, pen and touch share one path, a press that never travels
 * leaves no state behind, and a gesture the system takes away arrives as a
 * cancel rather than stranding the row.
 * @param {HTMLElement} grip - The row's drag handle.
 * @param {number} index - The op's position in the chain.
 * @param {HTMLElement} el - The row element.
 * @param {HTMLElement} list - The #opsList container.
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
      originY = e.clientY;
      dragging = false;
    },
    onMove: (e) => {
      if (!dragging) {
        if (Math.abs(e.clientY - originY) < DRAG_SLOP_PX) return;
        dragging = true;
        el.classList.add('dragging');
        precomputeDropSlots(index).catch(console.error);
      }

      const targetIndex = getDragTargetIndex(e, list);
      const items = [...list.children];
      const draggingItem = items[index];
      if (!draggingItem) return;

      // An engine-invalid slot gets no insertion preview and no drop cursor.
      const targetCheck = dropSlotChecks.get(targetIndex);
      const blocked = Boolean(targetCheck && !targetCheck.ok);
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
      renderOps(); // snap the drag preview back now; the commit re-renders
      queueCommit(async () => {
        if (revision !== opsRevision) return;
        const check = await chainIsValid(
          state.base, movedOps(state.ops, index, toIndex));
        if (!check.ok) {
          showGateMsg(`rejected: ${check.message}`);
          return;
        }
        // Re-derived from the live ops: a param edit lands outside the
        // commit queue, so a clone taken before the await would drop it.
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
        setParam: updateOpParam,
      },
    });

    list.appendChild(el);
  });
}

function updateOpParam(index, key, value) {
  // Snap onto the op's step grid (which also clamps to its range) and reject
  // non-numeric input before it reaches state — the number box carries
  // neither bounds nor grid, and the WASM mesh boundary is deliberately
  // fail-fast, so an out-of-range or NaN value typed here could kill the
  // page or produce garbage geometry, and an off-grid one would export a
  // coefficient no control ever shows. The grid also keeps integral-step
  // params (e.g. relax's iter) whole, as their count-typed C++ args demand.
  // On a bad value, fall back to the current value (the sync below restores
  // the UI).
  const def = OP_DEFS[state.ops[index].op]?.params?.[key];
  let val = parseFloat(value);
  if (Number.isNaN(val)) {
    val = state.ops[index].params[key];
  } else if (def) {
    val = snapToStep(val, def);
  }
  const previous = state.ops[index].params[key];
  state.ops[index].params[key] = val;

  // Sync UI elements. The row's data-key names the param it drives, so the
  // state object's key order need not match OP_DEFS'.
  const item = document.getElementById('opsList').children[index];
  const row = item && [...item.querySelectorAll('.op-param')].find(r => r.dataset.key === key);
  if (row) {
    const slider = row.querySelector('input[type="range"]');
    const input = row.querySelector('input[type="number"]');

    if (slider) slider.value = val;
    if (input) input.value = formatParamValue(val, def);
  }
  if (item) syncSweepWarning(item, state.ops[index]);

  // truncate and bevel short-circuit to ambo at t == 0.5, so a slider tick can
  // change the element census the way adding an op does. That crossing goes
  // through the gate like any other mutation: the live module is the page's
  // only one, and a trap on it costs a reload.
  const before = {
    op: state.ops[index].op,
    params: { ...state.ops[index].params, [key]: previous },
  };
  if (opTopologyKey(before) !== opTopologyKey(state.ops[index])) {
    scheduleUpdate.cancel();
    queueCommit(async () => {
      const check = await chainIsValid(state.base, state.ops);
      if (check.ok) {
        update();
        return;
      }
      showGateMsg(`rejected: ${check.message}`);
      if (state.ops[index]?.params?.[key] === val) {
        state.ops[index].params[key] = previous;
        renderOps();
      }
    });
    return;
  }
  scheduleUpdate();
}

const queueCommit = createCommitQueue();

// Bumped whenever the op list's membership or order changes. Row handlers close
// over the revision that built them, and a commit queued ahead of one of them
// can change the list before it runs -- at which point its render-time index
// names a different op. Rejecting the stale index is what keeps a second click
// during an in-flight gating sweep from moving or deleting whatever op now
// occupies that slot; a param edit leaves the list alone and does not bump it.
let opsRevision = 0;

/** Replaces the op list and marks every render-time index stale.
 * @param {Array<{op: string, params: Object<string, number>}>} next - The new op list.
 * @returns {void} */
function setOps(next) {
  state.ops = next;
  opsRevision++;
}

function removeOp(index, revision) {
  queueCommit(async () => {
    if (revision !== opsRevision) return;
    // Removing an op can invalidate the remainder (e.g. deleting the ambo
    // between two hankins), so removal validates like any other mutation.
    const candidate = state.ops.filter((op, i) => i !== index);
    const check = await chainIsValid(state.base, candidate);
    if (!check.ok) {
      showGateMsg(`rejected: ${check.message}`);
      return;
    }
    setOps(candidate);
    renderOps();
    update();
  });
}

function addOp(opName) {
  // A star base contributes its own authored steps on export, so this only
  // bounds the tool's share of the flattened chain; generateRegistryCpp
  // holds the real ceiling.
  if (state.ops.length >= MAX_RECIPE_STEPS) {
    showGateMsg(`rejected: a chain carries at most ${MAX_RECIPE_STEPS} ops`);
    return;
  }
  const newOp = { op: opName, params: seedOpParams(opName, currentMesh) };
  queueCommit(async () => {
    // The grid button is usually grayed before an invalid op can be
    // clicked, but gating is async — validate the exact candidate anyway.
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
    setOps([]);
    renderOps();
    update();
  });
}

function clearSavedSolids() {
  savedSolids.length = 0;
  persistSavedSolids();
  renderSavedList();
}

// --- CHAIN VALIDATION ---
// Candidate chains are proven on a sacrificial module instance before the
// live module runs them; see createChainValidator in solid_codegen.js.
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
 * Re-enables every add-op button. No later pass revises a verdict the gate
 * stopped probing for, so an unchecked gate fails open rather than stranding
 * whatever the last complete pass disabled for the rest of the session.
 * @param {string} reason - Why the sweep stopped, shown to the user.
 * @returns {void}
 */
function openOpGate(reason) {
  for (const btn of document.querySelectorAll('#addOpGrid [data-op]')) {
    btn.disabled = false;
    btn.removeAttribute('title');
  }
  showGateMsg(`op availability is no longer checked: ${reason}`);
}

// Gray out add-op buttons whose op would trap on the CURRENT mesh; the
// sweep itself is createOpGate in solid_codegen.js.
async function refreshOpGating() {
  const buttons = [...document.querySelectorAll('#addOpGrid [data-op]')];
  const probe = await opGate.refresh(state.base, state.ops,
    buttons.map((btn) => btn.dataset.op), currentMesh);
  if (!probe) return;

  if (probe.abandoned) {
    openOpGate('the validator module will not start');
    return;
  }

  for (const btn of buttons) {
    const blocked = probe.blocked.has(btn.dataset.op);
    // An incomplete pass names only a lower bound on what would trap, so an
    // op it does not name stays where the last complete pass left it.
    if (!blocked && !probe.complete) continue;
    btn.disabled = blocked;
    if (blocked) btn.title = 'Would exceed an engine mesh limit on the current solid';
    else btn.removeAttribute('title');
  }
}

// Drops the module handles and puts the page in its terminal state: every
// gate reads them, so nothing calls the engine again, and the banner stays up
// rather than being overwritten by the next recompute.
function standDown(message) {
  meshOpsWasm = null;
  wasmModule = null;
  showFatalError(message);
}

// The live module is unrecoverable after an engine trap (see update()); if
// one ever escapes the validator gate, fail loudly once instead of letting
// every later call trap the re-entrancy guard and spam the console.
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

// The live wiring one build runs against, assembled per call: an engine halt
// nulls the module handles, so a context must not outlive a build.
function buildContext() {
  return {
    Mod: wasmModule,
    meshOps: meshOpsWasm,
    vector: (x, y, z) => new THREE.Vector3(x, y, z),
    onError: showMeshError,
    onFatal: standDown,
    onTrap: engineTrapped,
  };
}

function update() {
  if (!wasmModule || !meshOpsWasm) return;

  const built = buildChainMesh(state.base, state.ops, buildContext());
  if (!built) return;

  // Cached alongside the mesh so toggling Colorize redraws from currentMesh
  // without replaying the whole WASM chain.
  currentMesh = built.meshData;
  currentFaceClasses = built.faceClasses;

  renderMesh();
  if (built.classifyFailure) showMeshError(built.classifyFailure);

  // The mesh changed, so which ops would now overflow changed too.
  refreshOpGating().catch((e) => {
    console.error(e);
    openOpGate('the gate sweep failed');
  });
}

// Rebuild the THREE scene from the cached currentMesh + currentFaceClasses,
// WITHOUT re-running the WASM op chain. update() calls this after a
// recompute; presentation-only toggles (faces/verts/normals/indices/
// colorize/geodesics) call it directly so they don't pay for the chain
// (relax alone runs up to 500 iterations) when only the view changed.
function renderMesh() {
  const meshData = currentMesh;
  if (!meshData || !meshRenderer) return;

  const { edgeCount, labelsBuilt } = meshRenderer.render(
    meshData, state, currentFaceClasses);
  // Flag the freshly-created labels for re-projection so updateLabels
  // positions them on the next frame. The toggle stays engaged when the
  // mesh is past the label cap, so say why nothing appeared.
  if (labelsBuilt) labelsNeedReproject = true;
  else if (state.showIndices && meshData.vertices.length >= MAX_INDEX_LABELS) {
    showGateMsg(`Vertex indices are off past ${MAX_INDEX_LABELS} vertices; `
      + `this mesh has ${meshData.vertices.length}.`);
  }

  // Update Stats
  renderBaseSolid();
  document.getElementById('meshStats').innerText = meshStatsLine(meshData, edgeCount);
  document.getElementById('canvas').setAttribute('aria-label',
    meshCanvasLabel(formatSolidName(state.base), state.ops.map((o) => o.op),
      meshData, edgeCount));
}

// Set true whenever the label set is (re)built, so updateLabels re-projects
// it once even if the camera happens not to have moved that frame.
let labelsNeedReproject = false;
// Cached camera transform from the last projection — lets updateLabels skip
// the ~1000-label loop on frames where the camera is identical (autorotate
// paused and no user input). During autorotation the camera changes every
// frame, so the loop runs as before.
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

// Project vertex-index labels onto the canvas. Runs each frame after the
// render (via initScene's onAfterRender hook), so the labels track the
// current camera; guarded because the loop starts before init finishes.
function updateLabels() {
  if (state.showIndices && currentMesh && labelsContainer && labelsContainer.children.length > 0) {
    // Nothing to do when neither the camera nor the label set changed since
    // the last projection. (A canvas resize without camera motion is the one
    // gap; autorotate — on by default — refreshes positions within a frame.)
    const moved = labelCameraMoved();
    if (!moved && !labelsNeedReproject) return;
    labelsNeedReproject = false;

    const rect = renderer.domElement.getBoundingClientRect();
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

        // Check if behind camera frustum (NDC z)
        if (tempV.z > 1) {
          el.style.display = 'none';
        } else {
          el.style.display = 'block';
          const x = (tempV.x * rect.width / 2) + rect.width / 2;
          const y = -(tempV.y * rect.height / 2) + rect.height / 2;
          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        }
      }
    });
  }
}



bootstrapTool(init, 'solids tool');
