import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSegmentRange, extractSegment, compositeSegment, stampBoundaries } from '../segment_layout.js';

// An odd width is rejected outright (see the case below), so the exactly-once
// tiling invariant holds for every width the layout accepts.
test('a full segment set tiles the canvas exactly once', () => {
  const cases = [
    { w: 288, h: 144, total: 4 },
    { w: 288, h: 144, total: 8 },
    { w: 96, h: 20, total: 2 },
    { w: 96, h: 21, total: 4 },   // odd height: the remainder spreads across bands
    { w: 100, h: 30, total: 6 },
  ];

  for (const { w, h, total } of cases) {
    const cover = new Uint8Array(w * h);
    const twice = [];
    for (let id = 0; id < total; id++) {
      const r = computeSegmentRange(id, total, w, h);
      assert.ok(r.x0 >= 0 && r.x1 <= w, `x in range for id=${id} ${w}x${h}/${total}`);
      assert.ok(r.y0 >= 0 && r.y1 <= h, `y in range for id=${id} ${w}x${h}/${total}`);
      assert.equal(r.w, r.x1 - r.x0, 'reported w matches x span');
      assert.equal(r.h, r.y1 - r.y0, 'reported h matches y span');
      for (let y = r.y0; y < r.y1; y++) {
        for (let x = r.x0; x < r.x1; x++) {
          if (cover[y * w + x] !== 0) twice.push(`(${x},${y})`);
          cover[y * w + x] = 1;
        }
      }
    }
    const uncovered = [];
    for (let i = 0; i < cover.length; i++) if (cover[i] !== 1) uncovered.push(i);
    assert.deepEqual(twice.slice(0, 5), [],
      `${twice.length} pixels painted twice for ${w}x${h}/${total}`);
    assert.deepEqual(uncovered.slice(0, 5), [],
      `${uncovered.length} pixels uncovered for ${w}x${h}/${total}`);
  }
});

test('two arms split the canvas left/right', () => {
  const left = computeSegmentRange(0, 2, 288, 144);
  const right = computeSegmentRange(1, 2, 288, 144);
  assert.deepEqual(left, { x0: 0, x1: 144, y0: 0, y1: 144, w: 144, h: 144 });
  assert.deepEqual(right, { x0: 144, x1: 288, y0: 0, y1: 144, w: 144, h: 144 });
});

// A floor(w/2) arm split would leave column w-1 in no segment, so a full set of
// results would still report a complete frame with a permanently black column.
test('an odd canvas width fails fast instead of leaving a column uncovered', () => {
  assert.throws(() => computeSegmentRange(0, 2, 97, 144), /multiple of 2 arms/);
  assert.throws(() => computeSegmentRange(1, 2, 97, 144), /multiple of 2 arms/);
  assert.throws(() => computeSegmentRange(0, 8, 289, 144), /multiple of 2 arms/);
  // The width floor is the same rule: 1 is odd, and every legal width is >= 2.
  assert.throws(() => computeSegmentRange(0, 2, 1, 144), /multiple of 2 arms/);
});

test('an uneven height remainder spreads one row per band', () => {
  // total=4 → 2 bands per arm; h=21 → segH=10 and one spare row, taken by the
  // northern band, so neither band exceeds the other by more than a row.
  const top = computeSegmentRange(0, 4, 96, 21);
  const bottom = computeSegmentRange(1, 4, 96, 21);
  assert.deepEqual([top.y0, top.y1], [0, 11]);
  assert.deepEqual([bottom.y0, bottom.y1], [11, 21]);
});

// The slowest worker bounds the frame, so a remainder piled onto one band inflates
// every parallel render by its excess.
test('no band exceeds another by more than one row', () => {
  for (const { total, h } of [{ total: 6, h: 20 }, { total: 8, h: 15 },
                              { total: 4, h: 21 }, { total: 6, h: 100 }]) {
    const heights = [];
    for (let id = 0; id < total; id++) heights.push(computeSegmentRange(id, total, 96, h).h);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= 1,
      `band heights ${heights} for ${total} segments over h=${h}`);
  }
});

