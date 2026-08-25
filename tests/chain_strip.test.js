//
// tools/chain_strip.js renders the pipeline strip — the chain left to right as
// chips grouped into one band per editable carrier, with crossings as socket chips on
// the band boundaries — and translates every gesture (band + palettes, ✕
// removal, socket selection, reorder buttons, Alt+Arrow, bypass, undo) into the
// document store's span-replacement primitive. The fixture is the
// real kaleidoscope_hex_bright pattern document over the pinned engine catalog and the real
// store, so legality, reconciliation and refusal texts are the shipping ones,
// not doubles.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChainDocumentStore } from '../tools/chain_document_store.js';
import { createChainStrip, deactivatedParameterIds } from '../tools/chain_strip.js';
import { compileShaderDocument } from '../shader/shader_workbench.mjs';
import {
  documentEvents, fakeElement, installDocument, restoreDocumentAfterEach,
} from './fake_dom.js';

const CATALOG = JSON.parse(readFileSync(
  new URL('../shader/engine_catalog.json', import.meta.url), 'utf8'));
const BASE = compileShaderDocument(readFileSync(
  new URL('../shader/patterns/kaleidoscope_hex_bright.shader.json', import.meta.url), 'utf8'),
{ catalog: CATALOG });
assert.equal(BASE.status, 'VALID');

