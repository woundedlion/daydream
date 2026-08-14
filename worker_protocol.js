/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Worker message protocol — the single source of truth for the structured-clone
 * messages exchanged between the main thread (segment_controller.js) and each
 * segment Web Worker (segment_worker.js).
 *
 * Apart from the shared `PROTOCOL_VERSION` constant this file is JSDoc `@typedef`s
 * only. Both sides import the relevant unions via `@typedef {import('./worker_protocol.js').X} X`
 * and run under `// @ts-check`, so a renamed field or a message shape that drifts
 * between sender and receiver is flagged in-editor instead of failing silently at
 * runtime (a malformed `postMessage` is otherwise only caught when a handler
 * reads `undefined`).
 *
 * Naming convention: "Inbound" is relative to the receiver — WorkerInboundMsg is
 * what the controller sends and the worker receives; ControllerInboundMsg is what
 * the worker sends back.
 */

/**
 * Protocol version stamped on `init` (controller → worker) and `booted`
 * (worker → controller). Each side faults on a mismatch, so a stale-cached worker
 * or glue against updated peer code fails fast instead of drifting on a
 * same-named but reshaped message. Bump on any breaking change to the messages below.
 * @type {number}
 */
export const PROTOCOL_VERSION = 9;

/**
 * One tuned effect parameter, flattened for structured-clone transport. Booleans
 * are encoded as 1/0 so the value is always a plain number.
 * @typedef {{ name: string, value?: number, acceptedValue?: number }} SegParam
 */

/**
 * Versioned ShaderBall state. Field-array indices are defined by the engine's
 * exhaustive stable field-ID table, never by the current presentation schema.
 * Accepted/requested entries are uint32 payload words and must not pass through
 * floating-point reinterpretation during persistence or transport.
 * @typedef {{
 *   schemaVersion: number,
 *   accepted: number[],
 *   requested: number[],
 *   pendingFieldIds: number[],
 *   hasRuntime: boolean,
 *   runtime: number[],
 * }} FullConfigSnapshot
 */

/**
 * Usage snapshot of a single arena (bytes).
 * @typedef {{ usage: number, high_water_mark: number, capacity: number }} ArenaUsage
 */

/**
 * Per-segment arena metrics, mirroring the engine's three arenas. Null when the
 * binding is unavailable.
 * @typedef {{
 *   scratch_arena_a: ArenaUsage,
 *   scratch_arena_b: ArenaUsage,
 *   persistent_arena: ArenaUsage,
 * }} SegArenaMetrics
 */

// --- Controller -> Worker (received by the worker) -------------------------

/**
 * Bootstrap message: assigns the worker its segment index within the pool and the
 * canvas geometry, then optionally selects an effect with tuned values. `paused`
 * carries the host's current pause state so a pool re-created under a paused GUI
 * doesn't start animating; `poleLod` does the same for the Pole LOD slider, whose
 * value lives per module instance and so must be re-pushed to every fresh engine.
 *
 * `wasmModule` is the binary the controller already compiled, for the worker to
 * instantiate instead of fetching and compiling its own copy. Optional in both
 * directions — absent it, the worker takes the glue's own load path — so it is
 * not a version-breaking field.
 * @typedef {{
 *   type: 'init', version: number, segId: number, totalSegs: number,
 *   w: number, h: number,
 *   effectName?: string, params?: SegParam[],
 *   fullConfigSnapshot?: FullConfigSnapshot, paused?: boolean,
 *   presetIndex?: number|undefined,
 *   poleLod?: number, paramRevision: number,
 *   wasmModule?: WebAssembly.Module|undefined,
 * }} InitMsg
 */

/**
 * Switch the worker's effect. `params` (when present) carries the main engine's
 * current tuned values, applied AFTER engine.setEffect() — which rebuilds the
 * effect with defaults — so the segment matches instead of reverting to defaults.
 * @typedef {{ type: 'setEffect', name: string, params?: SegParam[],
 *   fullConfigSnapshot?: FullConfigSnapshot,
 *   paused?: boolean, presetIndex?: number|undefined,
 *   paramRevision: number }} SetEffectMsg
 */

/** Resize the worker's canvas; the worker recomputes its segment rectangle from
 * w/h but does not push it to the engine: a size change tears the effect down,
 * and the engine rejects a clip with no effect. The controller follows with a
 * setEffect, which rebuilds the effect and applies the new clip.
 * @typedef {{ type: 'setResolution', w: number, h: number }} SetResolutionMsg */

