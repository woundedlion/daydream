//
// tools/chain_editor.js renders the chain rail — stage cards grouped into one
// band per carrier with crossings at the band boundaries — and translates every
// gesture (palette insertion, removal-by-replacement, Alt+Arrow and drag
// reorder, bypass, undo) into the document store's span-replacement primitive.
// The fixture is the real hex_wave pattern document over the pinned engine
// catalog and the real store, so legality, reconciliation and refusal texts are
// the shipping ones, not doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChainDocumentStore } from '../tools/chain_document_store.js';
import { createChainEditor, railGapFromPoint } from '../tools/chain_editor.js';
import { compileShaderDocument } from '../shader/shader_workbench.mjs';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

const CATALOG = JSON.parse(readFileSync(
  new URL('../shader/engine_catalog.json', import.meta.url), 'utf8'));
const BASE = compileShaderDocument(readFileSync(
  new URL('../shader/patterns/hex_wave.shader.json', import.meta.url), 'utf8'),
{ catalog: CATALOG });
assert.equal(BASE.status, 'VALID');

// hex_wave chain: camera, lens (sphere endos), project (crossing), warp2
// (plane endo), sample (crossing), transfer (field endo), colorize (exit).
const LENS = 1;
const PROJECT = 2;

restoreDocumentAfterEach();

/** An editor over a fresh store on a fresh fixture copy, plus its spies. */
async function makeEditor() {
  const store = await createChainDocumentStore({
    document: structuredClone(BASE.document), catalog: CATALOG });
  const container = fakeElement('section');
  // createPointerDrag captures on the container; the fake element does not
  // model pointer capture, so the pointer-wiring case stubs it.
  container.setPointerCapture = () => {};
  container.hasPointerCapture = () => true;
  container.releasePointerCapture = () => {};
  const doc = installDocument({
    body: fakeElement('body'),
    activeElement: null,
    createElement: (/** @type {string} */ tag) => fakeElement(tag),
  });
  const applied = [];
  const selections = [];
  const editor = createChainEditor({
    doc,
    container,
    store,
    catalog: CATALOG,
    onApply: () => applied.push(store.programShape().map((entry) => entry.instance)),
    onSelect: (label) => selections.push(label),
  });
  return { store, container, doc, editor, applied, selections };
}

const cards = (h) => h.container.querySelectorAll('.chain-card');
const cardByLabel = (h, label) =>
  cards(h).find((card) => card.dataset.label === label);
const gapByIndex = (h, index) => h.container.querySelectorAll('.chain-gap')
  .find((gap) => Number(gap.dataset.index) === index);
const paletteOf = (h) => h.container.querySelector('.chain-palette');
const paletteEntries = (h) => h.container.querySelectorAll('.chain-palette-entry');
const statusText = (h) =>
  h.container.querySelector('.chain-editor-status').textContent;
const labels = (h) => h.store.chain().map((entry) => entry.label);

test('the rail groups cards into carrier bands with crossings at the boundaries', async () => {
  const h = await makeEditor();
  const rail = h.container.children[1];
  assert.equal(rail.getAttribute('role'), 'listbox');
  assert.equal(rail.getAttribute('aria-orientation'), 'vertical');

  const bands = rail.querySelectorAll('.chain-band');
  assert.deepEqual(bands.map((band) => band.dataset.carrier),
    ['sphere', 'plane', 'field', 'color']);
  for (const band of bands) assert.equal(band.getAttribute('role'), 'group');
  const membership = bands.map((band) =>
    band.querySelectorAll('.chain-card').map((card) => card.dataset.label));
  assert.deepEqual(membership, [['camera', 'lens'], ['warp2'], ['transfer'], []]);

  const crossings = rail.children.filter(
    (child) => child.classList?.contains('chain-card--crossing'));
  assert.deepEqual(crossings.map((card) => card.dataset.label),
    ['project', 'sample', 'colorize']);

  const all = cards(h);
  assert.equal(all.length, 7);
  for (const card of all) assert.equal(card.getAttribute('role'), 'option');
  const camera = cardByLabel(h, 'camera');
  assert.equal(camera.getAttribute('aria-label'), 'Rotate · camera');
  assert.equal(camera.querySelector('.chain-card-name').textContent, 'Rotate');
  assert.equal(camera.querySelector('.chain-card-label').textContent, '· camera');
  assert.equal(cardByLabel(h, 'project').querySelector('.chain-card-pair').textContent,
    'sphere → plane');

  // One roving-tabindex stop, and one gap per chain position plus the ends.
  assert.deepEqual(all.filter((card) => card.getAttribute('tabindex') === '0')
    .map((card) => card.dataset.label), ['camera']);
  assert.equal(h.container.querySelectorAll('.chain-gap').length, 8);
});

