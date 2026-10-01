/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { engineParamValue, enumConstantName } from './param_sync.js';
import { legacyShaderBallParamNames } from './shader_stages.js';

export const CHAIN_SNAPSHOT_STORAGE_KEY = '__chainSnapshot';
export const LEGACY_CONFIG_STORAGE_KEY = '__fullConfig';
export const LEGACY_SIDECAR_STORAGE_KEY = '__legacyShader';

/**
 * The value the engine last took for one parameter: what it admitted for
 * rendering, else the writable target it holds, else the value it renders. A
 * definition that carries no accepted value still names a target, which is what
 * a replay writes back; the rendered value is an animation frame.
 * @param {{acceptedValue?: *, requestedValue?: *, value: *}} parameter - Engine
 *   parameter definition.
 * @returns {*} The accepted value, in the definition's own type.
 */
export function acceptedParamValue(parameter) {
  return parameter.acceptedValue ?? parameter.requestedValue ?? parameter.value;
}

/**
 * URL storage and replay of engine-accepted effect state.
 * @param {{getParameterDefinitions: () => Array<{name: string, readonly?: boolean, value: *, acceptedValue?: *, requestedValue?: *}>, setEngineParam: (name: string, value: number) => *, usesChainSnapshot: () => boolean, getSnapshot: () => *, restoreSnapshot: (snapshot: *) => *, chainSnapshotRestoreResults: () => *, showConfigImportNotice: (message: string|null) => void, logWarn: (...args: *) => void}} dependencies
 */
export function createEffectPersistence({
  getParameterDefinitions, setEngineParam, usesChainSnapshot, getSnapshot, restoreSnapshot, chainSnapshotRestoreResults, showConfigImportNotice, logWarn
}) {
  /** @param {string} name @returns {string} */
  const acceptedStorageKey = (name) => `__accepted.${name}`;
  const restoredKeys = new Set();
  let refusedSnapshot = false;

  /**
   * Persist the active effect through its snapshot or accepted-value surface.
   * @param {*} gui - The effect GUI holding the stored values.
   * @param {{name: string, accepted: *}} [edited] - The one parameter an edit
   *   moved, carrying the value the write settled on. Narrowing to it keeps a
   *   per-keystroke persist off the whole-definition marshal.
   * @param {boolean} [existingOnly=false] - Rewrite only restored companion keys.
   * @returns {void}
   */
  function persistEffectState(gui, edited = undefined, existingOnly = false) {
    if (!usesChainSnapshot()) {
      if (edited === undefined) persistAcceptedParams(gui, existingOnly);
      else persistAcceptedParam(gui, edited.name, edited.accepted);
      return;
    }
    if (refusedSnapshot || (gui.readStoredString(LEGACY_CONFIG_STORAGE_KEY) !== undefined
        && gui.readStoredString(LEGACY_SIDECAR_STORAGE_KEY) === undefined)) return;
    const snapshot = getSnapshot();
    if (!snapshot) return;
    gui.writeStoredValue(CHAIN_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  }

  /** Replay a stored chain snapshot or accepted parameter values. @param {*} gui */
  function restoreEffectState(gui) {
    restoredKeys.clear();
    refusedSnapshot = false;
    if (!usesChainSnapshot()) {
      restoreAcceptedParams(gui);
      return;
    }
    const text = gui.readStoredString(CHAIN_SNAPSHOT_STORAGE_KEY);
    if (text === undefined) return;
    let snapshot;
    try {
      snapshot = JSON.parse(text);
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new TypeError('snapshot must be an object');
      }
    } catch (error) {
      refusedSnapshot = true;
      showConfigImportNotice('The chain snapshot is invalid. Its original text remains preserved.');
      logWarn('Shader Workbench: invalid chain snapshot', error);
      return;
    }
    const results = chainSnapshotRestoreResults();
    const outcome = restoreSnapshot(snapshot);
    if (outcome !== results.APPLIED) {
      refusedSnapshot = true;
      showConfigImportNotice('The chain snapshot was rejected. Its original text remains preserved.');
      logWarn('Shader Workbench: chain snapshot was rejected: '
        + enumConstantName(results, outcome));
      return;
    }
    showConfigImportNotice(null);
  }

  /** Store one accepted numeric value for URL canonicalization. @param {*} gui @param {string} name @param {*} accepted */
  function persistAcceptedParam(gui, name, accepted) {
    gui.writeStoredValue(acceptedStorageKey(name), engineParamValue(accepted));
  }

  /** Store writable accepted parameters. @param {*} gui @param {boolean} existingOnly */
  function persistAcceptedParams(gui, existingOnly) {
    for (const parameter of getParameterDefinitions()) {
      if (parameter.readonly) continue;
      if (existingOnly && !restoredKeys.has(parameter.name)) continue;
      persistAcceptedParam(gui, parameter.name, acceptedParamValue(parameter));
    }
  }

  /** @param {*} gui @returns {void} */
  function restoreAcceptedParams(gui) {
    const probed = new Set();
    for (;;) {
      let parameter;
      let value;
      for (const candidate of getParameterDefinitions()) {
        if (candidate.readonly || probed.has(candidate.name)) continue;
        probed.add(candidate.name);
        const stored = gui.readStoredNumber(
          acceptedStorageKey(candidate.name),
          legacyShaderBallParamNames(candidate.name).map(acceptedStorageKey));
        if (stored === undefined) continue;
        restoredKeys.add(candidate.name);
        parameter = candidate;
        value = stored;
        break;
      }
      if (!parameter) return;
      setEngineParam(parameter.name, value);
    }
  }

  return { persist: persistEffectState, restore: restoreEffectState };
}
