/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The segmented pool's spawn policy: the epoch that keeps a toggle burst to one
 * pool, and the fallback to the single-thread engine a failed spawn or teardown
 * runs.
 */

import { errorDetail } from './tools/banner.js';

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
 * @param {{active: boolean, destroy: () => void, updateStats: () => void}} deps.segments -
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
    segments.updateStats();
    showToggle(false);
  };
}