const savedAnimationFrame = {
  request: globalThis.requestAnimationFrame,
  cancel: globalThis.cancelAnimationFrame,
};
let nextFrame = 0;
let frameCallbacks = new Map();
beforeEach(() => {
  nextFrame = 0;
  frameCallbacks = new Map();
  globalThis.requestAnimationFrame = (callback) => {
    const id = ++nextFrame;
    frameCallbacks.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => frameCallbacks.delete(id);
});
afterEach(() => {
  globalThis.requestAnimationFrame = savedAnimationFrame.request;
  globalThis.cancelAnimationFrame = savedAnimationFrame.cancel;
});
const runFrame = () => {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  for (const callback of callbacks) callback();
};

// kaleidoscope_hex_bright chain: camera, lens (sphere endos), project (crossing), warp2
// (plane endo), sample (crossing), transfer (field endo), colorize (exit).
const PROJECT = 2;

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
    ...documentEvents(),
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
const paletteOf = (h) => h.container.querySelector('.chain-palette');
const paletteEntries = (h) => h.container.querySelectorAll('.chain-palette-entry');
const lastAnnounced = (h) => h.announced.at(-1) ?? '';
const labels = (h) => h.store.chain().map((entry) => entry.label);

test('the strip lays the chain out as editable carrier bands with sockets between them', async () => {
  const h = await makeStrip();
  const strip = h.container.querySelector('.chain-strip');
  assert.equal(strip.getAttribute('role'), 'toolbar');
  assert.equal(strip.getAttribute('aria-orientation'), 'horizontal');
  assert.equal(strip.getAttribute('aria-label'), 'Shader chain');

  const bands = strip.querySelectorAll('.chain-band');
  assert.deepEqual(bands.map((band) => band.dataset.carrier),
    ['sphere', 'plane', 'field'],
    'color is the terminal output type, not an editable carrier band');
  assert.deepEqual(bands.map((band) => band.getAttribute('aria-label')),
    ['Sphere stages', 'Plane stages', 'Field stages']);
  for (const band of bands) {
    assert.equal(band.getAttribute('role'), 'group');
    assert.equal(band.querySelector('.chain-band-title').getAttribute('aria-hidden'),
      'true');
  }
  assert.deepEqual(
    bands.map((band) => band.querySelectorAll('.chain-chip').map((c) => c.dataset.label)),
    [['camera', 'lens'], ['warp2'], []]);

  const sockets = strip.children.filter(
    (child) => child.classList?.contains('chain-chip--socket'));
  assert.deepEqual(sockets.map((socket) => socket.dataset.label),
    ['project', 'sample', 'colorize'],
    'a crossing sits between the two bands it joins');

  const all = chips(h);
  assert.equal(all.length, 6);
  // A toolbar of groups, not a listbox of options: an option's children are
  // presentational, so every inline stage control would go unexposed.
  for (const chip of all) {
    assert.equal(chip.getAttribute('role'), 'group');
    assert.equal(chip.getAttribute('aria-selected'), null);
  }
  const camera = chipByLabel(h, 'camera');
  assert.equal(camera.getAttribute('aria-label'), 'Rotate · camera');
  assert.equal(camera.querySelector('.chain-chip-name').textContent, 'Rotate');
  assert.equal(camera.querySelector('.chain-chip-label'), null);
  assert.match(chipByLabel(h, 'project').getAttribute('aria-label'),
    /, sphere to plane$/);

  // One roving-tabindex stop and a + only where an insertion is legal.
  assert.deepEqual(all.filter((chip) => chip.getAttribute('tabindex') === '0')
    .map((chip) => chip.dataset.label), ['camera']);
  assert.equal(h.container.querySelectorAll('.chain-gap').length, 0);
  assert.deepEqual(bands.map((band) => band.querySelector('.chain-band-add')
    ?.getAttribute('aria-label') ?? null),
  ['Add a Sphere stage', 'Add a Plane stage', 'Add a Field stage']);
});

test('endomorphisms carry controls; sockets carry only valid selectors', async () => {
  const h = await makeStrip();
  for (const label of ['camera', 'lens', 'warp2']) {
    const chip = chipByLabel(h, label);
    assert.ok(chip.querySelector('.chain-chip-remove'), `${label} carries ✕`);
    assert.ok(chip.querySelector('.chain-chip-bypass'), `${label} carries bypass`);
    assert.equal(chip.querySelector('.chain-chip-replace'), null);
    assert.equal(chip.querySelector('.chain-chip-label'), null);
  }
  for (const label of ['project', 'sample', 'colorize']) {
    const chip = chipByLabel(h, label);
    assert.equal(chip.querySelector('.chain-chip-remove'), null,
      'removal across a crossing is illegal by construction, so no ✕');
    assert.equal(chip.querySelector('.chain-chip-bypass'), null);
    assert.ok(chip.querySelector('.chain-chip-replace'));
    assert.equal(chip.querySelector('.chain-chip-name'), null);
    assert.equal(chip.querySelector('.chain-chip-label'), null);
    assert.equal(chip.querySelector('.chain-chip-pair'), null);
  }
  for (const [label, text, accessibleName] of [
    ['project', 'Projection: ', 'Projection'],
    ['sample', 'Source: ', 'Source function'],
    ['colorize', 'Color: ', 'Color'],
  ]) {
    const functionLabel = chipByLabel(h, label)
      .querySelector('.chain-chip-function-label');
    assert.equal(functionLabel.textContent, text);
    assert.equal(functionLabel.querySelector('.chain-chip-replace')
      .getAttribute('aria-label'), accessibleName);
  }
  const remove = chipByLabel(h, 'lens').querySelector('.chain-chip-remove');
  assert.equal(remove.textContent, '×');
  assert.match(remove.getAttribute('aria-label'), /^Remove .+ · lens$/);
  const controls = chipByLabel(h, 'camera').querySelector('.chain-chip-header')
    .querySelectorAll('button');
  assert.deepEqual(controls.map((button) => button.textContent), ['◉', '←', '→', '×']);
});

test('pipeline arrows, wheel and background arrow keys scroll the viewport', async () => {
  const h = await makeStrip();
  const viewport = h.container.querySelector('.chain-strip-viewport');
  const buttons = h.container.querySelectorAll('.chain-scroll-button');
  viewport.clientWidth = 400;
  viewport.scrollLeft = 0;

  buttons[1].dispatch('click');
  assert.equal(viewport.scrollLeft, 300);
  buttons[0].dispatch('click');
  assert.equal(viewport.scrollLeft, 0);

  const wheel = viewport.dispatch('wheel', { deltaX: 0, deltaY: 120 });
  assert.equal(viewport.scrollLeft, 120);
  assert.equal(wheel.defaultPrevented, true);

  const right = viewport.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(viewport.scrollLeft, 420);
  assert.equal(right.defaultPrevented, true);
  viewport.dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(viewport.scrollLeft, 120);
});

test('clicking a chip header toggles its pinned selection', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'warp2').dispatch('click');

  assert.equal(h.store.selectedLabel(), 'warp2');
  assert.deepEqual(h.selections, ['warp2']);
  const chip = chipByLabel(h, 'warp2');
  assert.equal(chip.getAttribute('aria-current'), 'true',
    'aria-current carries the selection a group cannot express as aria-selected');
  assert.equal(h.doc.activeElement, chip, 'the selected chip takes focus');
  assert.equal(chipByLabel(h, 'camera').getAttribute('aria-current'), null);

  chipByLabel(h, 'warp2').dispatch('click');
  assert.equal(h.store.selectedLabel(), null);
  assert.deepEqual(h.selections, ['warp2', null]);

  chipByLabel(h, 'camera').dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(h.selections, ['warp2', null, 'camera']);
  chipByLabel(h, 'camera').dispatch('keydown', { key: ' ' });
  assert.equal(h.store.selectedLabel(), null,
    'keyboard activation closes the pinned card like a click');
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
    ['camera', 'lens', 'project', 'warp2', 'sample', 'colorize']);
  assert.deepEqual(h.applied, []);
  assert.notEqual(lastAnnounced(h), '',
    'the refusal reason reaches the shared live region');
});