// Four bands per arm is where the firmware's northern/southern split becomes
// observable; the goldens are cross-checked against pov_segment_map.h in
// tests/segment_crosscheck.test.js.
test('four bands per arm tile north top-down then south from the pole inward', () => {
  const slotRows = [[0, 36], [36, 72], [108, 144], [72, 108]];
  for (let arm = 0; arm < 2; arm++) {
    for (let slot = 0; slot < 4; slot++) {
      const r = computeSegmentRange(arm * 4 + slot, 8, 288, 144);
      assert.equal(r.x0, arm * 144, `arm side for arm=${arm} slot=${slot}`);
      assert.deepEqual([r.y0, r.y1], slotRows[slot], `rows for arm=${arm} slot=${slot}`);
    }
  }
});

test('an uneven height remainder spreads across four bands per arm', () => {
  // total=8 → 4 bands per arm; h=15 → segH=3 and three spare rows, so the three
  // northmost bands run 4 rows and the S-pole band 3. The bottom band belongs to
  // within-arm slot 2, not slot 3.
  const slot2 = computeSegmentRange(2, 8, 96, 15);
  const slot3 = computeSegmentRange(3, 8, 96, 15);
  assert.deepEqual([slot2.y0, slot2.y1], [12, 15]);
  assert.deepEqual([slot3.y0, slot3.y1], [8, 12]);
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

test('a height too small for one band per arm fails fast', () => {
  // total=8 → 4 y-segments per arm; h=3 cannot hold one row each.
  assert.throws(() => computeSegmentRange(0, 8, 96, 3), /y-segments per arm/);
});

test('extract then composite round-trips a non-trivial rect through the shared blit', () => {
  const canvasW = 8, canvasH = 6;
  const src = new Uint16Array(canvasW * canvasH * 3);
  for (let i = 0; i < src.length; i++) src[i] = i + 1; // distinct nonzero values
  const rect = { x0: 2, x1: 6, y0: 1, y1: 5 }; // 4x4, offset on both axes
  const qw = rect.x1 - rect.x0, qh = rect.y1 - rect.y0;

  const compact = new Uint16Array(qw * qh * 3);
  extractSegment(src, compact, canvasW, rect);
  const gathered = [];
  for (let y = 0; y < qh; y++)
    for (let x = 0; x < qw; x++)
      for (let c = 0; c < 3; c++) {
        const ci = (y * qw + x) * 3 + c;
        const si = ((y + rect.y0) * canvasW + (x + rect.x0)) * 3 + c;
        if (compact[ci] !== src[si])
          gathered.push(`(${x},${y}) ch${c}: ${compact[ci]} != ${src[si]}`);
      }
  assert.deepEqual(gathered.slice(0, 5), [], `${gathered.length} compact samples wrong`);

  // gather=false path: composite the compact buffer back into a fresh canvas;
  // the rect must land at its source offset and nothing outside it is touched.
  const dst = new Uint16Array(canvasW * canvasH * 3);
  compositeSegment(dst, compact, canvasW, rect);
  const scattered = [];
  for (let y = 0; y < canvasH; y++)
    for (let x = 0; x < canvasW; x++) {
      const inside = x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
      for (let c = 0; c < 3; c++) {
        const di = (y * canvasW + x) * 3 + c;
        const want = inside ? src[di] : 0;
        if (dst[di] !== want)
          scattered.push(`(${x},${y}) ch${c}: ${dst[di]} != ${want}`);
      }
    }
  assert.deepEqual(scattered.slice(0, 5), [], `${scattered.length} canvas samples wrong`);
});

test('stampBoundaries paints only the listed seams and clips off-canvas ones', () => {
  const canvasW = 6, canvasH = 4;
  const canvas = new Uint16Array(canvasW * canvasH * 3);
  // canvasW/canvasH are past the last valid index: a seam list cached from a
  // larger layout must be clipped, not wrapped into the next row.
  stampBoundaries(canvas, canvasW, canvasH, [0, 3, canvasW], [2, canvasH]);

  const wrong = [];
  for (let y = 0; y < canvasH; y++)
    for (let x = 0; x < canvasW; x++) {
      const seam = y === 2 || x === 0 || x === 3;
      const i = (y * canvasW + x) * 3;
      const want = [0, seam ? 65535 : 0, seam ? 65535 : 0];
      for (let c = 0; c < 3; c++)
        if (canvas[i + c] !== want[c])
          wrong.push(`(${x},${y}) ch${c}: ${canvas[i + c]} != ${want[c]}`);
    }
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} pixels wrong`);
});

test('stampBoundaries with no seams leaves the canvas untouched', () => {
  const canvas = new Uint16Array(4 * 2 * 3).fill(7);
  stampBoundaries(canvas, 4, 2, [], []);
  assert.ok(canvas.every((v) => v === 7));
});
