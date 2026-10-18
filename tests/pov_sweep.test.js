import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PovSweep, sustainedSurvival } from '../src/renderer/pov_sweep.js';

const frame = (value) => new Uint16Array(8 * 2 * 3).fill(value);
const row = (pixels, y) => Array.from({ length: 8 }, (_, x) => pixels[(y * 8 + x) * 3]);

test('effect replacement removes outgoing light from every hemisphere and history epoch', () => {
  const old = frame(0), incoming = frame(0);
  for (let i = 0; i < old.length; i += 3) {
    old[i] = 20000;
    incoming[i + 1] = 18000;
  }
  const sweep = new PovSweep(8, 2, old, 0.8);
  sweep.reset(incoming);
  assert.deepEqual(sweep.source, incoming);
  assert.deepEqual(sweep.previous, incoming);
  assert.deepEqual(sweep.pixels, incoming);
  for (const fraction of [0, 0.2, 0.9]) {
    const visible = sweep.visualPixels(fraction);
    for (let i = 0; i < visible.length; i += 3) {
      assert.equal(visible[i], 0);
      assert.ok(visible[i + 1] > 0, 'replacement is visible across the full sphere');
    }
  }
  sweep.beginFrame(incoming);
  assert.ok(sweep.emissions.every(entry => entry.pixels.every((v, i) => v === incoming[i])));
});

test('visual response matches independent quadrature of the sustained gamma density', () => {
  const frames = Array.from({ length: 10 }, (_, epoch) => new Uint16Array(
    Array.from({ length: 48 }, (_, index) => 800 + epoch * 500 + index * 11)));
  for (const frameMs of [62.5, 40]) {
    const sweep = new PovSweep(8, 2, frames[0], 0.375, frameMs);
    for (let epoch = 0; epoch < frames.length; epoch++) {
      if (epoch) sweep.beginFrame(frames[epoch]);
      for (const scale of [0.5, 1, 2]) {
        for (const fraction of [0, 0.375, 0.8125]) {
          const expected = new Float64Array(48);
          const now = (epoch + fraction) * frameMs;
          const tau = 4.94 * scale;
          for (let past = 0; past <= epoch; past++) {
            for (let column = 0; column < 4; column++) {
              const start = Math.max(past + column / 4, 0.375) * frameMs;
              const end = Math.min((past + (column + 1) / 4) * frameMs, now);
              if (end <= start) continue;
              const dt = (end - start) / 256;
              let weight = 0;
              for (let sample = 0; sample < 256; sample++) {
                const age = (now - start - (sample + 0.5) * dt) / tau;
                weight += age ** 8 * Math.exp(-age) / (tau * 40320) * dt * 4;
              }
              for (let y = 0; y < 2; y++) {
                for (const x of [column, column + 4]) {
                  for (let channel = 0; channel < 3; channel++) {
                    const index = (y * 8 + x) * 3 + channel;
                    expected[index] += frames[past][index] * weight;
                  }
                }
              }
            }
          }
          const actual = sweep.visualPixels(fraction, scale);
          for (let i = 0; i < actual.length; i++)
            assert.ok(Math.abs(actual[i] - Math.round(expected[i])) <= 1,
              `${frameMs}ms frame ${epoch} phase ${fraction} scale ${scale} channel ${i}`);
        }
      }
    }
  }
});

