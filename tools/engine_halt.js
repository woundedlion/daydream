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

/** The sentence a halted engine earns, shared by every tool page. */
const HALT_NOTICE = 'The WASM engine hit an internal invariant and is halted — '
  + 'reload the page.';

/**
 * Reports whether an error halted the engine and, if so, stands the page down.
 *
 * The page keeps ownership of its own module handles: standDown drops them and
 * raises the banner, so nothing calls the halted instance again.
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
