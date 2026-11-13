// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {LABEL_PATTERN, declarationFromCatalogField as parameterFromField} from '../../../generated/shader/shader_workbench.mjs';
/** @typedef {import('./chain_document_store.js').CatalogOperator} CatalogOperator */
/** @typedef {import('./chain_document_store.js').ChainEntry} ChainEntry */
/** @typedef {import('./chain_document_store.js').ChainEdit} ChainEdit */
/** @typedef {import('./chain_document_store.js').EditResult} EditResult */

/** @typedef {import('./chain_document_store.js').ParameterDeclaration} ParameterDeclaration */

/** @typedef {{state: import('./chain_document_history.js').ChainSession,
 * operators: Map<string, CatalogOperator>, declarationTemplates: Map<string, {label: string, parameter: ParameterDeclaration}[]>,
 * compiler: *, chain: () => ChainEntry[], operatorOf: (entry: ChainEntry) => CatalogOperator,
 * labelStem: (operator: string) => string, spanError: (start: number, count: number) => string|null,
 * budgetReason: (operators: CatalogOperator[]) => string|null,
 * commit: (candidate: *, coalesce?: string|null, admit?: (() => EditResult)|null) => EditResult}} EditContext */

/**
 * A single-diagnostic edit refusal.
 * @param {string} code - Diagnostic code.
 * @param {string} path - JSON path the refusal is about.
 * @param {string} message - Human-readable reason.
 * @returns {EditResult} The refusal.
 */
export const refusal = (code, path, message) => ({
  ok: false,
  diagnostics: [{ severity: 'error', phase: 'edit', code, path, message }],
});

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
  // A staggered group names a parameter's shared interpolation group where it
  // declares one and its id otherwise, so an instance prefix does not name
  // every group its removal strands.
  const groups = new Set(descriptor.parameters.map(
    (/** @type {{id: string, interpolation?: {group?: string}}} */ parameter) =>
      parameter.interpolation?.group ?? parameter.id));
  for (const policy of descriptor.path_policies) {
    if (policy.kind === 'STAGGERED_ORDERED')
      policy.groups = policy.groups.filter((/** @type {string} */ group) => groups.has(group));
  }
  for (const preset of candidate.preset_bank.presets) {
    for (const key of Object.keys(preset.values))
      if (owned(key)) delete preset.values[key];
  }
};

/** @param {*} candidate @param {ParameterDeclaration} parameter */
const addParameter = (candidate, parameter) => {
  candidate.descriptor.parameters.push(parameter);
  candidate.descriptor.serialization.fields.push(parameter.id);
  // A staggered group names a parameter's shared interpolation group where
  // it declares one and its id otherwise; sharers contribute one group.
  const group = parameter.interpolation.group ?? parameter.id;
  for (const policy of candidate.descriptor.path_policies) {
    if (policy.kind === 'STAGGERED_ORDERED' && !policy.groups.includes(group))
      policy.groups.push(group);
  }
  for (const preset of candidate.preset_bank.presets)
    preset.values[parameter.id] = parameter.default;
};

/**
 * Declares the operator's full catalog schema for an added instance.
 * Declarations snapshotted from the loaded document supply authored defaults;
 * remaining fields use catalog defaults. Every preset receives those defaults.
 * @param {EditContext} context - Store collaborators.
 * @param {*} candidate - Document being reconciled.
 * @param {ChainEntry} entry - The added chain entry.
 */
function addInstance(context, candidate, entry) {
  const {operators, declarationTemplates} = context;
  const op = /** @type {CatalogOperator} */ (operators.get(entry.operator));
  const templates = new Map((declarationTemplates.get(entry.operator) ?? []).map(
    (template) => [template.parameter.id.slice(template.label.length + 1), template]));
  const parameters = op.params.map((field) => {
    const template = templates.get(field.id);
    if (template === undefined) return parameterFromField(entry.label, field, entry.operator);
    const parameter = structuredClone(template.parameter);
    const prefix = `${template.label}.`;
    parameter.id = `${entry.label}.${parameter.id.slice(prefix.length)}`;
    if (parameter.interpolation.group?.startsWith(prefix)) {
      parameter.interpolation.group =
          `${entry.label}.${parameter.interpolation.group.slice(prefix.length)}`;
    }
    return parameter;
  });
  for (const parameter of parameters) addParameter(candidate, parameter);
}