test('clicking a card selects it, marks it current, and reports the selection', async () => {
  const h = await makeEditor();
  cardByLabel(h, 'warp2').dispatch('click');

  assert.equal(h.store.selectedLabel(), 'warp2');
  assert.deepEqual(h.selections, ['warp2']);
  const card = cardByLabel(h, 'warp2');
  assert.equal(card.getAttribute('aria-current'), 'true');
  assert.equal(card.getAttribute('aria-selected'), 'true');
  assert.equal(h.doc.activeElement, card, 'the selected card takes focus');
  assert.equal(cardByLabel(h, 'camera').getAttribute('aria-current'), null);

  // Re-selecting reports once per change, not once per click.
  cardByLabel(h, 'warp2').dispatch('click');
  assert.deepEqual(h.selections, ['warp2']);
});

test('arrow keys rove focus without editing; Alt+Arrow moves the card', async () => {
  const h = await makeEditor();
  const down = cardByLabel(h, 'camera').dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(down.defaultPrevented, true);
  assert.equal(h.doc.activeElement.dataset.label, 'lens');
  assert.equal(h.doc.activeElement.getAttribute('tabindex'), '0');
  assert.deepEqual(h.applied, [], 'roving focus is not an edit');

  cardByLabel(h, 'lens').dispatch('keydown', { key: 'ArrowUp', altKey: true });
  assert.deepEqual(labels(h).slice(0, 2), ['lens', 'camera']);
  assert.equal(h.applied.length, 1);
  assert.equal(h.doc.activeElement.dataset.label, 'lens',
    'focus rides the moved card across the rebuild');
});

test('a move the store refuses is surfaced and leaves the chain alone', async () => {
  const h = await makeEditor();
  cardByLabel(h, 'project').dispatch('keydown', { key: 'ArrowDown', altKey: true });

  assert.deepEqual(labels(h),
    ['camera', 'lens', 'project', 'warp2', 'sample', 'transfer', 'colorize']);
  assert.deepEqual(h.applied, []);
  assert.notEqual(statusText(h), '', 'the refusal reason lands in the live region');
});

test('Delete opens the replacement palette; Remove is offered only on endomorphisms', async () => {
  const h = await makeEditor();
  cardByLabel(h, 'lens').dispatch('keydown', { key: 'Delete' });

  const palette = paletteOf(h);
  assert.equal(palette.getAttribute('role'), 'listbox');
  const entries = paletteEntries(h);
  assert.equal(entries.length, 1 + CATALOG.operators.length,
    'Remove plus every catalog operator, visible whether or not legal');
  assert.equal(entries[0].dataset.remove, 'true');
  const rotate = entries.find((entry) => entry.dataset.operator === 'sphere.rotate.v2');
  assert.equal(rotate.getAttribute('aria-disabled'), null);
  const grid = entries.find((entry) => entry.dataset.operator === 'sample.grid.v2');
  assert.equal(grid.getAttribute('aria-disabled'), 'true');
  assert.match(grid.querySelector('.chain-palette-reason').textContent,
    /plane carrier/);
  assert.equal(h.doc.activeElement, entries[0], 'focus moves into the palette');

  // Escape closes without editing and hands focus back to the card.
  entries[0].dispatch('keydown', { key: 'Escape' });
  assert.equal(paletteOf(h), null);
  assert.equal(h.doc.activeElement, cardByLabel(h, 'lens'));
  assert.deepEqual(h.applied, []);

  cardByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });
  assert.equal(paletteEntries(h)[0].dataset.remove, undefined,
    'a crossing is removed by replacement, never by deletion');
});

test('choosing Remove deletes the endomorphism and re-applies the program', async () => {
  const h = await makeEditor();
  cardByLabel(h, 'lens').dispatch('click');
  cardByLabel(h, 'lens').dispatch('keydown', { key: 'Delete' });
  paletteEntries(h)[0].dispatch('click');

  assert.deepEqual(labels(h),
    ['camera', 'project', 'warp2', 'sample', 'transfer', 'colorize']);
  assert.deepEqual(h.applied,
    [['camera', 'project', 'warp2', 'sample', 'transfer', 'colorize']]);
  assert.equal(h.doc.activeElement.dataset.label, 'project',
    'focus lands on the card that filled the removed slot');
  assert.deepEqual(h.selections, ['lens', null],
    'removing the selected card clears the published selection');
});

