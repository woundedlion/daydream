/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @param {Element} widget @param {string} id @param {boolean} [present] */
export function describeBy(widget, id, present = true) {
  const ids = (widget.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  const next = present ? [...ids, id] : ids.filter((value) => value !== id);
  if (next.length) widget.setAttribute('aria-describedby', next.join(' '));
  else widget.removeAttribute('aria-describedby');
}
