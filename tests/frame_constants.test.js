import test from 'node:test';
import assert from 'node:assert/strict';

import { FPS, SLOW_FRAME_MS } from '../frame_constants.js';

test('simulation frame rate and slow-frame threshold are the shipped values', () => {
  assert.equal(FPS, 16);
  assert.equal(SLOW_FRAME_MS, 63);
});
