// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {BAKED_PARAMETER_REASON} from './chain_param_rows.js';
import {MODULATION_OPERATOR} from './chain_presentation.js';
import {BYPASS_UNAVAILABLE} from './chain_strip_context.js';

/** @typedef {import('./chain_document_store.js').EditResult} EditResult */
/** @typedef {ReturnType<typeof createStripCommands>} StripCommands */

/**
 * Creates document commands with render and parameter-edit callbacks.
 * @param {import('./chain_strip_context.js').StripContext} context
 */
export function createStripCommands(context) {
  const {store, view, announce, bypassAvailable, parameterLive, presetId, commit} = context;
  /**
   * Surfaces a store refusal in the shared live region.
   * @param {EditResult} result - The refused edit.
   * @returns {false} Always false, for tail-calling.
   */
  const report = (result) => {
    if (result.ok === false) {
      announce(result.diagnostics[0]?.message ?? 'the edit was refused');
    }
    return false;
  };

  /**
   * Moves the chip at one chain index to a gap, as the m-for-m span replacement
   * that keeps every label (and so every parameter value).
   * @param {number} index - The chip's chain index.
   * @param {number} gap - Target gap, 0..chain length.
   * @returns {boolean} Whether the move committed.
   */
  const moveChip = (index, gap) => {
    const chain = store.chain();
    if (gap < 0 || gap > chain.length) return false;
    if (gap === index || gap === index + 1) return true;
    const entry = chain[index];
    const result = gap < index
      ? store.replaceSpan(gap, index - gap + 1, [entry, ...chain.slice(gap, index)])
      : store.replaceSpan(index, gap - index, [...chain.slice(index + 1, gap), entry]);
    if (!result.ok) return report(result);
    return commit(entry.label);
  };

  /**
   * Removes one endomorphism, the empty span replacement legality makes
   * automatic. Focus lands on whatever fills the vacated position.
   * @param {number} index - The chip's chain index.
   * @returns {boolean} Whether the removal committed.
   */
  const removeChip = (index) => {
    const result = store.replaceSpan(index, 1, []);
    if (!result.ok) return report(result);
    const after = store.chain();
    return commit(after[index]?.label ?? after[index - 1]?.label ?? null);
  };

  /**
   * Toggles a modulation's authored enabled state or another stage's session bypass.
   * @param {string} label - The instance label.
   * @param {string|null} [focusControl] - Header control to retain after a pointer toggle.
   * @returns {void}
   */
  const toggleStage = (label, focusControl = null) => {
    if (store.chain().find((entry) => entry.label === label)?.operator === MODULATION_OPERATOR) {
      const id = `${label}.modulation-enabled`;
      if (!parameterLive(id)) {
        announce(BAKED_PARAMETER_REASON);
        return;
      }
      context.parameterRows.editParameter(id, view.values[id] === 'disabled' ? 'enabled' : 'disabled');
      store.endValueRun();
      context.parameterRows.commitParameter();
      return;
    }
    if (!bypassAvailable()) {
      announce(BYPASS_UNAVAILABLE);
      return;
    }
    const on = !store.bypassedLabels().includes(label);
    const result = store.setBypassed(label, on);
    if (!result.ok) {
      report(result);
      return;
    }
    commit(label, focusControl);
  };

  /** @param {string|null} [focusAction] */
  const undo = (focusAction = null) => {
    if (!store.undo()) return false;
    return commit(view.focusedLabel, null, focusAction);
  };

  /** @param {string} label - The instance whose editable parameters reset. */
  const resetParameters = (label) => {
    context.parameterRows.flushParameterEdit();
    const defaults = Object.fromEntries(view.declarations
      .filter((parameter) => parameter.id.startsWith(`${label}.`) && store.declares(parameter.id) && parameterLive(parameter.id))
      .map((parameter) => [parameter.id, parameter.default]));
    if (Object.keys(defaults).length === 0
        || Object.entries(defaults).every(([id, value]) => view.values[id] === value)) return;
    const targetPreset = presetId() ?? store.document().preset_bank.presets[0]?.preset_id;
    if (!targetPreset) return;
    store.endValueRun();
    const result = store.setPresetValues(targetPreset, defaults);
    store.endValueRun();
    if (!result.ok) {
      report(result);
      return;
    }
    commit(label, '.chain-chip-reset');
    context.parameterRows.commitParameter();
  };

  /** @param {string|null} [focusAction] */
  const redo = (focusAction = null) => {
    if (!store.redo()) return false;
    return commit(view.focusedLabel, null, focusAction);
  };

  return {report, moveChip, removeChip, toggleStage, undo, redo, resetParameters};
}
