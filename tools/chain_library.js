// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The stage library under the pipeline strip: every catalog operator, grouped
 * into the same four carrier domains the strip bands into and in the same order,
 * so the whole vocabulary stays browsable while the strip's contextual palettes
 * list only what fits one gap. Entries drag onto the strip, which owns drop
 * legality and hit-tests the pointer itself, and click to insert at the current
 * drop context, where an illegal entry shows disabled with the computed reason
 * instead of vanishing. The filter narrows by name or id and never hides that
 * state: a browsable vocabulary that quietly drops what does not currently fit
 * is the folder banks again.
 */

import { createPointerDrag } from './pointer_drag.js';

/** @typedef {{id: string, name: string, input: string, output: string, params: Array<Object>}} CatalogOperator */
/** @typedef {{carriers: string[], operators: CatalogOperator[]}} OperatorCatalog */
/** @typedef {{operator: CatalogOperator, legal: boolean, reason?: string}} LegalityEntry */
/**
 * The strip's drag controller, which owns drop-target legality and resolves a
 * viewport point to a target of its own.
 * @typedef {{
 *   start: (source: {kind: 'operator', operatorId: string}) => boolean,
 *   hoverFromPoint: (x: number, y: number) => void,
 *   drop: () => boolean,
 *   cancel: () => void,
 * }} DragController
 */

const FILTER_ID = 'chain-library-filter';

/** @param {string} carrier @returns {string} The carrier's group title. */
const carrierTitle = (carrier) =>
  carrier.length === 0 ? carrier : carrier[0].toUpperCase() + carrier.slice(1);

/**
 * Builds the stage library into a container.
 * @param {Object} options - The library's collaborators.
 * @param {*} options.doc - Document the library renders into.
 * @param {*} options.container - Element the library owns.
 * @param {OperatorCatalog} options.catalog - The operator catalog.
 * @param {DragController} options.drag - The strip's drag controller.
 * @param {(message: string) => void} options.announce - Writes the workbench's
 *   one shared live status region; every refusal reports through it.
 * @param {(operatorId: string) => void} options.onPick - Runs when an enabled
 *   entry is clicked; the caller inserts the operator at the drop context.
 * @returns {Object} The library.
 */
export function createChainLibrary({ doc, container, catalog, drag, announce, onPick }) {
  /** @type {Map<string, LegalityEntry>|null} Null = no drop context; all enabled. */
  let legality = null;

  /**
   * @param {string} tag - Element tag.
   * @param {string} className - Class attribute.
   * @returns {*} The created element.
   */
  const el = (tag, className) => {
    const node = doc.createElement(tag);
    node.className = className;
    return node;
  };

  const label = el('label', 'chain-library-filter-label');
  label.setAttribute('for', FILTER_ID);
  label.textContent = 'Filter stages';
  const filter = el('input', 'chain-library-filter');
  filter.type = 'search';
  filter.id = FILTER_ID;

  /**
   * @param {CatalogOperator} op - A catalog operator.
   * @returns {*} The entry button.
   */
  const entryElement = (op) => {
    const entry = el('button', 'chain-library-entry');
    entry.type = 'button';
    entry.dataset.operator = op.id;
    const name = el('span', 'chain-library-name');
    name.textContent = op.name;
    entry.appendChild(name);
    if (op.input !== op.output) {
      const pair = el('span', 'chain-library-pair');
      pair.textContent = `${op.input} → ${op.output}`;
      entry.appendChild(pair);
    }
    const state = legality?.get(op.id);
    if (state !== undefined && !state.legal) {
      // aria-disabled is also the styling hook: this module loads on every page,
      // and only the workbench page carries its stylesheet.
      entry.setAttribute('aria-disabled', 'true');
      const reason = el('span', 'chain-library-reason');
      reason.id = `chain-library-reason-${op.id.replace(/[^a-z0-9]+/g, '-')}`;
      reason.textContent = state.reason ?? 'not legal at the drop context';
      entry.setAttribute('aria-describedby', reason.id);
      entry.appendChild(reason);
    }
    entry.addEventListener('click', () => {
      if (entry.getAttribute('aria-disabled') === 'true') {
        announce(state?.reason ?? 'this operator is not legal at the drop context');
        return;
      }
      onPick(op.id);
    });
    return entry;
  };

  /**
   * Rebuilds the groups from the catalog, the current legality and the filter.
   * The filter box itself survives, so narrowing never costs its focus or
   * caret.
   * @returns {void}
   */
  const render = () => {
    const query = String(filter.value ?? '').trim().toLowerCase();
    /** @param {CatalogOperator} op */
    const matches = (op) => query === ''
      || op.name.toLowerCase().includes(query) || op.id.toLowerCase().includes(query);
    for (const stale of container.querySelectorAll('.chain-library-group')) stale.remove();
    for (const carrier of catalog.carriers) {
      const ops = catalog.operators.filter((op) => op.input === carrier && matches(op));
      if (ops.length === 0) continue;
      const group = el('div', 'chain-library-group');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', `${carrierTitle(carrier)} stages`);
      group.dataset.carrier = carrier;
      const title = el('h3', 'chain-library-title');
      title.textContent = carrierTitle(carrier);
      group.appendChild(title);
      for (const op of ops) group.appendChild(entryElement(op));
      container.appendChild(group);
    }
  };

  filter.addEventListener('input', () => render());

  // Drags hand off to the strip's drag controller, which highlights and gates
  // the drop targets; entries stay draggable even when the click context
  // disables them, since the drop target carries its own legality.
  const pointer = createPointerDrag({
    element: container,
    onStart: (event) => {
      const target = /** @type {*} */ (event.target);
      if (!target || typeof target.closest !== 'function') return false;
      const entry = target.closest('.chain-library-entry');
      if (!entry || typeof entry.dataset.operator !== 'string') return false;
      if (!drag.start({ kind: 'operator', operatorId: entry.dataset.operator })) return false;
      return undefined;
    },
    onMove: (event) => drag.hoverFromPoint(event.clientX, event.clientY),
    onEnd: () => {
      drag.drop();
    },
    onCancel: () => drag.cancel(),
  });

  container.replaceChildren(label, filter);
  render();

  return {
    render,

    /**
     * Adopts the current drop context's legality, or clears it.
     * @param {LegalityEntry[]|null} entries - The store's insertion legality at
     *   the context gap, or null when there is no context.
     * @returns {void}
     */
    setLegality(entries) {
      legality = entries === null
        ? null
        : new Map(entries.map((entry) => [entry.operator.id, entry]));
      render();
    },

    /** Detaches the library's listeners and empties its container. */
    destroy() {
      pointer.remove();
      container.replaceChildren();
    },
  };
}
