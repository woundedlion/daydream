// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { LABEL_PATTERN, declarationFromCatalogField as parameterFromField }
  from '../../../generated/shader/shader_workbench.mjs';
import {createChainHistory} from './chain_document_history.js';
import {createChainLegality} from './chain_document_legality.js';
import {changePlanarSource, PLANAR_SOURCE, presetSourceKind, simplifyPlanarSource, sourceFamily} from './chain_planar_source.js';
import {createPresetBankEdits, reconcilePresetEdges} from './chain_preset_bank.js';
import {createChainDocumentEdits, refusal} from './chain_document_edits.js';
import { supportedSnapshotSchema } from './shader_deeplink.js';
import { MODULATION_OPERATOR, PALETTE_OPERATOR } from './chain_presentation.js';

/** @typedef {Awaited<ReturnType<typeof createChainDocumentStore>>} ChainStore */

/** @typedef {{field: string, values: string[]}} CatalogGate */
/** @typedef {{id: string, name: string|null, min: number, max: number, default: *, curve?: string, topology?: false, gated_by?: CatalogGate, sources?: string[]}} CatalogNumericField */
/** @typedef {{id: string, topology: true, blend?: boolean, values: string[], default: *, gated_by?: CatalogGate, sources?: string[]}} CatalogTopologyField */
/** @typedef {CatalogNumericField|CatalogTopologyField} CatalogField */
/** @typedef {{id: string, name: string|null, input: string, output: string, blocks?: *, params: CatalogField[]}} CatalogOperator */
/** @typedef {{label: string, operator: string}} ChainEntry */
/** @typedef {{label?: string, operator: string}} ChainEdit */
/** @typedef {{severity: string, phase: string, code: string, path: string, message: string}} Diagnostic */
/** @typedef {{ok: true}|{ok: false, diagnostics: Diagnostic[]}} EditResult */
/** @typedef {{operator: CatalogOperator, legal: boolean, reason?: string}} LegalityEntry */
/** @typedef {{operators: CatalogOperator[]}} SequenceEntry */
/** @typedef {{id: string, classification: string, storage: string, unit: string, domain: *, interpolation: *, default: *}} ParameterDeclaration */

/**
 * Undo entries one session keeps, each a whole document clone; the oldest is
 * dropped past it.
 * @type {number}
 */
export const UNDO_DEPTH = 100;

/**
 * The default scratch chain winds a spherical spiral around the north pole.
 * @type {ReadonlyArray<ChainEntry>}
 */
export const DEFAULT_SCRATCH_CHAIN = Object.freeze([
  { label: 'rotate', operator: 'sphere.rotate.v2' },
  { label: 'project', operator: 'project.equirectangular.v2' },
  { label: 'sample', operator: 'sample.spiral.v3' },
  { label: 'colorize', operator: PALETTE_OPERATOR },
]);

const SCRATCH_PRESET_ID = 'catalog-defaults';

/**
 * Builds the workbench's scratch document: the given chain over catalog
 * operators carrying one preset. The default spiral reads equirectangular
 * longitude and latitude. The parameter
 * declarations come from the same catalog-field mapping a structural insert
 * backfills with.
 * @param {*} catalog - The operator catalog the document validates against.
 * @param {ReadonlyArray<ChainEntry>} [chain] - The chain to build over.
 * @returns {*} A complete v2 document.
 */
