/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM-free logic for the per-frame "fight-the-slider" parameter poll, extracted
 * so the diffing decision can be unit-tested without lil-gui, a WASM module, or
 * a browser. syncGUI() in daydream.js routes each controller through here so the
 * "should this slider adopt the engine's latest value?" rule lives in exactly
 * one tested place.
 */

/**
 * Decide whether a single GUI controller should adopt the engine's latest value
 * for its parameter, and what value to write.
 *
 * The engine streams animation-driven parameter values back every frame; the
 * GUI should track them, but must never clobber a controller the user is
 * actively editing (a focused input or an in-progress drag), and should avoid a
 * redundant write when the value is unchanged.
 *
 * @param {number|boolean} current - The controller's current value
 *   (c.getValue()); a boolean for a toggle, a number for a slider.
 * @param {number} incoming - The engine's raw numeric value for this parameter.
 * @param {boolean} isBoolean - Whether the controller is a boolean toggle (the
 *   engine streams bools as 0/1 floats, thresholded at 0.5).
 * @param {boolean} isEditing - Whether the user is actively editing this
 *   controller (focused or dragging) — such a controller must not be overwritten.
 * @returns {{update: boolean, value: number|boolean}} Whether to write, and the
 *   coerced value to write (a boolean when isBoolean). `value` is always the
 *   coerced incoming value even when `update` is false, so callers never need to
 *   re-coerce.
 */
export function resolveParamSync(current, incoming, isBoolean, isEditing) {
  const value = isBoolean ? incoming > 0.5 : incoming;
  if (isEditing) return { update: false, value };
  // NaN !== NaN, so without this guard current !== value is true every frame.
  if (typeof value === 'number' && Number.isNaN(value)) return { update: false, value };
  return { update: current !== value, value };
}
