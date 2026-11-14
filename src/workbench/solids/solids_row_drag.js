/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */
import {dropSlotIndex, dropTargetIndex, reorderPreviewShift, movedOps} from './solid_op_order.js';
import { createPointerDrag } from '../../shared/pointer_drag.js';
/** @typedef {{el: HTMLElement, grip: HTMLElement, list: HTMLElement, index: number, originX: number, originY: number, originListTop: number, originListLeft: number}} RowGesture */
const DRAG_SLOP_PX = 4;

/** Supplies operation and browser services. */
function defaultDependencies() {
  return { dropTargetIndex, movedOps, dropSlotIndex, console, reorderPreviewShift, createPointerDrag, DRAG_SLOP_PX };
}

/** @param {import('./solids_state.js').SolidsPage} page
 * @param {import('./solids_state.js').SolidsActions} actions
 * @param {Partial<ReturnType<typeof defaultDependencies>>} [dependencies] */
export function createSolidsRowDrag(page, actions, dependencies = {}) {
  const env = {...defaultDependencies(), ...dependencies};
  /** @param {number} fromIndex @param {number} target @returns {Promise<void>} */
  async function checkDropSlot(fromIndex, target) {
    if (page.doc.dropSlotChecks.has(target)) return;
    const gen = page.doc.dropSlotGen;
    page.doc.dropSlotChecks.set(target, null);
    const to = env.dropTargetIndex(target, fromIndex);
    if (to === fromIndex) {
      page.doc.dropSlotChecks.set(target, { ok: true, message: '' });
      return;
    }
    const check = await actions.chainIsValid(page.doc.base, env.movedOps(page.doc.ops, fromIndex, to));
    if (gen === page.doc.dropSlotGen) page.doc.dropSlotChecks.set(target, check);
  }

  /** @param {PointerEvent} e @param {HTMLElement} list @returns {number} */
  function getDragTargetIndex(e, list) {
    const listRect = list.getBoundingClientRect();
    const mouseY = e.clientY - listRect.top + list.scrollTop;
    return env.dropSlotIndex(mouseY, /** @type {HTMLElement[]} */ ([...list.children]));
  }

  /**
   * Update the row reorder preview for the current pointer position.
   * @param {{el: HTMLElement, grip: HTMLElement, list: HTMLElement, index: number, originX: number, originY: number, originListTop: number, originListLeft: number}} gesture - Drag state.
   * @param {PointerEvent} e - Pointer position.
   */
  function moveRowDragPreview(gesture, e) {
    const {el, grip, list, index, originX, originY, originListTop, originListLeft} = gesture;
    const rect = list.getBoundingClientRect();
    const dx = e.clientX - originX + originListLeft - rect.left + list.scrollLeft;
    const dy = e.clientY - originY + originListTop - rect.top + list.scrollTop;
    el.style.transform = `translate(${dx}px, ${dy}px)`;

    const targetIndex = actions.getDragTargetIndex(e, list);
    void actions.checkDropSlot(index, targetIndex).catch(env.console.error);
    const items = /** @type {HTMLElement[]} */ ([...list.children]);
    const draggingItem = items[index];
    if (!draggingItem) return;

    const targetCheck = page.doc.dropSlotChecks.get(targetIndex);
    const blocked = targetCheck?.ok === false;
    grip.classList.toggle('drop-blocked', blocked);
    if (blocked) {
      items.forEach((item, idx) => {
        if (idx !== index) item.style.transform = '';
      });
      return;
    }

    const shiftAmount = draggingItem.offsetHeight + 4;
    items.forEach((item, idx) => {
      if (idx === index) return;
      const shift = env.reorderPreviewShift(index, targetIndex, idx);
      item.style.transform = shift === 0 ? '' : `translateY(${shift * shiftAmount}px)`;
    });
  }

  /**
   * Wires one row's reorder drag onto its grip, with the pointer captured on the grip.
   * @param {HTMLElement} grip - The row's drag handle.
   * @param {number} index - The op's position in the chain.
   * @param {HTMLElement} el - The row element.
   * @param {HTMLElement} list - The #opsList container.
   * @param {number} revision - opsRevision this row was rendered against; the
   *   queued commit drops the drag when the list has changed since.
   * @returns {void}
   */
  function wireRowDrag(grip, index, el, list, revision) {
    const gesture = {el, grip, list, index, originX: 0, originY: 0, originListTop: 0, originListLeft: 0};
    let dragging = false;

    const clearPreview = () => {
      el.classList.remove('dragging');
      grip.classList.remove('drop-blocked');
      for (const item of /** @type {HTMLCollectionOf<HTMLElement>} */ (list.children)) item.style.transform = '';
    };

    env.createPointerDrag({
      element: grip,
      onStart: (e) => {
        if (!page.engine.wasmModule) return false;
        const rect = list.getBoundingClientRect();
        gesture.originX = e.clientX;
        gesture.originY = e.clientY;
        gesture.originListTop = rect.top - list.scrollTop;
        gesture.originListLeft = rect.left - list.scrollLeft;
        dragging = false;
        return undefined;
      },
      onMove: (e) => {
        if (!page.engine.wasmModule) return;
        if (!dragging) {
          if (Math.abs(e.clientY - gesture.originY) < env.DRAG_SLOP_PX) return;
          dragging = true;
          el.classList.add('dragging');
          page.doc.dropSlotGen += 1;
          page.doc.dropSlotChecks = new Map();
        }

        actions.moveRowDragPreview(gesture, e);
      },
      onEnd: (e) => {
        if (!dragging) return;
        dragging = false;
        clearPreview();
        if (!page.engine.wasmModule) return;

        const rawTarget = actions.getDragTargetIndex(/** @type {PointerEvent} */ (e), list);
        const toIndex = env.dropTargetIndex(rawTarget, index);
        if (index === toIndex) {
          actions.renderOps();
          return;
        }
        const slotCheck = page.doc.dropSlotChecks.get(rawTarget);
        if (slotCheck && !slotCheck.ok) {
          actions.showGateMsg(`rejected: ${slotCheck.message}`);
          actions.renderOps();
          return;
        }
        actions.renderOps(); // snap the drag preview back
        actions.reorderOp(index, toIndex, revision);
      },
      onCancel: () => {
        dragging = false;
        clearPreview();
      },
    });
  }
  return { checkDropSlot, getDragTargetIndex, moveRowDragPreview, wireRowDrag };
}
