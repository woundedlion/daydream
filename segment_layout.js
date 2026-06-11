// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 *
 * Pure segment-layout math, factored out of segment_worker.js so it can be
 * unit-tested in Node without loading the WASM module or a Worker global.
 */

/**
 * @typedef {{ x0: number, x1: number, y0: number, y1: number, w: number, h: number }} SegRange
 */

/**
 * Compute the canvas sub-rectangle a segment renders. Mirrors the 2-arm
 * quadrant layout from pov_segmented.h.
 * @param {number} id - segment index in [0, total)
 * @param {number} total - total segment count (positive even number)
 * @param {number} w - canvas width in pixels
 * @param {number} h - canvas height in pixels
 * @returns {SegRange}
 */
export function computeSegmentRange(id, total, w, h) {
  const NUM_ARMS = 2;
  // The layout is symmetric across the 2 arms, so the segment count is always a
  // positive even number (it mirrors pov_segmented.h's per-arm split — there can
  // never be an odd number of segments). An odd total would make armId exceed
  // NUM_ARMS and index x0 past the canvas, silently rendering a degenerate band.
  // That's a configuration bug with no valid rendering, so fail fast.
  if (!Number.isInteger(total) || total < NUM_ARMS || total % NUM_ARMS !== 0) {
    throw new Error(
      `segment_worker: totalSegs must be a positive even number (got ${total})`);
  }
  // The id selects which sub-rectangle this segment owns; out of [0, total) it
  // would compute an off-canvas band (e.g. id===total gives x0===w) and feed a
  // degenerate rect into setClip — the same silent-degenerate failure the total
  // guard above exists to prevent. Fail fast for symmetry with that guard.
  if (!Number.isInteger(id) || id < 0 || id >= total) {
    throw new Error(
      `segment_worker: segment id must be an integer in [0, ${total}) (got ${id})`);
  }
  // Guard the resolution carried across the postMessage boundary (init /
  // setResolution both funnel through here). A non-integer or
  // non-positive dimension would produce a degenerate segRange and feed garbage
  // into setClip; fail fast instead.
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
    throw new Error(
      `segment_worker: canvas dimensions must be positive integers (got ${w}x${h})`);
  }
  const ySegsPerArm = Math.floor(total / NUM_ARMS);
  const armId = Math.floor(id / ySegsPerArm);
  const ySegId = id % ySegsPerArm;

  const armW = Math.floor(w / NUM_ARMS);
  const x0 = armId * armW;
  const x1 = (armId === NUM_ARMS - 1) ? w : x0 + armW;

  const segH = Math.floor(h / ySegsPerArm);
  const y0 = ySegId * segH;
  const y1 = (ySegId === ySegsPerArm - 1) ? h : y0 + segH;

  return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}
