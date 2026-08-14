import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showFatalError, bootstrapTool, reportPageFailures } from '../tools/banner.js';
import { captureConsole, installConsoleCapture } from './fake_console.js';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

restoreDocumentAfterEach();

// Minimal fake DOM: getElementById resolves against whatever was appended and
// still attached, so both idempotent reuse and dismissal can be observed. body
// defaults present; pass {body: null} to exercise the no-body guard, and
// {documentElement: true} to model the pre-<body> parse state where <html>
// exists but <body> does not.
function fakeDocument({ body = true, documentElement = false } = {}) {
  const byId = new Map();
  const created = [];
  const makeParent = () => {
    const parent = fakeElement('div');
    const append = parent.appendChild.bind(parent);
    parent.appendChild = (el) => { byId.set(el.id, el); return append(el); };
    return parent;
  };
  const bodyEl = body ? makeParent() : null;
  const docEl = documentElement ? makeParent() : undefined;
  installDocument({
    getElementById: (id) => {
      const el = byId.get(id);
      return el?.parentNode ? el : null;
    },
    createElement: (tag) => {
      const el = fakeElement(tag);
      created.push(el);
      return el;
    },
    body: bodyEl,
    documentElement: docEl,
  });
  return { created, bodyEl, docEl };
}

const messageOf = (el) => el.querySelector('.fatal-error-message').textContent;

test('showFatalError appends one banner carrying the message as textContent', () => {
  const { bodyEl } = fakeDocument();
  showFatalError('engine failed to load');

  assert.equal(bodyEl.children.length, 1);
  const el = bodyEl.children[0];
  assert.equal(el.id, 'fatal-error-overlay');
  assert.equal(el.attributes.role, 'alert');
  assert.equal(messageOf(el), '⚠ engine failed to load');
});

test('showFatalError writes textContent, never innerHTML — markup is not interpreted', () => {
  const { created } = fakeDocument();
  showFatalError('<img src=x onerror=alert(1)>');

  const el = created[0];
  assert.equal(messageOf(el), '⚠ <img src=x onerror=alert(1)>');
  assert.deepEqual(el.querySelector('.fatal-error-message').children, [],
    'the markup landed as text, not as nodes parsed into the message slot');
});

test('showFatalError is idempotent — repeated calls reuse the single banner', () => {
  const { bodyEl } = fakeDocument();
  showFatalError('first');
  showFatalError('second');

  assert.equal(bodyEl.children.length, 1);
  assert.equal(messageOf(bodyEl.children[0]), '⚠ second');
});

test('the banner dismiss button removes it; a later failure opens a fresh one', () => {
  const { bodyEl } = fakeDocument();
  showFatalError('a rejection nothing awaited');

  const dismiss = bodyEl.children[0].querySelector('.fatal-error-dismiss');
  assert.equal(dismiss.tagName, 'BUTTON');
  assert.equal(dismiss.attributes['aria-label'], 'Dismiss');
  dismiss.dispatch('click');
  assert.equal(bodyEl.children.length, 0);

  showFatalError('a second failure');
  assert.equal(bodyEl.children.length, 1);
  assert.equal(messageOf(bodyEl.children[0]), '⚠ a second failure');
});

test('showFatalError falls back to documentElement when body is absent', () => {
  const { docEl } = fakeDocument({ body: null, documentElement: true });
  showFatalError('too early');
  assert.equal(docEl.children.length, 1);
  assert.equal(messageOf(docEl.children[0]), '⚠ too early');
});

test('showFatalError does not throw when neither body nor documentElement exists', () => {
  const { created } = fakeDocument({ body: null });
  assert.doesNotThrow(() => showFatalError('too early'));
  assert.equal(messageOf(created[0]), '⚠ too early');
});

// --- post-boot failure surface --------------------------------------------

/**
 * A stand-in for `window`: records listeners so a test can fire the failure
 * events the browser would, and reports what was dispatched to whom.
 * @returns {{addEventListener: Function, removeEventListener: Function,
 *   dispatch: Function, types: () => string[]}}
 */
function fakeTarget() {
  const listeners = new Map();
  const target = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const held = listeners.get(type);
      if (!held) return;
      const at = held.indexOf(fn);
      if (at >= 0) held.splice(at, 1);
      if (held.length === 0) listeners.delete(type);
    },
    dispatch(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    types: () => [...listeners.keys()],
  };
  return target;
}