test('visual response preserves periodic mean and the gamma frequency gain and phase', () => {
  const sweep = new PovSweep(8, 2, frame(10000));
  for (let i = 0; i < 10; i++) sweep.beginFrame(frame(10000));
  for (const scale of [0.5, 1, 2]) {
    const samples = 2048;
    let mean = 0, real = 0, imaginary = 0;
    let minimum = Infinity, maximum = 0;
    for (let i = 0; i < samples; i++) {
      const phase = i / samples;
      const value = sweep.visualPixels(phase, scale)[0];
      mean += value / samples;
      real += value * Math.cos(2 * Math.PI * phase) * 2 / samples / 10000;
      imaginary -= value * Math.sin(2 * Math.PI * phase) * 2 / samples / 10000;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    const omegaTau = 2 * Math.PI * 16 * 0.00494 * scale;
    const gain = (1 + omegaTau ** 2) ** -4.5;
    const phase = -Math.PI / 4 - 9 * Math.atan(omegaTau);
    const amplitude = 2 * Math.sin(Math.PI / 4) / (Math.PI / 4) * gain;
    assert.ok(Math.abs(mean - 10000) < 0.1);
    assert.ok(maximum - minimum > 1000, 'phase-dependent modulation remains');
    assert.ok(Math.abs(real - amplitude * Math.cos(phase)) < 0.0001);
    assert.ok(Math.abs(imaginary - amplitude * Math.sin(phase)) < 0.0001);
  }
});

test('visual response has causal startup and continuous column and half-turn boundaries', () => {
  const sweep = new PovSweep(8, 2, frame(10000), 0.5);
  assert.deepEqual(sweep.visualPixels(0.5), frame(0));
  assert.deepEqual(sweep.visualPixels(0.500001), frame(0));
  assert.ok(sweep.visualPixels(0.9)[2 * 3] > 0);
  assert.equal(sweep.visualPixels(0.9)[0], 0);
  sweep.beginFrame(frame(20000));
  for (const phase of [0.25, 0.5, 0.75]) {
    const before = sweep.visualPixels(phase - 1e-8).slice();
    assert.deepEqual(sweep.visualPixels(phase + 1e-8), before);
  }
  const before = sweep.visualPixels(1).slice();
  sweep.beginFrame(frame(30000));
  assert.deepEqual(sweep.visualPixels(0), before);
});

test('visual front differences converge with column spacing while held jumps remain', () => {
  const visualJumps = [];
  for (const width of [288, 576, 1152, 2304]) {
    const half = width / 2;
    const ramp = (epoch) => Uint16Array.from({ length: width * 3 },
      (_, index) => Math.round(2000 + 500 * (epoch + Math.floor(index / 3) % half / half)));
    const sweep = new PovSweep(width, 1, ramp(0));
    for (let epoch = 1; epoch <= 12; epoch++) sweep.beginFrame(ramp(epoch));
    sweep.advance(0.5);
    const frontJump = (pixels) => {
      let maximum = 0;
      for (let x = half / 2 - 2; x <= half / 2 + 1; x++)
        maximum = Math.max(maximum, Math.abs(pixels[x * 3] - pixels[(x + 1) * 3]));
      return maximum;
    };
    assert.ok(frontJump(sweep.pixels) >= 490);
    visualJumps.push(frontJump(sweep.visualPixels(0.5)));
  }
  assert.ok(visualJumps[0] < 200);
  for (let i = 1; i < visualJumps.length; i++)
    assert.ok(Math.abs(visualJumps[i] * 2 - visualJumps[i - 1]) <= 8,
      `doubling column density should halve adjacent differences: ${visualJumps}`);
});

test('visual history bounds cover the slowest response tail', () => {
  let tail = 0;
  for (let age = 40.005; age < 100; age += 0.01)
    tail += age ** 8 * Math.exp(-age) / 40320 * 0.01;
  assert.ok(Math.abs(sustainedSurvival(40) - tail) < 1e-14);
  assert.ok(tail > 8.56e-10 && tail < 8.58e-10);
  for (const frameMs of [62.5, 40, 100]) {
    const sweep = new PovSweep(8, 2, frame(10000), 0, frameMs);
    for (let i = 0; i < 30; i++) sweep.beginFrame(frame(10000));
    assert.equal(sweep.emissions.length, Math.ceil(40 * 4.94 * 2 / frameMs) + 1);
    assert.ok((sweep.emissions.length - 1) * frameMs >= 40 * 4.94 * 2);
    if (frameMs === 62.5) assert.equal(sweep.emissions.length, 8);
  }
});

test('visual scale, seek, and paused replacement preserve source frames', () => {
  const sweep = new PovSweep(8, 2, frame(10000));
  sweep.beginFrame(frame(20000));
  sweep.seek(0.5);
  const history = sweep.emissions.map(({ pixels }) => pixels.slice());
  const raw = sweep.pixels.slice();
  const visual = sweep.visualPixels(0.5).slice();
  assert.notDeepEqual(sweep.visualPixels(0.5, 2), visual);
  sweep.seek(0);
  sweep.visualPixels(0);
  sweep.seek(0.5);
  assert.deepEqual(sweep.visualPixels(0.5), visual);
  sweep.displayPixels(true, sweep.visualPixels(0.5));
  assert.deepEqual(sweep.pixels, raw);
  sweep.replaceFrame(frame(30000));
  assert.deepEqual(sweep.visualPixels(0.5), visual);
  assert.deepEqual(sweep.emissions.map(({ pixels }) => pixels), history);
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
