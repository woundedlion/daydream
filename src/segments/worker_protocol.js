/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Worker message protocol — the source of truth for the structured-clone
 * messages exchanged between the segment controller and each segment worker.
 *
 * Naming convention: "Inbound" is relative to the receiver — WorkerInboundMsg is
 * what the controller sends and the worker receives; ControllerInboundMsg is what
 * the worker sends back.
 */

/**
 * Protocol version stamped on `init` (controller → worker) and `booted`
 * (worker → controller); each side faults on a mismatch. Any typedef change
 * bumps PROTOCOL_VERSION.
 * @type {number}
 */
export const PROTOCOL_VERSION = 13;

// Sentinel segIds for pool-wide faults with no single worker to blame:
// FAULT_POOL for pool-creation faults, FAULT_RENDER for render-path faults.
export const FAULT_POOL = -1;
export const FAULT_RENDER = -2;

/**
 * One tuned effect parameter, flattened for structured-clone transport. Booleans
 * are encoded as 1/0 so the value is always a plain number.
 * @typedef {{ name: string, value: number, acceptedValue?: number }} SegParam
 */

/** @typedef {import('../../generated/holosphere_wasm.js').ChainSnapshot} ChainSnapshot */

/**
 * Usage snapshot of a single arena (bytes).
 * @typedef {Pick<import('../../generated/holosphere_wasm.js').ArenaUsage,
 * 'usage'|'high_water_mark'|'capacity'>} SegArenaUsage
 */

/**
 * Per-segment arena metrics, mirroring the engine's three arenas. Null when the
 * binding is unavailable.
 * @typedef {{
 *   scratch_arena_a: SegArenaUsage,
 *   scratch_arena_b: SegArenaUsage,
 *   persistent_arena: SegArenaUsage,
 * }} SegArenaMetrics
 */

// --- Controller -> Worker (received by the worker) -------------------------

/**
 * Bootstrap message: assigns the worker its segment index within the pool and the
 * canvas geometry and required effect, with optional tuned values, pause state
 * and Pole LOD. `wasmModule` is an already-compiled binary to instantiate;
 * absent it, the worker takes the glue's own load path.
 * @typedef {{
 *   type: 'init', version: number, segId: number, totalSegs: number,
 *   w: number, h: number,
 *   effectName: string, params?: SegParam[],
 *   chainSnapshot?: ChainSnapshot, paused?: boolean,
 *   presetIndex?: number|undefined,
 *   poleLod?: number, paramRevision: number,
 *   topCap?: number, bottomCap?: number,
 *   wasmModule?: WebAssembly.Module|undefined,
 * }} InitMsg
 */

/**
 * Switch the worker's effect. `params` (when present) carries the main engine's
 * tuned values, applied after engine.setEffect() rebuilds with defaults.
 * @typedef {{ type: 'setEffect', name: string, params?: SegParam[],
 *   chainSnapshot?: ChainSnapshot,
 *   paused?: boolean, presetIndex?: number|undefined,
 *   paramRevision: number }} SetEffectMsg
 */

/** Resize the worker's canvas; the worker recomputes its segment rectangle but
 * does not push it to the engine until the setEffect that must follow.
 * @typedef {{ type: 'setResolution', w: number, h: number }} SetResolutionMsg */

/** Push one live tuned-parameter value to the worker's bound effect.
 * @typedef {{ type: 'setParameter', name: string, value: number,
 *   paramRevision: number }} SetParameterMsg */

/** Toggle whether the worker's effect advances its animation clock.
 * @typedef {{ type: 'setAnimationsPaused', paused: boolean }} SetAnimationsPausedMsg */

/** Select one effect preset by index.
 * @typedef {{ type: 'selectPreset', index: number,
 *   paramRevision: number }} SelectPresetMsg */

/** Set near-pole azimuthal shading decimation on the worker's engine (a
 * per-module-instance global).
 * @typedef {{ type: 'setPoleLod', value: number }} SetPoleLodMsg */

/** Set missing arc percentages on the worker's engine.
 * @typedef {{ type: 'setDisplayCaps', topCap: number, bottomCap: number }} SetDisplayCapsMsg */

/** Request one frame; the worker replies with a FrameMsg. `recycle` transfers
 * the retired generation's segment buffer for the worker to refill; the worker
 * allocates when it is absent or sized for a different rect.
 * @typedef {{ type: 'render', recycle?: Uint16Array }} RenderMsg */

/**
 * Every message the controller sends to a worker.
 * @typedef {InitMsg | SetEffectMsg | SetResolutionMsg
 *   | SetParameterMsg | SetAnimationsPausedMsg | SelectPresetMsg | SetPoleLodMsg
 *   | SetDisplayCapsMsg | RenderMsg} WorkerInboundMsg
 */

// --- Worker -> Controller (received by the controller) ---------------------

/** Worker has finished bootstrapping (engine instantiated) and can accept work.
 * Carries no segId; the per-worker message handler identifies the sender.
 * @typedef {{ type: 'ready' }} ReadyMsg */

/** Fatal worker refusal: protocol or message validation, module instantiation,
 * engine setup/configuration, or rendering without a usable effect. Carries no
 * segId. `sharedModule` marks the controller's shared compilation as the one
 * that failed to instantiate.
 * @typedef {{ type: 'engineRejected', reason: string,
 *   sharedModule?: boolean }} EngineRejectedMsg */

/** Worker module body started executing — its static imports (incl. the WASM
 * glue) all resolved; sent before the WASM instantiate. Carries no segId, and
 * the protocol version.
 * @typedef {{ type: 'booted', version: number }} BootedMsg */

/**
 * A rendered segment. `pixels` is the segment's RGB16 rectangle ((x1-x0)*(y1-y0)*3),
 * transferred (not copied) across the boundary. The rectangle is the worker's
 * `computeSegmentRange(segId, totalSegs, w, h)`.
 *
 * `paramValues` carries segment 0's post-frame parameter values (ordered to match
 * the effect's param list); null on every other segment.
 *
 * `warnings` carries the standing parameter and preset refusals on this worker,
 * re-sent every frame and omitted while there are none.
 *
 * @typedef {{
 *   type: 'frame', segId: number,
 *   x0: number, x1: number, y0: number, y1: number,
 *   pixels: Uint16Array, elapsed: number,
 *   arenaMetrics: SegArenaMetrics | null,
 *   paramValues: number[] | null,
 *   paramRevision: number, presetCount: number | null,
 *   presetIndex: number | null,
 *   warnings?: string[]|undefined,
 * }} FrameMsg
 */

/**
 * Every message a worker sends back to the controller.
 * @typedef {ReadyMsg | EngineRejectedMsg | FrameMsg | BootedMsg} ControllerInboundMsg
 */
