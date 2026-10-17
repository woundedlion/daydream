import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PovSweep } from '../src/renderer/pov_sweep.js';

const frame = (value) => new Uint16Array(8 * 2 * 3).fill(value);
const row = (pixels, y) => Array.from({ length: 8 }, (_, x) => pixels[(y * 8 + x) * 3]);

test('sweep replaces opposing columns and retains the previous image ahead of both arms', () => {
  const sweep = new PovSweep(8, 2, frame(10));
  const source = frame(20);
  sweep.beginFrame(source);
  source.fill(99);
  assert.equal(sweep.advance(0), false);
  assert.equal(sweep.advance(0.5), true);
  for (const y of [0, 1]) {
    assert.deepEqual(row(sweep.pixels, y), [20, 20, 10, 10, 20, 20, 10, 10]);
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
  assert.deepEqual(row(sweep.pixels, 0), [30, 20, 20, 20, 30, 20, 20, 20]);
});

test('a stalled clock clamps at a full sweep and cannot rewind displayed columns', () => {
  const sweep = new PovSweep(8, 2, frame(10));
  sweep.beginFrame(frame(20));
  assert.equal(sweep.advance(-1), false);
  assert.equal(sweep.advance(10), true);
  assert.equal(sweep.advance(0.25), false);
  assert.deepEqual(sweep.pixels, frame(20));
});