/** Push one live tuned-parameter value to the worker's bound effect.
 * @typedef {{ type: 'setParameter', name: string, value: number,
 *   paramRevision: number }} SetParameterMsg */

/** Toggle whether the worker's effect advances its animation clock.
 * @typedef {{ type: 'setAnimationsPaused', paused: boolean }} SetAnimationsPausedMsg */

/** Select one effect preset by index.
 * @typedef {{ type: 'selectPreset', index: number,
 *   paramRevision: number }} SelectPresetMsg */

/** Set near-pole azimuthal shading decimation on the worker's engine. The
 * aggressiveness is a per-module-instance global, so each worker carries its own
 * copy and the slider must reach all of them or the composited preview decimates
 * differently from the single-engine one.
 * @typedef {{ type: 'setPoleLod', value: number }} SetPoleLodMsg */

/** Request one frame; the worker replies with a FrameMsg. `recycle` hands back
 * the retired generation's segment buffer (transferred, so the controller gives
 * up ownership) for the worker to refill in place instead of allocating and
 * detaching a fresh one every frame. The worker allocates when it is absent or
 * sized for a different rect, so a resolution change needs no coordination.
 * @typedef {{ type: 'render', recycle?: Uint16Array }} RenderMsg */

/**
 * Every message the controller sends to a worker.
 * @typedef {InitMsg | SetEffectMsg | SetResolutionMsg
 *   | SetParameterMsg | SetAnimationsPausedMsg | SelectPresetMsg | SetPoleLodMsg
 *   | RenderMsg} WorkerInboundMsg
 */

// --- Worker -> Controller (received by the controller) ---------------------

/** Worker has finished bootstrapping (engine instantiated) and can accept work.
 * Carries no segId: the controller maps it to the worker via the per-worker
 * message handler.
 * @typedef {{ type: 'ready' }} ReadyMsg */

/** Worker's engine rejected a resolution or effect — at init or on a later
 * setResolution/setEffect; no usable geometry. Lets the controller fault
 * immediately instead of rendering stale-geometry frames or waiting out the
 * init watchdog. Carries no segId, for the same reason as 'ready'.
 *
 * `sharedModule` marks the rejection as the controller's own compilation
 * failing to instantiate, so the controller drops it and the next pool compiles
 * per worker instead of being handed the same refused module forever. Optional
 * in both directions, so it is not a version-breaking field.
 * @typedef {{ type: 'engineRejected', reason: string,
 *   sharedModule?: boolean }} EngineRejectedMsg */

/** Worker module body started executing — its static imports (incl. the WASM
 * glue ./holosphere_wasm.js) all resolved. Sent before the WASM instantiate so
 * the controller can detect a missing/renamed glue file fast, ahead of the
 * slower init watchdog. Carries no segId: the controller maps it to the worker
 * via the per-worker message handler. Carries the protocol version so the
 * controller faults a stale-cached worker before init.
 * @typedef {{ type: 'booted', version: number }} BootedMsg */

/**
 * A rendered quadrant. `pixels` is the segment's RGB16 rectangle ((x1-x0)*(y1-y0)*3),
 * transferred (not copied) across the boundary. The rectangle is the worker's
 * `computeSegmentRange(segId, totalSegs, w, h)`; the controller re-derives it and
 * faults on a mismatch rather than trusting it, so a worker rendering stale
 * geometry cannot composite into another segment's rows.
 *
 * `paramValues` carries segment 0's post-frame parameter values (ordered to match
 * the effect's param list) so the GUI can track rendered changes the
 * un-stepped main engine cannot supply; null on every other segment.
 *
 * `fullFrame` is the disposition of the worker's last setClip: false when the
 * band was installed (`APPLIED`) and the engine shaded only the rectangle, true
 * when the effect reports `needs_full_frame()` (`FULL_FRAME_KEPT`) and the
 * engine shaded the whole canvas for the rectangle to be sliced out of. Carrying
 * it is what lets the pool tell an N-way parallel speedup from N workers each
 * computing the same full frame; `elapsed` alone cannot.
 * @typedef {{
 *   type: 'frame', segId: number,
 *   x0: number, x1: number, y0: number, y1: number,
 *   pixels: Uint16Array, elapsed: number,
 *   arenaMetrics: SegArenaMetrics | null,
 *   paramValues: number[] | null,
 *   paramRevision: number, presetCount: number | null,
 *   presetIndex: number | null,
 *   fullFrame: boolean,
 * }} FrameMsg
 */

/**
 * Every message a worker sends back to the controller.
 * @typedef {ReadyMsg | EngineRejectedMsg | FrameMsg | BootedMsg} ControllerInboundMsg
 */
