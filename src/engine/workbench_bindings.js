// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { engineHalted } from '../shared/engine_halt.js';

/**
 * Calls a workbench method and releases its temporary handle. Errors propagate;
 * an engine halt skips release.
 * @param {*} engine - Engine exposing optional workbench bindings.
 * @param {string} method - Method to invoke on the handle.
 * @param {Array<*>} args - Method arguments.
 * @param {*} unavailable - Result when bindings are absent, including fixed effects.
 * @returns {*} The method result or unavailable value.
 */
export function callWorkbenchBinding(engine, method, args, unavailable = null) {
  if (!engine) return unavailable;
  if (typeof engine.getShaderChainBindings !== 'function') return unavailable;
  const bindings = engine.getShaderChainBindings();
  if (!bindings) return unavailable;
  let release = true;
  try {
    return bindings[method](...args);
  } catch (error) {
    release = !engineHalted(error);
    throw error;
  } finally {
    if (release) bindings.delete();
  }
}

/**
 * Reads the module's shader operator catalog as JSON.
 * @param {*} module - Initialized engine module.
 * @returns {string} Shader operator catalog JSON.
 */
export function shaderChainCatalog(module) {
  return module.ShaderChainBindings.getShaderChainCatalog();
}

/** @param {*} engine @returns {*} Chain snapshot or null. */
export function getChainSnapshot(engine) {
  return callWorkbenchBinding(engine, 'getSnapshot', []);
}

/** @param {*} snapshot @param {*} catalog @returns {*} Snapshot with total Twist angles in radians. */
export function upgradeTwistSnapshot(snapshot, catalog) {
  const schema = catalog?.operators?.find((/** @type {*} */ operator) => operator.id === 'sphere.lens.twist.v2');
  if (!schema?.params?.some((/** @type {*} */ field) => field.id === 'twist-angle')) return snapshot;
  if (![3, 4].includes(snapshot?.schemaVersion)
      || !Array.isArray(snapshot.chain) || !Array.isArray(snapshot.parameters)
      || !Array.isArray(snapshot.modulation)) return snapshot;
  if (snapshot.chain.some((/** @type {*} */ entry) => !entry || typeof entry.instance !== 'string'
      || typeof entry.operator !== 'string')
      || snapshot.parameters.some((/** @type {*} */ entry) => !entry || typeof entry.name !== 'string'
        || typeof entry.value !== 'number' || !Number.isFinite(Math.fround(entry.value)))) return snapshot;
  const instances = new Set(snapshot.chain.map((/** @type {*} */ entry) => entry.instance));
  const parameters = new Map(snapshot.parameters.map((/** @type {*} */ entry) => [entry.name, entry]));
  if (instances.size !== snapshot.chain.length || parameters.size !== snapshot.parameters.length) return snapshot;
  /** @type {Map<string, number>} */
  const angles = new Map();
  for (const entry of snapshot.chain) {
    if (entry.operator !== 'sphere.lens.twist.v2') continue;
    const name = `${entry.instance}.twist-rate`;
    const parameter = parameters.get(name);
    if (!parameter) continue;
    if (parameters.has(`${entry.instance}.twist-angle`)) return snapshot;
    const rate = Math.fround(parameter.value);
    const distribution = Math.fround(parameters.get(`${entry.instance}.twist-distribution`)?.value ?? 0.85);
    if (rate < -12 || rate > 12 || distribution < 0 || distribution > 1) return snapshot;
    const a = 0.999 * distribution;
    const angle = Math.fround(2 * rate * (a === 0 ? 1 : Math.atanh(a) / a));
    if (!Number.isFinite(angle) || Math.abs(angle) > 96) return snapshot;
    angles.set(name, angle);
  }
  if (angles.size === 0) return snapshot;
  const result = structuredClone(snapshot);
  for (const parameter of result.parameters) {
    const angle = angles.get(parameter.name);
    if (angle === undefined) continue;
    parameter.name = parameter.name.replace(/twist-rate$/, 'twist-angle');
    parameter.value = angle;
  }
  return result;
}

/**
 * @param {*} engine
 * @param {*} module
 * @param {*} snapshot
 * @returns {*} Native snapshot restore result.
 */
export function restoreChainSnapshot(engine, module, snapshot) {
  if (engine && Array.isArray(snapshot?.parameters) && snapshot.parameters.some(
    (/** @type {*} */ entry) => typeof entry?.name === 'string' && entry.name.endsWith('.twist-rate'))) {
    const catalog = typeof module.ShaderChainBindings?.getShaderChainCatalog === 'function'
      ? JSON.parse(shaderChainCatalog(module)) : null;
    snapshot = upgradeTwistSnapshot(snapshot, catalog);
  }
  return callWorkbenchBinding(engine, 'restoreSnapshot', [snapshot],
    module.ChainSnapshotRestoreResult.NOT_SHADER_CHAIN);
}
