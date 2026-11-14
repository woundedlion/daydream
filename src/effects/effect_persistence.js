/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { acceptedParamValue, engineParamValue, enumConstantName } from './param_sync.js';

export const CHAIN_SNAPSHOT_STORAGE_KEY = '__chainSnapshot';

/** @typedef {import('../../generated/holosphere_wasm.js').ChainSnapshot} ChainSnapshot */

/**
 * The fields persistence reads from an engine parameter definition.
 * @typedef {Pick<import('../../generated/holosphere_wasm.js').ParameterDefinitionBase, 'name'>
 *   & {readonly?: boolean, value: number|boolean, acceptedValue?: number|boolean,
 *   requestedValue?: number|boolean}} PersistedParameter
 */

/**
 * The engine surface effect state is captured from and replayed into.
 * @typedef {Object} PersistenceEngine
 * @property {() => ReadonlyArray<PersistedParameter>} getParameterDefinitions - The
 *   active effect's parameter definitions.
 * @property {(name: string, value: number) => boolean} setParam - Writes one
 *   parameter; false when the engine refused it.
 * @property {() => boolean} usesChainSnapshot - Whether the active effect persists
 *   through the chain snapshot instead of per-parameter accepted values.
 * @property {() => ChainSnapshot|null} getSnapshot - Captures the active chain.
 * @property {(snapshot: ChainSnapshot) => unknown} restoreSnapshot - Atomically
 *   restores a chain, returning one ChainSnapshotRestoreResult value.
 * @property {() => Readonly<Record<string, unknown>>} restoreResults - The
 *   ChainSnapshotRestoreResult enum the outcome is judged against by identity.
 */

/**
 * The page surface persistence reports through.
 * @typedef {Object} PersistenceUi
 * @property {(message: string|null) => void} showImportNotice - Shows or clears
 *   the snapshot import notice.
 * @property {(message: string, error?: unknown) => void} logWarn - Console sink.
 */

/**
 * The effect GUI's URL companion storage.
 * @typedef {Object} PersistenceGui
 * @property {(prop: string) => number|undefined} readStoredNumber
 * @property {(prop: string) => string|undefined} readStoredString
 * @property {(prop: string, value: string|number|boolean|null|undefined) => void} writeStoredValue
 */

/**
 * URL storage and replay of engine-accepted effect state.
 * @param {PersistenceEngine} engine - Engine state source and sink.
 * @param {PersistenceUi} ui - Notice and console sinks.
 * @returns {{persist: (gui: PersistenceGui, options?: {edited?: {name: string, accepted: number|boolean}, existingOnly?: boolean}) => void,
 *   restore: (gui: PersistenceGui) => void}} The persistence pair.
 */
export function createEffectPersistence(engine, ui) {
  const {
    getParameterDefinitions, setParam: setEngineParam, usesChainSnapshot, getSnapshot,
    restoreSnapshot, restoreResults: chainSnapshotRestoreResults,
  } = engine;
  const { showImportNotice: showConfigImportNotice, logWarn } = ui;
  /** @param {string} name @returns {string} */
  const acceptedStorageKey = (name) => `__accepted.${name}`;
  const restoredKeys = new Set();
  let refusedSnapshot = false;

  /**
   * Persist the active effect through its snapshot or accepted-value surface.
   * @param {PersistenceGui} gui - The effect GUI holding the stored values.
   * @param {Object} [options]
   * @param {{name: string, accepted: number|boolean}} [options.edited] - The one parameter an
   *   edit moved, carrying the value the write settled on.
   * @param {boolean} [options.existingOnly=false] - Rewrite only restored companion keys.
   * @returns {void}
   */
  function persistEffectState(gui, { edited = undefined, existingOnly = false } = {}) {
    if (!usesChainSnapshot()) {
      if (edited === undefined) persistAcceptedParams(gui, { existingOnly });
      else persistAcceptedParam(gui, edited.name, edited.accepted);
      return;
    }
    if (refusedSnapshot) return;
    const snapshot = getSnapshot();
    if (!snapshot) return;
    gui.writeStoredValue(CHAIN_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  }

  /** Replay a stored chain snapshot or accepted parameter values. @param {PersistenceGui} gui */
  function restoreEffectState(gui) {
    restoredKeys.clear();
    refusedSnapshot = false;
    if (!usesChainSnapshot()) {
      restoreAcceptedParams(gui);
      return;
    }
    const text = gui.readStoredString(CHAIN_SNAPSHOT_STORAGE_KEY);
    if (text === undefined) return;
    /** @type {ChainSnapshot} */
    let snapshot;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new TypeError('snapshot must be an object');
      }
      snapshot = parsed;
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

  /** Store one accepted numeric value for URL canonicalization. @param {PersistenceGui} gui @param {string} name @param {number|boolean} accepted */
  function persistAcceptedParam(gui, name, accepted) {
    gui.writeStoredValue(acceptedStorageKey(name), engineParamValue(accepted));
  }

  /**
   * Store writable accepted parameters.
   * @param {PersistenceGui} gui
   * @param {{existingOnly: boolean}} options - Rewrite only restored companion keys.
   */
  function persistAcceptedParams(gui, { existingOnly }) {
    for (const parameter of getParameterDefinitions()) {
      if (parameter.readonly) continue;
      if (existingOnly && !restoredKeys.has(parameter.name)) continue;
      persistAcceptedParam(gui, parameter.name, acceptedParamValue(parameter));
    }
  }

  /**
   * Replay stored accepted values, rereading the schema after every write and
   * retrying refused writes while some retry applies.
   * @param {PersistenceGui} gui
   * @returns {void}
   */
  function restoreAcceptedParams(gui) {
    const probed = new Set();
    /** @type {Map<string, number>} */
    const refused = new Map();
    /** @param {string} name @param {number} value @returns {boolean} */
    const apply = (name, value) => {
      if (setEngineParam(name, value) === false) return false;
      refused.delete(name);
      restoredKeys.add(name);
      return true;
    };
    for (;;) {
      const writable = getParameterDefinitions().filter((candidate) => !candidate.readonly);
      /** @type {{name: string, value: number}|undefined} */
      let found;
      for (const candidate of writable) {
        if (probed.has(candidate.name)) continue;
        probed.add(candidate.name);
        const stored = gui.readStoredNumber(acceptedStorageKey(candidate.name));
        if (stored === undefined) continue;
        found = { name: candidate.name, value: stored };
        break;
      }
      if (found) {
        if (!apply(found.name, found.value)) refused.set(found.name, found.value);
        continue;
      }
      const names = new Set(writable.map((candidate) => candidate.name));
      if (![...refused].some(([name, retried]) => names.has(name) && apply(name, retried))) return;
    }
  }

  return { persist: persistEffectState, restore: restoreEffectState };
}
