// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The pipeline strip: the loaded document's operator chain read left to right in
 * execution order as chips grouped into one band per carrier family, with the
 * family crossings drawn as socket chips on the band boundaries. All four bands
 * render whether or not they hold a stage, so the strip reads as the pipeline
 * even where a run is empty. Every structural gesture — palette insertion, ✕
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

/** @typedef {{id: string, name: string, input: string, output: string, params: Array<Object>}} CatalogOperator */
/** @typedef {{carriers: string[], operators: CatalogOperator[]}} OperatorCatalog */
/** @typedef {{label: string, operator: string}} ChainEntry */
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

// Steps a slider divides its declared domain into.
const SLIDER_STEPS = 1000;

// Decimals a slider's value readout carries.
const VALUE_DECIMALS = 3;

const DEACTIVATED_TITLE = 'Deactivated by the current topology selection';

/** @param {string} value @returns {string} The kebab-case value, title-cased. */
const titleCase = (value) => value.split('-')
  .map((word) => (word.length === 0 ? word : word[0].toUpperCase() + word.slice(1)))
  .join(' ');

/** @param {string} id @returns {string} The `<label>.<field>` id's field segment. */
const fieldOf = (id) => id.slice(id.indexOf('.') + 1);

/**
 * The parameter ids the current topology selections deactivate: an `edge-width`
 * field is read by the engine only while its instance's `coverage-mode` or
 * `envelope` enum sits on `edge-fade`. Deactivation changes what the engine
 * reads, never what the document carries, so these controls render dimmed
 * rather than dropping out of the union schema.
 * @param {ParameterDeclaration[]} parameters - The document's declarations.
 * @param {Object<string, *>} values - The active preset's values.
 * @returns {Set<string>} The deactivated parameter ids.
 */
