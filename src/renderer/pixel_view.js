/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** DOM-free staleness and re-fetch logic for the zero-copy WASM pixel view. */

/**
 * Whether a pixel view has a nonempty backing buffer.
 *
 * Emscripten heap growth detaches the old ArrayBuffer (byteLength 0) while the
 * typed-array view stays truthy.
 * @param {ArrayBufferView|null|undefined} view - The pixel view to test.
 * @returns {view is ArrayBufferView} True for an ArrayBufferView with a nonempty
 *   backing buffer; this does not verify WASM ownership.
 */
export function isViewLive(view) {
  return ArrayBuffer.isView(view) && view.buffer.byteLength !== 0;
}

/**
 * Decide whether the pixel view must be re-fetched, returning the view to use.
 *
 * A view is stale when it is missing, detached, or not the engine's buffer
 * length: a resolution change re-spans the pre-sized buffer without
 * reallocating, so an old view stays attached at the wrong length.
 * @param {Uint16Array|null} view - The currently held pixel view.
 * @param {() => Uint16Array} getPixels - Fetches a fresh zero-copy view from the engine.
 * @param {number} expectedLength - The engine's current buffer length.
 * @returns {{view: Uint16Array, refreshed: boolean}} The view to use and whether it was re-fetched.
 */
export function refreshPixelView(view, getPixels, expectedLength) {
  const stale = !isViewLive(view) || view.length !== expectedLength;
  if (stale) return { view: getPixels(), refreshed: true };
  return { view, refreshed: false };
}
