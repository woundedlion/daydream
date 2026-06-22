/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM-free logic for the effect sidebar, extracted from sidebar.js so the sort
 * comparator, keyboard-navigation index math, and scroll-arrow visibility rules
 * can be unit-tested without a DOM. EffectSidebar wires these into element
 * mutations; the decisions themselves live here.
 */

/**
 * Order effect items by the given key and direction, returning a new array
 * (the input is not mutated). Name sorts lexicographically via localeCompare;
 * size sorts numerically. Direction 'asc' is ascending, anything else descending.
 * @param {Array<{name: string, size: number}>} items - Items to order.
 * @param {'name'|'size'} key - Sort key.
 * @param {'asc'|'desc'} dir - Sort direction.
 * @returns {Array<{name: string, size: number}>} A new, sorted array.
 */
export function sortItems(items, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (key === 'size') return (a.size - b.size) * mul;
    return a.name.localeCompare(b.name) * mul;
  });
}

/**
 * Compute the focus target index for an arrow keypress, wrapping at the ends.
 * Down/Right advance (wrapping past the last option to the first); Up/Left
 * retreat (wrapping before the first to the last). Returns -1 for any key that
 * does not move focus, and -1 for an empty list.
 * @param {number} idx - Current focused index (-1 if focus is not on an option).
 * @param {number} len - Number of options.
 * @param {string} key - KeyboardEvent.key value.
 * @returns {number} The target index, or -1 if the key does not navigate.
 */
export function navTargetIndex(idx, len, key) {
  if (len <= 0) return -1;
  if (key === 'ArrowDown' || key === 'ArrowRight') {
    return idx < len - 1 ? idx + 1 : 0;
  }
  if (key === 'ArrowUp' || key === 'ArrowLeft') {
    return idx > 0 ? idx - 1 : len - 1;
  }
  return -1;
}

/**
 * Decide which horizontal scroll arrows should be visible. When the content
 * fits (no overflow) neither arrow shows; otherwise the left arrow shows once
 * scrolled past a 4px deadzone from the start, and the right arrow shows until
 * within 4px of the end.
 * @param {number} scrollLeft - Current horizontal scroll offset.
 * @param {number} scrollWidth - Total scrollable content width.
 * @param {number} clientWidth - Visible viewport width.
 * @returns {{left: boolean, right: boolean}} Visibility of the left and right arrows.
 */
export function scrollArrowState(scrollLeft, scrollWidth, clientWidth) {
  const maxScroll = scrollWidth - clientWidth;
  if (maxScroll <= 0) return { left: false, right: false };
  return {
    left: scrollLeft > 4,
    right: scrollLeft < maxScroll - 4,
  };
}
