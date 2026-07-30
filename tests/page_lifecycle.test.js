// @ts-nocheck
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { createFrameScheduler, onPageTeardown } = await import('../tools/page_lifecycle.js');

/**
 * Animation-frame double: callbacks queue until flush() runs them, and cancelled
 * handles are dropped. Handles start at 1 so none is falsy.
 */
function fakeFrames() {
  const queued = new Map();
  let nextHandle = 1;
  globalThis.requestAnimationFrame = (fn) => {
    const handle = nextHandle++;
    queued.set(handle, fn);
    return handle;
  };
  globalThis.cancelAnimationFrame = (handle) => queued.delete(handle);
  return {
    get pending() { return queued.size; },
    flush() {
      const fns = [...queued.values()];
      queued.clear();
      for (const fn of fns) fn();
    },
  };
}

const saved = {};
beforeEach(() => {
  saved.raf = globalThis.requestAnimationFrame;
  saved.caf = globalThis.cancelAnimationFrame;
  saved.window = globalThis.window;
});
afterEach(() => {
  globalThis.requestAnimationFrame = saved.raf;
  globalThis.cancelAnimationFrame = saved.caf;
  if (saved.window === undefined) delete globalThis.window;
  else globalThis.window = saved.window;
});

/** Verifies a scheduled run happens on the frame, not on the call. */
test('createFrameScheduler defers the run to the next frame', () => {
  const frames = fakeFrames();
  let runs = 0;
  const schedule = createFrameScheduler(() => { runs++; });

  schedule();
  assert.equal(runs, 0);
  frames.flush();
  assert.equal(runs, 1);
});

/** Verifies a burst of requests in one frame coalesces to a single run. */
test('createFrameScheduler coalesces a burst into one run', () => {
  const frames = fakeFrames();
  let runs = 0;
  const schedule = createFrameScheduler(() => { runs++; });

  for (let i = 0; i < 50; i++) schedule();
  assert.equal(frames.pending, 1);
  frames.flush();
  assert.equal(runs, 1);
});

/** Verifies the next frame is schedulable again once the pending one has run. */
test('createFrameScheduler re-arms after the frame runs', () => {
  const frames = fakeFrames();
  let runs = 0;
  const schedule = createFrameScheduler(() => { runs++; });

  schedule();
  frames.flush();
  schedule();
  frames.flush();
  assert.equal(runs, 2);
});

/** Verifies a request made from inside the run itself lands on a later frame. */
test('createFrameScheduler accepts a request made during its own run', () => {
  const frames = fakeFrames();
  const order = [];
  const schedule = createFrameScheduler(() => {
    order.push('run');
    if (order.length === 1) schedule();
  });

  schedule();
  frames.flush();
  assert.equal(frames.pending, 1);
  frames.flush();
  assert.deepEqual(order, ['run', 'run']);
});

/** Verifies cancel() drops the pending frame, so a torn-down page never recomputes. */
test('cancel drops a pending run', () => {
  const frames = fakeFrames();
  let runs = 0;
  const schedule = createFrameScheduler(() => { runs++; });

  schedule();
  schedule.cancel();
  assert.equal(frames.pending, 0);
  frames.flush();
  assert.equal(runs, 0);
});

/** Verifies cancel() with nothing pending is a no-op rather than cancelling frame 0. */
test('cancel with nothing pending cancels nothing', () => {
  const frames = fakeFrames();
  const cancelled = [];
  const realCancel = globalThis.cancelAnimationFrame;
  globalThis.cancelAnimationFrame = (handle) => { cancelled.push(handle); realCancel(handle); };

  const schedule = createFrameScheduler(() => {});
  schedule.cancel();
  schedule.cancel();
  assert.deepEqual(cancelled, []);

  // A cancelled scheduler still works afterwards.
  schedule();
  assert.equal(frames.pending, 1);
});

/** Verifies a scheduler is usable again after a cancel, so a restored page recovers. */
test('a cancelled scheduler can be scheduled again', () => {
  const frames = fakeFrames();
  let runs = 0;
  const schedule = createFrameScheduler(() => { runs++; });

  schedule();
  schedule.cancel();
  schedule();
  frames.flush();
  assert.equal(runs, 1);
});

/** Verifies two schedulers keep independent pending state. */
test('schedulers do not share pending state', () => {
  const frames = fakeFrames();
  const runs = [];
  const a = createFrameScheduler(() => runs.push('a'));
  const b = createFrameScheduler(() => runs.push('b'));

  a();
  b();
  a.cancel();
  frames.flush();
  assert.deepEqual(runs, ['b']);
});

/**
 * Window double capturing the pagehide listener, so a test can fire the event
 * with either persisted value.
 */
function fakeWindow() {
  const listeners = [];
  globalThis.window = {
    addEventListener(type, handler) { listeners.push({ type, handler }); },
  };
  return {
    get types() { return listeners.map((l) => l.type); },
    fire(persisted) {
      for (const l of listeners) l.handler({ persisted });
    },
  };
}

/** Verifies the hook listens on pagehide, the event that respects the bfcache. */
test('onPageTeardown listens on pagehide', () => {
  const win = fakeWindow();
  onPageTeardown(() => {});
  assert.deepEqual(win.types, ['pagehide']);
});

/** Verifies a real discard runs the teardown. */
test('onPageTeardown runs the teardown on a real discard', () => {
  const win = fakeWindow();
  let torn = 0;
  onPageTeardown(() => { torn++; });
  win.fire(false);
  assert.equal(torn, 1);
});

/** Verifies a bfcache freeze leaves the page's resources alone, so it restores intact. */
test('onPageTeardown skips a bfcache freeze', () => {
  const win = fakeWindow();
  let torn = 0;
  onPageTeardown(() => { torn++; });
  win.fire(true);
  assert.equal(torn, 0);
  // The listener stays armed: a freeze must not consume the teardown.
  win.fire(false);
  assert.equal(torn, 1);
});

/** Verifies several teardowns on one page all run, since each owns different resources. */
test('onPageTeardown supports several independent teardowns', () => {
  const win = fakeWindow();
  const order = [];
  onPageTeardown(() => order.push('timers'));
  onPageTeardown(() => order.push('scene'));
  win.fire(false);
  assert.deepEqual(order, ['timers', 'scene']);
});

/** Verifies the two helpers compose the way the pages wire them: teardown cancels the pending frame. */
test('a teardown cancels the scheduler pending frame', () => {
  const frames = fakeFrames();
  const win = fakeWindow();
  let runs = 0;
  const schedule = createFrameScheduler(() => { runs++; });
  onPageTeardown(() => schedule.cancel());

  schedule();
  win.fire(false);
  frames.flush();
  assert.equal(runs, 0);
});
