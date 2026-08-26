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
