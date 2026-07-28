// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showFatalError } from '../tools/banner.js';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

restoreDocumentAfterEach();

// Minimal fake DOM: getElementById resolves against whatever was appended, so
// idempotent reuse can be observed. body defaults present; pass {body: null} to
// exercise the no-body guard, and {documentElement: true} to model the
// pre-<body> parse state where <html> exists but <body> does not.
function fakeDocument({ body = true, documentElement = false } = {}) {
  const byId = new Map();
  const created = [];
  const makeParent = () => {
    const parent = fakeElement('div');
    parent.appendChild = (el) => { parent.children.push(el); byId.set(el.id, el); return el; };
    return parent;
  };
  const bodyEl = body ? makeParent() : null;
  const docEl = documentElement ? makeParent() : undefined;
  installDocument({
    getElementById: (id) => byId.get(id) || null,
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

test('showFatalError appends one banner carrying the message as textContent', () => {
  const { created, bodyEl } = fakeDocument();
  showFatalError('engine failed to load');

  assert.equal(created.length, 1);
  assert.equal(bodyEl.children.length, 1);
  const el = bodyEl.children[0];
  assert.equal(el.id, 'fatal-error-overlay');
  assert.equal(el.attributes.role, 'alert');
  assert.equal(el.textContent, '⚠ engine failed to load');
});

test('showFatalError writes textContent, never innerHTML — markup is not interpreted', () => {
  const { created } = fakeDocument();
  showFatalError('<img src=x onerror=alert(1)>');

  const el = created[0];
  assert.equal(el.textContent, '⚠ <img src=x onerror=alert(1)>');
  assert.equal(el.innerHTML, undefined);
});

test('showFatalError is idempotent — repeated calls reuse the single banner', () => {
  const { created, bodyEl } = fakeDocument();
  showFatalError('first');
  showFatalError('second');

  assert.equal(created.length, 1);
  assert.equal(bodyEl.children.length, 1);
  assert.equal(bodyEl.children[0].textContent, '⚠ second');
});

test('showFatalError falls back to documentElement when body is absent', () => {
  const { docEl } = fakeDocument({ body: null, documentElement: true });
  showFatalError('too early');
  assert.equal(docEl.children.length, 1);
  assert.equal(docEl.children[0].textContent, '⚠ too early');
});

test('showFatalError does not throw when neither body nor documentElement exists', () => {
  const { created } = fakeDocument({ body: null });
  assert.doesNotThrow(() => showFatalError('too early'));
  assert.equal(created[0].textContent, '⚠ too early');
});
