// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Segment Worker — runs in a Web Worker to render one rectangular quadrant of
 * the canvas (an arm column subdivided into a Y-band; both axes are clipped —
 * see computeSegmentRange in segment_layout.js and the pov_segmented.h layout).
 * Each worker loads its own WASM module instance (isolated memory space),
 * ensuring separate global arenas and effect state.
 */

import createHolosphereModule from "./holosphere_wasm.js";
import { computeSegmentRange } from "./segment_layout.js";

/** @typedef {import('./worker_protocol.js').WorkerInboundMsg} WorkerInboundMsg */
/** @typedef {import('./worker_protocol.js').ControllerInboundMsg} ControllerInboundMsg */
/** @typedef {import('./worker_protocol.js').SegArenaMetrics} SegArenaMetrics */

/**
 * Send a protocol message back to the controller. The dedicated-worker global's
 * `postMessage(message, transfer)` overload isn't visible under the default DOM
 * lib (where `self` is typed as `Window`, whose `postMessage` takes a target
 * origin), so the call is routed through one cast; the `msg` argument is still
 * checked against the protocol union.
 * @param {ControllerInboundMsg} msg - The protocol message to send to the controller.
 * @param {Transferable[]=} transfer - Optional objects to transfer ownership of (zero-copy).
 * @returns {void}
 */
const post = /** @type {(msg: ControllerInboundMsg, transfer?: Transferable[]) => void} */ (
  self.postMessage.bind(self));

let wasmModule = null;
let engine = null;
let segId = 0;
let totalSegs = 1;
let canvasW = 0;
let canvasH = 0;
let segRange = null; // { x0, x1, y0, y1, w, h }

/**
 * Apply the stored segment clip rectangle to the engine. Must be called after
 * every setEffect, since rebuilding the effect resets the clip.
 * @returns {void}
 */
function applyClip() {
  if (engine && segRange) {
    engine.setClip(segRange.y0, segRange.y1, segRange.x0, segRange.x1);
  }
}

/**
 * Process one protocol message. Only ever invoked through the serialized
 * queue in self.onmessage below, so 'init''s long await of the WASM
 * fetch+instantiate cannot interleave with later messages: a setResolution/
 * setEffect/setParameter that arrives mid-init waits for init to finish
 * instead of running against a null engine and being silently dropped (a
 * dropped setResolution is unrecoverable — the worker keeps rendering
 * old-geometry frames tagged with the current generation, so the
 * controller's fence never catches them).
 * @param {WorkerInboundMsg} msg - The inbound protocol message to process.
 * @returns {Promise<void>} Resolves once the message has been fully handled.
 */
async function handleMessage(msg) {
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
      // Carry the host's paused state onto a freshly-spawned worker so a pool
      // re-created while paused doesn't animate under a paused GUI. A fresh
      // engine starts running, so only an active pause needs asserting.
      if (msg.paused) engine.setAnimationsPaused(true);
      applyClip();

      post({ type: 'ready', segId });
      break;
    }

    case 'setEffect': {
      if (engine) {
        engine.setEffect(msg.name);
        // setEffect rebuilds the effect with defaults; re-apply the main engine's
        // current tuned values afterward so this segment matches instead of
        // reverting to defaults. Same ordering as the init handler above.
        if (msg.params) {
          for (const p of msg.params) engine.setParameter(p.name, p.value);
        }
        applyClip();
      }
      post({ type: 'effectReady', segId });
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

    case 'setParameter': {
      if (engine) {
        engine.setParameter(msg.name, msg.value);
      }
      break;
    }

    case 'setAnimationsPaused': {
      if (engine) {
        engine.setAnimationsPaused(msg.paused);
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
      // Each quadrant row [x0,x1) is contiguous in the full canvas buffer, so
      // copy it in one TypedArray.set rather than element-by-element — qh bulk
      // copies instead of ~qw*qh*3 scalar stores.
      const rowLen = (x1 - x0) * 3;
      let dst = 0;
      for (let y = y0; y < y1; y++) {
        const src = (y * canvasW + x0) * 3;
        pixelsCopy.set(allPixels.subarray(src, src + rowLen), dst);
        dst += rowLen;
      }

      /** @type {SegArenaMetrics | null} */
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

      post({
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
}

// Serialize message handling: each message runs strictly after the previous
// one settles. The catch keeps one message's failure from wedging the chain
// (later messages still run) while rethrowing it as an uncaught error on a
// fresh task so it reaches the worker's global error handler — and thus the
// controller's worker.onerror fault latch — instead of vanishing as an
// unhandled rejection.
let messageQueue = Promise.resolve();
self.onmessage = (e) => {
  const msg = /** @type {WorkerInboundMsg} */ (e.data);
  messageQueue = messageQueue
    .then(() => handleMessage(msg))
    .catch((err) => { setTimeout(() => { throw err; }); });
};
