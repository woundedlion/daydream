// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {refusal} from './chain_document_edits.js';

/** @typedef {{preset_id: string, display_name?: string, values: Record<string, *>}} Preset */
/** @typedef {{from: string, to: string, duration: number, easing: string, path_policy: string}} Edge */
/** @typedef {{presets: Preset[], edges: Edge[], choreography: {generated_order: string[], dwell?: Record<string, number>}}} Bank */
/** @typedef {import('./chain_document_store.js').EditResult} EditResult */

export const DEFAULT_PRESET_DWELL = 600;

/** @param {string[]} order @returns {{from: string, to: string}[]} */
export function neighbouringPresets(order) {
  return order.length < 2 ? [] : order.map((from, index) => ({
    from, to: order[(index + 1) % order.length],
  }));
}

/** @param {{from: string, to: string}} edge */
const edgeKey = ({from, to}) => from + '>' + to;

/** @param {*} candidate @param {Bank} previous */
export function reconcilePresetEdges(candidate, previous) {
  /** @type {Bank} */
  const bank = candidate.preset_bank;
  const pairs = neighbouringPresets(bank.choreography.generated_order);
  const formerlyAdjacent = new Set(neighbouringPresets(previous.choreography.generated_order).map(edgeKey));
  const adjacent = new Set(pairs.map(edgeKey));
  const ids = new Set(bank.choreography.generated_order);
  bank.edges = bank.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)
    && (!formerlyAdjacent.has(edgeKey(edge)) || adjacent.has(edgeKey(edge))));
  const existing = new Set(bank.edges.map(edgeKey));
  const missing = pairs.filter((edge) => !existing.has(edgeKey(edge)));
  if (missing.length === 0) return;

  const policies = candidate.descriptor.path_policies;
  let parallel = policies.find((/** @type {*} */ policy) => policy.kind === 'PARALLEL');
  if (!parallel) {
    let id = 'parallel';
    for (let suffix = 2; policies.some((/** @type {*} */ policy) => policy.id === id); suffix++)
      id = 'parallel-' + suffix;
    parallel = {id, kind: 'PARALLEL'};
    policies.push(parallel);
  }
  for (const pair of missing)
    bank.edges.push({...pair, path_policy: parallel.id, easing: 'EASE_IN_OUT_SIN', duration: 480});
}

/** @param {{document: () => *, commit: (candidate: *) => EditResult}} deps */
export function createPresetBankEdits({document, commit}) {
  /** @param {string} id @param {(bank: Bank, preset: Preset) => void} change */
  function edit(id, change) {
    const previous = document();
    const candidate = structuredClone(previous);
    /** @type {Bank} */
    const bank = candidate.preset_bank;
    const preset = bank.presets.find((entry) => entry.preset_id === id);
    if (!preset) return refusal('UNKNOWN_PRESET', '$.preset_bank.presets', 'Unknown preset "' + id + '".');
    change(bank, preset);
    reconcilePresetEdges(candidate, previous.preset_bank);
    return commit(candidate);
  }

  /** @param {string} id */
  function duplicatePreset(id) {
    let presetId = id + '-copy';
    const result = edit(id, (bank, preset) => {
      const {generated_order: order, dwell} = bank.choreography;
      for (let suffix = 2; order.includes(presetId); suffix++)
        presetId = id + '-copy-' + suffix;
      const copy = structuredClone(preset);
      copy.preset_id = presetId;
      copy.display_name = (preset.display_name ?? id) + ' Copy';
      bank.presets.splice(bank.presets.indexOf(preset) + 1, 0, copy);
      order.splice(order.indexOf(id) + 1, 0, presetId);
      if (dwell) dwell[presetId] = dwell[id];
    });
    return result.ok ? {...result, presetId} : result;
  }

  return {
    addPreset: duplicatePreset,
    duplicatePreset,
    /** @param {string} id @param {string} displayName */
    renamePreset: (id, displayName) => edit(id, (_bank, preset) => { preset.display_name = displayName; }),
    /** @param {string} id */
    deletePreset(id) {
      if (document().preset_bank.presets.length === 1)
        return refusal('LAST_PRESET', '$.preset_bank.presets', 'The show needs at least one preset.');
      return edit(id, (bank, preset) => {
        bank.presets.splice(bank.presets.indexOf(preset), 1);
        const {generated_order: order, dwell} = bank.choreography;
        order.splice(order.indexOf(id), 1);
        if (dwell) delete dwell[id];
      });
    },
    /** @param {string} id @param {number} index - Final position. */
    movePreset(id, index) {
      if (!Number.isInteger(index) || index < 0 || index >= document().preset_bank.presets.length)
        return refusal('INVALID_PRESET_POSITION', '$.preset_bank.choreography.generated_order',
          'The preset position is outside the rail.');
      return edit(id, (bank) => {
        const order = bank.choreography.generated_order;
        order.splice(order.indexOf(id), 1);
        order.splice(index, 0, id);
      });
    },
    /** @param {string} from @param {string} to @param {Partial<Pick<Edge, 'duration'|'easing'|'path_policy'>>} settings */
    setPresetEdge(from, to, settings) {
      const previous = document();
      const candidate = structuredClone(previous);
      reconcilePresetEdges(candidate, previous.preset_bank);
      /** @type {Bank} */
      const bank = candidate.preset_bank;
      const edge = bank.edges.find((edge) => edge.from === from && edge.to === to);
      if (!edge) return refusal('ABSENT_EDGE', '$.preset_bank.edges', 'There is no edge between these presets.');
      Object.assign(edge, settings);
      return commit(candidate);
    },
    /** @param {string} id @param {number} value */
    setPresetDwell: (id, value) => edit(id, (bank) => {
      const {generated_order: order, dwell} = bank.choreography;
      bank.choreography.dwell = Object.fromEntries(order.map((key) => [
        key, key === id ? value : (dwell?.[key] ?? DEFAULT_PRESET_DWELL),
      ]));
    }),
  };
}
