/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Rebuild the floating axis labels, acquiring pooled sprites only for those on
 * the camera-facing hemisphere.
 * @param {import('./driver.js').Daydream} driver - Display state.
 * @param {{LABEL_VISIBILITY_FRAMING_RATIO:number,
 * AXIS_LABELS:{position:import('three').Vector3, content:string}[]}} config - Label placement.
 */
export function refreshLabels(driver, config) {
  driver.labelPool.reset();

  if (driver.labelAxes) {
    // position is a unit direction, so position·cameraPos == |cameraPos|·cos(angle);
    // scaling the cutoff by the live distance keeps the visible set zoom-independent.
    const facingThreshold =
      config.LABEL_VISIBILITY_FRAMING_RATIO * driver.camera.position.length();
    for (const label of config.AXIS_LABELS) {
      if (label.position.dot(driver.camera.position) > facingThreshold) {
        driver.labelPool.acquire(label.position, label.content);
      }
    }
  }

  driver.labelPool.cleanup();
}
