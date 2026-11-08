import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStripController} from '../src/workbench/palettes/strip_controller.js';
import {createPaletteViewport, paletteStripView} from '../src/workbench/palettes/palette_controls.js';
import {PaletteRecipeModel} from '../src/workbench/palettes/palette_recipe_model.js';
import {linearRgbToHex} from '../src/shared/color.js';
import {fakeElement} from './helpers/fake_dom.js';

function setup({copy = async () => true, getPalette = () => ({get: phase => [phase, 0, 0]})} = {}) {
  const canvas = fakeElement('canvas');
  Object.assign(canvas, {clientLeft: 0, clientTop: 0, clientWidth: 100, clientHeight: 20,
    getBoundingClientRect: () => ({left: 0, top: 0, width: 100, height: 20})});
  const resetZoomButton = fakeElement('button');
  canvas.ownerDocument = {activeElement: null};
  canvas.focus = () => { canvas.ownerDocument.activeElement = canvas; };
  resetZoomButton.focus = () => { canvas.ownerDocument.activeElement = resetZoomButton; };
  const feedback = {root: fakeElement(), swatch: fakeElement(), status: fakeElement(), hex: fakeElement()};
  const timers = new Map();
  let id = 0;
  let drag;
  let removed = 0;
  let tab = 'procedural';
  const viewport = createPaletteViewport();
  const model = new PaletteRecipeModel();
  const draws = [];
  const windowUpdates = [];
  const calls = {redraw: 0, recipe: 0, schedule: 0};
  const heading = fakeElement();
  const controller = createStripController({canvas, viewport, model, getTab: () => tab,
    getPalette,
    visiblePhaseRange: () => tab === 'procedural' ? viewport.value : {start:model.window.offset, end:model.window.offset + model.window.span},
    drawColorStrip: value => draws.push(value), redrawForViewport: () => { calls.redraw++; },
    renderRecipeWindow: () => { calls.recipe++; windowUpdates.push({ ...model.window }); },
    scheduleUpdate: () => { calls.schedule++; windowUpdates.push('redraw'); },
    resetZoomButton, paletteRangeHeading: heading, feedback,
    copy, createDrag: options => { drag = options; return {remove: () => { removed++; }}; },
    timers: {setTimeout: (fn, delay) => {
      assert.ok(Number.isFinite(delay) && delay > 0); timers.set(++id, fn); return id;
    },
      clearTimeout: id => timers.delete(id)}});
  return {controller, canvas, viewport, model, feedback, resetZoomButton, timers, draws, windowUpdates,
    calls, heading, drag, removed: () => removed, setTab: value => { tab = value; }};
}

test('copy feedback ignores older clipboard completions and replaces dismissal timers', async () => {
  const pending = [];
  const f = setup({copy: () => new Promise(resolve => pending.push(resolve))});
  const first = f.controller.copyColor(0.2);
  assert.equal(f.feedback.root.classList.contains('is-visible'), true);
  const second = f.controller.copyColor(0.8);
  pending[1](true); await second;
  pending[0](false); await first;
  assert.equal(f.feedback.hex.textContent, linearRgbToHex(0.8, 0, 0));
  assert.equal(f.feedback.status.textContent, 'Copied');
  assert.equal(f.timers.size, 1);
  const third = f.controller.copyColor(0.1);
  assert.equal(f.timers.size, 0);
  pending[2](false); await third;
  assert.equal(f.feedback.status.textContent, 'Copy failed');
  f.timers.values().next().value();
  assert.equal(f.feedback.root.classList.contains('is-visible'), false);
  f.controller.dispose();
  assert.equal(f.removed(), 1);
});

test('strip keyboard zoom narrows around the centre and reset restores focus before hiding', () => {
  const f = setup();
  f.canvas.dispatch('keydown', {key: 'ArrowRight', shiftKey: true});
  const {start, end} = f.viewport.value;
  assert.ok(end - start < 1 && end > start, 'the zoom narrows the range');
  assert.ok(Math.abs((start + end) / 2 - 0.5) < 1e-9, 'the zoom stays centred');
  f.controller.syncResetZoom();
  assert.equal(f.resetZoomButton.classList.contains('hidden'), false);
  f.resetZoomButton.focus();
  const events = [];
  const focus = f.canvas.focus;
  f.canvas.focus = () => { events.push('focus'); focus(); };
  const toggle = f.resetZoomButton.classList.toggle;
  f.resetZoomButton.classList.toggle = (name, value) => {
    if (name === 'hidden' && value) events.push('hide');
    return toggle(name, value);
  };
  f.canvas.dispatch('keydown', {key: 'ArrowLeft', shiftKey: true});
  f.controller.syncResetZoom();
  assert.equal(f.resetZoomButton.classList.contains('hidden'), true);
  assert.equal(f.canvas.ownerDocument.activeElement, f.canvas);
  assert.deepEqual(events, ['focus', 'hide']);
  assert.deepEqual(f.calls, {redraw: 2, recipe: 0, schedule: 0});
  f.controller.dispose();
  f.canvas.dispatch('keydown', {key: 'ArrowRight', shiftKey: true});
  assert.deepEqual(f.viewport.value, {start: 0, end: 1});
});

