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
 * removal, socket swap, Alt+Arrow and drag reorder, coarse band drops, undo —
 * funnels into the document store's one span-replacement primitive, so the strip
 * can commit nothing the store's validator refuses; it only decides which spans
 * the gestures name. Selection and the session bypass set live in the store too:
 * the strip is a view plus gesture translation, rebuilt whole after every
 * committed edit with keyboard focus restored to the edited chip.
 */

import { createPointerDrag } from './pointer_drag.js';

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
 *   replaceSpan: (start: number, deleteCount: number,
 *     sequence: Array<{label?: string, operator: string}>) => EditResult,
 *   undo: () => boolean, redo: () => boolean,
 *   canUndo: () => boolean, canRedo: () => boolean,
 * }} ChainStore
 */
/** @typedef {{kind: 'chip', index: number}|{kind: 'operator', operatorId: string}} DragSource */
/**
 * A drop target: one gap exactly, or a whole band, which resolves to the band's
 * nearest legal gap. `x` is the viewport abscissa a pointer named the band at,
 * absent for a target named without a pointer.
 * @typedef {{kind: 'gap', index: number}|{kind: 'band', carrier: string, x?: number}} DragTarget
 */
/**
 * One carrier's run of the chain: the gap indices that fall inside it, the chain
 * indices of its endomorphism chips, and the crossing that closes it.
 * @typedef {{carrier: string, gaps: number[], chips: number[], socket: number|null}} BandLayout
 */

// Keeps a palette clamped inside the viewport clear of its edge.
const PALETTE_MARGIN = 8;

// Pointer travel, in CSS pixels, that separates a chip drag from a chip click.
const DRAG_SLOP = 4;

/** @param {string} carrier @returns {string} The carrier's band title. */
const carrierTitle = (carrier) =>
  carrier.length === 0 ? carrier : carrier[0].toUpperCase() + carrier.slice(1);

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
 * @param {(label: string|null) => void} options.onSelect - Runs when the
 *   selected instance changes; the caller retargets the parameter dock.
 * @returns {Object} The strip.
 */
