// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The persistent operator catalog panel beside the chain rail: every catalog
 * operator, grouped into the four family bands by the carrier it consumes, so
 * the whole vocabulary stays browsable while the rail's contextual palettes
 * list only what fits one gap. Entries are draggable onto the rail's gaps (the
 * drop targets gate legality) and clickable to insert at the current drop
 * context — the gap after the selected card — where an illegal entry shows
 * disabled with the computed reason instead of vanishing.
 */

import { createPointerDrag } from './pointer_drag.js';
import { railGapFromPoint } from './chain_editor.js';

/** @typedef {import('./chain_editor.js').CatalogOperator} CatalogOperator */
/** @typedef {import('./chain_editor.js').OperatorCatalog} OperatorCatalog */
/** @typedef {import('./chain_editor.js').LegalityEntry} LegalityEntry */

/** @param {string} carrier @returns {string} The carrier's section title. */
const carrierTitle = (carrier) =>
  carrier.length === 0 ? carrier : carrier[0].toUpperCase() + carrier.slice(1);

/**
 * Builds the catalog panel into a container.
 * @param {Object} options - The panel's collaborators.
 * @param {*} options.doc - Document the panel renders into.
 * @param {*} options.container - Element the panel owns.
 * @param {OperatorCatalog} options.catalog - The operator catalog.
 * @param {{start: (source: Object) => boolean, hover: (gap: number|null) => void,
 *   drop: () => boolean, cancel: () => void}} options.drag - The rail editor's
 *   drag controller, which owns drop-target legality.
 * @param {(operatorId: string) => void} options.onPick - Runs when an enabled
 *   entry is clicked; the caller inserts the operator at the drop context.
 * @returns {Object} The panel.
 */
export function createChainCatalogPanel({ doc, container, catalog, drag, onPick }) {
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

  /** Rebuilds the panel's sections from the catalog and current legality. */
  const render = () => {
    const bands = [];
    for (const carrier of catalog.carriers) {
      const ops = catalog.operators.filter((op) => op.input === carrier);
      if (ops.length === 0) continue;
      const band = el('div', 'chain-catalog-band');
      const title = el('h3', 'chain-catalog-title');
      title.textContent = carrierTitle(carrier);
      band.appendChild(title);
      for (const op of ops) {
        const entry = el('button', 'chain-catalog-entry');
        entry.type = 'button';
        entry.dataset.operator = op.id;
        const name = el('span', 'chain-catalog-name');
        name.textContent = op.name;
        entry.appendChild(name);
        if (op.input !== op.output) {
          const pair = el('span', 'chain-catalog-pair');
          pair.textContent = `${op.input} → ${op.output}`;
          entry.appendChild(pair);
        }
        const state = legality?.get(op.id);
        if (state !== undefined && !state.legal) {
          // aria-disabled is also the styling hook: this module loads on every
          // page, and only the workbench page carries its stylesheet.
          entry.setAttribute('aria-disabled', 'true');
          const reason = el('span', 'chain-catalog-reason');
          reason.id = `chain-catalog-reason-${op.id.replace(/[^a-z0-9]+/g, '-')}`;
          reason.textContent = state.reason ?? 'not legal at the drop context';
          entry.setAttribute('aria-describedby', reason.id);
          entry.appendChild(reason);
        }
        entry.addEventListener('click', () => {
          if (entry.getAttribute('aria-disabled') === 'true') return;
          onPick(op.id);
        });
        band.appendChild(entry);
      }
      bands.push(band);
    }
    container.replaceChildren(...bands);
  };

  // Drags hand off to the rail's drag controller, which highlights and gates
  // the drop gaps; entries stay draggable even when the click context disables
  // them, since the drop target carries its own legality.
  const pointer = createPointerDrag({
    element: container,
    onStart: (event) => {
      const target = /** @type {*} */ (event.target);
      if (!target || typeof target.closest !== 'function') return false;
      const entry = target.closest('.chain-catalog-entry');
      if (!entry || typeof entry.dataset.operator !== 'string') return false;
      if (!drag.start({ kind: 'operator', operatorId: entry.dataset.operator })) return false;
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

    /** Detaches the panel's listeners and empties its container. */
    destroy() {
      pointer.remove();
      container.replaceChildren();
    },
  };
}
