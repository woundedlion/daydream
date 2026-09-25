/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { engineParamValue, enumConstantName } from './param_sync.js';
import { legacyShaderBallParamNames } from './shader_stages.js';

export const FULL_CONFIG_STORAGE_KEY = '__fullConfig';

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
 * @param {{getParameterDefinitions: () => Array<{name: string, readonly?: boolean, value: *, acceptedValue?: *, requestedValue?: *}>, setEngineParam: (name: string, value: number) => *, usesFullConfigSnapshot: () => boolean, getFullConfigSnapshot: () => *, restoreFullConfigSnapshot: (snapshot: *) => *, fullConfigRestoreResults: () => *, getConfigImportNotice: () => string, clearConfigImportNotice: () => void, showConfigImportNotice: (message: string|null) => void, logWarn: (...args: *) => void}} dependencies
 */
export function createEffectPersistence({
  getParameterDefinitions, setEngineParam, usesFullConfigSnapshot, getFullConfigSnapshot, restoreFullConfigSnapshot, fullConfigRestoreResults, getConfigImportNotice, clearConfigImportNotice, showConfigImportNotice, logWarn
}) {
  /** @param {string} name @returns {string} */
  const acceptedStorageKey = (name) => `__accepted.${name}`;

  /**
   * Persist the active effect through its snapshot or accepted-value surface.
   * @param {*} gui - The effect GUI holding the stored values.
   * @param {{name: string, accepted: *}} [edited] - The one parameter an edit
   *   moved, carrying the value the write settled on. Narrowing to it keeps a
   *   per-keystroke persist off the whole-definition marshal.
   * @returns {void}
   */
  function persistEffectState(gui, edited = undefined) {
    if (!usesFullConfigSnapshot()) {
      if (edited === undefined) persistAcceptedParams(gui);
      else persistAcceptedParam(gui, edited.name, edited.accepted);
      return;
    }
    const snapshot = getFullConfigSnapshot();
    if (!snapshot) return;
    gui.writeStoredValue(FULL_CONFIG_STORAGE_KEY, JSON.stringify(snapshot));
  }

  /** @param {*} gui */
  function restoreEffectState(gui) {
    if (!usesFullConfigSnapshot()) {
      restoreAcceptedParams(gui);
      return;
    }
    const text = gui.readStoredString(FULL_CONFIG_STORAGE_KEY);
    if (text === undefined) return;
    let snapshot;
    try {
      snapshot = JSON.parse(text);
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new TypeError('snapshot must be an object');
      }
      if (!Object.hasOwn(snapshot, 'schemaVersion')) snapshot.schemaVersion = 1;
    } catch (error) {
      logWarn('Shader Workbench: ignoring invalid full-config snapshot', error);
      return;
    }
    const results = fullConfigRestoreResults();
    const outcome = restoreFullConfigSnapshot(snapshot);
    if (outcome !== results.APPLIED) {
      logWarn('Shader Workbench: full-config snapshot was rejected: '
        + enumConstantName(results, outcome));
      return;
    }
    const notice = getConfigImportNotice();
    clearConfigImportNotice();
    showConfigImportNotice(notice || null);
  }

  /** @param {*} gui @param {string} name @param {*} accepted */
  function persistAcceptedParam(gui, name, accepted) {
    // The float form, not the raw value: restoreAcceptedParams() reads the
    // companion key back through the URL number grammar, which rejects a bool.
    gui.writeStoredValue(acceptedStorageKey(name), String(engineParamValue(accepted)));
  }

  /** @param {*} gui */
  function persistAcceptedParams(gui) {
    for (const parameter of getParameterDefinitions()) {
      if (parameter.readonly) continue;
      persistAcceptedParam(gui, parameter.name, acceptedParamValue(parameter));
    }
  }

  /**
   * Replay the stored accepted values into the engine. The definition list is
   * re-read after every write because a write can change it — a Shader
   * selector swaps in the controls of the stage it selects — so parameters that
   * did not exist a write ago still get their stored value. Nothing in the loop
   * writes the stored values it reads, so one probe per name settles it and the
   * rescan costs a set lookup rather than a URL read.
   * @param {*} gui - The effect GUI holding the stored values.
   * @returns {void}
   */
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
