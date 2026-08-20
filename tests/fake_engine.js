//
// Single source of truth for the HolosphereEngine method surface the tests
// stand in for: engine_contract_wasm.test.js pins the real WASM module against
// this list, and every FakeEngine is checked to mock nothing outside it.
import { readFileSync } from 'node:fs';

/** Instance methods the tests' engine fakes stand in for. */
export const ENGINE_METHODS = [
  'setResolution', 'setEffect', 'setParameter', 'setAnimationsPaused',
  'getPresetCount', 'getPresetIndex', 'selectPreset', 'selectPresetById',
  'synchronizePreset', 'nextPreset', 'previousPreset',
  'setPoleLod', 'setClip', 'drawFrame', 'getPixels', 'getArenaMetrics',
  'getParameterDefinitions', 'getParamValues', 'getBufferLength',
  'getParamGeneration', 'getEffectSizes', 'strobeColumns', 'setShaderChain',
];

/**
 * The rest of the documented engine surface (README §10.2): read through
 * optional calls, or driven by no fake at all. Pinned all the same, so a fake
 * that grows one of them is not reported as mocking a method the engine lacks.
 */
export const ENGINE_OPTIONAL_METHODS = [
  'getFullConfigSnapshot', 'restoreFullConfigSnapshot',
  'getFullConfigFieldDefinitions', 'getConfigImportNotice',
  'clearConfigImportNotice', 'getAnimationsPaused', 'getPresetIds', 'getPoleLod',
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

export const FullConfigRestoreResult = Object.freeze({
  APPLIED: Object.freeze({ value: 0 }),
  NOT_SHADERBALL: Object.freeze({ value: 1 }),
  UNSUPPORTED_VERSION: Object.freeze({ value: 2 }),
  INVALID_LENGTH: Object.freeze({ value: 3 }),
  INVALID_VALUE: Object.freeze({ value: 4 }),
  INVALID_ACCEPTED: Object.freeze({ value: 5 }),
  INVALID_PENDING: Object.freeze({ value: 6 }),
});

// The engine catalog exactly as the module's getShaderChainCatalog static
// exports it: the committed pin carries the export plus a POSIX trailing
// newline, which the export itself does not.
const CHAIN_CATALOG_TEXT = readFileSync(
  new URL('../shader/engine_catalog.json', import.meta.url), 'utf8',
).replace(/\n$/, '');

/**
 * Stand-in for the chain-capable engine surface tools/chain_apply.js drives:
 * setShaderChain with the module's payload-shape checks, parameter definitions
 * rebuilt from the pinned catalog on every APPLIED (with the generation bump
 * the real engine makes), and an injectable refusal. Every method it mocks is
 * pinned in ENGINE_METHODS.
 */
export class FakeChainEngine {
  /** The pinned operator catalog, byte-identical to the module export. */
  static getShaderChainCatalog() {
    return CHAIN_CATALOG_TEXT;
  }

  constructor() {
    this.catalog = JSON.parse(CHAIN_CATALOG_TEXT);
    this.effect = null;
    this.generation = 1;
    /** @type {Array<*>} Payloads handed to setShaderChain, in call order. */
    this.chainCalls = [];
    /** @type {Array<[string, number]>} Accepted setParameter writes. */
    this.writes = [];
    /** @type {?{code: string, entryIndex: number}} Injected next refusal. */
    this.nextChainResult = null;
    this.definitions = [];
  }

  setEffect(name) {
    this.effect = name;
    this.definitions = [];
    this.generation += 1;
    return EffectSetResult.INSTALLED;
  }

  setShaderChain(entries) {
    this.chainCalls.push(entries);
    const malformed = { code: 'MALFORMED_PAYLOAD', entryIndex: -1 };
    if (!Array.isArray(entries)) return malformed;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object'
          || typeof entry.instance !== 'string'
          || typeof entry.operator !== 'string') return malformed;
    }
    if (this.nextChainResult !== null) {
      const injected = this.nextChainResult;
      this.nextChainResult = null;
      return injected;
    }
    const operators = new Map(this.catalog.operators.map((op) => [op.id, op]));
    const definitions = [];
    for (const [index, entry] of entries.entries()) {
      const operator = operators.get(entry.operator);
      if (!operator) return { code: 'UNKNOWN_OPERATOR', entryIndex: index };
      for (const field of operator.params) {
        const base = {
          name: `${entry.instance}.${field.id}`,
          animated: false, readonly: false, preset: true,
        };
        definitions.push(field.topology
          ? { ...base, value: field.values.indexOf(field.default),
              min: 0, max: field.values.length - 1, options: [...field.values] }
          : { ...base, value: field.default, min: field.min, max: field.max });
      }
    }
    this.definitions = definitions;
    this.generation += 1;
    return { code: 'APPLIED', entryIndex: -1 };
  }

  getParameterDefinitions() {
    return this.definitions.map((definition) => ({
      ...definition,
      ...(definition.options ? { options: [...definition.options] } : {}),
    }));
  }

  setParameter(name, value) {
    const definition = this.definitions.find((d) => d.name === name);
    if (!definition) return ParamSetResult.UNKNOWN_PARAM;
    if (typeof value !== 'number' || !Number.isFinite(value))
      return ParamSetResult.NON_FINITE;
    definition.value = value;
    this.writes.push([name, value]);
    return ParamSetResult.APPLIED;
  }

  getParamGeneration() {
    return this.generation;
  }
}

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
  const pinned = new Set([...ENGINE_METHODS, ...ENGINE_OPTIONAL_METHODS]);
  const names = new Set();
  for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o))
    for (const name of Object.getOwnPropertyNames(o)) names.add(name);
  return [...names]
    .filter((name) => name !== 'constructor'
      && typeof obj[name] === 'function'
      && !pinned.has(name))
    .sort();
}
