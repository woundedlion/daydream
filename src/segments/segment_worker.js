// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Segment Worker — renders one rectangular segment of the canvas (see
 * computeSegmentRange) in its own WASM engine instance, optionally from a
 * compiled module shared via `init`.
 */

import { enumConstantName, replayParameterWrites } from '../effects/param_sync.js';
import { callWorkbenchBinding } from '../engine/workbench_bindings.js';
import createHolosphereModule from "../../generated/holosphere_wasm.js";
import { computeSegmentRange, extractSegment } from "./segment_layout.js";
import { PROTOCOL_VERSION } from "./worker_protocol.js";
import { engineHalted } from "../shared/engine_halt.js";

/** @typedef {import('./worker_protocol.js').WorkerInboundMsg} WorkerInboundMsg */
/** @typedef {import('./worker_protocol.js').ControllerInboundMsg} ControllerInboundMsg */
/** @typedef {import('./worker_protocol.js').SegArenaMetrics} SegArenaMetrics */
/** @typedef {import('./segment_layout.js').SegRange} SegRange */
/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereModule} HolosphereModule */
/** @typedef {import('../../generated/holosphere_wasm.js').HolosphereEngine} HolosphereEngine */

/**
 * Send a protocol message back to the controller. Cast because the DOM lib
 * types `self` as `Window`; `msg` is still checked against the protocol union.
 * @param {ControllerInboundMsg} msg - The protocol message to send to the controller.
 * @param {Transferable[]=} transfer - Optional objects to transfer ownership of (zero-copy).
 * @returns {void}
 */
const post = /** @type {(msg: ControllerInboundMsg, transfer?: Transferable[]) => void} */ (
  self.postMessage.bind(self));

