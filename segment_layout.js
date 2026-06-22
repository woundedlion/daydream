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
  // The 2-arm layout is symmetric, so total must be a positive even number. An
  // odd total makes armId exceed NUM_ARMS and pushes x0 past the canvas,
  // silently rendering a degenerate band — a config bug with no valid output, so
  // fail fast.
  if (!Number.isInteger(total) || total < NUM_ARMS || total % NUM_ARMS !== 0) {
    throw new Error(
      `segment_worker: totalSegs must be a positive even number (got ${total})`);
  }
  // id out of [0, total) computes an off-canvas band (e.g. id===total gives
  // x0===w) and feeds a degenerate rect into setClip; fail fast.
  if (!Number.isInteger(id) || id < 0 || id >= total) {
    throw new Error(
      `segment_worker: segment id must be an integer in [0, ${total}) (got ${id})`);
  }
  // Resolution arrives across the postMessage boundary (init / setResolution
  // both funnel through here). A non-integer or non-positive dimension produces
  // a degenerate segRange and feeds garbage into setClip; fail fast.
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

/**
 * Blit a segment's pixel rectangle row-by-row between the full W*H*3 canvas
 * buffer and a compact, tightly-packed per-segment buffer. Each canvas row
 * [x0,x1) is contiguous, so one row moves in a single TypedArray.set — (y1-y0)
 * bulk copies instead of ~(x1-x0)*(y1-y0)*3 scalar stores. Shared by the worker
 * (extract: canvas -> compact) and the compositor (composite: compact -> canvas)
 * so the two ends of the postMessage boundary cannot drift apart.
 * @param {Uint16Array} canvas - Full canvas buffer (W*H*3, row stride canvasW*3).
 * @param {Uint16Array} compact - Packed segment buffer ((x1-x0)*(y1-y0)*3), rows back-to-back.
 * @param {number} canvasW - Canvas width in pixels (the canvas row stride / 3).
 * @param {{x0:number,x1:number,y0:number,y1:number}} rect - Sub-rectangle to move.
 * @param {boolean} gather - true copies canvas->compact (extract a segment);
 *   false copies compact->canvas (composite a segment back).
 * @returns {void}
 */
export function blitSegmentRect(canvas, compact, canvasW, rect, gather) {
  const { x0, x1, y0, y1 } = rect;
  const rowLen = (x1 - x0) * 3;
  let compactIdx = 0;
  for (let y = y0; y < y1; y++) {
    const canvasIdx = (y * canvasW + x0) * 3;
    if (gather) {
      compact.set(canvas.subarray(canvasIdx, canvasIdx + rowLen), compactIdx);
    } else {
      canvas.set(compact.subarray(compactIdx, compactIdx + rowLen), canvasIdx);
    }
    compactIdx += rowLen;
  }
}
