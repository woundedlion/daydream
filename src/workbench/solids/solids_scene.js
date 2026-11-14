/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/solids.html.
 */
import * as THREE from 'three';
import { initScene } from '../shared.js';
import { formatSolidName } from './solid_codegen.js';
import { createMeshRenderer, meshStatsLine, meshCanvasLabel, MAX_INDEX_LABELS } from './solid_render.js';
import { onPageTeardown, watchMediaMatch } from '../../shared/page_lifecycle.js';
import { createPointerDrag } from '../../shared/pointer_drag.js';
import { VIEW_TOGGLES } from './solids_state.js';

/** Supplies browser and scene dependencies. */
function defaultDependencies() {
  return {initScene, watchMediaMatch, onPageTeardown, document: globalThis.document,
    createMeshRenderer, THREE, VIEW_TOGGLES, createPointerDrag, MAX_INDEX_LABELS,
    meshStatsLine, meshCanvasLabel, formatSolidName};
}

/** Creates the preview scene and view controls.
 * @param {import('./solids_state.js').SolidsPage} page
 * @param {import('./solids_state.js').SolidsActions} actions
 * @param {Partial<ReturnType<typeof defaultDependencies>>} [dependencies] */
export function createSolidsScene(page, actions, dependencies = {}) {
  const env = {...defaultDependencies(), ...dependencies};
  /** @type {THREE.MeshPhongMaterialParameters} */
  const FACE_MATERIAL_OPTIONS = {
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    flatShading: true,
    shininess: 50,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  };
  const faceMaterial = new THREE.MeshPhongMaterial({
    ...FACE_MATERIAL_OPTIONS,
    color: 0x3b82f6,
  });
  const faceColorizeMaterial = new THREE.MeshPhongMaterial({
    ...FACE_MATERIAL_OPTIONS,
    color: 0xffffff,
    vertexColors: true,
  });
  const vertMaterial = new THREE.PointsMaterial({ color: 0xa5b4fc, size: 0.05 });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
  const normalMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.8 });


  const labelCam = { px: NaN, py: NaN, pz: NaN, qx: NaN, qy: NaN, qz: NaN, qw: NaN };

  const labelSize = new THREE.Vector2();
  /** Mounts the scene and registers its teardown. */
  function mountSolidScene() {
    const result = env.initScene('canvas-container', 'canvas', {
      cameraPosition: [2, 1.5, 2],
      far: 100,
      minDistance: 0,
      maxDistance: Infinity,
      autoRotate: page.view.autoRotate,
      autoRotateSpeed: 2.0,
      lights: true,
      showSphere: false,
      onAfterRender: actions.updateLabels,
      onAfterResize: () => { page.scene.labelsNeedReproject = true; },
    });
    page.scene.scene = result.scene;
    page.scene.camera = result.camera;
    page.scene.renderer = result.renderer;
    page.scene.controls = result.controls;
    const stopWatchingReducedMotion = env.watchMediaMatch(
      page.view.reducedMotion, () => actions.setAutoRotate(false));

    env.onPageTeardown(() => {
      stopWatchingReducedMotion();
      actions.scheduleUpdate.cancel();
      page.scene.meshRenderer?.disposeGeometry();
      faceMaterial.dispose();
      faceColorizeMaterial.dispose();
      vertMaterial.dispose();
      edgeMaterial.dispose();
      normalMaterial.dispose();
      result.dispose();
    });

    actions.wireViewToggles();
    actions.wireCanvasTap(/** @type {HTMLCanvasElement} */ (env.document.getElementById('canvas')));

    page.scene.labelsContainer = env.document.getElementById('labels');
    page.scene.meshRenderer = env.createMeshRenderer({
      THREE: env.THREE,
      scene: page.scene.scene,
      materials: {
        face: faceMaterial,
        faceColorize: faceColorizeMaterial,
        vert: vertMaterial,
        edge: edgeMaterial,
        normal: normalMaterial,
      },
      labelsContainer: /** @type {HTMLElement} */ (page.scene.labelsContainer),
    });

  }

  /** Wires the authored view toggle buttons. */
  function wireViewToggles() {
    for (const [id, flag] of Object.entries(env.VIEW_TOGGLES)) {
      const toggle = flag === 'autoRotate'
        ? () => actions.setAutoRotate(!page.view.autoRotate)
        : () => {
          page.view[flag] = !page.view[flag];
          actions.updateToggles();
          actions.renderMesh();
        };
      /** @type {HTMLElement} */ (env.document.getElementById(id)).addEventListener('click', toggle);
    }
  }

  /** Synchronizes view button styling and accessibility state. */
  function updateToggles() {
    for (const [id, flag] of Object.entries(env.VIEW_TOGGLES)) {
      const btn = env.document.getElementById(id);
      if (!btn) continue;
      const on = page.view[flag];
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-checked', String(on));
    }
  }

  /** @param {boolean} on - Whether the camera rotates automatically. */
  function setAutoRotate(on) {
    page.view.autoRotate = on;
    /** @type {NonNullable<typeof page.scene.controls>} */ (page.scene.controls).autoRotate = on;
    actions.updateToggles();
  }

  /** @param {HTMLCanvasElement} canvasEl - Preview canvas. */
  function wireCanvasTap(canvasEl) {
    let x = 0, y = 0, moved = false;
    const tap = env.createPointerDrag({
      element: canvasEl,
      onStart: (event) => { x = event.clientX; y = event.clientY; moved = false; },
      onMove: (event) => { moved ||= Math.hypot(event.clientX - x, event.clientY - y) >= 5; },
      onEnd: (event) => {
        if (!moved && event && Math.hypot(event.clientX - x, event.clientY - y) < 5)
          actions.setAutoRotate(!page.view.autoRotate);
      },
      onCancel: () => {},
    });
    env.onPageTeardown(() => { tap.stop(); tap.remove(); });
  }

  /** @param {boolean} capped - Whether the vertex count suppresses index labels. */
  function updateIndexLabelNotice(capped) {
    const notice = env.document.getElementById('indexLabelNotice');
    const text = capped ? `Vertex indices require fewer than ${env.MAX_INDEX_LABELS} vertices.` : '';
    if (notice && notice.textContent !== text) notice.textContent = text;
  }

  /** Rebuild the scene from cached mesh data without replaying the op chain. */
  function renderMesh() {
    const meshData = page.mesh.currentMesh;
    if (!meshData || !page.scene.meshRenderer) return;

    const { edgeCount, labelsBuilt } = page.scene.meshRenderer.render(
      meshData, page.view, page.mesh.currentFaceClasses);
    if (labelsBuilt) page.scene.labelsNeedReproject = true;
    actions.updateIndexLabelNotice(page.view.showIndices && meshData.vertices.length >= env.MAX_INDEX_LABELS);

    actions.renderBaseSolid();
    if (!page.mesh.currentMeshIsCurrent) return;
    const stats = /** @type {HTMLElement} */ (env.document.getElementById('meshStats'));
    const statsText = page.mesh.currentClassifyFailure ?? env.meshStatsLine(meshData, edgeCount);
    if (stats.textContent !== statsText) stats.textContent = statsText;
    /** @type {HTMLCanvasElement} */ (env.document.getElementById('canvas')).setAttribute('aria-label',
      env.meshCanvasLabel(env.formatSolidName(page.doc.base), page.doc.ops.map((o) => o.op),
        meshData, edgeCount));
  }

  /** @returns {boolean} Whether the camera pose changed since the last projection. */
  function labelCameraMoved() {
    const camera = /** @type {THREE.PerspectiveCamera} */ (page.scene.camera);
    const p = camera.position, q = camera.quaternion;
    if (p.x === labelCam.px && p.y === labelCam.py && p.z === labelCam.pz &&
        q.x === labelCam.qx && q.y === labelCam.qy && q.z === labelCam.qz && q.w === labelCam.qw) {
      return false;
    }
    labelCam.px = p.x; labelCam.py = p.y; labelCam.pz = p.z;
    labelCam.qx = q.x; labelCam.qy = q.y; labelCam.qz = q.z; labelCam.qw = q.w;
    return true;
  }

  /** Reprojects vertex labels when their positions or the camera pose change. */
  function updateLabels() {
    const mesh = page.mesh.currentMesh;
    if (page.view.showIndices && mesh && page.scene.labelsContainer && page.scene.labelsContainer.children.length > 0) {
      const moved = actions.labelCameraMoved();
      if (!moved && !page.scene.labelsNeedReproject) return;
      page.scene.labelsNeedReproject = false;

      const renderer = /** @type {THREE.WebGLRenderer} */ (page.scene.renderer);
      const camera = /** @type {THREE.PerspectiveCamera} */ (page.scene.camera);
      const size = renderer.getSize(labelSize);
      const tempV = new env.THREE.Vector3();
      const camPos = camera.position;

      Array.from(page.scene.labelsContainer.children).forEach(child => {
        const el = /** @type {HTMLElement} */ (child);
        const i = parseInt(/** @type {string} */ (el.dataset.index));
        const v = mesh.vertices[i];
        if (v) {
          const dot = v.dot(camPos) - v.lengthSq();

          if (dot < 0) {
            el.style.display = 'none';
            return;
          }

          tempV.copy(/** @type {THREE.Vector3} */ (/** @type {unknown} */ (v)));
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
  return { mountSolidScene, wireViewToggles, updateToggles, setAutoRotate, wireCanvasTap, updateIndexLabelNotice, renderMesh, labelCameraMoved, updateLabels };
}