test('a replacement palette choice swaps the crossing in place', async () => {
  const h = await makeEditor();
  cardByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });
  paletteEntries(h)
    .find((entry) => entry.dataset.operator === 'project.bonne.v2')
    .dispatch('click');

  assert.equal(h.store.chain()[PROJECT].operator, 'project.bonne.v2');
  assert.equal(h.applied.length, 1);
  assert.equal(h.doc.activeElement.dataset.label, h.store.chain()[PROJECT].label);
});

test('Insert on a card and a gap click both open the insertion palette', async () => {
  const h = await makeEditor();
  cardByLabel(h, 'camera').dispatch('keydown', { key: 'Insert' });
  let entries = paletteEntries(h);
  assert.equal(entries.length, CATALOG.operators.length);
  const mobius = entries.find(
    (entry) => entry.dataset.operator === 'sphere.lens.mobius.v2');
  assert.equal(mobius.getAttribute('aria-disabled'), null);
  mobius.dispatch('click');

  assert.equal(labels(h).length, 8);
  assert.equal(h.store.chain()[LENS].operator, 'sphere.lens.mobius.v2');
  assert.equal(h.applied.length, 1);
  assert.equal(h.doc.activeElement.dataset.label, h.store.chain()[LENS].label);

  gapByIndex(h, 0).dispatch('click');
  entries = paletteEntries(h);
  assert.equal(entries.length, CATALOG.operators.length);
  const illegal = entries.find(
    (entry) => entry.dataset.operator === 'warp.affine.v2');
  assert.equal(illegal.getAttribute('aria-disabled'), 'true');
  illegal.dispatch('click');
  assert.equal(labels(h).length, 8, 'an aria-disabled entry commits nothing');
  assert.notEqual(statusText(h), '');
});

test('undo and redo revert and reapply whole edits through the same apply path', async () => {
  const h = await makeEditor();
  gapByIndex(h, 3).dispatch('click');
  paletteEntries(h)
    .find((entry) => entry.dataset.operator === 'warp.wave-shear.v2')
    .dispatch('click');
  assert.equal(labels(h).length, 8);
  assert.equal(h.applied.length, 1);

  h.container.querySelector('.chain-undo').dispatch('click');
  assert.equal(labels(h).length, 7);
  assert.equal(h.applied.length, 2);

  const redo = h.container.querySelector('.chain-redo');
  assert.equal(redo.disabled, false);
  redo.dispatch('click');
  assert.equal(labels(h).length, 8);
  assert.equal(h.applied.length, 3);

  // Ctrl+Z reaches the container's shortcut from any card.
  cardByLabel(h, 'camera').dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(labels(h).length, 7);
  assert.equal(h.applied.length, 4);
});

test('bypass toggles the program shape without touching the document', async () => {
  const h = await makeEditor();
  const digest = h.store.compile().descriptor_digest;
  assert.equal(cardByLabel(h, 'project').querySelector('.chain-card-bypass'), null,
    'a crossing gets no bypass toggle');

  cardByLabel(h, 'lens').querySelector('.chain-card-bypass').dispatch('click');
  assert.deepEqual(h.applied.at(-1),
    ['camera', 'project', 'warp2', 'sample', 'transfer', 'colorize']);
  const card = cardByLabel(h, 'lens');
  assert.equal(card.classList.contains('chain-card--bypassed'), true);
  const toggle = card.querySelector('.chain-card-bypass');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(h.doc.activeElement, toggle,
    'focus stays on the toggle so A/B flipping needs no re-navigation');
  assert.equal(h.store.compile().descriptor_digest, digest);

  toggle.dispatch('click');
  assert.equal(h.applied.at(-1).includes('lens'), true);
  assert.equal(cardByLabel(h, 'lens').classList.contains('chain-card--bypassed'),
    false);
});

