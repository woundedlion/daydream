/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createViewDisplayControls} from './view_display_controls.js';
import {createRecordingControls} from '../recording/recording_controls.js';
import {createSegmentedPovControls} from '../ui/segmented_pov_controls.js';
import {reportPageFailures} from '../shared/banner.js';
const TEST_ALL_INTERVAL_MS = 1000;
const RECORD_NOTICE = 'record';
const SEGMENT_NOTICE = 'segments';

/**
 * The timer walking the effect list; start() is idempotent.
 * @typedef {{start: () => void, stop: () => void, running: () => boolean}} TestAllTicker
 */

// Elements that own their keystrokes: a key landing inside one belongs to that
// control, not to the global shortcuts.
const INTERACTIVE_KEY_TARGET =
  'input, textarea, select, button, a[href], [contenteditable], .lil-gui, .effect-sidebar, .chain-strip-region';

/**
 * Build the window keydown handler for the global playback shortcuts.
 *
 * A key landing in an INTERACTIVE_KEY_TARGET element is ignored; a non-node
 * target falls through to the shortcuts.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {(e: KeyboardEvent) => void} deps.dispatch - Runs the shortcut.
 * @returns {(e: KeyboardEvent) => void} The handler.
 */
export function createGlobalKeydownHandler({ dispatch }) {
  return (e) => {
    const target = /** @type {Element|null} */ (e.target);
    if (typeof target?.closest === 'function'
        && target.closest(INTERACTIVE_KEY_TARGET)) return;
    dispatch(e);
  };
}

/**
 * Build the "Test All" ticker: the timer that walks the current resolution's
 * effect list, one entry per interval.
 *
 * The index is the ticker's own: a rejected switch reverts the live effect, so
 * re-deriving it would retry the rejected slot forever. The list is re-read
 * every tick.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {number} deps.intervalMs - Dwell time per effect.
 * @param {() => Array<string>} deps.availableEffects - The effect list the active
 *   resolution offers.
 * @param {() => string} deps.getEffect - The live effect name, where the walk starts.
 * @param {(name: string) => void} deps.setEffect - Requests the next effect.
 * @param {() => boolean} deps.engineReady - Whether an engine exists to take a
 *   switch; a tick before the module load lands is skipped, not queued.
 * @param {(fn: () => void, ms: number) => any} [deps.schedule] - Timer source.
 * @param {(handle: any) => void} [deps.cancel] - Timer sink.
 * @returns {TestAllTicker} The ticker.
 */
export function createTestAllTicker({
  intervalMs,
  availableEffects,
  getEffect,
  setEffect,
  engineReady,
  schedule = (fn, ms) => setInterval(fn, ms),
  cancel = (handle) => clearInterval(handle),
}) {
  /** @type {any} */
  let handle = null;
  let index = 0;

  const tick = () => {
    if (!engineReady()) return;
    const list = availableEffects();
    if (list.length === 0) return;
    index = (index + 1) % list.length;
    setEffect(list[index]);
  };

  return {
    start() {
      if (handle !== null) return;
      // -1 for an effect off the list, so the first advance starts at its head.
      index = availableEffects().indexOf(getEffect());
      handle = schedule(tick, intervalMs);
    },
    stop() {
      if (handle === null) return;
      cancel(handle);
      handle = null;
    },
    running: () => handle !== null,
  };
}

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
