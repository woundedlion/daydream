// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { createFrameScheduler } from './page_lifecycle.js';

/**
 * The pipeline strip: the loaded document's operator chain read left to right in
 * execution order as chips grouped into one band per editable carrier family, with the
 * family crossings drawn as socket chips on the band boundaries. The terminal
 * carrier is the pipeline's output type rather than an editable band, and is
 * conveyed by its incoming socket. Every structural gesture — palette insertion, ✕
 * removal, socket selection, button or Alt+Arrow reorder, and undo —
 * funnels into the document store's one span-replacement primitive, so the strip
 * can commit nothing the store's validator refuses; it only decides which spans
 * the gestures name. Selection and the session bypass set live in the store too:
 * the strip is a view plus gesture translation, rebuilt whole after every
 * committed edit with keyboard focus restored to the edited chip.
 *
 * Every chip carries its stage's controls inline, built from the document's
 * parameter declarations over the active preset's values, so a stage is tuned
 * where it sits in the pipeline.
 */

/** @typedef {{id: string, topology?: boolean, values?: string[]}} CatalogParameter */
/** @typedef {{id: string, name: string, input: string, output: string, params: CatalogParameter[]}} CatalogOperator */
/** @typedef {{carriers: string[], operators: CatalogOperator[]}} OperatorCatalog */
/** @typedef {{label: string, operator: string}} ChainEntry */
/** @typedef {[string, (value: *) => boolean]} GateRule */
/** @typedef {{operator: CatalogOperator, legal: boolean, reason?: string}} LegalityEntry */
/** @typedef {{severity: string, phase: string, code: string, path: string, message: string}} Diagnostic */
/** @typedef {{ok: true}|{ok: false, diagnostics: Diagnostic[]}} EditResult */
/**
 * The document-store surface the strip drives.
 * @typedef {{
 *   chain: () => ChainEntry[],
 *   selectedLabel: () => string|null,
 *   setSelectedLabel: (label: string|null) => boolean,
 *   bypassedLabels: () => string[],
 *   setBypassed: (label: string, on: boolean) => EditResult,
 *   legalInsertions: (index: number) => LegalityEntry[],
 *   legalReplacements: (start: number, deleteCount: number) => LegalityEntry[],
 *   document: () => *,
 *   replaceSpan: (start: number, deleteCount: number,
 *     sequence: Array<{label?: string, operator: string}>) => EditResult,
 *   undo: () => boolean, redo: () => boolean,
 *   canUndo: () => boolean, canRedo: () => boolean,
 * }} ChainStore
 */
/** @typedef {{id: string, storage: string, domain: *}} ParameterDeclaration */
/**
 * One carrier's run of the chain: the gap indices that fall inside it, the chain
 * indices of its endomorphism chips, and the crossing that closes it.
 * @typedef {{carrier: string, gaps: number[], chips: number[], socket: number|null}} BandLayout
 */

// Keeps a palette clamped inside the viewport clear of its edge.
const PALETTE_MARGIN = 8;

// Increments an editable readout's arrow keys divide its declared domain into.
const READOUT_STEPS = 1000;

const DEACTIVATED_TITLE = 'Deactivated by the current topology selection';

const MIN_SCROLL_STEP = 160;
const SCROLL_STEP_RATIO = 0.75;

// Pixels one WheelEvent.DOM_DELTA_LINE notch stands for.
const WHEEL_LINE_PX = 16;

/**
 * A socket's function name, by the carrier the crossing produces. A band holds
 * at most one socket and no two bands produce the same carrier, so these stay
 * distinct within a strip.
 * @type {Record<string, {name: string, accessibleName: string}>}
 */
const SOCKET_FUNCTIONS = {
  plane: { name: 'Projection', accessibleName: 'Projection' },
  field: { name: 'Source', accessibleName: 'Source function' },
  color: { name: 'Color', accessibleName: 'Color' },
};

/** @param {string} value @returns {string} The kebab-case value, title-cased. */
const titleCase = (value) => value.split('-')
  .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
  .join(' ');

/** @param {number} value @returns {string} A binary32-useful editable value. */
const formatNumericValue = (value) =>
  String(Number(Number(value).toPrecision(7)));

/**
 * @param {ParameterDeclaration} declaration - A binary32 declaration.
 * @returns {string} The increment its numeric readout's arrow keys nudge by.
 */
const nudgeStep = (declaration) => {
  const span = Number(declaration.domain?.maximum) - Number(declaration.domain?.minimum);
  return span > 0 ? String(span / READOUT_STEPS) : 'any';
};

/** @param {string} id @returns {string} The `<label>.<field>` id's field segment. */
const fieldOf = (id) => id.slice(id.indexOf('.') + 1);

/**
 * The parameter ids the current topology selections deactivate. Edge widths
 * require an edge-fade mode, hue controls require their corresponding hue mode,
 * and brightness depth requires a brightness envelope. Deactivation changes
 * what the engine reads, never what the document carries, so these controls
 * render dimmed rather than dropping out of the union schema.
 * @param {ParameterDeclaration[]} parameters - The document's declarations.
 * @param {Object<string, *>} values - The active preset's values.
 * @param {ChainEntry[]} chain - The document's operator instances.
 * @param {OperatorCatalog} catalog - Catalog declaring each topology field.
 * @returns {Set<string>} The deactivated parameter ids.
 */
