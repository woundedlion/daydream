/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Replace the current history entry with a URL, reporting a refused write
 * instead of propagating it.
 * @details Browsers rate-limit replaceState (WebKit: ~100 per 30 s) and throw
 *   past the limit.
 * @param {string} url - The URL to write.
 * @param {Window} [win] - The window whose history is written.
 * @returns {boolean} Whether the URL was written; false when the browser refused it.
 */
export function replaceUrl(url, win = window) {
  try {
    win.history.replaceState({}, '', url);
    return true;
  } catch (e) {
    console.warn('URL update skipped:', e);
    return false;
  }
}
