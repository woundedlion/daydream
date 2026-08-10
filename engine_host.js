/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { refreshPixelView as computePixelView } from "./pixel_view.js";

/**
 * Owns the main-thread WASM engine and its reassignable display state. The pixel
 * view goes stale on heap growth and on a resolution change, so consumers read it
 * through view()/refresh() rather than caching it; engine, adapter, and recorder
 * are late-bound at WASM load.
 */
export class EngineHost {
  /**
   * @param {(view: Uint16Array) => void} [onViewRefreshed] - Invoked with the new
   *   view whenever refresh() re-fetches one, so the caller can re-point its
   *   display aliases (kept out of this module so it stays DOM/Three-free).
   */
  constructor(onViewRefreshed = () => {}) {
    this.module = null;
    this.engine = null;
    this.adapter = null;
    this.recorder = null;
    this.pixelView = null;
    this.onViewRefreshed = onViewRefreshed;
  }

  /** Current Uint16Array display view; null until the first refresh() or after a resize. */
  view() {
    return this.pixelView;
  }

  /**
   * Identity of the effect the engine currently has loaded, bumped on every
   * setEffect. A parameter-definition snapshot and a value-stream read reporting
   * the same generation describe the same effect.
   * @returns {number|undefined} The engine's generation counter; undefined
   *   before the WASM load, after dispose(), or when the loaded module does not
   *   expose one, which pins every read to the same value and leaves the length
   *   guard as the only pairing check.
   */
  paramGeneration() {
    return this.engine?.getParamGeneration?.();
  }

  /** Drop the cached view so the next refresh() re-fetches it (used after a resize). */
  invalidateView() {
    this.pixelView = null;
  }

  /**
   * Re-fetch the WASM pixel view when it is missing, detached (heap growth can
   * detach the underlying ArrayBuffer, leaving a zero-length view), or sized for
   * a resolution the engine no longer renders, and notify the caller so it can
   * re-point its display aliases at the fresh view. A no-op before the WASM load
   * and after dispose(), when there is no engine to fetch from.
   * @returns {void}
   */
  refresh() {
    if (!this.engine) return;
    const { view, refreshed } = computePixelView(
      this.pixelView, () => this.engine.getPixels(),
      this.engine.getBufferLength?.());
    if (refreshed) {
      this.pixelView = view;
      this.onViewRefreshed(view);
    }
  }

  /**
   * Release the recorder, render adapter, engine handle, and cached view,
   * leaving the host inert. Idempotent, and the one release path for both a page
   * discard and a startup the discard raced. A recording in progress is ended
   * but not flushed: its onstop download is async and cannot complete under a
   * synchronous page discard.
   * @returns {void}
   */
  dispose() {
    this.recorder?.dispose();
    this.recorder = null;
    // Before the delete: the frame loop reaches the engine only through the
    // adapter, so a frame that outlives the teardown must find nothing to call.
    this.adapter = null;
    this.engine?.delete();
    this.engine = null;
    this.pixelView = null;
  }
}
