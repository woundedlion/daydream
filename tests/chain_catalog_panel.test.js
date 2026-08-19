//
// tools/chain_catalog_panel.js keeps the whole operator vocabulary browsable
// beside the rail: family-grouped entries from the pinned catalog, draggable
// onto the rail's gaps through the editor's drag controller, and clickable to
// insert at the current drop context, where an illegal entry shows disabled
// with the computed reason instead of vanishing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChainCatalogPanel } from '../tools/chain_catalog_panel.js';
import { fakeElement } from './fake_dom.js';

const CATALOG = JSON.parse(readFileSync(
  new URL('../shader/engine_catalog.json', import.meta.url), 'utf8'));

/** A panel over the pinned catalog, plus its spies. */
function makePanel({ elementFromPoint = () => null } = {}) {
  const container = fakeElement('section');
  // createPointerDrag captures on the container; the fake element does not
  // model pointer capture.
  container.setPointerCapture = () => {};
  container.hasPointerCapture = () => true;
  container.releasePointerCapture = () => {};
  const doc = {
    createElement: (/** @type {string} */ tag) => fakeElement(tag),
    elementFromPoint,
  };
  const dragCalls = [];
  const drag = {
    start: (source) => { dragCalls.push(['start', source]); return true; },
    hover: (gap) => dragCalls.push(['hover', gap]),
    drop: () => { dragCalls.push(['drop']); return true; },
    cancel: () => dragCalls.push(['cancel']),
  };
  const picks = [];
  const panel = createChainCatalogPanel({
    doc, container, catalog: CATALOG, drag,
    onPick: (operatorId) => picks.push(operatorId),
  });
  return { panel, container, dragCalls, picks };
}

const entries = (h) => h.container.querySelectorAll('.chain-catalog-entry');
const entryFor = (h, operatorId) =>
  entries(h).find((entry) => entry.dataset.operator === operatorId);

test('the panel groups every catalog operator by the carrier it consumes', () => {
  const h = makePanel();
  const bands = h.container.querySelectorAll('.chain-catalog-band');
  assert.deepEqual(
    bands.map((band) => band.querySelector('.chain-catalog-title').textContent),
    ['Sphere', 'Plane', 'Field'],
    'color consumes nothing in the shipped catalog, so it draws no band');
  assert.equal(entries(h).length, CATALOG.operators.length);

  const sphereBand = bands[0].querySelectorAll('.chain-catalog-entry');
  assert.deepEqual(sphereBand.map((entry) => entry.dataset.operator),
    CATALOG.operators.filter((op) => op.input === 'sphere').map((op) => op.id),
    'entries keep catalog order within their band');

  const rotate = entryFor(h, 'sphere.rotate.v2');
  assert.equal(rotate.querySelector('.chain-catalog-name').textContent, 'Rotate');
  assert.equal(rotate.querySelector('.chain-catalog-pair'), null,
    'an endomorphism needs no carrier-pair badge');
  assert.equal(
    entryFor(h, 'project.stereographic.v2')
      .querySelector('.chain-catalog-pair').textContent,
    'sphere → plane');
});

test('the drop context disables illegal entries with the computed reason', () => {
  const h = makePanel();
  const affine = CATALOG.operators.find((op) => op.id === 'warp.affine.v2');
  const rotate = CATALOG.operators.find((op) => op.id === 'sphere.rotate.v2');
  h.panel.setLegality([
    { operator: affine, legal: false, reason: 'consumes the plane carrier' },
    { operator: rotate, legal: true },
  ]);

  const disabled = entryFor(h, 'warp.affine.v2');
  assert.equal(disabled.getAttribute('aria-disabled'), 'true');
  const reason = disabled.querySelector('.chain-catalog-reason');
  assert.equal(reason.textContent, 'consumes the plane carrier');
  assert.equal(disabled.getAttribute('aria-describedby'), reason.id);
  assert.equal(entryFor(h, 'sphere.rotate.v2').getAttribute('aria-disabled'), null);

  disabled.dispatch('click');
  assert.deepEqual(h.picks, [], 'a disabled entry never picks');
  entryFor(h, 'sphere.rotate.v2').dispatch('click');
  assert.deepEqual(h.picks, ['sphere.rotate.v2']);

  h.panel.setLegality(null);
  assert.equal(entryFor(h, 'warp.affine.v2').getAttribute('aria-disabled'), null,
    'clearing the context re-enables every entry');
});

test('a pointer drag on an entry hands off to the rail drag controller', () => {
  const gap = fakeElement('button');
  gap.className = 'chain-gap';
  gap.dataset.index = '4';
  const h = makePanel({ elementFromPoint: () => gap });

  entryFor(h, 'warp.wave-shear.v2').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 5, clientX: 1, clientY: 2 });
  assert.deepEqual(h.dragCalls, [
    ['start', { kind: 'operator', operatorId: 'warp.wave-shear.v2' }],
  ]);

  entryFor(h, 'warp.wave-shear.v2').dispatch('pointermove',
    { pointerId: 5, clientX: 3, clientY: 4 });
  entryFor(h, 'warp.wave-shear.v2').dispatch('pointerup', { pointerId: 5 });
  assert.deepEqual(h.dragCalls.slice(1), [['hover', 4], ['drop']]);

  // A band title starts nothing.
  h.container.querySelector('.chain-catalog-title').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 6 });
  assert.equal(h.dragCalls.length, 3);
});

test('destroy detaches the pointer listeners and empties the panel', () => {
  const h = makePanel();
  h.panel.destroy();
  assert.equal(h.container.childNodes.length, 0);
  assert.deepEqual(h.container.listeners.filter(
    (listener) => listener.type.startsWith('pointer')), []);
});
