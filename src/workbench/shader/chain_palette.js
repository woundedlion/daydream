// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {import('./chain_presentation.js').SpanChoice} SpanChoice */

const PALETTE_MARGIN = 8;
const PALETTE_GAP = 4;

/**
 * @param {{doc: *, el: (tag: string, classes: string) => *,
 *   store: import('./chain_document_store.js').ChainStore,
 *   presentation: ReturnType<typeof import('./chain_presentation.js').createChainPresentation>,
 *   commit: (label: string|null) => boolean,
 *   report: (result: *) => boolean, announce: (message: string) => void,
 *   pinnedLabels: Set<string>}} deps
 * @returns {*} Operator palette gestures and anchor state.
 */
export function createChainPalette({doc, el, store, presentation, commit, report, announce, pinnedLabels}) {
  const {opOf, socketChoices, choiceKey, choiceEntries} = presentation;
  /** @type {{element: *, anchor: *}|null} */
  let palette = null;

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
      const focusLabel = after[choice.start]?.label ?? null;
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

  return {
    open: openPalette,
    close: closePalette,
    pointerDown,
    anchor: () => palette?.anchor ?? null,
    forget() { palette = null; },
  };
}
