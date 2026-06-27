/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { refreshPixelView as computePixelView } from "./pixel_view.js";

/**
 * Owns the main-thread WASM engine and its reassignable display state. The pixel
 * view detaches on heap growth, so consumers read it through view()/refresh()
 * rather than caching it; engine, adapter, and recorder are late-bound at WASM load.
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

  /** Drop the cached view so the next refresh() re-fetches it (used after a resize). */
  invalidateView() {
    this.pixelView = null;
  }

  /**
   * Re-fetch the WASM pixel view when missing or detached (heap growth can detach
   * the underlying ArrayBuffer, leaving a zero-length view), and notify the caller
   * so it can re-point its display aliases at the fresh view.
   * @returns {void}
   */
  refresh() {
    const { view, refreshed } = computePixelView(
      this.pixelView, () => this.engine.getPixels());
    if (refreshed) {
      this.pixelView = view;
      this.onViewRefreshed(view);
    }
  }
}
