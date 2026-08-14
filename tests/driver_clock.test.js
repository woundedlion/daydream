//
// Daydream.advanceFrameClock is the fixed-timestep gate for the main (non-
// segmented) render loop: it accrues real elapsed time, clamps the backlog to
// avoid a spiral-of-death, and consumes at most one frame interval per call. It
// reads only this.clock/paused/timeAccumulator/frameInterval plus the static
// backlog cap, so it runs standalone via prototype.call over a stubbed `this`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Daydream } from '../driver.js';

const FRAME_INTERVAL = 1 / Daydream.FPS;
const MAX_BACKLOG = Daydream.MAX_FRAME_BACKLOG_SECONDS;

/** Minimal `this` for advanceFrameClock: a drain-counting timer plus the fields
 *  it reads. */
function fixture({ delta, paused = false, timeAccumulator = 0 }) {
  const ctx = {
    clock: {
      update: () => { ctx.updateCalls++; },
      getDelta: () => { ctx.getDeltaCalls++; return delta; },
    },
    paused,
    timeAccumulator,
    frameInterval: FRAME_INTERVAL,
    updateCalls: 0,
    getDeltaCalls: 0,
  };
  return ctx;
}
const advance = (ctx) => Daydream.prototype.advanceFrameClock.call(ctx);

test('paused clock neither advances nor accrues backlog', () => {
  const ctx = fixture({ delta: 1, paused: true });
  assert.equal(advance(ctx), false, 'a paused clock advanced a frame');
  assert.equal(ctx.timeAccumulator, 0, 'a paused clock accrued backlog');
  assert.equal(ctx.updateCalls, 1, 'the timer was not updated exactly once');
  assert.equal(ctx.getDeltaCalls, 1, 'the elapsed time was not drained exactly once');
});

test('sub-interval elapsed accrues but does not advance', () => {
  const ctx = fixture({ delta: FRAME_INTERVAL / 2 });
  assert.equal(advance(ctx), false, 'a sub-interval elapsed advanced a frame');
  assert.ok(Math.abs(ctx.timeAccumulator - FRAME_INTERVAL / 2) < 1e-9,
    'the sub-interval elapsed was not accrued');
});

test('a full interval advances one frame and keeps the remainder', () => {
  const ctx = fixture({ delta: FRAME_INTERVAL + 0.01 });
  assert.equal(advance(ctx), true, 'a full interval did not advance a frame');
  assert.ok(Math.abs(ctx.timeAccumulator - 0.01) < 1e-9,
    'the remainder past one interval was not kept');
});

test('a long stall advances at most one frame and drops the excess backlog', () => {
  const ctx = fixture({ delta: 10 });
  assert.equal(advance(ctx), true, 'a long stall did not advance a frame');
  assert.ok(Math.abs(ctx.timeAccumulator - (MAX_BACKLOG - FRAME_INTERVAL)) < 1e-9,
    'the backlog was not clamped to the cap');
});
