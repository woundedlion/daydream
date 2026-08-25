/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The single predicate the tool pages ask before calling a WASM engine instance
 * again, shared so the pages and the solids chain validator cannot drift apart
 * on what counts as a halted module.
 */

/**
 * Whether an engine instance is halted and must never be called again.
 *
 * HS_CHECK sets Module.HS_MODULE_DEAD ahead of its __builtin_trap()
 * (core/platform/platform.h), and the trap unwinds nothing: the shadow stack
 * pointer keeps whatever the aborted frame left it at, so every later call runs
 * on a shortened stack and returns plausible garbage. The RuntimeError reaches
 * only the caller that was on the stack when the trap fired; the flag is what
 * says so to a caller whose own throw came from somewhere else.
 * @param {*} error - The error a bridge call threw, if any.
 * @param {?{HS_MODULE_DEAD?: boolean}} [module] - The instance the call ran on.
 * @returns {boolean} True when the instance is unrecoverable.
 */
export function engineHalted(error, module = null) {
  return error instanceof WebAssembly.RuntimeError
    || module?.HS_MODULE_DEAD === true;
}