test('pointer selection zooms either tab and cancellation clears the selection', () => {
  const f = setup();
  const point = x => ({clientX:x, clientY:10});
  f.drag.onStart(point(20)); f.drag.onMove(point(80)); f.drag.onEnd(point(80));
  assert.deepEqual(f.viewport.value, {start:0.2, end:0.8});
  assert.equal(f.calls.redraw, 1);
  f.setTab('generative');
  f.drag.onStart(point(25)); f.drag.onEnd(point(75));
  assert.deepEqual(f.model.window, {offset:0.25, span:0.5});
  f.drag.onStart(point(25)); f.drag.onEnd(point(75));
  assert.deepEqual(f.model.window, {offset:0.375, span:0.25});
  f.resetZoomButton.dispatch('click');
  assert.deepEqual(f.windowUpdates, [
    {offset:0.25, span:0.5}, 'redraw',
    {offset:0.375, span:0.25}, 'redraw',
    {offset:0, span:1}, 'redraw',
  ]);
  f.drag.onStart(point(20));
  f.drag.onMove(point(70));
  assert.deepEqual(f.draws.at(-1), {start: 0.2, end: 0.7});
  f.drag.onCancel();
  assert.equal(f.canvas.style.cursor, 'pointer');
  assert.equal(f.draws.at(-1), undefined);
  f.controller.dispose();
});


test('strip clicks copy at pointer coordinates', async () => {
  const f = setup();
  f.drag.onStart({clientX:25, clientY:10});
  f.drag.onEnd({clientX:25, clientY:10});
  await Promise.resolve();
  assert.equal(f.feedback.root.style.left, '25px');
  assert.equal(f.feedback.root.style.top, '10px');
  assert.equal(f.feedback.status.textContent, 'Copied');
  f.controller.dispose();
});

test('abandoned strip drags cannot zoom', () => {
  const f = setup();
  f.drag.onStart({clientX:10, clientY:10});
  f.drag.onMove({clientX:90, clientY:-1});
  f.drag.onEnd({clientX:90, clientY:-1});
  assert.deepEqual(f.viewport.value, {start:0,end:1});
  f.controller.dispose();
});

test('zero-width strip clicks copy the starting phase', async () => {
  const f = setup();
  f.canvas.clientWidth = 0;
  f.drag.onStart({clientX:10, clientY:10});
  f.drag.onEnd({clientX:10, clientY:10});
  await Promise.resolve();
  assert.equal(f.feedback.hex.textContent, linearRgbToHex(0, 0, 0));
  assert.equal(f.feedback.status.textContent, 'Copied');
  f.controller.dispose();
});

test('Enter and Space copy the middle of the strip', async () => {
  const copies = [];
  const f = setup({copy: async (hex) => { copies.push(hex); return true; }});
  f.setTab('generative');
  for (const key of ['Enter', ' ']) {
    f.feedback.status.textContent = '';
    f.feedback.hex.textContent = '';
    const count = copies.length;
    assert.equal(f.canvas.dispatch('keydown', {key}).defaultPrevented, true);
    await Promise.resolve();
    const hex = linearRgbToHex(0.5, 0, 0);
    assert.equal(copies.length, count + 1);
    assert.equal(copies.at(-1), hex);
    assert.equal(f.feedback.hex.textContent, hex);
    assert.equal(f.feedback.status.textContent, 'Copied');
  }
  f.controller.dispose();
});

test('unhandled strip keys retain their default behaviour', () => {
  const f = setup();
  for (const event of [{key:'Enter', shiftKey:true}, {key:'Escape'}, {key:'ArrowRight'}])
    assert.equal(f.canvas.dispatch('keydown', event).defaultPrevented, false);
  f.controller.dispose();
});

test('generative strip keyboard zoom narrows the recipe window and reset refreshes it', () => {
  const f = setup();
  f.setTab('generative');
  f.resetZoomButton.dispatch('click');
  f.canvas.dispatch('keydown', {key:'ArrowRight', shiftKey:true});
  const {offset, span} = f.model.window;
  assert.ok(span > 0 && span < 1, 'the zoom narrows the window');
  assert.ok(Math.abs(offset + span / 2 - 0.5) < 1e-9, 'the zoom stays centred');
  f.resetZoomButton.dispatch('click');
  assert.deepEqual(f.model.window, {offset:0, span:1});
  assert.deepEqual(f.calls, {redraw: 0, recipe: 2, schedule: 2});
  f.controller.syncResetZoom();
  assert.equal(f.resetZoomButton.classList.contains('hidden'), true);
  f.controller.dispose();
});

test('missing palettes publish no copy feedback', async () => {
  const none = setup({getPalette: () => null});
  await none.controller.copyColor(0.5);
  assert.equal(none.feedback.root.classList.contains('is-visible'), false);
  none.controller.dispose();
});

test('disposed clipboard requests publish no stale feedback', async () => {
  let resolve;
  const f = setup({copy: () => new Promise(done => { resolve = done; })});
  const pending = f.controller.copyColor(0.5);
  f.controller.dispose();
  resolve(true); await pending;
  assert.equal(f.timers.size, 0);
});

test('a rejected pointer copy replaces the pending feedback with failure', async (t) => {
  t.mock.method(console, 'error', () => {});
  const f = setup({copy: async () => { throw new Error('clipboard refused'); }});
  f.drag.onStart({clientX:25,clientY:10});
  f.drag.onEnd({clientX:25,clientY:10});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.feedback.status.textContent, 'Copy failed');
  assert.equal(f.timers.size, 1);
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});

test('strip view announces the current zoomed phase range', () => {
  const f = setup();
  f.viewport.zoom(0.2, 0.7);
  f.controller.updateView();
  const view = paletteStripView(f.viewport.value);
  assert.equal(f.canvas.getAttribute('aria-label'), view.ariaLabel);
  assert.equal(f.heading.textContent, view.heading);
  f.controller.dispose();
});
