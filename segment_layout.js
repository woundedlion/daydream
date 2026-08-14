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

const NUM_ARMS = 2;

/**
 * Whether `total` is a layout-legal segment count: a positive integer multiple
 * of the arm count, i.e. a positive even number. Exported so a caller can reject
 * a count before spending work on it; computeSegmentRange enforces the same rule.
 * @param {number} total - Proposed total segment count.
 * @returns {boolean}
 */
export function isValidSegmentCount(total) {
  return Number.isInteger(total) && total >= NUM_ARMS && total % NUM_ARMS === 0;
}

/**
 * Compute the canvas sub-rectangle a segment renders.
 *
 * Layout: NUM_ARMS = 2 vertical halves — arm A is the left half, arm B the
 * w/2-shifted right half — with segments [0, total/2) on arm A and the
 * rest on arm B. Each arm splits into total/2 equal Y-bands. Within an arm the
 * first floor(bands/2) segments tile the northern bands top-down and the
 * remainder tile the southern bands from the S pole inward, so four bands per
 * arm run 0, 1, 3, 2.
 *
 * Two conventions are shared with the firmware's physical segment→canvas map
 * (hardware/pov_segment_map.h::segment_map), so a per-segment overlay in the
 * simulator names the same board the hardware ID straps select: the arm
 * partition, arm B included as the w/2-shifted half, and each segment's
 * row band. Both are pinned by tests/segment_crosscheck.test.js against
 * pov_segment_map.json — the mapping emitted from that header by the engine build
 * and installed here — so a convention change on either side trips a test. The
 * firmware walks a southern band's LEDs in decreasing y; a render rectangle has
 * no direction, so only the row set matters here.
 *
 * The column split is a worker partition, not a firmware correspondence: arm A
 * holds [0, w/2) on every frame, keeping the `total` rectangles disjoint
 * so they composite into one canvas. The firmware's segment_clip() instead
 * trades the two column halves between the arms every half-revolution, and each
 * arm sweeps the full width over a rotation.
 *
 * The firmware takes a power-of-two segment count <= 8, making `total` in
 * {2, 4, 8} the device-backed counts. `total` = 6 is simulator-only extra worker
 * parallelism and follows the same band rule.
 *
 * @param {number} id - segment index in [0, total)
 * @param {number} total - total segment count (positive even number; the GUI
 *   exposes 2..8 in steps of 2, capped further on a low-memory device)
 * @param {number} w - canvas width in pixels; must be even, so the two arms
 *   tile it exactly (an odd width would leave column w-1 in no segment)
 * @param {number} h - canvas height in pixels
 * @returns {SegRange}
 */
export function computeSegmentRange(id, total, w, h) {
  if (!isValidSegmentCount(total)) {
    throw new Error(
      `segment_layout: totalSegs must be a positive even number (got ${total})`);
  }
  if (!Number.isInteger(id) || id < 0 || id >= total) {
    throw new Error(
      `segment_layout: segment id must be an integer in [0, ${total}) (got ${id})`);
  }
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
    throw new Error(
      `segment_layout: canvas dimensions must be positive integers (got ${w}x${h})`);
  }
  if (w % NUM_ARMS !== 0) {
    throw new Error(
      `segment_layout: canvas width must be a multiple of ${NUM_ARMS} arms so `
      + `every column belongs to a segment (got ${w})`);
  }
  const ySegsPerArm = Math.floor(total / NUM_ARMS);
  if (h < ySegsPerArm) {
    throw new Error(
      `segment_layout: canvas height must be >= ${ySegsPerArm} y-segments per arm (got ${h})`);
  }

  const armId = Math.floor(id / ySegsPerArm);
  const armSeg = id % ySegsPerArm;

  // Symmetric w/2 split per arm, matching the firmware's w/2 arm-B column offset.
  const armW = w / NUM_ARMS;
  const x0 = armId * armW;
  const x1 = x0 + armW;

  // Northern half of an arm counts bands down from the N pole; the southern half
  // counts back up from the S pole, matching segment_map()'s reversed strips.
  const northBands = Math.floor(ySegsPerArm / 2);
  const bandId = armSeg < northBands
    ? armSeg
    : ySegsPerArm - 1 - (armSeg - northBands);

  const segH = Math.floor(h / ySegsPerArm);
  const y0 = bandId * segH;
  const y1 = (bandId === ySegsPerArm - 1) ? h : y0 + segH;

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
function blitSegmentRect(canvas, compact, canvasW, rect, gather) {
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

/**
 * Extract rect from the full canvas into a compact per-segment buffer.
 * @param {Uint16Array} canvas - Full canvas buffer (W*H*3, row stride canvasW*3).
 * @param {Uint16Array} compact - Packed segment buffer ((x1-x0)*(y1-y0)*3).
 * @param {number} canvasW - Canvas width in pixels.
 * @param {{x0:number,x1:number,y0:number,y1:number}} rect - Sub-rectangle to move.
 * @returns {void}
 */
export function extractSegment(canvas, compact, canvasW, rect) {
  blitSegmentRect(canvas, compact, canvasW, rect, true);
}

/**
 * Composite a compact per-segment buffer back into the full canvas.
 * @param {Uint16Array} canvas - Full canvas buffer (W*H*3, row stride canvasW*3).
 * @param {Uint16Array} compact - Packed segment buffer ((x1-x0)*(y1-y0)*3).
 * @param {number} canvasW - Canvas width in pixels.
 * @param {{x0:number,x1:number,y0:number,y1:number}} rect - Sub-rectangle to move.
 * @returns {void}
 */
export function compositeSegment(canvas, compact, canvasW, rect) {
  blitSegmentRect(canvas, compact, canvasW, rect, false);
}

/**
 * Stamp the segment-boundary overlay into a composited canvas: a full-width
 * cyan row at each y in `ys` and a full-height cyan column at each x in `xs`.
 * Coordinates outside the canvas are skipped, so a seam list cached from a
 * larger layout cannot write out of bounds — a negative column would otherwise
 * wrap onto the end of the preceding row.
 * @param {Uint16Array} canvas - Full canvas buffer (canvasW*canvasH*3).
 * @param {number} canvasW - Canvas width in pixels.
 * @param {number} canvasH - Canvas height in pixels.
 * @param {number[]} xs - Column indices to stamp.
 * @param {number[]} ys - Row indices to stamp.
 * @returns {void}
 */
export function stampBoundaries(canvas, canvasW, canvasH, xs, ys) {
  /** @param {number} idx - Buffer index of the pixel's red component. */
  const plotCyan = (idx) => {
    canvas[idx]     = 0;
    canvas[idx + 1] = 65535;
    canvas[idx + 2] = 65535;
  };

  for (const y of ys) {
    if (y < 0 || y >= canvasH) continue;
    const rowStart = y * canvasW * 3;
    for (let x = 0; x < canvasW; x++) plotCyan(rowStart + x * 3);
  }

  for (const x of xs) {
    if (x < 0 || x >= canvasW) continue;
    for (let y = 0; y < canvasH; y++) plotCyan((y * canvasW + x) * 3);
  }
}
