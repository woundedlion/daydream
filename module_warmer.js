// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Minimum spacing between two actual warms. lil-gui fires onChange per drag
// step, so the segment-count slider warms several times a second.
export const WARM_INTERVAL_MS = 10000;

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
   * @param {{fetch?: typeof globalThis.fetch, baseUrl?: string|URL, minIntervalMs?: number, now?: () => number}} [dependencies]
   * @returns {Promise<void>}
   */
  warm({
    fetch: fetchResource = globalThis.fetch,
    baseUrl = import.meta.url,
    minIntervalMs = WARM_INTERVAL_MS,
    now: clock = Date.now,
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
    const drain = (/** @type {string} */ u) =>
      fetchResource(new URL(u, baseUrl), { cache: 'no-cache' }).then((r) => r.arrayBuffer());
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
    this.warmEpoch = epoch;
    this.lastWarmAt = now;
    this.lastWarmKey = probe.href;
    this.lastWarm = warm;
    return this.lastWarm;
  }
}

export const pageWarmer = new ModuleWarmer();
