// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Minimum spacing between two actual warms. lil-gui fires onChange per drag
// step, so the segment-count slider warms several times a second.
export const WARM_INTERVAL_MS = 10000;

// Deadline for one warm. Everything the warm produces is best-effort — a primed
// cache and a shared compilation each worker falls back to producing for itself
// — but the pool spawn waits on it, so a stalled re-fetch would leave segmented
// mode enabled with no workers, no watchdog and nothing on screen to say so.
// Sized alongside the worker init watchdog, which bounds the same binary.
export const WARM_DEADLINE_MS = 20000;

/**
 * Settle a warm on the earlier of its own completion and a deadline.
 * @param {Promise<void>} work - The warm in flight.
 * @param {number} ms - The deadline, in milliseconds.
 * @param {{setTimeout: Function, clearTimeout: Function}} timers - Timer source;
 *   the page, or whatever stands in for it under test.
 * @param {() => void} abandon - Runs when the deadline wins.
 * @returns {Promise<void>} Resolves either way: the spawn behind it must run.
 */
function warmWithDeadline(work, ms, timers, abandon) {
  /** @type {any} */
  let timer = null;
  const expired = new Promise((resolve) => {
    timer = timers.setTimeout(() => { abandon(); resolve(undefined); }, ms);
    // No-op in browsers; keeps an unfired deadline from holding the unit-test
    // process open.
    timer?.unref?.();
  });
  return Promise.race([work, expired]).finally(() => timers.clearTimeout(timer));
}

/**
 * Warm state for one module graph: the dedupe window a burst of warms collapses
 * into, and the compilation the pool spawn hands to its workers.
 */
export class ModuleWarmer {
  constructor() {
    this.lastWarmAt = -Infinity;
    this.warmEpoch = 0;
    /** @type {string | null} */
    this.lastWarmKey = null;
    /** @type {Promise<void>} */
    this.lastWarm = Promise.resolve();
    /** @type {WebAssembly.Module | null} */
    this.module = null;
  }

  /**
   * Drop the held compilation so the next spawn compiles per worker.
   * @returns {void}
   */
  discard() {
    this.warmEpoch += 1;
    this.module = null;
  }

  /**
   * Prime the module graph's HTTP cache and compile its binary.
   * @param {{fetch?: typeof globalThis.fetch, baseUrl?: string|URL, minIntervalMs?: number, now?: () => number, deadlineMs?: number, timers?: {setTimeout: Function, clearTimeout: Function}}} [dependencies]
   * @returns {Promise<void>} Resolves once the graph is warm, or once the
   *   deadline abandons it; never rejects, so the spawn behind it always runs.
   */
  warm({
    fetch: fetchResource = globalThis.fetch,
    baseUrl = import.meta.url,
    minIntervalMs = WARM_INTERVAL_MS,
    now: clock = Date.now,
    deadlineMs = WARM_DEADLINE_MS,
    timers = globalThis,
  } = {}) {
    if (typeof fetchResource !== 'function') return Promise.resolve();
    let probe;
    try { probe = new URL('./holosphere_wasm.js', baseUrl); }
    catch { return Promise.resolve(); }
    if (probe.protocol !== 'http:' && probe.protocol !== 'https:') return Promise.resolve();
    const now = clock();
    if (probe.href === this.lastWarmKey && now - this.lastWarmAt < minIntervalMs) {
      return this.lastWarm;
    }
    const controller = new AbortController();
    const drain = (/** @type {string} */ u) =>
      fetchResource(new URL(u, baseUrl), { cache: 'no-cache', signal: controller.signal })
        .then((r) => r.arrayBuffer());
    const epoch = this.warmEpoch + 1;
    /** @param {WebAssembly.Module | null} compiled */
    const publish = (compiled) => {
      if (this.warmEpoch === epoch) this.module = compiled;
    };
    /** @type {Promise<void>} */
    let warm;
    try {
      const workerJs = drain('./segment_worker.js');
      const glueJs = drain('./holosphere_wasm.js');
      const layoutJs = drain('./segment_layout.js');
      const protocolJs = drain('./worker_protocol.js');
      const binary = drain('./holosphere_wasm.wasm');
      warm = Promise.allSettled([
        workerJs,
        glueJs,
        layoutJs,
        protocolJs,
        binary,
        binary.then((bytes) => WebAssembly.compile(bytes).then(
          publish,
          (error) => {
            console.warn('[Segmented] shared WASM compile failed; each worker '
              + 'will compile its own', error);
            publish(null);
          }),
        () => { publish(null); }),
      ]).then(() => {});
    } catch {
      return Promise.resolve();
    }
    warm = warmWithDeadline(warm, deadlineMs, timers, () => {
      controller.abort();
      // The binary never arrived, so a module held from an earlier warm can no
      // longer be claimed to match the one being served.
      publish(null);
      console.warn('[Segmented] module warm did not finish within '
        + `${Math.round(deadlineMs / 1000)}s; each worker will fetch and `
        + 'compile its own');
    });
    this.warmEpoch = epoch;
    this.lastWarmAt = now;
    this.lastWarmKey = probe.href;
    this.lastWarm = warm;
    return this.lastWarm;
  }
}

export const pageWarmer = new ModuleWarmer();
