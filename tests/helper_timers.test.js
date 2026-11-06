import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeTimers } from './helpers/fake_timers.js';

test('window timer rejects overlapping schedules and ignores stale cancellation handles', () => {
  const timer = fakeTimers();
  let fired = 0;
  const first = timer.setTimeout(() => { fired++; }, 1);
  assert.throws(() => timer.setTimeout(() => {}, 2), /only one timer/);
  timer.clearTimeout(first + 1);
  assert.equal(timer.armed(), true);
  timer.fire();
  const second = timer.setTimeout(() => { fired++; }, 1);
  assert.notEqual(second, first);
  timer.clearTimeout(first);
  timer.fire();
  assert.equal(fired, 2);
  const third = timer.setTimeout(() => {}, 1);
  timer.clearTimeout(third);
  assert.equal(timer.armed(), false);
  assert.equal(timer.handle, third);
  assert.deepEqual(timer.delays, [1, 1, 1]);
  assert.deepEqual(timer.cleared, [first + 1, first, third]);
  assert.throws(() => timer.fire(), /scheduled callback/);
});
