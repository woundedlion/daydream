/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Display-buffer aliases (the Three.js instance-colour array and driver.pixels),
 * which must reference the live WASM view. A stale alias shows the previous buffer.
 */

/**
 * @typedef {Object} DisplayDriver
 * @property {{count?: number, instanceColor: {array: Uint16Array|null, needsUpdate: boolean}}} dotMesh
 * @property {Uint16Array|null} pixels
 */

/**
 * Re-point both display aliases (Three.js instanceColor + driver.pixels) so
 * source, displayed attribute, and driver.pixels all reference the same WASM
 * view.
 * @param {DisplayDriver} driver - The Daydream driver with a non-null dot mesh and instanceColor attribute.
 * @param {Uint16Array} view - The WASM pixel view to alias.
 * @returns {void}
 */
export function repointDisplayAliases(driver, view) {
  const previous = driver.dotMesh.instanceColor.array;
  const expected = driver.dotMesh.count === undefined
    ? previous?.length : driver.dotMesh.count * 3;
  if (expected && expected !== view.length)
    throw new RangeError('Display buffer size differs from the mesh color attribute');
  driver.dotMesh.instanceColor.array = view;
  driver.dotMesh.instanceColor.needsUpdate = true;
  driver.pixels = view;
}

/**
 * Whether either display alias has stopped referencing the engine's pixel view.
 * @param {DisplayDriver} driver - The Daydream driver with a non-null dot mesh and instanceColor attribute.
 * @param {Uint16Array} view - The view both aliases must reference.
 * @returns {boolean} True when at least one alias points elsewhere.
 */
export function displayAliasesDiverged(driver, view) {
  return driver.pixels !== view
    || driver.dotMesh.instanceColor.array !== view;
}
