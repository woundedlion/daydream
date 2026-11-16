import { test } from "node:test";
import assert from "node:assert/strict";
import { createChainDocumentStore, scratchChainDocument } from "../../src/workbench/shader/chain_document_store.js";
import { createChainStrip } from "../../src/workbench/shader/chain_strip.js";
import { documentEvents, fakeElement, installDocument } from ".././helpers/fake_dom.js";
import { CATALOG, BASE, runFrame, makeStrip, chipByLabel, bandFor, paletteEntries, lastAnnounced, labels, rowFor, controlIn } from ".././helpers/chain_strip_harness.js";
import { dragGeometry, dragPointer } from "./fixture.js";

test('undo and redo revert and reapply whole edits through the same apply path', async () => {
  const h = await makeStrip();
  bandFor(h, 'plane').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h)[0].dispatch('click');
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

  chipByLabel(h, 'camera').querySelector('.chain-chip-rename')
    .dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(labels(h).length, 8);
  assert.equal(h.applied.length, 3,
    'text-field undo stays with the native input editor');

  // Ctrl+Z reaches the container's shortcut from any chip.
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'z', ctrlKey: true });
  assert.equal(labels(h).length, 7);
  assert.equal(h.applied.length, 4);
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'y', ctrlKey: true });
  assert.equal(labels(h).length, 8);
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'z', metaKey: true });
  assert.equal(labels(h).length, 7);
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'z', ctrlKey: true, shiftKey: true });
  assert.equal(labels(h).length, 8);
  const selector = h.doc.createElement('select');
  const textArea = h.doc.createElement('textarea');
  for (const control of [selector, textArea]) {
    h.container.appendChild(control);
    control.dispatch('keydown', { key: 'z', ctrlKey: true });
    assert.equal(labels(h).length, 8);
  }
});

test('bypass toggles the program shape without touching the document', async () => {
  const h = await makeStrip();
  const digest = h.store.compile().descriptor_digest;

  chipByLabel(h, 'lens').querySelector('.chain-chip-bypass').dispatch('click');
  assert.deepEqual(h.applied.at(-1),
    ['camera', 'project', 'warp2', 'sample', 'colorize', 'modulation']);
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

test('keyboard bypass retains chip focus for repeated toggles and arrow navigation', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'lens').focus();
  h.doc.activeElement.dispatch('keydown', {key: 'b'});
  assert.equal(h.doc.activeElement === chipByLabel(h, 'lens'), true);
  assert.deepEqual(h.store.bypassedLabels(), ['lens']);
  h.doc.activeElement.dispatch('keydown', {key: 'b'});
  assert.equal(h.doc.activeElement === chipByLabel(h, 'lens'), true);
  assert.deepEqual(h.store.bypassedLabels(), []);
  for (const selector of ['.chain-chip-bypass', '.chain-chip-remove'])
    assert.equal(chipByLabel(h, 'lens').querySelector(selector).getAttribute('aria-keyshortcuts'), null);
  h.doc.activeElement.dispatch('keydown', {key: 'ArrowRight'});
  assert.equal(h.doc.activeElement === chipByLabel(h, 'project'), true);
});

test('a bypass unavailable to the render is disabled, with the reason in text', async () => {
  let compiledSide = false;
  const h = await makeStrip({ bypassAvailable: () => !compiledSide });
  const bypasses = () => h.container.querySelectorAll('.chain-chip-bypass')
    .filter((node) => !node.classList.contains('chain-modulation-enabled'));
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

test('the strip exposes one chip tab stop and tabbable header controls', async () => {
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

});

test('a chip selects by click', async () => {
  const h = await makeStrip();
  assert.equal(h.store.selectedLabel(), null);

  chipByLabel(h, 'lens').dispatch('click');
  assert.equal(h.store.selectedLabel(), 'lens');
  assert.deepEqual(h.applied, [], 'a selection is no structural edit');
});

test('endomorphism headers are drag surfaces; crossings are not', async () => {
  const h = await makeStrip();
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

test('a cancelled header drag does not consume the next parameter checkbox click', async () => {
  const source = scratchChainDocument(CATALOG, [
    {label: 'camera', operator: 'sphere.displace.ripple.v2'},
    {label: 'lens', operator: 'sphere.rotate.v2'},
    {label: 'project', operator: 'project.stereographic.v2'},
    {label: 'sample', operator: 'sample.grid.v4'},
    {label: 'color', operator: 'colorize.generated-palette.v4'},
  ]);
  const h = await makeStrip({source, writeThrough: true});
  dragGeometry(h);
  const chip = chipByLabel(h, 'camera');
  const header = chip.querySelector('.chain-chip-header');
  header.dispatch('pointerdown', dragPointer(25));
  header.dispatch('pointermove', dragPointer(100));
  chip.dispatch('keydown', {key: 'Escape'});
  assert.equal(header.hasPointerCapture(7), false);
  const toggle = controlIn(rowFor(h, 'camera', 'camera.random-center'));
  assert.equal(toggle.dispatch('click').defaultPrevented, false);
  toggle.checked = false;
  toggle.dispatch('change');
  assert.deepEqual(h.edits.at(-1), ['camera.random-center', 'off']);
  assert.deepEqual(h.applied, []);
});

test('a drag scrolls the pipeline near its edges and honors the final release position', async () => {
  const h = await makeStrip();
  dragGeometry(h);
  const viewport = h.container.querySelector('.chain-strip-viewport');
  viewport.scrollHeight = 500;
  viewport.scrollTop = 100;
  const header = chipByLabel(h, 'camera').querySelector('.chain-chip-header');
  header.dispatch('pointerdown', dragPointer(25));
  header.dispatch('pointermove', dragPointer(199));
  const step = viewport.scrollTop - 100;
  assert.ok(step > 0);
  runFrame();
  assert.equal(viewport.scrollTop, 100 + 2 * step);
  runFrame();
  assert.equal(viewport.scrollTop, 100 + 3 * step);
  header.dispatch('pointermove', dragPointer(1));
  assert.equal(viewport.scrollTop, 100 + 2 * step);
  runFrame();
  assert.equal(viewport.scrollTop, 100 + step);
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
  paletteEntries(h)[0].dispatch('click');
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
  assert.equal(labels(h).length, 8, 'a destroyed strip undoes nothing');
  assert.equal(h.container.childNodes.length, 0, 'and repaints nothing');
});
