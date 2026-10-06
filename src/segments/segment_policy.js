/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The segmented pool's spawn policy.
 */

import { errorDetail } from '../shared/banner.js';

/**
 * Build the segmented pool's spawn guard.
 *
 * Each attempt takes an epoch before awaiting the module warm-up and spawns
 * only if no later attempt or strand() superseded it and segmented mode is
 * still on, so an on/off/on burst builds one pool.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => Promise<*>} deps.warmModules - Primes the worker module cache
 *   before the spawn burst.
 * @param {() => void} deps.spawn - Builds the pool at the requested size.
 * @param {() => boolean} deps.isActive - Whether segmented mode is still on.
 * @returns {{respawn: () => Promise<boolean>, strand: () => void}} The guarded
 *   spawn, resolving to whether it landed, and the stranding bump. A rejecting
 *   warm-up or a throwing spawn propagates.
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
 * The flag goes false before the strand and the teardown, so an in-flight
 * warmModules() continuation reads an inactive host after its await. The toggle
 * is corrected last.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {{active: boolean, destroy: () => void}} deps.segments -
 *   The segment controller.
 * @param {() => void} deps.strand - Bumps the spawn epoch.
 * @param {(message: string) => void} deps.showNotice - Reports the fallback.
 * @param {(on: boolean) => void} deps.showToggle - Writes the Enabled control
 *   through setValue, so the deep link drops segmented=true.
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
 * gets. An N-segment pool costs N+1 WASM heaps (workers plus the main thread).
 */
export const SEGMENT_COUNT_MAX = 8;
const SEGMENT_COUNT_CONSTRAINED = 4;
const SEGMENT_COUNT_MIN = 2;

/**
 * Largest segment count to offer on this device.
 * @details `navigator.deviceMemory` is Chromium-only and reports a power of two
 * clamped to [0.25, 8] GiB; where it is missing the mobile layout stands in for
 * a phone.
 * @param {Navigator | {deviceMemory?: number}} [nav] - Source of the device hint.
 * @param {boolean} [isMobile] - Whether the app is in its mobile layout.
 * @returns {number} An even count in [2, 8].
 */
export function maxSegmentCount(nav = globalThis.navigator, isMobile = false) {
  let cap = SEGMENT_COUNT_MAX;
  // deviceMemory is a Chromium extension, absent from the DOM lib.
  const gib = /** @type {{deviceMemory?: number} | undefined} */ (nav)?.deviceMemory;
  if (typeof gib === 'number' && gib > 0) {
    if (gib <= 2) cap = SEGMENT_COUNT_MIN;
    else if (gib <= 4) cap = SEGMENT_COUNT_CONSTRAINED;
  }
  if (isMobile) cap = Math.min(cap, SEGMENT_COUNT_CONSTRAINED);
  return Math.max(cap, SEGMENT_COUNT_MIN);
}