test('× and Delete remove an endomorphism and re-apply the program', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'lens').dispatch('click');
  chipByLabel(h, 'lens').querySelector('.chain-chip-remove').dispatch('click');

  assert.deepEqual(labels(h),
    ['camera', 'project', 'warp2', 'sample', 'colorize']);
  assert.deepEqual(h.applied,
    [['camera', 'project', 'warp2', 'sample', 'colorize']]);
  assert.equal(h.doc.activeElement.dataset.label, 'project',
    'focus lands on the chip that filled the removed slot');
  assert.deepEqual(h.selections, ['lens', null],
    'removing the selected chip clears the published selection');

  chipByLabel(h, 'warp2').dispatch('keydown', { key: 'Delete' });
  assert.deepEqual(labels(h),
    ['camera', 'project', 'sample', 'colorize']);
  assert.equal(paletteOf(h), null, 'Delete on an endomorphism needs no palette');
});

test('Delete opens a socket replacement palette containing only valid stages', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });

  const palette = paletteOf(h);
  assert.equal(palette.getAttribute('role'), 'listbox');
  const entries = paletteEntries(h);
  assert.equal(entries.length, 8,
    'only the projection functions valid for this socket are shown');
  assert.equal(entries[0].dataset.remove, undefined);
  const bonne = entries.find((entry) => entry.dataset.operator === 'project.bonne.v2');
  assert.equal(bonne.getAttribute('aria-disabled'), null,
    'a same-pair operator is enabled');
  assert.equal(entries.find((entry) => entry.dataset.operator === 'sample.grid.v2'),
    undefined);
  assert.equal(h.doc.activeElement.dataset.operator, 'project.stereographic.v2',
    'focus moves to the palette\'s first enabled entry');

  h.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(paletteOf(h), null);
  assert.equal(h.doc.activeElement, chipByLabel(h, 'project'));
  assert.deepEqual(h.applied, []);

  const select = chipByLabel(h, 'project').querySelector('.chain-chip-replace');
  select.value = 'project.bonne.v2';
  select.dispatch('change');
  assert.equal(h.store.chain()[PROJECT].operator, 'project.bonne.v2');
  assert.equal(h.applied.length, 1);
  assert.equal(h.doc.activeElement.dataset.label, h.store.chain()[PROJECT].label);
});

test('a palette carries its listbox selection on the focused option', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });

  const entries = paletteEntries(h);
  const selection = () => entries.map((entry) => entry.getAttribute('aria-selected'));
  assert.deepEqual(selection(), entries.map((_, at) => String(at === 0)),
    'the opened palette selects the option it focused, and only that one');

  entries[0].dispatch('keydown', { key: 'ArrowDown' });
  assert.deepEqual(selection(), entries.map((_, at) => String(at === 1)),
    'the selection follows the arrow-key focus');
});

