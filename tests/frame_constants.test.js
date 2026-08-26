import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { FPS, SLOW_FRAME_MS } from '../frame_constants.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// The cadence is a fact about the ring, not a tunable: the sphere draws one
// frame per side per revolution, so the README's rotation row derives it.
test('the simulation cadence matches the physical sphere', () => {
  const rotation = README.match(
    /\| Rotation \| (\d+) RPM \((\d+) revolutions\/second\), (\d+) FPS from (\d+) sides of the ring \|/);
  assert.ok(rotation, 'the README rotation row no longer states the cadence');
  const [, rpm, revsPerSecond, statedFps, sides] = rotation.map(Number);
  assert.equal(rpm / 60, revsPerSecond, 'the README RPM and revolutions/second disagree');
  assert.equal(revsPerSecond * sides, FPS, 'one frame per side per revolution');
  assert.equal(statedFps, FPS);
});

test('the slow-frame threshold is the frame budget rounded to a whole ms', () => {
  const budgetMs = 1000 / FPS;
  assert.ok(Number.isInteger(SLOW_FRAME_MS), 'the threshold is a whole millisecond');
  assert.ok(Math.abs(SLOW_FRAME_MS - budgetMs) <= 0.5,
    `the threshold rounds to the nearest ms, got ${SLOW_FRAME_MS} for a ${budgetMs}ms budget`);
});
