// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSegmentRange } from '../segment_layout.js';

// The exactly-once tiling invariant holds for even widths only: the symmetric
// floor(w/2) arm split drops an odd width's trailing column (see the odd-width
// case below), which is acceptable since every real canvas (96, 288) is even.
test('a full segment set tiles the canvas exactly once', () => {
  const cases = [
    { w: 288, h: 144, total: 4 },
    { w: 288, h: 144, total: 8 },
    { w: 96, h: 20, total: 2 },
    { w: 96, h: 21, total: 4 },   // odd height: last band takes the remainder
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

test('two arms split the canvas left/right', () => {
  const left = computeSegmentRange(0, 2, 288, 144);
  const right = computeSegmentRange(1, 2, 288, 144);
  assert.deepEqual(left, { x0: 0, x1: 144, y0: 0, y1: 144, w: 144, h: 144 });
  assert.deepEqual(right, { x0: 144, x1: 288, y0: 0, y1: 144, w: 144, h: 144 });
});

test('an odd canvas width drops the trailing column instead of widening arm B', () => {
  const left = computeSegmentRange(0, 2, 97, 144);
  const right = computeSegmentRange(1, 2, 97, 144);
  assert.equal(left.x1, 48);
  assert.equal(right.x0, 48);
  assert.equal(right.x1, 96); // floor(97/2)*2 = 96; column 96 dropped, not absorbed
});

test('the last band absorbs an uneven height remainder', () => {
  // total=4 → 2 bands per arm; h=21 → segH=10, last band reaches 21.
  const top = computeSegmentRange(0, 4, 96, 21);
  const bottom = computeSegmentRange(1, 4, 96, 21);
  assert.equal(top.y0, 0);
  assert.equal(top.y1, 10);
  assert.equal(bottom.y0, 10);
  assert.equal(bottom.y1, 21); // remainder absorbed, not 20
});

test('an odd or too-small segment count fails fast', () => {
  assert.throws(() => computeSegmentRange(0, 3, 96, 20), /positive even number/);
  assert.throws(() => computeSegmentRange(0, 0, 96, 20), /positive even number/);
  assert.throws(() => computeSegmentRange(0, 2.5, 96, 20), /positive even number/);
});

test('degenerate canvas dimensions fail fast', () => {
  assert.throws(() => computeSegmentRange(0, 2, 0, 20), /positive integers/);
  assert.throws(() => computeSegmentRange(0, 2, 96, -1), /positive integers/);
  assert.throws(() => computeSegmentRange(0, 2, 96.5, 20), /positive integers/);
});

test('an out-of-range segment id fails fast instead of going off-canvas', () => {
  // id === total would yield x0 === w (a band entirely off the canvas).
  assert.throws(() => computeSegmentRange(4, 4, 288, 144), /segment id must be/);
  assert.throws(() => computeSegmentRange(-1, 4, 288, 144), /segment id must be/);
  assert.throws(() => computeSegmentRange(1.5, 4, 288, 144), /segment id must be/);
});