// A palette left open over a chain the strip has since rebuilt commits against
// stale indices, so every way out of it has to close it.
test('an open palette is dismissed by an outside press and by losing focus', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });
  const entries = paletteEntries(h);

  h.doc.dispatch('pointerdown', { target: entries[1] });
  assert.notEqual(paletteOf(h), null, 'a press inside the palette keeps it open');
  paletteOf(h).dispatch('focusout', { relatedTarget: entries[1] });
  assert.notEqual(paletteOf(h), null, 'focus moving between options keeps it open');

  paletteOf(h).dispatch('focusout', { relatedTarget: chipByLabel(h, 'camera') });
  assert.equal(paletteOf(h), null, 'focus leaving the palette dismisses it');

  chipByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });
  h.doc.dispatch('pointerdown', { target: chipByLabel(h, 'camera') });
  assert.equal(paletteOf(h), null, 'a press outside dismisses it');
  assert.deepEqual(h.applied, [], 'neither dismissal committed an edit');

  assert.equal(h.doc.listenerCount('pointerdown'), 1);
  h.strip.destroy();
  assert.equal(h.doc.listenerCount('pointerdown'), 0,
    'the document outlives the strip, so destroy() must take the listener off');
});

test('palette dismissal tolerates focusout during DOM removal', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });
  const element = paletteOf(h);
  const remove = element.remove.bind(element);
  let removals = 0;
  element.remove = () => {
    removals += 1;
    if (removals > 1) throw new Error('palette removed twice');
    element.dispatch('focusout', { relatedTarget: chipByLabel(h, 'camera') });
    remove();
  };

  h.doc.dispatch('pointerdown', { target: chipByLabel(h, 'camera') });

  assert.equal(removals, 1);
  assert.equal(paletteOf(h), null);
  assert.deepEqual(h.applied, []);
});

// Picking the operator a socket already carries is a no-op, not a re-seat: the
// instance keeps its label, and with it every tuned value.
test('selecting the operator the socket carries keeps the instance', async () => {
  const h = await makeStrip();
  const before = h.store.document();
  assert.equal(before.preset_bank.presets[0].values['project.singularity-fade'] !== 1, true,
    'the fixture tunes the socket away from the catalog default');

  let select = chipByLabel(h, 'project').querySelector('.chain-chip-replace');
  select.value = 'project.stereographic.v2';
  select.dispatch('change');
  assert.deepEqual(h.store.document(), before,
    'label, values, presets and serialization fields are all untouched');
  assert.equal(h.store.canUndo(), false, 'an edit that changes nothing has nothing to undo');
  assert.equal(h.doc.activeElement.dataset.label, 'project');

  select = chipByLabel(h, 'project').querySelector('.chain-chip-replace');
  select.value = 'project.bonne.v2';
  select.dispatch('change');
  const after = h.store.document();
  assert.deepEqual(after.descriptor.chain[PROJECT],
    { label: 'project1', operator: 'project.bonne.v2' },
    'a different operator retires the instance and seats a fresh one');
  assert.equal(after.preset_bank.presets[0].values['project1.singularity-fade'], 1,
    'the fresh instance opens on the catalog defaults');
  assert.equal(h.store.canUndo(), true);
});

