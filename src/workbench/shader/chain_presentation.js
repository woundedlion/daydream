// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { float32Decimal } from '../../shared/cpp_format.js';

/** @typedef {{id: string, topology?: boolean, values?: string[], gated_by?: {field: string, values: string[]}}} CatalogParameter */
/** @typedef {{id: string, name: string|null, input: string, output: string, params: CatalogParameter[]}} CatalogOperator */
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

export const PALETTE_OPERATOR = 'colorize.generated-palette.v4';
export const MODULATION_OPERATOR = 'color.modulate.v1';

/** @type {{name: string, fields: string[], source?: string}[]} */
export const COLOR_PARAMETER_GROUPS = [
  { name: 'Palette', fields: ['palette-type', 'palette-mode', 'palette-harmony',
    'palette-name', 'palette-name-b', 'palette-mutation', 'palette-hue', 'palette-spread',
    'palette-chroma', 'palette-lightness', 'palette-lightness-range', 'palette-lightness-curve'] },
  ...['start', 'middle', 'end'].map((stop) => ({ name: `Gradient ${stop}`,
    fields: ['r', 'g', 'b'].map((channel) => `gradient-${stop}-${channel}`) })),
  { name: 'Color mapping', fields: ['palette-mapping', 'mapping-frequency', 'mapping-phase',
    'phase-oscillation-depth', 'phase-oscillation-speed'] },
  { name: 'Brightness & opacity', fields: ['brightness-envelope', 'brightness-bottom',
    'brightness-top', 'value-opacity-low', 'value-opacity-high'] },
];

/** @type {{name: string, fields: string[], source?: string}[]} */
export const MODULATION_PARAMETER_GROUPS = [
  { name: 'Modulation', fields: ['modulation-enabled', 'modulation-source',
    'modulation-mechanic', 'modulation-amount', 'modulation-evaluation'] },
  { name: 'Noise', source: 'noise', fields: ['pattern-scale', 'pattern-speed',
    'pattern-noise-variant', 'pattern-noise-basis', 'pattern-contrast'] },
  { name: 'Sine wave', source: 'directional-sine', fields: ['sine-frequency', 'sine-speed',
    'sine-offset', 'sine-axis-x', 'sine-axis-y', 'sine-axis-z'] },
  { name: 'Interference · wave A', source: 'sphere-interference', fields: [
    'interference-frequency', 'interference-speed', 'interference-offset',
    'interference-axis-x', 'interference-axis-y', 'interference-axis-z'] },
  { name: 'Interference · wave B', source: 'sphere-interference', fields: [
    'interference-frequency-b', 'interference-offset-b', 'interference-axis-b-x',
    'interference-axis-b-y', 'interference-axis-b-z'] },
  { name: 'Grid · wave A', source: 'sphere-smooth-grid', fields: ['grid-frequency',
    'grid-speed', 'grid-offset', 'grid-axis-x', 'grid-axis-y', 'grid-axis-z'] },
  { name: 'Grid · wave B', source: 'sphere-smooth-grid', fields: ['grid-frequency-b',
    'grid-offset-b', 'grid-axis-b-x', 'grid-axis-b-y', 'grid-axis-b-z'] },
];

/** @type {Record<string, string>} */
export const COLOR_PARAMETER_NAMES = {
  'palette-type': 'Type', 'palette-mode': 'Harmony', 'palette-harmony': 'Harmony',
  'palette-chroma': 'Chroma', 'palette-name': 'Palette', 'palette-name-b': 'Second palette',
  'palette-mutation': 'Blend', 'palette-hue': 'Hue', 'palette-spread': 'Spread',
  'palette-lightness': 'Lightness', 'palette-lightness-range': 'Lightness range',
  'palette-lightness-curve': 'Lightness curve',
  'hue-shift-mode': 'Mode', 'hue-shift-amount': 'Amount',
  'palette-mapping': 'Shape', 'mapping-frequency': 'Repeats', 'mapping-phase': 'Phase',
  'phase-oscillation-depth': 'Phase motion depth', 'phase-oscillation-speed': 'Phase motion speed',
  'modulation-enabled': 'Enabled', 'modulation-source': 'Source',
  'modulation-mechanic': 'Affects', 'modulation-amount': 'Amount',
  'modulation-evaluation': 'Sampling', 'pattern-scale': 'Noise scale (frequency)',
  'pattern-speed': 'Noise speed', 'pattern-contrast': 'Noise contrast',
  'pattern-noise-basis': 'Noise basis', 'pattern-noise-variant': 'Noise detail',
  'interference-speed': 'Shared speed', 'grid-speed': 'Shared speed',
};

/**
 * @param {string} field - Modulation field id.
 * @param {(field: string) => *} value - Current modulation values.
 * @returns {boolean} Whether the field is hidden.
 */
export function modulationParameterHidden(field, value) {
  const group = MODULATION_PARAMETER_GROUPS.find((group) => group.fields.includes(field));
  const modulation = group?.source !== undefined || group?.name === 'Modulation';
  if (modulation && field !== 'modulation-enabled' && value('modulation-enabled') === 'disabled')
    return true;
  if (group?.source !== undefined && group.source !== value('modulation-source')) return true;
  if (field === 'modulation-evaluation' && value('modulation-source') !== 'noise') return true;
  return ['pattern-noise-basis', 'pattern-contrast'].includes(field)
    && value('pattern-noise-variant') !== 'octave-contour';
}

/** @param {string} field @param {(field: string) => *} value @returns {boolean} */
export function colorParameterHidden(field, value) {
  if (field.startsWith('hue-shift-') || MODULATION_PARAMETER_GROUPS.some(
    (group) => group.fields.includes(field))) return true;
  const type = value('palette-type') ?? 'cycling-generated';
  if (field === 'palette-mode') return type !== 'cycling-generated';
  if (['palette-harmony', 'palette-hue', 'palette-spread', 'palette-lightness',
    'palette-lightness-range', 'palette-lightness-curve'].includes(field)) return type !== 'generated';
  if (field === 'palette-name') return !['procedural', 'mutating'].includes(type);
  if (['palette-name-b', 'palette-mutation'].includes(field)) return type !== 'mutating';
  return field.startsWith('gradient-') && type !== 'gradient';
}

/**
 * @param {number} value - A stored parameter value.
 * @returns {string} The shortest decimal that reads back as the same binary32.
 */
export const formatNumericValue = (value) => String(float32Decimal(Number(value)));

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
 * The parameter ids deactivated by the catalog's topology-field gates.
 * Deactivated controls render dimmed; their values remain in the document.
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
    for (const carrier of catalog.carriers) {
      if (carrier === catalog.carriers.at(-1)
          && !catalog.operators.some((op) => op.input === carrier && op.output === carrier)) continue;
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
   * carries keeps its label, and with it every tuned value.
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
