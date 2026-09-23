import assert from 'node:assert/strict';
//
// Timer doubles the app's injected schedule/cancel pairs are driven through.

/**
 * Recording stand-in for the schedule/cancel pair: it keeps the last callback
 * and delay handed to schedule(), hands back a fresh handle each time, and
 * records every handle passed to cancel(). One callback is pending at a time,
 * which is the contract the factories taking this pair hold.
 * @returns {Object} The recorder, carrying the schedule/cancel pair to inject.
 */
export function fakeScheduler() {
  const timer = {
    fn: null,
    ms: null,
    handle: 0,
    cancelled: [],
    schedule: (fn, ms) => { timer.fn = fn; timer.ms = ms; return ++timer.handle; },
    cancel: (handle) => { timer.cancelled.push(handle); timer.fn = null; },
    /** Runs the pending callback. @returns {void} */
    fire: () => { timer.fn(); },
  };
  return timer;
}

/**
 * @typedef {Object} FakeTimer
 * @property {Function} fn - Callback the production code scheduled.
 * @property {number} delay - Delay it was scheduled at, which names it: each
 *   deadline in segment_controller.js has a distinct one.
 * @property {object} handle - Token setTimeout returned, keyed on by clearTimeout.
 */

/**
 * Swap in a setTimeout/clearTimeout pair that records timers instead of
 * scheduling them, so a test drives the watchdogs and boot backoff by hand and
 * can see a cancellation. A cleared or fired timer leaves the pending set but
 * stays in `timers`, which holds every arm in order.
 * @returns {{timers: Array<FakeTimer>, pendingAt: (delay: number) => Array<FakeTimer>,
 *   isPending: (timer: FakeTimer) => boolean, fire: (timer: FakeTimer) => void,
 *   fireOnly: (delay: number, message: string) => void, restore: () => void}}
 */
export const installFakeTimers = () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  /** @type {Array<FakeTimer>} */
  const timers = [];
  /** @type {Map<object, FakeTimer>} */
  const pending = new Map();
  globalThis.setTimeout = (fn, delay) => {
    const handle = { unref() {} };
    const timer = { fn, delay, handle };
    timers.push(timer);
    pending.set(handle, timer);
    return handle;
  };
  // A handle armed before the swap belongs to the real timer queue, so hand it
  // back rather than silently dropping the cancellation.
  globalThis.clearTimeout = (handle) => {
    if (pending.delete(handle)) return;
    realClearTimeout(handle);
  };
  const isPending = (timer) => pending.has(timer.handle);
  const fire = (timer) => {
    pending.delete(timer.handle);
    timer.fn();
  };
  const pendingAt = (delay) =>
    [...pending.values()].filter((timer) => timer.delay === delay);
  const fireOnly = (delay, message) => {
    const matches = pendingAt(delay);
    assert.equal(matches.length, 1, message);
    fire(matches[0]);
  };
  return {
    timers,
    pendingAt,
    isPending,
    fire,
    fireOnly,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
};


/**
 * @param {() => Promise<void>} body - Work that queues timeout callbacks.
 * @returns {Promise<Function[]>} Captured callbacks, without running them.
 */
export async function captureTimeouts(body) {
  const clock = installFakeTimers();
  try { await body(); } finally { clock.restore(); }
  return clock.timers.map(({ fn }) => fn);
}

/**
 * A timer source a case fires by hand.
 * @returns {Object} The stand-in, plus the pending timers and the clears seen.
 */
export function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    cleared: [],
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      this.cleared.push(id);
      pending.delete(id);
    },
    /** Runs the one pending timer. @returns {void} */
    fire() {
      const [id, { fn }] = [...pending][0];
      pending.delete(id);
      fn();
    },
  };
}

/**
 * A one-slot timer source a URLSync case fires by hand, shaped to sit on a
 * window stub as the timer surface URLSync arms against.
 * @returns {Object} The stand-in and its scheduled delays.
 */
export function fakeUrlTimer() {
  const delays = [];
  let pending = null;
  return {
    delays,
    setTimeout(fn, ms) {
      pending = fn;
      delays.push(ms);
      return 0;
    },
    clearTimeout() { pending = null; },
    /** @returns {boolean} Whether a timer is currently armed. */
    armed() { return pending !== null; },
    /** Runs the pending timer. @returns {void} */
    fire() {
      const fn = pending;
      pending = null;
      assert.ok(fn, 'a timer is pending');
      fn();
    },
  };
}
