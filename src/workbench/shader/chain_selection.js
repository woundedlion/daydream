/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * @param {object} deps
 * @param {import('./chain_document_store.js').ChainStore} deps.store
 * @param {Set<string>} deps.pinnedLabels
 * @param {(label: string) => void} deps.setFocusedLabel
 * @param {(options: {focusLabel: string}) => void} deps.render
 */
export function createChainSelection({store, pinnedLabels, setFocusedLabel, render}) {
  /**
   * Toggles a chip's pin and selection and re-renders.
   * @param {string} label - The instance label.
   * @returns {void}
   */
  const select = (label) => {
    const open = !pinnedLabels.has(label);
    const selected = open ? label : store.selectedLabel() === label ? null : store.selectedLabel();
    if (!store.setSelectedLabel(selected)) return;
    if (selected !== null) setFocusedLabel(selected);
    if (open) pinnedLabels.add(label);
    else pinnedLabels.delete(label);
    render({ focusLabel: label });
  };
  return select;
}
