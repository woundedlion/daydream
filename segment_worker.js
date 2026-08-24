// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Segment Worker — runs in a Web Worker to render one rectangular quadrant of
 * the canvas (an arm column subdivided into a Y-band; both axes are clipped —
 * see computeSegmentRange in segment_layout.js and the pov_segmented.h layout).
 * Each worker instantiates its own WASM engine (isolated memory space), ensuring
 * separate global arenas and effect state; the compiled binary those instances
 * share arrives with `init` when the controller has one.
 */

import createHolosphereModule from "./holosphere_wasm.js";
import { computeSegmentRange, extractSegment } from "./segment_layout.js";
import { PROTOCOL_VERSION } from "./worker_protocol.js";

/** @typedef {import('./worker_protocol.js').WorkerInboundMsg} WorkerInboundMsg */
/** @typedef {import('./worker_protocol.js').ControllerInboundMsg} ControllerInboundMsg */
/** @typedef {import('./worker_protocol.js').SegArenaMetrics} SegArenaMetrics */
/** @typedef {import('./segment_layout.js').SegRange} SegRange */
/** @typedef {import('./holosphere_wasm.js').HolosphereModule} HolosphereModule */
/** @typedef {import('./holosphere_wasm.js').HolosphereEngine} HolosphereEngine */

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

/** @type {HolosphereModule | null} */
let wasmModule = null;
/** @type {HolosphereEngine | null} */
let engine = null;
let segId = 0;
let totalSegs = 1;
let canvasW = 0;
let canvasH = 0;
let paramRevision = 0;
/** @type {SegRange | null} */
let segRange = null;
// Disposition of the last applyClip: true once the engine kept the full-canvas
// clip for a needs_full_frame() effect, so every 'frame' reports what this
// worker actually shaded rather than the rectangle it sliced out.
let clipFullFrame = false;
let arenaMetricsWarned = false;
// Last `name:outcome` reported by reportParamRejected, so a held slider pushing
// the same rejection every frame logs once. Cleared on every effect install: the
// same name:outcome pair under a different effect is a distinct event.
let paramRejectedKey = '';

/**
 * Restore a complete ShaderBall snapshot after the effect has been rebuilt.
 * @param {import('./worker_protocol.js').FullConfigSnapshot|undefined} snapshot
 * @returns {boolean} True when no snapshot was supplied or it was accepted.
 */
function restoreFullConfig(snapshot) {
  if (!snapshot) return true;
  if (!engine || !wasmModule
      || typeof engine.restoreFullConfigSnapshot !== 'function'
      || !wasmModule.FullConfigRestoreResult) {
    post({ type: 'engineRejected',
           reason: 'ShaderBall full-config restore API is unavailable' });
    return false;
  }
  const result = engine.restoreFullConfigSnapshot(snapshot);
  const restoreResults = wasmModule.FullConfigRestoreResult;
  if (result === restoreResults.APPLIED) return true;
  const name = Object.entries(restoreResults)
    .find(([, value]) => value === result)?.[0]
    ?? `value ${String(result?.value ?? result)}`;
  post({ type: 'engineRejected',
         reason: `ShaderBall full-config restore rejected: ${name}` });
  return false;
}

/**
 * Apply the stored segment clip rectangle to the engine. Must be called after
 * every setEffect, since rebuilding the effect resets the clip.
 * @details setClip answers a Module.ClipSetResult enum value; compare against
 * the enum, never by truthiness (every enum value is a truthy object). Two
 * values are successes: APPLIED installs the band, and FULL_FRAME_KEPT means
 * the effect reports needs_full_frame() so the clip stays at the full canvas
 * and this worker renders the whole frame. Only INVALID_BOUNDS faults the pool:
 * NO_EFFECT is the ordinary answer when no effect is installed to receive the
 * clip, and the controller follows with a setEffect that re-applies it. The
 * APPLIED/FULL_FRAME_KEPT split is latched into clipFullFrame and reported on
 * every frame, so the two successes stay distinguishable to the pool.
 * @returns {boolean} False only when this worker is left without usable render
 * geometry, which applyClip has already reported; NO_EFFECT counts as accepted.
 */
