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

/**
 * Warm state for one module graph: the dedupe window a burst of warms collapses
 * into, and the compilation the pool spawn hands to its workers.
 */
export class ModuleWarmer {
  constructor() {
    /** @type {AbortController|null} */
    this.controller = null;
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
    try { probe = new URL('../../generated/holosphere_wasm.js', baseUrl); }
    catch { return Promise.resolve(); }
    if (probe.protocol !== 'http:' && probe.protocol !== 'https:') return Promise.resolve();
    const now = clock();
    if (probe.href === this.lastWarmKey && now - this.lastWarmAt < minIntervalMs) {
      return this.lastWarm;
    }
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const drain = (/** @type {string} */ u) =>
      fetchResource(new URL(u, baseUrl), { cache: 'no-cache', signal: controller.signal })
        .then((r) => {
          if (r.ok === false) throw new Error(`Module fetch failed: ${r.status} ${u}`);
          return r.arrayBuffer();
        });
    const epoch = this.warmEpoch + 1;
    /** @param {WebAssembly.Module | null} compiled */
    const publish = (compiled) => {
      if (this.warmEpoch === epoch) this.module = compiled;
    };
    /** @type {Promise<void>} */
    let warm;
    try {
      const workerJs = drain('./segment_worker.js');
      const glueJs = drain('../../generated/holosphere_wasm.js');
      const layoutJs = drain('./segment_layout.js');
      const protocolJs = drain('./worker_protocol.js');
      const haltJs = drain('../shared/engine_halt.js');
      const binary = glueJs.then((bytes) => {
        const source = new TextDecoder().decode(bytes);
        const path = source.match(/new URL\(["'](holosphere_wasm\.wasm\?v=[a-f0-9]+)["']/)?.[1];
        if (!path) throw new Error('WASM glue has no versioned binary URL');
        return drain(new URL(path, probe).href);
      });
      warm = Promise.allSettled([
        workerJs,
        glueJs,
        layoutJs,
        protocolJs,
        haltJs,
        binary,
        binary.then((bytes) => WebAssembly.compile(bytes).then(
          publish,
          (error) => {
            console.warn('[Segmented] shared WASM compile failed; each worker '
              + 'will compile its own', error);
            publish(null);
          }),
        () => { publish(null); }),
      ]).then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed && this.warmEpoch === epoch) {
          this.lastWarmAt = -Infinity;
          publish(null);
          console.warn('[Segmented] module warm failed', failed.reason);
        }
      });
    } catch (error) {
      // Reported like the compile and deadline failures below; the dedupe
      // window stays shut, since nothing was warmed for a later caller to be
      // handed.
      console.warn('[Segmented] module warm could not be started; each worker '
        + 'will fetch and compile its own', error);
      return Promise.resolve();
    }
    warm = raceDeadline(() => warm, deadlineMs, timers, () => {
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
