//
// tools/chain_strip.js renders the pipeline strip — the chain left to right as
// chips grouped into one band per carrier, with the crossings as socket chips on
// the band boundaries — and translates every gesture (band + palettes, ✕
// removal, socket swap, Alt+Arrow and drag reorder, coarse band drops, bypass,
// undo) into the document store's span-replacement primitive. The fixture is the
// real hex_wave pattern document over the pinned engine catalog and the real
// store, so legality, reconciliation and refusal texts are the shipping ones,
// not doubles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChainDocumentStore } from '../tools/chain_document_store.js';
import { createChainStrip, deactivatedParameterIds } from '../tools/chain_strip.js';
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
const WARP2 = 3;

// The shipped catalog's crossings are the three the pipeline's own bands make,
// and a valid chain runs sphere to color, so it always carries a socket for
// every pair. A hypothetical fourth pair is what exercises a crossing the chain
// has no socket to swap.
const NO_SOCKET = {
  id: 'colorize.plane.v2',
  name: 'Plane Palette',
  input: 'plane',
  output: 'color',
  blocks: {
    param: { size: 4, align: 4 },
    prepared: { size: 4, align: 4 },
    state: { size: 4, align: 4 },
  },
  params: [],
};
const EXTENDED_CATALOG = { ...CATALOG, operators: [...CATALOG.operators, NO_SOCKET] };

restoreDocumentAfterEach();

/**
 * A strip over a fresh store on a fresh fixture copy, plus its spies.
 * @param {{presetId?: string|null, catalog?: *}} [seams] - The preset the
 *   inline controls read, omitted the strip falls back to the document's first;
 *   and the operator catalog, for a vocabulary the shipped one cannot express.
 * @returns {Promise<Object>} The harness.
 */
async function makeStrip({ presetId = null, catalog = CATALOG } = {}) {
  const store = await createChainDocumentStore({
    document: structuredClone(BASE.document), catalog });
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
    elementFromPoint: () => null,
  });
  const applied = [];
  const selections = [];
  const announced = [];
  const edits = [];
  const strip = createChainStrip({
    doc,
    container,
    store,
    catalog,
    announce: (message) => announced.push(message),
    onApply: () => applied.push(store.programShape().map((entry) => entry.instance)),
    onSelect: (label) => selections.push(label),
    presetId: () => presetId,
    onEditParameter: (parameterId, value) => edits.push([parameterId, value]),
  });
  return { store, container, doc, strip, applied, selections, announced, edits };
}

const chips = (h) => h.container.querySelectorAll('.chain-chip');
const chipByLabel = (h, label) =>
  chips(h).find((chip) => chip.dataset.label === label);
const bandFor = (h, carrier) => h.container.querySelectorAll('.chain-band')
  .find((band) => band.dataset.carrier === carrier);
const gapByIndex = (h, index) => h.container.querySelectorAll('.chain-gap')
  .find((gap) => Number(gap.dataset.index) === index);
const paletteOf = (h) => h.container.querySelector('.chain-palette');
const paletteEntries = (h) => h.container.querySelectorAll('.chain-palette-entry');
const lastAnnounced = (h) => h.announced.at(-1) ?? '';
const labels = (h) => h.store.chain().map((entry) => entry.label);

