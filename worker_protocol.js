/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Worker message protocol — the single source of truth for the structured-clone
 * messages exchanged between the main thread (segment_controller.js) and each
 * segment Web Worker (segment_worker.js).
 *
 * These are JSDoc `@typedef`s only — the file emits no runtime code. Both sides
 * import the relevant unions via `@typedef {import('./worker_protocol.js').X} X`
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
 * One tuned effect parameter, flattened for structured-clone transport. Booleans
 * are encoded as 1/0 so the value is always a plain number.
 * @typedef {{ name: string, value: number }} SegParam
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
 * doesn't start animating.
 * @typedef {{
 *   type: 'init', segId: number, totalSegs: number, w: number, h: number,
 *   effectName?: string, params?: SegParam[], paused?: boolean,
 * }} InitMsg
 */

/**
 * Switch the worker's effect. `params` (when present) carries the main engine's
 * current tuned values, applied AFTER engine.setEffect() — which rebuilds the
 * effect with defaults — so the segment matches instead of reverting to defaults.
 * @typedef {{ type: 'setEffect', name: string, params?: SegParam[] }} SetEffectMsg
 */

/** Resize the worker's canvas; the worker re-derives its segment clip from w/h.
 * @typedef {{ type: 'setResolution', w: number, h: number }} SetResolutionMsg */

/** Push one live tuned-parameter value to the worker's bound effect.
 * @typedef {{ type: 'setParameter', name: string, value: number }} SetParameterMsg */

/** Toggle whether the worker's effect advances its animation clock.
 * @typedef {{ type: 'setAnimationsPaused', paused: boolean }} SetAnimationsPausedMsg */

/** Request one frame; the worker replies with a FrameMsg.
 * @typedef {{ type: 'render' }} RenderMsg */

/**
 * Every message the controller sends to a worker.
 * @typedef {InitMsg | SetEffectMsg | SetResolutionMsg
 *   | SetParameterMsg | SetAnimationsPausedMsg | RenderMsg} WorkerInboundMsg
 */

// --- Worker -> Controller (received by the controller) ---------------------

/** Worker has finished bootstrapping (engine instantiated) and can accept work.
 * @typedef {{ type: 'ready', segId: number }} ReadyMsg */

/** Worker has rebuilt and re-clipped its effect after a setEffect.
 * @typedef {{ type: 'effectReady', segId: number }} EffectReadyMsg */

/** Worker module body started executing — its static imports (incl. the WASM
 * glue ./holosphere_wasm.js) all resolved. Sent before the WASM instantiate so
 * the controller can detect a missing/renamed glue file fast, ahead of the
 * slower init watchdog. Carries no segId: the controller maps it to the worker
 * via the per-worker message handler.
 * @typedef {{ type: 'booted' }} BootedMsg */

/**
 * A rendered quadrant. `pixels` is the segment's RGB16 rectangle (qw*qh*3),
 * transferred (not copied) across the boundary. `paramValues` carries segment 0's
 * post-frame parameter values (ordered to match the effect's param list) so the
 * GUI can track animation-driven changes the un-stepped main engine cannot supply;
 * null on every other segment.
 * @typedef {{
 *   type: 'frame', segId: number,
 *   x0: number, x1: number, y0: number, y1: number,
 *   quadW: number, quadH: number,
 *   pixels: Uint16Array, elapsed: number, renderUs: number,
 *   arenaMetrics: SegArenaMetrics | null,
 *   paramValues: number[] | null,
 * }} FrameMsg
 */

/**
 * Every message a worker sends back to the controller.
 * @typedef {ReadyMsg | EffectReadyMsg | FrameMsg | BootedMsg} ControllerInboundMsg
 */

export {};
