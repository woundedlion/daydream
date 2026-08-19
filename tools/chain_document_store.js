// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

const COMPILER_URL = new URL('../shader/shader_workbench.mjs', import.meta.url).href;

// Mirror of the compiler's LABEL_PATTERN (shader/shader_workbench.mjs).
const LABEL_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** @typedef {{id: string, name?: string, min?: number, max?: number, default: *, curve?: string, topology?: boolean, values?: string[]}} CatalogField */
/** @typedef {{id: string, name: string, input: string, output: string, blocks?: *, params: CatalogField[]}} CatalogOperator */
/** @typedef {{label: string, operator: string}} ChainEntry */
/** @typedef {{label?: string, operator: string}} ChainEdit */
/** @typedef {{severity: string, phase: string, code: string, path: string, message: string}} Diagnostic */
/** @typedef {{ok: true}|{ok: false, diagnostics: Diagnostic[]}} EditResult */
/** @typedef {{operator: CatalogOperator, legal: boolean, reason?: string}} LegalityEntry */
/** @typedef {{id: string, classification: string, storage: string, unit: string, domain: *, interpolation: *, default: *}} ParameterDeclaration */

/**
 * A single-diagnostic edit refusal.
 * @param {string} code - Diagnostic code.
 * @param {string} path - JSON path the refusal is about.
 * @param {string} message - Human-readable reason.
 * @returns {EditResult} The refusal.
 */
const refusal = (code, path, message) => ({
  ok: false,
  diagnostics: [{ severity: 'error', phase: 'edit', code, path, message }],
});

// Mirror of the validator's per-operator arena rounding.
/** @param {*} blocks */
const blockBytes = (blocks) =>
  ['param', 'prepared', 'state'].reduce((total, kind) => {
    const block = blocks?.[kind] ?? { size: 0, align: 1 };
    const align = Math.max(1, block.align);
    return total + Math.ceil(block.size / align) * align;
  }, 0);

/**
 * The document parameter declaration a catalog field backfills as: the
 * catalog's domain and default under the interpolation trait its curve names.
 * @param {string} label - Owning chain instance label.
 * @param {CatalogField} field - Catalog schema field.
 * @returns {ParameterDeclaration} A descriptor.parameters entry.
 */
const parameterFromField = (label, field) => {
  if (field.topology) {
    return {
      id: `${label}.${field.id}`,
      classification: 'preset',
      storage: 'enum8',
      unit: 'mode',
      domain: { values: [...(field.values ?? [])] },
      interpolation: { kind: 'MIXED_ENUM' },
      default: field.default,
    };
  }
  const kind = field.curve === 'LOG_POSITIVE' || field.curve === 'SHORTEST_PERIODIC'
    ? field.curve : 'LINEAR';
  return {
    id: `${label}.${field.id}`,
    classification: 'preset',
    storage: 'binary32',
    unit: kind === 'SHORTEST_PERIODIC' ? 'radian' : 'ratio',
    domain: { minimum: field.min, maximum: field.max },
    interpolation: kind === 'SHORTEST_PERIODIC'
      ? { kind, period: field.max } : { kind },
    default: field.default,
  };
};

/**
 * Creates the chain editor's document state machine: a validated chain
 * document, a selection, a session bypass set and an undo history, mutated
 * through one span-replacement primitive that reconciles the whole document
 * atomically and never commits anything the v2 validator refuses.
 * @param {Object} options - Store dependencies.
 * @param {*} options.document - A compiled (post-expansion, valid) v2 document.
 * @param {*} options.catalog - The operator catalog the document validates against.
 * @param {() => Promise<*>} [options.importCompiler] - Loads the document compiler.
 * @returns {Promise<Object>} The store.
 */
