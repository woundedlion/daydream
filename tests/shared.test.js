// @ts-nocheck
//
// shared.js's own export is initScene; showFatalError et al. are re-exports
// covered by their source modules' tests (banner.test.js, clipboard.test.js,
// cpp_format.test.js). initScene statically imports three + three/addons
// (resolved from node_modules in Node). Its element-lookup guards run before any
// THREE object is constructed, so they are reachable with a document stub alone.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { capPixelRatio, initScene } = await import('../tools/shared.js');

const savedDocument = globalThis.document;
afterEach(() => {
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
});

/** Stub document.getElementById against a fixed id->element map. */
function stubDocument(byId) {
  globalThis.document = { getElementById: (id) => byId[id] || null };
}

test('capPixelRatio preserves low-density displays and caps high-density displays', () => {
  assert.equal(capPixelRatio(0.75), 0.75);
  assert.equal(capPixelRatio(1), 1);
  assert.equal(capPixelRatio(3), 1);
});

test('initScene throws when the container element is absent', () => {
  stubDocument({});
  assert.throws(() => initScene('viewport', 'gl'),
    /container element #viewport not found/);
});

test('initScene throws when the canvas element is absent', () => {
  stubDocument({ viewport: { clientWidth: 640, clientHeight: 480 } });
  assert.throws(() => initScene('viewport', 'gl'),
    /canvas element #gl not found/);
});