test('a band + appends while Insert opens the insertion palette after focus', async () => {
  const h = await makeStrip();
  bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
  let entries = paletteEntries(h);
  assert.equal(entries.every((entry) => entry.getAttribute('aria-disabled') === null), true);
  entries.find((entry) => entry.dataset.operator === 'sphere.lens.mobius.v2')
    .dispatch('click');
  assert.deepEqual(labels(h).slice(0, 3), ['camera', 'lens', 'sphere1'],
    'the band + lands at the band\'s last gap');
  assert.equal(h.store.selectedLabel(), 'sphere1',
    'the landed stage is selected, so its controls open on the insert');
  assert.equal(chipByLabel(h, 'sphere1').getAttribute('aria-current'), 'true');
  assert.equal(chipByLabel(h, 'sphere1')
    .classList.contains('chain-chip--expanded'), true);
  assert.deepEqual(h.selections, ['sphere1']);
  assert.equal(h.applied.length, 1);

  chipByLabel(h, 'camera').dispatch('click');
  bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h).find((entry) => entry.dataset.operator === 'sphere.lens.glitch.v2')
    .dispatch('click');
  assert.deepEqual(labels(h).slice(0, 4), ['camera', 'lens', 'sphere1', 'sphere2'],
    'selection does not move the band + away from the last gap');
  assert.equal(h.store.chain()[3].operator, 'sphere.lens.glitch.v2');

  chipByLabel(h, 'camera').dispatch('keydown', { key: 'Insert' });
  entries = paletteEntries(h);
  const illegal = entries.find((entry) => entry.dataset.operator === 'warp.affine.v2');
  assert.equal(illegal, undefined, 'invalid stages are omitted instead of greyed out');
});

/**
 * @param {Object} h - A strip harness.
 * @param {number} width - Width every created element reports.
 * @returns {void}
 */
const measureNewElements = (h, width) => {
  h.doc.documentElement = { clientWidth: 1280 };
  h.doc.createElement = (/** @type {string} */ tag) => {
    const node = fakeElement(tag);
    node.getBoundingClientRect = () => ({ left: 0, width });
    return node;
  };
};

test('a palette opens anchored to the control that opened it', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  add.getBoundingClientRect = () => ({ left: 298, bottom: 52, width: 20 });
  add.dispatch('click');
  assert.equal(paletteOf(h).style.left, '298px');
  assert.equal(paletteOf(h).style.top, '52px');
});

test('a palette near the right edge is clamped back inside the viewport', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  add.getBoundingClientRect = () => ({ left: 1250, bottom: 52, width: 40 });
  add.dispatch('click');
  assert.equal(paletteOf(h).style.left, '1064px',
    'clamped to the viewport width less the palette and its margin');
});

test('a palette keeps its stylesheet placement where nothing measures', async () => {
  const h = await makeStrip();
  bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
  assert.equal(paletteOf(h).style.left, '',
    'a DOM without layout writes no offset rather than throwing');
});

test('undo and redo revert and reapply whole edits through the same apply path', async () => {
  const h = await makeStrip();
  bandFor(h, 'plane').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h)
    .find((entry) => entry.dataset.operator === 'warp.wave-shear.v2')
    .dispatch('click');
  assert.equal(labels(h).length, 7);
  assert.equal(h.applied.length, 1);

  h.container.querySelector('.chain-undo').dispatch('click');
  assert.equal(labels(h).length, 6);
  assert.equal(h.applied.length, 2);

  const redo = h.container.querySelector('.chain-redo');
  assert.equal(redo.disabled, false);
  redo.dispatch('click');
  assert.equal(labels(h).length, 7);
  assert.equal(h.applied.length, 3);

  // Ctrl+Z reaches the container's shortcut from any chip.
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(labels(h).length, 6);
  assert.equal(h.applied.length, 4);
});

