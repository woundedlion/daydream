/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/solids.html.
 */
import * as THREE from 'three';
import { showFatalError, formatKB } from '../shared.js';
import { standDownIfHalted } from '../../shared/engine_halt.js';
import { buildChainMesh } from './solid_build.js';

/** Supplies browser and engine dependencies. */
function defaultDependencies() {
  return {console, showFatalError, setTimeout, document: globalThis.document,
    formatKB, standDownIfHalted, THREE, buildChainMesh};
}

/** Creates the engine lifecycle and mesh build handlers.
 * @param {import('./solids_state.js').SolidsPage} page
 * @param {import('./solids_state.js').SolidsActions} actions
 * @param {Partial<ReturnType<typeof defaultDependencies>>} [dependencies] */
export function createSolidsEngine(page, actions, dependencies = {}) {
  const env = {...defaultDependencies(), ...dependencies};
  /** @returns {Promise<boolean>} Whether the engine registry loaded. */
  async function initializeSolidEngine() {
    try {
      ({ default: page.engine.createHolosphereModule } = await import('../../../generated/holosphere_wasm.js'));
      page.engine.wasmModule = await page.engine.createHolosphereModule();
      page.engine.meshOpsWasm = page.engine.wasmModule.MeshOps;

      const registry = page.engine.meshOpsWasm.getRegistry();
      page.registry.simpleSolids = [];
      page.registry.islamicStarPatterns = [];
      page.registry.registrySolidNames = new Set();

      for (let i = 0; i < registry.length; i++) {
        const item = registry[i];
        const name = item.name;
        const cat = item.category;

        page.registry.registrySolidNames.add(name);
        if (cat === "Complex") {
          page.registry.islamicStarPatterns.push(name);
        } else {
          page.registry.simpleSolids.push(name);
        }
      }

    } catch (e) {
      env.console.error('Failed to load WASM:', e);
      env.showFatalError('Failed to load the Holosphere WASM engine — the solids '
        + 'tool needs the built holosphere_wasm artifacts. Build the WASM '
        + 'target and reload.');
      return false;
    }

    return true;
  }

  /** Updates the arena statistics and schedules the next sample. */
  function updateArenaMetrics() {
    if (!page.engine.meshOpsWasm) return;
    page.engine.arenaMetricsTimer = null;
    try {
      const m = page.engine.meshOpsWasm.getArenaMetrics();
      /** @param {{lifetime_high_water_mark: number, capacity: number}} x */
      const fmt = (x) => `${env.formatKB(x.lifetime_high_water_mark, 0)} / ${env.formatKB(x.capacity, 0)}KB`;
      const statsEl = env.document.getElementById('arenaStats');
      if (statsEl) {
        statsEl.innerText = `Live ${fmt(m.tooling_arena)} · `
          + `Scratch A ${fmt(m.tooling_scratch_a)} · Scratch B ${fmt(m.tooling_scratch_b)}`;
      }
    } catch (error) {
      if (actions.engineTrapped(error)) return;
      env.console.warn('Arena metrics unavailable:', error);
    }
    page.engine.arenaMetricsTimer = env.setTimeout(updateArenaMetrics, 500);
  }

  /** @param {string} message - Fatal engine failure. */
  function standDown(message) {
    page.engine.meshOpsWasm = null;
    page.engine.wasmModule = null;
    actions.scheduleUpdate.cancel();
    actions.freezeEditing();
    env.showFatalError(message);
  }

  /** Disables controls that mutate or restore the chain. */
  function freezeEditing() {
    const controls = env.document.querySelectorAll(
      '#sidebar button, #sidebar input, #footer .thumb-btn, #savedList .saved-restore, #saveBtn');
    for (const el of controls) /** @type {HTMLButtonElement|HTMLInputElement} */ (el).disabled = true;
  }

  /** @param {unknown} e @returns {boolean} Whether the engine halted. */
  function engineTrapped(e) {
    const module = /** @type {(import('./solids_state.js').WasmModule & {HS_MODULE_DEAD?: boolean})|null} */ (page.engine.wasmModule);
    return env.standDownIfHalted(e, module, actions.standDown,
      '(The op that caused this slipped past validation; please report the chain.)');
  }

  /** @param {string} message - Mesh build failure. */
  function showMeshError(message) {
    env.console.error(message);
    const statsEl = env.document.getElementById('meshStats');
    if (statsEl) statsEl.textContent = message;
  }

  /** @param {string} message - Thumbnail build failure. */
  function showThumbnailError(message) {
    env.console.error(message);
    const status = env.document.getElementById('thumbnailStatus');
    if (status) status.textContent = message;
  }

  /** @param {(message: string) => void} [onError]
   * @returns {import('./solid_build.js').MeshBuildContext} Live build dependencies. */
  function buildContext(onError = actions.showMeshError) {
    return {
      Mod: /** @type {NonNullable<typeof page.engine.wasmModule>} */ (page.engine.wasmModule),
      meshOps: /** @type {NonNullable<typeof page.engine.meshOpsWasm>} */ (page.engine.meshOpsWasm),
      vector: (x, y, z) => /** @type {import('./solid_render.js').Vertex} */ (
        /** @type {unknown} */ (new env.THREE.Vector3(x, y, z))),
      onError,
      onFatal: actions.standDown,
      onTrap: actions.engineTrapped,
    };
  }

  /** Rebuilds the authored chain and refreshes its preview and availability gate. */
  function update() {
    page.mesh.currentMeshIsCurrent = false;
    if (!page.engine.wasmModule || !page.engine.meshOpsWasm) return;

    const built = env.buildChainMesh(page.doc.base, page.doc.ops, actions.buildContext());
    if (!built) return;

    page.mesh.currentMesh = built.meshData;
    page.mesh.currentMeshIsCurrent = true;
    page.mesh.currentFaceClasses = built.faceClasses;
    page.mesh.currentClassifyFailure = built.classifyFailure;

    actions.renderMesh();
    if (page.mesh.currentClassifyFailure) env.console.error(page.mesh.currentClassifyFailure);

    actions.refreshOpGating().catch((/** @type {unknown} */ e) => {
      env.console.error(e);
      actions.openOpGate('the gate sweep failed');
    });
  }
  return { initializeSolidEngine, updateArenaMetrics, standDown, freezeEditing, engineTrapped, showMeshError, showThumbnailError, buildContext, update };
}
