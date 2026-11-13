/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { Daydream } from "./driver.js";

/**
 * Rebuild the floating axis labels, acquiring pooled sprites only for those on
 * the camera-facing hemisphere.
 * @param {import('./driver.js').Daydream} driver - Display state.
 */
export function refreshLabels(driver) {
  driver.labelPool.reset();

  if (driver.labelAxes) {
    // position is a unit direction, so position·cameraPos == |cameraPos|·cos(angle);
    // scaling the cutoff by the live distance keeps the visible set zoom-independent.
    const facingThreshold =
      Daydream.LABEL_VISIBILITY_FRAMING_RATIO * driver.camera.position.length();
    for (const label of Daydream.AXIS_LABELS) {
      if (label.position.dot(driver.camera.position) > facingThreshold) {
        driver.labelPool.acquire(label.position, label.content);
      }
    }
  }

  driver.labelPool.cleanup();
}