test('the strip lays the chain out as carrier bands with sockets between them', async () => {
  const h = await makeStrip();
  const strip = h.container.children[1];
  assert.equal(strip.getAttribute('role'), 'listbox');
  assert.equal(strip.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(strip.getAttribute('aria-label'), 'Shader chain');

  const bands = strip.querySelectorAll('.chain-band');
  assert.deepEqual(bands.map((band) => band.dataset.carrier),
    ['sphere', 'plane', 'field', 'color'],
    'all four bands render whether or not they hold a stage');
  assert.deepEqual(bands.map((band) => band.getAttribute('aria-label')),
    ['Sphere stages', 'Plane stages', 'Field stages', 'Color stages']);
  for (const band of bands) {
    assert.equal(band.getAttribute('role'), 'group');
    assert.equal(band.querySelector('.chain-band-title').getAttribute('aria-hidden'),
      'true');
  }
  assert.deepEqual(
    bands.map((band) => band.querySelectorAll('.chain-chip').map((c) => c.dataset.label)),
    [['camera', 'lens'], ['warp2'], ['transfer'], []]);

  const sockets = strip.children.filter(
    (child) => child.classList?.contains('chain-chip--socket'));
  assert.deepEqual(sockets.map((socket) => socket.dataset.label),
    ['project', 'sample', 'colorize'],
    'a crossing sits between the two bands it joins');

  const all = chips(h);
  assert.equal(all.length, 7);
  for (const chip of all) assert.equal(chip.getAttribute('role'), 'option');
  const camera = chipByLabel(h, 'camera');
  assert.equal(camera.getAttribute('aria-label'), 'Rotate · camera');
  assert.equal(camera.querySelector('.chain-chip-name').textContent, 'Rotate');
  assert.equal(camera.querySelector('.chain-chip-label').textContent, '· camera');
  assert.equal(chipByLabel(h, 'project').querySelector('.chain-chip-pair').textContent,
    'sphere → plane');
  assert.match(chipByLabel(h, 'project').getAttribute('aria-label'),
    /, sphere to plane$/);

  // One roving-tabindex stop, one gap per chain position plus the ends, and one
  // persistent + per band.
  assert.deepEqual(all.filter((chip) => chip.getAttribute('tabindex') === '0')
    .map((chip) => chip.dataset.label), ['camera']);
  assert.equal(h.container.querySelectorAll('.chain-gap').length, 8);
  assert.deepEqual(bands.map((band) => band.querySelector('.chain-band-add')
    .getAttribute('aria-label')),
  ['Add a Sphere stage', 'Add a Plane stage', 'Add a Field stage', 'Add a Color stage']);
});

test('only endomorphisms carry ✕ and bypass; only sockets carry swap', async () => {
  const h = await makeStrip();
  for (const label of ['camera', 'lens', 'warp2', 'transfer']) {
    const chip = chipByLabel(h, label);
    assert.ok(chip.querySelector('.chain-chip-remove'), `${label} carries ✕`);
    assert.ok(chip.querySelector('.chain-chip-bypass'), `${label} carries bypass`);
    assert.equal(chip.querySelector('.chain-chip-swap'), null);
  }
  for (const label of ['project', 'sample', 'colorize']) {
    const chip = chipByLabel(h, label);
    assert.equal(chip.querySelector('.chain-chip-remove'), null,
      'removal across a crossing is illegal by construction, so no ✕');
    assert.equal(chip.querySelector('.chain-chip-bypass'), null);
    assert.equal(chip.querySelector('.chain-chip-swap').getAttribute('aria-haspopup'),
      'listbox');
  }
  const remove = chipByLabel(h, 'lens').querySelector('.chain-chip-remove');
  assert.equal(remove.textContent, '✕');
  assert.match(remove.getAttribute('aria-label'), /^Remove .+ · lens$/);
});

test('clicking a chip selects it, marks it current, and reports the selection', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'warp2').dispatch('click');

  assert.equal(h.store.selectedLabel(), 'warp2');
  assert.deepEqual(h.selections, ['warp2']);
  const chip = chipByLabel(h, 'warp2');
  assert.equal(chip.getAttribute('aria-current'), 'true');
  assert.equal(chip.getAttribute('aria-selected'), 'true');
  assert.equal(h.doc.activeElement, chip, 'the selected chip takes focus');
  assert.equal(chipByLabel(h, 'camera').getAttribute('aria-current'), null);

  // Re-selecting reports once per change, not once per click.
  chipByLabel(h, 'warp2').dispatch('click');
  assert.deepEqual(h.selections, ['warp2']);

  chipByLabel(h, 'camera').dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(h.selections, ['warp2', 'camera']);
});

test('Left/Right rove focus without editing; Alt+Arrow moves the chip', async () => {
  const h = await makeStrip();
  const right = chipByLabel(h, 'camera').dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(right.defaultPrevented, true);
  assert.equal(h.doc.activeElement.dataset.label, 'lens');
  assert.equal(h.doc.activeElement.getAttribute('tabindex'), '0');
  assert.deepEqual(h.applied, [], 'roving focus is not an edit');

  chipByLabel(h, 'lens').dispatch('keydown', { key: 'ArrowLeft', altKey: true });
  assert.deepEqual(labels(h).slice(0, 2), ['lens', 'camera']);
  assert.equal(h.applied.length, 1);
  assert.equal(h.doc.activeElement.dataset.label, 'lens',
    'focus rides the moved chip across the rebuild');

  chipByLabel(h, 'lens').dispatch('keydown', { key: 'ArrowRight', altKey: true });
  assert.deepEqual(labels(h).slice(0, 2), ['camera', 'lens']);
});

test('a move the store refuses is announced and leaves the chain alone', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'project').dispatch('keydown', { key: 'ArrowRight', altKey: true });

  assert.deepEqual(labels(h),
    ['camera', 'lens', 'project', 'warp2', 'sample', 'transfer', 'colorize']);
  assert.deepEqual(h.applied, []);
  assert.notEqual(lastAnnounced(h), '',
    'the refusal reason reaches the shared live region');
});

test('✕ and Delete remove an endomorphism and re-apply the program', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'lens').dispatch('click');
  chipByLabel(h, 'lens').querySelector('.chain-chip-remove').dispatch('click');

  assert.deepEqual(labels(h),
    ['camera', 'project', 'warp2', 'sample', 'transfer', 'colorize']);
  assert.deepEqual(h.applied,
    [['camera', 'project', 'warp2', 'sample', 'transfer', 'colorize']]);
  assert.equal(h.doc.activeElement.dataset.label, 'project',
    'focus lands on the chip that filled the removed slot');
  assert.deepEqual(h.selections, ['lens', null],
    'removing the selected chip clears the published selection');

  chipByLabel(h, 'warp2').dispatch('keydown', { key: 'Delete' });
  assert.deepEqual(labels(h),
    ['camera', 'project', 'sample', 'transfer', 'colorize']);
  assert.equal(paletteOf(h), null, 'Delete on an endomorphism needs no palette');
});

