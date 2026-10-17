import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PovSweep } from '../src/renderer/pov_sweep.js';

const frame = (value) => new Uint16Array(8 * 2 * 3).fill(value);
const row = (pixels, y) => Array.from({ length: 8 }, (_, x) => pixels[(y * 8 + x) * 3]);

test('seeking backwards restores the same frame pair without accumulating markers', () => {
  const sweep = new PovSweep(8, 2, frame(10));
  const source = frame(20);
  sweep.beginFrame(source);
  for (const [phase, expected, boundary] of [
    [0.5, [20, 20, 20, 10, 20, 20, 20, 10], 3],
    [0, [20, 10, 10, 10, 20, 10, 10, 10], 1],
    [1, [20, 20, 20, 20, 20, 20, 20, 20], 0],
    [0.25, [20, 20, 10, 10, 20, 20, 10, 10], 2],
    [0, [20, 10, 10, 10, 20, 10, 10, 10], 1],
  ]) {
    sweep.seek(phase);
    for (const y of [0, 1]) {
      assert.deepEqual(row(sweep.pixels, y), expected);
      const overlay = row(sweep.displayPixels(true), y);
      assert.equal(overlay.filter((value) => value === 65535).length, 2);
      assert.equal(overlay[boundary], 65535);
      assert.equal(overlay[boundary + 4], 65535);
    }
    assert.deepEqual(sweep.source, frame(20));
    assert.deepEqual(sweep.previous, frame(10));
    assert.deepEqual(source, frame(20));
  }
  sweep.beginFrame(frame(30));
  sweep.seek(0);
  assert.deepEqual(row(sweep.pixels, 0), [30, 20, 20, 20, 30, 20, 20, 20]);
});

test('the optional boundary marks only the next opposing columns without changing samples', () => {
  const initial = frame(10);
  const source = frame(20);
  const sweep = new PovSweep(8, 2, initial);
  sweep.beginFrame(source);
  assert.equal(sweep.displayPixels(false), sweep.pixels);
  assert.equal(sweep.boundaryPixels, null);
  let overlay;
  for (const [phase, boundary] of [[0, 1], [0.5, 3], [1, 0]]) {
    sweep.advance(phase);
    const held = sweep.pixels.slice();
    const displayed = sweep.displayPixels(true);
    if (overlay) assert.equal(displayed, overlay);
    overlay = displayed;
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 8; x++) {
        const index = (y * 8 + x) * 3;
        assert.deepEqual(displayed.slice(index, index + 3),
          x % 4 === boundary ? new Uint16Array([65535, 0, 65535])
            : held.slice(index, index + 3));
      }
    }
    assert.deepEqual(sweep.pixels, held);
    assert.deepEqual(sweep.source, source);
    assert.deepEqual(source, frame(20));
    assert.deepEqual(initial, frame(10));
    assert.equal(sweep.displayPixels(false), sweep.pixels);
  }
});

test('sweep replaces opposing columns and retains the previous image ahead of both arms', () => {
  const sweep = new PovSweep(8, 2, frame(10));
  const source = frame(20);
  sweep.beginFrame(source);
  source.fill(99);
  assert.equal(sweep.advance(0), true);
  assert.deepEqual(row(sweep.pixels, 0), [20, 10, 10, 10, 20, 10, 10, 10]);
  assert.equal(sweep.advance(0.5), true);
  for (const y of [0, 1]) {
    assert.deepEqual(row(sweep.pixels, y), [20, 20, 20, 10, 20, 20, 20, 10]);
  }
  assert.equal(sweep.advance(0.5), false);
  assert.equal(sweep.advance(1), true);
  assert.deepEqual(sweep.pixels, frame(20));
});

test('a new half-turn finishes the previous image before revealing the next', () => {
  const sweep = new PovSweep(8, 2, frame(10));
  sweep.beginFrame(frame(20));
  sweep.advance(0.25);
  sweep.beginFrame(frame(30));
  assert.deepEqual(sweep.pixels, frame(20));
  sweep.advance(0.25);
  assert.deepEqual(row(sweep.pixels, 0), [30, 30, 20, 20, 30, 30, 20, 20]);
});

test('a stalled clock clamps at a full sweep and cannot rewind displayed columns', () => {
  const sweep = new PovSweep(8, 2, frame(10));
  sweep.beginFrame(frame(20));
  assert.equal(sweep.advance(-1), false);
  assert.equal(sweep.advance(-0.01), false);
  assert.deepEqual(sweep.pixels, frame(10));
  assert.equal(sweep.advance(10), true);
  assert.equal(sweep.advance(0.25), false);
  assert.deepEqual(sweep.pixels, frame(20));
});

test('the first column joins the preceding sweep at both fixed meridians', () => {
  const timestampFrame = (start) => new Uint16Array(
    Array.from({ length: 8 * 3 }, (_, i) => start + Math.floor(i / 3) % 4));
  const sweep = new PovSweep(8, 1, timestampFrame(0));
  sweep.beginFrame(timestampFrame(4));
  sweep.advance(0);
  assert.deepEqual(row(sweep.pixels, 0), [4, 1, 2, 3, 4, 1, 2, 3]);
  assert.equal(sweep.pixels[0] - sweep.pixels[7 * 3], 1);
  assert.equal(sweep.pixels[4 * 3] - sweep.pixels[3 * 3], 1);
  sweep.advance(0.25 - Number.EPSILON);
  assert.equal(sweep.column, 1);
  sweep.advance(0.25);
  assert.deepEqual(row(sweep.pixels, 0), [4, 5, 2, 3, 4, 5, 2, 3]);
});
