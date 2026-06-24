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
import { computeSegmentRange, blitSegmentRect } from "./segment_layout.js";

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

// Proof-of-life: reaching this statement means every static import above (incl.
// the ./holosphere_wasm.js glue) resolved. Sent before the WASM instantiate so the
// controller can fault fast on a missing/renamed glue file; a failed module fetch
// never runs this line, so 'booted' simply never arrives.
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
      canvasW = msg.w;
      canvasH = msg.h;
      segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);

      // Each worker gets its own isolated WASM instance.
      wasmModule = await createHolosphereModule();
      engine = new wasmModule.HolosphereEngine();
      engine.setResolution(canvasW, canvasH);

      if (msg.effectName) {
        engine.setEffect(msg.effectName);
      }
      // Apply tuned param values after setEffect (which rebuilds with defaults) so
      // this segment matches instead of rendering effect defaults.
      if (msg.params) {
        for (const p of msg.params) engine.setParameter(p.name, p.value);
      }
      // A fresh engine starts running, so only carry an active pause.
      if (msg.paused) engine.setAnimationsPaused(true);
      applyClip();

      post({ type: 'ready', segId });
      break;
    }

    case 'setEffect': {
      if (engine) {
        engine.setEffect(msg.name);
        // setEffect rebuilds with defaults; re-apply tuned values afterward so this
        // segment matches. Same ordering as the init handler.
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
        // On a size the engine can't build, setResolution returns false and stays
        // at its current geometry; leave canvasW/H/segRange/clip untouched.
        // `=== false` (not `!`) is load-bearing: a non-boolean return (e.g.
        // undefined) must NOT be treated as rejection, so keep this binding
        // returning a strict boolean.
        if (engine.setResolution(msg.w, msg.h) === false) break;
        canvasW = msg.w;
        canvasH = msg.h;
        segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);
        // Re-apply the clip here so the handler is self-contained — any path that
        // changes resolution without a trailing setEffect still ends correctly
        // clipped rather than stale.
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

      // Two timings, overlapping but different spans:
      //   elapsed  — JS wall time (ms) around drawFrame(): C++ render PLUS embind
      //              boundary-crossing overhead (what the JS frame loop pays).
      //   renderUs — the engine's internal render timer (µs): C++ render proper,
      //              excluding JS<->WASM overhead (isolates engine cost).
      // So elapsed >= renderUs/1000; the gap is the marshaling cost.
      const t0 = performance.now();
      engine.drawFrame();
      const elapsed = performance.now() - t0;
      const renderUs = engine.getRenderUs();

      const allPixels = engine.getPixels();
      const { x0, x1, y0, y1, w: qw, h: qh } = segRange;
      const pixelsCopy = new Uint16Array(qw * qh * 3);
      // Extract this quadrant (canvas -> compact).
      blitSegmentRect(allPixels, pixelsCopy, canvasW, segRange, true);

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
        // Surface rather than swallow so a binding/shape change stays diagnosable.
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

// Serialize message handling: each message runs strictly after the previous one
// settles (so 'init''s long await can't interleave). The catch keeps one failure
// from wedging the chain, and rethrows on a fresh task so it reaches the global
// error handler (and the controller's onerror fault latch) instead of vanishing as
// an unhandled rejection.
let messageQueue = Promise.resolve();
self.onmessage = (e) => {
  const msg = /** @type {WorkerInboundMsg} */ (e.data);
  messageQueue = messageQueue
    .then(() => handleMessage(msg))
    .catch((err) => { setTimeout(() => { throw err; }); });
};
