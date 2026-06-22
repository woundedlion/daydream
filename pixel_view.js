/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM-free logic for the zero-copy WASM pixel view, extracted so the
 * detach/re-fetch contract can be unit-tested without a browser, a WASM module,
 * or Three.js. Both the driver (which clears the buffer) and daydream.js (which
 * re-fetches it) route their "is this view still live?" decision through here so
 * the buffer-alias contract lives in exactly one tested place.
 */

/**
 * Whether a pixel view still aliases live WASM memory.
 *
 * Emscripten grows the heap by detaching the old ArrayBuffer in place: its
 * byteLength drops to 0 while the typed-array view stays truthy. Presence alone
 * is therefore not enough — a detached view is still an object, and calling
 * fill()/read on it throws or reads nothing — so the backing buffer must also be
 * non-detached.
 * @param {{buffer: ArrayBuffer}|null|undefined} view - The pixel view to test.
 * @returns {boolean} True when the view exists and its buffer is not detached.
 */
export function isViewLive(view) {
  return !!view && view.buffer.byteLength !== 0;
}

/**
 * Decide whether the pixel view must be re-fetched, returning the view to use.
 *
 * A non-detached view is never stale (it aliases current memory), so it is
 * returned unchanged; a missing or detached view is re-fetched via getPixels().
 * The caller re-points its display aliases at the returned view only when
 * `refreshed` is true, so a steady-state frame does no work.
 * @param {Uint16Array|null} view - The currently held pixel view.
 * @param {() => Uint16Array} getPixels - Fetches a fresh zero-copy view from the engine.
 * @returns {{view: Uint16Array, refreshed: boolean}} The view to use and whether it was re-fetched.
 */
export function refreshPixelView(view, getPixels) {
  if (!isViewLive(view)) return { view: getPixels(), refreshed: true };
  return { view, refreshed: false };
}
