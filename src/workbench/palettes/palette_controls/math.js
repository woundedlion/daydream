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

/**
 * The endpoints a lightness or chroma axis spans, for controls that edit its
 * ends rather than its center and width.
 * @param {{center:number, range:number}} axis - The recipe's axis values.
 * @returns {{minimum:number, maximum:number}} The endpoints, each clamped to [0, 1].
 */
export function axisEndpoints({ center, range }) {
  return {
    minimum: clampUnit(center - range * 0.5),
    maximum: clampUnit(center + range * 0.5),
  };
}

/**
 * The center-and-range form of an axis the user edited by its endpoints.
 * @param {number} minimum - One endpoint.
 * @param {number} maximum - The other; the two may arrive in either order.
 * @param {{center:number, range:number}} [out] - Object the center and range are written into.
 * @returns {{center:number, range:number}} `out`, or a new axis value, with a non-negative range.
 */
export function axisFromEndpoints(minimum, maximum, out = { center: 0, range: 0 }) {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  out.center = (low + high) * 0.5;
  out.range = high - low;
  return out;
}