export async function createChainDocumentStore({
  document,
  catalog,
  importCompiler = () => import(COMPILER_URL),
}) {
  const compiler = await importCompiler();
  if (catalog === null || typeof catalog !== 'object' ||
      !Array.isArray(catalog.carriers) || !Array.isArray(catalog.operators) ||
      catalog.budgets === null || typeof catalog.budgets !== 'object') {
    throw new Error('chain document store: an operator catalog with carriers, '
      + 'operators and budgets is required');
  }
  /** @type {Map<string, CatalogOperator>} */
  const operators = new Map(catalog.operators.map(
    (/** @type {CatalogOperator} */ op) => [op.id, op]));
  const budgets = catalog.budgets;
  const entryCarrier = catalog.carriers[0];
  const exitCarrier = catalog.carriers[catalog.carriers.length - 1];

  /** @param {*} candidate */
  const diagnosticsOf = (candidate) => {
    try {
      return compiler.validateShaderDocument(candidate, { catalog });
    } catch (error) {
      if (error instanceof compiler.ShaderDocumentError)
        return [/** @type {{diagnostic: () => Diagnostic}} */ (error).diagnostic()];
      throw error;
    }
  };

  let doc = structuredClone(document);
  {
    const diagnostics = diagnosticsOf(doc);
    if (diagnostics.length > 0) {
      throw new Error('chain document store: the document fails validation: '
        + diagnostics.map((/** @type {Diagnostic} */ d) => d.code).join(', '));
    }
  }

  /** @type {string|null} */
  let selected = null;
  /** @type {Set<string>} */
  const bypassed = new Set();
  /** @type {Object[]} */
  const undoStack = [];
  /** @type {Object[]} */
  const redoStack = [];

  /** @returns {ChainEntry[]} */
  const chain = () => doc.descriptor.chain;
  /** @param {ChainEntry} entry */
  const operatorOf = (entry) =>
    /** @type {CatalogOperator} */ (operators.get(entry.operator));
  /** @param {CatalogOperator} op */
  const isEndomorphism = (op) => op.input === op.output;
  /** @param {number} index */
  const carrierBefore = (index) =>
    index === 0 ? entryCarrier : operatorOf(chain()[index - 1]).output;
  /** @param {number} index */
  const carrierAfter = (index) =>
    index === chain().length ? exitCarrier : operatorOf(chain()[index]).input;

  // Session state may only name a live endomorphism (selection: any live label).
  const pruneSession = () => {
    const live = new Map(chain().map((entry) => [entry.label, operatorOf(entry)]));
    if (selected !== null && !live.has(selected)) selected = null;
    for (const label of [...bypassed]) {
      const op = live.get(label);
      if (op === undefined || !isEndomorphism(op)) bypassed.delete(label);
    }
  };

  /**
   * Validates a candidate and, when green, makes it current under one undo
   * entry. A refused candidate is discarded whole.
   * @param {*} candidate - The reconciled document to adopt.
   * @returns {EditResult} The outcome.
   */
  const commit = (candidate) => {
    const diagnostics = diagnosticsOf(candidate);
    if (diagnostics.length > 0) return { ok: false, diagnostics };
    undoStack.push(doc);
    redoStack.length = 0;
    doc = candidate;
    pruneSession();
    return { ok: true };
  };

  /**
   * The engine-budget cost of an operator list, computed from whatever cost
   * keys the catalog's budgets object declares.
   * @param {CatalogOperator[]} ops - Operators of a candidate chain.
   * @returns {{arenaBytes: number, paramCount: number}} Totals.
   */
  const chainCost = (ops) => {
    let arenaBytes = 0;
    let paramCount = 0;
    for (const op of ops) {
      arenaBytes += (budgets.per_op_overhead_bytes ?? 0) + blockBytes(op.blocks)
        + (budgets.per_param_name_bytes ?? 0) * op.params.length;
      paramCount += op.params.length;
    }
    return { arenaBytes, paramCount };
  };

  /**
   * Why a candidate chain breaks a declared budget, or null when it fits.
   * @param {CatalogOperator[]} ops - Operators of a candidate chain.
   * @returns {string|null} The refusal reason.
   */
  const budgetReason = (ops) => {
    if (budgets.max_chain_ops !== undefined && ops.length > budgets.max_chain_ops)
      return `the chain would exceed the ${budgets.max_chain_ops}-operator budget`;
    const { arenaBytes, paramCount } = chainCost(ops);
    if (budgets.max_params !== undefined && paramCount > budgets.max_params)
      return `the chain would exceed the ${budgets.max_params}-parameter budget`;
    if (budgets.arena_bytes !== undefined && arenaBytes > budgets.arena_bytes)
      return `the chain would need ${arenaBytes} arena bytes of the `
        + `${budgets.arena_bytes} budget`;
    return null;
  };

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
   * Strips the removed instances from parameters, serialization fields,
   * staggered path-policy groups and every preset.
   * @param {*} candidate - Document being reconciled.
   * @param {string[]} labels - Labels leaving the chain.
   */
  const removeInstances = (candidate, labels) => {
    const prefixes = labels.map((label) => `${label}.`);
    /** @param {string} id */
    const owned = (id) => prefixes.some((prefix) => id.startsWith(prefix));
    const descriptor = candidate.descriptor;
    descriptor.parameters = descriptor.parameters.filter(
      (/** @type {{id: string}} */ parameter) => !owned(parameter.id));
    descriptor.serialization.fields = descriptor.serialization.fields.filter(
      (/** @type {string} */ id) => !owned(id));
    for (const policy of descriptor.path_policies) {
      if (policy.kind === 'STAGGERED_ORDERED')
        policy.groups = policy.groups.filter((/** @type {string} */ group) => !owned(group));
    }
    for (const preset of candidate.preset_bank.presets) {
      for (const key of Object.keys(preset.values))
        if (owned(key)) delete preset.values[key];
    }
  };

  /**
   * Declares an added instance's full catalog schema and backfills every
   * preset, the serialization fields and staggered path-policy groups with
   * the catalog defaults.
   * @param {*} candidate - Document being reconciled.
   * @param {ChainEntry} entry - The added chain entry.
   */
  const addInstance = (candidate, entry) => {
    const op = /** @type {CatalogOperator} */ (operators.get(entry.operator));
    for (const field of op.params) {
      const parameter = parameterFromField(entry.label, field);
      candidate.descriptor.parameters.push(parameter);
      candidate.descriptor.serialization.fields.push(parameter.id);
      for (const policy of candidate.descriptor.path_policies) {
        if (policy.kind === 'STAGGERED_ORDERED') policy.groups.push(parameter.id);
      }
      for (const preset of candidate.preset_bank.presets)
        preset.values[parameter.id] = field.default;
    }
  };

  // A removal can leave two presets value-identical, making a transition
  // between them the identity; such edges are dropped with the instance.
  /** @param {*} candidate */
  const dropDegenerateEdges = (candidate) => {
    const signatures = new Map(candidate.preset_bank.presets.map(
      (/** @type {{preset_id: string, values: Object}} */ preset) =>
        [preset.preset_id, compiler.stableStringify(preset.values)]));
    candidate.preset_bank.edges = candidate.preset_bank.edges.filter(
      (/** @type {{from: string, to: string}} */ edge) =>
        signatures.get(edge.from) !== signatures.get(edge.to));
  };

  /**
   * The one structural mutation: replaces a contiguous span of the chain with
   * a catalog sequence, reconciles the whole document (backfill added
   * instances, strip removed ones, drop degenerate transition edges) and
   * commits only if the result passes the v2 validator. An entry whose label
   * survives with the same operator keeps its parameter values; a label
   * omitted from a sequence entry is derived from the operator's family stem
   * plus the lowest free numeric suffix.
   * @param {number} start - First chain index of the span.
   * @param {number} deleteCount - Entries the span replaces (0 = insertion).
   * @param {ChainEdit[]} sequence - Replacement entries; [] removes the span.
   * @returns {EditResult} The outcome; a refusal leaves the store untouched.
   */
  const replaceSpan = (start, deleteCount, sequence) => {
    const error = spanError(start, deleteCount);
    if (error !== null) return refusal('INVALID_SPAN', '$.descriptor.chain', error);
    if (!Array.isArray(sequence))
      return refusal('INVALID_SEQUENCE', '$.descriptor.chain',
        'a replacement sequence is an array of {label?, operator} entries');
    const current = chain();
    const used = new Set(current.map((entry) => entry.label));
    /** @type {ChainEntry[]} */
    const entries = [];
    for (const item of sequence) {
      if (item === null || typeof item !== 'object' || typeof item.operator !== 'string')
        return refusal('INVALID_SEQUENCE', '$.descriptor.chain',
          'a replacement sequence is an array of {label?, operator} entries');
      if (!operators.has(item.operator))
        return refusal('UNKNOWN_OPERATOR', '$.descriptor.chain',
          `the catalog carries no operator "${item.operator}"`);
      let label = item.label;
      if (label === undefined) {
        const stem = item.operator.split('.')[0];
        let suffix = 1;
        while (used.has(`${stem}${suffix}`)) suffix += 1;
        label = `${stem}${suffix}`;
      }
      used.add(label);
      entries.push({ label, operator: item.operator });
    }

    const newChain = [
      ...current.slice(0, start).map((entry) => ({ ...entry })),
      ...entries,
      ...current.slice(start + deleteCount).map((entry) => ({ ...entry })),
    ];
    const newOps = new Map(newChain.map((entry) => [entry.label, entry.operator]));
    if (newOps.size !== newChain.length) {
      return refusal('DUPLICATE_LABEL', '$.descriptor.chain',
        'the edited chain repeats an instance label');
    }
    const budget = budgetReason(newChain.map(operatorOf));
    if (budget !== null)
      return refusal('BUDGET_EXCEEDED', '$.descriptor.chain', budget);

    // A label kept under a different operator is a fresh instance: its old
    // values are dropped and the new operator's defaults backfilled.
    const oldOps = new Map(current.map((entry) => [entry.label, entry.operator]));
    const removed = [...oldOps.keys()].filter(
      (label) => newOps.get(label) !== oldOps.get(label));
    const added = newChain.filter((entry) => oldOps.get(entry.label) !== entry.operator);

    const candidate = structuredClone(doc);
    candidate.descriptor.chain = newChain;
    if (removed.length > 0) removeInstances(candidate, removed);
    for (const entry of added) addInstance(candidate, entry);
    if (removed.length > 0) dropDegenerateEdges(candidate);
    return commit(candidate);
  };

  /**
   * Renames one instance, rewriting every `<label>.<field>` id in place across
   * parameters, presets, staggered path-policy groups and serialization
   * fields. Selection and bypass follow the rename.
   * @param {string} oldLabel - The instance's current label.
   * @param {string} newLabel - The label to adopt.
   * @returns {EditResult} The outcome; a refusal leaves the store untouched.
   */
  const relabel = (oldLabel, newLabel) => {
    if (!chain().some((entry) => entry.label === oldLabel))
      return refusal('UNKNOWN_LABEL', '$.descriptor.chain',
        `no chain entry is labeled "${oldLabel}"`);
    if (typeof newLabel !== 'string' || !LABEL_PATTERN.test(newLabel))
      return refusal('INVALID_LABEL', '$.descriptor.chain',
        'an instance label is a single kebab-case segment');
    if (newLabel === oldLabel) return { ok: true };
    if (chain().some((entry) => entry.label === newLabel))
      return refusal('DUPLICATE_LABEL', '$.descriptor.chain',
        `the chain already carries an instance labeled "${newLabel}"`);
    const prefix = `${oldLabel}.`;
    /** @param {string} id */
    const rewrite = (id) =>
      id.startsWith(prefix) ? `${newLabel}.${id.slice(prefix.length)}` : id;
    const candidate = structuredClone(doc);
    for (const entry of candidate.descriptor.chain)
      if (entry.label === oldLabel) entry.label = newLabel;
    for (const parameter of candidate.descriptor.parameters) {
      parameter.id = rewrite(parameter.id);
      if (typeof parameter.interpolation.group === 'string')
        parameter.interpolation.group = rewrite(parameter.interpolation.group);
    }
    candidate.descriptor.serialization.fields =
      candidate.descriptor.serialization.fields.map(rewrite);
    for (const policy of candidate.descriptor.path_policies) {
      if (policy.kind === 'STAGGERED_ORDERED')
        policy.groups = policy.groups.map(rewrite);
    }
    for (const preset of candidate.preset_bank.presets) {
      preset.values = Object.fromEntries(Object.entries(preset.values)
        .map(([id, value]) => [rewrite(id), value]));
    }
    const followBypass = bypassed.has(oldLabel);
    const followSelection = selected === oldLabel;
    const result = commit(candidate);
    if (result.ok) {
      if (followBypass) bypassed.add(newLabel);
      if (followSelection) selected = newLabel;
    }
    return result;
  };

  return {
    /** @returns {*} An isolated copy of the current (always-valid) document. */
    document: () => structuredClone(doc),

    /** @returns {ChainEntry[]} The chain in document order. */
    chain: () => chain().map((entry) => ({ ...entry })),

    /** @returns {*} The compiler's full result for the current document, digests included. */
    compile: () => compiler.compileShaderDocument(structuredClone(doc), { catalog }),

    /** @returns {string|null} The selected instance label. */
    selectedLabel: () => selected,

    /**
     * @param {string|null} label - A live chain label, or null to clear.
     * @returns {boolean} Whether the selection was adopted.
     */
    setSelectedLabel: (label) => {
      if (label !== null && !chain().some((entry) => entry.label === label))
        return false;
      selected = label;
      return true;
    },

    /** @returns {string[]} The bypassed labels, session state only. */
    bypassedLabels: () => [...bypassed],

    /**
     * Toggles the session bypass of one endomorphism. Never serialized: the
     * document and its digest are untouched.
     * @param {string} label - A live chain label.
     * @param {boolean} on - Whether the instance is bypassed.
     * @returns {EditResult} A refusal for an unknown label or a crossing.
     */
    setBypassed: (label, on) => {
      const entry = chain().find((candidate) => candidate.label === label);
      if (entry === undefined)
        return refusal('UNKNOWN_LABEL', '$.descriptor.chain',
          `no chain entry is labeled "${label}"`);
      const op = operatorOf(entry);
      if (on && !isEndomorphism(op))
        return refusal('BYPASS_CROSSING', '$.descriptor.chain',
          `"${label}" crosses ${op.input} to ${op.output}; only an endomorphism can be bypassed`);
      if (on) bypassed.add(label);
      else bypassed.delete(label);
      return { ok: true };
    },

    /**
     * @returns {{instance: string, operator: string}[]} The engine program
     *   shape: the chain in order, minus the bypassed instances.
     */
    programShape: () => chain()
      .filter((entry) => !bypassed.has(entry.label))
      .map((entry) => ({ instance: entry.label, operator: entry.operator })),

    /**
     * @param {number} index - Gap position, 0..chain length.
     * @returns {LegalityEntry[]} Every operator's insertion legality at the gap.
     */
    legalInsertions: (index) => spanLegality(index, 0),

    /**
     * @param {number} start - First chain index of the span.
     * @param {number} deleteCount - Entries the span covers.
     * @returns {LegalityEntry[]} Every operator's legality as a one-operator
     *   replacement of the span.
     */
    legalReplacements: (start, deleteCount) => spanLegality(start, deleteCount),

    replaceSpan,
    relabel,

    /** @returns {boolean} Whether a structural edit can be undone. */
    canUndo: () => undoStack.length > 0,

    /** @returns {boolean} Whether an undone edit can be reapplied. */
    canRedo: () => redoStack.length > 0,

    /**
     * Reverts the last structural edit whole, reconciliation included.
     * Selection and bypass are session state, not history: they are pruned
     * against the restored chain, never restored.
     * @returns {boolean} Whether an edit was undone.
     */
    undo: () => {
      const previous = undoStack.pop();
      if (previous === undefined) return false;
      redoStack.push(doc);
      doc = previous;
      pruneSession();
      return true;
    },

    /** @returns {boolean} Whether an undone edit was reapplied. */
    redo: () => {
      const next = redoStack.pop();
      if (next === undefined) return false;
      undoStack.push(doc);
      doc = next;
      pruneSession();
      return true;
    },
  };
}
