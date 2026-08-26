//
// The Pole LOD binding holds the near-pole decimation setting until the engine
// the module load builds exists to take it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPoleLodBinding } from '../pole_lod.js';

// The Pole LOD control is registered during module evaluation and DeepLinkGUI
// replays a URL-hydrated value's onChange right there, while the engine is
// still null — so the binding is the value's only durable home until the
// module load resolves.

/**
 * Build the binding over an engine that appears only when made to.
 * @returns {Object} The binding, the recorded pushes, and the engine switch.
 */
function makePoleLodBinding() {
  const pushed = [];
  const invalidations = { count: 0 };
  let engine = null;
  const binding = createPoleLodBinding({
    getEngine: () => engine,
    onChange: () => { invalidations.count += 1; },
  });
  return {
    binding,
    pushed,
    invalidations,
    loadEngine: () => { engine = { setPoleLod: (v) => pushed.push(v) }; },
  };
}

test('near-pole decimation is off until something turns it on', () => {
  const { binding } = makePoleLodBinding();

  assert.equal(binding.state.poleLod, 0,
    'the default must not enable decimation before any deep link is read');
});

test('a deep link applied before the engine exists still reaches it', () => {
  const h = makePoleLodBinding();

  h.binding.apply(1.5);
  assert.deepEqual(h.pushed, [], 'there is no engine yet to push into');

  h.loadEngine();
  h.binding.replay();

  assert.deepEqual(h.pushed, [1.5], 'the load carries the hydrated value in');
  assert.equal(h.invalidations.count, 1, 'the apply repainted; the replay need not');
});

test('a change made once the engine exists reaches it immediately', () => {
  const h = makePoleLodBinding();
  h.loadEngine();

  h.binding.apply(0.35);

  assert.deepEqual(h.pushed, [0.35]);
  assert.equal(h.binding.state.poleLod, 0.35, 'the state stays the durable home');
});

test('a replay before the engine loads is a no-op, not a crash', () => {
  const h = makePoleLodBinding();

  h.binding.replay();

  assert.deepEqual(h.pushed, []);
});
