// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { engineHalted } from '../shared/engine_halt.js';

/**
 * @param {*} engine
 * @param {'getShaderChainBindings'|'getLegacyShaderBindings'} accessor
 * @param {string} method
 * @param {Array<*>} args
 * @param {*} unavailable
 * @returns {*}
 */
export function callWorkbenchBinding(engine, accessor, method, args, unavailable = null) {
  if (!engine) return unavailable;
  if (typeof engine[accessor] !== 'function')
    return engine[method]?.(...args) ?? unavailable;
  const bindings = engine[accessor]();
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

/** @param {*} module @returns {string} */
export function shaderChainCatalog(module) {
  return (module.ShaderChainBindings ?? module.HolosphereEngine).getShaderChainCatalog();
}
