import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootstrap, refreshModuleCache, showBootstrapFailure } from '../bootstrap.js';
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
    'WebGL unavailable');
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
    'module fetch failed');
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
    'http://localhost:8000/holosphere_wasm.wasm',
  ]);
  for (const [, options] of calls) assert.deepEqual(options, { cache: 'reload' });
});

test('refreshModuleCache skips cross-origin and non-module resources', async () => {
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

  assert.deepEqual(calls, ['http://localhost:8000/bootstrap.js']);
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
  assert.equal(childWithClass(overlay, 'load-error-detail').textContent, 'boom');
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
  assert.doesNotMatch(source, /^\s*(?:void\s+)?bootstrap\s*\(/m);
});

test('index identifies new-window tool links and associates stats headers', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const toolLinks = [...html.matchAll(/<a href="tools\/[^"]+"[^>]+>.*?<\/a>/g)];
  assert.equal(toolLinks.length, 5);
  const newWindowLinks = toolLinks.filter(([link]) => !link.includes('tools/shader.html'));
  assert.equal(newWindowLinks.length, 4);
  for (const [link] of newWindowLinks) {
    assert.match(link, /target="_blank"/);
    assert.match(link, /rel="noopener"/);
    assert.match(link, /opens in a new window/);
  }
  const shaderLink = toolLinks.find(([link]) => link.includes('tools/shader.html'))?.[0];
  assert.doesNotMatch(shaderLink, /target=/);
  const headers = [...html.matchAll(/<th\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(headers.length > 0);
  for (const header of headers) assert.match(header, /\bscope="col"/);
});
