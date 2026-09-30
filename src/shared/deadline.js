// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * @template T
 * @param {() => Promise<T>} start - Starts the operation.
 * @param {number} ms - Deadline in milliseconds.
 * @param {{setTimeout: Function, clearTimeout: Function}} timers - Timer source.
 * @param {() => T} expire - Deadline result, or a thrown deadline error.
 * @returns {Promise<T>} The operation or deadline result.
 */
export function raceDeadline(start, ms, timers, expire) {
  /** @type {any} */
  let timer = null;
  const expired = new Promise((resolve, reject) => {
    timer = timers.setTimeout(() => {
      try { resolve(expire()); } catch (error) { reject(error); }
    }, ms);
    timer?.unref?.();
  });
  let work;
  try { work = start(); } catch (error) {
    timers.clearTimeout(timer);
    return Promise.reject(error);
  }
  return Promise.race([work, expired]).finally(() => timers.clearTimeout(timer));
}
