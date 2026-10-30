// Check chain-strip gestures against the real document store and
// kaleidoscope_hex_bright fixture compiled with the pinned engine catalog.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createChainDocumentStore, scratchChainDocument } from '../src/workbench/shader/chain_document_store.js';
import { createChainStrip } from '../src/workbench/shader/chain_strip.js';
import { deactivatedParameterIds } from '../src/workbench/shader/chain_presentation.js';
import { compileShaderDocument } from '../generated/shader/shader_workbench.mjs';
import {
  documentEvents, fakeElement, installAnimationFrames, installDocument,
  restoreDocumentAfterEach,
} from './helpers/fake_dom.js';

const CATALOG = JSON.parse(readFileSync(
  new URL('../generated/shader/engine_catalog.json', import.meta.url), 'utf8'));
const BASE = compileShaderDocument(readFileSync(
  new URL('../generated/shader/patterns/kaleidoscope_hex_bright.shader.json', import.meta.url), 'utf8'),
{ catalog: CATALOG });
assert.equal(BASE.status, 'VALID');

let frames = null;
beforeEach(() => { frames = installAnimationFrames(); });
afterEach(() => { frames.restore(); });
const runFrame = () => frames.flush();

// kaleidoscope_hex_bright chain: camera, lens (sphere endos), project (crossing), warp2
// (plane endo), sample (crossing), colorize (exit).
const PROJECT = 2;

restoreDocumentAfterEach();

/**
 * A strip over a fresh store on a fresh fixture copy, plus its spies.
 * @param {{presetId?: string|null, bypassAvailable?: () => boolean,
 *   writeThrough?: boolean, parameterLive?: (parameterId: string) => boolean,
 *   acceptParameter?: () => boolean, source?: Object}} [seams] - The preset the inline controls read,
 *   omitted the strip falls back to the document's first; whether a bypass
 *   reaches what is rendering; and whether inline edits reach the store as the
 *   page writes them; whether a parameter is live in the active build; whether
 *   the page accepts an inline edit (false models a refused write); and the
 *   document the store opens on.
 * @returns {Promise<Object>} The harness.
 */
async function makeStrip({
  presetId = null, bypassAvailable = () => true, writeThrough = false, parameterLive = () => true,
  acceptParameter = () => true,
  source = structuredClone(BASE.document),
} = {}) {
  const store = await createChainDocumentStore({
    document: source, catalog: CATALOG });
  const container = fakeElement('section', { connected: true });
  const doc = installDocument({
    body: fakeElement('body', { connected: true }),
    activeElement: null,
    createElement: (/** @type {string} */ tag) => fakeElement(tag),
    ...documentEvents(),
  });
  const applied = [];
  const selections = [];
  const announced = [];
  const edits = [];
  const commits = [];
  const strip = createChainStrip({
    doc,
    container,
    store,
    catalog: CATALOG,
    announce: (message) => announced.push(message),
    onApply: () => applied.push(store.programShape().map((entry) => entry.instance)),
    onSelect: (label) => selections.push(label),
    presetId: () => presetId,
    onEditParameter: (parameterId, value) => {
      if (!acceptParameter()) return false;
      edits.push([parameterId, value]);
      if (!writeThrough) return;
      const target = presetId ?? store.document().preset_bank.presets[0].preset_id;
      assert.equal(store.setPresetValue(target, parameterId, value).ok, true);
    },
    onCommitParameter: () => commits.push(edits.length),
    bypassAvailable, parameterLive,
  });
  return {
    store, container, doc, strip, applied, selections, announced, edits, commits,
  };
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
  assert.equal(strip.getAttribute('role'), 'group');
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
  // Groups, not listbox options: an option's children are presentational.
  for (const chip of all) {
    assert.equal(chip.getAttribute('role'), 'group');
    assert.equal(chip.getAttribute('aria-selected'), null);
  }
  const camera = chipByLabel(h, 'camera');
  assert.equal(camera.getAttribute('aria-label'), 'Rotate · camera');
  assert.equal(camera.querySelector('.chain-chip-name').textContent, 'Rotate');
  assert.match(chipByLabel(h, 'project').getAttribute('aria-label'),
    /, sphere to plane$/);

  // One roving-tabindex stop and a + only where an insertion is legal.
  assert.deepEqual(all.filter((chip) => chip.getAttribute('tabindex') === '0')
    .map((chip) => chip.dataset.label), ['camera']);
  assert.equal(h.container.querySelectorAll('.chain-band-add').length, 3,
    'each band carries one + insertion control');
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
    assert.equal(chip.querySelector('.chain-chip-name').textContent.length > 0,
      true, `${label} names its operator`);
  }
  for (const label of ['project', 'sample', 'colorize']) {
    const chip = chipByLabel(h, label);
    assert.equal(chip.querySelector('.chain-chip-remove'), null,
      'removal across a crossing is illegal by construction, so no ✕');
    assert.equal(chip.querySelector('.chain-chip-bypass'), null);
    assert.ok(chip.querySelector('.chain-chip-replace'));
    assert.equal(chip.querySelector('.chain-chip-name'), null);
    assert.ok(chip.querySelector('.chain-chip-function-label'),
      'a crossing names its function, never its instance');
  }
  for (const [label, text, accessibleName] of [
    ['project', 'Projection: ', 'Projection'],
    ['sample', 'Source: ', 'Source function'],
    ['colorize', 'Color: ', 'Color'],
  ]) {
    const functionLabel = chipByLabel(h, label)
      .querySelector('.chain-chip-function-label');
    assert.equal(functionLabel.childNodes[0], text);
    assert.equal(functionLabel.querySelector('.chain-chip-replace')
      .getAttribute('aria-label'), accessibleName);
  }
  const remove = chipByLabel(h, 'lens').querySelector('.chain-chip-remove');
  assert.equal(remove.textContent, '×');
  assert.match(remove.getAttribute('aria-label'), /^Remove .+ · lens$/);
  const controls = chipByLabel(h, 'camera').querySelector('.chain-chip-header')
    .querySelectorAll('button');
  assert.deepEqual(controls.map((button) => button.textContent), ['◉', '', '×']);
});

test('a socket names the function by the carrier its crossing produces', async () => {
  const h = await makeStrip();
  // camera, lens, sample (sphere to field), colorize: a shipped crossing
  // that skips the plane band entirely.
  assert.equal(h.store.replaceSpan(PROJECT, 3,
    [{ operator: 'sample.spherical-noise.v3' }]).ok, true);
  h.strip.render();

  const sockets = h.container.querySelectorAll('.chain-chip--socket');
  const names = sockets.map((chip) => chip.querySelector('.chain-chip-function-label')
    .childNodes[0]);
  assert.deepEqual(names, ['Source: ', 'Color: ']);
  assert.deepEqual(
    sockets.map((chip) => chip.querySelector('.chain-chip-replace')
      .getAttribute('aria-label')),
    ['Source function', 'Color'],
    'the sphere to field crossing is a source, not a second Color socket');
});

test('a carrier the chain passes over has no band', async () => {
  const h = await makeStrip();
  assert.equal(h.store.replaceSpan(PROJECT, 3,
    [{ operator: 'sample.spherical-noise.v3' }]).ok, true);
  h.strip.render();

  assert.deepEqual(
    h.container.querySelectorAll('.chain-band').map((band) => band.dataset.carrier),
    ['sphere', 'field'],
    'a framed, titled plane band would hold no gap, chip or socket');
});

test('a socket collapses an emptied band and expands back out of one', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'warp2').dispatch('keydown', { key: 'Delete' });
  assert.deepEqual(labels(h), ['camera', 'lens', 'project', 'sample', 'colorize'],
    'the plane band is empty, so Project and Sample are adjacent crossings');

  let select = chipByLabel(h, 'sample').querySelector('.chain-chip-replace');
  assert.equal(select.options.some((option) =>
    option.value === 'sample.spherical-rings.v3'), true,
  'a source skipping the plane band is offered where that band is empty');
  select.value = 'sample.spherical-rings.v3';
  select.dispatch('change');
  assert.deepEqual(h.store.chain().map((entry) => entry.operator),
    ['sphere.rotate.v2', 'sphere.lens.kaleidoscope.v2',
      'sample.spherical-rings.v3', 'colorize.generated-palette.v3'],
    'the one source replaces both crossings');
  assert.equal(bandFor(h, 'plane') === undefined, true,
    'a skipped band has no gap to insert at, so it is not drawn');

  select = h.container.querySelectorAll('.chain-chip--socket')[0]
    .querySelector('.chain-chip-replace');
  const crossings = (input, output) => CATALOG.operators.filter(
    (operator) => operator.input === input && operator.output === output).length;
  assert.equal(select.options.length, crossings('sphere', 'field')
    + crossings('sphere', 'plane') * crossings('plane', 'field'),
  'the socket offers every direct and projected source');
  select.value = 'project.equirectangular.v2 sample.lattice.v2';
  select.dispatch('change');
  assert.deepEqual(h.store.chain().map((entry) => entry.operator),
    ['sphere.rotate.v2', 'sphere.lens.kaleidoscope.v2', 'project.equirectangular.v2',
      'sample.lattice.v2', 'colorize.generated-palette.v3']);
  assert.ok(bandFor(h, 'plane').querySelector('.chain-band-add'),
    'the plane band and its operator vocabulary are back');
  assert.equal(h.applied.length, 3);
});

