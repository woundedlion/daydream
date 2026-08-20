//
// tools/chain_library.js keeps the whole operator vocabulary browsable under the
// pipeline strip: domain-grouped entries from the pinned catalog, draggable onto
// the strip through its drag controller, clickable to land wherever the chain
// takes them, and narrowable by a filter that never hides an entry's disabled
// state or the reason its legality computed, which an enabled entry carries too
// where the route it takes is not plain insertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChainLibrary } from '../tools/chain_library.js';
import { fakeElement } from './fake_dom.js';

const CATALOG = JSON.parse(readFileSync(
  new URL('../shader/engine_catalog.json', import.meta.url), 'utf8'));

const AFFINE = CATALOG.operators.find((op) => op.id === 'warp.affine.v2');
const ROTATE = CATALOG.operators.find((op) => op.id === 'sphere.rotate.v2');
const GNOMONIC = CATALOG.operators.find((op) => op.id === 'project.gnomonic.v2');

/**
 * A library over the pinned catalog, plus its spies.
 * @param {{dropped?: boolean}} [seams] - Whether the strip's drag controller
 *   reports the release as a committed drop.
 * @returns {Object} The harness.
 */
function makeLibrary({ dropped = true } = {}) {
  const container = fakeElement('section');
  // createPointerDrag captures on the container; the fake element does not
  // model pointer capture.
  container.setPointerCapture = () => {};
  container.hasPointerCapture = () => true;
  container.releasePointerCapture = () => {};
  const doc = { createElement: (/** @type {string} */ tag) => fakeElement(tag) };
  const dragCalls = [];
  const drag = {
    start: (source) => { dragCalls.push(['start', source]); return true; },
    hoverFromPoint: (x, y) => dragCalls.push(['hoverFromPoint', x, y]),
    drop: () => { dragCalls.push(['drop']); return dropped; },
    cancel: () => dragCalls.push(['cancel']),
  };
  const picks = [];
  const announced = [];
  const library = createChainLibrary({
    doc,
    container,
    catalog: CATALOG,
    drag,
    announce: (message) => announced.push(message),
    onPick: (operatorId) => picks.push(operatorId),
  });
  return { library, container, dragCalls, picks, announced };
}

const groups = (h) => h.container.querySelectorAll('.chain-library-group');
const entries = (h) => h.container.querySelectorAll('.chain-library-entry');
const entryFor = (h, operatorId) =>
  entries(h).find((entry) => entry.dataset.operator === operatorId);
const filterOf = (h) => h.container.querySelector('.chain-library-filter');
const tabs = (h) => h.container.querySelectorAll('.chain-library-tab');
const narrow = (h, text) => {
  const filter = filterOf(h);
  filter.value = text;
  filter.dispatch('input');
};

test('the library groups every catalog operator by the carrier it consumes', () => {
  const h = makeLibrary();
  assert.deepEqual(groups(h).map((group) => group.dataset.carrier),
    ['sphere', 'plane', 'field'],
    'color consumes nothing in the shipped catalog, so it draws no group');
  for (const group of groups(h)) {
    assert.equal(group.getAttribute('role'), 'group');
    assert.equal(group.getAttribute('aria-label'),
      `${group.querySelector('.chain-library-title').textContent} stages`);
  }
  assert.deepEqual(groups(h).map((group) =>
    group.querySelector('.chain-library-title').textContent),
  ['Sphere', 'Plane', 'Field']);
  assert.equal(entries(h).length, CATALOG.operators.length);

  assert.deepEqual(
    groups(h)[0].querySelectorAll('.chain-library-entry').map((e) => e.dataset.operator),
    CATALOG.operators.filter((op) => op.input === 'sphere').map((op) => op.id),
    'entries keep catalog order within their group');

  const rotate = entryFor(h, 'sphere.rotate.v2');
  assert.equal(rotate.querySelector('.chain-library-name').textContent, 'Rotate');
  assert.equal(rotate.querySelector('.chain-library-pair'), null,
    'an endomorphism needs no carrier-pair badge');
  assert.equal(
    entryFor(h, 'project.stereographic.v2')
      .querySelector('.chain-library-pair').textContent,
    'sphere → plane');
});

test('the filter is a labelled searchbox', () => {
  const h = makeLibrary();
  const filter = filterOf(h);
  assert.equal(filter.tagName, 'INPUT');
  assert.equal(filter.type, 'search');
  const label = h.container.querySelector('.chain-library-filter-label');
  assert.equal(label.tagName, 'LABEL');
  assert.equal(label.getAttribute('for'), filter.id);
  assert.notEqual(label.textContent, '');
});

