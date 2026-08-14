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
 * size sorts numerically, with equal sizes broken by name (A->Z). Direction 'asc'
 * is ascending, anything else descending.
 * @param {Array<{name: string, size: number}>} items - Items to order.
 * @param {'name'|'size'} key - Sort key.
 * @param {'asc'|'desc'} dir - Sort direction.
 * @returns {Array<{name: string, size: number}>} A new, sorted array.
 */
export function sortItems(items, key, dir) {
  const mul = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    if (key === 'size') {
      const d = a.size - b.size;
      return d ? d * mul : a.name.localeCompare(b.name, 'en');
    }
    return a.name.localeCompare(b.name, 'en') * mul;
  });
}

/**
 * Balance a column-flow list without exceeding its usual row cap.
 * @param {number} itemCount - Number of options in the list.
 * @param {number} [maxRows] - Maximum options in one column.
 * @returns {number} Number of rows for the balanced grid.
 */
export function balancedColumnRows(itemCount, maxRows = 8) {
  const count = Math.max(0, Math.trunc(itemCount) || 0);
  const rowCap = Math.max(1, Math.trunc(maxRows) || 1);
  if (count === 0) return 1;
  const columnCount = Math.ceil(count / rowCap);
  return Math.ceil(count / columnCount);
}

/**
 * Compute the focus target index for an arrow/Home/End keypress, wrapping at the
 * ends. Down/Up step one option; Right/Left step one `stride` — the number of
 * options laid out along the vertical axis, so a horizontal arrow crosses to the
 * neighbouring column of a column-flow grid and stays on the same row. Down and
 * Right wrap past the end (Right into the first column of its row), Up and Left
 * wrap before the start; Home jumps to the first option and End to the last.
 * Returns -1 for any key that does not move focus, and -1 for an empty list.
 * @param {number} idx - Current focused index (-1 if focus is not on an option).
 * @param {number} len - Number of options.
 * @param {string} key - KeyboardEvent.key value.
 * @param {number} [stride] - Options per column; 1 for a single-column list.
 * @returns {number} The target index, or -1 if the key does not navigate.
 */
export function navTargetIndex(idx, len, key, stride = 1) {
  if (len <= 0) return -1;
  if (key === 'ArrowDown') return idx < len - 1 ? idx + 1 : 0;
  if (key === 'ArrowUp') return idx > 0 ? idx - 1 : len - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return len - 1;
  const step = Math.max(1, Math.trunc(stride) || 1);
  if (key === 'ArrowRight') {
    if (idx < 0) return 0;
    return idx + step < len ? idx + step : idx % step;
  }
  if (key === 'ArrowLeft') {
    if (idx < 0) return len - 1;
    if (idx >= step) return idx - step;
    let last = idx;
    while (last + step < len) last += step;
    return last;
  }
  return -1;
}

/**
 * Resolve which effect should be active for a resolution's offered list. The
 * requested effect (from app state, including a `?effect=` deep link) is kept
 * when the resolution offers it; otherwise it falls back to the list's first
 * entry. The fallback is what stops an off-list request — a different-resolution
 * effect or a stale/garbage deep link — from leaving the canvas black.
 * @param {Array<string>} availableEffects - Effects offered at this resolution.
 * @param {string} currentEffect - The requested/active effect name.
 * @returns {string} The effect to activate: currentEffect if offered, else the
 *   first available effect (undefined only when the list is empty).
 */
export function resolveActiveEffect(availableEffects, currentEffect) {
  return availableEffects.includes(currentEffect)
    ? currentEffect
    : availableEffects[0];
}

/**
 * Decide which horizontal scroll arrows should be visible. When the content
 * fits (no overflow) neither arrow shows; otherwise the left arrow shows once
 * scrolled past a deadzone from the start, and the right arrow shows until within
 * the deadzone of the end. The deadzone is 4px but never more than half the
 * scroll range, so a small overflow (0 < maxScroll ≤ 8) still surfaces an arrow;
 * it is clamped at zero so a sub-pixel overflow (maxScroll < 1) does not invert
 * it and show the left arrow while pinned to the start.
 * @param {number} scrollLeft - Current horizontal scroll offset.
 * @param {number} scrollWidth - Total scrollable content width.
 * @param {number} clientWidth - Visible viewport width.
 * @returns {{left: boolean, right: boolean}} Visibility of the left and right arrows.
 */
export function scrollArrowState(scrollLeft, scrollWidth, clientWidth) {
  const maxScroll = scrollWidth - clientWidth;
  if (maxScroll <= 0) return { left: false, right: false };
  const deadzone = Math.max(0, Math.min(4, (maxScroll - 1) / 2));
  return {
    left: scrollLeft > deadzone,
    right: scrollLeft < maxScroll - deadzone,
  };
}