test('a loaded plane-skipping chain reaches the plane vocabulary through Delete', async () => {
  const h = await makeStrip();
  assert.equal(h.store.replaceSpan(PROJECT, 3,
    [{ operator: 'sample.spherical-noise.v3' }]).ok, true);
  h.strip.render();

  const socket = h.container.querySelectorAll('.chain-chip--socket')[0];
  socket.dispatch('keydown', { key: 'Delete' });
  const pair = paletteEntries(h).find((entry) =>
    entry.dataset.operator === 'project.gnomonic.v2 sample.fractal.v2');
  assert.equal(pair.querySelector('.chain-palette-name').textContent,
    'Gnomonic → Escape Fractal');
  pair.dispatch('click');

  assert.equal(paletteOf(h), null);
  assert.deepEqual(h.store.chain().map((entry) => entry.operator),
    ['sphere.rotate.v2', 'sphere.lens.kaleidoscope.v2', 'project.gnomonic.v2',
      'sample.fractal.v2', 'colorize.generated-palette.v3']);
  assert.ok(bandFor(h, 'plane').querySelector('.chain-band-add'));
});

test('pipeline arrows, wheel and background arrow keys scroll the viewport', async () => {
  const h = await makeStrip();
  const viewport = h.container.querySelector('.chain-strip-viewport');
  assert.equal(viewport.getAttribute('role'), 'group');
  assert.equal(viewport.getAttribute('aria-label'), 'Scrollable shader chain');
  const buttons = h.container.querySelectorAll('.chain-scroll-button');
  viewport.clientHeight = 400;
  viewport.scrollHeight = 1600;
  viewport.scrollTop = 0;

  buttons[1].dispatch('click');
  assert.equal(viewport.scrollTop, 300);
  buttons[0].dispatch('click');
  assert.equal(viewport.scrollTop, 0);

  const horizontal = viewport.dispatch('wheel', { deltaX: 120, deltaY: 0 });
  assert.equal(viewport.scrollTop, 0);
  assert.equal(horizontal.defaultPrevented, false);
  const wheel = viewport.dispatch('wheel', { deltaX: 0, deltaY: 120 });
  assert.equal(viewport.scrollTop, 120);
  assert.equal(wheel.defaultPrevented, true);

  const down = viewport.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(viewport.scrollTop, 420);
  assert.equal(down.defaultPrevented, true);
  viewport.dispatch('keydown', { key: 'ArrowUp' });
  assert.equal(viewport.scrollTop, 120);
});

test('the wheel reads deltaMode and yields when the strip cannot scroll', async () => {
  const h = await makeStrip();
  const viewport = h.container.querySelector('.chain-strip-viewport');
  viewport.clientHeight = 400;
  viewport.scrollHeight = 1600;
  viewport.scrollTop = 0;

  viewport.dispatch('wheel', { deltaX: 0, deltaY: 3, deltaMode: 1 });
  assert.equal(viewport.scrollTop, 48, 'a line-mode notch is not 3 pixels');
  viewport.scrollTop = 0;
  viewport.dispatch('wheel', { deltaX: 0, deltaY: 1, deltaMode: 2 });
  assert.equal(viewport.scrollTop, 400, 'a page-mode notch is one viewport');

  viewport.dispatch('wheel', { deltaX: 0, deltaY: 5000 });
  assert.equal(viewport.scrollTop, 1200, 'the offset stops at the content edge');

  viewport.scrollHeight = 400;
  viewport.scrollTop = 0;
  const idle = viewport.dispatch('wheel', { deltaX: 0, deltaY: 120 });
  assert.equal(viewport.scrollTop, 0);
  assert.equal(idle.defaultPrevented, false,
    'a strip with nothing to scroll leaves the wheel to the page');
});

test('the viewport offset survives the rebuild a committed edit forces', async () => {
  const h = await makeStrip();
  const viewport = h.container.querySelector('.chain-strip-viewport');
  viewport.clientHeight = 400;
  viewport.scrollHeight = 1600;
  viewport.scrollTop = 40;

  chipByLabel(h, 'camera').dispatch('keydown', { key: 'ArrowDown', altKey: true });

  assert.deepEqual(labels(h).slice(0, 2), ['lens', 'camera']);
  assert.equal(h.container.querySelector('.chain-strip-viewport').scrollTop, 40);
});

test('clicking a chip header toggles its pin and selection', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'warp2').querySelector('.chain-chip-name').dispatch('click');

  assert.equal(h.store.selectedLabel(), 'warp2');
  assert.deepEqual(h.selections, ['warp2']);
  const chip = chipByLabel(h, 'warp2');
  assert.equal(chip.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  chip.dispatch('mouseleave');
  assert.equal(chip.classList.contains('chain-chip--expanded'), true);
  assert.equal(chip.getAttribute('aria-current'), 'true',
    'aria-current carries the selection a group cannot express as aria-selected');
  assert.equal(h.doc.activeElement, chip, 'the selected chip takes focus');
  assert.equal(chipByLabel(h, 'camera').getAttribute('aria-current'), null);

  chipByLabel(h, 'warp2').querySelector('.chain-param-control').dispatch('click');
  assert.equal(h.store.selectedLabel(), 'warp2', 'a click inside the parameters keeps the selection');
  assert.deepEqual(h.selections, ['warp2']);
  assert.equal(chipByLabel(h, 'warp2').getAttribute('aria-current'), 'true');

  chipByLabel(h, 'warp2').dispatch('click');
  assert.equal(h.store.selectedLabel(), null);
  assert.deepEqual(h.selections, ['warp2', null]);
  const collapsed = chipByLabel(h, 'warp2');
  assert.equal(collapsed.classList.contains('chain-chip--expanded'), false);
  assert.equal(collapsed.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.activeElement, collapsed);
  collapsed.dispatch('focusin');
  collapsed.dispatch('mouseenter');
  assert.equal(collapsed.classList.contains('chain-chip--expanded'), false);

  chipByLabel(h, 'camera').dispatch('keydown', { key: 'Enter' });
  assert.deepEqual(h.selections, ['warp2', null, 'camera']);
  chipByLabel(h, 'camera').dispatch('keydown', { key: ' ' });
  assert.equal(h.store.selectedLabel(), null,
    'keyboard activation toggles selection like a click');
});

for (const [backward, forward] of [
  ['ArrowLeft', 'ArrowRight'], ['ArrowUp', 'ArrowDown'],
]) {
  test(`${backward}/${forward} rove focus without editing; Alt+Arrow moves the chip`, async () => {
    const h = await makeStrip();
    const next = chipByLabel(h, 'camera').dispatch('keydown', { key: forward });
    assert.equal(next.defaultPrevented, true);
    assert.equal(h.doc.activeElement.dataset.label, 'lens');
    assert.equal(h.doc.activeElement.getAttribute('tabindex'), '0');
    const previous = chipByLabel(h, 'lens').dispatch('keydown', { key: backward });
    assert.equal(previous.defaultPrevented, true);
    assert.equal(h.doc.activeElement.dataset.label, 'camera');
    assert.equal(h.doc.activeElement.getAttribute('tabindex'), '0');
    assert.deepEqual(h.applied, [], 'roving focus is not an edit');

    chipByLabel(h, 'lens').dispatch('keydown', { key: backward, altKey: true });
    assert.deepEqual(labels(h).slice(0, 2), ['lens', 'camera']);
    assert.equal(h.applied.length, 1);
    assert.equal(h.doc.activeElement.dataset.label, 'lens',
      'focus rides the moved chip across the rebuild');

    chipByLabel(h, 'lens').dispatch('keydown', { key: forward, altKey: true });
    assert.deepEqual(labels(h).slice(0, 2), ['camera', 'lens']);
    assert.equal(h.applied.length, 2);
  });
}

test('Alt+Arrow reorders only within the same carrier band', async () => {
  const h = await makeStrip();
  const untouched = ['camera', 'lens', 'project', 'warp2', 'sample', 'colorize'];

  chipByLabel(h, 'project').dispatch('keydown', { key: 'ArrowRight', altKey: true });
  assert.deepEqual(labels(h), untouched, 'a crossing has no reorder');

  chipByLabel(h, 'warp2').dispatch('keydown', { key: 'ArrowLeft', altKey: true });
  assert.deepEqual(labels(h), untouched, 'a band edge has no neighbour to swap with');
  assert.equal(chipByLabel(h, 'warp2').querySelector('.chain-chip-move'), null);

  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.announced, []);
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
  assert.deepEqual(entries.map((entry) => entry.dataset.operator).sort(),
    CATALOG.operators.filter((operator) => operator.input === 'sphere'
      && operator.output === 'plane').map((operator) => operator.id).sort(),
    'only the projection functions valid for this socket are shown');
  assert.equal(entries[0].dataset.remove, undefined);
  const bonne = entries.find((entry) => entry.dataset.operator === 'project.bonne.v3');
  assert.equal(bonne.getAttribute('aria-disabled'), null,
    'a same-pair operator is enabled');
  assert.equal(entries.find((entry) => entry.dataset.operator === 'sample.grid.v3'),
    undefined);
  assert.equal(h.doc.activeElement.dataset.operator, 'project.stereographic.v2',
    'focus moves to the palette\'s first enabled entry');

  h.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(paletteOf(h), null);
  assert.equal(h.doc.activeElement, chipByLabel(h, 'project'));
  assert.deepEqual(h.applied, []);

  const select = chipByLabel(h, 'project').querySelector('.chain-chip-replace');
  select.value = 'project.bonne.v3';
  select.dispatch('change');
  assert.equal(h.store.chain()[PROJECT].operator, 'project.bonne.v3');
  assert.equal(h.applied.length, 1);
  assert.equal(h.doc.activeElement,
    chipByLabel(h, h.store.chain()[PROJECT].label).querySelector('.chain-chip-replace'),
    'focus stays on the rebuilt socket select so arrow browsing can continue');
});

