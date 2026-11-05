import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createStripController} from '../src/workbench/palettes/strip_controller.js';
import {createPaletteViewport} from '../src/workbench/palettes/palette_controls.js';
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
  const controller = createStripController({canvas, viewport, model, getTab: () => tab,
    getPalette,
    visiblePhaseRange: () => tab === 'procedural' ? viewport.value : {start:model.window.offset, end:model.window.offset + model.window.span},
    drawColorStrip: value => draws.push(value), redrawForViewport() {},
    zoomRecipeWindowControls: (start, end) => model.setWindow(start, end - start),
    renderRecipeWindow() {}, scheduleUpdate() {}, resetZoomButton, paletteRangeHeading: fakeElement(), feedback,
    copy, createDrag: options => { drag = options; return {remove: () => { removed++; }}; },
    timers: {setTimeout: (fn, delay) => { assert.equal(delay, 1300); timers.set(++id, fn); return id; },
      clearTimeout: id => timers.delete(id)}});
  return {controller, canvas, viewport, model, feedback, resetZoomButton, timers, draws,
    drag, removed: () => removed, setTab: value => { tab = value; }};
}

test('copy feedback ignores older clipboard completions and replaces dismissal timers', async () => {
  const pending = [];
  const f = setup({copy: () => new Promise(resolve => pending.push(resolve))});
  const first = f.controller.copyColor(0.2);
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

test('strip keyboard zoom and reset restore focus before hiding the reset button', () => {
  const f = setup();
  f.canvas.dispatch('keydown', {key: 'ArrowRight', shiftKey: true});
  assert.deepEqual(f.viewport.value, {start: 0.4, end: 0.6});
  f.controller.syncResetZoom();
  assert.equal(f.resetZoomButton.classList.contains('hidden'), false);
  f.resetZoomButton.focus();
  f.canvas.dispatch('keydown', {key: 'ArrowLeft', shiftKey: true});
  f.controller.syncResetZoom();
  assert.equal(f.resetZoomButton.classList.contains('hidden'), true);
  assert.equal(f.canvas.ownerDocument.activeElement, f.canvas);
  f.controller.dispose();
  f.canvas.dispatch('keydown', {key: 'ArrowRight', shiftKey: true});
  assert.deepEqual(f.viewport.value, {start: 0, end: 1});
});

test('pointer selection zooms either tab and cancellation clears the selection', () => {
  const f = setup();
  const point = x => ({clientX:x, clientY:10});
  f.drag.onStart(point(20)); f.drag.onMove(point(80)); f.drag.onEnd(point(80));
  assert.deepEqual(f.viewport.value, {start:0.2, end:0.8});
  f.setTab('generative');
  f.drag.onStart(point(25)); f.drag.onEnd(point(75));
  assert.deepEqual(f.model.window, {offset:0.25, span:0.5});
  f.drag.onStart(point(20)); f.drag.onCancel();
  assert.equal(f.canvas.style.cursor, 'pointer');
  assert.equal(f.draws.at(-1), undefined);
  f.controller.dispose();
});


test('strip clicks copy at pointer coordinates and abandoned drags cannot zoom', async () => {
  const f = setup();
  f.drag.onStart({clientX:25, clientY:10});
  f.drag.onEnd({clientX:25, clientY:10});
  await Promise.resolve();
  assert.equal(f.feedback.root.style.left, '25px');
  assert.equal(f.feedback.root.style.top, '10px');
  assert.equal(f.feedback.status.textContent, 'Copied');
  f.drag.onStart({clientX:10, clientY:10});
  f.drag.onMove({clientX:90, clientY:-1});
  f.drag.onEnd({clientX:90, clientY:-1});
  assert.deepEqual(f.viewport.value, {start:0,end:1});
  f.drag.onEnd(null);
  f.canvas.clientWidth = 0;
  f.drag.onStart({clientX:10, clientY:10});
  f.drag.onCancel();
  f.controller.dispose();
});

test('strip keys copy and dispatch generated-window zoom/reset without swallowing other keys', async () => {
  const f = setup();
  f.setTab('generative');
  for (const key of ['Enter', ' ']) {
    assert.equal(f.canvas.dispatch('keydown', {key}).defaultPrevented, true);
    await Promise.resolve();
  }
  for (const event of [{key:'Enter', shiftKey:true}, {key:'Escape'}, {key:'ArrowRight'}])
    assert.equal(f.canvas.dispatch('keydown', event).defaultPrevented, false);
  f.resetZoomButton.dispatch('click');
  f.canvas.dispatch('keydown', {key:'ArrowRight', shiftKey:true});
  assert.deepEqual(f.model.window, {offset:0.4, span:0.19999999999999996});
  f.resetZoomButton.dispatch('click');
  assert.deepEqual(f.model.window, {offset:0, span:1});
  f.controller.syncResetZoom();
  f.controller.dispose();
});

test('missing palettes and disposed clipboard requests publish no stale feedback', async () => {
  const none = setup({getPalette: () => null});
  await none.controller.copyColor(0.5);
  assert.equal(none.feedback.root.classList.contains('is-visible'), false);
  none.controller.dispose();
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
});