test('Delete and swap both open a socket replacement palette', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });

  const palette = paletteOf(h);
  assert.equal(palette.getAttribute('role'), 'listbox');
  const entries = paletteEntries(h);
  assert.equal(entries.length, CATALOG.operators.length,
    'every catalog operator, and no Remove: a crossing is removed by replacement');
  assert.equal(entries[0].dataset.remove, undefined);
  const bonne = entries.find((entry) => entry.dataset.operator === 'project.bonne.v2');
  assert.equal(bonne.getAttribute('aria-disabled'), null,
    'a same-pair operator is enabled');
  const grid = entries.find((entry) => entry.dataset.operator === 'sample.grid.v2');
  assert.equal(grid.getAttribute('aria-disabled'), 'true');
  assert.match(grid.querySelector('.chain-palette-reason').textContent, /plane carrier/);
  assert.equal(h.doc.activeElement.dataset.operator, 'project.stereographic.v2',
    'focus moves to the palette\'s first enabled entry');

  h.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(paletteOf(h), null);
  assert.equal(h.doc.activeElement, chipByLabel(h, 'project'));
  assert.deepEqual(h.applied, []);

  chipByLabel(h, 'project').querySelector('.chain-chip-swap').dispatch('click');
  paletteEntries(h)
    .find((entry) => entry.dataset.operator === 'project.bonne.v2')
    .dispatch('click');
  assert.equal(h.store.chain()[PROJECT].operator, 'project.bonne.v2');
  assert.equal(h.applied.length, 1);
  assert.equal(h.doc.activeElement.dataset.label, h.store.chain()[PROJECT].label);
});

test('a band + and Insert both open the insertion palette at their gap', async () => {
  const h = await makeStrip();
  bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
  let entries = paletteEntries(h);
  assert.equal(entries.length, CATALOG.operators.length);
  entries.find((entry) => entry.dataset.operator === 'sphere.lens.mobius.v2')
    .dispatch('click');
  assert.deepEqual(labels(h).slice(0, 3), ['camera', 'lens', 'sphere1'],
    'with no selection the band + lands at the band\'s last gap');
  assert.equal(h.applied.length, 1);

  chipByLabel(h, 'camera').dispatch('click');
  bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h).find((entry) => entry.dataset.operator === 'sphere.lens.glitch.v2')
    .dispatch('click');
  assert.equal(h.store.chain()[1].operator, 'sphere.lens.glitch.v2',
    'with a selection in the band, the gap after the selected chip');

  chipByLabel(h, 'camera').dispatch('keydown', { key: 'Insert' });
  entries = paletteEntries(h);
  const illegal = entries.find((entry) => entry.dataset.operator === 'warp.affine.v2');
  assert.equal(illegal.getAttribute('aria-disabled'), 'true');
  illegal.dispatch('click');
  assert.equal(labels(h).length, 9, 'an aria-disabled entry commits nothing');
  assert.notEqual(lastAnnounced(h), '');
});

// The palette's offset parent is whatever positioned ancestor sits above it —
// the band for a band +, the whole strip region for a socket's swap — so its
// stylesheet placement lands wherever that ancestor starts. These cases give the
// fake the one measurement the anchoring reads.
/**
 * @param {Object} h - A strip harness.
 * @param {number} width - Width every created element reports.
 * @param {number} parentLeft - Left edge of the palette's offset parent.
 * @returns {void}
 */
const measureNewElements = (h, width, parentLeft) => {
  const offsetParent = fakeElement('div');
  offsetParent.getBoundingClientRect = () => ({ left: parentLeft, width: 1264 });
  h.doc.documentElement = { clientWidth: 1280 };
  h.doc.createElement = (/** @type {string} */ tag) => {
    const node = fakeElement(tag);
    node.getBoundingClientRect = () => ({ left: 0, width });
    node.offsetParent = offsetParent;
    return node;
  };
};

test('a palette opens anchored to the control that opened it', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208, 8);
  const swap = chipByLabel(h, 'project').querySelector('.chain-chip-swap');
  swap.getBoundingClientRect = () => ({ left: 900, width: 40 });
  swap.dispatch('click');
  assert.equal(paletteOf(h).style.left, '892px',
    'the offset is measured against the offset parent, not the parent the anchor sits in');

  h.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  add.getBoundingClientRect = () => ({ left: 298, width: 20 });
  add.dispatch('click');
  assert.equal(paletteOf(h).style.left, '290px');
});

test('a palette near the right edge is clamped back inside the viewport', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208, 8);
  const swap = chipByLabel(h, 'colorize').querySelector('.chain-chip-swap');
  swap.getBoundingClientRect = () => ({ left: 1250, width: 40 });
  swap.dispatch('click');
  assert.equal(paletteOf(h).style.left, '1056px',
    'clamped to the viewport width less the palette and its margin');
});

