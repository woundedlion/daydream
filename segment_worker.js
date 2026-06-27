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
import { computeSegmentRange, extractSegment } from "./segment_layout.js";

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

// Sent before the WASM instantiate so the controller can fault fast on a
// missing/renamed glue file; a failed module fetch never runs this line.
post({ type: 'booted' });

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
    engine.setClip(segRange.x0, segRange.x1, segRange.y0, segRange.y1);
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

      wasmModule = await createHolosphereModule();
      engine = new wasmModule.HolosphereEngine();
      // A rejected resolution leaves no usable geometry: skip the canvasW/canvasH
      // commit, segRange, and ready so the controller's init watchdog latches the
      // fault (symmetric with the setResolution handler's `=== false` guard).
      if (engine.setResolution(msg.w, msg.h) === false) break;
      canvasW = msg.w;
      canvasH = msg.h;
      segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);

      if (msg.effectName) {
        engine.setEffect(msg.effectName);
      }
      // Tuned params must follow setEffect, which rebuilds with defaults.
      if (msg.params) {
        for (const p of msg.params) engine.setParameter(p.name, p.value);
      }
      if (msg.paused) engine.setAnimationsPaused(true);
      applyClip();

      post({ type: 'ready', segId });
      break;
    }

    case 'setEffect': {
      if (engine) {
        engine.setEffect(msg.name);
        // Tuned params must follow setEffect, which rebuilds with defaults.
        if (msg.params) {
          for (const p of msg.params) engine.setParameter(p.name, p.value);
        }
        applyClip();
      }
      break;
    }

    case 'setResolution': {
      if (engine) {
        // `=== false` (not `!`) is load-bearing: only an explicit false rejection
        // keeps the current geometry; a non-boolean return must not count as one.
        if (engine.setResolution(msg.w, msg.h) === false) break;
        canvasW = msg.w;
        canvasH = msg.h;
        segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);
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

      // elapsed: JS wall time (ms) incl. embind overhead. renderUs: engine-internal
      // render timer (µs), excluding JS<->WASM overhead.
      const t0 = performance.now();
      engine.drawFrame();
      const elapsed = performance.now() - t0;
      const renderUs = engine.getRenderUs();

      // Segment 0 mirrors its post-frame param values back so the GUI can track
      // animation-driven params; the main engine is never stepped in this mode.
      const paramValues =
        segId === 0 ? Array.from(engine.getParamValues()) : null;

      const allPixels = engine.getPixels();
      const { x0, x1, y0, y1, w: qw, h: qh } = segRange;
      const pixelsCopy = new Uint16Array(qw * qh * 3);
      extractSegment(allPixels, pixelsCopy, canvasW, segRange);

      /** @type {SegArenaMetrics | null} */
      let arenaMetrics = null;
      try {
        arenaMetrics = engine.getArenaMetrics();
        // Convert to a plain object (embind vals can't be transferred).
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
        paramValues,
      }, [pixelsCopy.buffer]);
      break;
    }
  }
}

// Serialize message handling: each message runs strictly after the previous settles
// (so 'init''s long await can't interleave). The catch rethrows on a fresh task so a
// failure reaches the global error handler instead of vanishing as an unhandled
// rejection, without wedging the chain.
let messageQueue = Promise.resolve();
self.onmessage = (e) => {
  const msg = /** @type {WorkerInboundMsg} */ (e.data);
  messageQueue = messageQueue
    .then(() => handleMessage(msg))
    .catch((err) => { setTimeout(() => { throw err; }); });
  // The DOM worker ignores this; test harnesses await it to track the real
  // settle point of the serialized queue.
  return messageQueue;
};