function applyClip() {
  // wasmModule is non-null whenever engine is — the engine is built from it.
  if (!wasmModule || !engine || !segRange) return false;
  const result = engine.setClip(segRange.x0, segRange.x1, segRange.y0, segRange.y1);
  if (result === wasmModule.ClipSetResult.INVALID_BOUNDS) {
    post({
      type: 'engineRejected',
      reason: `setClip(${segRange.x0}, ${segRange.x1}, `
        + `${segRange.y0}, ${segRange.y1}) rejected`,
    });
    // The engine kept its previous clip, so the latch keeps describing it.
    return false;
  }
  clipFullFrame = result === wasmModule.ClipSetResult.FULL_FRAME_KEPT;
  return true;
}

/**
 * Report a live setParameter the engine did not apply. The controller has no
 * reply channel for one, and only segment 0 mirrors its values back on a frame,
 * so on any other segment this is the sole trace that the worker is rendering a
 * configuration the main engine never had.
 * @param {string} name - Parameter the controller pushed.
 * @param {unknown} result - The ParamSetResult the engine answered.
 * @returns {void}
 */
function reportParamRejected(name, result) {
  if (!wasmModule) return;
  const outcome = Object.entries(wasmModule.ParamSetResult)
    .find(([, value]) => value === result)?.[0]
    ?? `value ${String(/** @type {{value?: unknown}} */ (result)?.value ?? result)}`;
  const key = `${name}:${outcome}`;
  if (key === paramRejectedKey) return;
  paramRejectedKey = key;
  console.error(
    `segment_worker: segment ${segId} setParameter(${name}) rejected: ${outcome}`);
}

/**
 * Push one parameter, reporting a refusal.
 * @param {string} name - Parameter to write.
 * @param {number} value - Value to write.
 * @returns {void}
 */
function applyParam(name, value) {
  if (!engine || !wasmModule) return;
  const result = engine.setParameter(name, value);
  if (result !== wasmModule.ParamSetResult.APPLIED) {
    reportParamRejected(name, result);
  }
}

/**
 * Replay a rebuild's parameter list: accepted render state first, then pending
 * requests. setEffect rebuilds with defaults, so this must follow it. Every
 * ParamSetResult is checked as a live setParameter's is — the engine answers the
 * same structural refusals here, and one dropped leaves this segment rendering a
 * configuration the main engine never had.
 * @param {import('./worker_protocol.js').SegParam[]|undefined} params - The
 * controller's parameter snapshot.
 * @returns {void}
 */
function replayParams(params) {
  if (!params) return;
  for (const p of params) {
    if (typeof p.acceptedValue === 'number') applyParam(p.name, p.acceptedValue);
  }
  for (const p of params) {
    if (typeof p.value === 'number') applyParam(p.name, p.value);
  }
}

/**
 * Select a preset, reporting an index the engine refused. A refusal leaves this
 * segment rendering a different preset from its peers, and the controller has no
 * reply channel for one. An index the engine is already on moves nothing and is
 * not reported: the controller carries the fresh-effect index 0 for every
 * effect, and an effect with no presets refuses it.
 * @param {number} index - Preset the controller broadcast.
 * @param {'selectPreset'|'synchronizePreset'} [method] - Engine call to apply it
 * with. Mirroring an engine-driven index uses synchronizePreset, which does not
 * engage the pause selectPreset carries.
 * @returns {void}
 */
