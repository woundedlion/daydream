import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FPS, SLOW_FRAME_MS } from '../src/renderer/frame_constants.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// One frame per side per revolution; the README's rotation row derives the cadence.
test('the simulation cadence matches the physical sphere', () => {
  const rotation = README.match(
    /\| Rotation \| (\d+) RPM \((\d+) revolutions\/second\), (\d+) FPS from (\d+) sides of the ring \|/);
  assert.ok(rotation, 'the README rotation row no longer states the cadence');
  const [, rpm, revsPerSecond, statedFps, sides] = rotation.map(Number);
  assert.equal(rpm / 60, revsPerSecond, 'the README RPM and revolutions/second disagree');
  assert.equal(revsPerSecond * sides, FPS, 'one frame per side per revolution');
  assert.equal(statedFps, FPS);
});

test('the slow-frame threshold is the exact frame budget', () => {
  assert.equal(SLOW_FRAME_MS, 1000 / FPS);
});
