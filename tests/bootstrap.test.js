import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  bootstrap, refreshModuleCache, refreshWithDeadline, showBootstrapFailure,
  VENDOR_REMEDY,
} from '../bootstrap.js';
import { fakeElement } from './fake_dom.js';

function fakeDocument() {
  const overlay = fakeElement('div');
  const spinner = fakeElement('div');
  spinner.className = 'spinner';
  overlay.append(spinner);
  const doc = {
    createElement: (tagName) => fakeElement(tagName),
    getElementById: (id) => id === 'loading-overlay' ? overlay : null,
  };
  return {
    doc,
    overlay,
    // The click handler returns the refresh-then-reload chain, so the caller is
    // handed it to await rather than dispatching and losing it.
    click: (element) =>
      element.listeners.find(({ type }) => type === 'click')?.handler(),
  };
}

const quietLogger = { error() {} };
const childWithClass = (overlay, className) =>
  overlay.children.find((child) => child.className === className);

test('bootstrap catches a synchronous loader throw', async () => {
  const { doc, overlay } = fakeDocument();
  const loaded = await bootstrap({
    loader: () => { throw new Error('WebGL unavailable'); },
    document: doc,
    logger: quietLogger,
  });

  assert.equal(loaded, false);
  assert.equal(overlay.classList.contains('error'), true);
  assert.equal(overlay.getAttribute('role'), 'alert',
    'the polite loading status is promoted to an assertive alert');
  assert.equal(childWithClass(overlay, 'spinner'), undefined);
  assert.equal(childWithClass(overlay, 'load-error-detail').textContent,
    'Error: WebGL unavailable', 'the detail names the error type');
});

test('bootstrap catches a rejected module import', async () => {
  const { doc, overlay } = fakeDocument();
  const loaded = await bootstrap({
    loader: () => Promise.reject(new TypeError('module fetch failed')),
    document: doc,
    logger: quietLogger,
  });

  assert.equal(loaded, false);
  assert.equal(childWithClass(overlay, 'load-error-detail').textContent,
    'TypeError: module fetch failed');
});

test('bootstrap leaves the loading overlay intact after a successful import', async () => {
  const { doc, overlay } = fakeDocument();
  let calls = 0;
  const loaded = await bootstrap({
    loader: async () => { calls += 1; },
    document: doc,
    logger: quietLogger,
  });

  assert.equal(loaded, true);
  assert.equal(calls, 1);
  assert.equal(overlay.classList.contains('error'), false);
  assert.ok(childWithClass(overlay, 'spinner'));
});

test('failure detail is assigned as text without interpreting markup', () => {
  const { doc, overlay } = fakeDocument();
  const markup = '<img src=x onerror=alert(1)>';

  assert.doesNotThrow(() => showBootstrapFailure(
    { message: markup }, { document: doc }));
  assert.equal(childWithClass(overlay, 'load-error-detail').textContent, markup);
});

test('the failure overlay names the CDN libraries and their local remedy', () => {
  const { doc, overlay } = fakeDocument();

  showBootstrapFailure(new Error('failed'), { document: doc });

  const remedy = childWithClass(overlay, 'load-error-remedy').textContent;
  assert.match(remedy, /three/);
  assert.match(remedy, /cdn\.jsdelivr\.net/);
  assert.match(remedy, /importmap:local/);
  assert.equal(remedy, VENDOR_REMEDY);
});

test('the failure overlay moves focus onto its reload button', () => {
  const { doc, overlay } = fakeDocument();

  showBootstrapFailure(new Error('failed'), { document: doc });

  assert.equal(overlay.getAttribute('role'), 'alert');
  assert.equal(childWithClass(overlay, 'context-lost-reload').focusCalls, 1);
});

test('reload button refreshes the module cache before reloading', async () => {
  const { doc, overlay, click } = fakeDocument();
  const order = [];
  showBootstrapFailure(new Error('failed'), {
    document: doc,
    location: { reload() { order.push('reload'); } },
    refresh: async () => { order.push('refresh'); },
  });

  const reload = childWithClass(overlay, 'context-lost-reload');
  assert.equal(reload.textContent, 'Reload');
  await click(reload);
  assert.deepEqual(order, ['refresh', 'reload']);
});

