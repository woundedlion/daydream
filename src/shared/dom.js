/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * @template {HTMLElement} T
 * @param {string} id - Required element id.
 * @param {new () => T} kind - Expected DOM element constructor.
 * @param {Document} [doc] - Owning document.
 * @returns {T} The checked element.
 */
export function byId(id, kind, doc = document) {
  const element = doc.getElementById(id);
  if (!(element instanceof kind)) throw new TypeError(`Expected ${kind.name} at #${id}`);
  return element;
}