test('bypass toggles the program shape without touching the document', async () => {
  const h = await makeStrip();
  const digest = h.store.compile().descriptor_digest;

  chipByLabel(h, 'lens').querySelector('.chain-chip-bypass').dispatch('click');
  assert.deepEqual(h.applied.at(-1),
    ['camera', 'project', 'warp2', 'sample', 'colorize']);
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

// A press that travels off a chip is a real-layout gesture, and no chip binds
// a pointer listener to observe it: scripts/workbench-probe.mjs owns it.
test('a chip selects by click', async () => {
  const h = await makeStrip();
  assert.equal(h.store.selectedLabel(), null);

  chipByLabel(h, 'lens').dispatch('click');
  assert.equal(h.store.selectedLabel(), 'lens');
  assert.deepEqual(h.selections, ['lens'], 'the selection is announced once');
  assert.deepEqual(h.applied, [], 'a selection is no structural edit');
});

test('reorder buttons replace the chip drag affordance', async () => {
  const h = await makeStrip();
  assert.equal(chipByLabel(h, 'camera').querySelectorAll('.chain-chip-move').length, 2);
  assert.equal(chipByLabel(h, 'lens').querySelectorAll('.chain-chip-move').length, 2);
  assert.equal(chipByLabel(h, 'warp2').querySelectorAll('.chain-chip-move').length, 2);
  assert.equal(chipByLabel(h, 'warp2').querySelectorAll('.chain-chip-move')
    .every((button) => button.disabled), true);
  assert.equal(chipByLabel(h, 'project').querySelectorAll('.chain-chip-move').length, 0);

  const later = chipByLabel(h, 'camera').querySelectorAll('.chain-chip-move')[1];
  later.dispatch('click');
  assert.deepEqual(labels(h).slice(0, 2), ['lens', 'camera']);
});

test('insertOperator lands after the selection, else at the first legal gap', async () => {
  const h = await makeStrip();
  assert.equal(h.strip.insertOperator('warp.curl-flow.v2'), true);
  assert.equal(h.store.chain()[3].operator, 'warp.curl-flow.v2',
    'no selection: the first gap the store accepts');
  assert.equal(h.store.selectedLabel(), h.store.chain()[3].label,
    'the landed stage is selected, so its controls open on the insert');

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
  assert.equal(h.store.chain().length, 6,
    'the crossing replaced the socket; it filled no gap');
  assert.equal(h.store.chain()[PROJECT].operator, 'project.gnomonic.v2');
  assert.deepEqual(labels(h).filter((label) => label !== h.store.chain()[PROJECT].label),
    ['camera', 'lens', 'warp2', 'sample', 'colorize'],
    'every other instance keeps its label, and so its values');
  assert.equal(h.applied.length, 1, 'the swap re-applies the program');
  const selector = chipByLabel(h, h.store.chain()[PROJECT].label)
    .querySelector('.chain-chip-replace');
  assert.equal(selector.value, 'project.gnomonic.v2');
  assert.equal(selector.selectedOptions[0].textContent, 'Gnomonic');
});

// The library commits the same one-for-one replacement the socket's swap does,
// so clicking the projection already in the chain must leave it alone.
test('a library crossing already in the chain keeps the socket', async () => {
  const h = await makeStrip();
  const before = h.store.document();

  assert.equal(h.strip.insertOperator('project.stereographic.v2'), true);
  assert.deepEqual(h.store.document(), before,
    'label, values, presets and serialization fields are all untouched');
  assert.equal(h.store.canUndo(), false, 'an edit that changes nothing has nothing to undo');

  assert.equal(h.strip.insertOperator('project.gnomonic.v2'), true);
  const after = h.store.document();
  assert.deepEqual(after.descriptor.chain[PROJECT],
    { label: 'project1', operator: 'project.gnomonic.v2' });
  assert.equal(after.preset_bank.presets[0].values['project1.singularity-fade'], 1,
    'the fresh instance opens on the catalog defaults');
  assert.equal(h.store.canUndo(), true);
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
    ['camera', 'lens', 'project', 'warp2', 'sample', 'colorize']);
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

test('pointer gestures never start a chip drag', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'lens').dispatch('pointerdown',
    { isPrimary: true, button: 0, pointerId: 7 });
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.container.listeners.filter(
    (listener) => listener.type.startsWith('pointer')), []);
});

