// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {{id: string, topology?: boolean, values?: string[], gated_by?: {field: string, values: string[]}}} CatalogParameter */
/** @typedef {{id: string, name: string, input: string, output: string, params: CatalogParameter[]}} CatalogOperator */
/** @typedef {{carriers: string[], operators: CatalogOperator[]}} OperatorCatalog */
/** @typedef {{label: string, operator: string}} ChainEntry */
/** @typedef {{operator: CatalogOperator, legal: boolean, reason?: string}} LegalityEntry */
/** @typedef {{operators: CatalogOperator[]}} SequenceEntry */
/**
 * One offer of the replacement palette or a socket's selector: the span it
 * names and the operator sequence that takes its place.
 * @typedef {{start: number, deleteCount: number, operators: CatalogOperator[]}} SpanChoice
 */
/** @typedef {{id: string, storage: string, domain: *}} ParameterDeclaration */
/**
 * One carrier's run of the chain: the gap indices that fall inside it, the chain
 * indices of its endomorphism chips, and the crossing that closes it.
 * @typedef {{carrier: string, gaps: number[], chips: number[], socket: number|null}} BandLayout
 */

const READOUT_STEPS = 1000;

// Nine significant digits round-trip every binary32; seven do not.
const READOUT_DIGITS = 9;

/**
 * @param {number} value - A stored parameter value.
 * @returns {string} The shortest decimal that reads back as the same binary32.
 */
export const formatNumericValue = (value) => {
  const stored = Math.fround(Number(value));
  for (let digits = 1; digits < READOUT_DIGITS; digits += 1) {
    const text = String(Number(Number(value).toPrecision(digits)));
    if (Math.fround(Number(text)) === stored) return text;
  }
  return String(Number(Number(value).toPrecision(READOUT_DIGITS)));
};

/**
 * @param {ParameterDeclaration} declaration - A binary32 declaration.
 * @returns {number} The increment its numeric readout's arrow keys nudge by.
 */
export const nudgeStep = (declaration) => {
  const span = Number(declaration.domain?.maximum) - Number(declaration.domain?.minimum);
  return span > 0 ? span / READOUT_STEPS : 0;
};

/** @param {string} id @returns {string} The `<label>.<field>` id's field segment. */
export const fieldOf = (id) => id.slice(id.indexOf('.') + 1);

/**
 * The parameter ids the current topology selections deactivate. Edge widths
 * require an edge-fade mode, hue controls require their corresponding hue mode,
 * brightness endpoints and depth require a brightness envelope, and the
 * projection spin and wander rates require the spin-wander frame. Deactivation
 * changes what the engine reads, never what the document carries, so these
 * controls render dimmed rather than dropping out of the union schema.
 * @param {ParameterDeclaration[]} parameters - The document's declarations.
 * @param {Object<string, *>} values - The active preset's values.
 * @param {ChainEntry[]} chain - The document's operator instances.
 * @param {OperatorCatalog} catalog - Catalog declaring each topology field.
 * @returns {Set<string>} The deactivated parameter ids.
 */
export function deactivatedParameterIds(parameters, values, chain, catalog) {
  const operators = new Map(catalog.operators.map((operator) => [operator.id, operator]));
  const operatorByLabel = new Map(chain.map((entry) => [entry.label, operators.get(entry.operator)]));
  /** @type {Set<string>} */
  const deactivated = new Set();
  for (const parameter of parameters) {
    if (!parameter.id.includes('.')) continue;
    const field = fieldOf(parameter.id);
    const label = parameter.id.slice(0, parameter.id.indexOf('.'));
    const operator = operatorByLabel.get(label);
    const gate = operator?.params.find((candidate) => candidate.id === field)?.gated_by;
    if (!gate) continue;
    const schema = operator.params.find((candidate) => candidate.id === gate.field);
    const value = values[`${label}.${gate.field}`];
    if (schema?.topology === true && value !== undefined && !gate.values.includes(value))
      deactivated.add(parameter.id);
  }
  return deactivated;
}

/**
 * Derives carrier bands and replacement offers from a live chain.
 * @param {{catalog: OperatorCatalog, chain: () => ChainEntry[],
 *   legalSequences: (start: number, deleteCount: number, maxLength: number) => SequenceEntry[]}} source
 */
