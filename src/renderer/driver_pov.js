/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {PovSweep} from './pov_sweep.js';
import {isViewLive} from './pixel_view.js';

/**
 * @param {number} accumulator - Accumulated simulation time.
 * @param {number} interval - Duration of one step, in the same units.
 * @returns {number} Fractional progress through the current step.
 */
export const sweepFraction = (accumulator, interval) => (accumulator % interval) / interval;

/** @param {import('./driver.js').Daydream} driver */
export function ensurePovSweep(driver) {
  if (driver.povFidelity && isViewLive(driver.pixels)
      && (!driver.povSweep || driver.povSweep.width !== driver.W
        || driver.povSweep.height !== driver.H)) {
    driver.povSweep = new PovSweep(driver.W, driver.H, driver.pixels,
      sweepFraction(driver.timeAccumulator, driver.frameInterval),
      driver.frameInterval * 1000);
  } else if (!driver.povFidelity && driver.povSweep) {
    driver.povSweep = null;
    if (driver.dotMesh?.instanceColor) driver.dotMesh.instanceColor.needsUpdate = true;
    driver.needsRender = true;
  }

}

/** @param {import('./driver.js').Daydream} driver @param {boolean} advanced
 * @param {boolean} captureReady @param {number} previousSweepTime
 * @param {{refreshPixelView?: () => void}} adapter */
export function updatePovSweep(driver, advanced, captureReady, previousSweepTime, adapter) {
  if (driver.povSweep && !isViewLive(driver.pixels)) adapter?.refreshPixelView?.();
  if (driver.povResetPending && captureReady && isViewLive(driver.pixels)) {
    driver.povSweep?.reset(/** @type {Uint16Array} */ (driver.pixels));
    driver.povResetPending = false;
    driver.needsRender = true;
  }
  const panelDue = advanced || driver.paused || driver.needsRender;
  if (driver.povSweep && isViewLive(driver.pixels)) {
    if (!driver.povResetPending && (driver.paused ? captureReady : advanced))
      driver.povSweep.beginFrame(driver.pixels);
    const fraction = sweepFraction(driver.timeAccumulator, driver.frameInterval);
    if (driver.povSweep.advance(fraction)) driver.needsRender = true;
    if (driver.timeAccumulator !== previousSweepTime)
      driver.needsRender = true;
  }
  return panelDue;
}

/** @param {import('./driver.js').Daydream} driver */
export function resetPovNow(driver) {
  driver.povSweep?.reset(/** @type {Uint16Array} */ (driver.pixels));
}

/** @param {import('./driver.js').Daydream} driver */
export function resetPovOnNextFrame(driver) {
  driver.povResetPending = true;
}

/** @param {import('./driver.js').Daydream} driver @param {boolean} strobe */
export function setStrobeColumns(driver, strobe) {
  driver.noBlackColumns = !strobe;
  driver.invalidate();
}
