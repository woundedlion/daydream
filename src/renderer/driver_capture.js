/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {import('../../generated/holosphere_wasm.js').ArenaMetrics} ArenaMetrics */


/**
 * Hand one frame's measurements to the stats overlay.
 * @param {number} duration - Frame draw time in milliseconds.
 * @param {{getArenaMetrics?: () => ArenaMetrics|null}} adapter - Render adapter; its getArenaMetrics() supplies arena usage when present.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function updateStats(driver, duration, adapter) {
  driver.statsView?.update(duration, adapter?.getArenaMetrics?.() ?? null);
}


/** @param {import('./driver.js').Daydream} driver @param {boolean} captureDue */
export function captureDisplayFrame(driver, captureDue) {
  // One requestFrame per repaint: several in a single task carry one timestamp,
  // so the stream cannot emit them as separate video frames while the elapsed
  // counter charges for each. A backlog drains one per repaint instead.
  const owed = driver.recorder ? (captureDue ? 1 : 0) + driver.heldCaptures : 0;
  driver.heldCaptures = owed > 0 ? owed - 1 : 0;
  if (owed > 0) /** @type {import('../recording/recorder.js').VideoRecorder} */ (driver.recorder).captureFrame();
  if (driver.heldCaptures > 0) driver.needsRender = true;

}
