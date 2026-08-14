//
// fake_three.js's upload semantics and teardown sink, pinned on their own.
// app_lifecycle.test.js, driver.test.js and segment_controller.test.js all
// assert display aliasing through fakeColorAttribute, so a size guard that
// accepted a re-point no GPU buffer can take, or a version that stopped
// counting, would read there as an assertion about the module under test rather
// than about the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  log,
  fakeColorAttribute,
  Mesh,
  MeshBasicMaterial,
  Scene,
  SphereGeometry,
} from './fake_three.js';

/**
 * A typed array whose ArrayBuffer has been detached, as a WASM heap growth
 * leaves every view onto the old memory.
 * @param {number} bytes - Size of the buffer before it is transferred away.
 * @returns {Uint16Array} The detached view: length 0 over a 0-byte buffer.
 */
function detachedView(bytes) {
  const buffer = new ArrayBuffer(bytes);
  const view = new Uint16Array(buffer);
  structuredClone(buffer, { transfer: [buffer] });
  return view;
}

test('a null-backed attribute takes its size from the first array it binds', () => {
  const attribute = fakeColorAttribute(null);
  assert.equal(attribute.array, null);

  attribute.array = new Uint16Array(4);
  attribute.array = new Uint16Array(4);
  assert.equal(attribute.array.length, 4, 'a same-length re-point is a bufferSubData');

  assert.throws(() => { attribute.array = new Uint16Array(2); },
    /re-pointed at length 2, but the GPU buffer is sized 4/);
});

test('an array-backed attribute is sized at construction', () => {
  const attribute = fakeColorAttribute(new Uint16Array(6));

  assert.throws(() => { attribute.array = new Uint16Array(3); },
    /GPU buffer is sized 6/);
  assert.equal(attribute.array.length, 6, 'the refused re-point left the array alone');
});

test('a null array detaches without resizing the buffer', () => {
  const attribute = fakeColorAttribute(new Uint16Array(4));

  attribute.array = null;
  assert.equal(attribute.array, null, 'the dispose path drops the view');

  assert.throws(() => { attribute.array = new Uint16Array(2); },
    /GPU buffer is sized 4/, 'the size outlives the detach, as the GPU buffer does');
});

test('a view whose buffer was detached binds nothing', () => {
  const attribute = fakeColorAttribute(detachedView(8));
  assert.equal(attribute.array.length, 0);

  attribute.array = new Uint16Array(4);
  assert.equal(attribute.array.length, 4,
    'a detached view never sized the buffer, so the first live array does');
  assert.throws(() => { attribute.array = new Uint16Array(2); }, /GPU buffer is sized 4/);
});

test('needsUpdate only ever raises the version', () => {
  const attribute = fakeColorAttribute(new Uint16Array(4));
  assert.equal(attribute.version, 0);

  attribute.needsUpdate = true;
  attribute.needsUpdate = true;
  assert.equal(attribute.version, 2, 'each flagged upload is its own version');

  attribute.needsUpdate = false;
  assert.equal(attribute.version, 2, 'nothing can unflag an upload');
  assert.equal(attribute.needsUpdate, undefined, 'the flag is write-only');
});

test('only the dispose paths append to the shared teardown log', () => {
  const before = log.length;
  const scene = new Scene();
  const geometry = new SphereGeometry();
  const material = new MeshBasicMaterial({});
  scene.add(new Mesh(geometry, material));

  assert.equal(log.length, before, 'construction and add() are silent');

  scene.clear();
  geometry.dispose();
  material.dispose();

  assert.deepEqual(log.slice(before),
    ['scene.clear', 'geometry.dispose', 'material.dispose']);
  assert.deepEqual(scene.children, [], 'clear() empties the scene as well as logging');
});
