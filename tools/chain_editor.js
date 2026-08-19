// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The chain rail: the loaded document's operator chain as a vertical list of
 * stage cards grouped into one band per carrier family, with the family
 * crossings drawn as the band boundaries. Every structural gesture — palette
 * insertion, removal-by-replacement, Alt+Arrow and drag reorder, undo — funnels
 * into the document store's one span-replacement primitive, so the rail can
 * commit nothing the store's validator refuses; the editor only decides which
 * spans the gestures name. Selection and the session bypass set live in the
 * store too: the rail is a view plus gesture translation, rebuilt whole after
 * every committed edit with keyboard focus restored to the edited card.
 */

import { createPointerDrag } from './pointer_drag.js';

/** @typedef {{id: string, name: string, input: string, output: string, params: Array<Object>}} CatalogOperator */
/** @typedef {{carriers: string[], operators: CatalogOperator[]}} OperatorCatalog */
/** @typedef {{label: string, operator: string}} ChainEntry */
/** @typedef {{operator: CatalogOperator, legal: boolean, reason?: string}} LegalityEntry */
/** @typedef {{severity: string, phase: string, code: string, path: string, message: string}} Diagnostic */
/** @typedef {{ok: true}|{ok: false, diagnostics: Diagnostic[]}} EditResult */
/**
 * The document-store surface the rail drives.
 * @typedef {{
 *   chain: () => ChainEntry[],
 *   selectedLabel: () => string|null,
 *   setSelectedLabel: (label: string|null) => boolean,
 *   bypassedLabels: () => string[],
 *   setBypassed: (label: string, on: boolean) => EditResult,
 *   legalInsertions: (index: number) => LegalityEntry[],
 *   legalReplacements: (start: number, deleteCount: number) => LegalityEntry[],
 *   replaceSpan: (start: number, deleteCount: number,
 *     sequence: Array<{label?: string, operator: string}>) => EditResult,
 *   undo: () => boolean, redo: () => boolean,
 *   canUndo: () => boolean, canRedo: () => boolean,
 * }} ChainStore
 */
/** @typedef {{kind: 'card', index: number}|{kind: 'operator', operatorId: string}} DragSource */

/** @param {string} carrier @returns {string} The carrier's band title. */
const carrierTitle = (carrier) =>
  carrier.length === 0 ? carrier : carrier[0].toUpperCase() + carrier.slice(1);

/**
 * The rail gap under a viewport point, for a drag captured outside the rail
 * (the catalog panel's) to hit-test drop targets with.
 * @param {*} doc - Document owning the rail.
 * @param {number} x - Viewport x.
 * @param {number} y - Viewport y.
 * @returns {number|null} The gap's chain index, or null off every gap.
 */
export function railGapFromPoint(doc, x, y) {
  if (typeof doc.elementFromPoint !== 'function') return null;
  const hit = doc.elementFromPoint(x, y);
  const gap = hit && typeof hit.closest === 'function' ? hit.closest('.chain-gap') : null;
  const index = gap ? Number(gap.dataset.index) : NaN;
  return Number.isInteger(index) ? index : null;
}

/**
 * Builds the chain rail into a container and wires its gestures.
 * @param {Object} options - The rail's collaborators.
 * @param {*} options.doc - Document the rail renders into.
 * @param {*} options.container - Element the rail owns.
 * @param {ChainStore} options.store - The chain document store.
 * @param {OperatorCatalog} options.catalog - The operator catalog.
 * @param {() => void} options.onApply - Runs after every committed structural
 *   edit, undo/redo and bypass toggle; the caller re-applies the program shape
 *   through the engine.
 * @param {(label: string|null) => void} options.onSelect - Runs when the
 *   selected instance changes; the caller filters the parameter GUI.
 * @returns {Object} The editor.
 */
