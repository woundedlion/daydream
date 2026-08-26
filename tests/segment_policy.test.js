//
// The segmented pool's spawn policy: a toggle burst leaves several warm-up
// continuations in flight against one pool, and a failed spawn or teardown has
// to leave the app on the single engine with the user told why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSegmentSpawnGuard, createSegmentedFallback } from '../segment_policy.js';

// The segmented spawn guard: spawning awaits a module warm-up, so a toggle burst
// leaves several continuations in flight against one worker pool.

/**
 * Build the spawn guard over warm-ups the test resolves by hand.
 * @returns {Object} The guard, the pending warm-ups, the spawn log, and the
 *   segmented-mode switch the post-await check reads.
 */
function makeSpawnGuard() {
  const warms = [];
  const spawns = [];
  const mode = { active: false };
  const guard = createSegmentSpawnGuard({
    warmModules: () => new Promise((resolve, reject) => {
      warms.push({ resolve, reject });
    }),
    spawn: () => spawns.push('create'),
    isActive: () => mode.active,
  });
  return { guard, warms, spawns, mode };
}

test('an on/off/on burst spawns one worker pool, not two', async () => {
  const h = makeSpawnGuard();

  h.mode.active = true;
  const first = h.guard.respawn();
  h.mode.active = false;
  h.guard.strand();
  h.mode.active = true;
  const second = h.guard.respawn();

  h.warms[0].resolve();
  h.warms[1].resolve();

  assert.equal(await first, false, 'the superseded attempt is stranded');
  assert.equal(await second, true);
  assert.deepEqual(h.spawns, ['create']);
});

test('the last attempt is the one that spawns, whatever order they resume in', async () => {
  const h = makeSpawnGuard();
  h.mode.active = true;

  const first = h.guard.respawn();
  const second = h.guard.respawn();
  h.warms[1].resolve();
  h.warms[0].resolve();

  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.deepEqual(h.spawns, ['create'], 'two pools would double the worker count');
});

test('a strand lands on a continuation still awaiting the warm-up', async () => {
  const h = makeSpawnGuard();
  h.mode.active = true;

  const attempt = h.guard.respawn();
  h.guard.strand(); // the page discard / pool failure path
  h.warms[0].resolve();

  assert.equal(await attempt, false);
  assert.deepEqual(h.spawns, [], 'a spawn here builds workers into a dead page');
});

test('an attempt that resumes with segmented mode off spawns nothing', async () => {
  const h = makeSpawnGuard();
  h.mode.active = true;

  const attempt = h.guard.respawn();
  h.mode.active = false;
  h.warms[0].resolve();

  assert.equal(await attempt, false);
  assert.deepEqual(h.spawns, []);
});

test('a failed warm-up rejects so the caller can fall back', async () => {
  const h = makeSpawnGuard();
  h.mode.active = true;

  const attempt = h.guard.respawn();
  h.warms[0].reject(new Error('offline'));

  await assert.rejects(attempt, /offline/);
  assert.deepEqual(h.spawns, []);
});

// What the caller falls back with. Its order is the contract: the flag goes
// false before the strand and the teardown, or a continuation resuming mid-way
// spawns a pool behind the single engine the app just fell back to.

/**
 * Build the fallback over a recording segment-controller double.
 * @returns {Object} The fallback, the ordered log, and the controller double.
 */
function makeSegmentedFallback() {
  const order = [];
  const notices = [];
  const logs = [];
  let active = true;
  const segments = {
    destroy: () => order.push('destroy'),
    updateStats: () => order.push('updateStats'),
  };
  // An accessor, as the real controller has, so the write's position is visible.
  Object.defineProperty(segments, 'active', {
    enumerable: true,
    get: () => active,
    set: (v) => { active = v; order.push(`active=${v}`); },
  });
  const fallback = createSegmentedFallback({
    segments,
    strand: () => order.push('strand'),
    showNotice: (message) => { order.push('notice'); notices.push(message); },
    showToggle: (on) => order.push(`toggle=${on}`),
    logError: (message, err) => logs.push([message, err]),
  });
  return { fallback, order, notices, logs, segments };
}

test('the segmented fallback clears the flag before it strands or tears down', () => {
  const h = makeSegmentedFallback();

  h.fallback('enable', new Error('no workers'));

  assert.deepEqual(h.order,
    ['notice', 'active=false', 'strand', 'destroy', 'updateStats', 'toggle=false'],
    'a strand or a destroy ahead of the flag leaves a window a resuming '
    + 'continuation can spawn into');
  assert.equal(h.segments.active, false, 'the host is left inactive');
});

test('the segmented fallback names what failed in both the notice and the log', () => {
  const h = makeSegmentedFallback();
  const err = new Error('no workers');

  h.fallback('resize', err);

  assert.match(h.notices[0], /resize/, 'the notice names the operation');
  assert.match(h.notices[0], /no workers/, 'and the reason');
  assert.match(h.notices[0], /single engine/, 'and what the app fell back to');
  assert.equal(h.logs.length, 1, 'the console gets the thrown value too');
  assert.equal(h.logs[0][1], err, 'unwrapped, so its stack survives');
});

test('the segmented fallback reports a thrown non-Error', () => {
  const h = makeSegmentedFallback();

  h.fallback('teardown', 'worker exploded');

  assert.match(h.notices[0], /worker exploded/,
    'a rejection carrying a bare string must not read as "[object Object]"');
});
