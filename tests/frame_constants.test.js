import test from 'node:test';
import assert from 'node:assert/strict';

import { FPS, SLOW_FRAME_MS } from '../frame_constants.js';

test('slow-frame threshold follows the simulation frame rate', () => {
  assert.equal(SLOW_FRAME_MS, Math.round(1000 / FPS));
});