export function createChainEditor({ doc, container, store, catalog, onApply, onSelect }) {
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
  /** @type {{source: DragSource, legal: Set<number>, hovered: number|null}|null} */
  let dragState = null;

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

  const status = el('div', 'chain-editor-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  /**
   * @param {number} index - A gap position, 0..chain length.
   * @returns {string} The carrier crossing that gap.
   */
  const carrierAt = (index) => {
    const chain = store.chain();
    if (chain.length === 0) return catalog.carriers[0];
    return index === 0 ? opOf(chain[0]).input : opOf(chain[index - 1]).output;
  };

  /** @returns {Array<*>} Every gap button in the rail, in chain order. */
  const gapElements = () => container.querySelectorAll('.chain-gap');

  /**
   * @param {string} label - An instance label.
   * @returns {*|null} The card carrying it.
   */
  const cardByLabel = (label) => {
    for (const card of container.querySelectorAll('.chain-card')) {
      if (card.dataset.label === label) return card;
    }
    return null;
  };

  /**
   * @param {number} index - A chain index.
   * @returns {*|null} The card at that position.
   */
  const cardAt = (index) => {
    for (const card of container.querySelectorAll('.chain-card')) {
      if (Number(card.dataset.index) === index) return card;
    }
    return null;
  };

  /**
   * Surfaces a store refusal in the rail's live region.
   * @param {EditResult} result - The refused edit.
   * @returns {false} Always false, for tail-calling.
   */
  const report = (result) => {
    if (result.ok === false) {
      status.textContent = result.diagnostics[0]?.message ?? 'the edit was refused';
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
   * Rebuilds the rail after a committed edit, restores focus, and re-applies
   * the program through the caller.
   * @param {string|null} focusLabel - Card to hand keyboard focus back to.
   * @returns {true} Always true, for tail-calling.
   */
  const commit = (focusLabel) => {
    status.textContent = '';
    render({ focusLabel });
    notifySelection();
    onApply();
    return true;
  };

  /**
   * Selects one card (or clears the selection) and re-renders.
   * @param {string|null} label - The instance label, or null.
   * @returns {void}
   */
  const select = (label) => {
    if (!store.setSelectedLabel(label)) return;
    if (label !== null) focusedLabel = label;
    render({ focusLabel: label });
    notifySelection();
  };

  /**
   * Moves the card at one chain index to a gap, as the m-for-m span
   * replacement that keeps every label (and so every parameter value).
   * @param {number} index - The card's chain index.
   * @param {number} gap - Target gap, 0..chain length.
   * @returns {boolean} Whether the move committed.
   */
  const moveCard = (index, gap) => {
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
    status.textContent = '';
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

  /** Removes an open palette without committing anything. */
  const closePalette = () => {
    if (palette === null) return;
    palette.element.remove();
    palette = null;
  };

  /**
   * Opens the one palette: every catalog operator in catalog order, the
   * illegal ones present but aria-disabled with the reason, plus a leading
   * Remove entry where the empty replacement is legal.
   * @param {Object} options - What the palette replaces.
   * @param {'insert'|'replace'} options.kind - Insertion at a gap or
   *   replacement of one card.
   * @param {number} options.index - The gap or card chain index.
   * @param {*} options.anchor - Element the palette sits after and Escape
   *   returns focus to.
   * @returns {void}
   */
  const openPalette = ({ kind, index, anchor }) => {
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
      if (entry.getAttribute('aria-disabled') === 'true') {
        status.textContent = entry.dataset.reason ?? 'this operator is not legal here';
        return;
      }
      const remove = entry.dataset.remove === 'true';
      const result = remove
        ? store.replaceSpan(index, 1, [])
        : store.replaceSpan(index, kind === 'insert' ? 0 : 1,
          [{ operator: entry.dataset.operator }]);
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
    for (const legality of entries) {
      const option = el('div', 'chain-palette-entry');
      option.dataset.operator = legality.operator.id;
      const name = el('span', 'chain-palette-name');
      name.textContent = legality.operator.name;
      option.appendChild(name);
      if (!legality.legal) {
        option.setAttribute('aria-disabled', 'true');
        option.dataset.reason = legality.reason ?? '';
        const reason = el('span', 'chain-palette-reason');
        reason.textContent = legality.reason ?? '';
        option.appendChild(reason);
      }
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
    palette = { element, anchor };
    const first = options.find(
      (option) => option.getAttribute('aria-disabled') !== 'true') ?? options[0];
    if (first) first.focus();
  };

  /**
   * Moves keyboard focus to the card at a chain index, updating the roving
   * tabindex.
   * @param {number} index - Target chain index.
   * @returns {void}
   */
  const focusCard = (index) => {
    const card = cardAt(index);
    if (!card) return;
    for (const other of container.querySelectorAll('.chain-card')) {
      other.setAttribute('tabindex', other === card ? '0' : '-1');
    }
    focusedLabel = card.dataset.label ?? null;
    card.focus();
  };

  /**
   * @param {*} event - A card's keydown.
   * @param {number} index - The card's chain index.
   * @param {string} label - The card's instance label.
   * @param {*} card - The card element.
   * @returns {void}
   */
  const cardKeydown = (event, index, label, card) => {
    const key = event.key;
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      event.preventDefault();
      const delta = key === 'ArrowDown' ? 1 : -1;
      if (event.altKey) moveCard(index, key === 'ArrowDown' ? index + 2 : index - 1);
      else focusCard(index + delta);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      select(label);
      return;
    }
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      openPalette({ kind: 'replace', index, anchor: card });
      return;
    }
    if (key === 'Insert') {
      event.preventDefault();
      openPalette({ kind: 'insert', index: index + 1, anchor: card });
    }
  };

  /**
   * @param {number} index - Gap position, 0..chain length.
   * @returns {*} The gap's insertion button.
   */
  const gapButton = (index) => {
    const gap = el('button', 'chain-gap');
    gap.type = 'button';
    gap.dataset.index = String(index);
    gap.setAttribute('aria-label', `Insert at position ${index + 1}`);
    gap.setAttribute('aria-haspopup', 'listbox');
    gap.textContent = '+';
    gap.addEventListener('click', () => openPalette({ kind: 'insert', index, anchor: gap }));
    return gap;
  };

  /**
   * @param {number} index - The entry's chain index.
   * @param {ChainEntry} entry - The chain entry.
   * @param {Object} view - Render-pass state.
   * @param {boolean} view.crossing - Whether the operator crosses carriers.
   * @param {string|null} view.selected - The selected label.
   * @param {Set<string>} view.bypassed - The bypassed labels.
   * @param {string|null} view.tabLabel - The roving-tabindex label.
   * @returns {*} The card element.
   */
  const cardElement = (index, entry, { crossing, selected, bypassed, tabLabel }) => {
    const op = opOf(entry);
    const isSelected = selected === entry.label;
    const isBypassed = bypassed.has(entry.label);
    const card = el('div', 'chain-card'
      + (crossing ? ' chain-card--crossing' : '')
      + (isBypassed ? ' chain-card--bypassed' : ''));
    card.dataset.label = entry.label;
    card.dataset.index = String(index);
    card.setAttribute('role', 'option');
    card.setAttribute('aria-selected', String(isSelected));
    if (isSelected) card.setAttribute('aria-current', 'true');
    card.setAttribute('tabindex', tabLabel === entry.label ? '0' : '-1');
    card.setAttribute('aria-label', `${op.name} · ${entry.label}`
      + (crossing ? `, ${op.input} to ${op.output}` : '')
      + (isBypassed ? ', bypassed' : ''));

    const name = el('span', 'chain-card-name');
    name.textContent = op.name;
    const label = el('span', 'chain-card-label');
    label.textContent = `· ${entry.label}`;
    card.appendChild(name);
    card.appendChild(label);
    if (crossing) {
      const pair = el('span', 'chain-card-pair');
      pair.textContent = `${op.input} → ${op.output}`;
      card.appendChild(pair);
    } else {
      const toggle = el('button', 'chain-card-bypass');
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', String(isBypassed));
      toggle.setAttribute('aria-label', `Bypass ${op.name} · ${entry.label}`);
      toggle.textContent = 'bypass';
      toggle.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        toggleBypass(entry.label);
      });
      card.appendChild(toggle);
    }
    card.addEventListener('click', () => select(entry.label));
    card.addEventListener('keydown',
      (/** @type {*} */ event) => cardKeydown(event, index, entry.label, card));
    return card;
  };

  /**
   * Rebuilds the whole rail from the store. Keyboard focus is restored to the
   * named card (its bypass toggle when asked), or to the roving-tabindex card
   * when the rail held focus before the rebuild.
   * @param {{focusLabel?: string|null, focusBypass?: boolean}} [options]
   * @returns {void}
   */
  const render = ({ focusLabel = null, focusBypass = false } = {}) => {
    const active = doc.activeElement ?? null;
    const hadFocus = active !== null && container.contains(active);
    palette = null;
    dragState = null;

    const chain = store.chain();
    const selected = store.selectedLabel();
    const bypassed = new Set(store.bypassedLabels());
    const labels = chain.map((entry) => entry.label);
    const tabLabel = focusLabel !== null && labels.includes(focusLabel) ? focusLabel
      : focusedLabel !== null && labels.includes(focusedLabel) ? focusedLabel
      : selected ?? labels[0] ?? null;

    const actions = el('div', 'chain-actions');
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

    const rail = el('div', 'chain-rail');
    rail.setAttribute('role', 'listbox');
    rail.setAttribute('aria-label', 'Shader chain');
    rail.setAttribute('aria-orientation', 'vertical');
    const view = { selected, bypassed, tabLabel };
    let index = 0;
    for (const carrier of catalog.carriers) {
      const band = el('div', 'chain-band');
      band.setAttribute('role', 'group');
      band.setAttribute('aria-label', `${carrierTitle(carrier)} stages`);
      band.dataset.carrier = carrier;
      const heading = el('div', 'chain-band-title');
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = carrierTitle(carrier);
      band.appendChild(heading);
      if (chain.length === 0 ? carrier === catalog.carriers[0] : carrierAt(index) === carrier) {
        band.appendChild(gapButton(index));
      }
      while (index < chain.length) {
        const op = opOf(chain[index]);
        if (op.input !== carrier || op.output !== carrier) break;
        band.appendChild(cardElement(index, chain[index], { crossing: false, ...view }));
        band.appendChild(gapButton(index + 1));
        index += 1;
      }
      rail.appendChild(band);
      if (index < chain.length && opOf(chain[index]).input === carrier) {
        rail.appendChild(cardElement(index, chain[index], { crossing: true, ...view }));
        index += 1;
      }
    }

    container.replaceChildren(actions, rail, status);

    const target = focusLabel !== null ? cardByLabel(focusLabel) : null;
    if (target) {
      focusedLabel = focusLabel;
      if (focusBypass) {
        const toggle = target.querySelector('.chain-card-bypass');
        (toggle ?? target).focus();
      } else {
        target.focus();
      }
    } else if (hadFocus || focusLabel !== null) {
      const fallback = tabLabel !== null ? cardByLabel(tabLabel) : null;
      if (fallback) {
        focusedLabel = tabLabel;
        fallback.focus();
      }
    }
  };

  // Drag state is marked with data attributes rather than classes: these
  // modules load on every page, and only the workbench page carries their
  // stylesheet.
  /** Clears every drag highlight. */
  const clearDragMarks = () => {
    for (const gap of gapElements()) delete gap.dataset.drop;
    for (const card of container.querySelectorAll('.chain-card')) {
      delete card.dataset.dragging;
    }
  };

  const drag = {
    /**
     * Begins a drag and highlights its legal drop gaps: for a card, the gaps
     * of its own band (a crossing reorders no further than its position); for
     * a catalog operator, every gap the store would accept it at.
     * @param {DragSource} source - What is being dragged.
     * @returns {boolean} Whether the drag was accepted.
     */
    start(source) {
      if (dragState !== null) return false;
      const chain = store.chain();
      const legal = new Set();
      if (source.kind === 'card') {
        const entry = chain[source.index];
        if (entry === undefined) return false;
        const op = opOf(entry);
        if (op.input === op.output) {
          for (let gap = 0; gap <= chain.length; gap += 1) {
            if (gap === source.index || gap === source.index + 1) continue;
            if (carrierAt(gap) === op.input) legal.add(gap);
          }
        }
      } else {
        if (!operators.has(source.operatorId)) return false;
        for (let gap = 0; gap <= chain.length; gap += 1) {
          const entry = store.legalInsertions(gap)
            .find((candidate) => candidate.operator.id === source.operatorId);
          if (entry?.legal) legal.add(gap);
        }
      }
      dragState = { source, legal, hovered: null };
      for (const gap of gapElements()) {
        if (legal.has(Number(gap.dataset.index))) gap.dataset.drop = 'legal';
      }
      if (source.kind === 'card') {
        const card = cardAt(source.index);
        if (card) card.dataset.dragging = 'true';
      }
      return true;
    },

    /**
     * Highlights the gap under the pointer when it is a legal drop.
     * @param {number|null} gapIndex - Hovered gap, or null off the rail.
     * @returns {void}
     */
    hover(gapIndex) {
      if (dragState === null) return;
      const next = gapIndex !== null && dragState.legal.has(gapIndex) ? gapIndex : null;
      if (next === dragState.hovered) return;
      dragState.hovered = next;
      for (const gap of gapElements()) {
        const index = Number(gap.dataset.index);
        if (index === next) gap.dataset.drop = 'active';
        else if (dragState.legal.has(index)) gap.dataset.drop = 'legal';
        else delete gap.dataset.drop;
      }
    },

    /**
     * Commits the drag at the highlighted gap, or unwinds it when none is.
     * @returns {boolean} Whether an edit committed.
     */
    drop() {
      if (dragState === null) return false;
      const { source, hovered } = dragState;
      dragState = null;
      clearDragMarks();
      if (hovered === null) return false;
      if (source.kind === 'card') return moveCard(source.index, hovered);
      const result = store.replaceSpan(hovered, 0, [{ operator: source.operatorId }]);
      if (!result.ok) return report(result);
      return commit(store.chain()[hovered]?.label ?? null);
    },

    /** Unwinds the drag without committing. */
    cancel() {
      dragState = null;
      clearDragMarks();
    },
  };

  /**
   * Inserts a catalog operator without a drag: at the gap after the selected
   * card when there is a selection, else at the first gap the store accepts it.
   * @param {string} operatorId - The operator to insert.
   * @returns {boolean} Whether the insertion committed.
   */
  const insertOperator = (operatorId) => {
    const chain = store.chain();
    const selected = store.selectedLabel();
    let index = null;
    /** @type {string|undefined} */
    let reason;
    if (selected !== null) {
      const at = chain.findIndex((entry) => entry.label === selected) + 1;
      const entry = store.legalInsertions(at)
        .find((candidate) => candidate.operator.id === operatorId);
      if (entry?.legal) index = at;
      else reason = entry?.reason;
    } else {
      for (let gap = 0; gap <= chain.length && index === null; gap += 1) {
        const entry = store.legalInsertions(gap)
          .find((candidate) => candidate.operator.id === operatorId);
        if (entry?.legal) index = gap;
        else reason ??= entry?.reason;
      }
    }
    if (index === null) {
      status.textContent = reason ?? `${operatorId} fits nowhere in this chain`;
      return false;
    }
    const result = store.replaceSpan(index, 0, [{ operator: operatorId }]);
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

  const pointer = createPointerDrag({
    element: container,
    onStart: (event) => {
      const target = /** @type {*} */ (event.target);
      if (!target || typeof target.closest !== 'function') return false;
      if (target.closest('.chain-card-bypass') || target.closest('.chain-gap')
          || target.closest('.chain-palette')) return false;
      const card = target.closest('.chain-card');
      if (!card) return false;
      focusedLabel = card.dataset.label ?? focusedLabel;
      if (!drag.start({ kind: 'card', index: Number(card.dataset.index) })) return false;
      return undefined;
    },
    onMove: (event) => drag.hover(railGapFromPoint(doc, event.clientX, event.clientY)),
    onEnd: () => {
      drag.drop();
    },
    onCancel: () => drag.cancel(),
  });

  render();

  return {
    render,
    drag,
    insertOperator,

    /** Detaches the rail's listeners and empties its container. */
    destroy() {
      pointer.remove();
      container.replaceChildren();
    },
  };
}
