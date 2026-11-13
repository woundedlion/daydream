/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createTestAllTicker, createGlobalKeydownHandler} from './app_lifecycle.js';
import {createViewDisplayControls} from './view_display_controls.js';
import {createRecordingControls} from '../recording/recording_controls.js';
import {createSegmentedPovControls} from '../ui/segmented_pov_controls.js';
import {reportPageFailures} from '../shared/banner.js';
const TEST_ALL_INTERVAL_MS = 1000;
const RECORD_NOTICE = 'record';
const SEGMENT_NOTICE = 'segments';

/** @param {import('./app_context.js').EffectContext} deps */
export function createAppControls({doc, win, nav, host, daydream, display, segments, appState,
  availableEffects, effectGui, applyNotice, shell, shaderWorkbench}) {
  const {guiInstance} = shell;
  const testAllTicker = createTestAllTicker({
    intervalMs: TEST_ALL_INTERVAL_MS,
    availableEffects: () => availableEffects(appState.get('resolution')),
    getEffect: () => appState.get('effect'),
    setEffect: (name) => appState.set('effect', name),
    engineReady: () => Boolean(host.engine),
  });

  const testAllController = shaderWorkbench ? null : guiInstance.addSession({ testAll: false }, 'testAll').name('Test All')
    .onChange((/** @type {boolean} */ v) => {
      if (v) testAllTicker.start();
      else testAllTicker.stop();
    });


  guiInstance.addSession(daydream, 'paused').name('Pause').listen().onChange((/** @type {boolean} */ v) => {
    if (!v) daydream.stepFrames = 0;
  });
  guiInstance.add(daydream, 'labelAxes').name('Show Axes').onChange(() => daydream.invalidate());
  guiInstance.add(daydream, 'cullBackSphere').name('Cull Back Sphere').onChange(() => daydream.invalidate());
  guiInstance.add(daydream, 'showPip').name('Show PiP').onChange(() => daydream.invalidate());
  const viewDisplay = createViewDisplayControls({
    gui: guiInstance, driver: daydream, host, segments,
    syncEffectGui: (advanced) => effectGui.sync(advanced),
  });

  const segSpawn = shaderWorkbench ? null : createSegmentedPovControls({
    gui: guiInstance,
    segments,
    nav,
    win,
    showNotice: (message) => applyNotice.show(message, SEGMENT_NOTICE),
  });

  const recording = createRecordingControls({
    doc,
    gui: guiInstance,
    driver: display,
    getRecorder: () => host.recorder,
    getEffect: () => appState.get('effect'),
    showNotice: (message) => applyNotice.show(message, RECORD_NOTICE),
  });
  const onKeyDown = createGlobalKeydownHandler({
    dispatch: (e) => daydream.keydown(e, (delta) => !shaderWorkbench && effectGui.movePreset(delta)),
  });
  win.addEventListener("keydown", onKeyDown);

  const pageFailureListeners = reportPageFailures('simulator', win);

  const onApplyNoticeDismiss = (/** @type {MouseEvent} */ e) => {
    if (e.target === doc.getElementById('apply-notice-dismiss')) {
      /** @type {HTMLCanvasElement|null} */ (doc.getElementById('canvas'))?.focus();
      applyNotice.clear();
    }
  };
  doc.addEventListener('click', onApplyNoticeDismiss);

  return {viewDisplay, segSpawn, recording, onKeyDown, pageFailureListeners,
    onApplyNoticeDismiss, testAllTicker, testAllController};
}
