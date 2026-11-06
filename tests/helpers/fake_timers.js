// Timer doubles the app's injected schedule/cancel pairs are driven through.
import assert from 'node:assert/strict';

/**
 * Recording stand-in for the schedule/cancel pair: it keeps the last callback
 * and delay handed to schedule(), hands back a fresh handle each time, and
 * records every handle passed to cancel(). One callback is pending at a time.
 * @param {{repeat?: boolean}} [options] - `repeat` keeps the callback armed
 *   across fires, as setInterval does.
 * @returns {Object} The recorder, carrying the schedule/cancel pair to inject.
 */
export function fakeScheduler({ repeat = false } = {}) {
  const timer = {
    fn: null,
    ms: null,
    handle: 0,
    cancelled: [],
    schedule: (fn, ms) => {
      assert.equal(timer.fn, null, 'only one timer may be pending');
      timer.fn = fn; timer.ms = ms; return ++timer.handle;
    },
    cancel: (handle) => { timer.cancelled.push(handle); if (handle === timer.handle) timer.fn = null; },
    /** Runs the pending callback. @returns {void} */
    fire: () => {
      const fn = timer.fn;
      assert.ok(fn, 'a scheduled callback is pending');
      if (!repeat) timer.fn = null;
      fn();
    },
  };
  return timer;
}

/**
 * @typedef {Object} FakeTimer
 * @property {Function} fn - Callback the production code scheduled.
 * @property {number} delay - Delay it was scheduled at, which identifies it.
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
  const issued = new Set();
  globalThis.setTimeout = (fn, delay) => {
    const handle = { unref() {} };
    const timer = { fn, delay, handle };
    timers.push(timer);
    issued.add(handle);
    pending.set(handle, timer);
    return handle;
  };
  // A handle armed before the swap belongs to the real timer queue.
  globalThis.clearTimeout = (handle) => {
    if (issued.has(handle)) {
      pending.delete(handle);
      return;
    }
    realClearTimeout(handle);
  };
  const isPending = (timer) => pending.has(timer.handle);
  const fire = (timer) => {
    if (!pending.delete(timer.handle)) return;
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
 * A one-slot window timer source a case fires by hand.
 * @returns {Object} The stand-in and its scheduled delays.
 */
export function fakeTimers() {
  const timer = fakeScheduler();
  const delays = [];
  return {
    delays,
    cleared: timer.cancelled,
    get handle() { return timer.handle; },
    setTimeout(fn, ms) {
      const handle = timer.schedule(fn, ms);
      delays.push(ms);
      return handle;
    },
    clearTimeout: (id) => timer.cancel(id),
    armed: () => timer.fn !== null,
    fire: () => timer.fire(),
  };
}
