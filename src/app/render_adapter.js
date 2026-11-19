/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** The per-frame adapter between the driver's render loop and the engine or worker pool. */

import { repointDisplayAliases } from '../engine/display_aliases.js';

/** @typedef {import('../engine/display_aliases.js').DisplayDriver} DisplayDriver */
/** @typedef {import('../engine/display_aliases.js').AliasGuard} AliasGuard */
/** @typedef {import('../../generated/holosphere_wasm.js').ArenaMetrics} ArenaMetrics */

/**
 * The engine host surface a frame renders through.
 * @typedef {{engine: {drawFrame: () => void, getArenaMetrics: () => ArenaMetrics},
 *   refresh: () => boolean, view: () => Uint16Array|null}} RenderHost
 */

/**
 * The worker-pool surface a frame composites through.
 * @typedef {{ownsDisplay: boolean, active: boolean, faulted: boolean,
 *   hasPublishedFrame: () => boolean, consumeCapture: () => boolean,
 *   tick: () => void, updateStats: () => void}} RenderSegments
 */

/**
 * The adapter the driver calls each frame.
 * @typedef {{drawFrame: () => void, sync: (advanced: boolean) => void,
 *   getArenaMetrics: () => ArenaMetrics|null, captureReady: (advanced?: boolean) => boolean,
 *   refreshPixelView: () => void, retainsDisplay: () => boolean}} RenderAdapter
 */

/**
 * Build the per-frame adapter the driver's render loop calls.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {RenderHost} deps.host - The EngineHost owning the main engine and its view.
 * @param {DisplayDriver} deps.driver - The Daydream driver.
 * @param {RenderSegments} deps.segments - The SegmentController.
 * @param {(advanced: boolean) => void} deps.syncEffectGui - Mirrors engine params
 *   into the panel, told whether the simulation stepped this frame.
 * @param {() => void} [deps.beforeFrame] - Writes preview state for this simulation frame.
 * @param {AliasGuard} deps.aliasGuard - Heals display aliases that diverge
 *   from the view after a single-engine frame.
 * @returns {RenderAdapter} The adapter.
 */
export function createRenderAdapter({
  host,
  driver,
  segments,
  syncEffectGui,
  aliasGuard,
  beforeFrame,
}) {
  return {
    /** Whether the worker pool owns the display while awaiting a published frame. */
    retainsDisplay() {
      return segments.ownsDisplay && !segments.faulted && !segments.hasPublishedFrame();
    },
    /** Refreshes the engine view and repoints the display aliases when present. */
    refreshPixelView() {
      host.refresh();
      const view = host.view();
      if (view !== null) repointDisplayAliases(driver, view);
    },
    /**
     * Per-frame entry the driver calls: render (segmented or single-engine),
     * then republish the pixel view.
     * @returns {void}
     */
    drawFrame() {
      if (segments.ownsDisplay) {
        // Composite the previous frame (overwriting driver.render()'s cleared
        // buffer) and dispatch the next.
        segments.tick();
      } else {
        // A still-spawning pool paints nothing; render here and report the spawn.
        if (segments.active) segments.updateStats();
        beforeFrame?.();
        host.engine.drawFrame();
        host.refresh();
        const view = host.view();
        if (view !== null) aliasGuard.heal(view);
      }
    },
    /**
     * Mirror engine parameters into the effect panel.
     * @param {boolean} advanced - Whether the simulation stepped this frame.
     * @returns {void}
     */
    sync(advanced) {
      syncEffectGui(advanced);
    },
    /**
     * Report the engine's current arena allocation metrics for the driver's HUD.
     * @returns {ArenaMetrics|null} The main engine's arena metrics, or null once the
     *   worker pool owns the display and the main engine is idle, where the HUD
     *   reads per-segment worker stats instead.
     */
    getArenaMetrics() {
      return segments.ownsDisplay ? null : host.engine.getArenaMetrics();
    },
    /**
     * Consume the displayed frame's capture obligation, including while idle.
     * @param {boolean} [advanced] - Whether the simulation stepped this repaint.
     * @returns {boolean} True once per newly displayed frame.
     */
    captureReady(advanced = true) {
      return segments.ownsDisplay ? segments.consumeCapture() : advanced;
    }
  };
}