test('a palette keeps its stylesheet placement where nothing measures', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'project').querySelector('.chain-chip-swap').dispatch('click');
  assert.equal(paletteOf(h).style.left, '',
    'a DOM without layout writes no offset rather than throwing');
});

test('undo and redo revert and reapply whole edits through the same apply path', async () => {
  const h = await makeStrip();
  bandFor(h, 'plane').querySelector('.chain-band-add').dispatch('click');
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

  // Ctrl+Z reaches the container's shortcut from any chip.
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(labels(h).length, 7);
  assert.equal(h.applied.length, 4);
});

test('bypass toggles the program shape without touching the document', async () => {
  const h = await makeStrip();
  const digest = h.store.compile().descriptor_digest;

  chipByLabel(h, 'lens').querySelector('.chain-chip-bypass').dispatch('click');
  assert.deepEqual(h.applied.at(-1),
    ['camera', 'project', 'warp2', 'sample', 'transfer', 'colorize']);
  const chip = chipByLabel(h, 'lens');
  assert.equal(chip.classList.contains('chain-chip--bypassed'), true);
  assert.match(chip.getAttribute('aria-label'), /, bypassed$/);
  const toggle = chip.querySelector('.chain-chip-bypass');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(h.doc.activeElement, toggle,
    'focus stays on the toggle so A/B flipping needs no re-navigation');
  assert.equal(h.store.compile().descriptor_digest, digest);

  toggle.dispatch('click');
  assert.equal(h.applied.at(-1).includes('lens'), true);
  assert.equal(chipByLabel(h, 'lens').classList.contains('chain-chip--bypassed'), false);
});

test('the drag lifecycle reorders a chip within its band', async () => {
  const h = await makeStrip();
  assert.equal(h.strip.drag.start({ kind: 'chip', index: LENS }), true);
  const legal = h.container.querySelectorAll('.chain-gap')
    .filter((gap) => gap.dataset.drop === 'legal')
    .map((gap) => Number(gap.dataset.index));
  assert.deepEqual(legal, [0],
    'a sphere endomorphism may only drop into its own band');
  assert.equal(chipByLabel(h, 'lens').dataset.dragging, 'true');

  h.strip.drag.hover({ kind: 'gap', index: 5 });
  assert.equal(h.container.querySelectorAll('.chain-gap')
    .some((gap) => gap.dataset.drop === 'active'), false,
  'an illegal gap never highlights');
  h.strip.drag.hover({ kind: 'gap', index: 0 });
  assert.equal(gapByIndex(h, 0).dataset.drop, 'active');

  assert.equal(h.strip.drag.drop(), true);
  assert.deepEqual(labels(h).slice(0, 2), ['lens', 'camera']);
  assert.equal(h.applied.length, 1);
});

test('a chip with nowhere to go declines the drag, so its press stays a click',
  async () => {
    const h = await makeStrip();
    assert.equal(h.strip.drag.start({ kind: 'chip', index: PROJECT }), false,
      'a crossing never reorders');
    assert.equal(h.strip.drag.start({ kind: 'chip', index: WARP2 }), false,
      'the only chip in its band has no gap to move to');
    assert.equal(chips(h).some((chip) => chip.dataset.dragging === 'true'), false);
  });

test('a hoverless drop unwinds without committing', async () => {
  const h = await makeStrip();
  assert.equal(h.strip.drag.start({ kind: 'chip', index: LENS }), true);
  assert.equal(h.strip.drag.drop(), false);
  assert.deepEqual(h.applied, []);
  assert.equal(h.container.querySelectorAll('.chain-gap')
    .some((gap) => gap.dataset.drop === 'legal'), false,
  'an unwound drag clears its highlights');
});

test('a chip press that never moves selects instead of dragging', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'lens').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 3, clientX: 40, clientY: 10 });
  h.container.dispatch('pointerup', { pointerId: 3, clientX: 41, clientY: 10 });
  assert.equal(h.store.selectedLabel(), 'lens');
  assert.deepEqual(h.selections, ['lens']);
  assert.deepEqual(h.applied, [], 'a selection is no structural edit');

  chipByLabel(h, 'camera').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 4, clientX: 10, clientY: 10 });
  h.container.dispatch('pointermove', { pointerId: 4, clientX: 90, clientY: 10 });
  h.container.dispatch('pointerup', { pointerId: 4, clientX: 90, clientY: 10 });
  assert.equal(h.store.selectedLabel(), 'lens',
    'a press that travelled is a drag, and moves the selection nowhere');
  assert.deepEqual(h.selections, ['lens'], 'the selection is announced once');
});

test('the drag lifecycle inserts a catalog operator at a legal gap', async () => {
  const h = await makeStrip();
  assert.equal(h.strip.drag.start(
    { kind: 'operator', operatorId: 'warp.wave-shear.v2' }), true);
  const legal = h.container.querySelectorAll('.chain-gap')
    .filter((gap) => gap.dataset.drop === 'legal')
    .map((gap) => Number(gap.dataset.index));
  assert.deepEqual(legal, [3, 4], 'the plane band gaps take a plane endo');

  h.strip.drag.hover({ kind: 'gap', index: 3 });
  h.strip.drag.drop();
  assert.equal(h.store.chain()[3].operator, 'warp.wave-shear.v2');
  assert.equal(h.applied.length, 1);

  assert.equal(h.strip.drag.start({ kind: 'operator', operatorId: 'nope.v9' }), false);
});

