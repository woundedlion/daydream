import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireFlyout } from '../tools/flyout.js';
import {
  documentEvents, fakeElement, installDocument, restoreDocumentAfterEach,
} from './fake_dom.js';

restoreDocumentAfterEach();

/**
 * The flyout as the pages build it: a root holding the trigger button and the
 * panel it exposes, with a link inside the panel to press Escape from. Escape
 * reaches the root by bubbling, as it does in a browser where focus sits on
 * whatever the reader tabbed to, so a listener attached anywhere but the root
 * misses it here too.
 * @returns {Object} The nodes, the document stand-in, and the installed document.
 */
function harness() {
  const root = fakeElement('div', { connected: true });
  const trigger = fakeElement('button');
  const panel = fakeElement('div');
  const item = fakeElement('a');
  root.appendChild(trigger);
  root.appendChild(panel);
  panel.appendChild(item);

  const document = installDocument({ activeElement: null });
  return {
    root, trigger, panel, item, documentTarget: documentEvents(), document,
    outside: fakeElement('div'),
  };
}

test('flyout toggles its visible and accessible state', () => {
  const h = harness();
  wireFlyout(h);

  assert.equal(h.trigger.getAttribute('aria-expanded'), 'false');
  h.trigger.dispatch('click');
  assert.equal(h.trigger.getAttribute('aria-expanded'), 'true');
  assert.ok(h.root.classList.contains('is-open'));

  h.trigger.dispatch('click');
  assert.equal(h.trigger.getAttribute('aria-expanded'), 'false');
  assert.ok(!h.root.classList.contains('is-open'));
});

test('flyout dismisses outside and with Escape', () => {
  const h = harness();
  wireFlyout(h);

  h.trigger.dispatch('click');
  h.documentTarget.dispatch('pointerdown', { target: h.item });
  assert.ok(h.root.classList.contains('is-open'), 'a press inside the panel dismissed it');

  h.documentTarget.dispatch('pointerdown', { target: h.outside });
  assert.ok(!h.root.classList.contains('is-open'));

  h.trigger.dispatch('click');
  h.item.dispatch('keydown', { key: 'Escape' });
  assert.ok(!h.root.classList.contains('is-open'), 'Escape from inside the panel never reached');
  assert.equal(h.document.activeElement, h.trigger, 'focus must land back on the trigger');
});

test('flyout ignores a key that is not Escape', () => {
  const h = harness();
  wireFlyout(h);

  h.trigger.dispatch('click');
  h.item.dispatch('keydown', { key: 'ArrowDown' });
  assert.ok(h.root.classList.contains('is-open'));
});

test('flyout teardown removes listeners and closes it', () => {
  const h = harness();
  const external = () => {};
  h.root.addEventListener('keydown', external);
  const teardown = wireFlyout(h);
  h.trigger.dispatch('click');

  teardown();

  assert.deepEqual(h.root.listeners.map((l) => l.handler), [external]);
  assert.deepEqual(h.trigger.listeners, []);
  assert.equal(h.documentTarget.listenerCount('pointerdown'), 0);
  assert.ok(!h.root.classList.contains('is-open'));
  assert.equal(h.trigger.getAttribute('aria-expanded'), 'false');
});
