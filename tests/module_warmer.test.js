import { installFakeTimers } from './helpers/fake_timers.js';
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

import { ModuleWarmer, warmModules, pageWarmer, GRAPH, WARM_INTERVAL_MS, WARM_DEADLINE_MS, EMPTY_WASM } from './fixtures/module_warmer_fixture.js';
beforeEach(() => pageWarmer.discard());

test('default warm uses its served module URL, global fetch, and clears its deadline', async (t) => {
  const moduleUrl = 'https://daydream.test/nested/module_warmer.js';
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url === moduleUrl) return {
        format: 'module', shortCircuit: true,
        source: readFileSync(new URL('../module_warmer.js', import.meta.url), 'utf8'),
      };
      return nextLoad(url, context);
    },
  });
  const requested = [];
  const clock = installFakeTimers();
  t.mock.method(globalThis, 'fetch', async (url) => {
    requested.push(url.href);
    const bytes = url.pathname.endsWith('.wasm') ? EMPTY_WASM
      : new TextEncoder().encode('new URL("holosphere_wasm.wasm?v=abc123", import.meta.url)');
    return { ok: true, arrayBuffer: async () => bytes.buffer };
  });
  try {
    const { ModuleWarmer, WARM_DEADLINE_MS } = await import(moduleUrl);
    const warmer = new ModuleWarmer();
    await warmer.warm();
    assert.ok(warmer.module instanceof WebAssembly.Module);
    assert.equal(requested.length, GRAPH.length + 1);
    assert.ok(requested.every((url) => url.startsWith('https://daydream.test/nested/')));
    assert.ok(requested.includes('https://daydream.test/nested/holosphere_wasm.wasm?v=abc123'));
    assert.equal(clock.timers.length, 1);
    assert.equal(clock.timers[0].delay, WARM_DEADLINE_MS);
    assert.equal(clock.isPending(clock.timers[0]), false);
  } finally {
    hooks.deregister();
    clock.restore();
  }
});


test('warmModules revalidates the whole worker module graph', async () => {
  const calls = [];
  const response = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  await warmModules({
    baseUrl: 'http://localhost:8000/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url, options) => {
      calls.push([url.href, options]);
      return Promise.resolve(response);
    },
  });

  // Derived from the worker's own import graph plus the binary its glue
  // streams, so a module joining the graph is one the warm must drain too.
  const graph = [...GRAPH, 'holosphere_wasm.wasm?v=abc123'];
  assert.deepEqual(calls.map(([url]) => url).sort(),
    graph.map((file) => `http://localhost:8000/${file}`).sort(),
    'every static import of the worker, or a stale one survives the warm');
  // 'reload' would re-download all 1.8 MB per call; 'no-cache' still refetches a
  // rebuilt binary because the artifacts are served unversioned.
  for (const [, options] of calls) {
    assert.equal(options.cache, 'no-cache');
    assert.equal(options.signal.aborted, false);
  }
  // One controller for the graph: the deadline abandons the whole warm or none
  // of it.
  assert.equal(new Set(calls.map(([, options]) => options.signal)).size, 1);
});

test('a stalled warm is abandoned on its deadline so the spawn still runs',
  async () => {
    const warmer = new ModuleWarmer();
    await warmer.warm({
      baseUrl: 'http://localhost:8000/stalled/segment_controller.js',
      minIntervalMs: 0,
      fetch: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(EMPTY_WASM.buffer),
      }),
    });
    assert.ok(warmer.module instanceof WebAssembly.Module, 'the first warm compiled');

    /** @type {Array<() => void>} */
    const expire = [];
    let aborted = 0;
    const warm = warmer.warm({
      baseUrl: 'http://localhost:8000/stalled/segment_controller.js',
      minIntervalMs: 0,
      timers: {
        setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
          assert.equal(ms, WARM_DEADLINE_MS);
          expire.push(fn);
          return { unref() {} };
        },
        clearTimeout: () => {},
      },
      fetch: (/** @type {URL} */ url, /** @type {*} */ options) => {
        assert.ok(url instanceof URL);
        options.signal.addEventListener('abort', () => { aborted += 1; });
        return new Promise(() => {});
      },
    });

    assert.equal(expire.length, 1, 'the warm armed exactly one deadline');
    expire[0]();
    await warm;

    assert.equal(aborted, GRAPH.length, 'every stalled re-fetch was aborted');
    assert.equal(warmer.module, null,
      'the abandoned warm hands the pool a module it never revalidated');
  });

test('a re-warm inside the dedupe window is skipped', async () => {
  let calls = 0;
  let now = 0;
  const response = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  const deps = {
    baseUrl: 'http://localhost:8000/segment_controller.js',
    minIntervalMs: WARM_INTERVAL_MS,
    fetch: () => { calls++; return Promise.resolve(response); },
    now: () => now,
  };
  const warmer = new ModuleWarmer();
  await warmer.warm(deps);
  assert.equal(calls, GRAPH.length + 1, 'a first warm fetches the whole module graph');

  now += WARM_INTERVAL_MS - 1;
  await warmer.warm(deps);
  assert.equal(calls, GRAPH.length + 1, 'a slider-drag re-warm reuses the previous warm');

  now += 1;
  await warmer.warm(deps);
  assert.equal(calls, 2 * (GRAPH.length + 1), 'a warm on the window boundary fetches again');
});