test('an entry that fits nowhere is disabled with the computed reason', () => {
  const h = makeLibrary();
  h.library.setLegality([
    { operator: AFFINE, legal: false, reason: 'no insertion point accepts it' },
    { operator: ROTATE, legal: true },
  ]);

  const disabled = entryFor(h, 'warp.affine.v2');
  assert.equal(disabled.getAttribute('aria-disabled'), 'true');
  const reason = disabled.querySelector('.chain-library-reason');
  assert.equal(reason.textContent, 'no insertion point accepts it');
  assert.equal(disabled.getAttribute('aria-describedby'), reason.id);
  assert.equal(entryFor(h, 'sphere.rotate.v2').getAttribute('aria-disabled'), null);
  assert.equal(entries(h).length, CATALOG.operators.length,
    'an entry that fits nowhere is disabled, never hidden');

  disabled.dispatch('click');
  assert.deepEqual(h.picks, [], 'a disabled entry never picks');
  assert.deepEqual(h.announced, ['no insertion point accepts it'],
    'the refusal reaches the shared live region');
  entryFor(h, 'sphere.rotate.v2').dispatch('click');
  assert.deepEqual(h.picks, ['sphere.rotate.v2']);

  h.library.setLegality(null);
  assert.equal(entryFor(h, 'warp.affine.v2').getAttribute('aria-disabled'), null,
    'clearing the legality re-enables every entry');
});

// A crossing fits no gap, so the chain reaches it by replacing the socket over
// its carrier pair. The entry is live and says which route it takes; only a pair
// the chain carries no socket for is a dead end.
test('a crossing entry names the socket it swaps, or says there is none', () => {
  const h = makeLibrary();
  h.library.setLegality([
    { operator: GNOMONIC, legal: true, reason: 'swaps the sphere → plane socket' },
    { operator: ROTATE, legal: true },
  ]);

  const crossing = entryFor(h, 'project.gnomonic.v2');
  assert.equal(crossing.getAttribute('aria-disabled'), null);
  const route = crossing.querySelector('.chain-library-reason');
  assert.equal(route.textContent, 'swaps the sphere → plane socket');
  assert.equal(crossing.getAttribute('aria-describedby'), route.id);
  assert.equal(entryFor(h, 'sphere.rotate.v2').querySelector('.chain-library-reason'),
    null, 'a plain insertion names no route');

  crossing.dispatch('click');
  assert.deepEqual(h.picks, ['project.gnomonic.v2']);
  assert.deepEqual(h.announced, [], 'an enabled entry refuses nothing');

  h.library.setLegality([{ operator: GNOMONIC, legal: false,
    reason: 'the chain carries no sphere → plane socket to swap' }]);
  const dead = entryFor(h, 'project.gnomonic.v2');
  assert.equal(dead.getAttribute('aria-disabled'), 'true');
  assert.equal(dead.querySelector('.chain-library-reason').textContent,
    'the chain carries no sphere → plane socket to swap');

  dead.dispatch('click');
  assert.deepEqual(h.picks, ['project.gnomonic.v2'], 'a dead crossing picks nothing');
  assert.equal(h.announced.at(-1),
    'the chain carries no sphere → plane socket to swap');
});

test('the filter narrows every group by name or id', () => {
  const h = makeLibrary();
  narrow(h, 'LENS');
  assert.deepEqual(groups(h).map((group) => group.dataset.carrier), ['sphere'],
    'a group left empty by the filter is not rendered');
  assert.deepEqual(entries(h).map((entry) => entry.dataset.operator),
    CATALOG.operators.filter((op) => op.id.includes('lens.')).map((op) => op.id),
    'the match is case-insensitive');

  narrow(h, 'sample.');
  assert.deepEqual(groups(h).map((group) => group.dataset.carrier), ['plane'],
    'an id substring matches where the display name does not');
  assert.equal(entries(h).length,
    CATALOG.operators.filter((op) => op.id.startsWith('sample.')).length);

  narrow(h, 'no such stage');
  assert.deepEqual(groups(h), []);

  narrow(h, '');
  assert.equal(entries(h).length, CATALOG.operators.length);
  assert.equal(filterOf(h).value, '', 'the filter box survives every rebuild');
});

test('a filtered-in entry keeps the disabled state its legality gave it', () => {
  const h = makeLibrary();
  h.library.setLegality([{ operator: AFFINE, legal: false, reason: 'fits nowhere' }]);
  narrow(h, 'affine');

  const entry = entryFor(h, 'warp.affine.v2');
  assert.equal(entries(h).length, 1);
  assert.equal(entry.getAttribute('aria-disabled'), 'true');
  assert.equal(entry.querySelector('.chain-library-reason').textContent, 'fits nowhere');
  assert.equal(entry.getAttribute('aria-describedby'),
    entry.querySelector('.chain-library-reason').id);
});

test('the library carries one domain tab per rendered group', () => {
  const h = makeLibrary();
  assert.deepEqual(tabs(h).map((tab) => tab.dataset.carrier),
    ['sphere', 'plane', 'field']);
  assert.deepEqual(tabs(h).map((tab) => tab.textContent), ['Sphere', 'Plane', 'Field']);
  for (const tab of tabs(h)) assert.equal(tab.tagName, 'BUTTON');
  assert.deepEqual(tabs(h).map((tab) => tab.getAttribute('aria-pressed')),
    ['true', 'false', 'false']);
  assert.equal(h.container.dataset.activeCarrier, 'sphere');
});

