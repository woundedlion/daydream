/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Segment Worker — runs in a Web Worker to render one Y-band of the canvas.
 * Each worker loads its own WASM module instance (isolated memory space),
 * ensuring separate global arenas and effect state.
 */

import createHolosphereModule from "./holosphere_wasm.js";

let wasmModule = null;
let engine = null;
let segId = 0;
let totalSegs = 1;
let canvasW = 0;
let canvasH = 0;
let segRange = null; // { x0, x1, y0, y1, w, h }

/** Mirrors the 2-arm quadrant layout from pov_segmented.h */
function computeSegmentRange(id, total, w, h) {
  const NUM_ARMS = 2;
  // The layout is symmetric across the 2 arms, so the segment count is always a
  // positive even number (it mirrors pov_segmented.h's per-arm split — there can
  // never be an odd number of segments). An odd total would make armId exceed
  // NUM_ARMS and index x0 past the canvas, silently rendering a degenerate band.
  // That's a configuration bug with no valid rendering, so fail fast.
  if (!Number.isInteger(total) || total < NUM_ARMS || total % NUM_ARMS !== 0) {
    throw new Error(
      `segment_worker: totalSegs must be a positive even number (got ${total})`);
  }
  // Guard the resolution carried across the postMessage boundary (init /
  // setResolution / setSegment all funnel through here). A non-integer or
  // non-positive dimension would produce a degenerate segRange and feed garbage
  // into setClip; fail fast instead.
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
    throw new Error(
      `segment_worker: canvas dimensions must be positive integers (got ${w}x${h})`);
  }
  const ySegsPerArm = Math.floor(total / NUM_ARMS);
  const armId = Math.floor(id / ySegsPerArm);
  const ySegId = id % ySegsPerArm;

  const armW = Math.floor(w / NUM_ARMS);
  const x0 = armId * armW;
  const x1 = (armId === NUM_ARMS - 1) ? w : x0 + armW;

  const segH = Math.floor(h / ySegsPerArm);
  const y0 = ySegId * segH;
  const y1 = (ySegId === ySegsPerArm - 1) ? h : y0 + segH;

  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

/** Apply stored clip to the engine. Must be called after every setEffect. */
function applyClip() {
  if (engine && segRange) {
    engine.setClip(segRange.y0, segRange.y1, segRange.x0, segRange.x1);
  }
}

self.onmessage = async (e) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      segId = msg.segId;
      totalSegs = msg.totalSegs;
      canvasW = msg.w;
      canvasH = msg.h;
      segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);

      // Load WASM module (each worker gets its own isolated instance)
      wasmModule = await createHolosphereModule();
      engine = new wasmModule.HolosphereEngine();
      engine.setResolution(canvasW, canvasH);

      if (msg.effectName) {
        engine.setEffect(msg.effectName);
      }
      // Apply the main engine's current tuned param values (sent at init) so
      // this segment matches instead of rendering effect defaults. Must run
      // after setEffect, which rebuilds the effect with defaults.
      if (msg.params) {
        for (const p of msg.params) engine.setParameter(p.name, p.value);
      }
      applyClip();

      self.postMessage({ type: 'ready', segId });
      break;
    }

    case 'setEffect': {
      if (engine) {
        engine.setEffect(msg.name);
        applyClip();
      }
      self.postMessage({ type: 'effectReady', segId });
      break;
    }

    case 'setResolution': {
      if (engine) {
        canvasW = msg.w;
        canvasH = msg.h;
        segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);
        engine.setResolution(canvasW, canvasH);
        // Re-apply this segment's clip here rather than relying on a follow-up
        // setEffect message to do it. (No-op while no effect is bound —
        // setResolution clears the effect on an actual size change — but it
        // makes the handler self-contained: any path that changes resolution
        // without a trailing setEffect, or a same-size call that keeps the
        // effect, still ends with the correct clip instead of a stale one.)
        applyClip();
      }
      break;
    }

    case 'setSegment': {
      segId = msg.segId;
      totalSegs = msg.totalSegs;
      segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);
      applyClip();
      break;
    }

    case 'setParameter': {
      if (engine) {
        engine.setParameter(msg.name, msg.value);
      }
      break;
    }

    case 'render': {
      if (!engine || !segRange) break;

      const t0 = performance.now();
      engine.drawFrame();
      const elapsed = performance.now() - t0;
      const renderUs = engine.getRenderUs();

      // Extract only this quadrant's pixels from the full canvas buffer
      const allPixels = engine.getPixels();
      const { x0, x1, y0, y1, w: qw, h: qh } = segRange;
      const pixelsCopy = new Uint16Array(qw * qh * 3);
      let dst = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const src = (y * canvasW + x) * 3;
          pixelsCopy[dst++] = allPixels[src];
          pixelsCopy[dst++] = allPixels[src + 1];
          pixelsCopy[dst++] = allPixels[src + 2];
        }
      }

      // Get arena metrics
      let arenaMetrics = null;
      try {
        arenaMetrics = engine.getArenaMetrics();
        // Convert to plain object (embind vals can't be transferred)
        arenaMetrics = {
          scratch_arena_a: {
            usage: arenaMetrics.scratch_arena_a.usage,
            high_water_mark: arenaMetrics.scratch_arena_a.high_water_mark,
            capacity: arenaMetrics.scratch_arena_a.capacity,
          },
          scratch_arena_b: {
            usage: arenaMetrics.scratch_arena_b.usage,
            high_water_mark: arenaMetrics.scratch_arena_b.high_water_mark,
            capacity: arenaMetrics.scratch_arena_b.capacity,
          },
          persistent_arena: {
            usage: arenaMetrics.persistent_arena.usage,
            high_water_mark: arenaMetrics.persistent_arena.high_water_mark,
            capacity: arenaMetrics.persistent_arena.capacity,
          },
        };
      } catch (e) {
        // Surface rather than swallow: a missing/renamed binding or a shape
        // change in getArenaMetrics should be diagnosable, not invisible.
        console.warn('segment_worker: getArenaMetrics failed:', e);
        arenaMetrics = null;
      }

      self.postMessage({
        type: 'frame',
        segId,
        x0, x1, y0, y1,
        quadW: qw, quadH: qh,
        pixels: pixelsCopy,
        elapsed,
        renderUs,
        arenaMetrics,
      }, [pixelsCopy.buffer]);
      break;
    }
  }
};
