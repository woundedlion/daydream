/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { refreshPixelView as computePixelView } from "./pixel_view.js";

/** @typedef {import('./holosphere_wasm.js').HolosphereEngine} HolosphereEngine */
/** @typedef {import('./holosphere_wasm.js').HolosphereModule} HolosphereModule */

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
    /** @type {HolosphereModule|null} */
    this.module = null;
    /** @type {HolosphereEngine|null} */
    this.engine = null;
    /** @type {Object|null} */
    this.adapter = null;
    /** @type {{dispose: () => void}|null} */
    this.recorder = null;
    this.pixelView = null;
    this.onViewRefreshed = onViewRefreshed;
    /** @type {boolean} Latched once the module reports itself trapped. */
    this.dead = false;
  }

  /** Current Uint16Array display view; null until the first refresh() or after a resize. */
  view() {
    return this.pixelView;
  }

  /**
   * Whether the WASM module has trapped. HS_CHECK sets Module.HS_MODULE_DEAD
   * before its __builtin_trap(), and the trap unwinds nothing: the shadow stack
   * pointer keeps whatever the aborted frame left it at, so every later call
   * runs on a permanently shortened stack and hands back plausible results
   * while writing past its end. No call recovers, so the state is terminal and
   * latches here: a read after dispose() has dropped the module reference still
   * reports dead. A plain property read, cheap enough for a per-frame caller.
   * @returns {boolean} Whether the module has trapped.
   */
  moduleDead() {
    if (this.dead) return true;
    this.dead = this.module?.HS_MODULE_DEAD === true;
    return this.dead;
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
   * @returns {boolean} Whether a fresh view was fetched. A caller that writes
   *   into the view has to know: the buffer behind a fresh one carries whatever
   *   the engine last left there, not what the previous view's holder did to it.
   */
  refresh() {
    const engine = this.engine;
    if (!engine) return false;
    const { view, refreshed } = computePixelView(
      this.pixelView, () => engine.getPixels(),
      engine.getBufferLength?.());
    if (refreshed) {
      this.pixelView = view;
      this.onViewRefreshed(view);
    }
    return refreshed;
  }

  /**
   * Release the recorder, render adapter, engine handle, cached view, view
   * callback, and module reference, leaving the host inert. Idempotent, and the
   * one release path for both a page discard and a startup the discard raced. A recording in progress
   * is ended but not flushed: its onstop download is async and cannot complete
   * under a synchronous page discard. A collaborator that throws is reported and
   * the remaining references are dropped anyway: the host runs inside a teardown
   * that will not revisit it, so a stranded release is a leak with no retry.
   * @returns {void}
   */
  dispose() {
    try { this.recorder?.dispose(); }
    catch (error) { console.error('EngineHost: releasing the recorder failed:', error); }
    this.recorder = null;
    // Before the delete: the frame loop reaches the engine only through the
    // adapter, so a frame that outlives the teardown must find nothing to call.
    this.adapter = null;
    if (!this.moduleDead()) {
      try { this.engine?.delete(); }
      catch (error) { console.error('EngineHost: deleting the engine failed:', error); }
    }
    this.engine = null;
    this.pixelView = null;
    // The callback closes over the Three.js driver and its display aliases, so
    // it retains as much as the module reference below.
    this.onViewRefreshed = () => {};
    // The module owns the Emscripten heap, so a held reference keeps the whole
    // WebAssembly.Memory alive behind a host that can no longer render.
    this.module = null;
  }
}
