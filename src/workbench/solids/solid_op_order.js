/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Op-chain drag slots, preview positions, and committed order. */

/**
 * The drop slot a pointer is over: the number of list items whose midpoint it has
 * passed. Slots run 0..items.length, one more than the item count, since the
 * pointer can sit past the last item.
 * @param {number} pointerY - Pointer y in the list's own coordinate space (client y minus the list's top, plus its scrollTop).
 * @param {Array<{offsetTop: number, offsetHeight: number}>} items - The list's item elements, in document order.
 * @returns {number} The slot index.
 * @details Reads the static layout (offsetTop/offsetHeight), which ignores the
 * drag preview's translateY transforms.
 */
export function dropSlotIndex(pointerY, items) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (pointerY < item.offsetTop + item.offsetHeight / 2) return i;
  }
  return items.length;
}

/**
 * Converts a drop slot into the destination index movedOps() takes: removing the
 * dragged op first shifts every later index down by one.
 * @param {number} slot - A dropSlotIndex() value.
 * @param {number} fromIndex - Index the dragged op currently occupies.
 * @returns {number} The destination index in post-removal coordinates; equals fromIndex when the drop is a no-op.
 */
export function dropTargetIndex(slot, fromIndex) {
  return fromIndex < slot ? slot - 1 : slot;
}

/**
 * How far an item shifts in the drag preview, in whole item slots: the items
 * between the dragged op and the drop slot move to open the gap.
 * @param {number} fromIndex - Index the dragged op currently occupies.
 * @param {number} slot - A dropSlotIndex() value.
 * @param {number} index - Index of the item being positioned.
 * @returns {number} -1 (up one slot), 1 (down one slot), or 0 (unmoved, including the dragged item itself).
 */
export function reorderPreviewShift(fromIndex, slot, index) {
  if (index === fromIndex) return 0;
  if (fromIndex < slot) return index > fromIndex && index < slot ? -1 : 0;
  return index >= slot && index < fromIndex ? 1 : 0;
}

/**
 * Returns a copy of an op chain with the op at `from` moved to index `to`.
 * @param {Array<Object>} ops - The op chain.
 * @param {number} from - Index of the op to move.
 * @param {number} to - Destination index, in post-removal coordinates.
 * @returns {Array<Object>} A deep copy of the chain in the new order.
 */
export function movedOps(ops, from, to) {
  const next = structuredClone(ops);
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  return next;
}
