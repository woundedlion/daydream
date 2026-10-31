// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { titleCase } from '../../shared/labels.js';
import {
  createChainPresentation, deactivatedParameterIds, formatNumericValue, nudgeStep, fieldOf,
  COLOR_PARAMETER_GROUPS, MODULATION_PARAMETER_GROUPS, COLOR_PARAMETER_NAMES,
  colorParameterHidden, modulationParameterHidden, PALETTE_OPERATOR, MODULATION_OPERATOR,
} from './chain_presentation.js';

/** @typedef {import('./chain_presentation.js').CatalogOperator} CatalogOperator */
/** @typedef {import('./chain_presentation.js').OperatorCatalog} OperatorCatalog */
/** @typedef {import('./chain_presentation.js').ChainEntry} ChainEntry */
/** @typedef {import('./chain_presentation.js').LegalityEntry} LegalityEntry */
/** @typedef {import('./chain_presentation.js').SequenceEntry} SequenceEntry */
/** @typedef {import('./chain_presentation.js').SpanChoice} SpanChoice */
/** @typedef {import('./chain_document_store.js').ParameterDeclaration} ParameterDeclaration */
/** @typedef {import('./chain_presentation.js').BandLayout} BandLayout */

import { createFrameScheduler } from '../../shared/page_lifecycle.js';
import { createPointerDrag } from '../../shared/pointer_drag.js';

/**
 * The pipeline strip: the document's operator chain in execution order as chips
 * grouped into one band per editable carrier family, with carrier crossings as
 * socket chips on band boundaries. Structural gestures commit through the
 * store's span replacement; the strip is rebuilt whole after every committed
 * edit. Each chip carries its stage's controls inline.
 */

/** @typedef {{severity: string, phase: string, code: string, path: string, message: string}} Diagnostic */
/** @typedef {{ok: true}|{ok: false, diagnostics: Diagnostic[]}} EditResult */
/**
 * The document-store surface the strip drives. Legality queries throw RangeError
 * for invalid indices; mutation methods return EditResult refusals.
 * @typedef {{
 *   chain: () => ChainEntry[],
 *   selectedLabel: () => string|null,
 *   setSelectedLabel: (label: string|null) => boolean,
 *   bypassedLabels: () => string[],
 *   setBypassed: (label: string, on: boolean) => EditResult,
 *   legalInsertions: (index: number) => LegalityEntry[],
 *   legalSequences: (start: number, deleteCount: number,
 *     maxLength: number) => SequenceEntry[],
 *   parameterDeclarations: () => ParameterDeclaration[],
 *   document: () => *,
 *   replaceSpan: (start: number, deleteCount: number,
 *     sequence: Array<{label?: string, operator: string}>) => EditResult,
 *   relabel: (oldLabel: string, newLabel: string) => EditResult,
 *   endValueRun: () => void,
 *   undo: () => boolean, redo: () => boolean,
 *   canUndo: () => boolean, canRedo: () => boolean,
 * }} ChainStore
 */
// Keeps a palette clamped inside the viewport clear of its edge.
const PALETTE_MARGIN = 8;

// Separates a palette from the control it opened from.
const PALETTE_GAP = 4;

const DEACTIVATED_REASON = 'Deactivated by the current topology selection';

const BYPASS_UNAVAILABLE = 'Bypass applies to the interpreter only: '
  + 'the compiled build renders the whole chain.';

const MIN_SCROLL_STEP = 160;
const SCROLL_STEP_RATIO = 0.75;
const DRAG_SLOP_PX = 5;
const DRAG_SCROLL_EDGE_PX = 24;

// Pixels one WheelEvent.DOM_DELTA_LINE notch stands for.
const WHEEL_LINE_PX = 16;

/**
 * A socket's function name, by the carrier the crossing produces.
 * @type {Record<string, {name: string, accessibleName: string}>}
 */
const SOCKET_FUNCTIONS = {
  plane: { name: 'Projection', accessibleName: 'Projection' },
  field: { name: 'Source', accessibleName: 'Source function' },
  color: { name: 'Palette', accessibleName: 'Palette' },
};

/**
 * Builds the pipeline strip into a container and wires its gestures.
 * @param {Object} options - The strip's collaborators.
 * @param {*} options.doc - Document the strip renders into.
 * @param {*} options.container - Element the strip owns.
 * @param {ChainStore} options.store - The chain document store.
 * @param {OperatorCatalog} options.catalog - The operator catalog.
 * @param {(message: string) => void} options.announce - Writes the shared live
 *   status region; refusals report through it, and a committed edit clears it.
 * @param {() => void} options.onApply - Runs after every committed structural
 *   edit, undo/redo and bypass toggle.
 * @param {(label: string|null) => void} [options.onSelect] - Runs when the
 *   selected instance changes.
 * @param {() => string|null} [options.presetId] - The preset the inline stage
 *   controls read and write; null falls back to the document's first.
 * @param {(parameterId: string, value: *) => boolean|void} [options.onEditParameter] -
 *   Takes every inline control edit as the document value the store stores: a
 *   number for a binary32 field, the option id for an enum8 one.
 * @param {() => void} [options.onCommitParameter] - Runs once an inline control
 *   edit completes: a slider release, a chosen option, an entered value.
 * @param {() => boolean} [options.bypassAvailable] - Whether a bypass reaches
 *   what is rendering. False disables the toggles and states why.
 * @param {(parameterId: string) => boolean} [options.parameterLive] - Whether a parameter reaches the active build.
 * @returns {Object} The strip.
 */