export function createChainStrip({
  doc, container, store, catalog, announce, onApply, onSelect,
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
  /** @type {{source: DragSource, legal: Set<number>, hovered: number|null}|null} */
  let dragState = null;
  /** @type {BandLayout[]} The current render's band decomposition. */
  let layout = [];

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
   * @param {string} carrier - A catalog carrier.
   * @returns {BandLayout|null} That carrier's band in the current render.
   */
  const bandOf = (carrier) => layout.find((band) => band.carrier === carrier) ?? null;

  /**
   * The gap a band's + affordance and a rectangle-less coarse drop aim at: after
   * the band's selected chip, else the band's last gap.
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

  /** @returns {Array<*>} Every gap element, in chain order. */
  const gapElements = () => container.querySelectorAll('.chain-gap');

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

  /** @param {number} index @returns {*|null} The gap element at that position. */
  const gapAt = (index) => elementBy('.chain-gap', 'index', String(index));

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
   * Opens the one palette: every catalog operator in catalog order, the illegal
   * ones present but aria-disabled with the reason, plus a leading Remove entry
   * where the empty replacement is legal.
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
      if (entry.getAttribute('aria-disabled') === 'true') {
        announce(entry.dataset.reason ?? 'this operator is not legal here');
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
    placePalette(element, origin);
    palette = { element, anchor };
    const first = options.find(
      (option) => option.getAttribute('aria-disabled') !== 'true') ?? options[0];
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

  /**
   * @param {number} index - Gap position, 0..chain length.
   * @returns {*} The gap element, a drop target rather than a control.
   */
  const gapElement = (index) => {
    const gap = el('div', 'chain-gap');
    gap.dataset.index = String(index);
    gap.setAttribute('aria-hidden', 'true');
    return gap;
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
    const chip = el('div', 'chain-chip'
      + (crossing ? ' chain-chip--socket' : '')
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
    if (movable) {
      chip.dataset.movable = 'true';
      chip.setAttribute('title', 'Drag, or Alt+Arrow, to reorder');
    }

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
      const swap = el('button', 'chain-chip-swap');
      swap.type = 'button';
      swap.setAttribute('aria-haspopup', 'listbox');
      swap.setAttribute('aria-label', `Replace ${op.name} · ${entry.label}`);
      swap.textContent = 'swap';
      swap.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        openPalette({ kind: 'replace', index, anchor: chip, origin: swap });
      });
      chip.appendChild(swap);
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
    }

    chip.addEventListener('click', () => select(entry.label));
    chip.addEventListener('keydown',
      (/** @type {*} */ event) => chipKeydown(event, index, entry, crossing, chip));
    return chip;
  };

  /**
   * @param {BandLayout} band - The band the button belongs to.
   * @returns {*} The band's persistent insertion affordance.
   */
  const bandAddButton = (band) => {
    const title = carrierTitle(band.carrier);
    const add = el('button', 'chain-band-add');
    add.type = 'button';
    add.setAttribute('aria-haspopup', 'listbox');
    add.setAttribute('aria-label', `Add a ${title} stage`);
    add.textContent = '+';
    const gap = contextGap(band);
    if (gap === null) add.disabled = true;
    else {
      add.addEventListener('click',
        () => openPalette({ kind: 'insert', index: gap, anchor: add }));
    }
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
    dragState = null;
    layout = bandLayout();

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

    const strip = el('div', 'chain-strip');
    strip.setAttribute('role', 'listbox');
    strip.setAttribute('aria-label', 'Shader chain');
    strip.setAttribute('aria-orientation', 'horizontal');
    const view = { selected, bypassed, tabLabel };
    for (const band of layout) {
      const title = carrierTitle(band.carrier);
      const element = el('div', 'chain-band');
      element.setAttribute('role', 'group');
      element.setAttribute('aria-label', `${title} stages`);
      element.dataset.carrier = band.carrier;
      const heading = el('div', 'chain-band-title');
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = title;
      element.appendChild(heading);
      for (const [at, gap] of band.gaps.entries()) {
        element.appendChild(gapElement(gap));
        const chip = band.chips[at];
        if (chip !== undefined) {
          element.appendChild(chipElement(chip, chain[chip],
            { crossing: false, movable: band.chips.length > 1, ...view }));
        }
      }
      element.appendChild(bandAddButton(band));
      strip.appendChild(element);
      if (band.socket !== null) {
        strip.appendChild(chipElement(band.socket, chain[band.socket],
          { crossing: true, movable: false, ...view }));
      }
    }

    container.replaceChildren(actions, strip);

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

  // Drag state is marked with data attributes rather than classes: these modules
  // load on every page, and only the workbench page carries their stylesheet.
  /** Clears every drag highlight. */
  const clearDragMarks = () => {
    for (const gap of gapElements()) delete gap.dataset.drop;
    for (const band of container.querySelectorAll('.chain-band')) delete band.dataset.drop;
    for (const chip of container.querySelectorAll('.chain-chip')) delete chip.dataset.dragging;
    for (const strip of container.querySelectorAll('.chain-strip')) {
      delete strip.dataset.dragging;
    }
  };

  /**
   * @param {number} index - A gap position.
   * @returns {number|null} The gap element's viewport centre, or null where the
   *   layout is not measurable.
   */
  const gapCentre = (index) => {
    const element = gapAt(index);
    if (!element || typeof element.getBoundingClientRect !== 'function') return null;
    const rect = element.getBoundingClientRect();
    if (!rect || typeof rect.left !== 'number' || typeof rect.width !== 'number') return null;
    return rect.left + rect.width / 2;
  };

  /**
   * The gap a coarse band drop commits at: geometrically nearest the pointer
   * where the gaps measure, else the legal gap nearest the band's context gap.
   * @param {BandLayout} band - The hovered band.
   * @param {Set<number>} legal - The drag's legal gaps.
   * @param {number|undefined} x - Viewport abscissa of the pointer, if any.
   * @returns {number|null} The gap, or null when the band accepts none.
   */
  const nearestLegalGap = (band, legal, x) => {
    const candidates = band.gaps.filter((gap) => legal.has(gap));
    if (candidates.length === 0) return null;
    if (typeof x === 'number') {
      const measured = candidates
        .map((gap) => ({ gap, centre: gapCentre(gap) }))
        .filter((candidate) => candidate.centre !== null);
      if (measured.length > 0) {
        return measured.reduce((best, candidate) =>
          Math.abs(/** @type {number} */ (candidate.centre) - x)
            < Math.abs(/** @type {number} */ (best.centre) - x) ? candidate : best).gap;
      }
    }
    const context = contextGap(band);
    if (context === null) return candidates[0];
    return candidates.reduce((best, gap) =>
      Math.abs(gap - context) < Math.abs(best - context) ? gap : best);
  };

  /**
   * Why a band accepts the dragged operator nowhere.
   * @param {BandLayout} band - The refusing band.
   * @param {DragSource} source - What is being dragged.
   * @returns {string} The reason for the shared status region.
   */
  const bandRefusal = (band, source) => {
    const title = carrierTitle(band.carrier);
    if (band.gaps.length === 0) return `the ${title} band holds no insertion point`;
    if (source.kind === 'chip') {
      const entry = store.chain()[source.index];
      return `${opOf(entry).name} · ${entry.label} cannot move into the ${title} band`;
    }
    const legality = store.legalInsertions(band.gaps[0])
      .find((candidate) => candidate.operator.id === source.operatorId);
    return legality?.reason ?? `nothing accepts this operator in the ${title} band`;
  };

  /**
   * Repaints the drop marks for the current hover.
   * @param {number|null} active - The gap the drop would commit at.
   * @param {string|null} refused - Carrier of a band refusing the drag.
   * @returns {void}
   */
  const markDrop = (active, refused) => {
    const legal = dragState?.legal ?? new Set();
    for (const gap of gapElements()) {
      const index = Number(gap.dataset.index);
      if (index === active) gap.dataset.drop = 'active';
      else if (legal.has(index)) gap.dataset.drop = 'legal';
      else delete gap.dataset.drop;
    }
    for (const element of container.querySelectorAll('.chain-band')) {
      const gaps = bandOf(element.dataset.carrier)?.gaps ?? [];
      if (element.dataset.carrier === refused) element.dataset.drop = 'refused';
      else if (active !== null && gaps.includes(active)) element.dataset.drop = 'active';
      else if (gaps.some((gap) => legal.has(gap))) element.dataset.drop = 'legal';
      else delete element.dataset.drop;
    }
  };

  const drag = {
    /**
     * Begins a drag and computes its legal drop gaps: for a chip, the gaps of
     * its own band (a crossing does not reorder); for a catalog operator, every
     * gap the store would accept it at.
     * @param {DragSource} source - What is being dragged.
     * @returns {boolean} Whether the drag was accepted.
     */
    start(source) {
      if (dragState !== null) return false;
      const chain = store.chain();
      /** @type {Set<number>} */
      const legal = new Set();
      if (source.kind === 'chip') {
        const entry = chain[source.index];
        if (entry === undefined) return false;
        const op = opOf(entry);
        if (op.input === op.output) {
          for (let gap = 0; gap <= chain.length; gap += 1) {
            if (gap === source.index || gap === source.index + 1) continue;
            if (carrierAt(gap) === op.input) legal.add(gap);
          }
        }
        // A chip with nowhere to go — a crossing, or a band's only stage — must
        // not take the pointer: the capture retargets the click that follows and
        // the press would select nothing.
        if (legal.size === 0) return false;
      } else {
        if (!operators.has(source.operatorId)) return false;
        for (let gap = 0; gap <= chain.length; gap += 1) {
          const entry = store.legalInsertions(gap)
            .find((candidate) => candidate.operator.id === source.operatorId);
          if (entry?.legal) legal.add(gap);
        }
      }
      dragState = { source, legal, hovered: null };
      markDrop(null, null);
      for (const strip of container.querySelectorAll('.chain-strip')) {
        strip.dataset.dragging = 'true';
      }
      if (source.kind === 'chip') {
        const chip = chipAt(source.index);
        if (chip) chip.dataset.dragging = 'true';
      }
      return true;
    },

    /**
     * Aims the drag at a gap, or at a whole band, which resolves to the band's
     * nearest legal gap; a band that accepts the drag nowhere marks itself
     * refused and announces why.
     * @param {DragTarget|null} target - What the pointer is over.
     * @returns {void}
     */
    hover(target) {
      if (dragState === null) return;
      /** @type {number|null} */
      let next = null;
      /** @type {string|null} */
      let refused = null;
      if (target !== null && target.kind === 'gap') {
        if (dragState.legal.has(target.index)) next = target.index;
      } else if (target !== null) {
        const band = bandOf(target.carrier);
        if (band !== null) {
          next = nearestLegalGap(band, dragState.legal, target.x);
          if (next === null) {
            refused = band.carrier;
            announce(bandRefusal(band, dragState.source));
          }
        }
      }
      dragState.hovered = next;
      markDrop(next, refused);
    },

    /**
     * Resolves a viewport point to a drop target and hovers it, so a drag
     * captured outside the strip needs nothing of the strip but this call.
     * @param {number} x - Viewport x.
     * @param {number} y - Viewport y.
     * @returns {void}
     */
    hoverFromPoint(x, y) {
      if (typeof doc.elementFromPoint !== 'function') return drag.hover(null);
      const hit = doc.elementFromPoint(x, y);
      if (!hit || typeof hit.closest !== 'function') return drag.hover(null);
      const gap = hit.closest('.chain-gap');
      const index = gap ? Number(gap.dataset.index) : NaN;
      if (Number.isInteger(index)) return drag.hover({ kind: 'gap', index });
      const band = hit.closest('.chain-band');
      const carrier = band ? band.dataset.carrier : undefined;
      if (typeof carrier !== 'string') return drag.hover(null);
      return drag.hover({ kind: 'band', carrier, x });
    },

    /**
     * Commits the drag at the resolved gap, or unwinds it when there is none.
     * @returns {boolean} Whether an edit committed.
     */
    drop() {
      if (dragState === null) return false;
      const { source, hovered } = dragState;
      dragState = null;
      clearDragMarks();
      if (hovered === null) return false;
      if (source.kind === 'chip') return moveChip(source.index, hovered);
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
   * chip when there is a selection, else at the first gap the store accepts it.
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
      announce(reason ?? `${operatorId} fits nowhere in this chain`);
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

  // The press a running chip drag started from, and whether it has travelled far
  // enough to read as a drag. Pointer capture retargets the click that follows a
  // captured press to the container, so a press that never moves is turned back
  // into the chip selection it was meant to be.
  /** @type {{label: string|null, x: number, y: number, moved: boolean}|null} */
  let press = null;

  const pointer = createPointerDrag({
    element: container,
    onStart: (event) => {
      press = null;
      const target = /** @type {*} */ (event.target);
      if (!target || typeof target.closest !== 'function') return false;
      if (target.closest('.chain-chip-bypass') || target.closest('.chain-chip-remove')
          || target.closest('.chain-chip-swap') || target.closest('.chain-band-add')
          || target.closest('.chain-palette')) return false;
      const chip = target.closest('.chain-chip');
      if (!chip) return false;
      focusedLabel = chip.dataset.label ?? focusedLabel;
      if (!drag.start({ kind: 'chip', index: Number(chip.dataset.index) })) return false;
      press = {
        label: chip.dataset.label ?? null,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      return undefined;
    },
    onMove: (event) => {
      if (press !== null && Math.abs(event.clientX - press.x)
        + Math.abs(event.clientY - press.y) > DRAG_SLOP) press.moved = true;
      drag.hoverFromPoint(event.clientX, event.clientY);
    },
    onEnd: () => {
      const stationary = press !== null && !press.moved ? press.label : null;
      press = null;
      if (drag.drop()) return;
      if (stationary !== null) select(stationary);
    },
    onCancel: () => {
      press = null;
      drag.cancel();
    },
  });

  render();

  return {
    render,
    drag,
    insertOperator,

    /** Detaches the strip's listeners and empties its container. */
    destroy() {
      pointer.remove();
      container.replaceChildren();
    },
  };
}
