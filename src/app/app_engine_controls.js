/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {enumConstantName} from '../effects/param_sync.js';
import {callWorkbenchBinding} from '../engine/workbench_bindings.js';
const PARAM_NOTICE = 'param';

/** @param {import('./app_context.js').AppServices} deps */
export function createEngineControls({host, loaded, segments, applyNotice}) {
  /**
   * Write one parameter value to the main engine. setParameter returns a
   * Module.ParamSetResult enum value; compare against the enum, never by
   * truthiness (every enum value is a truthy object).
   * @param {string} name - The engine parameter name.
   * @param {number} value - The float value to write.
   * @param {object} [gesture] - Shared by the edits of one pointer gesture.
   * @returns {boolean} True when the engine accepted the value.
   */
  function setEngineParam(name, value, gesture) {
    const result = loaded.engine.setParameter(name, value);
    if (result !== loaded.module.ParamSetResult.APPLIED) {
      const message = `Parameter "${name}" was rejected: `
        + `${enumConstantName(loaded.module.ParamSetResult, result)}.`;
      console.warn(message);
      applyNotice.show(message, PARAM_NOTICE, gesture);
    } else {
      applyNotice.show(null, PARAM_NOTICE);
    }
    return result === loaded.module.ParamSetResult.APPLIED;
  }

  /**
   * Hold or resume animation on every live engine instance.
   * @param {boolean} paused - Whether animation is held.
   * @returns {void}
   * @details The flag is per module instance, so the main engine and every
   *   pool worker each need their own write.
   */
  function setAnimationsPaused(paused) {
    loaded.engine.setAnimationsPaused(paused);
    segments.setAnimationsPaused(paused);
  }

  /** @returns {boolean} */
  function usesChainSnapshot() {
    if (host.moduleDead() || !host.module?.ChainSnapshotRestoreResult) return false;
    return callWorkbenchBinding(host.engine, 'isValid', [], false);
  }

  return {setEngineParam, setAnimationsPaused, usesChainSnapshot};
}