export function createChainStrip({
  doc, container, store, catalog, announce, onApply, onSelect = () => {},
  presetId = () => null, onEditParameter = () => {}, onCommitParameter = () => {},
  bypassAvailable = () => true, parameterLive = () => true,
}) {
  const { opOf, bandLayout, appendGap, choiceEntries, choiceKey, socketChoices, sharesBand } = createChainPresentation({
    catalog, chain: store.chain, legalSequences: store.legalSequences,
  });

  /** @type {string|null} Roving-tabindex position, by instance label. */
  let focusedLabel = null;
  /** @type {string|null} The last selection onSelect was told about. */
  let notifiedSelection = null;
  /** @type {{element: *, anchor: *}|null} */
  let palette = null;
  /** @type {{undo: *, redo: *}|null} The current render's history buttons. */
  let history = null;
  /** @type {ParameterDeclaration[]} The current render's declarations. */
  let declarations = [];
  /** @type {Object<string, *>} The values the inline controls show. */
  let values = {};
  /**
   * @type {Map<string, *>} Every chip's parameter rows, by parameter id; a chip
   * builds its rows whether or not it is the expanded one.
   */
  const rows = new Map();
  /** @type {Set<string>} */
  const pinnedLabels = new Set();
  /** @type {Array<{remove: () => void}>} */
  const drags = [];

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
   * @param {string|null} [focusControl] - Selector of the chip control to
   *   focus instead of the chip itself.
   * @returns {true} Always true, for tail-calling.
   */
  const commit = (focusLabel, focusControl = null) => {
    announce('');
    render({ focusLabel, focusControl });
    notifySelection();
    onApply();
    return true;
  };

  /**
   * Toggles a chip's pin and selection and re-renders.
   * @param {string} label - The instance label.
   * @returns {void}
   */
  const select = (label) => {
    const selected = label === store.selectedLabel() ? null : label;
    if (!store.setSelectedLabel(selected)) return;
    if (selected !== null) focusedLabel = selected;
    if (!pinnedLabels.delete(label)) pinnedLabels.add(label);
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
   * @param {*} chip - The movable chip.
   * @param {*} header - Its drag surface.
   * @param {number} index - The chip's chain index.
   * @param {string|null} name - The stage name shown while dragging.
   * @returns {() => boolean} Whether a completed drag consumes the next click.
   */
  const wireChipDrag = (chip, header, index, name) => {
    let originX = 0;
    let originY = 0;
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let suppressClick = false;
    /** @type {PointerEvent|null} */
    let lastPointer = null;
    /** @type {*|null} */
    let preview = null;
    /** @type {*|null} */
    let marker = null;

    const clearMarker = () => {
      marker?.classList.remove('chain-chip--drop-before', 'chain-chip--drop-after');
      marker = null;
    };
    const clear = () => {
      scrollFrame.cancel();
      lastPointer = null;
      clearMarker();
      preview?.remove();
      preview = null;
      dragging = false;
      chip.classList.remove('chain-chip--dragging');
    };
    const dropGap = (/** @type {PointerEvent} */ event) => {
      clearMarker();
      const band = chip.parentNode;
      const bounds = band.getBoundingClientRect();
      const viewport = container.querySelector('.chain-strip-viewport').getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < Math.max(bounds.top, viewport.top)
          || event.clientY > Math.min(bounds.bottom, viewport.bottom)) return null;
      const siblings = [...band.querySelectorAll('.chain-chip')];
      const before = siblings.find((other) => {
        const rect = other.getBoundingClientRect();
        return event.clientY < rect.top + rect.height / 2;
      });
      const target = before ?? siblings[siblings.length - 1];
      const gap = Number(target.dataset.index) + (before ? 0 : 1);
      if (gap === index || gap === index + 1) return null;
      marker = target;
      marker.classList.add(before ? 'chain-chip--drop-before' : 'chain-chip--drop-after');
      return gap;
    };
    const scrollViewport = (/** @type {PointerEvent} */ event) => {
      const viewport = container.querySelector('.chain-strip-viewport');
      const bounds = viewport.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right) return false;
      const direction = event.clientY < bounds.top + DRAG_SCROLL_EDGE_PX ? -1
        : event.clientY > bounds.bottom - DRAG_SCROLL_EDGE_PX ? 1 : 0;
      const before = viewport.scrollTop;
      viewport.scrollTop = Math.max(0, Math.min(
        viewport.scrollHeight - viewport.clientHeight,
        before + direction * DRAG_SCROLL_EDGE_PX));
      return viewport.scrollTop !== before;
    };
    const scrollFrame = createFrameScheduler(() => {
      if (lastPointer === null || !scrollViewport(lastPointer)) return;
      dropGap(lastPointer);
      scrollFrame();
    });
    const drag = createPointerDrag({
      element: header,
      onStart(event) {
        suppressClick = false;
        const target = /** @type {Element} */ (event.target);
        if (target.closest('button, input, select, textarea, label, a')) return false;
        originX = event.clientX;
        originY = event.clientY;
        const rect = header.getBoundingClientRect();
        offsetX = originX - rect.left;
        offsetY = originY - rect.top;
        return true;
      },
      onMove(event) {
        if (!dragging) {
          if (Math.hypot(event.clientX - originX, event.clientY - originY) < DRAG_SLOP_PX) return;
          dragging = true;
          suppressClick = true;
          focusChip(index);
          chip.classList.add('chain-chip--dragging');
          preview = el('div', 'chain-drag-preview');
          preview.setAttribute('aria-hidden', 'true');
          preview.textContent = name;
          preview.style.width = `${header.getBoundingClientRect().width}px`;
          doc.body.appendChild(preview);
        }
        preview.style.left = `${event.clientX - offsetX}px`;
        preview.style.top = `${event.clientY - offsetY}px`;
        lastPointer = event;
        if (scrollViewport(event)) scrollFrame();
        dropGap(event);
      },
      onEnd(event) {
        if (!dragging) return;
        const gap = event === null ? null : dropGap(event);
        clear();
        if (gap !== null) moveChip(index, gap);
      },
      onCancel: clear,
    });
    const cancelKeydown = (/** @type {*} */ event) => {
      if (event.key !== 'Escape' || !dragging) return;
      event.preventDefault();
      drag.stop();
    };
    chip.addEventListener('keydown', cancelKeydown);
    drags.push({ remove() {
      chip.removeEventListener('keydown', cancelKeydown);
      drag.remove();
    } });
    return () => {
      const consumed = suppressClick;
      suppressClick = false;
      return consumed;
    };
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
   * Toggles a modulation's authored enabled state or another stage's session bypass.
   * @param {string} label - The instance label.
   * @returns {void}
   */
  const toggleStage = (label) => {
    if (store.chain().find((entry) => entry.label === label)?.operator === MODULATION_OPERATOR) {
      const id = `${label}.modulation-enabled`;
      editParameter(id, values[id] === 'disabled' ? 'enabled' : 'disabled');
      store.endValueRun();
      onCommitParameter();
      return;
    }
    if (!bypassAvailable()) {
      announce(BYPASS_UNAVAILABLE);
      return;
    }
    const on = !store.bypassedLabels().includes(label);
    const result = store.setBypassed(label, on);
    if (!result.ok) {
      report(result);
      return;
    }
    announce('');
    render({ focusLabel: label, focusControl: '.chain-chip-bypass' });
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
    let bounds = element.getBoundingClientRect();
    const width = bounds.width;
    const viewport = doc.documentElement?.clientWidth ?? 0;
    const anchorBounds = anchor.getBoundingClientRect();
    let left = anchorBounds.left;
    if (viewport > 0) left = Math.min(left, viewport - width - PALETTE_MARGIN);
    element.style.left = `${Math.max(PALETTE_MARGIN, left)}px`;
    const viewportHeight = doc.documentElement?.clientHeight ?? 0;
    let top = anchorBounds.bottom + PALETTE_GAP;
    if (viewportHeight > 0) {
      const available = Math.max(0, viewportHeight - 2 * PALETTE_MARGIN);
      top = Math.min(top, viewportHeight - Math.min(bounds.height, available) - PALETTE_MARGIN);
      top = Math.max(PALETTE_MARGIN, top);
      const maxHeight = Math.max(0, viewportHeight - top - PALETTE_MARGIN);
      element.style.maxHeight = `${Math.min(bounds.height, maxHeight)}px`;
      element.style.overflowY = 'auto';
      bounds = element.getBoundingClientRect();
      top = Math.min(top, viewportHeight - Math.min(bounds.height, maxHeight) - PALETTE_MARGIN);
    }
    element.style.top = `${Math.max(PALETTE_MARGIN, top)}px`;
  };

  /** Removes an open palette without committing anything. */
  const closePalette = () => {
    if (palette === null) return;
    const element = palette.element;
    if (palette.anchor.getAttribute('aria-haspopup') !== null) palette.anchor.setAttribute('aria-expanded', 'false');
    palette = null;
    element.remove();
  };

  /**
   * Dismisses a palette outside the pressed target.
   * @param {*} event - A pointerdown anywhere in the document.
   * @returns {void}
   */
  const pointerDown = (event) => {
    if (palette === null || palette.element.contains(event.target)
        || palette.anchor.contains(event.target)) return;
    closePalette();
  };

  /**
   * Opens the palette with only the operators valid at this position.
   * @param {Object} options - What the palette replaces.
   * @param {'insert'|'replace'} options.kind - Insertion at a gap or replacement
   *   of one chip.
   * @param {number} options.index - The gap or chip chain index.
   * @param {*} options.anchor - Element the palette sits after and under, and
   *   the one Escape returns focus to.
   * @returns {void}
   */
  const openPalette = ({ kind, index, anchor }) => {
    closePalette();
    const chain = store.chain();
    /** @type {Map<string, SpanChoice>} */
    const choices = new Map(kind === 'insert'
      ? store.legalInsertions(index).filter((candidate) => candidate.legal)
        .map((candidate) => [candidate.operator.id,
          { start: index, deleteCount: 0, operators: [candidate.operator] }])
      : socketChoices(index).map((choice) => [choiceKey(choice.operators), choice]));
    if (choices.size === 0) {
      announce('No legal operators are available here.');
      return;
    }
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
      const choice = choices.get(entry.dataset.operator);
      if (choice === undefined) return;
      const result = store.replaceSpan(choice.start, choice.deleteCount,
        choiceEntries(choice));
      if (!result.ok) {
        report(result);
        return;
      }
      palette = null;
      const after = store.chain();
      const focusLabel = choice.operators.length === 0
        ? (after[index]?.label ?? after[index - 1]?.label ?? null)
        : (after[choice.start]?.label ?? null);
      if (kind === 'insert') store.setSelectedLabel(focusLabel);
      if (focusLabel !== null) pinnedLabels.add(focusLabel);
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

    for (const [key, choice] of choices) {
      const option = el('div', 'chain-palette-entry');
      option.dataset.operator = key;
      const name = el('span', 'chain-palette-name');
      name.textContent = choice.operators.map((candidate) => candidate.name)
        .join(' → ');
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
      if (!palette || palette.element !== element) return;
      const next = event.relatedTarget ?? null;
      if (next !== null && (element.contains(next) || palette.anchor.contains(next))) return;
      closePalette();
    });

    anchor.parentNode.insertBefore(element, anchor.nextSibling);
    placePalette(element, anchor);
    palette = { element, anchor };
    if (anchor.getAttribute('aria-haspopup') !== null) anchor.setAttribute('aria-expanded', 'true');
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
    if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(key)) {
      event.preventDefault();
      const forward = key === 'ArrowDown' || key === 'ArrowRight';
      if (!event.altKey) {
        focusChip(forward ? index + 1 : index - 1);
        return;
      }
      // A crossing has no reorder, and a band edge has no neighbour to swap with.
      if (crossing || !sharesBand(index, forward ? 1 : -1)) return;
      moveChip(index, forward ? index + 2 : index - 1);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      select(entry.label);
      return;
    }
    if ((key === 'b' || key === 'B')
      && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!crossing) toggleStage(entry.label);
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
   * @param {string} parameterId - The deactivated parameter.
   * @returns {string} The id its reason node is published under, for the row's
   *   controls to describe themselves by.
   */
  const reasonId = (parameterId) => `chain-param-off-${encodeURIComponent(parameterId)}`;

  /**
   * Points a row's controls at its reason node, or takes the reference back.
   * @param {*} row - The parameter row.
   * @param {string|null} id - The reason node's id, or null to clear.
   * @returns {void}
   */
  const describeControls = (row, id) => {
    for (const selector of ['.chain-param-control', '.chain-param-value']) {
      const control = row.querySelector(selector);
      if (control === null) continue;
      if (id === null) control.removeAttribute('aria-describedby');
      else control.setAttribute('aria-describedby', id);
    }
  };

  /**
   * Repaints each parameter row's deactivated controls and the reason node
   * beside them.
   */
  const markDeactivated = () => {
    const chain = store.chain();
    const off = deactivatedParameterIds(declarations, values, chain, catalog);
    for (const control of container.querySelectorAll('.chain-modulation-enabled')) {
      const id = `${control.dataset.label}.modulation-enabled`;
      const disabled = values[id] === 'disabled';
      const action = disabled ? 'Enable' : 'Disable';
      control.setAttribute('aria-pressed', String(disabled));
      control.setAttribute('aria-label', `${action} Modulation · ${control.dataset.label}`);
      control.setAttribute('title', action);
      control.disabled = !parameterLive(id);
    }
    for (const control of container.querySelectorAll('.chain-palette-type')) {
      const id = control.dataset.parameter;
      control.value = values[id];
      control.disabled = !parameterLive(id);
    }
    for (const [id, row] of rows) {
      const label = id.slice(0, id.indexOf('.'));
      const operator = chain.find((entry) => entry.label === label)?.operator;
      const color = operator === PALETTE_OPERATOR;
      const modulation = operator === MODULATION_OPERATOR;
      const ripple = operator === 'sphere.displace.ripple.v2';
      const field = fieldOf(id);
      if ((color || modulation) && ['pattern-scale', 'modulation-amount'].includes(field)) {
        const domain = declarations.find((parameter) => parameter.id === id)?.domain;
        let minimum = Number(domain?.minimum);
        let maximum = Number(domain?.maximum);
        if (field === 'pattern-scale' && values[`${label}.modulation-evaluation`] === 'baked-cube')
          maximum = Math.min(maximum, 8);
        if (field === 'modulation-amount' && values[`${label}.modulation-mechanic`] !== 'hue-rotation') {
          minimum = Math.max(minimum, 0);
          maximum = Math.min(maximum, 1);
        }
        for (const control of row.querySelectorAll('input')) {
          control.min = String(minimum);
          control.max = String(maximum);
        }
      }
      row.hidden = (color && (off.has(id)
        || colorParameterHidden(field, (field) => values[`${label}.${field}`])))
        || (modulation && (off.has(id)
          || modulationParameterHidden(field, (field) => values[`${label}.${field}`])))
        || (ripple && off.has(id) && ['center-azimuth', 'center-polar'].includes(field));
      const shown = row.querySelector('.chain-param-note');
      const live = parameterLive(id);
      for (const control of row.querySelectorAll('input, select')) control.disabled = !live;
      const reason = live ? DEACTIVATED_REASON : 'This parameter is baked into the compiled build';
      if (!row.hidden && (!live || off.has(id))) {
        row.dataset.deactivated = 'true';
        if (shown !== null) { shown.textContent = reason; continue; }
        const note = el('span', 'chain-param-note');
        note.setAttribute('id', reasonId(id));
        note.textContent = reason;
        row.appendChild(note);
        describeControls(row, reasonId(id));
      } else {
        delete row.dataset.deactivated;
        if (shown === null) continue;
        row.removeChild(shown);
        describeControls(row, null);
      }
    }
    for (const group of container.querySelectorAll('.chain-param-group')) {
      group.hidden = [...group.querySelectorAll('.chain-param')].every((row) => row.hidden);
    }
  };

  /**
   * Takes one inline control edit: the document write is the caller's, and the
   * strip keeps the value it now shows so a topology edit re-dims what the new
   * selection deactivates.
   * @param {string} parameterId - The edited parameter.
   * @param {*} value - The document value.
   * @returns {boolean}
   */
  const editParameter = (parameterId, value) => {
    if (!parameterLive(parameterId)) return false;
    if (onEditParameter(parameterId, value) === false) {
      scheduleSliderEdit.cancel();
      pendingSliderEdit = null;
      store.endValueRun();
      render();
      return false;
    }
    values[parameterId] = value;
    markDeactivated();
    return true;
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
   * @returns {*} The control for its domain values.
   */
  const enumControl = (declaration) => {
    if (fieldOf(declaration.id) === 'random-center'
      && declaration.domain?.values?.join(',') === 'off,on') {
      const toggle = el('input', 'chain-param-control');
      toggle.type = 'checkbox';
      toggle.checked = values[declaration.id] === 'on';
      toggle.addEventListener('change', () => {
        const accepted = editParameter(declaration.id, toggle.checked ? 'on' : 'off');
        toggle.checked = values[declaration.id] === 'on';
        if (accepted) {
          store.endValueRun();
          onCommitParameter();
        }
      });
      return toggle;
    }
    const select = el('select', 'chain-param-control');
    for (const value of declaration.domain?.values ?? []) {
      const option = el('option', 'chain-param-option');
      option.value = value;
      option.textContent = titleCase(value);
      option.selected = value === values[declaration.id];
      select.appendChild(option);
    }
    select.addEventListener('change', (/** @type {*} */ event) => {
      editParameter(declaration.id, event.target.value);
      store.endValueRun();
      onCommitParameter();
    });
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
    // Any step grid would re-snap the authored value on first touch.
    slider.step = 'any';
    slider.value = String(values[declaration.id]);
    slider.addEventListener('input', (/** @type {*} */ event) => {
      const value = Number(event.target.value);
      readout.value = formatNumericValue(value);
      pendingSliderEdit = { parameterId: declaration.id, value };
      scheduleSliderEdit();
    });
    slider.addEventListener('change', () => {
      commitSliderEdit();
      store.endValueRun();
      onCommitParameter();
    });
    return slider;
  };

  /**
   * The instance label as an editable field. A rename is a document edit
   * through the store; a refusal restores the field.
   * @param {ChainEntry} entry - The expanded chain entry.
   * @returns {*} The rename row.
   */
  const renameRow = (entry) => {
    const row = el('div', 'chain-chip-rename-row');
    const label = el('span', 'chain-param-name');
    label.textContent = 'Name';
    row.appendChild(label);
    const field = el('input', 'chain-chip-rename');
    field.type = 'text';
    field.value = entry.label;
    field.setAttribute('aria-label', `${opOf(entry).name} · ${entry.label} name`);
    field.addEventListener('change', (/** @type {*} */ event) => {
      const next = String(event.target.value ?? '').trim();
      if (next === entry.label) return;
      const result = store.relabel(entry.label, next);
      if (!result.ok) {
        field.value = entry.label;
        report(result);
        return;
      }
      if (pinnedLabels.delete(entry.label)) pinnedLabels.add(next);
      commit(next);
    });
    row.appendChild(field);
    return row;
  };

  /**
   * The expanded chip's own controls, one row per parameter the store reports
   * for the instance (authored declarations plus undeclared catalog fields),
   * labeled by the field segment alone: the chip already names the instance.
   * @param {ChainEntry} entry - The expanded chain entry.
   * @param {ParameterDeclaration[]} declared - The instance's parameters.
   * @returns {*} The parameter region.
   */
  const paramsElement = (entry, declared) => {
    const palette = entry.operator === PALETTE_OPERATOR;
    const modulation = entry.operator === MODULATION_OPERATOR;
    const color = palette || modulation;
    const parameterGroups = modulation ? MODULATION_PARAMETER_GROUPS : COLOR_PARAMETER_GROUPS;
    const region = el('div', 'chain-chip-params');
    region.dataset.label = entry.label;
    region.setAttribute('role', 'group');
    region.setAttribute('aria-label', `${opOf(entry).name} · ${entry.label} parameters`);
    if (!color) region.appendChild(renameRow(entry));
    if (declared.length === 0) {
      const note = el('p', 'chain-strip-note');
      note.textContent = 'No adjustable parameters';
      region.appendChild(note);
    }
    /** @type {Map<string, *>} */
    const groups = new Map();
    const ordered = color ? parameterGroups.flatMap((group) => group.fields.flatMap(
      (field) => declared.filter((parameter) => fieldOf(parameter.id) === field))) : declared;
    for (const declaration of [...ordered, ...declared.filter((parameter) => !ordered.includes(parameter))]) {
      const field = fieldOf(declaration.id);
      if (modulation && field === 'modulation-enabled') continue;
      if (palette && field === 'palette-type') continue;
      const name = color ? COLOR_PARAMETER_NAMES[field]
        ?? titleCase(field.replace(/^(interference|grid)-(.+)-b(?=-|$)/, '$1-$2')
          .replace(/^(sine|interference|grid)-/, ''))
        : titleCase(field);
      let parent = region;
      if (color) {
        const groupName = parameterGroups.find((group) => group.fields.includes(field))?.name
          ?? 'Other';
        if (!groups.has(groupName)) {
          const group = el('div', 'chain-param-group');
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', groupName);
          const heading = el('div', 'chain-param-group-title');
          heading.textContent = groupName;
          group.appendChild(heading);
          region.appendChild(group);
          groups.set(groupName, group);
        }
        parent = groups.get(groupName);
      }
      const row = el('div', 'chain-param');
      row.dataset.parameter = declaration.id;
      const label = el('span', 'chain-param-name');
      label.textContent = name;
      if (color && field === 'pattern-scale')
        label.setAttribute('title', 'Higher values produce finer noise; lower values produce broader patches.');
      if (color && field === 'pattern-speed')
        label.setAttribute('title', 'Animation rate. Zero freezes the noise; negative values reverse it.');
      row.appendChild(label);
      if (declaration.storage === 'enum8') {
        const control = enumControl(declaration);
        control.setAttribute('aria-label', name);
        row.appendChild(control);
      } else {
        const readout = el('input', 'chain-param-value');
        readout.type = 'number';
        readout.value = formatNumericValue(values[declaration.id]);
        const slider = sliderControl(declaration, readout);
        slider.setAttribute('aria-label', name);
        readout.min = slider.min;
        readout.max = slider.max;
        // Any step grid would report a stored binary32 as stepMismatch.
        readout.step = 'any';
        readout.setAttribute('aria-label', `${name} value`);
        /** @param {string} raw - The entered text. @returns {void} */
        const enterValue = (raw) => {
          // Unparseable number-input content reads as '', which Number() makes 0.
          const trimmed = raw.trim();
          const typed = trimmed === '' ? Number.NaN : Number(trimmed);
          const current = Number(values[declaration.id]);
          const value = Number.isFinite(typed)
            ? Math.min(Number(slider.max), Math.max(Number(slider.min), typed))
            : current;
          readout.value = formatNumericValue(value);
          if (value === current) return;
          slider.value = String(value);
          editParameter(declaration.id, value);
        };
        readout.addEventListener('change', (/** @type {*} */ event) => {
          enterValue(String(event.target.value ?? ''));
          store.endValueRun();
          onCommitParameter();
        });
        readout.addEventListener('keydown', (/** @type {*} */ event) => {
          const direction = event.key === 'ArrowUp' ? 1
            : event.key === 'ArrowDown' ? -1 : 0;
          if (direction === 0) return;
          event.preventDefault();
          const shown = readout.value.trim() === '' ? NaN : Number(readout.value);
          const from = Number.isFinite(shown) ? shown : Number(values[declaration.id]);
          enterValue(String(from + direction * nudgeStep(declaration)));
          store.endValueRun();
          onCommitParameter();
        });
        row.appendChild(slider);
        row.appendChild(readout);
      }
      rows.set(declaration.id, row);
      parent.appendChild(row);
    }
    if (palette) region.appendChild(renameRow(entry));
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
    const expanded = pinnedLabels.has(entry.label);
    const chip = el('div', 'chain-chip'
      + (crossing ? ' chain-chip--socket' : ' chain-chip--stage')
      + (expanded ? ' chain-chip--expanded' : '')
      + (isBypassed ? ' chain-chip--bypassed' : ''));
    chip.dataset.label = entry.label;
    chip.dataset.index = String(index);
    // Not role=option: an option's children are presentational to assistive technology.
    chip.setAttribute('role', 'group');
    if (isSelected) chip.setAttribute('aria-current', 'true');
    chip.setAttribute('tabindex', tabLabel === entry.label ? '0' : '-1');
    chip.setAttribute('aria-keyshortcuts',
      crossing ? 'ArrowUp ArrowDown ArrowLeft ArrowRight Enter Space Delete Backspace Insert'
        : 'ArrowUp ArrowDown Alt+ArrowUp Alt+ArrowDown ArrowLeft ArrowRight Alt+ArrowLeft Alt+ArrowRight Enter Space b Delete Backspace Insert');
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
      const paletteType = entry.operator === PALETTE_OPERATOR
        ? declared.find((parameter) => fieldOf(parameter.id) === 'palette-type') : undefined;
      const replacement = paletteType ? enumControl(paletteType) : el('select', 'chain-chip-replace');
      if (paletteType) {
        replacement.classList.remove('chain-param-control');
        replacement.classList.add('chain-chip-replace', 'chain-palette-type');
        replacement.dataset.parameter = paletteType.id;
      }
      replacement.setAttribute('tabindex', '0');
      replacement.setAttribute('aria-label', socketFunction.accessibleName);
      const choices = new Map(socketChoices(index).map(
        (choice) => [choiceKey(choice.operators), choice]));
      for (const [key, choice] of paletteType ? [] : choices) {
        const option = el('option', 'chain-chip-replace-option');
        option.value = key;
        option.textContent = choice.operators.map((candidate) => candidate.name)
          .join(' → ');
        option.selected = key === entry.operator;
        replacement.appendChild(option);
      }
      replacement.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
      });
      replacement.addEventListener('change', (/** @type {*} */ event) => {
        event.stopPropagation();
        if (paletteType) return;
        const choice = choices.get(event.target.value);
        if (choice === undefined) return;
        const result = store.replaceSpan(choice.start, choice.deleteCount,
          choiceEntries(choice));
        if (!result.ok) {
          event.target.value = entry.operator;
          report(result);
          return;
        }
        commit(store.chain()[choice.start]?.label ?? null, '.chain-chip-replace');
      });
      functionLabel.appendChild(replacement);
      header.appendChild(functionLabel);
    } else {
      const name = el('span', 'chain-chip-name');
      name.textContent = op.name;
      header.appendChild(name);
      const toggle = el('button', 'chain-chip-bypass');
      const modulation = entry.operator === MODULATION_OPERATOR;
      const bypassable = modulation ? parameterLive(`${entry.label}.modulation-enabled`) : bypassAvailable();
      if (modulation) {
        toggle.classList.add('chain-modulation-enabled');
        toggle.dataset.label = entry.label;
      }
      toggle.type = 'button';
      toggle.setAttribute('tabindex', '0');
      toggle.setAttribute('aria-keyshortcuts', 'b');
      toggle.disabled = !bypassable;
      toggle.setAttribute('aria-pressed', String(isBypassed));
      toggle.setAttribute('aria-label', `Bypass ${op.name} · ${entry.label}`);
      toggle.setAttribute('title', bypassable ? 'Bypass' : BYPASS_UNAVAILABLE);
      toggle.textContent = '◉';
      toggle.addEventListener('click', (/** @type {*} */ event) => {
        event.stopPropagation();
        toggleStage(entry.label);
      });
      header.appendChild(toggle);
    }

    const pin = el('button', 'chain-chip-pin');
    pin.type = 'button';
    const pinIcon = el('span', 'chain-chip-pin-icon');
    pinIcon.setAttribute('aria-hidden', 'true');
    pin.appendChild(pinIcon);
    const syncPin = () => {
      const pinned = pinnedLabels.has(entry.label);
      pin.setAttribute('aria-pressed', String(pinned));
      pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${op.name} · ${entry.label}`);
      pin.setAttribute('title', pinned ? 'Unpin panel' : 'Pin panel');
    };
    syncPin();
    pin.addEventListener('click', (/** @type {*} */ event) => {
      event.stopPropagation();
      if (!pinnedLabels.delete(entry.label)) pinnedLabels.add(entry.label);
      syncPin();
      chip.classList.toggle('chain-chip--expanded', pinnedLabels.has(entry.label));
      markDeactivated();
    });
    header.appendChild(pin);
    if (!crossing) {
      const remove = el('button', 'chain-chip-remove');
      remove.type = 'button';
      remove.setAttribute('tabindex', '0');
      remove.setAttribute('aria-keyshortcuts', 'Delete Backspace');
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
    chip.appendChild(paramsElement(entry, declared));

    const movable = !crossing && (sharesBand(index, -1) || sharesBand(index, 1));
    header.classList.toggle('chain-chip-header--draggable', movable);
    const consumeDragClick = movable ? wireChipDrag(chip, header, index, op.name) : () => false;
    chip.addEventListener('click', (/** @type {*} */ event) => {
      if (consumeDragClick()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const clickedHeader = event.target === chip
        || event.target?.closest?.('.chain-chip-header') === header;
      if (clickedHeader) select(entry.label);
    });
    chip.addEventListener('keydown', (/** @type {*} */ event) => {
      chipKeydown(event, index, entry, crossing, chip);
    });
    return chip;
  };

  /**
   * @param {BandLayout} band - The band the button belongs to.
   * @returns {*|null} The band's insertion affordance, when a stage fits.
   */
  const bandAddButton = (band) => {
    const title = titleCase(band.carrier);
    const gap = appendGap(band);
    if (gap === null || !store.legalInsertions(gap).some((entry) => entry.legal))
      return null;
    const add = el('button', 'chain-band-add');
    add.type = 'button';
    add.setAttribute('aria-haspopup', 'listbox');
    add.setAttribute('aria-expanded', 'false');
    add.setAttribute('aria-label', `Add a ${title} stage`);
    add.textContent = '+';
    /** @type {boolean|null} */
    let openOnPointerDown = null;
    add.addEventListener('pointerdown', () => { openOnPointerDown = palette?.anchor === add; });
    add.addEventListener('click', () => {
      const wasOpen = openOnPointerDown ?? (palette?.anchor === add);
      openOnPointerDown = null;
      if (wasOpen) closePalette();
      else openPalette({ kind: 'insert', index: gap, anchor: add });
    });
    return add;
  };

  /** @param {*} viewport @param {number} direction */
  const scrollPipeline = (viewport, direction) => {
    const distance = Math.max(MIN_SCROLL_STEP,
      Number(viewport.clientHeight ?? 0) * SCROLL_STEP_RATIO);
    viewport.scrollTop = Math.max(0,
      Number(viewport.scrollTop ?? 0) + direction * distance);
  };

  /** @param {*} viewport @param {number} direction @returns {*} */
  const scrollButton = (viewport, direction) => {
    const button = el('button', 'chain-scroll-button');
    button.type = 'button';
    button.setAttribute('aria-label', direction < 0
      ? 'Scroll shader chain up' : 'Scroll shader chain down');
    const icon = el('span', direction < 0
      ? 'chain-scroll-icon chain-scroll-icon--up' : 'chain-scroll-icon');
    icon.setAttribute('aria-hidden', 'true');
    button.appendChild(icon);
    button.addEventListener('click', () => scrollPipeline(viewport, direction));
    return button;
  };

  /**
   * Rebuilds the whole strip from the store. Keyboard focus is restored to the
   * named chip (or the chip control matching `focusControl`), or to the
   * roving-tabindex chip when the strip held focus before the rebuild.
   * @param {{focusLabel?: string|null, focusControl?: string|null}} [options]
   * @returns {void}
   */
  const render = ({ focusLabel = null, focusControl = null } = {}) => {
    const active = doc.activeElement ?? null;
    const hadFocus = active !== null && container.contains(active);
    const scrolled = Number(
      container.querySelector('.chain-strip-viewport')?.scrollTop ?? 0);
    palette = null;
    for (const drag of drags) drag.remove();
    drags.length = 0;
    const layout = bandLayout();
    rows.clear();

    const snapshot = store.document();
    declarations = store.parameterDeclarations();
    const presets = snapshot.preset_bank.presets;
    const preset = presets.find(
      (/** @type {*} */ candidate) => candidate.preset_id === presetId()) ?? presets[0];
    values = Object.fromEntries(declarations.map((parameter) =>
      [parameter.id, parameter.default]));
    Object.assign(values, preset?.values);

    const chain = store.chain();
    const selected = store.selectedLabel();
    const bypassed = new Set(store.bypassedLabels());
    const labels = chain.map((entry) => entry.label);
    for (const label of pinnedLabels) {
      if (!labels.includes(label)) pinnedLabels.delete(label);
    }
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
    if (!bypassAvailable()) {
      const note = el('p', 'chain-strip-note');
      note.textContent = BYPASS_UNAVAILABLE;
      actions.appendChild(note);
    }

    const strip = el('div', 'chain-strip');
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', 'Shader chain');
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
    viewport.setAttribute('role', 'group');
    viewport.setAttribute('aria-label', 'Scrollable shader chain');
    viewport.appendChild(strip);
    viewport.addEventListener('wheel', (/** @type {*} */ event) => {
      const delta = event.deltaY;
      if (delta === 0) return;
      const height = Number(viewport.clientHeight ?? 0);
      const overflow = Number(viewport.scrollHeight ?? 0) - height;
      if (overflow <= 0) return;
      // deltaMode counts pixels, lines or pages.
      const scale = event.deltaMode === 1 ? WHEEL_LINE_PX
        : event.deltaMode === 2 ? Math.max(MIN_SCROLL_STEP, height) : 1;
      viewport.scrollTop = Math.min(overflow,
        Math.max(0, Number(viewport.scrollTop ?? 0) + delta * scale));
      event.preventDefault();
    }, { passive: false });
    viewport.addEventListener('keydown', (/** @type {*} */ event) => {
      if (event.target !== viewport
        || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault();
      scrollPipeline(viewport, event.key === 'ArrowUp' ? -1 : 1);
    });

    container.replaceChildren(actions, scrollButton(viewport, -1), viewport,
      scrollButton(viewport, 1));
    // Preserve the scroll offset across rebuilds.
    if (scrolled > 0) viewport.scrollTop = scrolled;
    markDeactivated();

    const target = focusLabel !== null ? chipByLabel(focusLabel) : null;
    if (target) {
      focusedLabel = focusLabel;
      if (focusControl !== null) {
        const control = target.querySelector(focusControl);
        (control ?? target).focus();
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
   * The container's history shortcut.
   * @param {*} event - A keydown anywhere in the strip.
   * @returns {void}
   */
  const historyKeydown = (event) => {
    const target = event.target;
    if (target?.isContentEditable ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes(target?.tagName)) return;
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
  // Bound after the first render: a throwing render returns no destroy().
  render();
  container.addEventListener('keydown', historyKeydown);
  doc.addEventListener('pointerdown', pointerDown, true);

  return {
    render,

    /** @param {Record<string, *>} updates - Committed parameter values. */
    syncParameterValues(updates) {
      for (const [id, value] of Object.entries(updates)) {
        values[id] = value;
        const row = rows.get(id);
        if (!row) continue;
        const control = row.querySelector('.chain-param-control');
        if (control.type === 'checkbox') control.checked = value === 'on';
        else control.value = String(value);
        const readout = row.querySelector('.chain-param-value');
        if (readout) readout.value = formatNumericValue(value);
      }
      markDeactivated();
    },

    /**
     * Repaints the Undo/Redo buttons without a rebuild, which would replace the
     * control under a dragging pointer.
     * @returns {void}
     */
    syncHistory() {
      if (history === null) return;
      history.undo.disabled = !store.canUndo();
      history.redo.disabled = !store.canRedo();
    },

    flushParameterEdit: commitSliderEdit,

    /**
     * Detaches the strip's listeners and empties its container.
     * @returns {void}
     */
    destroy() {
      scheduleSliderEdit.cancel();
      pendingSliderEdit = null;
      container.removeEventListener('keydown', historyKeydown);
      doc.removeEventListener('pointerdown', pointerDown, true);
      for (const drag of drags) drag.remove();
      drags.length = 0;
      container.replaceChildren();
    },
  };
}
