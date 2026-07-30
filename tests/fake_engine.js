// @ts-nocheck
//
// Single source of truth for the HolosphereEngine method surface the tests
// stand in for: engine_contract_wasm.test.js pins the real WASM module against
// this list, and every FakeEngine is checked to mock nothing outside it.

/** Engine methods the segmented worker and controller drive. */
export const ENGINE_METHODS = [
  'setResolution', 'setEffect', 'setParameter', 'setAnimationsPaused',
  'setClip', 'drawFrame', 'getPixels', 'getArenaMetrics',
  'getParameterDefinitions', 'getParamValues',
];

/**
 * Method names an object exposes that ENGINE_METHODS does not pin — a fake
 * mocking one of these would pass its own tests against a method the real
 * engine never had.
 * @param {Object} obj - Prototype or object carrying a fake engine's methods.
 * @returns {Array<string>} Unpinned method names, sorted.
 */
export function unpinnedEngineMethods(obj) {
  const pinned = new Set(ENGINE_METHODS);
  return Object.getOwnPropertyNames(obj)
    .filter((name) => name !== 'constructor'
      && typeof obj[name] === 'function'
      && !pinned.has(name))
    .sort();
}
