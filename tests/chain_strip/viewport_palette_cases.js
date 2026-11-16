import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeElement } from ".././helpers/fake_dom.js";
import { CATALOG, BASE, makeStrip, chipByLabel, bandFor, paletteOf, paletteEntries, labels } from ".././helpers/chain_strip_harness.js";
import { PROJECT, measureNewElements, measureNewHeights } from "./fixture.js";

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
  const step = viewport.scrollTop;
  assert.ok(step > 0 && step < viewport.clientHeight,
    'a scroll step advances by less than a viewport');
  buttons[0].dispatch('click');
  assert.equal(viewport.scrollTop, 0);

  const horizontal = viewport.dispatch('wheel', { deltaX: 120, deltaY: 0 });
  assert.equal(viewport.scrollTop, 0);
  assert.equal(horizontal.defaultPrevented, false);
  const wheel = viewport.dispatch('wheel', { deltaX: 0, deltaY: 120 });
  assert.equal(viewport.scrollTop, 120);
  assert.equal(wheel.defaultPrevented, true);

  const down = viewport.dispatch('keydown', { key: 'ArrowDown' });
  assert.equal(viewport.scrollTop, 120 + step);
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
  assert.ok(viewport.scrollTop > 3 && viewport.scrollTop < viewport.clientHeight,
    'a line-mode notch is not 3 pixels');
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

test('wheel events over the operator palette remain available to its own scroll list', async () => {
  const h = await makeStrip();
  const viewport = h.container.querySelector('.chain-strip-viewport');
  viewport.clientHeight = 400;
  viewport.scrollHeight = 1600;
  viewport.scrollTop = 50;
  const palette = fakeElement('div');
  palette.className = 'chain-palette';
  const entry = fakeElement('button');
  palette.appendChild(entry);
  viewport.appendChild(palette);
  const wheel = viewport.dispatch('wheel', { target: entry, deltaY: 120 });
  assert.equal(viewport.scrollTop, 50);
  assert.equal(wheel.defaultPrevented, false);
});

test('scrolling the strip closes its open operator palette', async () => {
  const h = await makeStrip();
  const viewport = h.container.querySelector('.chain-strip-viewport');
  viewport.clientHeight = 400;
  viewport.scrollHeight = 1600;
  bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
  assert.ok(paletteOf(h));

  viewport.dispatch('wheel', { deltaY: 120 });
  assert.equal(paletteOf(h), null);
});

test('window resize closes the operator palette', async () => {
  const h = await makeStrip();
  bandFor(h, 'sphere').querySelector('.chain-band-add').dispatch('click');
  assert.ok(paletteOf(h));

  h.doc.defaultView.dispatch('resize');
  assert.equal(paletteOf(h), null);
});

test('destroying the strip removes its window resize listener', async () => {
  const h = await makeStrip();
  assert.equal(h.doc.defaultView.listenerCount('resize'), 1);
  h.strip.destroy();
  assert.equal(h.doc.defaultView.listenerCount('resize'), 0);
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
  assert.equal(chipByLabel(h, 'warp2').getAttribute('aria-current'), 'true');

  chipByLabel(h, 'warp2').dispatch('click');
  assert.equal(h.store.selectedLabel(), null);
  const collapsed = chipByLabel(h, 'warp2');
  assert.equal(collapsed.classList.contains('chain-chip--expanded'), false);
  assert.equal(collapsed.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.activeElement, collapsed);
  collapsed.dispatch('focusin');
  collapsed.dispatch('mouseenter');
  assert.equal(collapsed.classList.contains('chain-chip--expanded'), false);

  chipByLabel(h, 'camera').dispatch('keydown', { key: 'Enter' });
  assert.equal(h.store.selectedLabel(), 'camera');
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
  const untouched = ['camera', 'lens', 'project', 'warp2', 'sample', 'colorize', 'modulation'];

  chipByLabel(h, 'project').dispatch('keydown', { key: 'ArrowRight', altKey: true });
  assert.deepEqual(labels(h), untouched, 'a crossing has no reorder');

  chipByLabel(h, 'warp2').dispatch('keydown', { key: 'ArrowLeft', altKey: true });
  assert.deepEqual(labels(h), untouched, 'a band edge has no neighbour to swap with');

  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.announced, []);
});