test('destroy detaches the strip listeners and empties the strip', async () => {
  const h = await makeStrip();
  bandFor(h, 'plane').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h)
    .find((entry) => entry.dataset.operator === 'warp.wave-shear.v2')
    .dispatch('click');
  assert.deepEqual(h.container.listeners.map((listener) => listener.type), ['keydown'],
    'the history shortcut is the one listener the strip binds to its mount');

  h.strip.destroy();
  assert.equal(h.container.childNodes.length, 0);
  assert.deepEqual(h.container.listeners, [],
    'the next document reuses the mount, so nothing may stay bound to it');

  h.container.dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(labels(h).length, 7, 'a destroyed strip undoes nothing');
  assert.equal(h.container.childNodes.length, 0, 'and repaints nothing');
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

test('stage controls open transiently on hover and pin open on click', async () => {
  const h = await makeStrip();
  assert.ok(paramsOf(h, 'sample'), 'an unselected chip carries its controls');
  assert.equal(h.container.dataset.expanded, 'false');

  const chip = chipByLabel(h, 'sample');
  assert.equal(chip.querySelector('.chain-chip-disclosure'), null);
  assert.equal(chip.getAttribute('aria-expanded'), 'false');
  assert.equal(chip.classList.contains('chain-chip--expanded'), false);

  chip.dispatch('mouseenter');
  assert.equal(chip.getAttribute('aria-expanded'), 'true');
  assert.equal(chip.classList.contains('chain-chip--expanded'), true);
  assert.equal(h.container.dataset.expanded, 'true');
  chip.dispatch('mouseleave');
  assert.equal(chip.getAttribute('aria-expanded'), 'false');
  assert.equal(chip.classList.contains('chain-chip--expanded'), false);

  chip.dispatch('click');
  const pinned = chipByLabel(h, 'sample');
  assert.equal(pinned.getAttribute('aria-expanded'), 'true');
  pinned.dispatch('mouseleave');
  assert.equal(pinned.classList.contains('chain-chip--expanded'), true,
    'mouse leave preserves a pinned card');
  pinned.dispatch('click');
  assert.equal(chipByLabel(h, 'sample').getAttribute('aria-expanded'), 'false');
  assert.equal(h.container.dataset.expanded, 'false');

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
    .querySelector('.chain-param-value').value, '3.881');

  chipByLabel(h, 'camera').dispatch('click');
  assert.equal(rowsOf(h, 'camera').length, 1);
});

test('a stage with no parameters grows no disclosure', async () => {
  const h = await makeStrip();
  h.strip.insertOperator('sphere.lens.glitch.v2');
  const label = h.store.chain()
    .find((entry) => entry.operator === 'sphere.lens.glitch.v2').label;
  assert.deepEqual(declarationsFor(h, label), []);

  const chip = chipByLabel(h, label);
  assert.equal(chip.getAttribute('aria-current'), 'true');
  assert.equal(chip.querySelector('.chain-chip-disclosure'), null,
    'a disclosure that opens nothing is not offered');
  assert.equal(chip.getAttribute('aria-expanded'), null);
  assert.equal(paramsOf(h, label), null);
  assert.equal(h.container.dataset.expanded, 'false');
});

test('pinning a stage closes the previously pinned stage', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').dispatch('click');
  chipByLabel(h, 'lens').dispatch('click');

  assert.equal(h.store.selectedLabel(), 'lens');
  assert.equal(chipByLabel(h, 'camera').getAttribute('aria-expanded'), 'false');
  assert.equal(chipByLabel(h, 'lens').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(h.selections, ['camera', 'lens']);
});

test('a slider edit calls back with the parameter and its value', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);

  slider.value = '5.5';
  slider.dispatch('input');

  assert.deepEqual(h.edits, [], 'the expensive write waits for the frame');
  runFrame();
  assert.deepEqual(h.edits, [['sample.pattern-freq', 5.5]]);
  assert.equal(row.querySelector('.chain-param-value').value, '5.5');
  assert.deepEqual(h.applied, [], 'a value edit is no structural edit');
  assert.equal(controlIn(rowFor(h, 'sample', 'sample.pattern-freq')), slider,
    'the strip is not rebuilt under the pointer');
});

test('slider input coalesces to the latest value in each frame', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);

  for (const value of ['2', '3', '4']) {
    slider.value = value;
    slider.dispatch('input');
  }
  assert.equal(row.querySelector('.chain-param-value').value, '4');
  assert.deepEqual(h.edits, []);
  runFrame();
  assert.deepEqual(h.edits, [['sample.pattern-freq', 4]]);

  slider.value = '5';
  slider.dispatch('input');
  h.strip.destroy();
  runFrame();
  assert.deepEqual(h.edits, [['sample.pattern-freq', 4]]);
});

