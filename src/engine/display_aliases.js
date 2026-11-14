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

/**
 * @typedef {Object} AliasGuard
 * @property {(view: Uint16Array) => boolean} heal - Re-points diverged aliases at
 *   the view, logging the first divergence since the guard was armed; returns
 *   whether it re-pointed.
 * @property {() => void} reset - Re-arms the divergence log.
 */

/**
 * Build a self-healing check for display aliases that drift from the live view.
 * @param {Object} deps - Injected collaborators.
 * @param {(view: Uint16Array) => void} deps.repoint - Re-points both display aliases at the view.
 * @param {(view: Uint16Array) => boolean} deps.diverged - Whether either alias references another buffer.
 * @param {((message: string) => void)|undefined} [deps.logError] - Console sink for the
 *   divergence report.
 * @param {string} deps.site - Names the caller at the head of the report.
 * @returns {AliasGuard} The guard, armed.
 */
export function createAliasGuard({ repoint, diverged, logError = (message) => console.error(message), site }) {
  let logged = false;
  return {
    heal(view) {
      if (!diverged(view)) return false;
      if (!logged) {
        logged = true;
        logError(`${site}: display-buffer alias diverged from the WASM view;`
          + ' re-pointing driver.pixels and instanceColor.array at it');
      }
      repoint(view);
      return true;
    },
    reset() {
      logged = false;
    },
  };
}

/**
 * Build an alias guard over one driver's display aliases.
 * @param {DisplayDriver} driver - The Daydream driver whose aliases the guard heals.
 * @param {string} site - Names the caller at the head of the report.
 * @param {(message: string) => void} [logError] - Console sink for the divergence report.
 * @returns {AliasGuard} The guard, armed.
 */
export function createDriverAliasGuard(driver, site, logError) {
  return createAliasGuard({
    repoint: (view) => repointDisplayAliases(driver, view),
    diverged: (view) => displayAliasesDiverged(driver, view),
    logError,
    site,
  });
}