export function deactivatedParameterIds(parameters, values, chain, catalog) {
  const operators = new Map(catalog.operators.map((operator) => [operator.id, operator]));
  const operatorByLabel = new Map(chain.map((entry) => [entry.label, operators.get(entry.operator)]));
  /** @type {Record<string, GateRule[]>} */
  const gateRules = {
    'edge-width': [
      ['coverage-mode', (value) => value === 'edge-fade'],
      ['envelope', (value) => value === 'edge-fade'],
    ],
    'hue-shift-amount': [['hue-shift-mode', (value) => value !== 'none']],
    'hue-noise-scale': [['hue-shift-mode', (value) => value === 'noise']],
    'hue-noise-speed': [['hue-shift-mode', (value) => value === 'noise']],
    'brightness-depth': [['brightness-envelope', (value) => value !== 'none']],
  };
  /** @type {Set<string>} */
  const deactivated = new Set();
  for (const parameter of parameters) {
    if (!parameter.id.includes('.')) continue;
    const field = fieldOf(parameter.id);
    const rules = gateRules[field];
    if (!rules) continue;
    const label = parameter.id.slice(0, parameter.id.indexOf('.'));
    const operator = operatorByLabel.get(label);
    for (const [gateField, active] of rules) {
      const schema = operator?.params.find((candidate) => candidate.id === gateField);
      const value = values[`${label}.${gateField}`];
      if (schema?.topology === true && value !== undefined && !active(value)) {
        deactivated.add(parameter.id);
        break;
      }
    }
  }
  return deactivated;
}

/**
 * Builds the pipeline strip into a container and wires its gestures.
 * @param {Object} options - The strip's collaborators.
 * @param {*} options.doc - Document the strip renders into.
 * @param {*} options.container - Element the strip owns.
 * @param {ChainStore} options.store - The chain document store.
 * @param {OperatorCatalog} options.catalog - The operator catalog.
 * @param {(message: string) => void} options.announce - Writes the workbench's
 *   one shared live status region; every refusal reports through it, and a
 *   committed edit clears it.
 * @param {() => void} options.onApply - Runs after every committed structural
 *   edit, undo/redo and bypass toggle; the caller re-applies the program shape
 *   through the engine.
 * @param {(label: string|null) => void} [options.onSelect] - Runs when the
 *   selected instance changes, which is also what expands the chip's controls.
 * @param {() => string|null} [options.presetId] - The preset the inline stage
 *   controls read and write; null falls back to the document's first.
 * @param {(parameterId: string, value: *) => void} [options.onEditParameter] -
 *   Takes every inline control edit as the document value the store stores: a
 *   number for a binary32 field, the option id for an enum8 one.
 * @param {() => void} [options.onCommitParameter] - Flushes work buffered while
 *   a range control was moving.
 * @returns {Object} The strip.
 */