export function scratchChainDocument(catalog, chain = DEFAULT_SCRATCH_CHAIN) {
  /** @type {Map<string, CatalogOperator>} */
  const operators = new Map((catalog?.operators ?? []).map(
    (/** @type {CatalogOperator} */ op) => [op.id, op]));
  /** @type {ParameterDeclaration[]} */
  const parameters = [];
  /** @type {Object<string, *>} */
  const values = {};
  for (const entry of chain) {
    const operator = operators.get(entry.operator);
    if (operator === undefined) {
      throw new Error('scratch chain document: the catalog carries no operator '
        + `"${entry.operator}"`);
    }
    for (const field of operator.params) {
      const parameter = parameterFromField(entry.label, field, entry.operator);
      if (chain === DEFAULT_SCRATCH_CHAIN && field.id === 'coordinate-system'
        && entry.operator === 'sample.spiral.v3') {
        parameter.default = 'equirectangular';
      }
      parameters.push(parameter);
      values[parameter.id] = parameter.default;
    }
  }
  return {
    schema_version: 2,
    catalog_version: catalog.catalog_version,
    document_id: 'scratch',
    effect_id: 'scratch',
    effect_metadata: {
      display_name: 'Scratch Chain',
      description: 'A spiral winding around the north pole through Equirectangular.',
    },
    descriptor: {
      chain: chain.map((entry) => ({ ...entry })),
      parameters,
      path_policies: [{ id: 'parallel', kind: 'PARALLEL' }],
      serialization: {
        schema_version: 1,
        fields: parameters.map((parameter) => parameter.id),
      },
    },
    preset_bank: {
      schema_version: 1,
      presets: [{
        preset_id: SCRATCH_PRESET_ID,
        display_name: 'Catalog Defaults',
        values,
      }],
      edges: [],
      absent_edge_fallback: {
        manual: 'SNAP',
        automatic: 'REJECT',
        synchronized: 'SNAP',
        restore: 'SNAP',
        authoring: 'SNAP',
      },
      choreography: {
        generated_order: [SCRATCH_PRESET_ID],
        dwell: { [SCRATCH_PRESET_ID]: 600 },
      },
    },
  };
}

/**
 * Creates the chain editor's document state machine: a validated chain
 * document, a selection, a session bypass set and an undo history. Every
 * mutation (`replaceSpan`, the one structural chain edit, plus `relabel` and
 * `setPresetValues`) builds a whole candidate document and commits it
 * atomically through one step that refuses anything the v2 validator rejects.
 * @param {Object} options - Store dependencies.
 * @param {*} options.document - A compiled (post-expansion, valid) v2 document.
 * @param {*} options.catalog - The operator catalog the document validates against.
 * @param {() => Promise<*>} [options.importCompiler] - Loads the document compiler.
 */