test('a coarse band drop snaps to the geometrically nearest legal gap', async () => {
  const h = await makeStrip();
  h.strip.drag.start({ kind: 'operator', operatorId: 'warp.wave-shear.v2' });
  gapByIndex(h, 3).getBoundingClientRect = () => ({ left: 100, width: 10 });
  gapByIndex(h, 4).getBoundingClientRect = () => ({ left: 300, width: 10 });

  h.strip.drag.hover({ kind: 'band', carrier: 'plane', x: 280 });
  assert.equal(gapByIndex(h, 4).dataset.drop, 'active');
  assert.equal(gapByIndex(h, 3).dataset.drop, 'legal');

  h.strip.drag.hover({ kind: 'band', carrier: 'plane', x: 120 });
  assert.equal(gapByIndex(h, 3).dataset.drop, 'active');
  assert.equal(h.strip.drag.drop(), true);
  assert.equal(h.store.chain()[3].operator, 'warp.wave-shear.v2');
});

test('an unmeasurable band drop falls back to the band context gap', async () => {
  const h = await makeStrip();
  h.strip.drag.start({ kind: 'operator', operatorId: 'warp.wave-shear.v2' });
  h.strip.drag.hover({ kind: 'band', carrier: 'plane' });

  assert.equal(gapByIndex(h, 4).dataset.drop, 'active',
    'with no selection the context gap is the band\'s last');
  assert.equal(h.strip.drag.drop(), true);
  assert.equal(h.store.chain()[4].operator, 'warp.wave-shear.v2');
});

test('a band with no legal gap refuses the drag and announces why', async () => {
  const h = await makeStrip();
  h.strip.drag.start({ kind: 'operator', operatorId: 'sphere.rotate.v2' });
  h.strip.drag.hover({ kind: 'band', carrier: 'plane', x: 10 });

  assert.equal(bandFor(h, 'plane').dataset.drop, 'refused');
  assert.equal(bandFor(h, 'sphere').dataset.drop, 'legal',
    'the band that does accept it stays marked as a target');
  assert.match(lastAnnounced(h), /carrier/);
  assert.equal(h.strip.drag.drop(), false);
  assert.deepEqual(h.applied, []);
  assert.equal(bandFor(h, 'plane').dataset.drop, undefined,
    'an unwound drag clears the refusing mark');
});

test('a running drag marks its bands and widens the strip gaps', async () => {
  const h = await makeStrip();
  const stripOf = (harness) => harness.container.querySelector('.chain-strip');
  h.strip.drag.start({ kind: 'operator', operatorId: 'warp.wave-shear.v2' });
  assert.equal(stripOf(h).dataset.dragging, 'true',
    'the strip carries the drag so the stylesheet can give the gaps a hit area');
  assert.deepEqual(h.container.querySelectorAll('.chain-band')
    .map((band) => band.dataset.drop), [undefined, 'legal', undefined, undefined],
  'a band holding a legal gap is a coarse drop target from the start');

  h.strip.drag.hover({ kind: 'gap', index: 3 });
  assert.equal(bandFor(h, 'plane').dataset.drop, 'active',
    'the band the drop would commit in reads live, not merely legal');

  h.strip.drag.cancel();
  assert.equal(stripOf(h).dataset.dragging, undefined);
  assert.deepEqual(h.container.querySelectorAll('.chain-band')
    .map((band) => band.dataset.drop), [undefined, undefined, undefined, undefined]);
});

test('only a chip with somewhere to go advertises the reorder', async () => {
  const h = await makeStrip();
  assert.deepEqual(chips(h).filter((chip) => chip.dataset.movable === 'true')
    .map((chip) => chip.dataset.label), ['camera', 'lens'],
  'the sole chip in a band, and every crossing, can go nowhere');
  assert.equal(chipByLabel(h, 'camera').getAttribute('title'),
    'Drag, or Alt+Arrow, to reorder');
  assert.equal(chipByLabel(h, 'warp2').getAttribute('title'), null);
});

test('hoverFromPoint resolves gaps, then bands, then nothing', async () => {
  const h = await makeStrip();
  h.strip.drag.start({ kind: 'operator', operatorId: 'warp.wave-shear.v2' });

  h.doc.elementFromPoint = () => gapByIndex(h, 3);
  h.strip.drag.hoverFromPoint(1, 2);
  assert.equal(gapByIndex(h, 3).dataset.drop, 'active');

  h.doc.elementFromPoint = () => bandFor(h, 'plane').querySelector('.chain-band-title');
  h.strip.drag.hoverFromPoint(1, 2);
  assert.equal(gapByIndex(h, 4).dataset.drop, 'active',
    'a point off every gap resolves through the band it landed in');

  h.doc.elementFromPoint = () => null;
  h.strip.drag.hoverFromPoint(1, 2);
  assert.equal(h.container.querySelectorAll('.chain-gap')
    .some((gap) => gap.dataset.drop === 'active'), false);
});