test('the dedupe window covers one base URL, not every caller in it', async () => {
  const seen = [];
  const response = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  const deps = {
    minIntervalMs: WARM_INTERVAL_MS,
    fetch: (url) => { seen.push(url.href); return Promise.resolve(response); },
    now: () => 0,
  };
  const warmer = new ModuleWarmer();
  await warmer.warm({
    ...deps,
    baseUrl: 'http://localhost:8000/first/segment_controller.js',
  });
  seen.length = 0;

  // Another base URL is another module graph: serving it the first warm's
  // promise would report a warm of files it never fetched.
  await warmer.warm({
    ...deps,
    baseUrl: 'http://localhost:8000/second/segment_controller.js',
  });
  assert.deepEqual(seen.slice().sort(),
    [...GRAPH, 'holosphere_wasm.wasm?v=abc123']
      .map((file) => `http://localhost:8000/second/${file}`).sort(),
    'a second base URL inside the window warms its own module graph');

  seen.length = 0;
  await warmer.warm({
    ...deps,
    baseUrl: 'http://localhost:8000/second/segment_controller.js',
  });
  assert.deepEqual(seen, [], 'a repeat of that base URL still dedupes');
});

test('a warm whose fetch throws synchronously does not claim the window', async () => {
  const baseUrl = 'http://localhost:8000/offline/segment_controller.js';
  const warmer = new ModuleWarmer();
  const warned = [];
  const stub = mock.method(console, 'warn', (...args) => { warned.push(args); });
  try {
    await warmer.warm({
      baseUrl, minIntervalMs: WARM_INTERVAL_MS, now: () => 0,
      fetch: () => { throw new TypeError('network down'); },
    });
  } finally {
    stub.mock.restore();
  }
  // Silent here alone, where every other warm failure reports itself, a pool
  // that spawned with no shared compilation leaves nothing to explain why.
  assert.equal(warned.length, 1, 'the refused warm is reported');
  assert.match(String(warned[0][0]), /module warm could not be started/);
  assert.match(String(warned[0][1]), /network down/);

  let calls = 0;
  await warmer.warm({
    baseUrl, minIntervalMs: WARM_INTERVAL_MS, now: () => 0,
    fetch: () => {
      calls++;
      return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    },
  });
  assert.equal(calls, GRAPH.length + 1,
    'the throw warmed nothing, so the next call must not be handed a settled promise');
});

test('a binary the engine refuses is reported, not left to the spawn to discover', async () => {
  const warned = [];
  const stub = mock.method(console, 'warn', (...args) => { warned.push(args); });
  try {
    await warmModules({
      baseUrl: 'http://localhost:8000/corrupt/segment_controller.js',
      minIntervalMs: 0,
      fetch: (url) => Promise.resolve({
        arrayBuffer: () => Promise.resolve(url.pathname.endsWith('.wasm')
          ? Uint8Array.of(0, 0x61, 0x73, 0x6d, 9, 9, 9, 9).buffer
          : new ArrayBuffer(0)),
      }),
    });
  } finally {
    stub.mock.restore();
  }

  assert.equal(warned.length, 1, 'the compile rejection reached no diagnostic');
  assert.match(String(warned[0][0]), /shared WASM compile failed/);
  assert.ok(warned[0][1] instanceof Error,
    'the rejection is carried, so the operator sees why it failed');
});

test('a warm that settles behind a newer one leaves its module alone', async () => {
  const warmer = new ModuleWarmer();
  /** @type {(bytes: ArrayBuffer) => void} */
  let releaseStale = () => {};
  const stale = new Promise((resolve) => { releaseStale = resolve; });
  const serve = (path, binary) => ({
    baseUrl: `http://localhost:8000/${path}/segment_controller.js`,
    minIntervalMs: 0,
    fetch: (url) => Promise.resolve({
      arrayBuffer: () => (url.pathname.endsWith('.wasm')
        ? binary()
        : Promise.resolve(new ArrayBuffer(0))),
    }),
  });

  const slow = warmer.warm(serve('stale', () => stale));
  await warmer.warm(serve('fresh', () => Promise.resolve(EMPTY_WASM.buffer)));
  const fresh = warmer.module;
  assert.ok(fresh instanceof WebAssembly.Module, 'the newer warm compiled');

  releaseStale(Uint8Array.of(0, 0x61, 0x73, 0x6d, 9, 9, 9, 9).buffer);
  const stub = mock.method(console, 'warn', () => {});
  try {
    await slow;
  } finally {
    stub.mock.restore();
  }
  assert.equal(warmer.module, fresh,
    'the superseded warm nulled out a module a later warm had already landed');
});

test('a warm in flight when a worker refuses the module does not restore it', async () => {
  const warmer = new ModuleWarmer();
  /** @type {(bytes: ArrayBuffer) => void} */
  let releaseBinary = () => {};
  const binary = new Promise((resolve) => { releaseBinary = resolve; });
  const warm = warmer.warm({
    baseUrl: 'http://localhost:8000/refused/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url) => Promise.resolve({
      arrayBuffer: () => (url.pathname.endsWith('.wasm')
        ? binary
        : Promise.resolve(new ArrayBuffer(0))),
    }),
  });

  warmer.discard();
  releaseBinary(EMPTY_WASM.buffer);
  await warm;
  assert.equal(warmer.module, null,
    'the discarded warm handed the pool back the compilation a worker refused');
});
