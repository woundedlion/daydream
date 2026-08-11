/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Dependency-free page-lifecycle helpers shared by the tool pages: the
 * animation-frame coalescer their input handlers schedule recomputes through,
 * and the teardown hook that tells a real page discard from a bfcache freeze.
 */

/**
 * @typedef {{ (): void, cancel: () => void }} FrameScheduler
 */

/**
 * Builds a scheduler that runs `run` at most once per animation frame.
 *
 * A slider's `input` event fires on every pointer tick during a drag, and each
 * tool's recompute is expensive (replaying a WASM op chain, re-baking a palette
 * LUT, resampling thousands of curve points). Coalescing keeps at most one
 * recompute pending, so a drag costs one per frame instead of one per tick.
 *
 * @param {Function} run - The recompute to coalesce. Called with no arguments.
 * @returns {FrameScheduler} Call it to request a run; call `.cancel()` to drop a pending frame.
 */
export function createFrameScheduler(run) {
  let pending = 0;

  const schedule = () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      run();
    });
  };

  /**
   * Drops the pending frame, so a torn-down page cannot run a recompute against
   * disposed resources.
   * @returns {void}
   */
  schedule.cancel = () => {
    if (!pending) return;
    cancelAnimationFrame(pending);
    pending = 0;
  };

  return schedule;
}

/**
 * Runs `teardown` when the page is really going away.
 *
 * pagehide (not unload) so the back/forward cache is respected: a frozen page is
 * restored intact, so releasing its render loop, timers, and GPU buffers would
 * leave it broken on the way back. `event.persisted` marks exactly that freeze.
 *
 * @param {Function} teardown - Releases the page's resources. Called with no arguments.
 * @returns {void}
 */
export function onPageTeardown(teardown) {
  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return;
    teardown();
  });
}