test('× and Delete remove an endomorphism and re-apply the program', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'lens').dispatch('click');
  chipByLabel(h, 'lens').querySelector('.chain-chip-remove').dispatch('click');

  assert.deepEqual(labels(h),
    ['camera', 'project', 'warp2', 'sample', 'colorize', 'modulation']);
  assert.deepEqual(h.applied,
    [['camera', 'project', 'warp2', 'sample', 'colorize', 'modulation']]);
  assert.equal(h.doc.activeElement.dataset.label, 'project',
    'focus lands on the chip that filled the removed slot');
  assert.equal(h.store.selectedLabel(), null,
    'removing the selected chip clears the published selection');

  chipByLabel(h, 'warp2').dispatch('keydown', { key: 'Delete' });
  assert.deepEqual(labels(h),
    ['camera', 'project', 'sample', 'colorize', 'modulation']);
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
  assert.equal(entries.find((entry) => entry.dataset.operator === 'sample.grid.v4'),
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
    const option = paletteEntries(h).find((entry) =>
      !h.store.chain().some(({operator}) => operator === entry.dataset.operator));
    option.dispatch('keydown', {key});
    const inserted = h.store.chain().find((entry) => entry.operator === option.dataset.operator);
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
  const source = structuredClone(BASE.document);
  const fade = source.descriptor.parameters.find((parameter) => parameter.id === 'project.singularity-fade');
  source.preset_bank.presets[0].values['project.singularity-fade'] = fade.domain.maximum;
  assert.notEqual(fade.domain.maximum, fade.default);
  const h = await makeStrip({ source });
  const before = h.store.document();

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
  entries.find((entry) => entry.dataset.operator === 'sphere.lens.mobius.v3')
    .dispatch('click');
  assert.deepEqual(labels(h).slice(0, 3), ['camera', 'lens', 'lens1'],
    'the band + lands at the band\'s last gap');
  assert.equal(h.store.selectedLabel(), 'lens1',
    'the landed stage is selected, so its controls open on the insert');
  assert.equal(chipByLabel(h, 'lens1').getAttribute('aria-current'), 'true');
  assert.equal(chipByLabel(h, 'lens1')
    .classList.contains('chain-chip--expanded'), true);
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
  const illegal = entries.find((entry) => entry.dataset.operator === 'warp.affine.v4');
  assert.equal(illegal, undefined, 'invalid stages are omitted instead of greyed out');
  const applied = h.applied.length;
  entries.find((entry) => entry.dataset.operator === 'sphere.lens.glitch.v2')
    .dispatch('click');
  assert.equal(h.store.chain()[0].label, 'camera');
  assert.equal(h.store.chain()[1].operator, 'sphere.lens.glitch.v2');
  assert.equal(h.store.chain()[2].label, 'lens');
  assert.equal(h.applied.length, applied + 1);
});

test('a palette opens anchored to the control that opened it', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  Object.assign(add, { offsetLeft: 298, offsetTop: 32, offsetWidth: 20, offsetHeight: 20 });
  add.dispatch('click');
  assert.equal(paletteOf(h).style.left, `${add.offsetLeft}px`);
  assert.ok(Number.parseFloat(paletteOf(h).style.top) >= add.offsetTop + add.offsetHeight,
    'the palette opens below its control');
});

test('a palette near the right edge is clamped back inside the viewport', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  Object.assign(add, { offsetLeft: 1250, offsetTop: 32, offsetWidth: 40, offsetHeight: 20 });
  add.dispatch('click');
  const left = Number.parseFloat(paletteOf(h).style.left);
  assert.ok(left < add.offsetLeft && left + 208 < h.doc.documentElement.clientWidth,
    'clamped inside the viewport width less the palette');
});

test('a palette near the bottom is lifted back inside the viewport', async () => {
  const h = await makeStrip();
  measureNewElements(h, 208);
  h.doc.documentElement.clientHeight = 300;
  measureNewHeights(h, 192);
  const add = bandFor(h, 'sphere').querySelector('.chain-band-add');
  Object.assign(add, { offsetLeft: 20, offsetTop: 270, offsetHeight: 20 });
  add.dispatch('click');
  const top = Number.parseFloat(paletteOf(h).style.top);
  assert.ok(top < add.offsetTop && top + 192 < h.doc.documentElement.clientHeight,
    'lifted inside the viewport height');
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
  const top = Number.parseFloat(paletteOf(h).style.top);
  const height = Number.parseFloat(paletteOf(h).style.maxHeight);
  assert.ok(top > 0 && height < 400);
  assert.equal(h.doc.documentElement.clientHeight - top - height, top,
    'the viewport height less equal margins');
  assert.equal(paletteOf(h).style.overflowY, 'auto');
});