test('the reload button reports the sweep and cannot be re-fired', async () => {
  const { doc, overlay, click } = fakeDocument();
  let refreshes = 0;
  showBootstrapFailure(new Error('failed'), {
    document: doc,
    location: { reload() {} },
    refresh: async () => { refreshes += 1; },
  });

  const reload = childWithClass(overlay, 'context-lost-reload');
  await click(reload);

  // Every run re-fetches the whole module graph including the WASM binary, so a
  // second click would start a second sweep over the first with nothing on
  // screen to say the first was running.
  assert.equal(reload.textContent, 'Reloading…');
  assert.equal(reload.disabled, true);
  assert.equal(refreshes, 1);
});

test('bootstrap widens the resource-timing buffer before the module graph loads', async () => {
  const { doc } = fakeDocument();
  const order = [];
  const loaded = await bootstrap({
    loader: async () => { order.push('load'); },
    document: doc,
    logger: quietLogger,
    performance: { setResourceTimingBufferSize: (size) => order.push(size) },
  });

  assert.equal(loaded, true);
  assert.equal(order.length, 2);
  assert.ok(order[0] > 250,
    'the 250-entry default drops the earliest modules — the ones a Reload is '
    + 'most likely to be clearing');
  assert.equal(order[1], 'load', 'a module loaded before the widening is unlisted');
});

test('bootstrap loads on a page whose performance object lacks the control', async () => {
  const { doc } = fakeDocument();
  assert.equal(await bootstrap({
    loader: async () => {},
    document: doc,
    logger: quietLogger,
    performance: {},
  }), true);
});

test('the reload sweep runs on the deadline’s abort signal', async () => {
  const { doc, overlay, click } = fakeDocument();
  let signal = null;
  showBootstrapFailure(new Error('failed'), {
    document: doc,
    location: { reload() {} },
    refresh: async (dependencies) => { signal = dependencies?.signal ?? null; },
  });

  await click(childWithClass(overlay, 'context-lost-reload'));

  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false, 'a sweep that finished was never aborted');
});

// A stalled connection fires no error of its own, so without the deadline the
// overlay's one control stays relabelled, disabled and inert for good.
test('refreshWithDeadline aborts a stalled sweep and releases the reload', async () => {
  let expire = null;
  let cleared = 0;
  const timers = {
    setTimeout: (fn) => { expire = fn; return { unref() {} }; },
    clearTimeout: () => { cleared += 1; },
  };
  let swept = null;
  const settled = refreshWithDeadline(({ signal }) => {
    swept = signal;
    return new Promise(() => {});
  }, { timers });

  expire();
  await settled;

  assert.equal(swept.aborted, true);
  assert.equal(cleared, 1, 'the deadline timer is released with the race');
});

test('refreshWithDeadline survives a sweep that rejects or throws outright', async () => {
  const timers = { setTimeout: () => ({ unref() {} }), clearTimeout: () => {} };

  await assert.doesNotReject(() => refreshWithDeadline(
    () => Promise.reject(new TypeError('offline')), { timers }));
  await assert.doesNotReject(() => refreshWithDeadline(
    () => { throw new TypeError('no fetch'); }, { timers }));
});

test('reload button still reloads when the cache refresh fails', async () => {
  const { doc, overlay, click } = fakeDocument();
  let reloads = 0;
  showBootstrapFailure(new Error('failed'), {
    document: doc,
    location: { reload() { reloads += 1; } },
    refresh: () => Promise.reject(new TypeError('offline')),
  });

  await click(childWithClass(overlay, 'context-lost-reload'));
  assert.equal(reloads, 1);
});

const fakeTimeline = (...names) => ({
  getEntriesByType: (type) => type === 'resource' ? names.map((name) => ({ name })) : [],
});

test('refreshModuleCache re-fetches same-origin scripts past the cache', async () => {
  const calls = [];
  await refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: fakeTimeline(
      'http://localhost:8000/daydream.js',
      'http://localhost:8000/effect_sequencing.js',
      'http://localhost:8000/effect_sequencing.js',
      'http://localhost:8000/tools/shared.js?v=2',
      // '.mjs' does not end in '.js': the workbench compiler and the digest
      // module it is hash-coupled to load through the same main.js path.
      'http://localhost:8000/shader/shader_workbench.mjs',
      'http://localhost:8000/shader/sha256.mjs',
      // Glue and binary are bound by content hash, so a cached binary against
      // fresh glue is exactly the skew Reload exists to clear.
      'http://localhost:8000/holosphere_wasm.wasm',
    ),
    fetch: (url, options) => { calls.push([url, options]); return Promise.resolve(); },
  });

  assert.deepEqual(calls.map(([url]) => url), [
    'http://localhost:8000/daydream.js',
    'http://localhost:8000/effect_sequencing.js',
    'http://localhost:8000/tools/shared.js?v=2',
    'http://localhost:8000/shader/shader_workbench.mjs',
    'http://localhost:8000/shader/sha256.mjs',
    'http://localhost:8000/holosphere_wasm.wasm',
  ]);
  for (const [, options] of calls) assert.deepEqual(options, { cache: 'reload' });
});