test('insertOperator lands after the selection, else at the first legal gap', async () => {
  const h = await makeStrip();
  assert.equal(h.strip.insertOperator('warp.curl-flow.v2'), true);
  assert.equal(h.store.chain()[3].operator, 'warp.curl-flow.v2',
    'no selection: the first gap the store accepts');

  chipByLabel(h, 'camera').dispatch('click');
  assert.equal(h.strip.insertOperator('sphere.lens.glitch.v2'), true);
  assert.equal(h.store.chain()[1].operator, 'sphere.lens.glitch.v2',
    'with a selection: the gap after the selected chip');

  // The selection is a sphere chip, so a plane stage takes the first plane gap
  // rather than refusing.
  assert.equal(h.strip.insertOperator('warp.wave-shear.v2'), true);
  assert.equal(h.store.chain()[4].operator, 'warp.wave-shear.v2');
});

// §4.2: a crossing fits no gap — the carrier is the same either side of one
// — so its route into the chain is the socket over its own pair, which is the
// replacement that socket's swap control commits.
test('a crossing lands on the socket its carrier pair names', async () => {
  const h = await makeStrip();
  const entryFor = (/** @type {string} */ id) =>
    h.strip.insertionLegality().find((entry) => entry.operator.id === id);

  const gnomonic = entryFor('project.gnomonic.v2');
  assert.equal(gnomonic.legal, true);
  assert.equal(gnomonic.reason, 'swaps the sphere → plane socket',
    'the entry names the route rather than refusing the gesture');
  assert.equal(entryFor('sample.rings.v2').reason, 'swaps the plane → field socket');

  assert.equal(h.strip.insertOperator('project.gnomonic.v2'), true);
  assert.equal(h.store.chain().length, 7,
    'the crossing replaced the socket; it filled no gap');
  assert.equal(h.store.chain()[PROJECT].operator, 'project.gnomonic.v2');
  assert.deepEqual(labels(h).filter((label) => label !== h.store.chain()[PROJECT].label),
    ['camera', 'lens', 'warp2', 'sample', 'transfer', 'colorize'],
    'every other instance keeps its label, and so its values');
  assert.equal(h.applied.length, 1, 'the swap re-applies the program');
  assert.equal(chipByLabel(h, h.store.chain()[PROJECT].label)
    .querySelector('.chain-chip-name').textContent, 'Gnomonic');
});

test('a crossing no socket in the chain matches is refused', async () => {
  const h = await makeStrip({ catalog: EXTENDED_CATALOG });
  const entry = h.strip.insertionLegality()
    .find((candidate) => candidate.operator.id === NO_SOCKET.id);
  assert.equal(entry.legal, false);
  assert.equal(entry.reason, 'the chain carries no plane → color socket to swap');

  assert.equal(h.strip.insertOperator(NO_SOCKET.id), false);
  assert.equal(lastAnnounced(h), 'the chain carries no plane → color socket to swap');
  assert.deepEqual(labels(h),
    ['camera', 'lens', 'project', 'warp2', 'sample', 'transfer', 'colorize']);
  assert.deepEqual(h.applied, [], 'a refusal commits nothing');
});

// §4.3: the library's entries are the whole catalog against the whole chain, so
// an operator the selection's own gap refuses is still one click from the band
// that takes it.
test('insertionLegality reads the whole chain, not the selection gap', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').dispatch('click');
  const entryFor = (/** @type {string} */ id) =>
    h.strip.insertionLegality().find((entry) => entry.operator.id === id);

  assert.equal(h.strip.insertionLegality().length, CATALOG.operators.length,
    'every catalog operator is reported, in catalog order');
  assert.equal(entryFor('sphere.lens.mobius.v2').legal, true);
  assert.equal(entryFor('warp.wave-shear.v2').legal, true,
    'the sphere selection does not disable a plane stage');
  assert.equal(entryFor('warp.wave-shear.v2').reason, undefined);

  const crossing = entryFor('project.stereographic.v2');
  assert.equal(crossing.legal, true);
  assert.equal(crossing.reason, 'swaps the sphere → plane socket',
    'the reason describes the chain, not the gap the selection names');
});

test('pointerdown on a chip begins the drag; its buttons decline it', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'lens').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 7 });
  assert.equal(chipByLabel(h, 'lens').dataset.dragging, 'true');
  chipByLabel(h, 'lens').dispatch('pointerup', { pointerId: 7 });
  assert.equal(chipByLabel(h, 'lens').dataset.dragging, undefined,
    'a hoverless release unwinds the drag');
  assert.deepEqual(h.applied, []);

  for (const selector of ['.chain-chip-bypass', '.chain-chip-remove']) {
    chipByLabel(h, 'camera').querySelector(selector)
      .dispatch('pointerdown', { isPrimary: true, button: 0, pointerId: 8 });
    assert.equal(chips(h).some((chip) => chip.dataset.dragging === 'true'), false,
      `${selector} starts no drag`);
  }
  chipByLabel(h, 'project').querySelector('.chain-chip-swap')
    .dispatch('pointerdown', { isPrimary: true, button: 0, pointerId: 9 });
  assert.equal(chips(h).some((chip) => chip.dataset.dragging === 'true'), false);
});

