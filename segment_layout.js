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
 * Compute the canvas sub-rectangle a segment renders. This is the SIMULATOR's
 * own render tiler, not a 1:1 port of the firmware map.
 *
 * Relationship to the firmware (hardware/pov_segment_map.h, no shared source of
 * truth — there is no codegen bridging C++ and JS, and the device does not build
 * in CI):
 *  - For `total` in {2, 4} this tiling corresponds to the physical segment→
 *    canvas mapping the firmware uses (arm partition, the w/2 arm-B offset, and
 *    per-segment row coverage). That correspondence is pinned by
 *    tests/segment_crosscheck.test.js against the same fixture the C++ host
 *    tests (test_pov_segmented.h) lock down, so a convention change on either
 *    side trips a test.
 *  - For `total` in {6, 8} this is SIMULATOR-ONLY: extra Y-bands per arm spread
 *    the browser render across more Web Workers for parallelism. The firmware
 *    `segment_map()` rejects N > 4 (even, power-of-two, <= 4), so these counts
 *    have no device counterpart and intentionally do not mirror any C++ map.
 * The shared invariant in every case is NUM_ARMS = 2 vertical halves (arm A =
 * left, arm B = the w/2-shifted right half), each split into equal Y-bands.
 *
 * @param {number} id - segment index in [0, total)
 * @param {number} total - total segment count (positive even number; the GUI
 *   exposes 2..8 in steps of 2)
 * @param {number} w - canvas width in pixels
 * @param {number} h - canvas height in pixels
 * @returns {SegRange}
 */
export function computeSegmentRange(id, total, w, h) {
  const NUM_ARMS = 2;
  if (!Number.isInteger(total) || total < NUM_ARMS || total % NUM_ARMS !== 0) {
    throw new Error(
      `segment_worker: totalSegs must be a positive even number (got ${total})`);
  }
  if (!Number.isInteger(id) || id < 0 || id >= total) {
    throw new Error(
      `segment_worker: segment id must be an integer in [0, ${total}) (got ${id})`);
  }
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
