//
// Single source of truth for the HolosphereEngine method surface the tests
// stand in for: engine_contract_wasm.test.js pins the real WASM module against
// this list, and every FakeEngine is checked to mock nothing outside it.

/** Instance methods the tests' engine fakes stand in for. */
export const ENGINE_METHODS = [
  'setResolution', 'setEffect', 'setParameter', 'setAnimationsPaused',
  'getPresetCount', 'getPresetIndex', 'selectPreset', 'synchronizePreset',
  'nextPreset', 'previousPreset',
  'setPoleLod', 'setClip', 'drawFrame', 'getPixels', 'getArenaMetrics',
  'getParameterDefinitions', 'getParamValues', 'getBufferLength',
  'getParamGeneration', 'getEffectSizes', 'strobeColumns',
];

/**
 * Mirror of the module-level ParamSetResult embind enum (targets/wasm/wasm.cpp)
 * that setParameter returns. Values are distinct frozen objects so identity
 * comparison behaves like embind's cached enum instances; consumers must
 * compare against these values, never by truthiness (every value is a truthy
 * object). engine_contract_wasm.test.js pins the name roster against the real
 * module.
 */
export const ParamSetResult = Object.freeze({
  APPLIED: Object.freeze({ value: 0 }),
  NO_EFFECT: Object.freeze({ value: 1 }),
  UNKNOWN_PARAM: Object.freeze({ value: 2 }),
  READONLY: Object.freeze({ value: 3 }),
  NON_FINITE: Object.freeze({ value: 4 }),
});

/**
 * Mirror of the module-level ClipSetResult embind enum (targets/wasm/wasm.cpp)
 * that setClip returns, under the same identity-comparison contract as
 * ParamSetResult above. engine_contract_wasm.test.js pins the name roster
 * against the real module.
 */
export const ClipSetResult = Object.freeze({
  APPLIED: Object.freeze({ value: 0 }),
  NO_EFFECT: Object.freeze({ value: 1 }),
  INVALID_BOUNDS: Object.freeze({ value: 2 }),
  FULL_FRAME_KEPT: Object.freeze({ value: 3 }),
});

/**
 * Mirror of the module-level ResolutionSetResult embind enum that setResolution
 * returns, under the same identity-comparison contract as ParamSetResult above.
 * RESIZED and ALREADY_ACTIVE are both successes; only RESIZED tears the effect
 * down. engine_contract_wasm.test.js pins the name roster against the real
 * module.
 */
export const ResolutionSetResult = Object.freeze({
  RESIZED: Object.freeze({ value: 0 }),
  ALREADY_ACTIVE: Object.freeze({ value: 1 }),
  UNSUPPORTED: Object.freeze({ value: 2 }),
});

/**
 * Mirror of the module-level EffectSetResult embind enum that setEffect
 * returns, under the same identity-comparison contract as ParamSetResult above.
 * engine_contract_wasm.test.js pins the name roster against the real module.
 */
export const EffectSetResult = Object.freeze({
  INSTALLED: Object.freeze({ value: 0 }),
  UNKNOWN_EFFECT: Object.freeze({ value: 1 }),
  UNSUPPORTED_RESOLUTION: Object.freeze({ value: 2 }),
});

/**
 * Method names an object exposes that ENGINE_METHODS does not pin — a fake
 * mocking one of these would pass its own tests against a method the real
 * engine never had. Walks the prototype chain up to Object.prototype, so an
 * instance is checked together with the class it came from and a per-instance
 * patch cannot slip past.
 * @param {Object} obj - Prototype, instance, or object literal carrying a fake
 *   engine's methods.
 * @returns {Array<string>} Unpinned method names, sorted.
 */
export function unpinnedEngineMethods(obj) {
  const pinned = new Set(ENGINE_METHODS);
  const names = new Set();
  for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
    for (const name of Object.getOwnPropertyNames(o)) names.add(name);
  return [...names]
    .filter((name) => name !== 'constructor'
      && typeof obj[name] === 'function'
      && !pinned.has(name))
    .sort();
}
