// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSegmentRange } from '../segment_layout.js';

/**
 * Verifies that the complete set of segments for several canvas sizes covers
 * every pixel exactly once, with no overlaps, no gaps, and reported w/h
 * matching the x/y spans.
 */
test('a full segment set tiles the canvas exactly once', () => {
  // Mix of dimensions that divide evenly and ones that leave a remainder for
  // the last band/arm to absorb.
  const cases = [
    { w: 288, h: 144, total: 4 },
    { w: 288, h: 144, total: 8 },
    { w: 96, h: 20, total: 2 },
    { w: 97, h: 21, total: 4 },   // odd dims: last arm/band takes the remainder
    { w: 100, h: 30, total: 6 },
  ];

  for (const { w, h, total } of cases) {
    const cover = new Uint8Array(w * h);
    for (let id = 0; id < total; id++) {
      const r = computeSegmentRange(id, total, w, h);
      assert.ok(r.x0 >= 0 && r.x1 <= w, `x in range for id=${id} ${w}x${h}/${total}`);
      assert.ok(r.y0 >= 0 && r.y1 <= h, `y in range for id=${id} ${w}x${h}/${total}`);
      assert.equal(r.w, r.x1 - r.x0, 'reported w matches x span');
      assert.equal(r.h, r.y1 - r.y0, 'reported h matches y span');
      for (let y = r.y0; y < r.y1; y++) {
        for (let x = r.x0; x < r.x1; x++) {
          assert.equal(cover[y * w + x], 0,
            `pixel (${x},${y}) painted twice for ${w}x${h}/${total}`);
          cover[y * w + x] = 1;
        }
      }
    }
    for (let i = 0; i < cover.length; i++) {
      assert.equal(cover[i], 1, `pixel ${i} uncovered for ${w}x${h}/${total}`);
    }
  }
});

/**
 * Verifies that total=2 splits the canvas into two full-height halves, one per
 * arm, left and right.
 */
test('two arms split the canvas left/right', () => {
  // total=2 → one band per arm, full height each.
  const left = computeSegmentRange(0, 2, 288, 144);
  const right = computeSegmentRange(1, 2, 288, 144);
  assert.deepEqual(left, { x0: 0, x1: 144, y0: 0, y1: 144, w: 144, h: 144 });
  assert.deepEqual(right, { x0: 144, x1: 288, y0: 0, y1: 144, w: 144, h: 144 });
});

/**
 * Verifies that when the height does not divide evenly across bands, the final
 * band extends to the full height to absorb the remainder rather than leaving a
 * gap.
 */
test('the last band absorbs an uneven height remainder', () => {
  // total=4 → 2 bands per arm; h=21 → segH=10, last band reaches 21.
  const top = computeSegmentRange(0, 4, 96, 21);
  const bottom = computeSegmentRange(1, 4, 96, 21);
  assert.equal(top.y0, 0);
  assert.equal(top.y1, 10);
  assert.equal(bottom.y0, 10);
  assert.equal(bottom.y1, 21); // remainder absorbed, not 20
});

/**
 * Verifies that a non-positive, odd, or non-integer total segment count is
 * rejected with a "positive even number" error.
 */
test('an odd or too-small segment count fails fast', () => {
  assert.throws(() => computeSegmentRange(0, 3, 96, 20), /positive even number/);
  assert.throws(() => computeSegmentRange(0, 0, 96, 20), /positive even number/);
  assert.throws(() => computeSegmentRange(0, 2.5, 96, 20), /positive even number/);
});

/**
 * Verifies that zero, negative, or non-integer canvas dimensions are rejected
 * with a "positive integers" error.
 */
test('degenerate canvas dimensions fail fast', () => {
  assert.throws(() => computeSegmentRange(0, 2, 0, 20), /positive integers/);
  assert.throws(() => computeSegmentRange(0, 2, 96, -1), /positive integers/);
  assert.throws(() => computeSegmentRange(0, 2, 96.5, 20), /positive integers/);
});

/**
 * Verifies that a segment id outside [0, total), or a non-integer id, is
 * rejected rather than producing a range that falls off the canvas.
 */
test('an out-of-range segment id fails fast instead of going off-canvas', () => {
  // id === total would yield x0 === w (a band entirely off the canvas).
  assert.throws(() => computeSegmentRange(4, 4, 288, 144), /segment id must be/);
  assert.throws(() => computeSegmentRange(-1, 4, 288, 144), /segment id must be/);
  assert.throws(() => computeSegmentRange(1.5, 4, 288, 144), /segment id must be/);
});