test('destroy detaches the pointer listeners and empties the strip', async () => {
  const h = await makeStrip();
  h.strip.destroy();
  assert.equal(h.container.childNodes.length, 0);
  assert.deepEqual(h.container.listeners.filter(
    (listener) => listener.type.startsWith('pointer')), []);
});

// ── Inline stage parameters ─────────────────────────────────────────────────

const paramsOf = (h, label) =>
  chipByLabel(h, label).querySelector('.chain-chip-params');
const rowsOf = (h, label) => paramsOf(h, label).querySelectorAll('.chain-param');
const rowFor = (h, label, parameterId) =>
  rowsOf(h, label).find((row) => row.dataset.parameter === parameterId);
const controlIn = (row) => row.querySelector('.chain-param-control');
const declarationsFor = (h, label) => h.store.document().descriptor.parameters
  .filter((parameter) => parameter.id.startsWith(`${label}.`));

test('the selected chip expands into its own stage’s controls', async () => {
  const h = await makeStrip();
  assert.equal(paramsOf(h, 'sample'), null, 'an unselected chip carries no controls');
  assert.equal(h.container.dataset.expanded, 'false');

  chipByLabel(h, 'sample').dispatch('click');

  const chip = chipByLabel(h, 'sample');
  assert.equal(chip.getAttribute('aria-current'), 'true');
  assert.equal(chip.querySelector('.chain-chip-disclosure').getAttribute('aria-expanded'),
    'true', 'selection and expansion are one state');
  assert.equal(h.container.dataset.expanded, 'true');
  const region = paramsOf(h, 'sample');
  assert.equal(region.getAttribute('role'), 'group');
  assert.equal(region.getAttribute('aria-label'), 'Twin Wave · sample parameters');
  assert.deepEqual(rowsOf(h, 'sample').map((row) => row.dataset.parameter),
    declarationsFor(h, 'sample').map((parameter) => parameter.id),
    'one control per declared parameter, in document order');
  assert.deepEqual(rowsOf(h, 'sample')
    .map((row) => row.querySelector('.chain-param-name').textContent),
  ['Angle Speed', 'Coverage Mode', 'Drift', 'Pattern Freq', 'Speed', 'Weight Mode'],
  'a control is labeled by its field segment alone: the chip names the instance');

  // The document's declared domain and the active preset's value, not the
  // engine's idea of either.
  const freq = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  const declared = declarationsFor(h, 'sample')
    .find((parameter) => parameter.id === 'sample.pattern-freq');
  assert.equal(freq.type, 'range');
  assert.equal(freq.min, String(declared.domain.minimum));
  assert.equal(freq.max, String(declared.domain.maximum));
  assert.equal(Number(freq.value),
    h.store.document().preset_bank.presets[0].values['sample.pattern-freq']);
  assert.equal(rowFor(h, 'sample', 'sample.pattern-freq')
    .querySelector('.chain-param-value').textContent, '3.881');

  chipByLabel(h, 'camera').dispatch('click');
  assert.equal(paramsOf(h, 'sample'), null, 'only the selected chip is expanded');
  assert.equal(rowsOf(h, 'camera').length, 1);
});

test('a stage with no parameters grows no disclosure', async () => {
  const h = await makeStrip();
  assert.deepEqual(declarationsFor(h, 'transfer'), []);

  chipByLabel(h, 'transfer').dispatch('click');

  const chip = chipByLabel(h, 'transfer');
  assert.equal(chip.getAttribute('aria-current'), 'true');
  assert.equal(chip.querySelector('.chain-chip-disclosure'), null,
    'a disclosure that opens nothing is not offered');
  assert.equal(paramsOf(h, 'transfer'), null);
  assert.equal(h.container.dataset.expanded, 'false');
});

test('the disclosure collapses the chip it expanded', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').dispatch('click');
  assert.equal(chipByLabel(h, 'camera')
    .querySelector('.chain-chip-disclosure').getAttribute('aria-expanded'), 'true');

  chipByLabel(h, 'camera').querySelector('.chain-chip-disclosure').dispatch('click');

  assert.equal(h.store.selectedLabel(), null);
  assert.equal(paramsOf(h, 'camera'), null);
  assert.equal(chipByLabel(h, 'camera')
    .querySelector('.chain-chip-disclosure').getAttribute('aria-expanded'), 'false');
  assert.deepEqual(h.selections, ['camera', null]);

  chipByLabel(h, 'camera').querySelector('.chain-chip-disclosure').dispatch('click');
  assert.equal(h.store.selectedLabel(), 'camera', 'and expands it again');
});

