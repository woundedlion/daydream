/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */



/**
 * @param {number} value - Value to clamp.
 * @returns {number} `value` clamped to [0, 1].
 */
export const clampUnit = (value) => Math.max(0, Math.min(1, value));

/**
 * Subtracts whole turns from a hue.
 * @param {number} turns - A hue in turns (one turn is 360°).
 * @returns {number} The equivalent hue in [0, 1); rounding near the seam may yield 1.
 */
export const wrapTurns = (turns) => turns - Math.floor(turns);

/**
 * The shortest signed rotation a hue difference stands for.
 * @param {number} delta - Difference between two hues, in turns.
 * @returns {number} The equivalent difference in [-0.5, 0.5]. Exactly half a
 *   turn is equally far either way, so it keeps the sign of `delta` — a key
 *   dragged the long way round travels on instead of snapping back.
 */
export function signedTurnDelta(delta) {
  const wrapped = wrapTurns(delta);
  if (wrapped < 0.5) return wrapped;
  if (wrapped > 0.5) return wrapped - 1;
  return delta < 0 ? -0.5 : 0.5;
}

/**
 * Lifts a wrapped hue to the representative nearest a reference hue, so a hue
 * that crossed the 0/1 seam stays continuous with where it came from.
 * @param {number} wrappedTurn - A hue in turns, typically in [0, 1).
 * @param {number} referenceTurn - The unwrapped hue the result should sit beside.
 * @returns {number} The representative of `wrappedTurn` within half a turn of `referenceTurn`.
 */
export function equivalentTurnNear(wrappedTurn, referenceTurn) {
  return referenceTurn + signedTurnDelta(wrappedTurn - referenceTurn);
}