export function deactivatedParameterIds(parameters, values) {
  /** @type {Map<string, *>} */
  const gates = new Map();
  for (const parameter of parameters) {
    if (parameter.storage !== 'enum8' || !parameter.id.includes('.')) continue;
    const field = fieldOf(parameter.id);
    if (field !== 'coverage-mode' && field !== 'envelope') continue;
    const option = values[parameter.id];
    if (option !== undefined)
      gates.set(parameter.id.slice(0, parameter.id.indexOf('.')), option);
  }
  /** @type {Set<string>} */
  const deactivated = new Set();
  for (const parameter of parameters) {
    if (!parameter.id.includes('.') || fieldOf(parameter.id) !== 'edge-width') continue;
    const gate = gates.get(parameter.id.slice(0, parameter.id.indexOf('.')));
    if (gate !== undefined && gate !== 'edge-fade') deactivated.add(parameter.id);
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
 * @returns {Object} The strip.
 */
export function createChainStrip({
  doc, container, store, catalog, announce, onApply, onSelect = () => {},
  presetId = () => null, onEditParameter = () => {},
}) {
  /** @type {Map<string, CatalogOperator>} */
  const operators = new Map(catalog.operators.map((op) => [op.id, op]));
  /** @param {ChainEntry} entry */
  const opOf = (entry) => /** @type {CatalogOperator} */ (operators.get(entry.operator));

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
   * Decomposes the chain into its carrier bands: each band's gap range is the
   * chain indices whose carrier is that band's, and the crossing that leaves the
   * band sits between it and the next.
   * @returns {BandLayout[]} One entry per catalog carrier, in catalog order.
   */
  const bandLayout = () => {
    const chain = store.chain();
    /** @type {BandLayout[]} */
    const bands = [];
    let index = 0;
    for (const carrier of catalog.carriers) {
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
   * The gap a band's + affordance aims at: after its selected chip, else the
   * band's last gap.
   * @param {BandLayout} band - The band.
   * @returns {number|null} A gap index, or null for a band that holds no gap.
   */
  const contextGap = (band) => {
    if (band.gaps.length === 0) return null;
    const selected = store.selectedLabel();
    if (selected !== null) {
      const at = store.chain().findIndex((entry) => entry.label === selected);
      if (band.chips.includes(at)) return at + 1;
    }
    return band.gaps[band.gaps.length - 1];
  };

  /**
   * @param {string} operatorId - A catalog operator.
   * @returns {number[]} Every gap the store accepts it at, in chain order.
   */
  const acceptingGaps = (operatorId) => {
    const chain = store.chain();
    /** @type {number[]} */
    const gaps = [];
    for (let gap = 0; gap <= chain.length; gap += 1) {
      const entry = store.legalInsertions(gap)
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
      for (const entry of store.legalInsertions(gap)) {
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
    if (label === store.selectedLabel()) return;
    if (!store.setSelectedLabel(label)) return;
    if (label !== null) focusedLabel = label;
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
   * Anchors an open palette horizontally under the control that opened it. The
   * stylesheet places it against its offset parent, which is whatever
   * positioned ancestor happens to sit above it rather than the anchor, so the
   * offset is measured and written out; a palette near the right edge is
   * clamped back inside the viewport. A DOM with no layout keeps the
   * stylesheet's placement.
   * @param {*} element - The open palette.
   * @param {*} anchor - The control it opened from.
   * @returns {void}
   */
  const placePalette = (element, anchor) => {
    const parent = element.offsetParent;
    if (typeof element.getBoundingClientRect !== 'function'
      || typeof anchor.getBoundingClientRect !== 'function'
      || !parent || typeof parent.getBoundingClientRect !== 'function') return;
    const width = element.getBoundingClientRect().width;
    const viewport = doc.documentElement?.clientWidth ?? 0;
    let left = anchor.getBoundingClientRect().left;
    if (viewport > 0) left = Math.min(left, viewport - width - PALETTE_MARGIN);
    element.style.left =
      `${Math.max(PALETTE_MARGIN, left) - parent.getBoundingClientRect().left}px`;
  };

  /** Removes an open palette without committing anything. */
  const closePalette = () => {
    if (palette === null) return;
    palette.element.remove();
    palette = null;
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
      ? store.legalInsertions(index)
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
      option.addEventListener('click', () => activate(option));
      options.push(option);
      element.appendChild(option);
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
        if (next) next.focus();
        return;
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        const target = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('.chain-palette-entry') : null;
        if (target) activate(target);
      }
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
    if (first) first.focus();
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
    const inside = typeof event.target?.closest === 'function'
      && (event.target.closest('.chain-chip-params') !== null
        || event.target.closest('.chain-chip-replace') !== null
        || event.target.closest('.chain-chip-move') !== null);
    if (inside) return;
    const key = event.key;
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      event.preventDefault();
      const forward = key === 'ArrowRight';
      if (event.altKey) moveChip(index, forward ? index + 2 : index - 1);
      else focusChip(forward ? index + 1 : index - 1);
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
    const off = deactivatedParameterIds(declarations, values);
    for (const [id, row] of rows) {
      if (off.has(id)) {
        row.dataset.deactivated = 'true';
        row.setAttribute('title', DEACTIVATED_TITLE);
      } else {
        delete row.dataset.deactivated;
        row.setAttribute('title', '');
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
    const span = maximum - minimum;
    slider.type = 'range';
    slider.min = String(minimum);
    slider.max = String(maximum);
    slider.step = span > 0 ? String(span / SLIDER_STEPS) : 'any';
    slider.value = String(values[declaration.id]);
    slider.addEventListener('input', (/** @type {*} */ event) => {
      const value = Number(event.target.value);
      readout.textContent = value.toFixed(VALUE_DECIMALS);
      editParameter(declaration.id, value);
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
        const readout = el('span', 'chain-param-value');
        readout.textContent = Number(values[declaration.id]).toFixed(VALUE_DECIMALS);
        const slider = sliderControl(declaration, readout);
        slider.setAttribute('aria-label', name);
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
   * @param {boolean} view.movable - Whether the chip has a gap to move to.
   * @param {string|null} view.selected - The selected label.
   * @param {Set<string>} view.bypassed - The bypassed labels.
   * @param {string|null} view.tabLabel - The roving-tabindex label.
   * @returns {*} The chip element.
   */
  const chipElement = (index, entry, {
    crossing, movable, selected, bypassed, tabLabel,
  }) => {
    const op = opOf(entry);
    const isSelected = selected === entry.label;
    const isBypassed = bypassed.has(entry.label);
    const declared = declarations.filter(
      (declaration) => declaration.id.startsWith(`${entry.label}.`));
    const expanded = declared.length > 0;
    const chip = el('div', 'chain-chip'
      + (crossing ? ' chain-chip--socket' : '')
      + (expanded ? ' chain-chip--expanded' : '')
      + (isBypassed ? ' chain-chip--bypassed' : ''));
    chip.dataset.label = entry.label;
    chip.dataset.index = String(index);
    chip.setAttribute('role', 'option');
    chip.setAttribute('aria-selected', String(isSelected));
    if (isSelected) chip.setAttribute('aria-current', 'true');
    chip.setAttribute('tabindex', tabLabel === entry.label ? '0' : '-1');
    chip.setAttribute('aria-label', `${op.name} · ${entry.label}`
      + (crossing ? `, ${op.input} to ${op.output}` : '')
      + (isBypassed ? ', bypassed' : ''));
    const name = el('span', 'chain-chip-name');
    name.textContent = op.name;
    const label = el('span', 'chain-chip-label');
    label.textContent = `· ${entry.label}`;
    chip.appendChild(name);
    chip.appendChild(label);

    if (crossing) {
      const pair = el('span', 'chain-chip-pair');
      pair.textContent = `${op.input} → ${op.output}`;
      chip.appendChild(pair);
      const functionLabel = el('label', 'chain-chip-function-label');
      functionLabel.textContent = op.input === 'plane' && op.output === 'field'
        ? 'Source function' : 'Stage';
      const replacement = el('select', 'chain-chip-replace');
      replacement.setAttribute('aria-label', functionLabel.textContent);
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
      chip.appendChild(functionLabel);
    } else {
      const remove = el('button', 'chain-chip-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${op.name} · ${entry.label}`);
      remove.textContent = '✕';
      remove.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        removeChip(index);
      });
      chip.appendChild(remove);
      const toggle = el('button', 'chain-chip-bypass');
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', String(isBypassed));
      toggle.setAttribute('aria-label', `Bypass ${op.name} · ${entry.label}`);
      toggle.textContent = 'bypass';
      toggle.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        toggleBypass(entry.label);
      });
      chip.appendChild(toggle);
      if (movable) {
        const previous = store.chain()[index - 1];
        const next = store.chain()[index + 1];
        const earlier = el('button', 'chain-chip-move');
        earlier.type = 'button';
        earlier.textContent = '‹';
        earlier.disabled = previous === undefined
          || opOf(previous).input !== op.input || opOf(previous).output !== op.output;
        earlier.setAttribute('aria-label', `Move ${op.name} · ${entry.label} earlier`);
        earlier.addEventListener('click', (/** @type {*} */ event) => {
          event.stopPropagation();
          moveChip(index, index - 1);
        });
        const later = el('button', 'chain-chip-move');
        later.type = 'button';
        later.textContent = '›';
        later.disabled = next === undefined
          || opOf(next).input !== op.input || opOf(next).output !== op.output;
        later.setAttribute('aria-label', `Move ${op.name} · ${entry.label} later`);
        later.addEventListener('click', (/** @type {*} */ event) => {
          event.stopPropagation();
          moveChip(index, index + 2);
        });
        chip.appendChild(earlier);
        chip.appendChild(later);
      }
    }

    if (expanded) chip.appendChild(paramsElement(entry, declared));

    chip.addEventListener('click', () => select(entry.label));
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
    const gap = contextGap(band);
    if (gap === null || !store.legalInsertions(gap).some((entry) => entry.legal))
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
    strip.setAttribute('role', 'listbox');
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
      for (const [at] of band.gaps.entries()) {
        const chip = band.chips[at];
        if (chip !== undefined) {
          element.appendChild(chipElement(chip, chain[chip],
            { crossing: false, movable: band.chips.length > 1, ...view }));
        }
      }
      const add = bandAddButton(band);
      if (add !== null) element.appendChild(add);
      strip.appendChild(element);
      if (band.socket !== null) {
        strip.appendChild(chipElement(band.socket, chain[band.socket],
          { crossing: true, movable: false, ...view }));
      }
    }

    container.replaceChildren(actions, strip);
    container.dataset.expanded = String(rows.size > 0);
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
   * replacement the socket's own swap control commits.
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
    return commit(store.chain()[index]?.label ?? null);
  };

  container.addEventListener('keydown', (/** @type {*} */ event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      undo();
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault();
      redo();
    }
  });

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

    /** Detaches the strip's listeners and empties its container. */
    destroy() {
      container.replaceChildren();
    },
  };
}
