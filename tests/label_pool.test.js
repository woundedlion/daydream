//
// LabelPool backs driver.js's zero-allocation-per-frame label reuse. It imports
// three (resolved from node_modules in Node); LabelPool.acquire touches only
// document.createElement and the scene's add/remove, so a create-element stub
// plus a parent-tracking scene stub exercise the real pooling logic without a DOM.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LabelPool } from '../driver.js';

const savedDocument = globalThis.document;
afterEach(() => {
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
});

// Stub element carrying only the fields CSS2DObject's constructor and
// LabelPool.acquire read/write.
function stubElement() {
  return { style: {}, setAttribute() {}, className: '', textContent: '' };
}

// Parent-tracking scene stub: add/remove mirror what THREE.Object3D exposes to
// LabelPool (parent identity and re-add), without the real removed-event DOM path.
function stubScene() {
  return {
    add(obj) { obj.parent = this; },
    remove(obj) { obj.parent = null; },
  };
}

function makePool() {
  globalThis.document = { createElement: stubElement };
  return new LabelPool(stubScene());
}

const UNIT_X = new THREE.Vector3(1, 0, 0);

test('LabelPool.acquire grows the pool one object per new slot', () => {
  const pool = makePool();
  pool.acquire(UNIT_X, 'a');
  pool.acquire(UNIT_X, 'b');
  pool.acquire(UNIT_X, 'c');
  assert.equal(pool.pool.length, 3);
  assert.equal(pool.activeCount, 3);
});

test('LabelPool reuses pooled objects after reset without allocating', () => {
  const pool = makePool();
  pool.acquire(UNIT_X, 'a');
  pool.acquire(UNIT_X, 'b');
  const [first, second] = pool.pool;
  // A hidden pooled object must come back shown, not carry its old state.
  first.visible = false;

  pool.reset();
  assert.equal(pool.activeCount, 0);

  pool.acquire(UNIT_X, 'x');
  assert.equal(pool.pool.length, 2, 'no new object allocated on reuse');
  assert.equal(pool.pool[0], first, 'the same pooled object is handed back');
  assert.equal(pool.pool[1], second);
  assert.equal(first.element.textContent, 'x', 'reused label content is refreshed');
  assert.equal(first.visible, true, 'reused label is shown again');
});

test('LabelPool.acquire scales placement to the sphere and shows the label', () => {
  const pool = makePool();
  pool.acquire(UNIT_X, 'a');
  const obj = pool.pool[0];
  assert.equal(obj.element.className, 'label');
  assert.equal(obj.visible, true);
  assert.equal(obj.parent, pool.scene, 'acquired label is added to the scene');
  // position = unit direction scaled to the sphere surface (a positive radius).
  assert.ok(obj.position.x > 1, 'placement is scaled past the unit direction');
  assert.equal(obj.position.y, 0);
  assert.equal(obj.position.z, 0);
  assert.ok(Math.abs(obj.position.x - obj.position.length()) < 1e-9);
});

test('LabelPool.cleanup drops labels unused this frame and keeps active ones', () => {
  const pool = makePool();
  pool.acquire(UNIT_X, 'a');
  pool.acquire(UNIT_X, 'b');
  pool.acquire(UNIT_X, 'c');
  const [kept, drop1, drop2] = pool.pool;

  pool.reset();
  pool.acquire(UNIT_X, 'still-here');
  pool.cleanup();

  assert.equal(kept.parent, pool.scene, 'this-frame label stays in the scene');
  assert.equal(drop1.parent, null, 'stale label removed from the scene');
  assert.equal(drop2.parent, null);
  assert.equal(pool.pool.length, 3, 'pool objects are retained for future reuse');
});

test('LabelPool re-adds a reused label that cleanup removed', () => {
  const pool = makePool();
  pool.acquire(UNIT_X, 'a');
  pool.acquire(UNIT_X, 'b');
  const reused = pool.pool[1];

  pool.reset();
  pool.acquire(UNIT_X, 'one'); // only slot 0 active
  pool.cleanup(); // removes slot 1
  assert.equal(reused.parent, null);

  pool.reset();
  pool.acquire(UNIT_X, 'again-0');
  pool.acquire(UNIT_X, 'again-1'); // slot 1 reused
  assert.equal(reused.parent, pool.scene, 'reused label is re-added to the scene');
});
