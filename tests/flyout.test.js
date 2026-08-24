import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireFlyout } from '../tools/flyout.js';

const eventTarget = () => {
  const listeners = new Map();
  return {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type, event = {}) { listeners.get(type)?.(event); },
    listenerCount() { return listeners.size; },
  };
};

const harness = () => {
  const classes = new Set();
  const attributes = new Map();
  const root = {
    ...eventTarget(),
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
    contains(target) {
      for (let node = target; node; node = node.parentNode)
        if (node === root) return true;
      return false;
    },
  };
  const trigger = {
    ...eventTarget(),
    setAttribute(name, value) { attributes.set(name, value); },
    getAttribute(name) { return attributes.get(name); },
    focus() { trigger.focused = true; },
    focused: false,
    parentNode: root,
  };
  const inside = { parentNode: trigger };
  const documentTarget = eventTarget();
  return { root, trigger, inside, documentTarget, classes, attributes };
};

test('flyout toggles its visible and accessible state', () => {
  const h = harness();
  wireFlyout(h);

  assert.equal(h.attributes.get('aria-expanded'), 'false');
  h.trigger.dispatch('click');
  assert.equal(h.attributes.get('aria-expanded'), 'true');
  assert.ok(h.classes.has('is-open'));

  h.trigger.dispatch('click');
  assert.equal(h.attributes.get('aria-expanded'), 'false');
  assert.ok(!h.classes.has('is-open'));
});

test('flyout dismisses outside and with Escape', () => {
  const h = harness();
  wireFlyout(h);

  h.trigger.dispatch('click');
  h.documentTarget.dispatch('pointerdown', { target: h.inside });
  assert.ok(h.classes.has('is-open'));

  h.documentTarget.dispatch('pointerdown', { target: {} });
  assert.ok(!h.classes.has('is-open'));

  h.trigger.dispatch('click');
  h.root.dispatch('keydown', { key: 'Escape' });
  assert.ok(!h.classes.has('is-open'));
  assert.ok(h.trigger.focused);
});

test('flyout teardown removes listeners and closes it', () => {
  const h = harness();
  const teardown = wireFlyout(h);
  h.trigger.dispatch('click');

  teardown();

  assert.equal(h.root.listenerCount(), 0);
  assert.equal(h.trigger.listenerCount(), 0);
  assert.equal(h.documentTarget.listenerCount(), 0);
  assert.ok(!h.classes.has('is-open'));
  assert.equal(h.attributes.get('aria-expanded'), 'false');
});
