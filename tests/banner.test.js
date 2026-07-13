// @ts-check
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { showFatalError } from '../tools/banner.js';

// Restore any globalThis.document stub after each test so it never leaks.
const savedDocument = globalThis.document;
afterEach(() => {
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
});

// Minimal fake DOM: getElementById resolves against whatever was appended, so
// idempotent reuse can be observed. body defaults present; pass {body: null} to
// exercise the no-body guard, and {documentElement: true} to model the
// pre-<body> parse state where <html> exists but <body> does not.
function fakeDocument({ body = true, documentElement = false } = {}) {
  const byId = new Map();
  const created = [];
  const makeParent = () => ({
    children: [],
    appendChild(el) { this.children.push(el); byId.set(el.id, el); },
  });
  const bodyEl = body ? makeParent() : null;
  const docEl = documentElement ? makeParent() : undefined;
  globalThis.document = {
    getElementById: (id) => byId.get(id) || null,
    createElement: () => {
      const el = {
        id: '', textContent: '', style: {}, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
      };
      created.push(el);
      return el;
    },
    body: bodyEl,
    documentElement: docEl,
  };
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