/** Installs an isolated worker protocol session. @returns {void} */
export function installSegmentWorker() {
  // Sent before the WASM instantiate; a failed module fetch never runs this line.
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
  // clip for a needs_full_frame() || persists_pixels() effect.
  let clipFullFrame = false;
  // Log-once latch for getArenaMetrics failures; reset per effect install and
  // geometry change.
  let arenaMetricsWarned = false;
  // Last `name:outcome` reported by reportParamRejected (log once); reset per
  // effect install.
  let paramRejectedKey = '';
  // Refused parameters or presets standing on this worker, sent whole with every
  // 'frame'; reset per effect install.
  /** @type {Map<string, string>} */
  let divergenceWarnings = new Map();
  // Latched by a RESIZED setResolution, which tears the effect and its clip
  // down; a render before the next setEffect faults.
  let awaitingEffect = false;
  let engineDead = false;

  /**
   * Restore a complete shader-workbench snapshot after the effect has been rebuilt.
   * @param {import('./worker_protocol.js').ChainSnapshot|undefined} snapshot
   * @returns {boolean} True when no snapshot was supplied or it was accepted.
   */
  function restoreChainSnapshot(snapshot) {
    if (!snapshot) return true;
    if (!engine || !wasmModule
        || typeof engine.getShaderChainBindings !== 'function'
        || !wasmModule.ChainSnapshotRestoreResult) {
      post({ type: 'engineRejected',
             reason: 'Shader chain snapshot restore API is unavailable' });
      return false;
    }
    const result = callWorkbenchBinding(engine, 'getShaderChainBindings', 'restoreSnapshot', [snapshot], wasmModule.ChainSnapshotRestoreResult.NOT_SHADER_CHAIN);
    const restoreResults = wasmModule.ChainSnapshotRestoreResult;
    if (result === restoreResults.APPLIED) return true;
    const name = enumConstantName(restoreResults, result);
    post({ type: 'engineRejected',
           reason: `Shader chain snapshot restore rejected: ${name}` });
    return false;
  }

  /**
   * Apply the stored segment clip rectangle to the engine. Must be called after
   * every setEffect, since rebuilding the effect resets the clip.
   * @details setClip answers a Module.ClipSetResult enum object (always truthy).
   * FULL_FRAME_KEPT means the effect reports needs_full_frame() ||
   * persists_pixels(), so this worker renders the whole frame; NO_EFFECT latches
   * awaitingEffect.
   * @returns {boolean} False when this worker is left without usable render
   * geometry; an INVALID_BOUNDS clip is reported first. NO_EFFECT counts as
   * accepted.
   */
  function applyClip() {
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
    if (result === wasmModule.ClipSetResult.NO_EFFECT) {
      awaitingEffect = true;
      return true;
    }
    clipFullFrame = result === wasmModule.ClipSetResult.FULL_FRAME_KEPT;
    return true;
  }

  /**
   * Report a setParameter the engine did not apply.
   * @param {string} name - Parameter the controller pushed.
   * @param {unknown} result - The ParamSetResult the engine answered.
   * @returns {void}
   */
  function reportParamRejected(name, result) {
    if (!wasmModule) return;
    const outcome = enumConstantName(wasmModule.ParamSetResult, result);
    const key = `${name}:${outcome}`;
    const detail = `setParameter(${name}) rejected: ${outcome}`;
    divergenceWarnings.set(`param:${name}`, detail);
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
    } else {
      divergenceWarnings.delete(`param:${name}`);
      if (paramRejectedKey.startsWith(`${name}:`)) paramRejectedKey = '';
    }
  }

  /**
   * Replay a rebuild's parameter list: accepted render state first, then pending
   * requests, reporting each refusal. setEffect rebuilds with defaults, so this
   * must follow it.
   * @param {import('./worker_protocol.js').SegParam[]|undefined} params - The
   * controller's parameter snapshot.
   * @returns {void}
   */
  function replayParams(params) {
    if (!params || !engine || !wasmModule) return;
    const writer = engine.setParameter.bind(engine);
    for (const field of /** @type {const} */ (['acceptedValue', 'value'])) {
      const writes = params.flatMap((p) => typeof p[field] === 'number'
        ? [{ name: p.name, value: p[field] }] : []);
      for (const { name, result } of replayParameterWrites(writes, writer, wasmModule.ParamSetResult)) {
        reportParamRejected(name, result);
      }
    }
  }

  /**
   * Select a preset, reporting an index the engine refused. An index the engine
   * is already on is not reported.
   * @param {number} index - Preset the controller broadcast.
   * @param {'selectPreset'|'synchronizePreset'} [method] - Engine call to apply it
   * with; synchronizePreset does not engage the pause selectPreset carries.
   * @returns {void}
   */
  function applyPreset(index, method = 'selectPreset') {
    if (!engine) return;
    if ((method === 'synchronizePreset' && engine.getPresetIndex() === index)
        || engine[method](index) || engine.getPresetIndex() === index) {
      divergenceWarnings.delete('preset');
      return;
    }
    const detail = `${method}(${index}) rejected: ${engine.getPresetCount()} `
      + `presets, still on ${engine.getPresetIndex()}`;
    divergenceWarnings.set('preset', detail);
    console.error(`segment_worker: segment ${segId} ${detail}`);
  }

  /** @param {string} type - State-changing message received without an engine. */
  function rejectBeforeInit(type) {
    post({ type: 'engineRejected', reason: `${type} before a completed init` });
  }

  /**
   * Process one protocol message. Must run through the serialized queue, so a
   * message arriving mid-init waits for init's WASM instantiate to finish.
   * @param {WorkerInboundMsg} msg - The inbound protocol message to process.
   * @returns {Promise<void>} Resolves once the message has been fully handled.
   */
  async function handleMessage(msg) {
    if (engineDead) return;
    switch (msg.type) {
      case 'init': {
        // Version check precedes reading any other field or touching WASM.
        if (msg.version !== PROTOCOL_VERSION) {
          post({ type: 'engineRejected',
                 reason: `protocol version ${msg.version} != worker ${PROTOCOL_VERSION}`
                         + ` (stale cached worker or controller)` });
          break;
        }

        if (typeof msg.effectName !== 'string' || !msg.effectName.trim()) {
          post({ type: 'engineRejected', reason: 'init requires an effect name' });
          break;
        }

        paramRejectedKey = '';
        divergenceWarnings = new Map();
        segId = msg.segId;
        totalSegs = msg.totalSegs;
        paramRevision = msg.paramRevision;

        /** @type {Parameters<typeof createHolosphereModule>[0]} */
        const options = {};
        // Only segment 0 prints engine logs; printErr stays live everywhere.
        if (segId !== 0) options.print = () => {};
        const compiled = msg.wasmModule;
        let failInstantiation = () => {};
        /** @type {Promise<null>} */
        const instantiationFailed = new Promise((resolve) => {
          failInstantiation = () => resolve(null);
        });
        if (compiled) {
          // Each instance of the shared compilation owns a private heap.
          options.instantiateWasm = (imports, onInstance) => {
            WebAssembly.instantiate(compiled, imports).then(
              (instance) => onInstance(instance, compiled),
              // The glue's instantiate has no rejection path; settle the race here.
              (error) => {
                post({ type: 'engineRejected',
                       reason: `shared module instantiate failed: ${error}`,
                       sharedModule: true });
                failInstantiation();
              });
            return {};
          };
        }
        const mod = await Promise.race([createHolosphereModule(options), instantiationFailed]);
        if (!mod) break;
        wasmModule = mod;
        if (mod.HolosphereEngine.isLive()) {
          post({ type: 'engineRejected',
                 reason: 'HolosphereEngine is already live' });
          break;
        }
        engine = new mod.HolosphereEngine();
        if (!engine.setDisplayCaps(msg.topCap ?? 0, msg.bottomCap ?? 0)) {
          post({ type: 'engineRejected', reason: 'setDisplayCaps rejected' });
          break;
        }
        // The latch tracks the live engine; a fresh one starts unlatched.
        awaitingEffect = false;
        // A rejected resolution leaves no usable geometry.
        if (engine.setResolution(msg.w, msg.h)
            === wasmModule.ResolutionSetResult.UNSUPPORTED) {
          post({ type: 'engineRejected',
                 reason: `setResolution(${msg.w}, ${msg.h}) rejected` });
          break;
        }
        canvasW = msg.w;
        canvasH = msg.h;
        segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);

        if (engine.setEffect(msg.effectName)
            !== wasmModule.EffectSetResult.INSTALLED) {
          post({ type: 'engineRejected',
                 reason: `setEffect(${msg.effectName}) rejected` });
          break;
        }
        // Mirrors the engine-driven index without engaging the pause.
        if (typeof msg.presetIndex === 'number') {
          applyPreset(msg.presetIndex, 'synchronizePreset');
        }
        if (!restoreChainSnapshot(msg.chainSnapshot)) break;
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
          divergenceWarnings = new Map();
          arenaMetricsWarned = false;
          awaitingEffect = false;
          // Mirrors the engine-driven index without the pause, as in 'init'.
          if (typeof msg.presetIndex === 'number') {
            applyPreset(msg.presetIndex, 'synchronizePreset');
          }
          if (!restoreChainSnapshot(msg.chainSnapshot)) break;
          replayParams(msg.params);
          if (typeof msg.paused === 'boolean') {
            engine.setAnimationsPaused(msg.paused);
          }
          paramRevision = msg.paramRevision;
          // A rejected clip leaves no usable render geometry, as in 'init'.
          if (!applyClip()) break;
        } else {
          rejectBeforeInit(msg.type);
        }
        break;
      }

      case 'setResolution': {
        if (engine && wasmModule) {
          // RESIZED and ALREADY_ACTIVE both commit; RESIZED also dropped the
          // effect and the clip.
          const resolutionResult = engine.setResolution(msg.w, msg.h);
          if (resolutionResult === wasmModule.ResolutionSetResult.UNSUPPORTED) {
            post({ type: 'engineRejected',
                   reason: `setResolution(${msg.w}, ${msg.h}) rejected` });
            break;
          }
          if (resolutionResult === wasmModule.ResolutionSetResult.RESIZED) {
            awaitingEffect = true;
          }
          canvasW = msg.w;
          canvasH = msg.h;
          arenaMetricsWarned = false;
          segRange = computeSegmentRange(segId, totalSegs, canvasW, canvasH);
        } else {
          rejectBeforeInit(msg.type);
        }
        break;
      }

      case 'setParameter': {
        if (engine && wasmModule) {
          applyParam(msg.name, msg.value);
          paramRevision = msg.paramRevision;
        } else {
          rejectBeforeInit(msg.type);
        }
        break;
      }

      case 'setAnimationsPaused': {
        if (engine && wasmModule) {
          engine.setAnimationsPaused(msg.paused);
        } else {
          rejectBeforeInit(msg.type);
        }
        break;
      }

      case 'selectPreset': {
        if (engine && wasmModule) {
          applyPreset(msg.index);
          paramRevision = msg.paramRevision;
        } else {
          rejectBeforeInit(msg.type);
        }
        break;
      }

      case 'setDisplayCaps': {
        if (engine && wasmModule) {
          if (!engine.setDisplayCaps(msg.topCap, msg.bottomCap)) {
            post({ type: 'engineRejected', reason: 'setDisplayCaps rejected' });
            break;
          }
          arenaMetricsWarned = false;
          applyClip();
        } else {
          rejectBeforeInit(msg.type);
        }
        break;
      }

      case 'setPoleLod': {
        if (engine && wasmModule) {
          engine.setPoleLod(msg.value);
        } else {
          rejectBeforeInit(msg.type);
        }
        break;
      }

      case 'render': {
        // Fail fast: no reply would leave the frame outstanding until the watchdog.
        if (!engine || !segRange) {
          throw new Error('segment_worker: render before a completed init '
            + `(engine=${engine ? 'set' : 'null'}, `
            + `segRange=${segRange ? 'set' : 'null'})`);
        }
        // A missing setEffect is the controller's sequencing fault; report it.
        if (awaitingEffect) {
          post({
            type: 'engineRejected',
            reason: `render at ${canvasW}x${canvasH} with no effect: the resize `
              + 'tore the effect and clip down and no setEffect followed',
          });
          break;
        }

        // elapsed: JS wall time (ms) incl. embind overhead.
        const t0 = performance.now();
        engine.drawFrame();
        const elapsed = performance.now() - t0;

        // Segment 0 mirrors its post-frame param values back.
        const paramValues =
          segId === 0 ? Array.from(engine.getParamValues()) : null;
        const presetCount = segId === 0 ? engine.getPresetCount() : null;
        const presetIndex = segId === 0 ? engine.getPresetIndex() : null;

        const allPixels = engine.getPixels();
        const { x0, x1, y0, y1, w: qw, h: qh } = segRange;
        // A short source leaves the destination tail unchanged, including recycled pixels.
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
        // Reuse a recycled buffer of the right size; extractSegment overwrites
        // every element.
        const segLen = qw * qh * 3;
        const pixelsCopy = (msg.recycle && msg.recycle.length === segLen)
          ? msg.recycle : new Uint16Array(segLen);
        extractSegment(allPixels, pixelsCopy, canvasW, segRange);

        /** @type {SegArenaMetrics | null} */
        let arenaMetrics;
        try {
          arenaMetrics = engine.getArenaMetrics();
          // Convert to a plain SegArenaMetrics (embind vals can't be transferred).
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
          if (engineHalted(e, wasmModule)) throw e;
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
          warnings: divergenceWarnings.size > 0 ? [...divergenceWarnings.values()] : undefined,
        }, [pixelsCopy.buffer]);
        break;
      }

      default: {
        // Fail fast on protocol drift; `never` makes an unhandled
        // WorkerInboundMsg member a typecheck error.
        /** @type {never} */
        const unhandled = msg;
        throw new Error(`segment_worker: unknown message type ${
          (/** @type {{type?: unknown}} */ (unhandled)).type}`);
      }
    }
  }

  // Serialize message handling. The catch rethrows on a fresh task so a failure
  // reaches the global error handler without wedging the chain.
  let messageQueue = Promise.resolve();
  self.onmessage = (e) => {
    const msg = /** @type {WorkerInboundMsg} */ (e.data);
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      post({ type: 'engineRejected', reason: 'invalid worker message envelope' });
      return Promise.resolve();
    }
    messageQueue = messageQueue
      .then(() => handleMessage(msg))
      .catch((err) => {
        if (engineHalted(err, wasmModule)) engineDead = true;
        setTimeout(() => { throw err; });
      });
    // Ignored by the DOM; awaitable as the queue's settle point.

    return messageQueue;
  };

  self.onmessageerror = (e) => {
    console.error('segment_worker: message deserialization failed', e);
    post({ type: 'engineRejected', reason: 'message deserialization failed' });
  };
}

installSegmentWorker();
