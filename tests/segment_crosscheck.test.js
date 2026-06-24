// @ts-check
//
// Cross-implementation equivalence between the web render-tiling layout
// (segment_layout.js computeSegmentRange) and the firmware's physical
// segment→canvas mapping (hardware/pov_segment_map.h, pinned independently by
// tests/test_pov_segmented.h on the Holosphere side).
//
// The two decompositions are NOT pixel-identical, and that is deliberate:
//   - computeSegmentRange tiles the canvas into NUM_ARMS=2 vertical halves
//     (arm A = left, arm B = right) each split into Y-bands, so each web worker
//     renders a disjoint sub-rectangle.
//   - pov_segment_map.h maps each physical segment's LEDs onto canvas columns;
//     over a full rotation BOTH arms read the entire width, with arm B reading a
//     w/2-shifted column. So the column decompositions intentionally differ.
//
// What the two MUST agree on is the shared convention:
//   1. Arm partition: segments [0, N/2) are arm A; [N/2, N) are arm B.
//   2. Arm B is the w/2 half: its web rect starts at x = floor(w/2), and the
//      firmware's arm-B column offset segment_x_col(true, 0, w) is floor(w/2).
//   3. Per-segment row coverage: the web rect's row span [y0, y1) equals the SET
//      of canvas rows the firmware segment's PPS LEDs touch (the bottom strip
//      runs reversed, so only the covered set is equal, not the traversal order).
//
// Run: node --test --experimental-test-module-mocks "tests/segment_crosscheck.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSegmentRange } from '../segment_layout.js';

/**
 * @typedef {{ armB: boolean, yBase: number, yStep: number }} CppSegmentMap
 */

/**
 * Reference port of hardware/pov_segment_map.h::segment_map. Kept in lockstep
 * with the C++ (whose authoritative host tests live in test_pov_segmented.h):
 * segments [0, N/2) are arm A, [N/2, N) arm B; within an arm the even slot is
 * the top strip (y_base 0, +1) and the odd slot the bottom strip (y_base
 * ROWS-1, -1, reversed).
 *
 * This is a hand port, so on its own it could drift from the C++ in lockstep
 * with `computeSegmentRange` and keep the cross-check green. To prevent that,
 * the port is itself pinned against hardcoded goldens — for every config the
 * sweep exercises — in the "pov_segment_map port matches independent goldens"
 * test below (the goldens mirror the C++ host-test fixture). An edit that
 * silently changes this port's convention trips those goldens regardless of how
 * `computeSegmentRange` changes.
 * @param {number} segmentId - Hardware segment id in [0, N).
 * @param {number} S - Total LEDs across both arms (ROWS = S/2).
 * @param {number} N - Segment count (even; N/2 per arm).
 * @returns {CppSegmentMap}
 */
function cppSegmentMap(segmentId, S, N) {
  const segsPerArm = N / 2;
  const rows = S / 2;
  const armSeg = segmentId % segsPerArm; // C++ masks (power-of-two segsPerArm)
  const armB = segmentId >= segsPerArm;
  return armSeg === 0
    ? { armB, yBase: 0, yStep: 1 }
    : { armB, yBase: rows - 1, yStep: -1 };
}

/**
 * Reference port of hardware/pov_segment_map.h::segment_x_col.
 * @param {boolean} armB - True for arm B (reads the w/2-shifted column).
 * @param {number} x - Rotation column (arm A's canvas column).
 * @param {number} w - Canvas width.
 * @returns {number} Canvas column this segment samples.
 */
function cppSegmentXCol(armB, x, w) {
  return armB ? (x + Math.floor(w / 2)) % w : x;
}

/**
 * Reference port of hardware/pov_segment_map.h::segment_y.
 * @param {CppSegmentMap} m - Segment mapping.
 * @param {number} i - LED index along the segment, in [0, PPS).
 * @returns {number} Canvas row of the i-th LED.
 */
function cppSegmentY(m, i) {
  return m.yBase + i * m.yStep;
}

/**
 * Cross-checks computeSegmentRange against the pov_segment_map.h port for a
 * config where the web total equals the firmware segment count N and the canvas
 * height equals ROWS = S/2 (the regime in which the two layouts are meant to
 * correspond). PPS = S/N must divide the canvas height evenly.
 * @param {number} S - Total firmware LEDs (ROWS = S/2).
 * @param {number} N - Segment count (== web total).
 * @param {number} w - Canvas width.
 */
