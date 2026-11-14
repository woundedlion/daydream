/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** The main WASM module load: its deadline and its discard-guarded handlers. */

import { raceDeadline } from '../shared/deadline.js';

/**
 * The app teardown surface a module load consults.
 * @typedef {{dispose: Function, disposed: () => boolean}} DisposableApp
 */

/**
 * Fulfillment and rejection handlers for the module promise.
 * @template T
 * @typedef {{onModuleReady: (module: T) => void, onModuleFailed: (err: *) => void}} ModuleLoadHandlers
 */

// Main-thread WASM fetch, instantiation and runtime-init deadline.
export const MODULE_LOAD_DEADLINE_MS = 90000;

/**
 * Race a module load against a deadline. The timer is cleared once the race
 * settles; a losing load's later rejection is handled.
 *
 * @template T
 * @param {() => Promise<T>} load - Starts the module load.
 * @param {Object} [deps] - Injected collaborators.
 * @param {number} [deps.ms] - The deadline, in milliseconds.
 * @param {{setTimeout: Function, clearTimeout: Function}} [deps.timers] - Timer
 *   source.
 * @returns {Promise<T>} The loaded module, or a rejection carrying the
 *   deadline that expired or whatever load() raised, synchronous throws included.
 */
export function loadWithDeadline(load, {
  ms = MODULE_LOAD_DEADLINE_MS,
  timers = globalThis,
} = {}) {
  return raceDeadline(load, ms, timers, () => {
    throw new Error(`The rendering engine did not load within ${Math.round(ms / 1000)} seconds.`);
  });
}

/**
 * Build the handlers for the main WASM module promise, guarded against a page
 * discard that settles first.
 *
 * Startup is skipped once the app is disposed. A load failure disposes the app.
 *
 * @template T
 * @param {Object} deps - Injected app collaborators.
 * @param {() => ?DisposableApp} deps.teardown - Reads the app teardown, or null
 *   if none is set.
 * @param {(module: T) => void} deps.start - Brings the app up on the
 *   loaded module.
 * @param {(err: *) => void} deps.reportFailure - Renders the load-failure UI.
 * @returns {ModuleLoadHandlers<T>} The fulfillment and rejection handlers.
 */
export function createModuleLoadHandlers({
  teardown,
  start,
  reportFailure,
}) {
  const disposed = () => teardown()?.disposed() === true;
  return {
    onModuleReady(module) {
      if (disposed()) return;
      start(module);
    },
    onModuleFailed(err) {
      if (disposed()) return;
      try {
        reportFailure(err);
      } finally {
        teardown()?.dispose();
      }
    },
  };
}