export function createChainStrip({
  doc, container, store, catalog, announce, onApply, onSelect = () => {},
  presetId = () => null, onEditParameter = () => {}, onCommitParameter = () => {},
}) {
  /** @type {Map<string, CatalogOperator>} */
  const operators = new Map(catalog.operators.map((op) => [op.id, op]));
  /** @param {ChainEntry} entry */
  const opOf = (entry) => /** @type {CatalogOperator} */ (operators.get(entry.operator));

  /** @param {number} index @returns {LegalityEntry[]} */
  const insertionsAt = (index) => store.legalInsertions(index);

  /** @type {string|null} Roving-tabindex position, by instance label. */
  let focusedLabel = null;
  /** @type {string|null} The last selection onSelect was told about. */
  let notifiedSelection = null;
  /** @type {{element: *, anchor: *}|null} */
  let palette = null;
  /** @type {BandLayout[]} The current render's band decomposition. */
  let layout = [];
  /** @type {{undo: *, redo: *}|null} The current render's history buttons. */
  let history = null;
  /** @type {ParameterDeclaration[]} The current render's declarations. */
  let declarations = [];
  /** @type {Object<string, *>} The values the inline controls show. */
  let values = {};
  /** @type {Map<string, *>} The expanded chip's rows, by parameter id. */
  const rows = new Map();

  /**
   * @param {string} tag - Element tag.
   * @param {string} classes - Class attribute.
   * @returns {*} The created element.
   */
  const el = (tag, classes) => {
    const node = doc.createElement(tag);
    node.className = classes;
    return node;
  };

  /**
   * @param {number} index - A gap position, 0..chain length.
   * @returns {string} The carrier crossing that gap.
   */
  const carrierAt = (index) => {
    const chain = store.chain();
    if (chain.length === 0) return catalog.carriers[0];
    return index === 0 ? opOf(chain[0]).input : opOf(chain[index - 1]).output;
  };

  /**
   * Decomposes the chain into its editable carrier bands: each band's gap range
   * is the chain indices whose carrier is that band's, and the crossing that
   * leaves the band sits after it. The catalog's terminal carrier is the output
   * type and has no band.
   * @returns {BandLayout[]} One entry per editable carrier, in catalog order.
   */
  const bandLayout = () => {
    const chain = store.chain();
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
   * @param {string} operatorId - A catalog operator.
   * @returns {number[]} Every gap the store accepts it at, in chain order.
   */
  const acceptingGaps = (operatorId) => {
    const chain = store.chain();
    /** @type {number[]} */
    const gaps = [];
    for (let gap = 0; gap <= chain.length; gap += 1) {
      const entry = insertionsAt(gap)
        .find((candidate) => candidate.operator.id === operatorId);
      if (entry?.legal) gaps.push(gap);
    }
    return gaps;
  };

  /**
   * The sockets a crossing can reach: the chain's crossings over its own
   * carrier pair. Both sides of a gap carry one carrier, so a crossing fits
   * none, and replacing one of these sockets is its only route in.
   * @param {CatalogOperator} op - A catalog operator.
   * @returns {number[]} Their chain indices, in chain order.
   */
  const pairSockets = (op) => {
    if (op.input === op.output) return [];
    /** @type {number[]} */
    const sockets = [];
    store.chain().forEach((entry, index) => {
      const socket = opOf(entry);
      if (socket.input === op.input && socket.output === op.output) sockets.push(index);
    });
    return sockets;
  };

  /**
   * @param {CatalogOperator} op - A catalog operator.
   * @returns {number|null} The first socket over its pair the store accepts it
   *   as a replacement of, or null where none does.
   */
  const swapSocket = (op) => pairSockets(op).find((index) => store.legalReplacements(index, 1)
    .some((entry) => entry.operator.id === op.id && entry.legal)) ?? null;

  /**
   * The catalog's legality for a click, which lands an endomorphism at the
   * first gap that accepts it and a crossing on the first socket over its pair
   * (§4.2: crossings are changed by replacement, not insertion). Either way the
   * reason describes the chain rather than one gap: an endomorphism no gap
   * takes reports the refusal from a gap whose carrier it consumes — a budget,
   * not a carrier mismatch — while a crossing names the socket it swaps, which
   * it carries alongside a legal verdict so the entry advertises its route.
   * @returns {LegalityEntry[]} One entry per catalog operator, in catalog order.
   */
  const insertionLegality = () => {
    const chain = store.chain();
    /** @type {Set<string>} */
    const accepted = new Set();
    /** @type {Map<string, string>} */
    const refused = new Map();
    for (let gap = 0; gap <= chain.length; gap += 1) {
      const carrier = carrierAt(gap);
      for (const entry of insertionsAt(gap)) {
        const id = entry.operator.id;
        if (entry.legal) accepted.add(id);
        else if (entry.operator.input === carrier && !refused.has(id))
          refused.set(id, entry.reason ?? '');
      }
    }
    return catalog.operators.map((op) => {
      if (accepted.has(op.id)) return { operator: op, legal: true };
      if (op.input !== op.output) {
        const pair = `${op.input} → ${op.output}`;
        const sockets = pairSockets(op);
        if (sockets.length === 0) {
          return { operator: op, legal: false,
            reason: `the chain carries no ${pair} socket to swap` };
        }
        if (swapSocket(op) !== null)
          return { operator: op, legal: true, reason: `swaps the ${pair} socket` };
        const refusal = store.legalReplacements(sockets[0], 1)
          .find((entry) => entry.operator.id === op.id)?.reason ?? '';
        return { operator: op, legal: false,
          reason: `the ${pair} socket refuses it: ${refusal}` };
      }
      const refusal = refused.get(op.id) ?? `the chain carries no ${op.input} gap`;
      return { operator: op, legal: false,
        reason: `no insertion point accepts it: ${refusal}` };
    });
  };

  /**
   * @param {string} selector - Element class selector.
   * @param {string} attribute - Dataset key to match.
   * @param {string} value - Value to match.
   * @returns {*|null} The first match.
   */
  const elementBy = (selector, attribute, value) => {
    for (const node of container.querySelectorAll(selector)) {
      if (node.dataset[attribute] === value) return node;
    }
    return null;
  };

  /** @param {string} label @returns {*|null} The chip carrying the instance. */
  const chipByLabel = (label) => elementBy('.chain-chip', 'label', label);

  /** @param {number} index @returns {*|null} The chip at that chain index. */
  const chipAt = (index) => elementBy('.chain-chip', 'index', String(index));

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

  /** Tells the caller when the store's selection has moved. */
  const notifySelection = () => {
    const selected = store.selectedLabel();
    if (selected === notifiedSelection) return;
    notifiedSelection = selected;
    onSelect(selected);
  };

  /**
   * Rebuilds the strip after a committed edit, restores focus, and re-applies
   * the program through the caller.
   * @param {string|null} focusLabel - Chip to hand keyboard focus back to.
   * @returns {true} Always true, for tail-calling.
   */
  const commit = (focusLabel) => {
    announce('');
    render({ focusLabel });
    notifySelection();
    onApply();
    return true;
  };

  /**
   * Selects one chip (or clears the selection) and re-renders.
   * @param {string|null} label - The instance label, or null.
   * @returns {void}
   */
  const select = (label) => {
    const selected = label === store.selectedLabel() ? null : label;
    if (!store.setSelectedLabel(selected)) return;
    if (selected !== null) focusedLabel = selected;
    render({ focusLabel: label });
    notifySelection();
  };

  /**
   * The one-for-one replacement of one chip: an operator the chip already
   * carries keeps its label, and with it every tuned value, rather than
   * re-seating the stage on the catalog's defaults.
   * @param {number} index - The chip's chain index.
   * @param {string} operatorId - The operator replacing it.
   * @returns {{label?: string, operator: string}} The replacement entry.
   */
  const replacementEntry = (index, operatorId) => {
    const entry = store.chain()[index];
    return entry !== undefined && entry.operator === operatorId
      ? { label: entry.label, operator: operatorId } : { operator: operatorId };
  };

  /**
   * @param {number} index - A chip's chain index.
   * @param {number} step - -1 for the earlier neighbour, 1 for the later one.
   * @returns {boolean} Whether that neighbour is an endomorphism of the same
   *   carrier, which is the only direction a reorder can name.
   */
  const sharesBand = (index, step) => {
    const chain = store.chain();
    const neighbour = chain[index + step];
    if (neighbour === undefined) return false;
    const op = opOf(chain[index]);
    return opOf(neighbour).input === op.input && opOf(neighbour).output === op.output;
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
   * Toggles one endomorphism's session bypass and re-applies the program.
   * @param {string} label - The instance label.
   * @returns {void}
   */
  const toggleBypass = (label) => {
    const on = !store.bypassedLabels().includes(label);
    const result = store.setBypassed(label, on);
    if (!result.ok) {
      report(result);
      return;
    }
    announce('');
    render({ focusLabel: label, focusBypass: true });
    onApply();
  };

  const undo = () => {
    if (!store.undo()) return false;
    return commit(focusedLabel);
  };

  const redo = () => {
    if (!store.redo()) return false;
    return commit(focusedLabel);
  };

  /**
   * Anchors an open palette under the control that opened it, clamped inside
   * the viewport.
   * @param {*} element - The open palette.
   * @param {*} anchor - The control it opened from.
   * @returns {void}
   */
  const placePalette = (element, anchor) => {
    if (typeof element.getBoundingClientRect !== 'function'
      || typeof anchor.getBoundingClientRect !== 'function') return;
    const width = element.getBoundingClientRect().width;
    const viewport = doc.documentElement?.clientWidth ?? 0;
    const anchorBounds = anchor.getBoundingClientRect();
    let left = anchorBounds.left;
    if (viewport > 0) left = Math.min(left, viewport - width - PALETTE_MARGIN);
    element.style.left = `${Math.max(PALETTE_MARGIN, left)}px`;
    element.style.top = `${anchorBounds.bottom}px`;
  };

  /** Removes an open palette without committing anything. */
  const closePalette = () => {
    if (palette === null) return;
    const element = palette.element;
    palette = null;
    element.remove();
  };

  /**
   * Dismisses an open palette on a press outside it. The document outlives the
   * strip, so destroy() must take this back off.
   * @param {*} event - A pointerdown anywhere in the document.
   * @returns {void}
   */
  const dismissPalette = (event) => {
    if (palette === null || palette.element.contains(event.target)) return;
    closePalette();
  };

  /**
   * Opens the one palette with only the operators valid at this position, plus
   * a leading Remove entry where the empty replacement is legal.
   * @param {Object} options - What the palette replaces.
   * @param {'insert'|'replace'} options.kind - Insertion at a gap or replacement
   *   of one chip.
   * @param {number} options.index - The gap or chip chain index.
   * @param {*} options.anchor - Element the palette sits after and Escape
   *   returns focus to.
   * @param {*} [options.origin] - Control the palette is placed under, where
   *   that is not the anchor itself; a socket chip anchors the palette but its
   *   swap button is what opened it.
   * @returns {void}
   */
  const openPalette = ({ kind, index, anchor, origin = anchor }) => {
    closePalette();
    const chain = store.chain();
    const entries = kind === 'insert'
      ? insertionsAt(index)
      : store.legalReplacements(index, 1);
    const removable = kind === 'replace'
      && opOf(chain[index]).input === opOf(chain[index]).output;
    const title = kind === 'insert'
      ? `Insert at position ${index + 1}`
      : `Replace ${opOf(chain[index]).name} · ${chain[index].label}`;

    const element = el('div', 'chain-palette');
    element.setAttribute('role', 'listbox');
    element.setAttribute('aria-label', title);

    /**
     * @param {*} entry - The activated palette entry.
     * @returns {void}
     */
    const activate = (entry) => {
      const remove = entry.dataset.remove === 'true';
      const result = remove
        ? store.replaceSpan(index, 1, [])
        : store.replaceSpan(index, kind === 'insert' ? 0 : 1,
          [kind === 'insert' ? { operator: entry.dataset.operator }
            : replacementEntry(index, entry.dataset.operator)]);
      if (!result.ok) {
        report(result);
        return;
      }
      palette = null;
      const after = store.chain();
      const focusLabel = remove
        ? (after[index]?.label ?? after[index - 1]?.label ?? null)
        : (after[index]?.label ?? null);
      if (kind === 'insert') store.setSelectedLabel(focusLabel);
      commit(focusLabel);
    };

    /** @type {Array<*>} */
    const options = [];
    /**
     * @param {*} option - A built palette entry.
     * @returns {void}
     */
    const addOption = (option) => {
      option.setAttribute('role', 'option');
      option.setAttribute('tabindex', '-1');
      option.setAttribute('aria-selected', 'false');
      option.addEventListener('click', () => activate(option));
      options.push(option);
      element.appendChild(option);
    };

    /**
     * Focuses one option, carrying the listbox's single selection with it.
     * @param {*} option - The option to focus.
     * @returns {void}
     */
    const focusOption = (option) => {
      for (const other of options) {
        other.setAttribute('aria-selected', String(other === option));
      }
      option.focus();
    };

    if (removable) {
      const remove = el('div', 'chain-palette-entry chain-palette-entry--remove');
      remove.dataset.remove = 'true';
      remove.textContent = 'Remove';
      addOption(remove);
    }
    for (const legality of entries.filter((entry) => entry.legal)) {
      const option = el('div', 'chain-palette-entry');
      option.dataset.operator = legality.operator.id;
      const name = el('span', 'chain-palette-name');
      name.textContent = legality.operator.name;
      option.appendChild(name);
      addOption(option);
    }

    element.addEventListener('keydown', (/** @type {*} */ event) => {
      const key = event.key;
      if (key === 'Escape') {
        event.preventDefault();
        closePalette();
        anchor.focus();
        return;
      }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        const target = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('.chain-palette-entry') : null;
        const at = options.indexOf(target);
        const next = options[at + (key === 'ArrowDown' ? 1 : -1)];
        if (next) focusOption(next);
        return;
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        const target = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('.chain-palette-entry') : null;
        if (target) activate(target);
      }
    });

    element.addEventListener('focusout', (/** @type {*} */ event) => {
      if (palette?.element !== element) return;
      const next = event.relatedTarget ?? null;
      if (next !== null && element.contains(next)) return;
      closePalette();
    });

    // After the anchor, so the palette reads in place; childNodes is walked by
    // index because fake and real child lists share indexOf only through the
    // array prototype.
    const parent = anchor.parentNode;
    const at = Array.prototype.indexOf.call(parent.childNodes, anchor);
    parent.insertBefore(element, parent.childNodes[at + 1] ?? null);
    placePalette(element, origin);
    palette = { element, anchor };
    const first = options[0];
    if (first) focusOption(first);
  };

  /**
   * Moves keyboard focus to the chip at a chain index, updating the roving
   * tabindex.
   * @param {number} index - Target chain index.
   * @returns {void}
   */
  const focusChip = (index) => {
    const chip = chipAt(index);
    if (!chip) return;
    for (const other of container.querySelectorAll('.chain-chip')) {
      other.setAttribute('tabindex', other === chip ? '0' : '-1');
    }
    focusedLabel = chip.dataset.label ?? null;
    chip.focus();
  };

  /**
   * @param {*} event - A chip's keydown.
   * @param {number} index - The chip's chain index.
   * @param {ChainEntry} entry - The chain entry.
   * @param {boolean} crossing - Whether the operator crosses carriers.
   * @param {*} chip - The chip element.
   * @returns {void}
   */
  const chipKeydown = (event, index, entry, crossing, chip) => {
    const inside = event.target !== chip;
    if (inside) return;
    const key = event.key;
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      event.preventDefault();
      const forward = key === 'ArrowRight';
      if (!event.altKey) {
        focusChip(forward ? index + 1 : index - 1);
        return;
      }
      // The same span the '‹ ›' buttons disable themselves outside of: a
      // crossing has no reorder, and a band edge has no neighbour to swap with.
      if (crossing || !sharesBand(index, forward ? 1 : -1)) return;
      moveChip(index, forward ? index + 2 : index - 1);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      select(entry.label);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      if (crossing) openPalette({ kind: 'replace', index, anchor: chip });
      else removeChip(index);
      return;
    }
    if (key === 'Insert') {
      event.preventDefault();
      openPalette({ kind: 'insert', index: index + 1, anchor: chip });
    }
  };

  // Only the workbench page carries the stylesheet that reads this attribute.
  /** Repaints the dimming of the expanded chip's deactivated controls. */
  const markDeactivated = () => {
    const off = deactivatedParameterIds(declarations, values, store.chain(), catalog);
    for (const [id, row] of rows) {
      if (off.has(id)) {
        row.dataset.deactivated = 'true';
        row.setAttribute('title', DEACTIVATED_TITLE);
      } else {
        delete row.dataset.deactivated;
        row.removeAttribute('title');
      }
    }
  };

  /**
   * Takes one inline control edit: the document write is the caller's, and the
   * strip keeps the value it now shows so a topology edit re-dims what the new
   * selection deactivates.
   * @param {string} parameterId - The edited parameter.
   * @param {*} value - The document value.
   * @returns {void}
   */
  const editParameter = (parameterId, value) => {
    values[parameterId] = value;
    onEditParameter(parameterId, value);
    markDeactivated();
  };
  /** @type {{parameterId: string, value: number}|null} */
  let pendingSliderEdit = null;
  const scheduleSliderEdit = createFrameScheduler(() => {
    const edit = pendingSliderEdit;
    pendingSliderEdit = null;
    if (edit !== null) editParameter(edit.parameterId, edit.value);
  });
  const commitSliderEdit = () => {
    scheduleSliderEdit.cancel();
    const edit = pendingSliderEdit;
    pendingSliderEdit = null;
    if (edit !== null) editParameter(edit.parameterId, edit.value);
  };

  /**
   * @param {ParameterDeclaration} declaration - An enum8 declaration.
   * @returns {*} The dropdown of its domain values.
   */
  const enumControl = (declaration) => {
    const select = el('select', 'chain-param-control');
    for (const value of declaration.domain?.values ?? []) {
      const option = el('option', 'chain-param-option');
      option.value = value;
      option.textContent = value;
      option.selected = value === values[declaration.id];
      select.appendChild(option);
    }
    select.addEventListener('change',
      (/** @type {*} */ event) => editParameter(declaration.id, event.target.value));
    return select;
  };

  /**
   * @param {ParameterDeclaration} declaration - A binary32 declaration.
   * @param {*} readout - The row's value readout, repainted as the slider moves.
   * @returns {*} The slider over its domain.
   */
  const sliderControl = (declaration, readout) => {
    const slider = el('input', 'chain-param-control');
    const minimum = Number(declaration.domain?.minimum);
    const maximum = Number(declaration.domain?.maximum);
    slider.type = 'range';
    slider.min = String(minimum);
    slider.max = String(maximum);
    // A range input re-snaps its value onto its step grid, so any grid at all
    // rewrites the authored value the moment the control is touched. Arrow keys
    // stay usable without one: a step-free range nudges by a hundredth of span.
    slider.step = 'any';
    slider.value = String(values[declaration.id]);
    slider.addEventListener('input', (/** @type {*} */ event) => {
      const value = Number(event.target.value);
      readout.value = formatNumericValue(value);
      values[declaration.id] = value;
      pendingSliderEdit = { parameterId: declaration.id, value };
      scheduleSliderEdit();
    });
    slider.addEventListener('change', () => {
      commitSliderEdit();
      onCommitParameter();
    });
    return slider;
  };

  /**
   * The expanded chip's own controls, one row per parameter the document
   * declares for the instance, labeled by the field segment alone: the chip
   * already names the instance.
   * @param {ChainEntry} entry - The expanded chain entry.
   * @param {ParameterDeclaration[]} declared - The instance's declarations.
   * @returns {*} The parameter region.
   */
  const paramsElement = (entry, declared) => {
    const region = el('div', 'chain-chip-params');
    region.dataset.label = entry.label;
    region.setAttribute('role', 'group');
    region.setAttribute('aria-label', `${opOf(entry).name} · ${entry.label} parameters`);
    for (const declaration of declared) {
      const name = titleCase(fieldOf(declaration.id));
      const row = el('div', 'chain-param');
      row.dataset.parameter = declaration.id;
      const label = el('span', 'chain-param-name');
      label.textContent = name;
      row.appendChild(label);
      if (declaration.storage === 'enum8') {
        const select = enumControl(declaration);
        select.setAttribute('aria-label', name);
        row.appendChild(select);
      } else {
        const readout = el('input', 'chain-param-value');
        readout.type = 'number';
        readout.value = formatNumericValue(values[declaration.id]);
        const slider = sliderControl(declaration, readout);
        slider.setAttribute('aria-label', name);
        readout.min = slider.min;
        readout.max = slider.max;
        // A number input never re-snaps, so the readout carries the finer grid
        // its arrow keys nudge by.
        readout.step = nudgeStep(declaration);
        readout.setAttribute('aria-label', `${name} value`);
        readout.addEventListener('change', (/** @type {*} */ event) => {
          const typed = Number(event.target.value);
          const current = Number(values[declaration.id]);
          const value = Number.isFinite(typed)
            ? Math.min(Number(slider.max), Math.max(Number(slider.min), typed))
            : current;
          readout.value = formatNumericValue(value);
          if (value === current) return;
          slider.value = String(value);
          editParameter(declaration.id, value);
        });
        row.appendChild(slider);
        row.appendChild(readout);
      }
      rows.set(declaration.id, row);
      region.appendChild(row);
    }
    return region;
  };

  /**
   * @param {number} index - The entry's chain index.
   * @param {ChainEntry} entry - The chain entry.
   * @param {Object} view - Render-pass state.
   * @param {boolean} view.crossing - Whether the operator crosses carriers.
   * @param {string|null} view.selected - The selected label.
   * @param {Set<string>} view.bypassed - The bypassed labels.
   * @param {string|null} view.tabLabel - The roving-tabindex label.
   * @returns {*} The chip element.
   */
  const chipElement = (index, entry, {
    crossing, selected, bypassed, tabLabel,
  }) => {
    const op = opOf(entry);
    const isSelected = selected === entry.label;
    const isBypassed = bypassed.has(entry.label);
    const declared = declarations.filter(
      (declaration) => declaration.id.startsWith(`${entry.label}.`));
    const hasParams = declared.length > 0;
    const expanded = hasParams && isSelected;
    const chip = el('div', 'chain-chip'
      + (crossing ? ' chain-chip--socket' : ' chain-chip--stage')
      + (expanded ? ' chain-chip--expanded' : '')
      + (isBypassed ? ' chain-chip--bypassed' : ''));
    chip.dataset.label = entry.label;
    chip.dataset.index = String(index);
    // Not a listbox option: an option's children are presentational, which
    // hides the chip's inline stage controls from assistive technology.
    chip.setAttribute('role', 'group');
    if (isSelected) chip.setAttribute('aria-current', 'true');
    if (hasParams) chip.setAttribute('aria-expanded', String(expanded));
    chip.setAttribute('tabindex', tabLabel === entry.label ? '0' : '-1');
    chip.setAttribute('aria-label', `${op.name} · ${entry.label}`
      + (crossing ? `, ${op.input} to ${op.output}` : '')
      + (isBypassed ? ', bypassed' : ''));
    const header = el('div', 'chain-chip-header');

    if (crossing) {
      const functionLabel = el('label', 'chain-chip-function-label');
      const socketFunction = SOCKET_FUNCTIONS[op.output] ?? {
        name: titleCase(op.output),
        accessibleName: `${titleCase(op.output)} function`,
      };
      functionLabel.textContent = `${socketFunction.name}: `;
      const replacement = el('select', 'chain-chip-replace');
      replacement.setAttribute('aria-label', socketFunction.accessibleName);
      for (const legality of store.legalReplacements(index, 1)
        .filter((candidate) => candidate.legal)) {
        const option = el('option', 'chain-chip-replace-option');
        option.value = legality.operator.id;
        option.textContent = legality.operator.name;
        option.selected = legality.operator.id === entry.operator;
        replacement.appendChild(option);
      }
      replacement.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
      });
      replacement.addEventListener('change', (/** @type {*} */ event) => {
        event.stopPropagation();
        const result = store.replaceSpan(index, 1,
          [replacementEntry(index, event.target.value)]);
        if (!result.ok) {
          report(result);
          return;
        }
        commit(store.chain()[index]?.label ?? null);
      });
      functionLabel.appendChild(replacement);
      header.appendChild(functionLabel);
    } else {
      const name = el('span', 'chain-chip-name');
      name.textContent = op.name;
      header.appendChild(name);
      const toggle = el('button', 'chain-chip-bypass');
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', String(isBypassed));
      toggle.setAttribute('aria-label', `Bypass ${op.name} · ${entry.label}`);
      toggle.setAttribute('title', 'Bypass');
      toggle.textContent = '◉';
      toggle.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        toggleBypass(entry.label);
      });
      header.appendChild(toggle);
      const earlier = el('button', 'chain-chip-move');
      earlier.type = 'button';
      earlier.textContent = '←';
      earlier.disabled = !sharesBand(index, -1);
      earlier.setAttribute('aria-label', `Move ${op.name} · ${entry.label} earlier`);
      earlier.setAttribute('title', 'Move earlier');
      earlier.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        moveChip(index, index - 1);
      });
      const later = el('button', 'chain-chip-move');
      later.type = 'button';
      later.textContent = '→';
      later.disabled = !sharesBand(index, 1);
      later.setAttribute('aria-label', `Move ${op.name} · ${entry.label} later`);
      later.setAttribute('title', 'Move later');
      later.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        moveChip(index, index + 2);
      });
      header.appendChild(earlier);
      header.appendChild(later);
      const remove = el('button', 'chain-chip-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${op.name} · ${entry.label}`);
      remove.setAttribute('title', 'Delete');
      remove.textContent = '×';
      remove.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        removeChip(index);
      });
      header.appendChild(remove);
    }

    chip.appendChild(header);
    if (hasParams) chip.appendChild(paramsElement(entry, declared));

    chip.addEventListener('click', (/** @type {*} */ event) => {
      const clickedHeader = event.target === chip
        || event.target?.closest?.('.chain-chip-header') === header;
      if (clickedHeader) select(entry.label);
    });
    if (hasParams) {
      const setTransientOpen = (/** @type {boolean} */ open) => {
        if (store.selectedLabel() === entry.label) return;
        chip.classList.toggle('chain-chip--expanded', open);
        chip.setAttribute('aria-expanded', String(open));
        container.dataset.expanded = String(
          container.querySelector('.chain-chip--expanded') !== null);
        if (open) markDeactivated();
      };
      chip.addEventListener('mouseenter', () => setTransientOpen(true));
      chip.addEventListener('mouseleave', () => setTransientOpen(false));
    }
    chip.addEventListener('keydown',
      (/** @type {*} */ event) => chipKeydown(event, index, entry, crossing, chip));
    return chip;
  };

  /**
   * @param {BandLayout} band - The band the button belongs to.
   * @returns {*|null} The band's insertion affordance, when a stage fits.
   */
  const bandAddButton = (band) => {
    const title = titleCase(band.carrier);
    const gap = appendGap(band);
    if (gap === null || !insertionsAt(gap).some((entry) => entry.legal))
      return null;
    const add = el('button', 'chain-band-add');
    add.type = 'button';
    add.setAttribute('aria-haspopup', 'listbox');
    add.setAttribute('aria-label', `Add a ${title} stage`);
    add.textContent = '+';
    add.addEventListener('click',
      () => openPalette({ kind: 'insert', index: gap, anchor: add }));
    return add;
  };

  /** @param {*} viewport @param {number} direction */
  const scrollPipeline = (viewport, direction) => {
    const distance = Math.max(MIN_SCROLL_STEP,
      Number(viewport.clientWidth ?? 0) * SCROLL_STEP_RATIO);
    viewport.scrollLeft = Math.max(0,
      Number(viewport.scrollLeft ?? 0) + direction * distance);
  };

  /** @param {*} viewport @param {number} direction @returns {*} */
  const scrollButton = (viewport, direction) => {
    const button = el('button', 'chain-scroll-button');
    button.type = 'button';
    button.setAttribute('aria-label', direction < 0
      ? 'Scroll shader chain left' : 'Scroll shader chain right');
    button.textContent = direction < 0 ? '‹' : '›';
    button.addEventListener('click', () => scrollPipeline(viewport, direction));
    return button;
  };

  /**
   * Rebuilds the whole strip from the store. Keyboard focus is restored to the
   * named chip (its bypass toggle when asked), or to the roving-tabindex chip
   * when the strip held focus before the rebuild.
   * @param {{focusLabel?: string|null, focusBypass?: boolean}} [options]
   * @returns {void}
   */
  const render = ({ focusLabel = null, focusBypass = false } = {}) => {
    const active = doc.activeElement ?? null;
    const hadFocus = active !== null && container.contains(active);
    palette = null;
    layout = bandLayout();
    rows.clear();

    const snapshot = store.document();
    declarations = snapshot.descriptor.parameters;
    const presets = snapshot.preset_bank.presets;
    const preset = presets.find(
      (/** @type {*} */ candidate) => candidate.preset_id === presetId()) ?? presets[0];
    values = { ...preset?.values };

    const chain = store.chain();
    const selected = store.selectedLabel();
    const bypassed = new Set(store.bypassedLabels());
    const labels = chain.map((entry) => entry.label);
    const tabLabel = focusLabel !== null && labels.includes(focusLabel) ? focusLabel
      : focusedLabel !== null && labels.includes(focusedLabel) ? focusedLabel
      : selected ?? labels[0] ?? null;

    const actions = el('div', 'chain-strip-actions');
    const undoButton = el('button', 'chain-undo');
    undoButton.type = 'button';
    undoButton.textContent = 'Undo';
    undoButton.disabled = !store.canUndo();
    undoButton.addEventListener('click', () => undo());
    const redoButton = el('button', 'chain-redo');
    redoButton.type = 'button';
    redoButton.textContent = 'Redo';
    redoButton.disabled = !store.canRedo();
    redoButton.addEventListener('click', () => redo());
    actions.appendChild(undoButton);
    actions.appendChild(redoButton);
    history = { undo: undoButton, redo: redoButton };

    const strip = el('div', 'chain-strip');
    strip.setAttribute('role', 'toolbar');
    strip.setAttribute('aria-label', 'Shader chain');
    strip.setAttribute('aria-orientation', 'horizontal');
    const view = { selected, bypassed, tabLabel };
    for (const band of layout) {
      const title = titleCase(band.carrier);
      const element = el('div', 'chain-band');
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', `${title} stages`);
      element.dataset.carrier = band.carrier;
      const heading = el('div', 'chain-band-title');
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = title;
      element.appendChild(heading);
      for (const chip of band.chips) {
        element.appendChild(chipElement(chip, chain[chip],
          { crossing: false, ...view }));
      }
      const add = bandAddButton(band);
      if (add !== null) element.appendChild(add);
      strip.appendChild(element);
      if (band.socket !== null) {
        strip.appendChild(chipElement(band.socket, chain[band.socket],
          { crossing: true, ...view }));
      }
    }

    const viewport = el('div', 'chain-strip-viewport');
    viewport.setAttribute('tabindex', '0');
    viewport.setAttribute('aria-label', 'Scrollable shader chain');
    viewport.appendChild(strip);
    viewport.addEventListener('wheel', (/** @type {*} */ event) => {
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      const width = Number(viewport.clientWidth ?? 0);
      const overflow = Number(viewport.scrollWidth ?? 0) - width;
      // Nothing to scroll: the wheel belongs to whatever encloses the strip.
      if (overflow <= 0) return;
      // deltaMode counts pixels, lines or pages; a line-mode browser sends 3
      // where a pixel-mode one sends 100.
      const scale = event.deltaMode === 1 ? WHEEL_LINE_PX
        : event.deltaMode === 2 ? Math.max(MIN_SCROLL_STEP, width) : 1;
      viewport.scrollLeft = Math.min(overflow,
        Math.max(0, Number(viewport.scrollLeft ?? 0) + delta * scale));
      event.preventDefault();
    }, { passive: false });
    viewport.addEventListener('keydown', (/** @type {*} */ event) => {
      if (event.target !== viewport
        || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      scrollPipeline(viewport, event.key === 'ArrowLeft' ? -1 : 1);
    });

    container.replaceChildren(actions, scrollButton(viewport, -1), viewport,
      scrollButton(viewport, 1));
    container.dataset.expanded = String(
      container.querySelector('.chain-chip--expanded') !== null);
    markDeactivated();

    const target = focusLabel !== null ? chipByLabel(focusLabel) : null;
    if (target) {
      focusedLabel = focusLabel;
      if (focusBypass) {
        const toggle = target.querySelector('.chain-chip-bypass');
        (toggle ?? target).focus();
      } else {
        target.focus();
      }
    } else if (hadFocus || focusLabel !== null) {
      const fallback = tabLabel !== null ? chipByLabel(tabLabel) : null;
      if (fallback) {
        focusedLabel = tabLabel;
        fallback.focus();
      }
    }
  };

  /**
   * Lands a catalog operator without a drag: an endomorphism at the gap after
   * the selected chip when that gap accepts it, else at the first gap that
   * does; a crossing over the socket its carrier pair names, which is the
   * replacement the socket's own swap control commits. A stage that lands in
   * a gap takes the selection, opening its controls.
   * @param {string} operatorId - The operator to land.
   * @returns {boolean} Whether the edit committed.
   */
  const insertOperator = (operatorId) => {
    const gaps = acceptingGaps(operatorId);
    const selected = store.selectedLabel();
    const at = selected === null ? null
      : store.chain().findIndex((entry) => entry.label === selected) + 1;
    const op = operators.get(operatorId);
    const socket = gaps.length > 0 || op === undefined ? null : swapSocket(op);
    const index = at !== null && gaps.includes(at) ? at : gaps[0] ?? socket;
    if (index === null) {
      announce(insertionLegality().find((entry) => entry.operator.id === operatorId)
        ?.reason ?? `${operatorId} fits nowhere in this chain`);
      return false;
    }
    const result = store.replaceSpan(index, socket === null ? 0 : 1,
      [socket === null ? { operator: operatorId }
        : replacementEntry(socket, operatorId)]);
    if (!result.ok) return report(result);
    const landed = store.chain()[index]?.label ?? null;
    if (socket === null) store.setSelectedLabel(landed);
    return commit(landed);
  };

  /**
   * The container's history shortcut. The container outlives the strip, so
   * destroy() must take it back off.
   * @param {*} event - A keydown anywhere in the strip.
   * @returns {void}
   */
  const historyKeydown = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      redo();
    }
  };
  container.addEventListener('keydown', historyKeydown);
  doc.addEventListener('pointerdown', dismissPalette);

  render();

  return {
    render,
    insertOperator,
    insertionLegality,

    /**
     * Repaints the Undo/Redo buttons a value edit moved, which a rebuild would
     * do too — but a rebuild during a slider drag would replace the control
     * under the pointer.
     * @returns {void}
     */
    syncHistory() {
      if (history === null) return;
      history.undo.disabled = !store.canUndo();
      history.redo.disabled = !store.canRedo();
    },

    flushParameterEdit: commitSliderEdit,

    /**
     * Detaches the strip's listeners and empties its container. Every other
     * listener sits on an element the strip built inside the container, so
     * emptying it drops them.
     * @returns {void}
     */
    destroy() {
      scheduleSliderEdit.cancel();
      pendingSliderEdit = null;
      container.removeEventListener('keydown', historyKeydown);
      doc.removeEventListener('pointerdown', dismissPalette);
      container.replaceChildren();
    },
  };
}
