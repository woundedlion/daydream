/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The display buffer every renderer writes through: the Three.js instance-colour
 * attribute, its array, and the driver's own pixel handle, all of which must
 * reference the live WASM view. A stale alias shows the previous buffer.
 */

/**
 * @typedef {Object} DisplayDriver
 * @property {{instanceColor: {array: Uint16Array|null, needsUpdate: boolean}}} dotMesh
 * @property {Uint16Array|null} pixels
 */

/**
 * Re-point both display aliases (Three.js instanceColor + driver.pixels) so
 * source, displayed attribute, and driver.pixels all reference the same WASM
 * view. Shared by EngineHost.refresh(), the frame adapter's alias heal, and
 * SegmentController's composite heal.
 * @param {DisplayDriver} driver - The Daydream driver owning the dot mesh.
 * @param {Uint16Array} view - The WASM pixel view to alias.
 * @returns {void}
 */
export function repointDisplayAliases(driver, view) {
  driver.dotMesh.instanceColor.array = view;
  driver.dotMesh.instanceColor.needsUpdate = true;
  driver.pixels = view;
}

/**
 * Whether either display alias has stopped referencing the engine's pixel view.
 * @param {DisplayDriver} driver - The Daydream driver owning the dot mesh.
 * @param {Uint16Array} view - The view both aliases must reference.
 * @returns {boolean} True when at least one alias points elsewhere.
 */
export function displayAliasesDiverged(driver, view) {
  return driver.pixels !== view
    || driver.dotMesh.instanceColor.array !== view;
}