test('a palette carries its listbox selection on the focused option', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'project').dispatch('keydown', { key: 'Delete' });

  const entries = paletteEntries(h);
  const selection = () => entries.map((entry) => entry.getAttribute('aria-selected'));
  assert.deepEqual(selection(), entries.map((_, at) => String(at === 0)),
    'the opened palette selects the option it focused, and only that one');

  entries[0].dispatch('keydown', { key: 'ArrowDown' });
  entries[1].dispatch('keydown', { key: 'ArrowUp' });
  assert.deepEqual(selection(), entries.map((_, at) => String(at === 0)));
  entries[0].dispatch('keydown', { key: 'ArrowUp' });
  assert.deepEqual(selection(), entries.map((_, at) => String(at === 0)),
    'arrow navigation stops at the first option');
  entries[0].dispatch('keydown', { key: 'ArrowDown' });
  assert.deepEqual(selection(), entries.map((_, at) => String(at === 1)),
    'the selection follows the arrow-key focus');
});

test('Enter and Space insert and pin the palette choice without pointer activation', async () => {
  for (const key of ['Enter', ' ']) {
    const h = await makeStrip();
    bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
    const option = paletteEntries(h).find((entry) => entry.dataset.operator === 'sphere.lens.twist.v2');
    option.dispatch('keydown', {key});
    const inserted = h.store.chain().find((entry) => entry.operator === 'sphere.lens.twist.v2');
    assert.ok(inserted);
    assert.equal(h.applied.length, 1);
    assert.equal(h.store.selectedLabel(), inserted.label);
    assert.equal(chipByLabel(h, inserted.label).querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
    assert.equal(chipByLabel(h, inserted.label).classList.contains('chain-chip--expanded'), true);
    assert.equal(paletteOf(h), null);
  }
});

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
  assert.equal(h.doc.activeElement,
    chipByLabel(h, 'project').querySelector('.chain-chip-replace'));

  select = chipByLabel(h, 'project').querySelector('.chain-chip-replace');
  select.value = 'project.bonne.v3';
  select.dispatch('change');
  const after = h.store.document();
  assert.deepEqual(after.descriptor.chain[PROJECT],
    { label: 'project', operator: 'project.bonne.v3' },
    'a different operator retires the instance and seats a fresh one');
  assert.equal('project.singularity-fade' in after.preset_bank.presets[0].values, false,
    'the old instance parameter is removed');
  assert.equal(after.preset_bank.presets[0].values['project.central-meridian'], 0,
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
  assert.deepEqual(labels(h).slice(0, 3), ['camera', 'lens', 'lens1'],
    'the band + lands at the band\'s last gap');
  assert.equal(h.store.selectedLabel(), 'lens1',
    'the landed stage is selected, so its controls open on the insert');
  assert.equal(chipByLabel(h, 'lens1').getAttribute('aria-current'), 'true');
  assert.equal(chipByLabel(h, 'lens1')
    .classList.contains('chain-chip--expanded'), true);
  assert.deepEqual(h.selections, ['lens1']);
  assert.equal(h.applied.length, 1);

  chipByLabel(h, 'camera').dispatch('click');
  bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h).find((entry) => entry.dataset.operator === 'sphere.lens.glitch.v2')
    .dispatch('click');
  assert.deepEqual(labels(h).slice(0, 4), ['camera', 'lens', 'lens1', 'lens2'],
    'selection does not move the band + away from the last gap');
  assert.equal(h.store.chain()[3].operator, 'sphere.lens.glitch.v2');

  chipByLabel(h, 'camera').dispatch('keydown', { key: 'Insert' });
  assert.ok(paletteOf(h));
  entries = paletteEntries(h);
  assert.ok(entries.length > 0);
  const illegal = entries.find((entry) => entry.dataset.operator === 'warp.affine.v3');
  assert.equal(illegal, undefined, 'invalid stages are omitted instead of greyed out');
  const applied = h.applied.length;
  entries.find((entry) => entry.dataset.operator === 'sphere.lens.glitch.v2')
    .dispatch('click');
  assert.equal(h.store.chain()[0].label, 'camera');
  assert.equal(h.store.chain()[1].operator, 'sphere.lens.glitch.v2');
  assert.equal(h.store.chain()[2].label, 'lens');
  assert.equal(h.applied.length, applied + 1);
});

/**
 * @param {Object} h - A strip harness.
 * @param {number} width - Width every created element reports.
 * @returns {void}
 * @details Written as the box metrics the fake derives its whole rect from, so
 *   a measurement the module starts taking is answered rather than undefined.
 */
const measureNewElements = (h, width) => {
  h.doc.documentElement = { clientWidth: 1280 };
  h.doc.createElement = (/** @type {string} */ tag) => {
    const node = fakeElement(tag);
    node.offsetWidth = width;
    return node;
  };
};

test('a palette opens anchored to the control that opened it', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  Object.assign(add, { offsetLeft: 298, offsetTop: 32, offsetWidth: 20, offsetHeight: 20 });
  add.dispatch('click');
  assert.equal(paletteOf(h).style.left, '298px');
  assert.equal(paletteOf(h).style.top, '56px');
});

test('a palette near the right edge is clamped back inside the viewport', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  Object.assign(add, { offsetLeft: 1250, offsetTop: 32, offsetWidth: 40, offsetHeight: 20 });
  add.dispatch('click');
  assert.equal(paletteOf(h).style.left, '1064px',
    'clamped to the viewport width less the palette and its margin');
});

/**
 * Measures every created element at one unconstrained height, capped by the
 * max-height the strip writes: a max-height only ever shrinks a box.
 * @param {Object} h - A strip harness.
 * @param {number} height - The unconstrained height.
 * @returns {void}
 */
const measureNewHeights = (h, height) => {
  h.doc.createElement = (/** @type {string} */ tag) => {
    const node = fakeElement(tag);
    node.offsetWidth = 208;
    Object.defineProperty(node, 'offsetHeight', {
      get: () => Math.min(height, Number.parseFloat(node.style.maxHeight) || height),
    });
    return node;
  };
};

test('a palette near the bottom is lifted back inside the viewport', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  h.doc.documentElement.clientHeight = 300;
  measureNewHeights(h, 192);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  Object.assign(add, { offsetLeft: 20, offsetTop: 270, offsetHeight: 20 });
  add.dispatch('click');
  assert.equal(paletteOf(h).style.top, '100px');
  assert.equal(paletteOf(h).style.maxHeight, '192px');
  assert.equal(paletteOf(h).style.overflowY, 'auto');
});

test('a palette taller than the viewport is capped and scrolls', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  h.doc.documentElement.clientHeight = 300;
  measureNewHeights(h, 400);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  Object.assign(add, { offsetLeft: 20, offsetTop: 270, offsetHeight: 20 });
  add.dispatch('click');
  assert.equal(paletteOf(h).style.top, '8px');
  assert.equal(paletteOf(h).style.maxHeight, '284px',
    'the viewport height less both margins');
  assert.equal(paletteOf(h).style.overflowY, 'auto');
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

  chipByLabel(h, 'camera').querySelector('.chain-chip-rename')
    .dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(labels(h).length, 7);
  assert.equal(h.applied.length, 3,
    'text-field undo stays with the native input editor');

  // Ctrl+Z reaches the container's shortcut from any chip.
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(labels(h).length, 6);
  assert.equal(h.applied.length, 4);
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'y', ctrlKey: true });
  assert.equal(labels(h).length, 7);
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'z', metaKey: true });
  assert.equal(labels(h).length, 6);
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'z', ctrlKey: true, shiftKey: true });
  assert.equal(labels(h).length, 7);
  const selector = h.doc.createElement('select');
  const textArea = h.doc.createElement('textarea');
  for (const control of [selector, textArea]) {
    h.container.appendChild(control);
    control.dispatch('keydown', { key: 'z', ctrlKey: true });
    assert.equal(labels(h).length, 7);
  }
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

test('a bypass unavailable to the render is disabled, with the reason in text', async () => {
  let compiledSide = false;
  const h = await makeStrip({ bypassAvailable: () => !compiledSide });
  const bypasses = () => h.container.querySelectorAll('.chain-chip-bypass');
  assert.ok(bypasses().length >= 3);
  assert.deepEqual([...new Set(bypasses().map((node) => node.disabled))], [false]);
  assert.equal(h.container.querySelector('.chain-strip-note'), null);

  compiledSide = true;
  h.strip.render();
  assert.deepEqual([...new Set(bypasses().map((node) => node.disabled))], [true]);
  bypasses()[0].dispatch('click');
  assert.deepEqual(h.announced, [], 'the disabled toggle runs no handler at all');
  assert.deepEqual(h.store.bypassedLabels(), []);
  const note = h.container.querySelector('.chain-strip-note');
  assert.match(note.textContent, /^Bypass applies to the interpreter only:/);
  assert.deepEqual([...new Set(bypasses().map((node) => node.getAttribute('title')))],
    [note.textContent], 'the reason is text, not only a title');

  // 'b' reaches the chip, not the disabled button, so the gesture itself refuses.
  chipByLabel(h, 'lens').dispatch('keydown', { key: 'b' });
  assert.deepEqual(h.store.bypassedLabels(), []);
  assert.deepEqual(h.applied, [], 'no program re-apply for a refused bypass');
  assert.equal(lastAnnounced(h), note.textContent);

  compiledSide = false;
  h.strip.render();
  assert.deepEqual([...new Set(bypasses().map((node) => node.disabled))], [false]);
  assert.equal(h.container.querySelector('.chain-strip-note'), null);
  chipByLabel(h, 'lens').dispatch('keydown', { key: 'b' });
  assert.deepEqual(h.store.bypassedLabels(), ['lens']);
});