export async function createChainDocumentStore({
  document,
  catalog,
  importCompiler = () => import('../../../generated/shader/shader_workbench.mjs'),
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
  const carriers = new Set(catalog.carriers);

  /**
   * The label a shipped document gives an instance of an operator: its
   * family segment, or the stage segment under it when the family is a
   * carrier every one of its operators shares.
   * @param {string} operator - A catalog operator id.
   * @returns {string} The unnumbered label stem.
   */
  const labelStem = (operator) => {
    const segments = operator.split('.');
    const from = carriers.has(segments[0]) ? 1 : 0;
    return segments.find((segment, index) =>
      index >= from && LABEL_PATTERN.test(segment)) ?? segments[0];
  };

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
  /** @type {Map<string, {label: string, parameter: ParameterDeclaration}[]>} */
  const declarationTemplates = new Map();
  const sourceFamilyVisits = new Set();
  /** @param {string} label @param {string} presetId @param {string|null} kind */
  const visitKey = (label, presetId, kind) => JSON.stringify([label, presetId, kind === null ? null : sourceFamily(kind)]);
  for (const entry of doc.descriptor.chain) {
    if (declarationTemplates.has(entry.operator)) continue;
    const prefix = `${entry.label}.`;
    declarationTemplates.set(entry.operator, doc.descriptor.parameters
      .filter((/** @type {ParameterDeclaration} */ parameter) =>
        parameter.id.startsWith(prefix))
      .map((/** @type {ParameterDeclaration} */ parameter) => ({
        label: entry.label,
        parameter: structuredClone(parameter),
      })));
  }

  /** @type {string|null} */
  let selected = null;
  /** @type {Set<string>} */
  const bypassed = new Set();
  /** @type {Object[]} */
  const undoStack = [];
  /** @type {Object[]} */
  const redoStack = [];
  /** @type {string|null} Coalesce key the newest undo entry was opened under. */
  let coalesceKey = null;
  /** @type {{doc: *, result: *}|null} Memo for compile(), keyed on the current
      document's identity: every edit swaps `doc` for a fresh object rather than
      mutating it, so a hit is exact. */
  let compiled = null;

  /** @returns {ChainEntry[]} */
  const chain = () => doc.descriptor.chain;
  /** @param {ChainEntry} entry */
  const operatorOf = (entry) =>
    /** @type {CatalogOperator} */ (operators.get(entry.operator));
  /** @param {CatalogOperator} op */
  const isEndomorphism = (op) => op.input === op.output;
  // Session state may only name a live endomorphism (selection: any live label).
  /** @type {import('./chain_document_history.js').ChainSession} */
  const sessionState = {
    get doc() { return doc; },
    set doc(value) { doc = value; },
    get selected() { return selected; },
    set selected(value) { selected = value; },
    get coalesceKey() { return coalesceKey; },
    set coalesceKey(value) { coalesceKey = value; },
    get bypassed() { return bypassed; },
    get undoStack() { return undoStack; },
    get redoStack() { return redoStack; },
  };
  const {commit, history} = createChainHistory({state: sessionState, chain,
    operatorOf, isEndomorphism, diagnosticsOf, undoDepth: UNDO_DEPTH});

  const {budgetReason, spanError, spanLegality, legalSequences} = createChainLegality({
    compiler, budgets, catalog, entryCarrier, exitCarrier, chain, operatorOf});

  const {removeInstances, replaceSpan, relabel, setPresetValues, setValuesInAllPresets,
    setPresetValue} = createChainDocumentEdits({state: sessionState, operators,
    declarationTemplates, compiler, chain, operatorOf, labelStem, spanError, budgetReason, commit});

  return {
    /** @returns {*} An isolated copy of the current (always-valid) document. */
    document: () => structuredClone(doc),

    /** @param {string} parameterId @returns {boolean} Whether the document declares this parameter. */
    declares: (parameterId) => doc.descriptor.parameters.some(
      (/** @type {ParameterDeclaration} */ parameter) => parameter.id === parameterId),

    /** @returns {ParameterDeclaration[]} Authored declarations plus undeclared catalog fields. */
    parameterDeclarations: () => {
      const parameters = structuredClone(doc.descriptor.parameters);
      const declared = new Set(parameters.map(
        (/** @type {ParameterDeclaration} */ parameter) => parameter.id));
      for (const entry of chain()) {
        for (const field of operatorOf(entry).params) {
          if (!declared.has(`${entry.label}.${field.id}`))
            parameters.push(parameterFromField(entry.label, field, entry.operator));
        }
      }
      return parameters;
    },

    /** @returns {ChainEntry[]} The chain in document order. */
    chain: () => chain().map((entry) => ({ ...entry })),
    /** @returns {ReadonlyArray<Readonly<ChainEntry>>} Current chain without cloning. */
    chainView: () => chain(),

    /**
     * @param {string} presetId - Preset to inspect.
     * @returns {Readonly<Record<string, *>>|null} Current values without cloning.
     */
    presetValuesView: (presetId) => doc.preset_bank.presets.find(
      (/** @type {{preset_id: string}} */ preset) => preset.preset_id === presetId)?.values ?? null,

    /** @returns {*} The compiler's full result for the current document, digests included. */
    compile: () => {
      if (compiled === null || compiled.doc !== doc) {
        compiled = {
          doc,
          result: compiler.compileShaderDocument(structuredClone(doc), { catalog }),
        };
      }
      return compiled.result;
    },

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
     * Toggles the session bypass of one endomorphism. The document and its
     * digest are untouched; `exportDocument` omits bypassed instances.
     * @param {string} label - A live chain label.
     * @param {boolean} on - Whether the instance is bypassed.
     * @returns {EditResult} A refusal for an unknown label, crossing or modulation stage.
     */
    setBypassed: (label, on) => {
      const entry = chain().find((candidate) => candidate.label === label);
      if (entry === undefined)
        return refusal('UNKNOWN_LABEL', '$.descriptor.chain',
          `no chain entry is labeled "${label}"`);
      const op = operatorOf(entry);
      if (on && entry.operator === MODULATION_OPERATOR)
        return refusal('BYPASS_MODULATION', '$.descriptor.chain',
          `"${label}" uses its modulation-enabled parameter instead of session bypass`);
      if (on && !isEndomorphism(op))
        return refusal('BYPASS_CROSSING', '$.descriptor.chain',
          `"${label}" crosses ${op.input} to ${op.output}; only an endomorphism can be bypassed`);
      if (on) bypassed.add(label);
      else bypassed.delete(label);
      return { ok: true };
    },

    /**
     * @returns {*} A copy of the current document without its bypassed
     *   instances or the modulation stages every preset disables.
     * @throws {Error} If the reduced document fails validation.
     */
    exportDocument: () => {
      const presets = doc.preset_bank.presets;
      const disabled = chain().filter((entry) => bypassed.has(entry.label)
        || (entry.operator === MODULATION_OPERATOR && presets.every(
          (/** @type {{values: Record<string, *>}} */ preset) =>
            preset.values[`${entry.label}.modulation-enabled`] === 'disabled')))
        .map((entry) => entry.label);
      const candidate = structuredClone(doc);
      for (const entry of chain())
        if (entry.operator === PLANAR_SOURCE) simplifyPlanarSource(candidate, entry.label, operators);
      if (disabled.length === 0 && !chain().some((entry) => entry.operator === PLANAR_SOURCE)) return candidate;
      candidate.descriptor.chain = candidate.descriptor.chain.filter(
        (/** @type {ChainEntry} */ entry) => !disabled.includes(entry.label));
      removeInstances(candidate, disabled);
      reconcilePresetEdges(candidate, doc.preset_bank);
      const diagnostics = diagnosticsOf(candidate);
      if (diagnostics.length > 0) {
        throw new Error('the document without its disabled stages fails validation: '
          + diagnostics.map((/** @type {Diagnostic} */ d) => d.code).join(', '));
      }
      return candidate;
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
     * @throws {RangeError} If the gap is not an integer position inside the chain.
     */
    legalInsertions: (index) => spanLegality(index, 0),

    /**
     * @param {number} start - First chain index of the span.
     * @param {number} deleteCount - Entries the span covers.
     * @returns {LegalityEntry[]} Every operator's legality as a one-operator
     *   replacement of the span.
     * @throws {RangeError} If the span bounds are not integer positions inside the chain.
     */
    legalReplacements: (start, deleteCount) => spanLegality(start, deleteCount),

    legalSequences,
    replaceSpan,
    relabel,
    setPresetValue,
    setPresetValues,
    setValuesInAllPresets,
    /** @returns {Readonly<import('./chain_preset_bank.js').Bank>} */
    presetBankView: () => doc.preset_bank,
    ...createPresetBankEdits({document: () => doc, commit}),

    /** @param {string} label @param {string} presetId @param {string} kind */
    setSourceKind(label, presetId, kind) {
      const candidate = structuredClone(doc);
      const key = visitKey(label, presetId, kind);
      const previous = doc.descriptor.chain.find((/** @type {ChainEntry} */ entry) => entry.label === label);
      const result = changePlanarSource(candidate, label, presetId, kind, operators, sourceFamilyVisits.has(key));
      if (!result.ok || compiler.stableStringify(candidate) === compiler.stableStringify(doc)) return result;
      const priorKeys = doc.preset_bank.presets.map((/** @type {import('./chain_preset_bank.js').Preset} */ preset) =>
        visitKey(label, preset.preset_id, presetSourceKind(previous.operator, label, preset.values, operators.get(previous.operator))));
      reconcilePresetEdges(candidate, doc.preset_bank);
      const committed = commit(candidate);
      if (committed.ok) {
        sourceFamilyVisits.add(key);
        for (const priorKey of priorKeys) sourceFamilyVisits.add(priorKey);
        const prefix = label + '.';
        declarationTemplates.set(PLANAR_SOURCE, doc.descriptor.parameters
          .filter((/** @type {ParameterDeclaration} */ parameter) => parameter.id.startsWith(prefix))
          .map((/** @type {ParameterDeclaration} */ parameter) => ({label, parameter: structuredClone(parameter)})));
      }
      return committed;
    },

    /** @param {string} label */
    simplifySource(label) {
      const candidate = structuredClone(doc);
      if (!simplifyPlanarSource(candidate, label, operators))
        return refusal('MIXED_PLANAR_SOURCE', '$.descriptor.chain', 'Select the same source in every preset first.');
      reconcilePresetEdges(candidate, doc.preset_bank);
      return commit(candidate);
    },

    ...history,
  };
}

/**
 * Builds an editable document from an executable chain snapshot.
 * @param {*} snapshot - Executable program, parameters and modulation recipes.
 * @param {*} catalog - Operator catalog used to declare parameters and defaults.
 * @returns {*} The imported document; enum8 option indices map to authored option IDs.
 * @throws {Error} If the snapshot schema is unsupported or a parameter is unknown.
 */
export function documentFromChainSnapshot(snapshot, catalog) {
  if (!supportedSnapshotSchema(snapshot?.schemaVersion) || !Array.isArray(snapshot.chain)
      || !Array.isArray(snapshot.parameters) || !Array.isArray(snapshot.modulation))
    throw new Error('unsupported chain snapshot');
  const document = scratchChainDocument(catalog, snapshot.chain.map((/** @type {*} */ entry) => ({
    label: entry.instance, operator: entry.operator,
  })));
  document.document_id = 'imported-chain';
  document.effect_id = 'imported-chain';
  document.effect_metadata.display_name = 'Imported Chain';
  document.effect_metadata.description = 'Imported chain snapshot.';
  const values = document.preset_bank.presets[0].values;
  /** @param {string} name @param {*} value */
  const setValue = (name, value) => {
    const parameter = document.descriptor.parameters.find((/** @type {*} */ p) => p.id === name);
    if (!parameter) throw new Error(`unknown chain snapshot parameter: ${name}`);
    values[name] = parameter.storage === 'enum8' ? parameter.domain.values[value] : value;
  };
  for (const entry of snapshot.parameters) setValue(entry.name, entry.value);
  for (const {instance, recipe} of snapshot.modulation) {
    const set = (/** @type {string} */ field, /** @type {*} */ value) => setValue(`${instance}.${field}`, value);
    set('modulation-enabled', Number(recipe.enabled));
    set('modulation-source', recipe.source);
    set('modulation-evaluation', recipe.evaluation);
    set('modulation-mechanic', recipe.mechanic.kind);
    set('modulation-amount', recipe.mechanic.amount);
    set('pattern-noise-basis', recipe.noise.basis);
    set('pattern-noise-variant', recipe.noise.variant);
    for (const field of ['scale', 'speed', 'contrast']) set(`pattern-${field}`, recipe.noise[field]);
    for (const source of ['sine', 'interference', 'grid']) {
      const pattern = recipe[source];
      for (const [index, axis] of ['x', 'y', 'z'].entries()) {
        set(`${source}-axis-${axis}`, pattern.axis[index]);
        if (source !== 'sine') set(`${source}-axis-b-${axis}`, pattern.axisB[index]);
      }
      for (const field of ['frequency', 'offset', 'speed']) set(`${source}-${field}`, pattern[field]);
      if (source !== 'sine') {
        set(`${source}-frequency-b`, pattern.frequencyB);
        set(`${source}-offset-b`, pattern.offsetB);
      }
    }
  }
  return document;
}
