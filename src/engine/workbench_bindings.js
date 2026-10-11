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
 * @param {'getShaderChainBindings'} accessor - Binding-handle accessor.
 * @param {string} method - Method to invoke on the handle.
 * @param {Array<*>} args - Method arguments.
 * @param {*} unavailable - Result when bindings are absent, including fixed effects.
 * @returns {*} The method result or unavailable value.
 */
export function callWorkbenchBinding(engine, accessor, method, args, unavailable = null) {
  if (!engine) return unavailable;
  if (typeof engine[accessor] !== 'function') return unavailable;
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

/**
 * Reads the module's shader operator catalog as JSON.
 * @param {*} module - Initialized engine module.
 * @returns {string} Shader operator catalog JSON.
 */
export function shaderChainCatalog(module) {
  return module.ShaderChainBindings.getShaderChainCatalog();
}