test('the strip roves between chips and exposes their controls to Tab', async () => {
  const h = await makeStrip();
  const strip = h.container.querySelector('.chain-strip');
  const headerControls = strip.querySelectorAll(
    '.chain-chip-bypass, .chain-chip-remove, .chain-chip-replace');
  assert.ok(headerControls.length >= 9);
  assert.deepEqual(
    [...new Set(headerControls.map((node) => node.getAttribute('tabindex')))], ['0'],
    'every chip header control is keyboard tabbable');
  assert.deepEqual(
    strip.querySelectorAll('.chain-chip').map((chip) => chip.getAttribute('tabindex'))
      .filter((value) => value !== '-1'),
    ['0'], 'exactly one chip carries the tab stop');

  chipByLabel(h, 'lens').dispatch('keydown', { key: 'b' });
  assert.deepEqual(h.applied.at(-1),
    ['camera', 'project', 'warp2', 'sample', 'colorize']);
  chipByLabel(h, 'lens').dispatch('keydown', { key: 'b' });
  assert.equal(h.applied.at(-1).includes('lens'), true);
});

test('a chip selects by click', async () => {
  const h = await makeStrip();
  assert.equal(h.store.selectedLabel(), null);

  chipByLabel(h, 'lens').dispatch('click');
  assert.equal(h.store.selectedLabel(), 'lens');
  assert.deepEqual(h.selections, ['lens'], 'the selection is announced once');
  assert.deepEqual(h.applied, [], 'a selection is no structural edit');
});

const rect = (top, height = 30, left = 10, width = 200) => ({
  top, bottom: top + height, left, right: left + width, width, height,
});
const dragGeometry = (h) => {
  const band = bandFor(h, 'sphere');
  band.getBoundingClientRect = () => rect(0, 140);
  for (const [label, top] of [['camera', 20], ['lens', 70]]) {
    const chip = chipByLabel(h, label);
    chip.getBoundingClientRect = () => rect(top);
    chip.querySelector('.chain-chip-header').getBoundingClientRect = () => rect(top, 20);
  }
  const viewport = h.container.querySelector('.chain-strip-viewport');
  viewport.getBoundingClientRect = () => rect(0, 200);
  viewport.clientHeight = viewport.scrollHeight = 200;
};
const dragPointer = (clientY, extra = {}) => ({
  clientX: 20, clientY, pointerId: 7, isPrimary: true, button: 0, ...extra,
});

test('stage headers replace reorder arrows with a drag surface', async () => {
  const h = await makeStrip();
  assert.equal(h.container.querySelector('.chain-chip-move'), null);
  for (const label of ['camera', 'lens']) {
    assert.equal(chipByLabel(h, label).querySelector('.chain-chip-header')
      .classList.contains('chain-chip-header--draggable'), true);
  }
  for (const label of ['project', 'warp2']) {
    assert.equal(chipByLabel(h, label).querySelector('.chain-chip-header')
      .classList.contains('chain-chip-header--draggable'), false);
  }
});