test('reportPageFailures listens for both uncaught errors and unhandled rejections', () => {
  const target = fakeTarget();
  reportPageFailures('solids tool', target);
  assert.deepEqual(target.types().sort(), ['error', 'unhandledrejection']);
});

/**
 * The simulator installs this surface at module scope and drops it on a page
 * discard. Returning the pairs it registered is what lets that teardown remove
 * the same functions; a handler surviving the discard reports into a dead page.
 */
test('reportPageFailures returns the pairs its caller needs to deregister', () => {
  const { bodyEl } = fakeDocument();
  const target = fakeTarget();

  const installed = reportPageFailures('simulator', target);

  assert.deepEqual(installed.map(([type]) => type),
    ['error', 'unhandledrejection']);
  for (const [type, handler] of installed) target.removeEventListener(type, handler);
  assert.deepEqual(target.types(), [], 'a returned handler was not the one installed');

  captureConsole(() => {
    target.dispatch('error', { error: new Error('after discard') });
  });
  assert.equal(bodyEl.children.length, 0, 'a removed listener still raised a banner');
});

test('a post-boot uncaught error raises the banner, not just a console line', () => {
  const { bodyEl } = fakeDocument();
  const target = fakeTarget();
  reportPageFailures('solids tool', target);

  const { calls: logged } = captureConsole(() => {
    target.dispatch('error', { error: new Error('renderOps blew up') });
  });

  assert.equal(bodyEl.children.length, 1, 'no banner for a post-boot error');
  assert.match(messageOf(bodyEl.children[0]),
    /^⚠ The solids tool hit an error — renderOps blew up —/);
  assert.equal(logged.length, 1);
});

test('a post-boot unhandled rejection raises the banner and is not double-reported', () => {
  const { bodyEl } = fakeDocument();
  const target = fakeTarget();
  reportPageFailures('palette tool', target);

  let prevented = 0;
  const { calls: logged } = captureConsole(() => {
    target.dispatch('unhandledrejection', {
      reason: new Error('bakeLut rejected'),
      preventDefault: () => { prevented++; },
    });
  });

  assert.equal(prevented, 1, 'the browser duplicate report was not suppressed');
  assert.match(messageOf(bodyEl.children[0]), /bakeLut rejected/);
  assert.equal(logged.length, 1);
});

test('a failed subresource does not raise the page-failure banner', () => {
  const { bodyEl } = fakeDocument();
  const target = fakeTarget();
  reportPageFailures('palette tool', target);

  captureConsole(() => {
    target.dispatch('error', { target: { tagName: 'IMG' }, error: null });
  });
  assert.equal(bodyEl.children.length, 0, 'a subresource error opened a banner');
});

test('bootstrapTool installs the post-boot surface alongside the load handler', () => {
  const { bodyEl } = fakeDocument();
  const target = fakeTarget();
  bootstrapTool(() => { }, 'Möbius tool', target);
  assert.deepEqual(target.types().sort(), ['error', 'load', 'unhandledrejection']);

  // The boot path still reports through the same banner.
  captureConsole(() => {
    target.dispatch('load');
    assert.equal(bodyEl.children.length, 0, 'a clean init opened a banner');
    target.dispatch('error', { error: new Error('after boot') });
  });
  assert.match(messageOf(bodyEl.children[0]), /Möbius tool hit an error — after boot/);
});

test('bootstrapTool still banners a synchronous and an async init failure', async () => {
  const target = fakeTarget();
  const { bodyEl } = fakeDocument();
  bootstrapTool(() => { throw new Error('sync boom'); }, 'solids tool', target);
  captureConsole(() => target.dispatch('load'));
  assert.match(messageOf(bodyEl.children[0]), /failed to initialize/);

  // Every tool page's initializer is async: its failure arrives as a rejection
  // the load handler has already returned from.
  const asyncTarget = fakeTarget();
  const asyncPage = fakeDocument();
  const captured = installConsoleCapture('error', 'warn');
  try {
    bootstrapTool(async () => { throw new Error('async boom'); }, 'palette tool', asyncTarget);
    asyncTarget.dispatch('load');
    await Promise.resolve();
  } finally {
    captured.restore();
  }
  const logged = captured.calls;

  assert.equal(asyncPage.bodyEl.children.length, 1, 'a rejected init raised no banner');
  assert.match(messageOf(asyncPage.bodyEl.children[0]),
    /^⚠ The palette tool failed to initialize/);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /palette tool failed to initialize/);
});
