// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {import('./chain_document_store.js').CatalogOperator} CatalogOperator */
/** @typedef {import('./chain_document_store.js').ChainEntry} ChainEntry */

/** @typedef {import('./chain_document_store.js').LegalityEntry} LegalityEntry */
/** @typedef {import('./chain_document_store.js').SequenceEntry} SequenceEntry */

/** Creates catalog and carrier legality queries over a live chain.
 * @param {{compiler: *, budgets: *, catalog: *, entryCarrier: string, exitCarrier: string,
 * chain: () => ChainEntry[], operatorOf: (entry: ChainEntry) => CatalogOperator}} dependencies */
export function createChainLegality({compiler, budgets, catalog, entryCarrier, exitCarrier, chain, operatorOf}) {
  /** @param {number} index */
  const carrierBefore = (index) =>
    index === 0 ? entryCarrier : operatorOf(chain()[index - 1]).output;
  /** @param {number} index */
  const carrierAfter = (index) =>
    index === chain().length ? exitCarrier : operatorOf(chain()[index]).input;

  /** @param {CatalogOperator[]} ops @returns {string|null} */
  const budgetReason = (ops) => compiler.chainBudgetReasons(ops, budgets)[0] ?? null;

  /**
   * @param {number} start - First chain index of the span.
   * @param {number} deleteCount - Entries the span covers.
   * @returns {string|null} Why the span is malformed, or null.
   */
  const spanError = (start, deleteCount) => {
    if (!Number.isInteger(start) || !Number.isInteger(deleteCount) ||
        start < 0 || deleteCount < 0 || start + deleteCount > chain().length)
      return `a span needs integer bounds inside the ${chain().length}-entry chain`;
    return null;
  };

  /**
   * Every catalog operator's legality as a one-operator replacement of the
   * span: carrier agreement with the span's neighbors (chain entry and exit
   * at the ends) plus the declared budgets over the resulting chain.
   * @param {number} start - First chain index of the span.
   * @param {number} deleteCount - Entries the span covers (0 = insertion).
   * @returns {LegalityEntry[]} One entry per catalog operator, in catalog order.
   * @throws {RangeError} If the span bounds are not integer positions inside the chain.
   */
  const spanLegality = (start, deleteCount) => {
    const error = spanError(start, deleteCount);
    if (error !== null) throw new RangeError(`chain document store: ${error}`);
    const before = carrierBefore(start);
    const after = carrierAfter(start + deleteCount);
    const kept = chain().map(operatorOf);
    kept.splice(start, deleteCount);
    return catalog.operators.map((/** @type {CatalogOperator} */ op) => {
      if (op.input !== before) {
        return { operator: op, legal: false,
          reason: `consumes the ${op.input} carrier; the chain carries ${before} here` };
      }
      if (op.output !== after) {
        return { operator: op, legal: false,
          reason: `produces the ${op.output} carrier; the chain needs ${after} here` };
      }
      const reason = budgetReason([...kept.slice(0, start), op, ...kept.slice(start)]);
      if (reason !== null) return { operator: op, legal: false, reason };
      return { operator: op, legal: true };
    });
  };

  /**
   * Every legal sequence of at most `maxLength` operators that replaces the
   * span, shortest first and in catalog order within a length. A sequence is
   * either the empty removal, one operator the span's neighbors accept, or a
   * run of crossings carrying the chain from the span's entry carrier to its
   * exit while crossing each carrier at most once. Every candidate is costed
   * against the declared budgets.
   * @param {number} start - First chain index of the span.
   * @param {number} deleteCount - Entries the span covers (0 = insertion).
   * @param {number} maxLength - Longest sequence to enumerate.
   * @returns {SequenceEntry[]} The legal sequences.
   * @throws {RangeError} If the span bounds are not integer positions inside the chain.
   */
  const legalSequences = (start, deleteCount, maxLength) => {
    const error = spanError(start, deleteCount);
    if (error !== null) throw new RangeError(`chain document store: ${error}`);
    const before = carrierBefore(start);
    const after = carrierAfter(start + deleteCount);
    const kept = chain().map(operatorOf);
    kept.splice(start, deleteCount);
    /** @type {CatalogOperator[][]} */
    const candidates = [];
    if (before === after) candidates.push([]);
    if (maxLength >= 1) {
      for (const op of catalog.operators)
        if (op.input === before && op.output === after) candidates.push([op]);
    }
    /** @type {{ops: CatalogOperator[], carrier: string, seen: Set<string>}[]} */
    let frontier = [{ ops: [], carrier: before, seen: new Set([before]) }];
    for (let length = 1; length <= maxLength && frontier.length > 0; length += 1) {
      /** @type {typeof frontier} */
      const next = [];
      for (const node of frontier) {
        for (const op of catalog.operators) {
          if (op.input !== node.carrier || op.input === op.output) continue;
          if (node.seen.has(op.output)) continue;
          const ops = [...node.ops, op];
          // The exit carrier ends the run: nothing may leave it and return.
          if (op.output === after) {
            if (length >= 2) candidates.push(ops);
            continue;
          }
          next.push({ ops, carrier: op.output, seen: new Set([...node.seen, op.output]) });
        }
      }
      frontier = next;
    }
    return candidates
      .filter((ops) => budgetReason(
        [...kept.slice(0, start), ...ops, ...kept.slice(start)]) === null)
      .map((operators) => ({ operators }));
  };
  return {budgetReason, spanError, spanLegality, legalSequences};
}
