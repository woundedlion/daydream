/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM-free logic for the zero-copy WASM pixel view, extracted so the
 * staleness/re-fetch contract can be unit-tested without a browser, a WASM
 * module, or Three.js. Both the driver (which clears the buffer) and
 * engine_host.js (which re-fetches it) route their "is this view still
 * usable?" decision through here so the buffer-alias contract lives in exactly
 * one tested place.
 */

/**
 * Whether a pixel view still aliases live WASM memory.
 *
 * Emscripten grows the heap by detaching the old ArrayBuffer in place: its
 * byteLength drops to 0 while the typed-array view stays truthy. Presence alone
 * is therefore not enough — a detached view is still an object, and calling
 * fill()/read on it throws or reads nothing — so the backing buffer must also be
 * non-detached.
 * @param {ArrayBufferView|null|undefined} view - The pixel view to test.
 * @returns {view is ArrayBufferView} True when view is a typed array whose
 *   buffer is not detached.
 */
export function isViewLive(view) {
  return ArrayBuffer.isView(view) && view.buffer.byteLength !== 0;
}

/**
 * Decide whether the pixel view must be re-fetched, returning the view to use.
 *
 * A view is stale when it is missing, detached, or no longer the engine's buffer
 * length: the engine pre-sizes its pixel buffer, so a resolution change re-spans
 * it without reallocating and a view taken at the old resolution stays attached
 * while covering the wrong number of instances. A view of the expected length is
 * returned unchanged; anything else is re-fetched via getPixels(). The caller
 * re-points its display aliases at the returned view only when `refreshed` is
 * true, so a steady-state frame does no work.
 * @param {Uint16Array|null} view - The currently held pixel view.
 * @param {() => Uint16Array} getPixels - Fetches a fresh zero-copy view from the engine.
 * @param {number} [expectedLength] - The engine's current buffer length. Omitted
 *   on a module without the accessor, which leaves detachment the only trigger.
 * @returns {{view: Uint16Array, refreshed: boolean}} The view to use and whether it was re-fetched.
 */
export function refreshPixelView(view, getPixels, expectedLength) {
  const stale = !isViewLive(view)
    || (typeof expectedLength === 'number' && view.length !== expectedLength);
  if (stale) return { view: getPixels(), refreshed: true };
  return { view, refreshed: false };
}
