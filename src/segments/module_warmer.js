// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { raceDeadline } from '../shared/deadline.js';

// Minimum spacing between two actual warms.
export const WARM_INTERVAL_MS = 10000;

// Best-effort warming deadline; pool creation waits for warming to settle.
export const WARM_DEADLINE_MS = 20000;

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
   * @returns {Promise<void>} Resolves when best-effort warming settles or is
   *   skipped; never rejects, so the spawn behind it always runs.
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
      const bindingsJs = drain('../engine/workbench_bindings.js');
      const paramsJs = drain('../effects/param_sync.js');
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
        bindingsJs,
        paramsJs,
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
      // The dedupe window stays shut: nothing was warmed.
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