// The whole module graph at once only queues past the browser's per-host
// connection limit, leaving the binary the sweep exists for behind the queue.
test('refreshModuleCache bounds how many re-fetches are in flight', async () => {
  const urls = Array.from({ length: 30 }, (_, i) => `http://localhost:8000/m${i}.js`);
  const release = [];
  let inFlight = 0;
  let peak = 0;

  const sweep = refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: fakeTimeline(...urls),
    fetch: () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise((resolve) => release.push(() => {
        inFlight -= 1;
        resolve({ body: null, arrayBuffer: async () => {} });
      }));
    },
  });

  while (release.length > 0) {
    release.splice(0).forEach((fn) => fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await sweep;

  assert.ok(peak > 1, 'the sweep runs re-fetches in parallel');
  assert.ok(peak <= 6, `${peak} re-fetches were in flight at once`);
});

// A response whose body is never read is aborted when it is collected, so the
// cache entry the sweep exists to replace survives the reload.
function fakeBody(chunks, gate = Promise.resolve()) {
  const body = { pending: chunks, drained: false };
  body.response = {
    body: {
      getReader: () => ({
        read: async () => {
          await gate;
          if (body.pending === 0) {
            body.drained = true;
            return { done: true, value: undefined };
          }
          body.pending -= 1;
          return { done: false, value: new Uint8Array(1) };
        },
      }),
    },
  };
  return body;
}

test('refreshModuleCache reads every re-fetched body to completion', async () => {
  const bodies = new Map([
    ['http://localhost:8000/daydream.js', fakeBody(1)],
    ['http://localhost:8000/holosphere_wasm.wasm', fakeBody(4)],
  ]);

  await refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: fakeTimeline(...bodies.keys()),
    fetch: (url) => Promise.resolve(bodies.get(url).response),
  });

  for (const [url, body] of bodies) {
    assert.equal(body.drained, true, `${url} settled on its headers, uncached`);
  }
});

test('refreshModuleCache reads a response that carries no body stream', async () => {
  let reads = 0;
  await assert.doesNotReject(() => refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: fakeTimeline('http://localhost:8000/daydream.js'),
    fetch: async () => ({ body: null, arrayBuffer: async () => { reads += 1; } }),
  }));
  assert.equal(reads, 1);
});

test('the reload waits for the re-fetched binary to finish streaming', async () => {
  const { doc, overlay, click } = fakeDocument();
  const order = [];
  let release;
  const body = fakeBody(1, new Promise((resolve) => { release = resolve; }));
  showBootstrapFailure(new Error('failed'), {
    document: doc,
    location: { reload() { order.push('reload'); } },
    refresh: () => refreshModuleCache({
      origin: 'http://localhost:8000',
      performance: fakeTimeline('http://localhost:8000/holosphere_wasm.wasm'),
      fetch: async () => body.response,
    }),
  });

  const clicked = click(childWithClass(overlay, 'context-lost-reload'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, [], 'the reload fired while the binary was still streaming');

  release();
  await clicked;
  assert.equal(body.drained, true);
  assert.deepEqual(order, ['reload']);
});

test('refreshModuleCache re-fetches on the signal and drops the queue on abort', async () => {
  const urls = Array.from({ length: 12 }, (_, i) => `http://localhost:8000/m${i}.js`);
  const controller = new AbortController();
  const calls = [];

  await refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: fakeTimeline(...urls),
    signal: controller.signal,
    fetch: (url, options) => {
      calls.push([url, options]);
      controller.abort();
      return Promise.resolve({ body: null, arrayBuffer: async () => {} });
    },
  });

  // The abort lands before any other lane takes its first url, so the eleven
  // behind it are dropped rather than each rejecting in turn.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { cache: 'reload', signal: controller.signal });
});

