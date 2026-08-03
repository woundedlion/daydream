import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showFatalError } from '../tools/banner.js';
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
  assert.equal(el.innerHTML, undefined);
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
