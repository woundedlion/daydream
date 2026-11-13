// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {import('./chain_document_store.js').CatalogOperator} CatalogOperator */
/** @typedef {import('./chain_document_store.js').ChainEntry} ChainEntry */

/** @typedef {import('./chain_document_store.js').Diagnostic} Diagnostic */
/** @typedef {import('./chain_document_store.js').EditResult} EditResult */

/** @typedef {{doc: *, selected: string|null, coalesceKey: string|null, bypassed: Set<string>, undoStack: Object[], redoStack: Object[]}} ChainSession */
/** Creates validated history and prunes session selection after document swaps.
 * @param {{state: ChainSession, chain: () => ChainEntry[], operatorOf: (entry: ChainEntry) => CatalogOperator,
 * isEndomorphism: (operator: CatalogOperator) => boolean, diagnosticsOf: (candidate: *) => Diagnostic[], undoDepth: number}} dependencies */
export function createChainHistory({state, chain, operatorOf, isEndomorphism, diagnosticsOf, undoDepth}) {
  const pruneSession = () => {
    const live = new Map(chain().map((entry) => [entry.label, operatorOf(entry)]));
    if (state.selected !== null && !live.has(state.selected)) state.selected = null;
    for (const label of [...state.bypassed]) {
      const op = live.get(label);
      if (op === undefined || !isEndomorphism(op)) state.bypassed.delete(label);
    }
  };

  /**
   * Validates a candidate and, when green, makes it current under one undo
   * entry. A refused candidate is discarded whole.
   * @param {*} candidate - The reconciled document to adopt.
   * @param {string|null} [coalesce] - Control key consecutive commits share one
   *   undo entry under, so a slider drag's stream of writes is undone whole.
   *   Null for a structural edit, which also ends any open run.
   * @param {(() => EditResult)|null} [admit] - Admission after document validation.
   * @returns {EditResult} The outcome.
   * @details History past undoDepth entries is dropped oldest first. Redo
   * entries only ever come off the undo stack, so the pair stays within it.
   */
  const commit = (candidate, coalesce = null, admit = null) => {
    const diagnostics = diagnosticsOf(candidate);
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    const admission = admit?.();
    if (admission && !admission.ok) return admission;
    if (coalesce === null || coalesce !== state.coalesceKey) {
      state.undoStack.push(state.doc);
      if (state.undoStack.length > undoDepth) state.undoStack.shift();
    }
    state.coalesceKey = coalesce;
    state.redoStack.length = 0;
    state.doc = candidate;
    pruneSession();
    return { ok: true };
  };
  return {commit, history: {
    /** Ends a control's coalesced value run so its next gesture opens a new entry. */
    endValueRun: () => { state.coalesceKey = null; },

    /** @returns {boolean} Whether an edit or coalesced value run can be undone. */
    canUndo: () => state.undoStack.length > 0,

    /** @returns {boolean} Whether an undone edit can be reapplied. */
    canRedo: () => state.redoStack.length > 0,

    /**
     * Reverts the last edit or coalesced value run, reconciliation included.
     * Selection and bypass are session state, not history: they are pruned
     * against the restored chain, never restored.
     * @returns {boolean} Whether an edit was undone.
     */
    undo: () => {
      const previous = state.undoStack.pop();
      if (previous === undefined) return false;
      state.redoStack.push(state.doc);
      state.doc = previous;
      state.coalesceKey = null;
      pruneSession();
      return true;
    },

    /** @returns {boolean} Whether an undone edit was reapplied. */
    redo: () => {
      const next = state.redoStack.pop();
      if (next === undefined) return false;
      state.undoStack.push(state.doc);
      state.doc = next;
      state.coalesceKey = null;
      pruneSession();
      return true;
    }
  }};
}