test('refreshModuleCache skips cross-origin and unrelated resources', async () => {
  const calls = [];
  await refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: fakeTimeline(
      'https://cdn.jsdelivr.net/npm/three@0.183.1/build/three.module.js',
      'https://cdn.jsdelivr.net/npm/some-pkg/dist/some.wasm',
      'http://localhost:8000/styles/index.css',
      'http://localhost:8000/pov_segment_map.json',
      'http://localhost:8000/bootstrap.js',
    ),
    fetch: (url) => { calls.push(url); return Promise.resolve(); },
  });

  assert.deepEqual(calls, [
    'http://localhost:8000/styles/index.css',
    'http://localhost:8000/pov_segment_map.json',
    'http://localhost:8000/bootstrap.js',
  ]);
});

test('refreshModuleCache survives a rejected re-fetch and a missing timeline', async () => {
  await assert.doesNotReject(() => refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: fakeTimeline('http://localhost:8000/daydream.js'),
    fetch: () => Promise.reject(new TypeError('network down')),
  }));
  await assert.doesNotReject(() => refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: undefined,
    fetch: () => assert.fail('no resource timeline: nothing to re-fetch'),
  }));
  await assert.doesNotReject(() => refreshModuleCache({
    origin: 'http://localhost:8000',
    performance: fakeTimeline('http://localhost:8000/daydream.js'),
    fetch: async () => ({
      body: { getReader: () => ({ read: () => Promise.reject(new TypeError('aborted')) }) },
    }),
  }));
});

test('showBootstrapFailure reports whether an overlay carried the failure', () => {
  const { doc } = fakeDocument();
  assert.equal(showBootstrapFailure(new Error('failed'), { document: doc }), true);
  assert.equal(showBootstrapFailure(new Error('failed'), {
    document: { getElementById: () => null },
  }), false);
});

test('bootstrap falls back to a fatal banner when there is no overlay', async () => {
  const messages = [];
  const loaded = await bootstrap({
    loader: () => { throw new Error('offline'); },
    document: { getElementById: () => null },
    logger: quietLogger,
    fatal: (message) => messages.push(message),
  });

  assert.equal(loaded, false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^Failed to start the simulator\b.*\boffline\b/);
});

test('bootstrap leaves the fatal banner alone when the overlay renders', async () => {
  const { doc, overlay } = fakeDocument();
  let fatals = 0;
  await bootstrap({
    loader: () => Promise.reject(new Error('boom')),
    document: doc,
    logger: quietLogger,
    fatal: () => { fatals += 1; },
  });

  assert.equal(fatals, 0);
  assert.equal(childWithClass(overlay, 'load-error-detail').textContent, 'Error: boom');
});

// Booting is the entry module's job alone. As an import-time side effect here it
// would stand up a second simulator — WebGL context, URLSync, engine — for any
// module that reached bootstrap.js for its overlay, daydream.js included.
test('index boots through the entry module and bootstrap.js stays importable', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<link href="\.\/favicon\.svg" rel="icon"/);
  assert.match(html, /<script type="module" src="main\.js"><\/script>/);
  assert.doesNotMatch(html, /<script type="module" src="daydream\.js"><\/script>/);
  const source = readFileSync(new URL('../bootstrap.js', import.meta.url), 'utf8');
  const body = source.replace(/export\s+async\s+function\s+bootstrap\s*\(/, 'function(');
  const invocation = /\bbootstrap\s*(?:\?\.\s*)?(?:\(|\.(?:call|apply)\s*\()|\(\s*bootstrap\s*\)\s*\(/;
  assert.doesNotMatch(body, invocation);
  for (const spelling of [
    'await bootstrap()',
    'bootstrap?.()',
    '(bootstrap)()',
    'bootstrap.call(null)',
  ]) assert.match(spelling, invocation);
});

test('index identifies new-window tool links and associates stats headers', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const toolLinks = [...html.matchAll(/<a href="tools\/[^"]+"[^>]+>.*?<\/a>/g)];
  assert.equal(toolLinks.length, 5);
  for (const [link] of toolLinks) {
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener"/);
    assert.match(link, /opens in a new window/);
  }
  const headers = [...html.matchAll(/<th\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(headers.length > 0);
  for (const header of headers) assert.match(header, /\bscope="col"/);
});