test('a slider edit calls back with the parameter and its value', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);

  slider.value = '5.5';
  slider.dispatch('input');

  assert.deepEqual(h.edits, [['sample.pattern-freq', 5.5]]);
  assert.equal(row.querySelector('.chain-param-value').textContent, '5.500');
  assert.deepEqual(h.applied, [], 'a value edit is no structural edit');
  assert.equal(controlIn(rowFor(h, 'sample', 'sample.pattern-freq')), slider,
    'the strip is not rebuilt under the pointer');
});

test('an enum renders its declared values and edits by option id', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'lens').dispatch('click');
  const select = controlIn(rowFor(h, 'lens', 'lens.symmetry'));
  const declared = declarationsFor(h, 'lens')
    .find((parameter) => parameter.id === 'lens.symmetry');

  assert.equal(select.tagName, 'SELECT');
  assert.deepEqual(select.options.map((option) => option.value),
    declared.domain.values);
  assert.equal(select.value, 'hexagonal-prism', 'the preset’s value is selected');

  select.value = 'octahedral';
  select.dispatch('change');

  assert.deepEqual(h.edits, [['lens.symmetry', 'octahedral']],
    'the document stores the option id, never an index');
});

// §3/§4.4: the union schema survives — a field the topology deactivates is
// dimmed, but present and editable, because the document still carries it.
test('a deactivated field renders dimmed but editable', async () => {
  const h = await makeStrip();
  h.strip.insertOperator('warp.wave-shear.v2');
  const label = h.store.chain()
    .find((entry) => entry.operator === 'warp.wave-shear.v2').label;
  chipByLabel(h, label).dispatch('click');

  const edge = rowFor(h, label, `${label}.edge-width`);
  assert.equal(edge.dataset.deactivated, 'true',
    'the envelope gate opens on flat, which reads no edge width');
  assert.equal(edge.getAttribute('title'),
    'Deactivated by the current topology selection');
  assert.equal(controlIn(edge).disabled, undefined, 'dimmed, not disabled');
  assert.equal(rowFor(h, label, `${label}.strength`).dataset.deactivated, undefined);

  const envelope = controlIn(rowFor(h, label, `${label}.envelope`));
  envelope.value = 'edge-fade';
  envelope.dispatch('change');

  assert.equal(edge.dataset.deactivated, undefined,
    'the gate moving onto edge-fade re-activates the field in place');
  assert.equal(edge.getAttribute('title'), '');

  controlIn(edge).value = '0.4';
  controlIn(edge).dispatch('input');
  assert.deepEqual(h.edits.at(-1), [`${label}.edge-width`, 0.4]);
});

test('the inline controls read the named preset', async () => {
  const h = await makeStrip({ presetId: 'hex-twin-wave-alt' });
  chipByLabel(h, 'colorize').dispatch('click');

  assert.equal(Number(controlIn(rowFor(h, 'colorize', 'colorize.mapping-frequency'))
    .value), 2, 'the second preset’s value, not the first’s');
});

test('the inline controls keep their own keys and take no drag', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').dispatch('click');
  const slider = controlIn(rowFor(h, 'camera', 'camera.wander'));

  const right = slider.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(right.defaultPrevented, false,
    'a slider’s own arrow keys are not the strip’s chip roving');
  slider.dispatch('keydown', { key: 'Delete' });
  assert.deepEqual(labels(h),
    ['camera', 'lens', 'project', 'warp2', 'sample', 'transfer', 'colorize']);

  slider.dispatch('pointerdown', { isPrimary: true, button: 0, pointerId: 4 });
  assert.equal(chips(h).some((chip) => chip.dataset.dragging === 'true'), false,
    'a press on a control must not be captured as a chip drag');
});

test('syncHistory repaints Undo and Redo without rebuilding the strip', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').dispatch('click');
  const chip = chipByLabel(h, 'camera');
  assert.equal(h.container.querySelector('.chain-undo').disabled, true);

  h.store.setPresetValue('hex-twin-wave', 'camera.wander', 0.5);
  h.strip.syncHistory();

  assert.equal(h.container.querySelector('.chain-undo').disabled, false);
  assert.equal(chipByLabel(h, 'camera'), chip, 'no rebuild: the chips are the same');
});

// The union-schema rule reads the document's declarations and the preset values
// that gate them.
test('deactivatedParameterIds flags edge-width only while its gate is off edge-fade', () => {
  const parameters = [
    { id: 'sample.coverage-mode', storage: 'enum8' },
    { id: 'sample.edge-width', storage: 'binary32' },
    { id: 'warp1.envelope', storage: 'enum8' },
    { id: 'warp1.edge-width', storage: 'binary32' },
    { id: 'camera.wander', storage: 'binary32' },
  ];
  const values = {
    'sample.coverage-mode': 'weight',
    'sample.edge-width': 0.1,
    'warp1.envelope': 'edge-fade',
    'warp1.edge-width': 0.1,
    'camera.wander': 0,
  };
  assert.deepEqual([...deactivatedParameterIds(parameters, values)],
    ['sample.edge-width']);
  assert.deepEqual([...deactivatedParameterIds(
    [{ id: 'sample.edge-width', storage: 'binary32' }], { 'sample.edge-width': 0.1 })],
  [], 'no gate, no deactivation');
});
