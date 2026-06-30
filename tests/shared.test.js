// @ts-nocheck
//
// showFatalError renders the tool-page WASM-load-failure banner. Key invariant:
// it is idempotent — repeat calls reuse the single #fatal-error-overlay element
// and show the latest message, never stacking duplicate banners.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// shared.js statically imports three + three/addons (resolved from node_modules
// in Node, an import map in the browser). showFatalError itself touches only
// `document`, stubbed per-test below.
const { showFatalError } = await import('../tools/shared.js');

/**
 * Build a minimal document stub backed by an id->element map, tracking how many
 * elements get appended to body so duplicate banners are observable.
 * @returns {{doc: object, appended: object[]}} The stub and the append log.
 */
function makeDocStub() {
  const byId = new Map();
  const appended = [];
  const makeEl = () => ({ id: '', textContent: '', style: {} });
  const doc = {
    getElementById: (id) => byId.get(id) || null,
    createElement: () => makeEl(),
    body: {
      appendChild: (el) => {
        appended.push(el);
        if (el.id) byId.set(el.id, el);
        return el;
      },
    },
  };
  return { doc, appended };
}

let savedDoc;
beforeEach(() => { savedDoc = globalThis.document; });
afterEach(() => { globalThis.document = savedDoc; });

/** Verifies the first call appends one banner whose text carries the message. */
test('showFatalError renders one banner showing the message', () => {
  const { doc, appended } = makeDocStub();
  globalThis.document = doc;

  showFatalError('engine missing');

  assert.equal(appended.length, 1, 'exactly one banner appended');
  assert.equal(appended[0].id, 'fatal-error-overlay');
  assert.match(appended[0].textContent, /engine missing/);
});

/** Verifies repeat calls reuse the single banner and show the latest message. */
test('showFatalError is idempotent and shows the latest message', () => {
  const { doc, appended } = makeDocStub();
  globalThis.document = doc;

  showFatalError('first failure');
  showFatalError('second failure');

  assert.equal(appended.length, 1, 'no duplicate banner on the second call');
  assert.match(appended[0].textContent, /second failure/);
  assert.doesNotMatch(appended[0].textContent, /first failure/);
});