/** @param {EditContext} context - Store collaborators.
 * @param {*} candidate */
function dropDegenerateEdges(context, candidate) {
  const {state, compiler} = context;
  const previous = new Map(state.doc.preset_bank.presets.map(
    (/** @type {{preset_id: string, values: Object}} */ preset) =>
      [preset.preset_id, compiler.stableStringify(preset.values)]));
  const signatures = new Map(candidate.preset_bank.presets.map(
    (/** @type {{preset_id: string, values: Object}} */ preset) =>
      [preset.preset_id, compiler.stableStringify(preset.values)]));
  candidate.preset_bank.edges = candidate.preset_bank.edges.filter(
    (/** @type {{from: string, to: string}} */ edge) =>
      previous.get(edge.from) === previous.get(edge.to) ||
        signatures.get(edge.from) !== signatures.get(edge.to));
}

/**
 * The one structural mutation: replaces a contiguous span of the chain with
 * a catalog sequence, reconciles the whole document (backfill added
 * instances, strip removed ones, drop degenerate transition edges) and
 * commits only if the result passes the v2 validator. An entry whose label
 * survives with the same operator keeps its parameter values; a label
 * omitted from a sequence entry takes the operator's stem, numbered from
 * 1 only where the stem is taken. A replacement that leaves the chain
 * as it stands changes nothing and pushes no undo entry.
 * @param {EditContext} context - Store collaborators.
 * @param {number} start - First chain index of the span.
 * @param {number} deleteCount - Entries the span replaces (0 = insertion).
 * @param {ChainEdit[]} sequence - Replacement entries; [] removes the span.
 * @returns {EditResult} The outcome; a refusal leaves the store untouched.
 */
function replaceSpan(context, start, deleteCount, sequence) {
  const {state, operators, chain, operatorOf, labelStem, spanError, budgetReason, commit} = context;
  const error = spanError(start, deleteCount);
  if (error !== null) return refusal('INVALID_SPAN', '$.descriptor.chain', error);
  if (!Array.isArray(sequence))
    return refusal('INVALID_SEQUENCE', '$.descriptor.chain',
      'a replacement sequence is an array of {label?, operator} entries');
  const current = chain();
  const used = new Set([
    ...current.slice(0, start),
    ...current.slice(start + deleteCount),
  ].map((entry) => entry.label));
  for (const item of sequence) {
    if (item && typeof item === 'object' && item.label !== undefined) used.add(item.label);
  }
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
      const stem = labelStem(item.operator);
      label = stem;
      for (let suffix = 1; used.has(label); suffix += 1) label = `${stem}${suffix}`;
    }
    used.add(label);
    entries.push({ label, operator: item.operator });
  }

  const newChain = [
    ...current.slice(0, start).map((entry) => ({ ...entry })),
    ...entries,
    ...current.slice(start + deleteCount).map((entry) => ({ ...entry })),
  ];
  if (newChain.length === current.length && newChain.every((entry, index) =>
    entry.label === current[index].label && entry.operator === current[index].operator))
    return { ok: true };

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

  const candidate = structuredClone(state.doc);
  candidate.descriptor.chain = newChain;
  if (removed.length > 0) removeInstances(candidate, removed);
  try {
    for (const entry of added) addInstance(context, candidate, entry);
  } catch (error) {
    return refusal('INVALID_CATALOG_FIELD', '$.descriptor.chain',
      error instanceof Error ? error.message : String(error));
  }
  if (removed.length > 0) dropDegenerateEdges(context, candidate);
  return commit(candidate);
}

