import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectPanelEdits } from '../effect_panel_edits.js';

function fixture() {
  const target = new EventTarget();
  const writes = [];
  const edits = new EffectPanelEdits(target, value => writes.push(value));
  const controller = { domElement: new EventTarget(), $input: new EventTarget() };
  edits.trackDrag(controller);
  edits.trackKeyboard(controller);
  const emit = (node, type, fields = {}) =>
    node.dispatchEvent(Object.assign(new Event(type), fields));
  return { target, writes, edits, controller, emit };
}

test('edit lifetime separates keyboard completion from an active pointer', () => {
  const { target, writes, edits, controller, emit } = fixture();
  emit(controller.domElement, 'pointerdown', { isPrimary: true, button: 0, pointerId: 4 });
  emit(controller.$input, 'keydown', { key: 'ArrowUp' });
  edits.persist(controller, { name: 'rate', accepted: 2 });
  edits.persist(controller, { name: 'rate', accepted: 3 });
  emit(controller.$input, 'keyup');
  assert.equal(edits.active, true);
  emit(target, 'pointerup', { pointerId: 9 });
  assert.deepEqual(writes, []);
  emit(target, 'pointerup', { pointerId: 4 });
  assert.equal(edits.active, false);
  assert.deepEqual(writes, [{ name: 'rate', accepted: 3 }]);
});

test('disposal flushes a deferred write once and detaches its global listener', () => {
  const { target, writes, edits, controller, emit } = fixture();
  emit(controller.domElement, 'pointerdown', { isPrimary: true, button: 0, pointerId: 4 });
  edits.persist(controller, { name: 'rate', accepted: 2 });
  edits.dispose();
  assert.equal(edits.active, false);
  edits.persist(controller, { name: 'rate', accepted: 3 });
  emit(target, 'blur');
  assert.deepEqual(writes, [{ name: 'rate', accepted: 2 }]);
});

test('keyboard-only edits persist immediately and release their rebuild guard on blur', () => {
  const { writes, edits, controller, emit } = fixture();
  emit(controller.$input, 'keydown', { key: 'ArrowDown' });
  edits.persist(controller, { name: 'rate', accepted: 1 });
  assert.equal(edits.active, true);
  assert.deepEqual(writes, [{ name: 'rate', accepted: 1 }]);
  emit(controller.$input, 'blur');
  assert.equal(edits.active, false);
});