function applyPreset(index, method = 'selectPreset') {
  if (!engine || engine[method](index)) return;
  if (engine.getPresetIndex() === index) return;
  console.error(
    `segment_worker: segment ${segId} ${method}(${index}) rejected: ` +
    `${engine.getPresetCount()} presets, still on ${engine.getPresetIndex()}`);
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
      // A version mismatch means a stale-cached worker or controller: fault before
      // reading any other field, so nothing from a message shape the worker does not
      // understand is latched, and before touching WASM so the controller stops
      // instead of drifting on reshaped fields.
      if (msg.version !== PROTOCOL_VERSION) {
        post({ type: 'engineRejected',
               reason: `protocol version ${msg.version} != worker ${PROTOCOL_VERSION}`
                       + ` (stale cached worker or controller)` });
        break;
      }

      segId = msg.segId;
      totalSegs = msg.totalSegs;
      paramRevision = msg.paramRevision;

      /** @type {Parameters<typeof createHolosphereModule>[0]} */
      const options = {};
      // Every segment runs a full engine replica, so engine logs would print
      // once per worker; only segment 0 logs. printErr stays live everywhere.
      if (segId !== 0) options.print = () => {};
      const compiled = msg.wasmModule;
      if (compiled) {
        // Instantiate the controller's single compilation instead of fetching and
        // compiling the 2 MB binary again here. The binary declares its own memory
        // rather than importing one, so this instance still gets a private heap.
        options.instantiateWasm = (imports, onInstance) => {
          WebAssembly.instantiate(compiled, imports).then(
            (instance) => onInstance(instance, compiled),
            // The glue's instantiate has no rejection path, so without this the
            // await below never settles and the pool waits out its init watchdog.
            (error) => post({ type: 'engineRejected',
                              reason: `shared module instantiate failed: ${error}`,
                              sharedModule: true }));
          return {};
        };
      }
      const mod = await createHolosphereModule(options);
      wasmModule = mod;
      if (mod.HolosphereEngine.isLive()) {
        post({ type: 'engineRejected',
               reason: 'HolosphereEngine is already live' });
        break;
      }
      engine = new mod.HolosphereEngine();
      // A rejected resolution leaves no usable geometry: skip the canvasW/canvasH
      // commit, segRange, and ready (symmetric with the setResolution handler's
      // UNSUPPORTED guard), and post engineRejected so the controller faults at
      // once instead of waiting out the full init watchdog.
      if (engine.setResolution(msg.w, msg.h)
          === wasmModule.ResolutionSetResult.UNSUPPORTED) {
        post({ type: 'engineRejected',
               reason: `setResolution(${msg.w}, ${msg.h}) rejected` });
        break;
      }
      canvasW = msg.w;
      canvasH = msg.h;
      segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);

      if (msg.effectName) {
        if (engine.setEffect(msg.effectName)
            !== wasmModule.EffectSetResult.INSTALLED) {
          post({ type: 'engineRejected',
                 reason: `setEffect(${msg.effectName}) rejected` });
          break;
        }
      }
      // synchronizePreset, not selectPreset: this mirrors the engine-driven
      // index, and selectPreset would engage the pause msg.paused carries.
      if (typeof msg.presetIndex === 'number') {
        applyPreset(msg.presetIndex, 'synchronizePreset');
      }
      if (!restoreFullConfig(msg.fullConfigSnapshot)) break;
      replayParams(msg.params);
      if (typeof msg.paused === 'boolean') engine.setAnimationsPaused(msg.paused);
      if (typeof msg.poleLod === 'number') engine.setPoleLod(msg.poleLod);
      // A rejected clip leaves no usable render geometry: report nothing ready.
      if (!applyClip()) break;

      post({ type: 'ready' });
      break;
    }

    case 'setEffect': {
      if (engine && wasmModule) {
        // INSTALLED is the sole success; either rejection keeps the old effect.
        if (engine.setEffect(msg.name)
            !== wasmModule.EffectSetResult.INSTALLED) {
          post({ type: 'engineRejected',
                 reason: `setEffect(${msg.name}) rejected` });
          break;
        }
        paramRejectedKey = '';
        // Mirrors the engine-driven index without the pause, as in 'init'.
        if (typeof msg.presetIndex === 'number') {
          applyPreset(msg.presetIndex, 'synchronizePreset');
        }
        if (!restoreFullConfig(msg.fullConfigSnapshot)) break;
        replayParams(msg.params);
        if (typeof msg.paused === 'boolean') {
          engine.setAnimationsPaused(msg.paused);
        }
        paramRevision = msg.paramRevision;
        // A rejected clip leaves no usable render geometry, as in 'init'.
        if (!applyClip()) break;
      }
      break;
    }

    case 'setResolution': {
      if (engine && wasmModule) {
        // Only an explicit UNSUPPORTED keeps the current geometry: RESIZED and
        // ALREADY_ACTIVE both leave the requested size active, so both commit.
        if (engine.setResolution(msg.w, msg.h)
            === wasmModule.ResolutionSetResult.UNSUPPORTED) {
          post({ type: 'engineRejected',
                 reason: `setResolution(${msg.w}, ${msg.h}) rejected` });
          break;
        }
        canvasW = msg.w;
        canvasH = msg.h;
        segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);
      }
      break;
    }

    case 'setParameter': {
      if (engine && wasmModule) {
        applyParam(msg.name, msg.value);
        paramRevision = msg.paramRevision;
      }
      break;
    }

    case 'setAnimationsPaused': {
      if (engine) {
        engine.setAnimationsPaused(msg.paused);
      }
      break;
    }

    case 'selectPreset': {
      if (engine) {
        applyPreset(msg.index);
        paramRevision = msg.paramRevision;
      }
      break;
    }

    case 'setPoleLod': {
      if (engine) {
        engine.setPoleLod(msg.value);
      }
      break;
    }

    case 'render': {
      // Same fail-fast policy as the unknown-type default below: replying to
      // nothing leaves the controller's frame outstanding until its watchdog.
      if (!engine || !segRange) {
        throw new Error('segment_worker: render before a completed init '
          + `(engine=${engine ? 'set' : 'null'}, `
          + `segRange=${segRange ? 'set' : 'null'})`);
      }

      // elapsed: JS wall time (ms) incl. embind overhead.
      const t0 = performance.now();
      engine.drawFrame();
      const elapsed = performance.now() - t0;

      // Segment 0 mirrors its post-frame param values back; the main engine is
      // never stepped in this mode.
      const paramValues =
        segId === 0 ? Array.from(engine.getParamValues()) : null;
      const presetCount = segId === 0 ? engine.getPresetCount?.() ?? null : null;
      const presetIndex = segId === 0 ? engine.getPresetIndex?.() ?? null : null;

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
      // The controller transfers the retired generation's buffer back for reuse;
      // a missing or differently-sized one (first frame, resolution change)
      // allocates. extractSegment overwrites every element, so nothing of the
      // previous generation survives in a reused buffer.
      const segLen = qw * qh * 3;
      const pixelsCopy = (msg.recycle && msg.recycle.length === segLen)
        ? msg.recycle : new Uint16Array(segLen);
      extractSegment(allPixels, pixelsCopy, canvasW, segRange);

      /** @type {SegArenaMetrics | null} */
      let arenaMetrics;
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
        const module = /** @type {{HS_MODULE_DEAD?: boolean}|null} */ (wasmModule);
        if (module?.HS_MODULE_DEAD === true) throw e;
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
        arenaMetrics,
        paramValues,
        paramRevision,
        presetCount,
        presetIndex,
        fullFrame: clipFullFrame,
      }, [pixelsCopy.buffer]);
      break;
    }

    default: {
      // Fail fast on protocol drift: a state-changing message dropped here would
      // leave the worker rendering stale under the current generation, invisible
      // to the fence. Throwing reaches onerror -> the controller faults.
      // The `never` binding makes an unhandled WorkerInboundMsg member a
      // typecheck error rather than a runtime-only throw.
      /** @type {never} */
      const unhandled = msg;
      throw new Error(`segment_worker: unknown message type ${
        (/** @type {{type?: unknown}} */ (unhandled)).type}`);
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

self.onmessageerror = (e) => {
  console.error('segment_worker: message deserialization failed', e);
  post({ type: 'engineRejected', reason: 'message deserialization failed' });
};