function crossCheck(S, N, w) {
  const ROWS = S / 2;
  const PPS = S / N;
  const halfW = Math.floor(w / 2);
  assert.equal(ROWS % (N / 2), 0, 'fixture: ROWS must split evenly into PPS bands');

  for (let id = 0; id < N; id++) {
    const rect = computeSegmentRange(id, N, w, ROWS);
    const m = cppSegmentMap(id, S, N);

    // (1) Arm partition: the web arm (rect on the left vs right half) must match
    // the firmware arm_b flag for the same id.
    const webArmB = rect.x0 === halfW;
    assert.equal(webArmB, m.armB, `arm side agrees for id=${id} (S=${S},N=${N})`);

    // (2) Arm B is the w/2 half: the web rect of an arm-B segment starts at the
    // same column the firmware shifts arm B by.
    if (m.armB) {
      assert.equal(rect.x0, halfW, `arm-B rect starts at w/2 for id=${id}`);
      assert.equal(cppSegmentXCol(true, 0, w), halfW, 'firmware arm-B offset is w/2');
    } else {
      assert.equal(rect.x0, 0, `arm-A rect starts at 0 for id=${id}`);
    }

    // (3) Row coverage: the firmware segment's PPS LEDs cover exactly the web
    // rect's contiguous row span [y0, y1) (as a set; the bottom strip is
    // reversed in traversal order).
    const cppRows = [];
    for (let i = 0; i < PPS; i++) cppRows.push(cppSegmentY(m, i));
    cppRows.sort((a, b) => a - b);
    const webRows = [];
    for (let y = rect.y0; y < rect.y1; y++) webRows.push(y);
    assert.deepEqual(cppRows, webRows, `row coverage agrees for id=${id} (S=${S},N=${N})`);
  }
}

/**
 * Locks the canonical Phantasm config (S=288, N=4 → ROWS=144, PPS=72) against
 * the exact per-segment arm/row fixture the C++ side pins in
 * test_pov_segmented.h::test_segment_derivation, so a convention change on either
 * side trips the cross-check.
 */
test('segment layout ↔ pov_segment_map: canonical N=4/S=288 fixture agrees', () => {
  // Shared fixture — must equal both sides. C++ counterpart: the s0..s3 cases in
  // test_pov_segmented.h (arm A top/bottom, arm B top/bottom; ROWS=144, PPS=72).
  const fixture = [
    { id: 0, armB: false, rows: [0, 72] },    // arm A, top
    { id: 1, armB: false, rows: [72, 144] },  // arm A, bottom (reversed strip)
    { id: 2, armB: true, rows: [0, 72] },     // arm B, top
    { id: 3, armB: true, rows: [72, 144] },   // arm B, bottom (reversed strip)
  ];
  for (const f of fixture) {
    const rect = computeSegmentRange(f.id, 4, 288, 144);
    assert.equal(rect.x0 === 144, f.armB, `arm side for id=${f.id}`);
    assert.equal(rect.y0, f.rows[0], `y0 for id=${f.id}`);
    assert.equal(rect.y1, f.rows[1], `y1 for id=${f.id}`);

    const m = cppSegmentMap(f.id, 288, 4);
    assert.equal(m.armB, f.armB, `firmware arm side for id=${f.id}`);
    const lo = cppSegmentY(m, 0);
    const hi = cppSegmentY(m, 71);
    assert.deepEqual([Math.min(lo, hi), Math.max(lo, hi) + 1], f.rows,
      `firmware row span for id=${f.id}`);
  }
});

/**
 * Sweeps several even configs to prove the arm/offset/row-coverage correspondence
 * holds beyond the canonical fixture, including the N=2 single-band-per-arm case.
 */
test('segment layout ↔ pov_segment_map: correspondence holds across configs', () => {
  crossCheck(/*S=*/288, /*N=*/4, /*w=*/288);
  crossCheck(/*S=*/288, /*N=*/2, /*w=*/96);
  crossCheck(/*S=*/8, /*N=*/4, /*w=*/8);
});

/**
 * Pins the cppSegmentMap port against hardcoded {armB, yBase, yStep} goldens for
 * EVERY config the sweep above exercises. Without this the port (a hand
 * reimplementation of the C++) and computeSegmentRange could drift together and
 * keep the cross-check green; here the firmware side is independent literals
 * derived from pov_segment_map.h's rule (arm A = [0,N/2), top slot y_base 0 +1,
 * bottom slot y_base ROWS-1 -1), so a convention change in the port fails
 * regardless of how computeSegmentRange changes. The canonical N=4/S=288 case is
 * additionally pinned in the fixture test above.
 */
test('pov_segment_map port matches independent goldens', () => {
  /** @type {Array<{S:number, N:number, golden: CppSegmentMap[]}>} */
  const cases = [
    // S=288, N=2 → ROWS=144, one band per arm: both segments are the top slot.
    { S: 288, N: 2, golden: [
      { armB: false, yBase: 0, yStep: 1 },
      { armB: true, yBase: 0, yStep: 1 },
    ] },
    // S=288, N=4 → ROWS=144: arm A top/bottom, arm B top/bottom.
    { S: 288, N: 4, golden: [
      { armB: false, yBase: 0, yStep: 1 },
      { armB: false, yBase: 143, yStep: -1 },
      { armB: true, yBase: 0, yStep: 1 },
      { armB: true, yBase: 143, yStep: -1 },
    ] },
    // S=8, N=4 → ROWS=4: same shape at the small extreme.
    { S: 8, N: 4, golden: [
      { armB: false, yBase: 0, yStep: 1 },
      { armB: false, yBase: 3, yStep: -1 },
      { armB: true, yBase: 0, yStep: 1 },
      { armB: true, yBase: 3, yStep: -1 },
    ] },
  ];
  for (const { S, N, golden } of cases) {
    for (let id = 0; id < N; id++) {
      assert.deepEqual(cppSegmentMap(id, S, N), golden[id],
        `port matches golden for id=${id} (S=${S}, N=${N})`);
    }
  }
});
