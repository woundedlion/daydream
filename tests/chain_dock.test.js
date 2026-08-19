//
// tools/chain_dock.js carries the parameter dock beside the canvas: the
// collapse toggle that trades its width back to the render, and the
// union-schema predicate the parameter filter dims deactivated fields with.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createParameterDock, deactivatedParamNames } from '../tools/chain_dock.js';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

restoreDocumentAfterEach();

/** A dock over a container holding its toggle and one focusable control. */
function makeDock() {
  const container = fakeElement('aside');
  const toggle = fakeElement('button');
  const control = fakeElement('input');
  container.appendChild(toggle);
  container.appendChild(control);
  const doc = installDocument({
    body: fakeElement('body'),
    activeElement: null,
    createElement: (/** @type {string} */ tag) => fakeElement(tag),
  });
  const dock = createParameterDock({ doc, container, toggle });
  return { dock, container, toggle, control, doc };
}

test('the dock opens expanded and the toggle flips it both ways', () => {
  const h = makeDock();
  assert.equal(h.dock.collapsed(), false);
  assert.equal(h.container.dataset.collapsed, 'false');
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'true');

  h.toggle.dispatch('click');
  assert.equal(h.dock.collapsed(), true);
  assert.equal(h.container.dataset.collapsed, 'true');
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'false');

  h.toggle.dispatch('click');
  assert.equal(h.dock.collapsed(), false);
  assert.equal(h.container.dataset.collapsed, 'false');
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'true');
});

test('setCollapsed drives the same state the toggle does', () => {
  const h = makeDock();
  h.dock.setCollapsed(true);
  assert.equal(h.dock.collapsed(), true);
  assert.equal(h.container.dataset.collapsed, 'true');

  // Committing an insert reopens the dock on the new instance, whether or not
  // the user left it collapsed.
  h.dock.setCollapsed(false);
  assert.equal(h.dock.collapsed(), false);
  assert.equal(h.toggle.getAttribute('aria-expanded'), 'true');
});

test('collapsing pulls keyboard focus out of the dock onto the toggle', () => {
  const h = makeDock();
  h.control.focus();
  assert.equal(h.doc.activeElement, h.control);

  h.dock.setCollapsed(true);
  assert.equal(h.doc.activeElement, h.toggle,
    'a collapsed dock is unreachable, so focus inside it would be stranded');

  // Focus outside the dock is nobody's to move.
  const elsewhere = fakeElement('button');
  elsewhere.focus();
  h.dock.setCollapsed(false);
  h.dock.setCollapsed(true);
  assert.equal(h.doc.activeElement, elsewhere);
});

test('destroy leaves the toggle inert', () => {
  const h = makeDock();
  h.dock.destroy();
  h.toggle.dispatch('click');
  assert.equal(h.dock.collapsed(), false);
  assert.deepEqual(h.toggle.listeners.filter((l) => l.type === 'click'), []);
});

test('deactivatedParamNames flags edge-width only while its gate is off edge-fade', () => {
  const definitions = [
    { name: 'sample.coverage-mode', value: 1,
      options: ['none', 'weight', 'weight-squared', 'edge-fade'] },
    { name: 'sample.edge-width', value: 0.1 },
    { name: 'warp1.envelope', value: 2,
      options: ['flat', 'projection-weight', 'edge-fade'] },
    { name: 'warp1.edge-width', value: 0.1 },
    { name: 'camera.wander', value: 0 },
  ];
  assert.deepEqual([...deactivatedParamNames(definitions)], ['sample.edge-width']);
  assert.deepEqual([...deactivatedParamNames([
    { name: 'sample.edge-width', value: 0.1 },
  ])], [], 'no gate, no deactivation');
});

test('a requested enum value gates ahead of the applied one', () => {
  const pending = [
    { name: 'sample.coverage-mode', value: 3, requestedValue: 0,
      options: ['none', 'weight', 'weight-squared', 'edge-fade'] },
    { name: 'sample.edge-width', value: 0.1 },
  ];
  assert.deepEqual([...deactivatedParamNames(pending)], ['sample.edge-width'],
    'the dimming follows the value the document asked for');
});
