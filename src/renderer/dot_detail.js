/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Dot sphere segment count at zero pixels. */
export const MAX_DOT_SEGMENTS = 30;

/** Dot sphere segment floor. */
export const MIN_DOT_SEGMENTS = 3;

/** Per-dot sphere LOD: segment count decays exponentially as pixel count rises
 *  so the triangle budget stays bounded.
 * @param {number} totalPixels - Instance count of the dot mesh (W*H).
 * @returns {number} Sphere width/height segment count, floored at `MIN_DOT_SEGMENTS`.
 */
export const dotDetailFor = (totalPixels) => {
  const LOD_DECAY_PIXELS = 30000;
  return Math.max(
    MIN_DOT_SEGMENTS,
    Math.round(MAX_DOT_SEGMENTS * Math.exp(-totalPixels / LOD_DECAY_PIXELS)));
};
