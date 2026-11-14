/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/solids.html.
 */
import * as THREE from 'three';
import { opsFromRecipe } from './solid_op_params.js';
import { formatSolidName } from './solid_codegen.js';
import { buildBaseMesh } from './solid_build.js';
import { createMeshRenderer } from './solid_render.js';

/** @typedef {{offRenderer: THREE.WebGLRenderer, offScene: THREE.Scene, offCamera: THREE.PerspectiveCamera, mat: THREE.MeshPhongMaterial, lineMat: THREE.LineBasicMaterial, thumbRenderer: ReturnType<typeof createMeshRenderer>}} ThumbnailScene */

/** Supplies browser and thumbnail dependencies. */
function defaultDependencies() {
  return {document: globalThis.document, THREE, createMeshRenderer, buildBaseMesh,
    formatSolidName, setTimeout, window: globalThis.window, opsFromRecipe};
}

/** Creates base selection and thumbnail handlers.
 * @param {import('./solids_state.js').SolidsPage} page
 * @param {import('./solids_state.js').SolidsActions} actions
 * @param {Partial<ReturnType<typeof defaultDependencies>>} [dependencies] */
export function createSolidsBasePicker(page, actions, dependencies = {}) {
  const env = {...defaultDependencies(), ...dependencies};
  /** @param {KeyboardEvent} event - A base radio's keyboard event. */
  function handleBaseSolidKeyDown(event) {
    const delta = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1
      : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const choices = [.../** @type {NodeListOf<HTMLButtonElement>} */ (
      env.document.querySelectorAll('.thumb-btn[role="radio"]'))];
    const current = /** @type {HTMLButtonElement} */ (event.currentTarget);
    const next = choices[(choices.indexOf(current) + delta + choices.length) % choices.length];
    choices.forEach(choice => { choice.tabIndex = choice === next ? 0 : -1; });
    next.focus();
    next.click();
  }

  /** @returns {ThumbnailScene} The offscreen thumbnail scene. */
  function createThumbnailScene() {
    const width = 256;
    const height = 256;
    const offRenderer = new env.THREE.WebGLRenderer({ alpha: true, antialias: true });
    offRenderer.setSize(width, height);
    offRenderer.setClearColor(0x000000, 0);

    const offScene = new env.THREE.Scene();
    const offCamera = new env.THREE.PerspectiveCamera(45, 1, 0.1, 10);
    offCamera.position.set(1.5, 1.5, 1.5);
    offCamera.lookAt(0, 0, 0);

    const light = new env.THREE.DirectionalLight(0xffffff, 1.5);
    light.position.set(2, 5, 3);
    const ambient = new env.THREE.AmbientLight(0xffffff, 0.5);
    offScene.add(light);
    offScene.add(ambient);

    const mat = new env.THREE.MeshPhongMaterial({
      color: 0x3b82f6,
      flatShading: true,
      shininess: 30
    });
    const lineMat = new env.THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
    const thumbRenderer = env.createMeshRenderer({
      THREE: env.THREE,
      scene: offScene,
      materials: { face: mat, faceColorize: mat, edge: lineMat },
    });
    return {offRenderer, offScene, offCamera, mat, lineMat, thumbRenderer};
  }

  /** @param {AbortSignal} signal - Stops generation during teardown.
   * @returns {Promise<void>} Resolves when the thumbnails finish. */
  async function generateThumbnails(signal) {
    const baseSolids = /** @type {HTMLElement} */ (env.document.getElementById('baseSolids'));
    const starPatterns = /** @type {HTMLElement} */ (env.document.getElementById('starPatterns'));

    const thumbKeys = [...page.registry.simpleSolids, ...page.registry.islamicStarPatterns];

    const {offRenderer, offScene, offCamera, mat, lineMat, thumbRenderer} = actions.createThumbnailScene();
    const THUMB_VIEW = {
      showFaces: true,
      showGeodesics: false,
      colorizeFaces: false,
      showVertices: false,
      showNormals: false,
      showIndices: false,
    };

    try {
      for (const key of thumbKeys) {
        await /** @type {Promise<void>} */ (new Promise(resolve => env.setTimeout(resolve)));
        if (signal.aborted || !page.engine.meshOpsWasm) break;

        const meshData = env.buildBaseMesh(key, `Thumbnail for "${key}"`, actions.buildContext(actions.showThumbnailError));
        if (!meshData) continue;
        thumbRenderer.render(meshData, THUMB_VIEW, null);

        offRenderer.render(offScene, offCamera);

        const btn = env.document.createElement('button');
        actions.configureBaseSolidThumbnail(btn, key);

        const img = env.document.createElement('img');
        img.alt = '';
        const dataURL = offRenderer.domElement.toDataURL();
        img.src = dataURL;
        page.registry.baseThumbnails[key] = dataURL;

        if (key === page.doc.base) {
          /** @type {HTMLImageElement} */ (env.document.getElementById('baseThumb')).src = dataURL;
        }

        const title = env.formatSolidName(key);
        btn.title = title;
        const span = env.document.createElement('span');
        span.className = 'thumb-label';
        span.textContent = title;
        const fullName = env.document.createElement('span');
        fullName.className = 'thumb-name-full';
        fullName.setAttribute('aria-hidden', 'true');
        fullName.textContent = title;

        btn.appendChild(img);
        btn.appendChild(span);
        btn.appendChild(fullName);
        if (page.registry.islamicStarPatterns.includes(key)) {
          starPatterns.appendChild(btn);
        } else {
          baseSolids.appendChild(btn);
          actions.highlightBaseSolid();
        }

      }
    } finally {
      thumbRenderer.disposeGeometry();
      mat.dispose();
      lineMat.dispose();
      offRenderer.dispose();
      offRenderer.forceContextLoss();
    }
  }

  /**
   * Configures a base-solid radio or a star-pattern load button.
   * @param {HTMLButtonElement} btn - Thumbnail button.
   * @param {string} key - Registry solid name.
   * @returns {void}
   */
  function configureBaseSolidThumbnail(btn, key) {
    btn.type = 'button';
    btn.className = `thumb-btn ${page.doc.base === key ? 'active' : ''}`;
    if (page.registry.islamicStarPatterns.includes(key)) {
      btn.classList.add('thumb-star');
    } else {
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', page.doc.base === key ? 'true' : 'false');
      btn.tabIndex = page.doc.base === key ? 0 : -1;
      btn.addEventListener('keydown', actions.handleBaseSolidKeyDown);
    }
    btn.dataset.solid = key;
    btn.addEventListener('click', () => actions.selectBaseSolid(key, btn));
  }

  /**
   * Applies a footer thumbnail click.
   * @param {string} key - Registry name of the clicked solid.
   * @param {HTMLElement} btn - The clicked thumbnail.
   * @returns {void}
   * @details A simple solid becomes the base under the current op stack. A star
   * pattern replaces both with its authored seed and chain.
   */
  function selectBaseSolid(key, btn) {
    actions.queueCommit(async () => {
      let base = key;
      let ops = page.doc.ops;
      if (page.registry.islamicStarPatterns.includes(key)) {
        const meshOps = /** @type {NonNullable<typeof page.engine.meshOpsWasm>} */ (page.engine.meshOpsWasm);
        const recipe = meshOps.getRecipe(key);
        if (!recipe) {
          actions.showGateMsg(`rejected: "${env.formatSolidName(key)}" has no authored chain to load`);
          return;
        }
        if (page.doc.ops.length > 1 && !env.window.confirm(
          `Replace all ${page.doc.ops.length} operations with the ${env.formatSolidName(key)} chain?`)) return;
        base = recipe.seed;
        ops = /** @type {import('./solids_state.js').SolidsOp[]} */ (env.opsFromRecipe(recipe.ops));
      }
      if (ops.length) {
        const check = await actions.chainIsValid(base, ops);
        if (!check.ok) {
          actions.showGateMsg(ops === page.doc.ops
            ? `rejected: the op stack fails on this solid — ${check.message}`
            : `rejected: ${check.message}`);
          actions.highlightBaseSolid();
          if (env.document.activeElement === btn) {
            /** @type {HTMLElement|null} */ (env.document.querySelector('.thumb-btn[aria-checked="true"]'))?.focus();
          }
          return;
        }
      }
      actions.showGateMsg('');
      page.doc.base = base;
      if (ops !== page.doc.ops) {
        actions.setOps(ops);
        actions.renderOps();
      }
      actions.update();
      actions.renderBaseSolid();
      actions.highlightBaseSolid();
    });
  }

  /** Synchronizes base radio selection and the group's tab stop. */
  function highlightBaseSolid() {
    const radios = [.../** @type {NodeListOf<HTMLButtonElement>} */ (
      env.document.querySelectorAll('.thumb-btn[role="radio"]'))];
    // With no radio checked, the first radio is the group's tab stop.
    const stop = radios.find(b => b.dataset.solid === page.doc.base) ?? radios[0];
    radios.forEach(b => {
      const selected = b.dataset.solid === page.doc.base;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-checked', selected ? 'true' : 'false');
      b.tabIndex = b === stop ? 0 : -1;
    });
  }

  /** Updates the selected base's title and thumbnail. */
  function renderBaseSolid() {
    const thumb = page.registry.baseThumbnails[page.doc.base];
    const title = env.formatSolidName(page.doc.base);
    const image = /** @type {HTMLImageElement} */ (env.document.getElementById('baseThumb'));
    if (thumb) image.src = thumb;
    else image.removeAttribute('src');
    const titleEl = /** @type {HTMLElement} */ (env.document.getElementById('baseTitle'));
    titleEl.innerText = title;
    titleEl.title = title;
  }
  return { handleBaseSolidKeyDown, createThumbnailScene, generateThumbnails, configureBaseSolidThumbnail, selectBaseSolid, highlightBaseSolid, renderBaseSolid };
}