export function createChainPresentation({ catalog, chain: readChain, legalSequences }) {
  /** @type {Map<string, CatalogOperator>} */
  const operators = new Map(catalog.operators.map((op) => [op.id, op]));
  /** @param {ChainEntry} entry */
  const opOf = (entry) => /** @type {CatalogOperator} */ (operators.get(entry.operator));

  /**
   * @param {number} index - A gap position, 0..chain length.
   * @returns {string} The carrier crossing that gap.
   */
  const carrierAt = (index) => {
    const chain = readChain();
    if (chain.length === 0) return catalog.carriers[0];
    return index === 0 ? opOf(chain[0]).input : opOf(chain[index - 1]).output;
  };

  /**
   * Decomposes the chain into its editable carrier bands: each band's gap range
   * is the chain indices whose carrier is that band's, and the crossing that
   * leaves the band sits after it. The catalog's terminal carrier is the output
   * type and has no band.
   * @returns {BandLayout[]} One entry per editable carrier the chain stops in,
   *   in catalog order; a carrier it passes over has no band.
   */
  const bandLayout = () => {
    const chain = readChain();
    /** @type {BandLayout[]} */
    const bands = [];
    let index = 0;
    for (const carrier of catalog.carriers.slice(0, -1)) {
      /** @type {number[]} */
      const gaps = [];
      /** @type {number[]} */
      const chips = [];
      if (carrierAt(index) === carrier) {
        gaps.push(index);
        while (index < chain.length) {
          const op = opOf(chain[index]);
          if (op.input !== carrier || op.output !== carrier) break;
          chips.push(index);
          index += 1;
          gaps.push(index);
        }
      }
      let socket = null;
      if (index < chain.length && opOf(chain[index]).input === carrier) {
        socket = index;
        index += 1;
      }
      if (gaps.length === 0 && socket === null) continue;
      bands.push({ carrier, gaps, chips, socket });
    }
    return bands;
  };

  /**
   * @param {BandLayout} band - The band.
   * @returns {number|null} The gap after its last stage, or null without a gap.
   */
  const appendGap = (band) => band.gaps[band.gaps.length - 1] ?? null;

  /**
   * The one-for-one replacement of one chip: an operator the chip already
   * carries keeps its label, and with it every tuned value, rather than
   * re-seating the stage on the catalog's defaults.
   * @param {number} index - The chip's chain index.
   * @param {string} operatorId - The operator replacing it.
   * @returns {{label?: string, operator: string}} The replacement entry.
   */
  const replacementEntry = (index, operatorId) => {
    const entry = readChain()[index];
    return entry !== undefined && entry.operator === operatorId
      ? { label: entry.label, operator: operatorId } : { operator: operatorId };
  };

  /**
   * The replacement entries a span choice commits: a position the choice keeps
   * on the same operator keeps its instance, and with it every tuned value.
   * @param {SpanChoice} choice - The offer being taken.
   * @returns {Array<{label?: string, operator: string}>} The sequence.
   */
  const choiceEntries = (choice) => choice.operators.map((op, at) =>
    (at < choice.deleteCount ? replacementEntry(choice.start + at, op.id)
      : { operator: op.id }));

  /** @param {CatalogOperator[]} operators @returns {string} The choice's key. */
  const choiceKey = (operators) => operators.map((op) => op.id).join(' ');

  /**
   * What a socket offers in its selector and its replacement palette: the
   * sequences that stand in for the crossing — a longer one re-opening the
   * carrier bands the crossing skips — plus the single operators that swallow
   * it together with the unbroken run of crossings before it, which is the
   * collapse of a band the chain no longer stops in.
   * @param {number} index - The crossing's chain index.
   * @returns {SpanChoice[]} The offers, narrowest span first.
   */
  const socketChoices = (index) => {
    const chain = readChain();
    /** @type {Map<string, SpanChoice>} */
    const choices = new Map();
    /**
     * @param {number} start - Span start.
     * @param {number} deleteCount - Span length.
     * @param {number} maxLength - Longest sequence to offer.
     * @returns {void}
     */
    const offer = (start, deleteCount, maxLength) => {
      for (const { operators } of legalSequences(start, deleteCount, maxLength)) {
        const key = choiceKey(operators);
        if (!choices.has(key)) choices.set(key, { start, deleteCount, operators });
      }
    };
    offer(index, 1, catalog.carriers.length - 1);
    for (let start = index; start > 0; start -= 1) {
      const previous = opOf(chain[start - 1]);
      if (previous.input === previous.output) break;
      offer(start - 1, index - start + 2, 1);
    }
    return [...choices.values()];
  };

  /**
   * @param {number} index - A chip's chain index.
   * @param {number} step - -1 for the earlier neighbour, 1 for the later one.
   * @returns {boolean} Whether that neighbour is an endomorphism of the same
   *   carrier, which is the only direction a reorder can name.
   */
  const sharesBand = (index, step) => {
    const chain = readChain();
    const neighbour = chain[index + step];
    if (neighbour === undefined) return false;
    const op = opOf(chain[index]);
    return opOf(neighbour).input === op.input && opOf(neighbour).output === op.output;
  };

  return { opOf, carrierAt, bandLayout, appendGap, replacementEntry, choiceEntries, choiceKey, socketChoices, sharesBand };
}
