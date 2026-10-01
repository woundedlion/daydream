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
  'setDisplayCaps', 'getDisplayNorthPhi', 'getDisplaySouthPhi',
  'getParameterDefinitions', 'getParamValues', 'getBufferLength',
  'getParamGeneration', 'getEffectSizes', 'getEffectPresetCounts',
  'strobeColumns',
];

/**
 * The rest of the documented engine surface (README §10.2): read through
 * optional calls, or driven by no fake at all. Pinned all the same, so a fake
 * that grows one of them is not reported as mocking a method the engine lacks.
 */
export const ENGINE_OPTIONAL_METHODS = [
  'getShaderChainBindings',
  'getAnimationsPaused', 'getPresetIds', 'getPoleLod',
  // embind's own handle release, which engine_host.js calls on teardown.
  'delete',
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
  INADMISSIBLE: Object.freeze({ value: 5 }),
  MALFORMED_PAYLOAD: Object.freeze({ value: 6 }),
  TOO_LONG: Object.freeze({ value: 7 }),
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

export const ChainStatus = Object.freeze({
  OK: Object.freeze({ value: 0 }),
  NOT_CHAIN_EFFECT: Object.freeze({ value: 1 }),
  MALFORMED_PAYLOAD: Object.freeze({ value: 2 }),
  EMPTY: Object.freeze({ value: 3 }),
  TOO_LONG: Object.freeze({ value: 4 }),
  UNKNOWN_OPERATOR: Object.freeze({ value: 5 }),
  DUPLICATE_INSTANCE: Object.freeze({ value: 6 }),
  MALFORMED_INSTANCE: Object.freeze({ value: 7 }),
  ENTRY_FAMILY: Object.freeze({ value: 8 }),
  EXIT_FAMILY: Object.freeze({ value: 9 }),
  CARRIER_MISMATCH: Object.freeze({ value: 10 }),
  ARENA_OVERFLOW: Object.freeze({ value: 11 }),
  PARAM_OVERFLOW: Object.freeze({ value: 12 }),
  MIGRATE_FAILED: Object.freeze({ value: 13 }),
});

export const ChainSnapshotRestoreResult = Object.freeze({
  APPLIED: Object.freeze({ value: 0 }),
  NOT_SHADER_CHAIN: Object.freeze({ value: 1 }),
  UNSUPPORTED_VERSION: Object.freeze({ value: 2 }),
  INVALID_LENGTH: Object.freeze({ value: 3 }),
  INVALID_VALUE: Object.freeze({ value: 4 }),
  INVALID_CHAIN: Object.freeze({ value: 5 }),
});

// The engine catalog exactly as the module's getShaderChainCatalog static
// exports it: the committed pin carries the export plus a POSIX trailing
// newline, which the export itself does not.
const CHAIN_CATALOG_TEXT = readFileSync(
  new URL('../../generated/shader/engine_catalog.json', import.meta.url), 'utf8',
).replace(/\n$/, '');

/**
 * Stand-in for the chain-capable engine surface src/workbench/shader/chain_apply.js drives:
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
    this.bindings = {
      setShaderChain: (entries) => this.#setShaderChain(entries),
      setShaderChainParameters: (writes) => this.#setShaderChainParameters(writes),
    };
    this.effect = null;
    this.generation = 1;
    this.effectGeneration = 0;
    /** @type {Array<*>} Payloads handed to setShaderChain, in call order. */
    this.chainCalls = [];
    /** @type {Array<[string, number]>} Accepted setParameter writes. */
    this.writes = [];
    /** @type {?{code: string, entryIndex: number}} Injected next refusal. */
    this.nextChainResult = null;
    this.definitions = [];
    this.paused = false;
  }

  setEffect(name) {
    this.effectGeneration += 1;
    this.effect = name;
    this.definitions = [];
    this.generation += 1;
    if (name === 'ShaderChain') {
      const result = this.#setShaderChain([
        { instance: 'camera', operator: 'sphere.rotate.v2' },
        { instance: 'project', operator: 'project.stereographic.v2' },
        { instance: 'sample', operator: 'sample.grid.v3' },
        { instance: 'colorize', operator: 'colorize.generated-palette.v3' },
      ]);
      this.chainCalls.pop();
      if (result.code !== 'APPLIED') throw new Error('default chain failed');
    }
    return EffectSetResult.INSTALLED;
  }

  #setShaderChain(entries) {
    this.chainCalls.push(entries);
    const refusal = (code, entryIndex = -1) => ({ status: ChainStatus[code], code, entryIndex });
    if (this.effect !== 'ShaderChain') return refusal('NOT_CHAIN_EFFECT');
    const malformed = { status: ChainStatus.MALFORMED_PAYLOAD, code: 'MALFORMED_PAYLOAD', entryIndex: -1 };
    if (!Array.isArray(entries)) return malformed;
    if (entries.length > this.catalog.budgets.max_chain_ops) return refusal('TOO_LONG');
    for (const [index, entry] of entries.entries()) {
      if (entry === null || typeof entry !== 'object'
          || typeof entry.instance !== 'string'
          || typeof entry.operator !== 'string') return refusal('MALFORMED_PAYLOAD', index);
    }
    if (this.nextChainResult !== null) {
      const injected = this.nextChainResult;
      this.nextChainResult = null;
      return { ...injected, status: ChainStatus[injected.code === 'APPLIED' ? 'OK' : injected.code] };
    }
    if (entries.length === 0) return refusal('EMPTY');
    const instances = new Set();
    for (const [index, entry] of entries.entries()) {
      if (instances.has(entry.instance)) return refusal('DUPLICATE_INSTANCE', index);
      instances.add(entry.instance);
    }
    const operators = new Map(this.catalog.operators.map((op) => [op.id, op]));
    const definitions = [];
    for (const [index, entry] of entries.entries()) {
      const operator = operators.get(entry.operator);
      if (!operator) return { status: ChainStatus.UNKNOWN_OPERATOR, code: 'UNKNOWN_OPERATOR', entryIndex: index };
      for (const field of operator.params) {
        const base = {
          name: `${entry.instance}.${field.id}`,
          animated: true, readonly: false, preset: true,
        };
        const value = field.topology ? field.values.indexOf(field.default) : Math.fround(field.default);
        definitions.push({ ...base, value, requestedValue: value, acceptedValue: value,
          ...(field.topology
            ? { min: 0, max: field.values.length - 1, step: 1, options: [...field.values] }
            : { min: Math.fround(field.min), max: Math.fround(field.max) }),
        });
      }
    }
    this.program = structuredClone(entries);
    this.definitions = definitions;
    this.generation += 1;
    return { status: ChainStatus.OK, code: 'APPLIED', entryIndex: -1 };
  }

  getShaderChainBindings() {
    if (this.effect !== 'ShaderChain') return null;
    const generation = this.effectGeneration;
    let released = false;
    const isValid = () => !released && this.effectGeneration === generation;
    return {
      isValid,
      getProgram: () => isValid() ? structuredClone(this.program) : null,
      getSnapshot: () => isValid() ? {
        schemaVersion: 2, chain: structuredClone(this.program),
        parameters: this.definitions.map((d) => ({name: d.name, value: d.acceptedValue})),
        animationsPaused: this.paused,
      } : null,
      restoreSnapshot: (snapshot) => {
        if (!isValid()) return ChainSnapshotRestoreResult.NOT_SHADER_CHAIN;
        if (snapshot?.schemaVersion !== 2) return ChainSnapshotRestoreResult.UNSUPPORTED_VERSION;
        const outcome = this.#setShaderChain(snapshot.chain);
        if (outcome.code !== 'APPLIED') return ChainSnapshotRestoreResult.INVALID_CHAIN;
        if (this.#setShaderChainParameters(snapshot.parameters) !== ParamSetResult.APPLIED)
          return ChainSnapshotRestoreResult.INVALID_VALUE;
        this.paused = snapshot.animationsPaused;
        return ChainSnapshotRestoreResult.APPLIED;
      },
      setShaderChain: (entries) => isValid() ? this.bindings.setShaderChain(entries)
        : { code: 'NOT_CHAIN_EFFECT', status: ChainStatus.NOT_CHAIN_EFFECT, entryIndex: -1 },
      setShaderChainParameters: (writes) => isValid() ? this.bindings.setShaderChainParameters(writes)
        : ParamSetResult.NO_EFFECT,
      delete: () => { released = true; },
    };
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
    const accepted = Math.fround(Math.max(definition.min, Math.min(definition.max,
      definition.options ? Math.trunc(value) : value)));
    definition.value = accepted;
    definition.requestedValue = accepted;
    definition.acceptedValue = accepted;
    this.paused = true;
    this.writes.push([name, value]);
    return ParamSetResult.APPLIED;
  }

  #setShaderChainParameters(writes) {
    if (!Array.isArray(writes)) return ParamSetResult.MALFORMED_PAYLOAD;
    if (writes.length > this.catalog.budgets.max_params) return ParamSetResult.TOO_LONG;
    for (const entry of writes) {
      if (entry === null || typeof entry !== 'object'
          || typeof entry.name !== 'string' || typeof entry.value !== 'number')
        return ParamSetResult.MALFORMED_PAYLOAD;
    }
    for (const { name, value } of writes) {
      if (!this.definitions.some((definition) => definition.name === name))
        return ParamSetResult.UNKNOWN_PARAM;
      if (typeof value !== 'number' || !Number.isFinite(value))
        return ParamSetResult.NON_FINITE;
    }
    for (const { name, value } of writes) {
      this.setParameter(name, value);
    }
    return ParamSetResult.APPLIED;
  }

  getAnimationsPaused() { return this.paused; }
  setAnimationsPaused(paused) { this.paused = paused; }

  getParamGeneration() {
    return this.generation;
  }
}

/**
 * Method names an object exposes that ENGINE_METHODS does not pin — a fake
 * mocking one of these would pass its own tests against a method the real
 * engine never had. Walks the prototype chain up to Object.prototype, so an
 * instance is checked together with the class it came from and a per-instance
 * patch cannot slip past. Static module APIs are pinned by the real-WASM
 * contract suite rather than this instance-method audit.
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
