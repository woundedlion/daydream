/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {createFrameScheduler} from '../../shared/page_lifecycle.js';
import {createPointerDrag} from '../../shared/pointer_drag.js';

const DRAG_SLOP_PX = 5;
const DRAG_SCROLL_EDGE_PX = 24;

/**
 * @param {object} deps
 * @param {Document} deps.doc
 * @param {HTMLElement} deps.container
 * @param {import('./chain_row_controls.js').ElementFactory} deps.el
 * @param {(index: number) => void} deps.focusChip
 * @param {(index: number, gap: number) => boolean} deps.moveChip
 * @param {{remove: () => void}[]} deps.drags
 */
export function createChipDrag({doc, container, el, focusChip, moveChip, drags}) {
  /**
   * @param {HTMLElement} chip - The movable chip.
   * @param {HTMLElement} header - Its drag surface.
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
    /** @type {HTMLElement|null} */
    let preview = null;
    /** @type {HTMLElement|null} */
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
      const band = /** @type {HTMLElement} */ (chip.parentNode);
      const bounds = band.getBoundingClientRect();
      const viewport = /** @type {HTMLElement} */ (container.querySelector('.chain-strip-viewport')).getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right
          || event.clientY < Math.max(bounds.top, viewport.top)
          || event.clientY > Math.min(bounds.bottom, viewport.bottom)) return null;
      const siblings = /** @type {HTMLElement[]} */ ([...band.querySelectorAll('.chain-chip')]);
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
      const viewport = /** @type {HTMLElement} */ (container.querySelector('.chain-strip-viewport'));
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
        /** @type {HTMLElement} */ (preview).style.left = `${event.clientX - offsetX}px`;
        /** @type {HTMLElement} */ (preview).style.top = `${event.clientY - offsetY}px`;
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
    const cancelKeydown = (/** @type {KeyboardEvent} */ event) => {
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
  return wireChipDrag;
}
