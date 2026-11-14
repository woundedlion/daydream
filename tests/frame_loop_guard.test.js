// The render loop guard: frame failure containment and the dead-module latch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFrameLoopGuard,
  FRAME_GUARD_REARM_FRAMES,
  MODULE_TRAP_NOTICE,
} from '../src/app/frame_loop_guard.js';

// The render loop guard: a throw escaping the frame callback stops Three.js re-arming it.

/**
 * Guard under test over a frame body the test drives, plus the sinks it writes to.
 * @param {() => void} frame - The per-frame body.
 * @param {Object} [deps] - Death-latch collaborators, defaulted off.
 * @param {() => boolean} [deps.moduleDead] - Reads the module's death flag.
 * @param {() => void} [deps.onModuleDead] - Releases the app on a dead module.
 * @returns {Object} The guarded callback, the reported messages, and the console lines.
 */
function makeFrameGuard(frame, deps = {}) {
  const reported = [];
  const logged = [];
  const guarded = createFrameLoopGuard({
    frame,
    report: (message) => reported.push(message),
    logError: (...args) => logged.push(args),
    ...deps,
  });
  return { guarded, reported, logged };
}

test('a throwing frame is contained and the loop keeps calling the body', () => {
  let calls = 0;
  const { guarded, reported } = makeFrameGuard(() => {
    calls += 1;
    if (calls === 1) throw new Error('view detached');
  });

  guarded();
  guarded();

  assert.equal(calls, 2, 'a contained throw must not stop the frames that follow');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /view detached/);
});

test('a frame that throws every tick reports once', () => {
  const { guarded, reported, logged } = makeFrameGuard(() => {
    throw new Error('boom');
  });

  for (let i = 0; i < 5; i++) guarded();

  assert.equal(reported.length, 1, 'the banner must not be rewritten 60 times a second');
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /frame failed/);
});

test('a failing reporter cannot skip dead-module release', () => {
  let released = false;
  const errors = [];
  const guarded = createFrameLoopGuard({
    frame() {},
    report() { throw new Error('report unavailable'); },
    logError: (...args) => errors.push(args),
    moduleDead: () => true,
    onModuleDead() { released = true; },
  });
  assert.doesNotThrow(guarded);
  assert.equal(released, true);
  assert.match(errors.at(-1)[0], /reporting failed/);
  assert.equal(errors.at(-1)[1].message, 'report unavailable');
});

test('a failing frame reporter preserves the recovery message', () => {
  let failed = true;
  let attempted = '';
  const cleared = [];
  const guarded = createFrameLoopGuard({
    frame() { if (failed) throw new Error('view detached'); },
    report(message) { attempted = message; throw new Error('report unavailable'); },
    clearReport(message) { cleared.push(message); },
    logError() {},
  });
  assert.doesNotThrow(guarded);
  assert.match(attempted, /view detached/);
  failed = false;
  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES; ++i) guarded();
  assert.deepEqual(cleared, [attempted]);
});

test('a loop that recovers reports its next failure again', () => {
  let boom = true;
  const { guarded, reported, logged } = makeFrameGuard(() => {
    if (boom) throw new Error('view detached');
  });

  guarded();
  boom = false;
  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES - 1; i++) guarded();
  boom = true;
  guarded();
  assert.equal(reported.length, 1,
    'a clean run short of the re-arm keeps the latch, so an intermittent throw '
    + 'cannot report at display rate');

  boom = false;
  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES; i++) guarded();
  boom = true;
  guarded();

  assert.equal(reported.length, 2,
    'a failure after the loop recovered must not be swallowed for the page lifetime');
  assert.equal(logged.length, 2);
});

test('a frame guard stringifies a thrown value carrying no message', () => {
  const { guarded, reported } = makeFrameGuard(() => { throw 'aborted'; });

  guarded();

  assert.match(reported[0], /aborted/);
});

// A terminal module flag stops frames even when the simulated frame body returns normally.

test('a thrown RuntimeError latches module death without a separate death flag', () => {
  let frames = 0;
  let releases = 0;
  const { guarded, reported } = makeFrameGuard(() => {
    frames += 1;
    throw new WebAssembly.RuntimeError('unreachable');
  }, {
    moduleDead: (error) => error instanceof WebAssembly.RuntimeError,
    onModuleDead: () => { releases += 1; },
  });

  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES * 2; i++) guarded();

  assert.equal(frames, 1);
  assert.equal(releases, 1);
  assert.deepEqual(reported, [MODULE_TRAP_NOTICE]);
});

test('a dead module stops the frames, releases the app, and names the reload', () => {
  let frames = 0;
  let dead = false;
  let releases = 0;
  const { guarded, reported, logged } = makeFrameGuard(
    () => { frames += 1; },
    { moduleDead: () => dead, onModuleDead: () => { releases += 1; } });

  guarded();
  dead = true;
  guarded();
  guarded();

  assert.equal(frames, 1, 'the body must not run when the module is dead on entry');
  assert.equal(releases, 1, 'the release runs once, not per frame');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /Reload the page/,
    'no call recovers a trapped module, so the banner has to say what does');
  assert.equal(logged.length, 1);
});

test('a dead module is polled on a clean frame, not only on a throw', () => {
  let dead = false;
  let frames = 0;
  const { guarded, reported } = makeFrameGuard(
    () => { frames += 1; dead = true; }, { moduleDead: () => dead });

  guarded();
  guarded();

  assert.equal(frames, 1);
  assert.equal(reported.length, 1,
    'a trapped module hands back plausible frames; waiting for a throw waits '
    + 'for one that never comes');
});

test('a dead module latches past the clean-frame re-arm', () => {
  let dead = false;
  let releases = 0;
  const { guarded, reported } = makeFrameGuard(
    () => { if (!dead) throw new Error('view detached'); },
    { moduleDead: () => dead, onModuleDead: () => { releases += 1; } });

  guarded();
  assert.equal(reported.length, 1);
  dead = true;
  guarded();
  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES * 2; i++) guarded();

  assert.equal(reported.length, 2,
    'death is terminal, so no run of clean frames retracts its banner');
  assert.match(reported[1], /Reload the page/,
    'the terminal report is the one left standing');
  assert.equal(releases, 1);
});

test('a release that throws still leaves the loop stopped', () => {
  let frames = 0;
  const { guarded } = makeFrameGuard(
    () => { frames += 1; },
    {
      moduleDead: () => true,
      onModuleDead: () => { throw new Error('teardown failed'); },
    });

  assert.throws(() => guarded(), /teardown failed/);
  guarded();

  assert.equal(frames, 0, 'the latch is set before the release is attempted');
});

test('a clean recovery clears its own report after the rearm window', () => {
  let fail = true;
  const cleared = [];
  const reported = [];
  const guarded = createFrameLoopGuard({
    frame: () => { if (fail) throw new Error('transient'); },
    report: (message) => reported.push(message),
    clearReport: (message) => cleared.push(message),
    logError: () => {},
  });
  guarded();
  fail = false;
  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES - 1; i++) guarded();
  assert.deepEqual(cleared, []);
  guarded();
  assert.equal(reported.length, 1);
  assert.deepEqual(cleared, reported);
});