test('a tab moves the active carrier the narrow layout reads', () => {
  const h = makeLibrary();
  tabs(h).find((tab) => tab.dataset.carrier === 'field').dispatch('click');

  assert.equal(h.container.dataset.activeCarrier, 'field');
  assert.deepEqual(tabs(h).map((tab) => tab.getAttribute('aria-pressed')),
    ['false', 'false', 'true']);
  assert.equal(groups(h).length, 3,
    'every group stays in the DOM; only the stylesheet hides the inactive ones');
  assert.deepEqual(h.picks, [], 'a tab inserts nothing');
});

test('a filter that drops the active domain re-homes it onto a rendered one', () => {
  const h = makeLibrary();
  tabs(h).find((tab) => tab.dataset.carrier === 'field').dispatch('click');
  narrow(h, 'sample.');

  assert.deepEqual(tabs(h).map((tab) => tab.dataset.carrier), ['plane']);
  assert.equal(h.container.dataset.activeCarrier, 'plane');
  assert.equal(tabs(h)[0].getAttribute('aria-pressed'), 'true');

  narrow(h, 'no such stage');
  assert.deepEqual(tabs(h), []);
  assert.equal(h.container.dataset.activeCarrier, undefined,
    'an empty library names no domain');

  narrow(h, '');
  assert.equal(h.container.dataset.activeCarrier, 'sphere');
});

test('a pointer drag on an entry hands off to the strip drag controller', () => {
  const h = makeLibrary();
  const entry = () => entryFor(h, 'warp.wave-shear.v2');
  entry().dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 5, clientX: 1, clientY: 2 });
  assert.deepEqual(h.dragCalls, [
    ['start', { kind: 'operator', operatorId: 'warp.wave-shear.v2' }],
  ]);

  assert.equal(entry().dataset.dragging, 'true',
    'the entry the gesture was picked up from reads as picked up');

  entry().dispatch('pointermove', { pointerId: 5, clientX: 3, clientY: 4 });
  entry().dispatch('pointerup', { pointerId: 5 });
  assert.deepEqual(h.dragCalls.slice(1), [['hoverFromPoint', 3, 4], ['drop']],
    'the library resolves nothing itself; the strip hit-tests the point');
  assert.equal(entry().dataset.dragging, undefined,
    'the mark is cleared before the drop, which may re-render the library');

  // A group title, a domain tab and the filter box start nothing.
  h.container.querySelector('.chain-library-title').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 6 });
  tabs(h)[0].dispatch('pointerdown', { isPrimary: true, button: 0, pointerId: 7 });
  filterOf(h).dispatch('pointerdown', { isPrimary: true, button: 0, pointerId: 8 });
  assert.equal(h.dragCalls.length, 3);
});

test('an entry that fits nowhere still drags', () => {
  const h = makeLibrary();
  h.library.setLegality([{ operator: AFFINE, legal: false, reason: 'fits nowhere' }]);

  entryFor(h, 'warp.affine.v2').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 9, clientX: 1, clientY: 2 });
  assert.deepEqual(h.dragCalls, [
    ['start', { kind: 'operator', operatorId: 'warp.affine.v2' }],
  ], 'the drop target carries its own legality');
});

// The capture a drag opens with retargets the click that follows to the
// container, so a press that never travels is what reaches an entry as a click.
test('a press that never travels inserts; one that misses its drop does not', () => {
  const h = makeLibrary({ dropped: false });
  const entryAt = (/** @type {string} */ id) => entryFor(h, id);
  const wave = 'warp.wave-shear.v2';

  entryAt(wave).dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 3, clientX: 10, clientY: 10 });
  entryAt(wave).dispatch('pointerup', { pointerId: 3 });
  assert.deepEqual(h.picks, [wave]);

  entryAt(wave).dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 4, clientX: 10, clientY: 10 });
  entryAt(wave).dispatch('pointermove', { pointerId: 4, clientX: 40, clientY: 10 });
  entryAt(wave).dispatch('pointerup', { pointerId: 4 });
  assert.deepEqual(h.picks, [wave], 'a drag that missed every target inserts nothing');

  h.library.setLegality([{ operator: AFFINE, legal: false, reason: 'fits nowhere' }]);
  entryAt('warp.affine.v2').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 5, clientX: 10, clientY: 10 });
  entryAt('warp.affine.v2').dispatch('pointerup', { pointerId: 5 });
  assert.deepEqual(h.picks, [wave], 'an entry that fits nowhere inserts nothing');
  assert.equal(h.announced.at(-1), 'fits nowhere');
});

test('destroy detaches the pointer listeners and empties the library', () => {
  const h = makeLibrary();
  h.library.destroy();
  assert.equal(h.container.childNodes.length, 0);
  assert.deepEqual(h.container.listeners.filter(
    (listener) => listener.type.startsWith('pointer')), []);
});
