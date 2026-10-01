import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDisplayCapsBinding } from '../src/renderer/display_caps.js';

test('caps replay defaults and pre-load edits using the accepted engine angles', () => {
  let engine = null;
  const pushed = [], changed = [];
  const binding = createDisplayCapsBinding({ getEngine: () => engine, onChange: (g) => changed.push(g) });
  assert.deepEqual(binding.state, { topCap: 0, bottomCap: 0 });
  binding.state.topCap = 2;
  binding.state.bottomCap = 3;
  assert.equal(binding.apply(), true);
  assert.deepEqual(changed, []);
  engine = {
    setDisplayCaps: (...caps) => { pushed.push(caps); return true; },
    getDisplayNorthPhi: () => 0.06283185,
    getDisplaySouthPhi: () => 3.047344,
  };
  assert.equal(binding.replay(), true);
  assert.deepEqual(pushed, [[2, 3]]);
  assert.deepEqual(changed[0], { DISPLAY_NORTH_PHI: 0.06283185, DISPLAY_SOUTH_PHI: 3.047344 });
  binding.state.topCap = binding.state.bottomCap = 0;
  assert.equal(binding.apply(), true);
  assert.deepEqual(pushed.at(-1), [0, 0]);
  assert.equal(changed.length, 2);
});

test('invalid or rejected caps do not publish geometry', () => {
  const binding = createDisplayCapsBinding({
    getEngine: () => ({ setDisplayCaps: () => false }),
    onChange: () => assert.fail('rejected geometry published'),
  });
  assert.equal(binding.apply(), false);
  let calls = 0;
  const accepting = createDisplayCapsBinding({
    getEngine: () => ({ setDisplayCaps: () => { calls++; return true; } }),
    onChange: () => assert.fail('invalid geometry published'),
  });
  for (const value of [-1, 25.1, NaN, Infinity]) {
    accepting.state.topCap = value;
    assert.equal(accepting.apply(), false);
    assert.equal(calls, 0);
  }
});