test('the drag lifecycle reorders a card within its band', async () => {
  const h = await makeEditor();
  assert.equal(h.editor.drag.start({ kind: 'card', index: LENS }), true);
  const legal = h.container.querySelectorAll('.chain-gap')
    .filter((gap) => gap.dataset.drop === 'legal')
    .map((gap) => Number(gap.dataset.index));
  assert.deepEqual(legal, [0],
    'a sphere endomorphism may only drop into its own band');
  assert.equal(cardByLabel(h, 'lens').dataset.dragging, 'true');

  h.editor.drag.hover(5);
  assert.equal(h.container.querySelectorAll('.chain-gap')
    .some((gap) => gap.dataset.drop === 'active'), false,
  'an illegal gap never highlights');
  h.editor.drag.hover(0);
  assert.equal(gapByIndex(h, 0).dataset.drop, 'active');

  assert.equal(h.editor.drag.drop(), true);
  assert.deepEqual(labels(h).slice(0, 2), ['lens', 'camera']);
  assert.equal(h.applied.length, 1);
});

test('a crossing card and a hoverless drop both drag to nothing', async () => {
  const h = await makeEditor();
  assert.equal(h.editor.drag.start({ kind: 'card', index: PROJECT }), true);
  assert.equal(h.container.querySelectorAll('.chain-gap')
    .some((gap) => gap.dataset.drop === 'legal'), false);
  assert.equal(h.editor.drag.drop(), false);
  assert.deepEqual(h.applied, []);
  assert.equal(h.container.querySelectorAll('.chain-gap')
    .some((gap) => gap.dataset.drop === 'legal'), false,
  'an unwound drag clears its highlights');
});

test('the drag lifecycle inserts a catalog operator at a legal gap', async () => {
  const h = await makeEditor();
  assert.equal(h.editor.drag.start(
    { kind: 'operator', operatorId: 'warp.wave-shear.v2' }), true);
  const legal = h.container.querySelectorAll('.chain-gap')
    .filter((gap) => gap.dataset.drop === 'legal')
    .map((gap) => Number(gap.dataset.index));
  assert.deepEqual(legal, [3, 4], 'the plane band gaps take a plane endo');

  h.editor.drag.hover(3);
  h.editor.drag.drop();
  assert.equal(h.store.chain()[3].operator, 'warp.wave-shear.v2');
  assert.equal(h.applied.length, 1);

  assert.equal(h.editor.drag.start({ kind: 'operator', operatorId: 'nope.v9' }),
    false);
});

test('insertOperator lands after the selection, else at the first legal gap', async () => {
  const h = await makeEditor();
  assert.equal(h.editor.insertOperator('warp.curl-flow.v2'), true);
  assert.equal(h.store.chain()[3].operator, 'warp.curl-flow.v2',
    'no selection: the first gap the store accepts');

  cardByLabel(h, 'camera').dispatch('click');
  assert.equal(h.editor.insertOperator('sphere.lens.glitch.v2'), true);
  assert.equal(h.store.chain()[1].operator, 'sphere.lens.glitch.v2',
    'with a selection: the gap after the selected card');

  assert.equal(h.editor.insertOperator('sample.grid.v2'), false,
    'illegal at the selection gap is a refusal, not a silent relocation');
  assert.notEqual(statusText(h), '');
});

test('pointerdown on a card begins the drag; buttons and gaps decline it', async () => {
  const h = await makeEditor();
  cardByLabel(h, 'lens').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 7 });
  assert.equal(cardByLabel(h, 'lens').dataset.dragging, 'true');
  cardByLabel(h, 'lens').dispatch('pointerup', { pointerId: 7 });
  assert.equal(cardByLabel(h, 'lens').dataset.dragging, undefined,
    'a hoverless release unwinds the drag');
  assert.deepEqual(h.applied, []);

  cardByLabel(h, 'camera').querySelector('.chain-card-bypass')
    .dispatch('pointerdown', { isPrimary: true, button: 0, pointerId: 8 });
  assert.equal(cards(h).some(
    (card) => card.dataset.dragging === 'true'), false);
});

test('destroy detaches the pointer listeners and empties the rail', async () => {
  const h = await makeEditor();
  h.editor.destroy();
  assert.equal(h.container.childNodes.length, 0);
  assert.deepEqual(h.container.listeners.filter(
    (listener) => listener.type.startsWith('pointer')), []);
});

test('railGapFromPoint resolves gaps through elementFromPoint', () => {
  assert.equal(railGapFromPoint({}, 1, 2), null);
  const gap = fakeElement('button');
  gap.className = 'chain-gap';
  gap.dataset.index = '3';
  const inner = fakeElement('span');
  gap.appendChild(inner);
  assert.equal(railGapFromPoint({ elementFromPoint: () => inner }, 1, 2), 3);
  assert.equal(railGapFromPoint({ elementFromPoint: () => null }, 1, 2), null);
});
