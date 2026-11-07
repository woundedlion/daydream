/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { FPS } from '../renderer/frame_constants.js';
import { PovSweep } from '../renderer/pov_sweep.js';
import { MAX_DISPLAY_CAP_PERCENT, createDisplayCapsBinding } from '../renderer/display_caps.js';
import { createPoleLodBinding } from '../renderer/pole_lod.js';

/**
 * Binds display controls and replays their state when the engine becomes ready.
 * @param {object} deps
 * @param {import('../ui/gui.js').GUI} deps.gui - View GUI.
 * @param {import('../renderer/driver.js').Daydream} deps.driver - Renderer.
 * @param {import('../engine/engine_host.js').EngineHost} deps.host - Engine and active adapter.
 * @param {Pick<import('../segments/segment_controller.js').SegmentController,
 *   'setTemporalSampling'|'setPoleLod'|'setDisplayCaps'|'ownsDisplay'>} deps.segments - Worker-pool display controls.
 * @param {(advanced: boolean) => void} deps.syncEffectGui - Updates the effect panel.
 * @returns {{replay: () => boolean, finishColumnDefaults: () => void,
 *   columnDefaultsReady: () => boolean}} Startup replay and column-default coordination.
 */
export function createViewDisplayControls({gui, driver, host, segments, syncEffectGui}) {
  let columnDefaultsReady = false;
  let temporalSampling = driver.povFidelity;
  const povFidelity = gui.add(driver, 'povFidelity').name(`POV fidelity (${FPS} Hz)`);
  const povResponse = gui.add(driver, 'povResponseScale',
    PovSweep.MIN_RESPONSE_SCALE, PovSweep.MAX_RESPONSE_SCALE, 0.05).name('Response timescale');
  const armPositions = gui.add(driver, 'showSweepBoundary').name('Show arm positions');
  const syncPovControls = () => {
    for (const control of [povResponse, armPositions]) {
      if (driver.povFidelity) control.enable();
      else control.disable();
    }
    driver.invalidate();
  };
  povFidelity.onChange(() => {
    const changed = temporalSampling !== driver.povFidelity;
    temporalSampling = driver.povFidelity;
    if (host.engine) host.engine.setTemporalSampling(driver.povFidelity);
    segments.setTemporalSampling(driver.povFidelity);
    if (changed && driver.paused && host.adapter && !segments.ownsDisplay)
      host.adapter.drawFrame();
    syncPovControls();
  });
  povResponse.onChange(() => driver.invalidate());
  armPositions.onChange(() => driver.invalidate());
  syncPovControls();
  /** @type {boolean|null} */
  let initialColumnOverride = null;
  let columnOverrideChanged = false;
  const finishColumnDefaults = () => {
    if (initialColumnOverride !== null && host.engine && !columnOverrideChanged) {
      driver.noBlackColumns = initialColumnOverride;
      driver.invalidate();
    }
    columnDefaultsReady = true;
  };
  gui.add(driver, 'noBlackColumns').name('No black columns').listen().onChange((/** @type {boolean} */ value) => {
    if (!host.engine) initialColumnOverride = value;
    else columnOverrideChanged = true;
    driver.invalidate();
  });

  const poleLod = createPoleLodBinding({
    getEngine: () => host.engine,
    onChange: () => driver.invalidate(),
  });
  gui.add(poleLod.state, 'poleLod', 0, 2, 0.05).name('Pole LOD')
    .onChange((/** @type {number} */ value) => {
      poleLod.apply(value);
      segments.setPoleLod(value);
      if (driver.paused && !segments.ownsDisplay) driver.stepOnce();
    });

  const displayCaps = createDisplayCapsBinding({
    getEngine: () => host.engine,
    onChange: (geometry) => {
      driver.setDisplayGeometry(geometry);
      host.invalidateView();
      segments.setDisplayCaps(displayCaps.state.topCap, displayCaps.state.bottomCap);
      if (host.adapter) {
        host.refresh();
        host.adapter.drawFrame();
        if (segments.ownsDisplay) driver.resetPovOnNextFrame();
        else driver.resetPovNow();
        syncEffectGui(true);
      }
      driver.invalidate();
    },
  });
  let acceptedCaps = { ...displayCaps.state };
  /** @type {import('lil-gui').Controller[]} */
  const capControls = [];
  const applyDisplayCaps = () => {
    if (!displayCaps.apply()) {
      Object.assign(displayCaps.state, acceptedCaps);
      for (const control of capControls) control.updateDisplay();
      throw new Error('Engine rejected display cap settings.');
    }
    acceptedCaps = { ...displayCaps.state };
    if (!host.engine) segments.setDisplayCaps(displayCaps.state.topCap, displayCaps.state.bottomCap);
  };
  capControls.push(gui.add(displayCaps.state, 'topCap', 0, MAX_DISPLAY_CAP_PERCENT, 0.1).name('Top cap (%)')
    .onChange(applyDisplayCaps));
  capControls.push(gui.add(displayCaps.state, 'bottomCap', 0, MAX_DISPLAY_CAP_PERCENT, 0.1).name('Bottom cap (%)')
    .onChange(applyDisplayCaps));

  return {
    replay() {
      poleLod.replay();
      return displayCaps.replay();
    },
    finishColumnDefaults,
    columnDefaultsReady: () => columnDefaultsReady,
  };
}
