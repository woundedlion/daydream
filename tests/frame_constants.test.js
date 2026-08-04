import test from 'node:test';
import assert from 'node:assert/strict';

import { FPS, SLOW_FRAME_MS } from '../frame_constants.js';

test('the slow-frame threshold is the frame budget rounded to a whole ms', () => {
  const budgetMs = 1000 / FPS;
  assert.ok(Number.isInteger(SLOW_FRAME_MS), 'the threshold is a whole millisecond');
  assert.ok(SLOW_FRAME_MS >= budgetMs, 'a frame inside its budget is never flagged slow');
  assert.ok(SLOW_FRAME_MS - budgetMs < 1, 'the threshold stays within a ms of the budget');
});
