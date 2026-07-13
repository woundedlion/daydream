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
import { PROTOCOL_VERSION } from "./worker_protocol.js";

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
post({ type: 'booted', version: PROTOCOL_VERSION });

let wasmModule = null;
let engine = null;
let segId = 0;
let totalSegs = 1;
let canvasW = 0;
let canvasH = 0;
let segRange = null; // { x0, x1, y0, y1, w, h }
let arenaMetricsWarned = false;

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

      // A version mismatch means a stale-cached worker or controller: fault before
      // touching WASM so the controller stops instead of drifting on reshaped fields.
      if (msg.version !== PROTOCOL_VERSION) {
        post({ type: 'initFailed', segId,
               reason: `protocol version ${msg.version} != worker ${PROTOCOL_VERSION}`
                       + ` (stale cached worker or controller)` });
        break;
      }

      wasmModule = await createHolosphereModule();
      engine = new wasmModule.HolosphereEngine();
      // A rejected resolution leaves no usable geometry: skip the canvasW/canvasH
      // commit, segRange, and ready (symmetric with the setResolution handler's
      // `=== false` guard), and post initFailed so the controller faults at once
      // instead of waiting out the full init watchdog.
      if (engine.setResolution(msg.w, msg.h) === false) {
        post({ type: 'initFailed', segId,
               reason: `setResolution(${msg.w}, ${msg.h}) rejected` });
        break;
      }
      canvasW = msg.w;
      canvasH = msg.h;
      segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);

      if (msg.effectName) {
        if (engine.setEffect(msg.effectName) === false) {
          post({ type: 'initFailed', segId,
                 reason: `setEffect(${msg.effectName}) rejected` });
          break;
        }
      }
      // Tuned params must follow setEffect, which rebuilds with defaults.
      if (msg.params) {
        for (const p of msg.params) engine.setParameter(p.name, p.value);
      }
      if (typeof msg.paused === 'boolean') engine.setAnimationsPaused(msg.paused);
      applyClip();

      post({ type: 'ready', segId });
      break;
    }

    case 'setEffect': {
      if (engine) {
        if (engine.setEffect(msg.name) === false) {
          post({ type: 'initFailed', segId,
                 reason: `setEffect(${msg.name}) rejected` });
          break;
        }
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
        if (engine.setResolution(msg.w, msg.h) === false) {
          post({ type: 'initFailed', segId,
                 reason: `setResolution(${msg.w}, ${msg.h}) rejected` });
          break;
        }
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
      // extractSegment's row subarrays clamp rather than throw, so a short source
      // would silently zero-fill the tail; fault on a stride/length mismatch.
      const expectedLen = canvasW * canvasH * 3;
      if (allPixels.length !== expectedLen) {
        throw new Error(
          `segment_worker: pixel buffer length ${allPixels.length} != ` +
          `${expectedLen} (canvasW=${canvasW}, canvasH=${canvasH})`);
      }
      if (x0 < 0 || y0 < 0 || x1 > canvasW || y1 > canvasH) {
        throw new Error(
          `segment_worker: segment rect [${x0},${y0})-[${x1},${y1}) out of ` +
          `bounds for the ${canvasW}x${canvasH} canvas`);
      }
      const pixelsCopy = new Uint16Array(qw * qh * 3);
      extractSegment(allPixels, pixelsCopy, canvasW, segRange);

      /** @type {SegArenaMetrics | null} */
      let arenaMetrics = null;
      try {
        arenaMetrics = engine.getArenaMetrics();
        // Convert to a plain object (embind vals can't be transferred). The
        // engine's `stack` metric is intentionally omitted: the segmented stats
        // view shows only the three arenas. SegArenaMetrics is the authority for
        // the shape carried across the worker boundary.
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
        if (!arenaMetricsWarned) {
          console.warn('segment_worker: getArenaMetrics failed:', e);
          arenaMetricsWarned = true;
        }
        arenaMetrics = null;
      }

      post({
        type: 'frame',
        segId,
        x0, x1, y0, y1,
        pixels: pixelsCopy,
        elapsed,
        renderUs,
        arenaMetrics,
        paramValues,
      }, [pixelsCopy.buffer]);
      break;
    }

    default:
      // Fail fast on protocol drift: a state-changing message dropped here would
      // leave the worker rendering stale under the current generation, invisible
      // to the fence. Throwing reaches onerror -> the controller faults.
      throw new Error(`segment_worker: unknown message type ${
        (/** @type {{type?: unknown}} */ (msg)).type}`);
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
