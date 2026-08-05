//
// Cross-implementation equivalence between the web render-tiling layout
// (segment_layout.js computeSegmentRange) and the firmware's physical
// segment→canvas mapping.
//
// The firmware side is read from pov_segment_map.json, not reimplemented here.
// That file is emitted by the engine's tools/pov_segment_map_export.cpp — a TU
// compiled against hardware/pov_segment_map.h — pinned against the header by the
// engine's unit_pov_segment_map_golden CTest, and installed into this checkout
// alongside the WASM module. The deploy gate diffs the committed copy against the
// engine checkout it pins to the module's SHA. So a C++-side convention change
// cannot leave this cross-check green: the reference table moves with the header,
// and computeSegmentRange is then measured against the new convention.
//
// The two decompositions are NOT pixel-identical, and that is deliberate:
//   - computeSegmentRange tiles the canvas into NUM_ARMS=2 vertical halves
//     (arm A = left, arm B = right) each split into Y-bands, so each web worker
//     renders a disjoint sub-rectangle.
//   - the firmware map assigns each physical segment's LEDs to canvas columns;
//     over a full rotation BOTH arms read the entire width, with arm B reading a
//     w/2-shifted column. So the column decompositions intentionally differ.
//
// What the two MUST agree on is the shared convention:
//   1. Arm partition: segments [0, N/2) are arm A; [N/2, N) are arm B.
//   2. Arm placement: each arm's web rect starts at the canvas column the
//      firmware samples at rotation column 0 — x = 0 for arm A, x = floor(w/2)
//      for arm B.
//   3. Per-segment row coverage: the web rect's row span [y0, y1) equals the SET
//      of canvas rows the firmware segment's PPS LEDs touch (the bottom strip
//      runs reversed, so only the covered set is equal, not the traversal order).
//
// Run: node --test --experimental-test-module-mocks "tests/segment_crosscheck.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeSegmentRange } from '../segment_layout.js';

/**
 * @typedef {{ arm_b: boolean, y_base: number, y_step: number, y: number[] }} GoldenSegment
 * @typedef {{ leds: number, segment_count: number, rows: number, pps: number,
 *   segments: GoldenSegment[] }} GoldenConfig
 */

const GOLDEN_URL = new URL('../pov_segment_map.json', import.meta.url);
const REGENERATE =
  'regenerate it in the engine checkout (cmake --build --preset tests --target '
  + 'pov_segment_map_gen) and re-run the WASM install';

const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8'));

/**
 * Looks up the firmware mapping the golden records for one (S, N) config.
 * @param {number} S - Total firmware LEDs across both arms (ROWS = S/2).
 * @param {number} N - Segment count.
 * @returns {GoldenConfig}
 */
function goldenConfig(S, N) {
  const cfg = golden.configs.find(
    (c) => c.leds === S && c.segment_count === N);
  assert.ok(cfg, `pov_segment_map.json has no config for S=${S}, N=${N} — add it `
    + `to CONFIGS in tools/pov_segment_map_export.cpp, then ${REGENERATE}`);
  assert.equal(cfg.segments.length, N,
    `golden config S=${S}, N=${N} covers all ${N} segments`);
  return cfg;
}

/**
 * Canvas columns each arm samples at rotation column 0, per the golden.
 * @param {number} w - Canvas width.
 * @returns {{ arm_a: number, arm_b: number }}
 */
function goldenArmCols(w) {
  const entry = golden.x_cols.find((e) => e.width === w);
  assert.ok(entry, `pov_segment_map.json has no x_cols entry for width ${w} — add `
    + `it to WIDTHS in tools/pov_segment_map_export.cpp, then ${REGENERATE}`);
  assert.equal(typeof entry.arm_a, 'number',
    `pov_segment_map.json x_cols entry for width ${w} has no arm_a column — ${REGENERATE}`);
  assert.equal(typeof entry.arm_b, 'number',
    `pov_segment_map.json x_cols entry for width ${w} has no arm_b column — ${REGENERATE}`);
  return entry;
}

/**
 * Cross-checks computeSegmentRange against the golden for a config where the web
 * total equals the firmware segment count N and the canvas height equals
 * ROWS = S/2 (the regime in which the two layouts are meant to correspond).
 * PPS = S/N must divide the canvas height evenly.
 * @param {number} S - Total firmware LEDs (ROWS = S/2).
 * @param {number} N - Segment count (== web total).
 * @param {number} w - Canvas width.
 */
function crossCheck(S, N, w) {
  const cfg = goldenConfig(S, N);
  const halfW = Math.floor(w / 2);
  assert.equal(cfg.rows % (N / 2), 0, 'fixture: ROWS must split evenly into PPS bands');

  for (let id = 0; id < N; id++) {
    const rect = computeSegmentRange(id, N, w, cfg.rows);
    const m = cfg.segments[id];

    // (1) Arm partition.
    const webArmB = rect.x0 === halfW;
    assert.equal(webArmB, m.arm_b, `arm side agrees for id=${id} (S=${S},N=${N})`);

    // (2) Each arm's web rect starts at the firmware's sampled column.
    const cols = goldenArmCols(w);
    if (m.arm_b) {
      assert.equal(rect.x0, halfW, `arm-B rect starts at w/2 for id=${id}`);
      assert.equal(cols.arm_b, halfW, 'firmware arm-B offset is w/2');
    } else {
      assert.equal(rect.x0, cols.arm_a,
        `arm-A rect starts at the firmware arm-A column for id=${id}`);
      assert.equal(cols.arm_a, 0, 'firmware arm-A offset is 0');
    }

    // (3) Row coverage as a SET — the bottom strip is reversed in traversal order.
    assert.equal(m.y.length, cfg.pps, `golden lists PPS rows for id=${id}`);
    const cppRows = [...m.y].sort((a, b) => a - b);
    const webRows = [];
    for (let y = rect.y0; y < rect.y1; y++) webRows.push(y);
    assert.deepEqual(cppRows, webRows, `row coverage agrees for id=${id} (S=${S},N=${N})`);
  }
}

