/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Page module for tools/solids.html.
 */
import {bootstrapTool} from '../shared.js';
import {createFrameScheduler, onPageTeardown} from '../../shared/page_lifecycle.js';
import {createSolidsPage, initializeSolidsState, setOps} from './solids_state.js';
import {createSolidsEngine} from './solids_engine.js';
import {createSolidsScene} from './solids_scene.js';
import {createSolidsOpsController} from './solids_ops_controller.js';
import {createSolidsRowDrag} from './solids_row_drag.js';
import {createSolidsOpGateView} from './solids_op_gate_view.js';
import {createSolidsSavedController} from './solids_saved_controller.js';
import {createSolidsBasePicker} from './solids_base_picker.js';

const page = createSolidsPage(window.matchMedia?.('(prefers-reduced-motion: reduce)'));
const actions = /** @type {import('./solids_state.js').SolidsActions} */ ({});
Object.assign(actions,
  createSolidsEngine(page, actions),
  createSolidsScene(page, actions),
  createSolidsOpsController(page, actions),
  createSolidsRowDrag(page, actions),
  createSolidsOpGateView(page, actions),
  createSolidsSavedController(page, actions),
  createSolidsBasePicker(page, actions));
actions.setOps = next => setOps(page, next);
actions.scheduleUpdate = createFrameScheduler(actions.update);
initializeSolidsState(page, actions);

/** Loads the engine and mounts the solids tool. @returns {Promise<void>} */
async function init() {
  if (!await actions.initializeSolidEngine()) return;
  const thumbnailAbort = new AbortController();
  onPageTeardown(() => {
    thumbnailAbort.abort();
    if (page.engine.arenaMetricsTimer !== null) {
      clearTimeout(page.engine.arenaMetricsTimer);
      page.engine.arenaMetricsTimer = null;
    }
  });
  actions.updateArenaMetrics();
  if (!page.engine.wasmModule) return;
  actions.mountSolidScene();
  actions.wireOpControls();
  actions.wireSavedSolidControls();
  actions.generateThumbnails(thumbnailAbort.signal).catch(error => {
    if (actions.engineTrapped(error)) return;
    actions.showThumbnailError(`Thumbnails failed: ${error.message}`);
  });
  actions.renderSavedList();
  window.addEventListener('storage', actions.reloadSavedSolids);
  onPageTeardown(() => window.removeEventListener('storage', actions.reloadSavedSolids));
  actions.updateToggles();
  actions.update();
  actions.renderBaseSolid();
}

bootstrapTool(init, 'solids tool');
