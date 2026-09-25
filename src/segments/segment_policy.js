/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The segmented pool's spawn policy: the device ceiling on the pool size, the
 * epoch that keeps a toggle burst to one pool, and the fallback to the
 * single-thread engine a failed spawn or teardown runs.
 */

import { errorDetail } from '../shared/banner.js';

/**
 * Build the segmented pool's spawn guard.
 *
 * Spawning awaits a module warm-up, so a toggle burst can leave several
 * continuations in flight at once. Each attempt takes an epoch before the await
 * and spawns only if no later attempt or strand() superseded it and segmented
 * mode is still on — an on/off/on burst therefore builds one pool, not two, and
 * a page discard or a pool failure strands whatever is still awaiting.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => Promise<*>} deps.warmModules - Primes the worker module cache
 *   before the spawn burst.
 * @param {() => void} deps.spawn - Builds the pool at the requested size.
 * @param {() => boolean} deps.isActive - Whether segmented mode is still on.
 * @returns {{respawn: () => Promise<boolean>, strand: () => void}} The guarded
 *   spawn, resolving to whether it landed, and the stranding bump. A rejecting
 *   warm-up or a throwing spawn propagates, leaving the caller to run its
 *   fallback; the app's own warmModules is best-effort and never rejects.
 */
export function createSegmentSpawnGuard({ warmModules, spawn, isActive }) {
  let epoch = 0;
  return {
    async respawn() {
      const mine = ++epoch;
      await warmModules();
      if (mine !== epoch || !isActive()) return false;
      spawn();
      return true;
    },
    strand() { epoch++; },
  };
}

/**
 * Build the segmented pool's fallback to the single-thread engine.
 *
 * Ordered: the flag goes false before the strand and the teardown, so a
 * warmModules() continuation still in flight reads an inactive host after its
 * await and cannot spawn a pool behind the engine the app has fallen back to.
 * The toggle is corrected last, since its own onChange re-runs the (idempotent)
 * teardown.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{active: boolean, destroy: () => void}} deps.segments -
 *   The segment controller.
 * @param {() => void} deps.strand - Bumps the spawn epoch.
 * @param {(message: string) => void} deps.showNotice - Reports the fallback;
 *   without it the only symptom is the toggle flipping back, which reads as a
 *   mis-click, and the fault banner covers latched runtime faults, not this path.
 * @param {(on: boolean) => void} deps.showToggle - Writes the Enabled control
 *   through setValue (not updateDisplay), so the deep-link writer drops
 *   segmented=true from the URL.
 * @param {(message: string, err: *) => void} [deps.logError] - Console sink.
 * @returns {(label: string, err: *) => void} The fallback, taking what failed
 *   (named in the log line and the notice) and the thrown value.
 */
export function createSegmentedFallback({
  segments,
  strand,
  showNotice,
  showToggle,
  logError = (message, err) => console.error(message, err),
}) {
  return (label, err) => {
    logError(`Segmented POV: ${label} failed; falling back to the single engine.`,
      err);
    showNotice(`Segmented POV ${label} failed: ${errorDetail(err)}. `
      + 'Falling back to the single engine.');
    segments.active = false;
    strand();
    segments.destroy();
    showToggle(false);
  };
}

/**
 * GUI ceiling on the worker pool, and the two lower ones a constrained device
 * gets. Every pool member holds its own WASM instance — 17.5 MB of linear memory
 * before growth — and the main thread holds one more, so an N-segment pool costs
 * N+1 heaps.
 */
export const SEGMENT_COUNT_MAX = 8;
const SEGMENT_COUNT_CONSTRAINED = 4;
const SEGMENT_COUNT_MIN = 2;

/**
 * Largest segment count to offer on this device. The GUI builds its slider
 * against this rather than rejecting an oversized pool afterwards, since running
 * the tab out of memory is a crash no fault path can report.
 * @details `navigator.deviceMemory` is Chromium-only and reports a power of two
 * clamped to [0.25, 8] GiB; where it is missing the mobile layout is what stands
 * in for a phone. The result is always even, so it satisfies isValidSegmentCount.
 * @param {Navigator | {deviceMemory?: number}} [nav] - Source of the device hint.
 * @param {boolean} [isMobile] - Whether the app is in its mobile layout.
 * @returns {number} An even count in [2, 8].
 */
export function maxSegmentCount(nav = globalThis.navigator, isMobile = false) {
  let cap = SEGMENT_COUNT_MAX;
  // deviceMemory is not in the DOM lib: it is a Chromium extension to Navigator.
  const gib = /** @type {{deviceMemory?: number} | undefined} */ (nav)?.deviceMemory;
  if (typeof gib === 'number' && gib > 0) {
    if (gib <= 2) cap = SEGMENT_COUNT_MIN;
    else if (gib <= 4) cap = SEGMENT_COUNT_CONSTRAINED;
  }
  if (isMobile) cap = Math.min(cap, SEGMENT_COUNT_CONSTRAINED);
  return Math.max(cap, SEGMENT_COUNT_MIN);
}