/**
 * Renames one instance, rewriting every `<label>.<field>` id in place across
 * parameters, presets, staggered path-policy groups and serialization
 * fields. Selection and bypass follow the rename.
 * @param {EditContext} context - Store collaborators.
 * @param {string} oldLabel - The instance's current label.
 * @param {string} newLabel - The label to adopt.
 * @returns {EditResult} The outcome; a refusal leaves the store untouched.
 */
function relabel(context, oldLabel, newLabel) {
  const {state, chain, commit} = context;
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
  const candidate = structuredClone(state.doc);
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
  const followBypass = state.bypassed.has(oldLabel);
  const followSelection = state.selected === oldLabel;
  const result = commit(candidate);
  if (result.ok) {
    if (followBypass) state.bypassed.add(newLabel);
    if (followSelection) state.selected = newLabel;
  }
  return result;
}

/**
 * Writes one preset's values for one or more parameters atomically through
 * the same validator and history as a structural edit. Consecutive writes to
 * the same preset and identical ordered parameter IDs collapse into one undo
 * entry; any other edit, undo or redo ends the run.
 * @param {EditContext} context - Store collaborators.
 * @param {string} presetId - The preset the values belong to.
 * @param {Object<string, *>} values - Catalog parameter IDs and their values; enum8 takes its option id.
 * @param {(() => EditResult)|null} [admit] - Admission before changing document or history.
 * @returns {EditResult} The outcome; a refusal leaves the store untouched.
 */
function setPresetValues(context, presetId, values, admit = null) {
  const {state, chain, operatorOf, commit} = context;
  const index = state.doc.preset_bank.presets.findIndex(
    (/** @type {{preset_id: string}} */ preset) => preset.preset_id === presetId);
  if (index < 0)
    return refusal('UNKNOWN_PRESET', '$.preset_bank.presets',
        `the preset bank carries no preset "${presetId}"`);
  const candidate = structuredClone(state.doc);
  for (const [parameterId, value] of Object.entries(values)) {
    if (!candidate.descriptor.parameters.some(
      (/** @type {{id: string}} */ parameter) => parameter.id === parameterId)) {
      const entry = chain().find((entry) => parameterId.startsWith(`${entry.label}.`));
      const field = entry && operatorOf(entry).params.find(
        (field) => `${entry.label}.${field.id}` === parameterId);
      if (!entry || !field)
        return refusal('UNKNOWN_PARAMETER', '$.descriptor.parameters',
            `the catalog carries no parameter "${parameterId}" for this chain`);
      addParameter(candidate, parameterFromField(entry.label, field, entry.operator));
    }
    candidate.preset_bank.presets[index].values[parameterId] = value;
  }
  return commit(candidate, `${presetId} ${Object.keys(values).join(' ')}`, admit);
}

/** Stores one preset value in a coalesced control edit.
 * @param {EditContext} context - Store collaborators.
 * @param {string} presetId @param {string} parameterId @param {*} value
 * @param {(() => EditResult)|null} [admit] @returns {EditResult} */
function setPresetValue(context, presetId, parameterId, value, admit = null) {
  return setPresetValues(context, presetId, { [parameterId]: value }, admit);
}

/** Binds structural reconciliation and preset edits to one store.
 * @param {EditContext} context */
export function createChainDocumentEdits(context) {
  return {
    removeInstances,
    dropDegenerateEdges: (/** @type {*} */ candidate) => dropDegenerateEdges(context, candidate),
    replaceSpan: (/** @type {number} */ start, /** @type {number} */ deleteCount, /** @type {ChainEdit[]} */ sequence) => replaceSpan(context, start, deleteCount, sequence),
    relabel: (/** @type {string} */ oldLabel, /** @type {string} */ newLabel) => relabel(context, oldLabel, newLabel),
    setPresetValues: (/** @type {string} */ presetId, /** @type {Record<string, *>} */ values, /** @type {(() => EditResult)|null} */ admit = null) => setPresetValues(context, presetId, values, admit),
    setPresetValue: (/** @type {string} */ presetId, /** @type {string} */ parameterId, /** @type {*} */ value, /** @type {(() => EditResult)|null} */ admit = null) => setPresetValue(context, presetId, parameterId, value, admit),
  };
}
