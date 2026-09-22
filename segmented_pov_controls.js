/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The Segmented POV panel: the folder, its Enabled toggle and Segments slider,
 * and the device-bounded spawn callback they drive.
 */

import { pageWarmer } from "./module_warmer.js";
import {
  createSegmentSpawnGuard,
  createSegmentedFallback,
  maxSegmentCount,
} from "./segment_policy.js";

/**
 * Creates the worker-pool spawn callback from live layout and count state.
 * @param {Pick<import('./segment_controller.js').SegmentController, 'create'>} segments - Segment controller receiving the bounded count.
 * @param {() => number} requestedCount - Current GUI-requested segment count.
 * @param {Navigator | {deviceMemory?: number}} nav - Source of the device hint.
 * @param {() => boolean} isMobile - Current layout state.
 * @returns {() => void} A callback that creates the bounded pool.
 */
export function createSegmentPoolSpawner(segments, requestedCount, nav, isMobile) {
  return () => segments.create(
    Math.min(requestedCount(), maxSegmentCount(nav, isMobile())));
}

/**
 * Build the Segmented POV controls: the folder, its Enabled toggle and Segments
 * slider, the spawn guard they drive, and the fallback a failed spawn or
 * teardown runs.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{addFolder: (title: string) => *}} deps.gui - The global GUI root the
 *   folder is added under.
 * @param {import('./segment_controller.js').SegmentController} deps.segments - The SegmentController the controls drive.
 * @param {Navigator | {deviceMemory?: number}} deps.nav - Source of the device hint.
 * @param {{isMobile: boolean}} deps.driver - The driver, read for the live layout.
 * @param {(message: string) => void} deps.showNotice - Owner-tagged sink for the
 *   fallback report.
 * @returns {ReturnType<typeof createSegmentSpawnGuard>} The spawn guard, whose
 *   strand() the page teardown runs.
 */
export function createSegmentedPovControls({
  gui,
  segments,
  nav,
  driver,
  showNotice,
}) {
  // The folder name and the segState property names are deep-link key segments
  // (view.Segmented POV.<prop>); renaming either invalidates links already shared.
  const segFolder = gui.addFolder('Segmented POV');
  segFolder.close();
  // Every pool member holds a WASM heap of its own, so the ceiling is what the
  // device can carry. The slider is built against it, which is also what bounds a
  // deep link — addWithHydration clamps an over-cap URL value and rewrites the URL.
  const segMax = maxSegmentCount(nav, driver.isMobile);
  const segState = {
    segmented: segments.active,
    segments: Math.min(segments.count, segMax),
    boundaries: segments.showBoundaries,
  };
  // Requested size; segments.count follows the live pool and lags this across
  // the warmModules() await.
  let segCount = segState.segments;
  // Assigned below, after the toggle whose deep-linked handler can reconcile it.
  /** @type {{updateDisplay: () => void, setValue: (value: number) => void, onChange: Function}} */
  let segCountCtrl;
  // The ceiling is re-read at every spawn, so a narrowing — a rotation into the
  // mobile layout — bounds the pool below the requested size. setValue, not
  // updateDisplay, so the deep-link writer re-advertises the running size.
  const syncSegmentCount = () => {
    const live = segments.count;
    if (!segCountCtrl || !Number.isFinite(live) || live === segCount) return;
    segCount = live;
    segCountCtrl.setValue(live);
  };
  const segSpawn = createSegmentSpawnGuard({
    warmModules: () => pageWarmer.warm(),
    // segMax is the layout the page loaded in; a rotation into the mobile
    // layout lowers what the device can carry, so the pool is bounded by the
    // ceiling as it stands at the spawn, not the one the slider was built on.
    spawn: createSegmentPoolSpawner(
      segments, () => segCount, nav, () => driver.isMobile),
    isActive: () => segments.active,
  });
  // Declared ahead of the fallback, and assigned before its handler is wired: a
  // deep-linked `segmented` replays that handler synchronously at registration,
  // and a throw there reaches the fallback's showToggle.
  /** @type {{setValue: (value: boolean) => void, onChange: Function}} */
  let segEnabledCtrl;
  const segmentedFailed = createSegmentedFallback({
    segments,
    strand: () => segSpawn.strand(),
    showNotice,
    // No-ops when the toggle is already false.
    showToggle: (on) => segEnabledCtrl.setValue(on),
  });
  segEnabledCtrl = segFolder.add(segState, 'segmented').name('Enabled');
  segEnabledCtrl.onChange(async (/** @type {boolean} */ v) => {
    try {
      segments.active = v;
      if (v) {
        if (await segSpawn.respawn()) syncSegmentCount();
      } else {
        segSpawn.strand();
        segments.destroy();
        segments.updateStats();
      }
    } catch (e) {
      segmentedFailed(v ? 'enable' : 'teardown', e);
    }
  });
  // The firmware takes a power-of-two segment count <= 8, so 6 is extra worker
  // parallelism no hardware produces; the label says so, since the per-segment
  // overlay otherwise names boards that cannot exist. A device cap that drops 6
  // from the range takes the marker with it and names the cap instead.
  const segLabel = segMax >= 6 ? 'Segments (6 = sim only)' : `Segments (max ${segMax} here)`;
  segCountCtrl = segFolder.add(segState, 'segments', 2, segMax, 2).name(segLabel);
  segCountCtrl.onChange(async (/** @type {number} */ v) => {
    // A reconcile writes the value the handler already acted on.
    if (v === segCount) return;
    try {
      segCount = v;
      if (segments.active && await segSpawn.respawn()) syncSegmentCount();
    } catch (e) {
      segmentedFailed('resize', e);
    }
  });
  segFolder.addSession(segState, 'boundaries').name('Show Boundaries').onChange((/** @type {boolean} */ v) => {
    segments.showBoundaries = v;
  });
  return segSpawn;
}