/**
 * Pins the golden's identity before anything reads it: a file that is not the
 * segment-map export (a truncated install, an unrelated JSON dropped at that
 * path) would otherwise make every lookup below fail with an opaque message.
 */
test('the committed golden is the pov_segment_map.h export', () => {
  assert.equal(golden.source, 'hardware/pov_segment_map.h',
    `pov_segment_map.json is not the segment-map export — ${REGENERATE}`);
  assert.ok(Array.isArray(golden.configs) && golden.configs.length > 0,
    'golden lists at least one config');
  assert.ok(Array.isArray(golden.x_cols) && golden.x_cols.length > 0,
    'golden lists at least one canvas width');
});

/**
 * Locks the canonical Phantasm config (S=288, N=4 → ROWS=144, PPS=72) against
 * the exact per-segment arm/row fixture the C++ side pins in
 * test_pov_segmented.h::test_segment_derivation, so a convention change on either
 * side trips the cross-check.
 */
test('segment layout ↔ pov_segment_map: canonical N=4/S=288 fixture agrees', () => {
  const fixture = [
    { id: 0, armB: false, rows: [0, 72] },    // arm A, top
    { id: 1, armB: false, rows: [72, 144] },  // arm A, bottom (reversed strip)
    { id: 2, armB: true, rows: [0, 72] },     // arm B, top
    { id: 3, armB: true, rows: [72, 144] },   // arm B, bottom (reversed strip)
  ];
  const cfg = goldenConfig(288, 4);
  for (const f of fixture) {
    const rect = computeSegmentRange(f.id, 4, 288, 144);
    assert.equal(rect.x0 === 144, f.armB, `arm side for id=${f.id}`);
    assert.equal(rect.y0, f.rows[0], `y0 for id=${f.id}`);
    assert.equal(rect.y1, f.rows[1], `y1 for id=${f.id}`);

    const m = cfg.segments[f.id];
    assert.equal(m.arm_b, f.armB, `firmware arm side for id=${f.id}`);
    const lo = m.y[0];
    const hi = m.y[cfg.pps - 1];
    assert.deepEqual([Math.min(lo, hi), Math.max(lo, hi) + 1], f.rows,
      `firmware row span for id=${f.id}`);
  }
});

/**
 * Locks the 8-board config (S=288, N=8 → ROWS=144, PPS=36) against the y_base
 * values the C++ side pins as static_asserts in test_pov_segmented.h. Four bands
 * per arm are where the northern/southern split becomes visible: the two
 * southern segments tile from the S pole inward, so within-arm slots 2 and 3
 * take the BOTTOM and second-from-bottom bands respectively.
 */
test('segment layout ↔ pov_segment_map: 8-board N=8/S=288 fixture agrees', () => {
  const fixture = [
    { id: 0, armB: false, yBase: 0, rows: [0, 36] },
    { id: 1, armB: false, yBase: 36, rows: [36, 72] },
    { id: 2, armB: false, yBase: 143, rows: [108, 144] },
    { id: 3, armB: false, yBase: 107, rows: [72, 108] },
    { id: 4, armB: true, yBase: 0, rows: [0, 36] },
    { id: 5, armB: true, yBase: 36, rows: [36, 72] },
    { id: 6, armB: true, yBase: 143, rows: [108, 144] },
    { id: 7, armB: true, yBase: 107, rows: [72, 108] },
  ];
  const cfg = goldenConfig(288, 8);
  for (const f of fixture) {
    const m = cfg.segments[f.id];
    assert.equal(m.arm_b, f.armB, `firmware arm side for id=${f.id}`);
    assert.equal(m.y_base, f.yBase, `firmware y_base for id=${f.id}`);

    const rect = computeSegmentRange(f.id, 8, 288, 144);
    assert.equal(rect.x0 === 144, f.armB, `arm side for id=${f.id}`);
    assert.equal(rect.y0, f.rows[0], `y0 for id=${f.id}`);
    assert.equal(rect.y1, f.rows[1], `y1 for id=${f.id}`);
  }
});

/**
 * Sweeps several even configs to prove the arm/offset/row-coverage correspondence
 * holds beyond the canonical fixture, including the N=2 single-band-per-arm case
 * and the N=8 four-band-per-arm case.
 */
test('segment layout ↔ pov_segment_map: correspondence holds across configs', () => {
  crossCheck(/*S=*/288, /*N=*/4, /*w=*/288);
  crossCheck(/*S=*/288, /*N=*/2, /*w=*/96);
  crossCheck(/*S=*/288, /*N=*/8, /*w=*/288);
  crossCheck(/*S=*/8, /*N=*/4, /*w=*/8);
  crossCheck(/*S=*/8, /*N=*/8, /*w=*/8);
});
