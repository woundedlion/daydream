/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Halted-engine predicate for WASM engine instances.
 */

/**
 * Whether an engine instance is halted and must never be called again.
 *
 * HS_CHECK sets Module.HS_MODULE_DEAD ahead of its __builtin_trap(), and the
 * trap unwinds nothing, so later calls can misbehave without trapping. The
 * RuntimeError reaches only the caller on the stack at the trap; the flag
 * covers every other caller.
 * @param {*} error - The error a bridge call threw, if any.
 * @param {?{HS_MODULE_DEAD?: boolean}} [module] - The instance the call ran on.
 * @returns {boolean} True when the instance is unrecoverable.
 */
export function engineHalted(error, module = null) {
  return (typeof globalThis.WebAssembly?.RuntimeError === 'function'
    && error instanceof globalThis.WebAssembly.RuntimeError)
    || module?.HS_MODULE_DEAD === true;
}

/** Banner sentence for a halted engine. */
const HALT_NOTICE = 'The WASM engine hit an internal invariant and is halted — '
  + 'reload the page.';

/**
 * Reports whether an error halted the engine and, if so, stands the page down.

 * @param {*} error - The error a bridge call threw, if any.
 * @param {?{HS_MODULE_DEAD?: boolean}} module - The instance the call ran on.
 * @param {(message: string) => void} standDown - Drops the page's handles and shows the fatal banner.
 * @param {string} [detail] - A page-specific sentence appended to the banner text.
 * @returns {boolean} True when the error was an engine halt.
 */
export function standDownIfHalted(error, module, standDown, detail = '') {
  if (!engineHalted(error, module)) return false;
  standDown(detail ? `${HALT_NOTICE} ${detail}` : HALT_NOTICE);
  return true;
}
