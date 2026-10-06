/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Dependency-free page-lifecycle helpers for the tool pages.
 */

/**
 * @typedef {{ (): void, cancel: () => void }} FrameScheduler
 */

/**
 * Builds a scheduler that runs `run` at most once per animation frame.
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
 * Runs a callback whenever a media query changes into its matching state.
 * @param {*} query - A MediaQueryList or an absent matchMedia result.
 * @param {Function} run - Callback for a matching change.
 * @returns {Function} Removes the change listener.
 */
export function watchMediaMatch(query, run) {
  const changed = (/** @type {MediaQueryListEvent} */ event) => {
    if (event.matches) run();
  };
  query?.addEventListener?.('change', changed);
  return () => query?.removeEventListener?.('change', changed);
}

/**
 * Runs `teardown` when the page is really going away.
 *
 * A back/forward-cache freeze (`event.persisted`) is skipped: that page is
 * restored intact.

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