test('a numeric value can be typed directly and stays within its domain', async () => {
  const h = await makeStrip();
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const value = row.querySelector('.chain-param-value');

  value.value = '5.5';
  value.dispatch('change');
  assert.equal(slider.value, '5.5');
  assert.equal(value.value, '5.5');
  assert.deepEqual(h.edits, [['sample.pattern-freq', 5.5]]);

  value.value = '100';
  value.dispatch('change');
  assert.equal(Number(slider.value), Number(slider.max));
  assert.equal(Number(value.value), Number(slider.max));
  assert.deepEqual(h.edits.at(-1), ['sample.pattern-freq', Number(slider.max)]);
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
  assert.equal(edge.getAttribute('title'), null);

  controlIn(edge).value = '0.4';
  controlIn(edge).dispatch('input');
  runFrame();
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
    ['camera', 'lens', 'project', 'warp2', 'sample', 'colorize']);

  slider.dispatch('pointerdown', { isPrimary: true, button: 0, pointerId: 4 });
  assert.deepEqual(h.applied, [],
    'a press on a control must not apply a chain edit');
  assert.deepEqual(labels(h),
    ['camera', 'lens', 'project', 'warp2', 'sample', 'colorize']);
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
test('deactivatedParameterIds follows the engine topology gates', () => {
  const parameters = [
    { id: 'sample.coverage-mode', storage: 'enum8' },
    { id: 'sample.edge-width', storage: 'binary32' },
    { id: 'warp1.envelope', storage: 'enum8' },
    { id: 'warp1.edge-width', storage: 'binary32' },
    { id: 'camera.wander', storage: 'binary32' },
    { id: 'colorize.hue-shift-mode', storage: 'enum8' },
    { id: 'colorize.hue-shift-amount', storage: 'binary32' },
    { id: 'colorize.hue-noise-scale', storage: 'binary32' },
    { id: 'colorize.hue-noise-speed', storage: 'binary32' },
    { id: 'colorize.brightness-envelope', storage: 'enum8' },
    { id: 'colorize.brightness-depth', storage: 'binary32' },
  ];
  const values = {
    'sample.coverage-mode': 'weight',
    'sample.edge-width': 0.1,
    'warp1.envelope': 'edge-fade',
    'warp1.edge-width': 0.1,
    'camera.wander': 0,
    'colorize.hue-shift-mode': 'path-length',
    'colorize.hue-shift-amount': 1,
    'colorize.hue-noise-scale': 1,
    'colorize.hue-noise-speed': 0,
    'colorize.brightness-envelope': 'none',
    'colorize.brightness-depth': 1,
  };
  const chain = [
    { label: 'sample', operator: 'sample.grid.v2' },
    { label: 'warp1', operator: 'warp.wave-shear.v2' },
    { label: 'camera', operator: 'sphere.rotate.v2' },
    { label: 'colorize', operator: 'colorize.generated-palette.v2' },
  ];
  assert.deepEqual([...deactivatedParameterIds(parameters, values, chain, CATALOG)],
    ['sample.edge-width', 'colorize.hue-noise-scale',
      'colorize.hue-noise-speed', 'colorize.brightness-depth']);
  assert.deepEqual([...deactivatedParameterIds(
    [{ id: 'sample.edge-width', storage: 'binary32' }],
    { 'sample.edge-width': 0.1 }, chain, CATALOG)],
  [], 'no gate, no deactivation');

  const renamed = structuredClone(CATALOG);
  renamed.operators.find((operator) => operator.id === 'sample.grid.v2')
    .params.find((field) => field.id === 'coverage-mode').id = 'coverage-style';
  const renamedParameters = parameters.map((parameter) => ({
    ...parameter,
    id: parameter.id === 'sample.coverage-mode' ? 'sample.coverage-style' : parameter.id,
  }));
  assert.deepEqual([...deactivatedParameterIds(
    renamedParameters,
    { ...values, 'sample.coverage-style': values['sample.coverage-mode'] },
    chain, renamed,
  )], ['colorize.hue-noise-scale', 'colorize.hue-noise-speed',
    'colorize.brightness-depth']);
});
