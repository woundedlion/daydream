// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootstrap, showBootstrapFailure } from '../bootstrap.js';

function fakeDocument() {
  const listeners = new WeakMap();
  const createElement = (tagName) => {
    const element = {
      tagName,
      type: '',
      className: '',
      textContent: '',
      children: [],
      classList: {
        values: new Set(),
        add(value) { this.values.add(value); },
        contains(value) { return this.values.has(value); },
      },
      addEventListener(type, callback) {
        const handlers = listeners.get(this) || {};
        handlers[type] = callback;
        listeners.set(this, handlers);
      },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
    };
    Object.defineProperty(element, 'innerHTML', {
      set() { throw new Error('innerHTML must not be used'); },
    });
    return element;
  };

  const overlay = createElement('div');
  const spinner = createElement('div');
  spinner.className = 'spinner';
  overlay.append(spinner);
  const doc = {
    createElement,
    getElementById: (id) => id === 'loading-overlay' ? overlay : null,
  };
  return {
    doc,
    overlay,
    click: (element) => listeners.get(element)?.click?.(),
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

test('reload button invokes the injected page location', () => {
  const { doc, overlay, click } = fakeDocument();
  let reloads = 0;
  showBootstrapFailure(new Error('failed'), {
    document: doc,
    location: { reload() { reloads += 1; } },
  });

  const reload = childWithClass(overlay, 'context-lost-reload');
  assert.equal(reload.textContent, 'Reload');
  click(reload);
  assert.equal(reloads, 1);
});

test('index loads bootstrap instead of the application module directly', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<script type="module" src="bootstrap\.js"><\/script>/);
  assert.doesNotMatch(html, /<script type="module" src="daydream\.js"><\/script>/);
});
