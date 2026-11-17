import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {createViewReset} from '../src/renderer/driver_input.js';
import {fakeElement} from './helpers/fake_dom.js';

test('view reset disposal cancels animation and removes every input listener', () => {
  const button = fakeElement('button'), canvas = fakeElement('canvas');
  const controls = Object.assign(fakeElement('div'), {target: new THREE.Vector3(1, 2, 3), update() {}});
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(10, 20, 30);
  let next = 1, paints = 0;
  const pending = new Map();
  const reset = createViewReset({doc: {getElementById: () => button}, canvas, controls, camera,
    win: {performance: {now: () => 0}, matchMedia: () => ({matches: false}),
      requestAnimationFrame(fn) { const id = next++; pending.set(id, fn); return id; },
      cancelAnimationFrame(id) { pending.delete(id); }},
    invalidate() { paints++; }, durationMs: 250});
  button.dispatch('click');
  assert.equal(paints, 1);
  assert.equal(pending.size, 1);
  controls.dispatch('start');
  assert.equal(pending.size, 0);
  canvas.dispatch('dblclick');
  assert.equal(pending.size, 1);
  canvas.dispatch('keydown');
  assert.equal(pending.size, 0);
  reset.reset();
  assert.equal(pending.size, 1);
  reset.dispose();
  assert.equal(pending.size, 0);
  assert.deepEqual(button.listeners, []);
  assert.deepEqual(canvas.listeners, []);
  assert.deepEqual(controls.listeners, []);
  const before = paints;
  button.dispatch('click');
  canvas.dispatch('dblclick');
  assert.equal(paints, before);
});
