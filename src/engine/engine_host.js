/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { engineHalted } from '../shared/engine_halt.js';

import { refreshPixelView as computePixelView } from "../renderer/pixel_view.js";

/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereEngine} HolosphereEngine */
/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereModule} HolosphereModule */

/**
 * Owns the main-thread WASM engine and its reassignable display state. The pixel
 * view goes stale on heap growth and on a resolution change, so consumers read it
 * through view()/refresh() rather than caching it; engine, adapter, and recorder
 * are late-bound at WASM load.
 */
export class EngineHost {
  /**
   * @param {(view: Uint16Array) => void} [onViewRefreshed] - Invoked with the new
   *   view whenever refresh() re-fetches one.
   */
  constructor(onViewRefreshed = () => {}) {
    /** @type {HolosphereModule|null} */
    this.module = null;
    /** @type {HolosphereEngine|null} */
    this.engine = null;
    /** @type {ReturnType<typeof import('../app/app_lifecycle.js').createRenderAdapter>|null} */
    this.adapter = null;
    /** @type {import('../recording/recorder.js').VideoRecorder|null} */
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
   * before trapping and the trap unwinds nothing, so the state is terminal and
   * latches here, surviving dispose().
   * @param {*} [error] - Error from an engine call.
   * @returns {boolean} Whether the module has trapped.
   */
  moduleDead(error = undefined) {
    if (this.dead) return true;
    this.dead = engineHalted(error, this.module);
    return this.dead;
  }

  /**
   * Identity of the effect and parameter schema, bumped on every effect
   * replacement or descriptor-schema change. A parameter-definition snapshot and a value-stream read reporting
   * the same generation describe the same effect.
   * @returns {number|undefined} The engine's generation counter; undefined
   *   before the WASM load or after dispose().
   */
  paramGeneration() {
    return this.engine?.getParamGeneration();
  }

  /** Drop the cached view so the next refresh() re-fetches it. */
  invalidateView() {
    this.pixelView = null;
  }

  /**
   * Re-fetch the WASM pixel view when it is missing, detached, or sized for a
   * resolution the engine no longer renders, and notify onViewRefreshed. A no-op
   * without an engine.
   * @returns {boolean} Whether a fresh view was fetched; its buffer holds what
   *   the engine last wrote.
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
   * callback, and module reference, leaving the host inert. Idempotent. A
   * recording in progress is finalized and saved by onstop on a live page; a
   * synchronous page discard cannot complete that callback. A collaborator that
   * throws is reported and the remaining references are still dropped.
   * @returns {void}
   */
  dispose() {
    try { this.recorder?.dispose(); }
    catch (error) { console.error('EngineHost: releasing the recorder failed:', error); }
    this.recorder = null;
    // Before the delete: a frame that outlives the teardown must find no adapter.
    this.adapter = null;
    if (!this.moduleDead()) {
      try { this.engine?.delete(); }
      catch (error) { console.error('EngineHost: deleting the engine failed:', error); }
    }
    this.engine = null;
    this.pixelView = null;
    this.onViewRefreshed = () => {};
    this.module = null;
  }
}
