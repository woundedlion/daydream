import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PovSweep } from '../src/renderer/pov_sweep.js';

const frame = (value) => new Uint16Array(8 * 2 * 3).fill(value);
const row = (pixels, y) => Array.from({ length: 8 }, (_, x) => pixels[(y * 8 + x) * 3]);

test('camera exposure agrees with an independent time-sampled emission oracle', () => {
  const frames = Array.from({ length: 8 }, (_, epoch) => new Uint16Array(
    Array.from({ length: 48 }, (_, index) => (epoch + 1) * 1000 + index * 7)));
  const sweep = new PovSweep(8, 2, frames[0], 0.375);
  for (let epoch = 0; epoch < frames.length; epoch++) {
    if (epoch > 0) sweep.beginFrame(frames[epoch]);
    for (const fraction of [0, 0.125, 0.375, 0.75, 1]) {
      for (const duration of [0.125, 0.5, 1, 2.5, 4]) {
        const expected = new Float64Array(48);
        const endTick = (epoch + fraction) * 64;
        const ticks = duration * 64;
        for (let tick = endTick - ticks; tick < endTick; tick++) {
          const time = (tick + 0.5) / 64;
          if (time < 0.375) continue;
          const source = frames[Math.floor(time)];
          const column = Math.floor((time % 1) * 4);
          for (let y = 0; y < 2; y++) {
            for (const x of [column, column + 4]) {
              const index = (y * 8 + x) * 3;
              for (let channel = 0; channel < 3; channel++)
                expected[index + channel] += source[index + channel] * 4 / ticks;
            }
          }
        }
        const rounded = Uint16Array.from(expected, (value) => Math.min(65535, Math.round(value)));
        assert.deepEqual(sweep.cameraPixels(fraction, duration), rounded,
          `frame ${epoch}, phase ${fraction}, shutter ${duration}`);
      }
    }
    assert.ok(sweep.emissions.length <= 5);
  }
});

test('camera startup is black and complete static exposures preserve linear brightness', () => {
  const initial = frame(10000);
  const sweep = new PovSweep(8, 2, initial, 0.5);
  initial.fill(0);
  assert.deepEqual(sweep.cameraPixels(0.5, 2), frame(0));
  assert.deepEqual(row(sweep.cameraPixels(0.625, 2), 0), [0, 0, 2500, 0, 0, 0, 2500, 0]);
  for (let i = 0; i < 5; i++) sweep.beginFrame(frame(10000));
  for (const phase of [0, 0.125, 0.5, 0.875, 1]) {
    for (const duration of [1, 2, 4])
      assert.deepEqual(sweep.cameraPixels(phase, duration), frame(10000));
  }
  assert.deepEqual(row(sweep.cameraPixels(0.125, 0.125), 0),
    [40000, 0, 0, 0, 40000, 0, 0, 0]);
  sweep.beginFrame(frame(50000));
  assert.deepEqual(row(sweep.cameraPixels(0.125, 0.125), 0),
    [65535, 0, 0, 0, 65535, 0, 0, 0]);
});

test('camera seeks and marker overlays leave raw pixels and emission history unchanged', () => {
  const source = frame(10000);
  const sweep = new PovSweep(8, 2, source);
  sweep.beginFrame(frame(20000));
  source.fill(99);
  sweep.seek(0.5);
  const raw = sweep.pixels.slice();
  const captured = sweep.emissions.map(({ pixels }) => pixels.slice());
  const camera = sweep.cameraPixels(0.5, 1).slice();
  const marked = sweep.displayPixels(true, sweep.cameraPixels(0.5, 1));
  assert.equal(row(marked, 0).filter((value) => value === 65535).length, 2);
  assert.deepEqual(sweep.cameraPixels(0.5, 1), camera);
  assert.deepEqual(sweep.pixels, raw);
  assert.equal(sweep.displayPixels(false), sweep.pixels);
  sweep.seek(0);
  sweep.cameraPixels(0, 4);
  sweep.seek(0.5);
  assert.deepEqual(sweep.cameraPixels(0.5, 1), camera);
  assert.deepEqual(sweep.pixels, raw);
  assert.deepEqual(sweep.emissions.map(({ pixels }) => pixels), captured);
  sweep.replaceFrame(frame(30000));
  assert.deepEqual(sweep.cameraPixels(0.5, 1), camera);
  assert.deepEqual(sweep.emissions.map(({ pixels }) => pixels), captured);
  sweep.beginFrame(frame(40000));
  assert.deepEqual(sweep.emissions.at(-2).pixels, frame(20000));
});

test('camera exposure is continuous across column and half-turn boundaries', () => {
  const sweep = new PovSweep(8, 2, frame(10000));
  sweep.beginFrame(frame(20000));
  for (const phase of [0.25, 0.5, 0.75]) {
    const before = sweep.cameraPixels(phase - 1e-8, 1.5).slice();
    assert.deepEqual(sweep.cameraPixels(phase + 1e-8, 1.5), before);
  }
  const before = sweep.cameraPixels(1, 1.5).slice();
  sweep.beginFrame(frame(30000));
  assert.deepEqual(sweep.cameraPixels(0, 1.5), before);
});

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