test('dragging a header reorders its stage before or after another in its band', async () => {
  for (const [label, from, to, markerClass] of [
    ['camera', 25, 100, 'chain-chip--drop-after'],
    ['lens', 75, 25, 'chain-chip--drop-before'],
  ]) {
    const h = await makeStrip();
    chipByLabel(h, 'camera').dispatch('click');
    dragGeometry(h);
    const chip = chipByLabel(h, label);
    const header = chip.querySelector('.chain-chip-header');
    header.dispatch('pointerdown', dragPointer(from));
    header.dispatch('pointermove', dragPointer(to));
    assert.equal(chip.classList.contains('chain-chip--dragging'), true);
    assert.equal(h.doc.activeElement, chip);
    assert.equal(h.container.querySelectorAll(`.${markerClass}`).length, 1);
    assert.equal(h.doc.body.querySelector('.chain-drag-preview').getAttribute('aria-hidden'), 'true');
    assert.deepEqual(labels(h).slice(0, 2), ['camera', 'lens']);
    header.dispatch('pointerup', dragPointer(to));
    assert.deepEqual(labels(h).slice(0, 2), ['lens', 'camera']);
    assert.equal(h.applied.length, 1);
    assert.equal(h.store.selectedLabel(), 'camera');
    assert.equal(chipByLabel(h, 'camera').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
    assert.equal(h.doc.activeElement.dataset.label, label);
    assert.equal(h.doc.body.querySelector('.chain-drag-preview'), null);
    assert.equal(h.container.querySelector(`.${markerClass}`), null);
    assert.equal(header.hasPointerCapture(7), false);
    header.dispatch('click');
    assert.equal(h.store.selectedLabel(), 'camera');
  }
});

test('a header press below the drag threshold still clicks to pin its tile', async () => {
  const h = await makeStrip();
  dragGeometry(h);
  const header = chipByLabel(h, 'camera').querySelector('.chain-chip-header');
  header.dispatch('pointerdown', dragPointer(25));
  header.dispatch('pointermove', dragPointer(27));
  header.dispatch('pointerup', dragPointer(27));
  assert.deepEqual(h.applied, []);
  assert.equal(h.doc.body.querySelector('.chain-drag-preview'), null);
  header.dispatch('click');
  assert.equal(chipByLabel(h, 'camera').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
});

test('header controls and parameters never start a stage drag', async () => {
  const h = await makeStrip();
  dragGeometry(h);
  const chip = chipByLabel(h, 'camera');
  const header = chip.querySelector('.chain-chip-header');
  for (const control of [chip.querySelector('.chain-chip-bypass'),
    chip.querySelector('.chain-chip-pin'), chip.querySelector('.chain-chip-remove'),
    chip.querySelector('.chain-param-control')]) {
    const down = control.dispatch('pointerdown', dragPointer(25));
    header.dispatch('pointermove', dragPointer(100));
    header.dispatch('pointerup', dragPointer(100));
    assert.equal(down.defaultPrevented, false);
    assert.equal(header.hasPointerCapture(7), false);
    assert.equal(h.doc.body.querySelector('.chain-drag-preview'), null);
  }
  assert.deepEqual(h.applied, []);
});

test('outside, same-position and cross-band drops leave the chain and pin unchanged', async () => {
  for (const position of [dragPointer(100, {clientX: 300}), dragPointer(-10),
    dragPointer(160), dragPointer(30), dragPointer(60)]) {
    const h = await makeStrip();
    dragGeometry(h);
    const chip = chipByLabel(h, 'camera');
    const header = chip.querySelector('.chain-chip-header');
    header.dispatch('pointerdown', dragPointer(25));
    header.dispatch('pointermove', position);
    assert.equal(h.container.querySelector('.chain-chip--drop-before, .chain-chip--drop-after'), null);
    header.dispatch('pointerup', position);
    assert.deepEqual(labels(h).slice(0, 2), ['camera', 'lens']);
    assert.deepEqual(h.applied, []);
    const click = header.dispatch('click');
    assert.equal(click.defaultPrevented, true);
    assert.equal(chip.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
    header.dispatch('pointerdown', dragPointer(25));
    header.dispatch('pointerup', dragPointer(25));
    header.dispatch('click');
    assert.equal(chipByLabel(h, 'camera').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  }
});

test('cancelling, rebuilding or destroying a dragged strip clears its preview and capture', async () => {
  for (const action of ['pointercancel', 'lostpointercapture', 'Escape', 'render', 'destroy']) {
    const h = await makeStrip();
    dragGeometry(h);
    const chip = chipByLabel(h, 'camera');
    const header = chip.querySelector('.chain-chip-header');
    header.dispatch('pointerdown', dragPointer(25));
    header.dispatch('pointermove', dragPointer(100));
    if (action === 'render' || action === 'destroy') h.strip[action]();
    else if (action === 'Escape') {
      assert.equal(chip.dispatch('keydown', {key: 'Escape'}).defaultPrevented, true);
      assert.equal(header.dispatch('click').defaultPrevented, true);
    } else header.dispatch(action, dragPointer(100));
    assert.equal(h.doc.body.querySelector('.chain-drag-preview'), null);
    assert.equal(chip.classList.contains('chain-chip--dragging'), false);
    assert.equal(header.hasPointerCapture(7), false);
    assert.deepEqual(h.applied, []);
    if (action !== 'destroy') {
      assert.equal(h.container.querySelector('.chain-chip--drop-before, .chain-chip--drop-after'), null);
    }
  }
});

test('a refused drag reports its legality failure and leaves the chain unchanged', async () => {
  const h = await makeStrip();
  dragGeometry(h);
  const header = chipByLabel(h, 'camera').querySelector('.chain-chip-header');
  h.store.replaceSpan = () => ({ok: false, diagnostics: [{message: 'move refused'}]});
  header.dispatch('pointerdown', dragPointer(25));
  header.dispatch('pointermove', dragPointer(100));
  header.dispatch('pointerup', dragPointer(100));
  assert.deepEqual(labels(h).slice(0, 2), ['camera', 'lens']);
  assert.equal(lastAnnounced(h), 'move refused');
  assert.deepEqual(h.applied, []);
  assert.equal(h.doc.body.querySelector('.chain-drag-preview'), null);
  assert.equal(header.dispatch('click').defaultPrevented, true);
});

test('a drag scrolls the pipeline near its edges and honors the final release position', async () => {
  const h = await makeStrip();
  dragGeometry(h);
  const viewport = h.container.querySelector('.chain-strip-viewport');
  viewport.scrollHeight = 500;
  viewport.scrollTop = 100;
  const header = chipByLabel(h, 'camera').querySelector('.chain-chip-header');
  header.dispatch('pointerdown', dragPointer(25));
  header.dispatch('pointermove', dragPointer(190));
  assert.equal(viewport.scrollTop, 124);
  runFrame();
  assert.equal(viewport.scrollTop, 148);
  runFrame();
  assert.equal(viewport.scrollTop, 172);
  header.dispatch('pointermove', dragPointer(5));
  assert.equal(viewport.scrollTop, 148);
  runFrame();
  assert.equal(viewport.scrollTop, 124);
  runFrame();
  assert.equal(viewport.scrollTop, 100);
  header.dispatch('pointermove', dragPointer(100));
  assert.equal(viewport.scrollTop, 100);
  header.dispatch('pointerup', dragPointer(100, {clientX: 300}));
  runFrame();
  assert.equal(viewport.scrollTop, 100);
  assert.deepEqual(h.applied, []);
});

test('a strip whose first render throws binds nothing to the mount', async () => {
  const store = await createChainDocumentStore({
    document: structuredClone(BASE.document), catalog: CATALOG });
  const container = fakeElement('section', { connected: true });
  let failing = true;
  const doc = installDocument({
    body: fakeElement('body', { connected: true }),
    activeElement: null,
    createElement: (/** @type {string} */ tag) => {
      if (failing && tag === 'button') throw new Error('render failed');
      return fakeElement(tag);
    },
    ...documentEvents(),
  });
  const build = () => createChainStrip({
    doc, container, store, catalog: CATALOG, announce: () => {}, onApply: () => {},
  });

  assert.throws(build, /render failed/);
  assert.deepEqual(container.listeners, [],
    'the mount outlives the strip, so a failed build may leave nothing on it');
  assert.equal(doc.listenerCount('pointerdown'), 0);
  assert.equal(doc.listenerCount('pointerup'), 0);
  assert.equal(doc.listenerCount('pointercancel'), 0);

  failing = false;
  build();
  assert.deepEqual(container.listeners.map((listener) => listener.type), ['keydown'],
    'the next successful build owns the only history shortcut');
  assert.equal(doc.listenerCount('pointerdown'), 1);
  assert.equal(doc.listenerCount('pointerup'), 0);
  assert.equal(doc.listenerCount('pointercancel'), 0);
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
  assert.equal(h.doc.listenerCount('pointerdown'), 0);
  assert.equal(h.doc.listenerCount('pointerup'), 0);
  assert.equal(h.doc.listenerCount('pointercancel'), 0);
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

test('stage controls ignore hover and toggle immediately with the pin button', async () => {
  const h = await makeStrip();
  assert.equal(chipByLabel(h, 'sample').getAttribute('aria-expanded'), null);
  assert.ok(paramsOf(h, 'sample'), 'an unselected chip carries its controls');

  const chip = chipByLabel(h, 'sample');
  assert.equal(chip.classList.contains('chain-chip--expanded'), false);

  chip.dispatch('mouseenter');
  assert.equal(chip.classList.contains('chain-chip--expanded'), false);
  chip.dispatch('mouseleave');
  assert.equal(chip.classList.contains('chain-chip--expanded'), false);

  chip.querySelector('.chain-chip-pin').dispatch('click');
  const pinned = chipByLabel(h, 'sample');
  assert.equal(pinned.classList.contains('chain-chip--expanded'), true);
  pinned.dispatch('mouseleave');
  assert.equal(pinned.classList.contains('chain-chip--expanded'), true,
    'mouse leave preserves a pinned card');
  pinned.querySelector('.chain-chip-pin').dispatch('click');
  assert.equal(chipByLabel(h, 'sample').classList.contains('chain-chip--expanded'), false);
  assert.equal(pinned.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');

  const region = paramsOf(h, 'sample');
  assert.equal(region.getAttribute('role'), 'group');
  assert.equal(region.getAttribute('aria-label'), 'Twin Wave Extended Drift · sample parameters');
  assert.deepEqual(rowsOf(h, 'sample').map((row) => row.dataset.parameter),
    h.store.parameterDeclarations().filter((parameter) =>
      parameter.id.startsWith('sample.')).map((parameter) => parameter.id),
    'authored declarations followed by undeclared catalog controls');
  assert.deepEqual(rowsOf(h, 'sample')
    .map((row) => row.querySelector('.chain-param-name').textContent),
  ['Angle Speed', 'Coverage Mode', 'Drift', 'Pattern Freq', 'Speed', 'Weight Mode', 'Edge Width'],
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
  assert.equal(rowsOf(h, 'camera').length, h.store.parameterDeclarations().filter(
    (parameter) => parameter.id.startsWith('camera.')).length);
});

test('Enter and Space toggle a tile while focus and Tab leave it collapsed', async () => {
  const h = await makeStrip();
  const initial = chipByLabel(h, 'sample');
  initial.focus();
  initial.dispatch('focusin');
  initial.dispatch('keydown', { key: 'Tab' });
  assert.equal(initial.classList.contains('chain-chip--expanded'), false);

  const enter = initial.dispatch('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  const opened = chipByLabel(h, 'sample');
  assert.equal(opened.classList.contains('chain-chip--expanded'), true);
  assert.equal(opened.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  assert.equal(h.store.selectedLabel(), 'sample');

  const space = opened.dispatch('keydown', { key: ' ' });
  assert.equal(space.defaultPrevented, true);
  const closed = chipByLabel(h, 'sample');
  assert.equal(closed.classList.contains('chain-chip--expanded'), false);
  assert.equal(closed.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.activeElement, closed);
  assert.equal(h.store.selectedLabel(), null);
});

test('a fixed stage expands to explain its parameters and allow renaming', async () => {
  const h = await makeStrip();
  bandFor(h, 'field').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h).find((entry) => entry.dataset.operator === 'field.transfer.ridge.v2')
    .dispatch('click');
  const label = h.store.chain()
    .find((entry) => entry.operator === 'field.transfer.ridge.v2').label;
  assert.deepEqual(declarationsFor(h, label), []);

  const chip = chipByLabel(h, label);
  assert.equal(chip.getAttribute('aria-current'), 'true');
  assert.equal(chip.classList.contains('chain-chip--expanded'), true);
  assert.equal(chip.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  assert.equal(paramsOf(h, label).querySelector('.chain-strip-note').textContent,
    'No adjustable parameters');
  assert.ok(paramsOf(h, label).querySelector('.chain-chip-rename'));
});

test('stage and socket pins are independent of selection and each other', async () => {
  const h = await makeStrip();
  for (const label of ['camera', 'project']) {
    const chip = chipByLabel(h, label);
    const pin = chip.querySelector('.chain-chip-pin');
    assert.equal(pin.getAttribute('aria-pressed'), 'false');
    assert.match(pin.getAttribute('aria-label'), /^Pin /);
    assert.equal(pin.querySelector('.chain-chip-pin-icon').getAttribute('aria-hidden'), 'true');
    pin.dispatch('click');
    assert.equal(pin.getAttribute('aria-pressed'), 'true');
    assert.match(pin.getAttribute('aria-label'), /^Unpin /);
    chip.dispatch('mouseleave');
    chip.dispatch('focusout');
    chip.dispatch('keydown', { key: 'Escape' });
  }
  assert.equal(h.store.selectedLabel(), null);
  chipByLabel(h, 'lens').dispatch('click');
  chipByLabel(h, 'lens').dispatch('mouseleave');
  assert.equal(chipByLabel(h, 'lens').classList.contains('chain-chip--expanded'), true);
  for (const label of ['camera', 'project']) {
    assert.equal(chipByLabel(h, label).classList.contains('chain-chip--expanded'), true);
  }
  const camera = chipByLabel(h, 'camera');
  camera.querySelector('.chain-chip-pin').dispatch('click');
  assert.equal(camera.classList.contains('chain-chip--expanded'), false);
  camera.dispatch('mouseleave');
  assert.equal(camera.classList.contains('chain-chip--expanded'), false);
  assert.equal(chipByLabel(h, 'project').classList.contains('chain-chip--expanded'), true);
});

test('pins survive reorder and rename and disappear with removed instances', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').querySelector('.chain-chip-pin').dispatch('click');
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'ArrowRight', altKey: true });
  assert.equal(chipByLabel(h, 'camera').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  const rename = chipByLabel(h, 'camera').querySelector('.chain-chip-rename');
  rename.value = 'renamed';
  rename.dispatch('change');
  assert.equal(chipByLabel(h, 'renamed').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  chipByLabel(h, 'renamed').querySelector('.chain-chip-remove').dispatch('click');
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.equal(chipByLabel(h, 'renamed').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
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

test('the numeric readout reads back as the binary32 it shows', async () => {
  const h = await makeStrip();
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const value = row.querySelector('.chain-param-value');

  // The engine stores binary32, so the readout a slider drag leaves behind is
  // what a later arrow-key nudge or re-entry is computed from.
  for (const authored of [3.14159274, 0.100000001, 1 / 3, 1e-7, 47.8000031]) {
    const stored = Math.fround(
      Math.min(Number(slider.max), Math.max(Number(slider.min), authored)));
    slider.value = String(stored);
    slider.dispatch('input');
    assert.equal(Math.fround(Number(value.value)), stored,
      `${value.value} must read back as ${stored}`);
  }

  // A value a shorter decimal already names keeps the shorter spelling.
  slider.value = '3.5';
  slider.dispatch('input');
  assert.equal(value.value, '3.5');
});

test('the readout carries no step grid and nudges by arrow key', async () => {
  const h = await makeStrip();
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const value = row.querySelector('.chain-param-value');
  const declared = declarationsFor(h, 'sample')
    .find((parameter) => parameter.id === 'sample.pattern-freq');
  const nudge = (declared.domain.maximum - declared.domain.minimum) / 1000;

  assert.equal(value.step, 'any',
    'a grid based at min would report stepMismatch on the stored value');

  const before = Number(value.value);
  assert.equal(value.dispatch('keydown', { key: 'ArrowUp' }).defaultPrevented, true);
  assert.equal(Math.fround(Number(value.value)), Math.fround(before + nudge));
  assert.equal(Math.fround(Number(slider.value)), Math.fround(before + nudge));
  assert.equal(h.edits.at(-1)[0], 'sample.pattern-freq');
  assert.equal(Math.fround(h.edits.at(-1)[1]), Math.fround(before + nudge));

  assert.equal(value.dispatch('keydown', { key: 'ArrowDown' }).defaultPrevented, true);
  assert.equal(Math.fround(Number(value.value)), Math.fround(before));

  const editsBefore = h.edits.length;
  const commitsBefore = h.commits.length;
  value.value = '5.5';
  assert.equal(value.dispatch('keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.equal(value.value, '5.5', 'other keys are left to the input');
  assert.equal(h.edits.length, editsBefore);
  assert.equal(h.commits.length, commitsBefore);
});

// A browser's number input reports content it cannot parse as the empty
// string, which is what the listener sees when an author types letters.
test('an unparsable numeric entry restores the stored value', async () => {
  const h = await makeStrip();
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const value = row.querySelector('.chain-param-value');
  const authored = value.value;
  const position = slider.value;

  value.value = '';
  value.dispatch('change');

  assert.equal(value.value, authored);
  assert.equal(slider.value, position);
  assert.deepEqual(h.edits, []);
});

const renameIn = (h, label) =>
  paramsOf(h, label).querySelector('.chain-chip-rename');

test('a chip renames its instance through the store', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'warp2').dispatch('click');
  const field = renameIn(h, 'warp2');
  assert.equal(field.value, 'warp2');

  field.value = ' mirror ';
  field.dispatch('change');

  assert.equal(labels(h)[3], 'mirror');
  assert.equal(h.store.selectedLabel(), 'mirror', 'the selection follows the rename');
  assert.ok(h.store.document().descriptor.parameters.some(
    (parameter) => parameter.id === 'mirror.rotation'));
  assert.equal(h.applied.length, 1, 'the program is re-applied under the new ids');
  assert.equal(renameIn(h, 'mirror').value, 'mirror');
});

test('a refused rename reports and restores the field', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'warp2').dispatch('click');
  const field = renameIn(h, 'warp2');

  field.value = 'Not.Valid';
  field.dispatch('change');

  assert.equal(field.value, 'warp2');
  assert.equal(labels(h)[3], 'warp2');
  assert.match(lastAnnounced(h), /kebab-case/);

  field.value = 'sample';
  field.dispatch('change');
  assert.equal(labels(h)[3], 'warp2');
  assert.match(lastAnnounced(h), /already carries/);
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

// The page writes every inline edit under the control's coalesce key so a
// slider drag undoes whole; a discrete control's change is a whole gesture.
test('a chosen option and an entered value each close the coalesced value run', async () => {
  const h = await makeStrip({ writeThrough: true });
  const stored = (id) => h.store.document().preset_bank.presets[0].values[id];

  for (const value of ['octahedral', 'tetrahedral']) {
    const select = controlIn(rowFor(h, 'lens', 'lens.symmetry'));
    select.value = value;
    select.dispatch('change');
  }
  assert.deepEqual(h.commits, [1, 2], 'each choice completes an edit');
  assert.equal(h.store.undo(), true);
  assert.equal(stored('lens.symmetry'), 'octahedral',
    'one Undo reverts one choice, not every choice since the strip was built');

  for (const value of ['5.5', '6']) {
    const readout = rowFor(h, 'sample', 'sample.pattern-freq')
      .querySelector('.chain-param-value');
    readout.value = value;
    readout.dispatch('change');
  }
  assert.deepEqual(h.commits, [1, 2, 3, 4]);
  assert.equal(h.store.undo(), true);
  assert.equal(stored('sample.pattern-freq'), 5.5,
    'one Undo reverts one entered value');
});

// The union schema survives — a field the topology deactivates is
// dimmed, but present and editable, because the document still carries it.
test('a deactivated field renders dimmed but editable', async () => {
  const h = await makeStrip();
  bandFor(h, 'plane').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h).find((entry) => entry.dataset.operator === 'warp.wave-shear.v2')
    .dispatch('click');
  const label = h.store.chain()
    .find((entry) => entry.operator === 'warp.wave-shear.v2').label;
  chipByLabel(h, label).dispatch('click');

  const edge = rowFor(h, label, `${label}.edge-width`);
  assert.equal(edge.dataset.deactivated, 'true',
    'the envelope gate opens on flat, which reads no edge width');
  // A `display: contents` row hangs no tooltip, so the reason is a node the
  // control describes itself by.
  const note = edge.querySelector('.chain-param-note');
  assert.equal(note.textContent, 'Deactivated by the current topology selection');
  assert.equal(controlIn(edge).getAttribute('aria-describedby'), note.id);
  assert.equal(controlIn(edge).disabled, false, 'dimmed, not disabled');
  assert.equal(rowFor(h, label, `${label}.strength`).dataset.deactivated, undefined);

  const envelope = controlIn(rowFor(h, label, `${label}.envelope`));
  envelope.value = 'edge-fade';
  envelope.dispatch('change');

  assert.equal(edge.dataset.deactivated, undefined,
    'the gate moving onto edge-fade re-activates the field in place');
  assert.equal(edge.querySelector('.chain-param-note'), null);
  assert.equal(controlIn(edge).getAttribute('aria-describedby'), null);

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

test('the Color card groups noise controls and hides unused source and topology fields', async () => {
  const h = await makeStrip({ writeThrough: true });
  const groups = () => paramsOf(h, 'colorize').querySelectorAll('.chain-param-group');
  assert.deepEqual(groups().filter((group) => !group.hidden)
    .map((group) => group.getAttribute('aria-label')),
  ['Palette', 'Modulation', 'Noise', 'Color mapping', 'Hue shift', 'Brightness & opacity']);
  const scale = rowFor(h, 'colorize', 'colorize.pattern-scale');
  const speed = rowFor(h, 'colorize', 'colorize.pattern-speed');
  assert.equal(scale.parentNode.getAttribute('aria-label'), 'Noise');
  assert.equal(controlIn(scale).getAttribute('aria-label'), 'Noise scale (frequency)');
  assert.equal(controlIn(speed).getAttribute('aria-label'), 'Noise speed');
  for (const field of ['pattern-scale', 'pattern-speed', 'pattern-noise-variant'])
    assert.equal(rowFor(h, 'colorize', `colorize.${field}`).hidden, false, field);
  for (const field of ['sine-frequency', 'interference-frequency', 'grid-frequency',
    'hue-shift-amount', 'brightness-bottom', 'brightness-top', 'pattern-contrast', 'pattern-noise-basis']) {
    const row = rowFor(h, 'colorize', `colorize.${field}`);
    assert.equal(row.hidden, true, field);
    assert.equal(row.querySelector('.chain-param-note'), null, field);
  }
  for (const [field, value] of [['pattern-scale', '2'], ['pattern-speed', '0.0004']]) {
    const control = controlIn(rowFor(h, 'colorize', `colorize.${field}`));
    control.value = value;
    control.dispatch('input');
    control.dispatch('change');
    assert.equal(h.store.document().preset_bank.presets[0].values[`colorize.${field}`],
      Number(value));
  }
});

test('Color source changes reveal only their own controls and preserve hidden values through undo', async () => {
  const h = await makeStrip({ writeThrough: true });
  const edit = (field, value) => {
    const control = controlIn(rowFor(h, 'colorize', `colorize.${field}`));
    control.value = value;
    control.dispatch('change');
  };
  const noiseScale = controlIn(rowFor(h, 'colorize', 'colorize.pattern-scale')).value;
  for (const [source, shown, hidden] of [
    ['directional-sine', 'sine-frequency', 'interference-frequency'],
    ['sphere-interference', 'interference-frequency', 'grid-frequency'],
    ['sphere-smooth-grid', 'grid-frequency', 'sine-frequency'],
    ['noise', 'pattern-scale', 'interference-frequency'],
  ]) {
    edit('modulation-source', source);
    assert.equal(rowFor(h, 'colorize', `colorize.${shown}`).hidden, false);
    assert.equal(rowFor(h, 'colorize', `colorize.${hidden}`).hidden, true);
  }
  assert.equal(controlIn(rowFor(h, 'colorize', 'colorize.pattern-scale')).value, noiseScale);
  edit('modulation-enabled', 'disabled');
  assert.equal(rowFor(h, 'colorize', 'colorize.modulation-enabled').hidden, false);
  assert.equal(rowFor(h, 'colorize', 'colorize.modulation-source').hidden, true);
  assert.equal(rowFor(h, 'colorize', 'colorize.pattern-scale').hidden, true);
  assert.equal(h.store.undo(), true);
  h.strip.render();
  assert.equal(rowFor(h, 'colorize', 'colorize.pattern-scale').hidden, false);
  assert.equal(controlIn(rowFor(h, 'colorize', 'colorize.pattern-scale')).value, noiseScale);
  edit('pattern-noise-variant', 'octave-contour');
  assert.equal(rowFor(h, 'colorize', 'colorize.pattern-contrast').hidden, false);
  assert.equal(rowFor(h, 'colorize', 'colorize.pattern-noise-basis').hidden, false);
  edit('hue-shift-mode', 'path-length');
  edit('brightness-envelope', 'bell');
  for (const field of ['hue-shift-amount', 'brightness-bottom', 'brightness-top'])
    assert.equal(rowFor(h, 'colorize', `colorize.${field}`).hidden, false);
});

test('Noise scale follows the sampling limit without replacing its controls', async () => {
  const h = await makeStrip({ writeThrough: true });
  const row = rowFor(h, 'colorize', 'colorize.pattern-scale');
  const slider = controlIn(row);
  const readout = row.querySelector('.chain-param-value');
  assert.equal(slider.max, '8');
  assert.equal(readout.max, '8');
  readout.value = '20';
  readout.dispatch('change');
  assert.equal(h.store.document().preset_bank.presets[0].values['colorize.pattern-scale'], 8);
  const evaluation = controlIn(rowFor(h, 'colorize', 'colorize.modulation-evaluation'));
  evaluation.value = 'direct';
  evaluation.dispatch('change');
  assert.equal(slider.max, '64');
  assert.equal(readout.max, '64');
  slider.value = '32';
  slider.dispatch('input');
  slider.dispatch('change');
  assert.equal(h.store.document().preset_bank.presets[0].values['colorize.pattern-scale'], 32);
  assert.ok(controlIn(rowFor(h, 'colorize', 'colorize.pattern-scale')) === slider);
});

test('modulation strength follows the selected mechanic range', async () => {
  const h = await makeStrip();
  const amount = rowFor(h, 'colorize', 'colorize.modulation-amount');
  const control = controlIn(rowFor(h, 'colorize', 'colorize.modulation-mechanic'));
  for (const [mechanic, minimum, maximum] of [
    ['opacity', '0', '1'], ['positive-lightness-lift', '0', '1'], ['hue-rotation', '-4', '4'],
  ]) {
    control.value = mechanic;
    control.dispatch('change');
    assert.equal(controlIn(amount).min, minimum);
    assert.equal(controlIn(amount).max, maximum);
    assert.equal(amount.querySelector('.chain-param-value').max, maximum);
  }
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
    { id: 'colorize.pattern-scale', storage: 'binary32' },
    { id: 'colorize.pattern-speed', storage: 'binary32' },
    { id: 'colorize.brightness-envelope', storage: 'enum8' },
    { id: 'colorize.brightness-bottom', storage: 'binary32' },
    { id: 'colorize.brightness-top', storage: 'binary32' },
  ];
  const values = {
    'sample.coverage-mode': 'weight',
    'sample.edge-width': 0.1,
    'warp1.envelope': 'edge-fade',
    'warp1.edge-width': 0.1,
    'camera.wander': 0,
    'colorize.hue-shift-mode': 'path-length',
    'colorize.hue-shift-amount': 1,
    'colorize.pattern-scale': 1,
    'colorize.pattern-speed': 0,
    'colorize.brightness-envelope': 'none',
    'colorize.brightness-bottom': 0,
    'colorize.brightness-top': 1,
  };
  const chain = [
    { label: 'sample', operator: 'sample.grid.v3' },
    { label: 'warp1', operator: 'warp.wave-shear.v2' },
    { label: 'camera', operator: 'sphere.rotate.v2' },
    { label: 'colorize', operator: 'colorize.generated-palette.v3' },
  ];
  assert.deepEqual([...deactivatedParameterIds(parameters, values, chain, CATALOG)],
    ['sample.edge-width', 'colorize.brightness-bottom',
      'colorize.brightness-top']);
  assert.deepEqual([...deactivatedParameterIds(
    [{ id: 'sample.edge-width', storage: 'binary32' }],
    { 'sample.edge-width': 0.1 }, chain, CATALOG)],
  [], 'an unset gate field deactivates nothing');
});

test('parameter gate predicates match every catalog live value', () => {
  const gates = CATALOG.operators.flatMap(operator => operator.params
    .filter(parameter => parameter.gated_by)
    .map(parameter => ({ operator, parameter })));
  assert.ok(gates.length > 0);
  for (const { operator, parameter } of gates) {
    const gate = parameter.gated_by;
    const choices = operator.params.find(candidate => candidate.id === gate.field).values;
    const active = choices.filter((value) => {
      const result = deactivatedParameterIds([{ id: `stage.${parameter.id}` }],
        { [`stage.${gate.field}`]: value }, [{ label: 'stage', operator: operator.id }], CATALOG);
      return !result.has(`stage.${parameter.id}`);
    });
    assert.deepEqual(active, gate.values, `${operator.id}.${parameter.id}`);
  }
});


test('arrow nudges finish independent undo entries', async () => {
  const h = await makeStrip({ writeThrough: true });
  const stored = () => h.store.document().preset_bank.presets[0].values['sample.pattern-freq'];
  const initial = stored();
  const readout = () => rowFor(h, 'sample', 'sample.pattern-freq').querySelector('.chain-param-value');
  readout().dispatch('keydown', { key: 'ArrowUp' });
  const once = stored();
  readout().dispatch('keydown', { key: 'ArrowUp' });
  assert.notEqual(stored(), once);
  assert.equal(h.store.undo(), true);
  assert.equal(stored(), once);
  assert.equal(h.store.undo(), true);
  assert.equal(stored(), initial);
  assert.deepEqual(h.commits, [1, 2]);
});


test('band insertion buttons expose the open palette state', async () => {
  const h = await makeStrip();
  const add = h.container.querySelector('.chain-band-add');
  assert.equal(add.getAttribute('aria-expanded'), 'false');
  add.dispatch('click');
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  add.dispatch('pointerdown');
  add.dispatch('click');
  assert.equal(add.getAttribute('aria-expanded'), 'false');
  assert.equal(paletteOf(h), null);
  add.dispatch('click');
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  h.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(add.getAttribute('aria-expanded'), 'false');
});


test('omitted catalog fields display defaults and become undoable document edits', async () => {
  const h = await makeStrip({ writeThrough: true });
  const before = h.store.document();
  const digest = h.store.compile().descriptor_digest;
  const declaration = h.store.parameterDeclarations().find((parameter) =>
    !before.descriptor.parameters.some((authored) => authored.id === parameter.id));
  assert.ok(declaration);
  const label = declaration.id.split('.')[0];
  chipByLabel(h, label).dispatch('click');
  const row = rowsOf(h, label).find((row) => row.dataset.parameter === declaration.id);
  const readout = row.querySelector('.chain-param-value');
  assert.equal(Number(readout.value), Number(declaration.default));
  assert.deepEqual(h.store.document(), before);
  assert.equal(h.store.compile().descriptor_digest, digest);
  assert.equal(h.store.canUndo(), false);
  readout.value = String(declaration.domain.maximum);
  readout.dispatch('change');
  assert.equal(h.store.document().preset_bank.presets[0].values[declaration.id],
    declaration.domain.maximum);
  h.strip.syncHistory();
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(h.store.document(), before);
  assert.equal(h.store.compile().descriptor_digest, digest);
});


test('every catalog operator exposes its full schema in a declaration-free stage', async () => {
  const crossings = CATALOG.carriers.slice(0, -1).map((carrier, index) =>
    CATALOG.operators.find((operator) => operator.input === carrier
      && operator.output === CATALOG.carriers[index + 1]));
  for (const operator of CATALOG.operators) {
    const prefix = crossings.slice(0, CATALOG.carriers.indexOf(operator.input));
    const suffix = crossings.slice(CATALOG.carriers.indexOf(operator.output));
    const chain = [...prefix, operator, ...suffix].map((stage, index) => ({
      label: index === prefix.length ? 'audit' : `stage${index}`, operator: stage.id,
    }));
    const source = scratchChainDocument(CATALOG, chain);
    source.descriptor.parameters = source.descriptor.parameters.filter(
      (parameter) => !parameter.id.startsWith('audit.'));
    source.descriptor.serialization.fields = source.descriptor.parameters.map(
      (parameter) => parameter.id);
    for (const preset of source.preset_bank.presets)
      for (const id of Object.keys(preset.values))
        if (id.startsWith('audit.')) delete preset.values[id];
    const h = await makeStrip({ source });
    chipByLabel(h, 'audit').dispatch('click');
    assert.deepEqual(rowsOf(h, 'audit').map((row) => row.dataset.parameter).sort(),
      operator.params.map((field) => `audit.${field.id}`).sort(), operator.name);
    for (const field of operator.params) {
      const control = controlIn(rowFor(h, 'audit', `audit.${field.id}`));
      const value = control.type === 'checkbox' ? (control.checked ? 'on' : 'off') : control.value;
      assert.equal(String(value), String(field.default), `${operator.name}: ${field.id}`);
    }
    if (operator.params.length === 0)
      assert.equal(paramsOf(h, 'audit').querySelector('.chain-strip-note').textContent,
        'No adjustable parameters');
    assert.deepEqual(h.store.document(), source);
    assert.equal(h.store.canUndo(), false);
    h.strip.destroy();
  }
});

test('parameters baked into the active build cannot commit edits', async () => {
  const h = await makeStrip({ parameterLive: (id) => id !== 'sample.coverage-mode' });
  const row = rowFor(h, 'sample', 'sample.coverage-mode');
  const select = controlIn(row);
  assert.equal(select.disabled, true);
  assert.match(row.querySelector('.chain-param-note').textContent, /baked into the compiled build/);
  select.disabled = false;
  select.value = 'weight';
  select.dispatch('change');
  assert.deepEqual(h.edits, []);
  assert.equal(controlIn(rowFor(h, 'sample', 'sample.pattern-freq')).disabled, false);
});


test('header collapse stays closed while focus and the pointer remain on the tile', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const opened = chipByLabel(h, 'sample');
  opened.dispatch('mouseenter');
  const readout = rowFor(h, 'sample', 'sample.pattern-freq').querySelector('.chain-param-value');
  readout.focus();
  readout.dispatch('focusin');
  opened.querySelector('.chain-chip-header').dispatch('click');
  const closed = chipByLabel(h, 'sample');
  assert.equal(closed.classList.contains('chain-chip--expanded'), false);
  assert.equal(closed.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.activeElement, closed);
  closed.dispatch('focusin');
  closed.dispatch('mouseenter');
  closed.dispatch('keydown', { key: 'Tab' });
  assert.equal(closed.classList.contains('chain-chip--expanded'), false);
});

test('parameter and header controls keep a tile pinned without selecting it again', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const chip = chipByLabel(h, 'sample');
  const control = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  control.dispatch('click');
  control.dispatch('keydown', { key: 'Enter' });
  control.dispatch('keydown', { key: ' ' });
  assert.equal(chipByLabel(h, 'sample'), chip);
  assert.equal(chip.classList.contains('chain-chip--expanded'), true);
  assert.equal(chip.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.selections, ['sample']);

  chipByLabel(h, 'camera').dispatch('click');
  chipByLabel(h, 'camera').querySelector('.chain-chip-bypass').dispatch('click');
  assert.equal(chipByLabel(h, 'camera').classList.contains('chain-chip--expanded'), true);
  assert.equal(h.store.selectedLabel(), 'camera');
  assert.deepEqual(h.selections, ['sample', 'camera']);
  const socket = chipByLabel(h, 'project');
  socket.querySelector('.chain-chip-replace').dispatch('click');
  assert.equal(socket.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(h.store.selectedLabel(), 'camera');
});

test('pointer exits, focus changes and outside presses preserve clicked tiles', async () => {
  const h = await makeStrip();
  for (const label of ['camera', 'sample']) chipByLabel(h, label).dispatch('click');
  const chip = chipByLabel(h, 'sample');
  const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  h.doc.dispatch('pointerdown', { target: slider, button: 0, pointerId: 5 });
  slider.focus();
  slider.dispatch('focusin');
  chip.dispatch('mouseleave');
  h.doc.dispatch('pointerup', { pointerId: 5 });
  h.doc.dispatch('pointercancel', { pointerId: 5 });
  h.doc.dispatch('pointerdown', { target: h.doc.body });
  slider.dispatch('focusout', { relatedTarget: chipByLabel(h, 'colorize') });
  chip.dispatch('keydown', { key: 'Escape' });
  for (const label of ['camera', 'sample']) {
    assert.equal(chipByLabel(h, label).classList.contains('chain-chip--expanded'), true);
    assert.equal(chipByLabel(h, label).querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  }
});

test('synchronized parameter values update mounted controls without changing pins', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const chip = chipByLabel(h, 'sample');
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const control = controlIn(row);
  h.strip.syncParameterValues({'sample.pattern-freq': 5.5, 'absent.parameter': 2});
  assert.equal(control.value, '5.5');
  assert.equal(row.querySelector('.chain-param-value').value, '5.5');
  assert.equal(chipByLabel(h, 'sample'), chip);
  assert.equal(chip.classList.contains('chain-chip--expanded'), true);
  assert.equal(chip.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.edits, []);
});

test('separate slider drags form separate undo entries', async () => {
  const h = await makeStrip({ writeThrough: true });
  for (const value of ['5.5', '6']) {
    const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
    slider.value = value;
    slider.dispatch('input');
    slider.dispatch('change');
  }
  assert.deepEqual(h.commits, [1, 2]);
  assert.equal(h.store.undo(), true);
  assert.equal(h.store.document().preset_bank.presets[0].values['sample.pattern-freq'], 5.5);
});

test('a refused slider edit closes its undo gesture before replacing the control', async () => {
  let accepted = true;
  const h = await makeStrip({writeThrough: true, acceptParameter: () => accepted});
  const drag = (value) => {
    const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
    slider.value = String(value);
    slider.dispatch('input');
    runFrame();
    return slider;
  };
  drag(5.5);
  accepted = false;
  drag(6);
  accepted = true;
  drag(7).dispatch('change');
  assert.equal(h.store.undo(), true);
  assert.equal(h.store.document().preset_bank.presets[0].values['sample.pattern-freq'], 5.5);
});

test('a refused socket replacement restores the selected operator', async () => {
  const h = await makeStrip();
  const before = h.store.document();
  h.store.replaceSpan = () => ({ ok: false, diagnostics: [{ message: 'catalog refused edit' }] });
  const select = chipByLabel(h, 'project').querySelector('.chain-chip-replace');
  select.value = 'project.bonne.v3';
  select.dispatch('change');
  assert.equal(select.value, 'project.stereographic.v2');
  assert.deepEqual(h.store.document(), before);
  assert.equal(h.applied.length, 0);
  assert.equal(lastAnnounced(h), 'catalog refused edit');
});

test('band insertion closes after pointer focusout and retains keyboard toggles', async () => {
  for (const target of ['anchor', 'null']) {
    const h = await makeStrip();
    const add = h.container.querySelector('.chain-band-add');
    add.dispatch('click');
    const option = h.doc.activeElement;
    add.dispatch('pointerdown');
    option.dispatch('focusout', {relatedTarget: target === 'anchor' ? add : null});
    add.dispatch('click');
    assert.equal(add.getAttribute('aria-expanded'), 'false', target);
    assert.equal(paletteOf(h), null);
    add.dispatch('click');
    assert.equal(add.getAttribute('aria-expanded'), 'true', 'keyboard click clears the pointer decision');
    h.doc.activeElement.dispatch('focusout', {relatedTarget: add});
    add.dispatch('click');
    assert.equal(add.getAttribute('aria-expanded'), 'false');
  }
});

test('loaded twist and glitch stages expose omitted controls and persist slider edits', async () => {
  const source = scratchChainDocument(CATALOG, [
    { label: 'twist', operator: 'sphere.lens.twist.v2' },
    { label: 'glitch', operator: 'sphere.lens.glitch.v2' },
    { label: 'project', operator: 'project.stereographic.v2' },
    { label: 'sample', operator: 'sample.grid.v3' },
    { label: 'color', operator: 'colorize.generated-palette.v3' },
  ]);
  const controls = [
    ['twist', 'twist-rate', 3, 4.5],
    ['twist', 'speed', 0.02, 0.035],
    ['glitch', 'polar-multiplier', 2, 4],
    ['glitch', 'azimuth-multiplier', 3, -2],
  ];
  const omitted = controls.map(([label, field]) => `${label}.${field}`);
  source.descriptor.parameters = source.descriptor.parameters.filter(
    (parameter) => !omitted.includes(parameter.id));
  source.descriptor.serialization.fields = source.descriptor.parameters.map(
    (parameter) => parameter.id);
  for (const preset of source.preset_bank.presets)
    for (const id of omitted) delete preset.values[id];
  const h = await makeStrip({ source, writeThrough: true });
  assert.deepEqual(h.store.document(), source);
  for (const [label, field, initial, value] of controls) {
    chipByLabel(h, label).dispatch('click');
    const id = `${label}.${field}`;
    const slider = controlIn(rowFor(h, label, id));
    assert.equal(slider.type, 'range');
    assert.equal(Number(slider.value), initial);
    slider.value = String(value);
    slider.dispatch('input');
    runFrame();
    assert.deepEqual(h.edits.at(-1), [id, value]);
    assert.equal(h.store.document().preset_bank.presets[0].values[id], value);
    assert.ok(h.store.document().descriptor.parameters.some((parameter) => parameter.id === id));
  }
  assert.equal(h.edits.length, 4);
  assert.deepEqual(h.applied, []);
  assert.equal(h.store.compile().status, 'VALID');
});

test('Ripple random center toggles manual coordinates and follows synchronized values', async () => {
  const source = scratchChainDocument(CATALOG, [
    { label: 'ripple', operator: 'sphere.displace.ripple.v2' },
    { label: 'sample', operator: 'sample.spherical-rings.v3' },
    { label: 'color', operator: 'colorize.generated-palette.v3' },
  ]);
  const h = await makeStrip({ source, writeThrough: true });
  chipByLabel(h, 'ripple').dispatch('click');
  const toggle = controlIn(rowFor(h, 'ripple', 'ripple.random-center'));
  const azimuth = rowFor(h, 'ripple', 'ripple.center-azimuth');
  const polar = rowFor(h, 'ripple', 'ripple.center-polar');
  assert.equal(toggle.type, 'checkbox');
  assert.equal(toggle.checked, true);
  assert.equal(azimuth.hidden, true);
  assert.equal(polar.hidden, true);
  toggle.checked = false;
  toggle.dispatch('change');
  assert.deepEqual(h.edits.at(-1), ['ripple.random-center', 'off']);
  assert.equal(azimuth.hidden, false);
  assert.equal(polar.hidden, false);
  h.strip.syncParameterValues({'ripple.random-center': 'on'});
  assert.equal(toggle.checked, true);
  assert.equal(azimuth.hidden, true);
  assert.equal(polar.hidden, true);
  assert.equal(h.store.compile().status, 'VALID');
});
