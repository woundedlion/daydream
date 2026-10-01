import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import { fakeElement } from './helpers/fake_dom.js';

const handler = pageHandlers(new URL('../src/workbench/palettes/palettes_page.js', import.meta.url));

test('a previous slider blur preserves the new locked drag', () => {
  const sliders = { red: fakeElement(), green: fakeElement() };
  const definitions = Object.keys(sliders).map((param) => ({ param, group: 'offset', scale: 1 }));
  for (const slider of Object.values(sliders)) Object.assign(slider, { value: '0.5', min: '0', max: '1' });
  const input = {};
  const context = {
    parameters: { red: 0.5, green: 0.5 }, sliderDefinitions: definitions, sliderHandles: {},
    lockedDragStartValues: {}, lockedDragOwner: null, sliderAriaLabel: () => '',
    document: { getElementById: (id) => id === 'lock_offset' ? { checked: true } : sliders[id.replace('_slider', '')] },
    createSlider: (_container, options, callback) => {
      input[options.id] = callback;
      return { slider: sliders[options.id], setValue: (value) => { sliders[options.id].value = String(value); } };
    },
    lockedGroupMove: (delta, members) => ({ values: Object.fromEntries(members.map((member) => [member.param, member.start + delta])) }),
    scheduleUpdate: () => {},
  };
  const mount = handler('mountSlider', context);
  definitions.forEach(mount);
  sliders.red.dispatch('mousedown');
  sliders.green.dispatch('mousedown');
  sliders.red.dispatch('blur');
  input.green(0.6);
  assert.equal(context.parameters.red, 0.6);
  assert.equal(context.parameters.green, 0.6);
  sliders.green.dispatch('blur');
  assert.equal(context.lockedDragOwner, null);
});

test('copy feedback ignores an older clipboard completion', async () => {
  const pending = [];
  let dismissed = 0;
  const context = {
    palette: { get: (phase) => [phase, 0, 0] },
    copyFeedback: fakeElement(), copyFeedbackSwatch: fakeElement(),
    copyFeedbackStatus: fakeElement(), copyFeedbackHex: fakeElement(),
    activeTab: 'generative', linearRgbToHex: (red) => String(red),
    feedbackPosition: () => ({ x: 4, y: 5 }), copyFeedbackTimer: null,
    copyRequestId: 0, copyToClipboard: () => new Promise((resolve) => pending.push(resolve)),
    dismissCopyFeedbackLater: () => { dismissed++; },
  };
  const copy = handler('copyPaletteColor', context);
  const first = copy(0.2);
  const second = copy(0.8);
  pending[1](true);
  await second;
  pending[0](false);
  await first;
  assert.equal(context.copyFeedbackHex.textContent, '0.8');
  assert.equal(context.copyFeedbackStatus.textContent, 'Copied');
  assert.equal(dismissed, 1);
});

test('feedback dismissal replaces its timer and hides the bubble', () => {
  const cleared = [];
  const timers = [];
  const context = {
    copyFeedbackTimer: 1, copyFeedback: fakeElement(),
    clearTimeout: (id) => cleared.push(id),
    setTimeout: (fn, delay) => { timers.push([fn, delay]); return 2; },
  };
  context.copyFeedback.classList.add('is-visible');
  handler('dismissCopyFeedbackLater', context)();
  assert.deepEqual(cleared, [1]);
  assert.equal(timers[0][1], 1300);
  timers[0][0]();
  assert.equal(context.copyFeedback.classList.contains('is-visible'), false);
  assert.equal(context.copyFeedbackTimer, null);
});

test('strip keyboard dispatches copy, zoom, reset and ignores unrelated keys', () => {
  const calls = [];
  const keydown = handler('handleStripKeyDown', {
    copyPaletteColor: (position) => { calls.push(['copy', position]); return Promise.resolve(); },
    reportCopyFailure: assert.fail, handleResetZoom: () => calls.push(['reset']),
    zoomAroundCenter: () => calls.push(['zoom']),
  });
  for (const [key, shiftKey, handled] of [
    ['Enter', false, true], [' ', false, true], ['ArrowLeft', true, true],
    ['ArrowRight', true, true], ['Enter', true, false], ['Escape', false, false],
  ]) {
    let prevented = false;
    keydown({ key, shiftKey, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, handled);
  }
  assert.deepEqual(calls, [['copy', 0.5], ['copy', 0.5], ['reset'], ['zoom']]);
});

test('a dropped hue selection is redrawn without nudging its replacement', () => {
  let scheduled = 0;
  let prevented = 0;
  const context = {
    hueKeyNudgeTurns: () => 0.01, selectedHueKey: 0,
    readPaletteRecipe: () => ({ hue: { mode: 'TRIAD' } }),
    PaletteV4: { hueMode: { CUSTOM: 'CUSTOM' } }, activateCustomHue: () => false,
    scheduleUpdate: () => { scheduled++; }, customBaseTurns: assert.fail,
  };
  handler('handleHueKeyNudge', context)({ preventDefault: () => { prevented++; } }, 2);
  assert.equal(scheduled, 1);
  assert.equal(prevented, 1);
  assert.equal(context.selectedHueKey, 2);
});

test('the hue dropdown restores its previous mode after a refused handoff', () => {
  const select = { value: 'CUSTOM' };
  const context = {
    PaletteV4: { hueMode: { HARMONY: 0, CUSTOM: 1, SWEEP: 2 }, domain: { LOOP: 1 } },
    previousHueMode: 0, selectedHueKey: 0, activeHueKey: null, paletteEnumOrdinal: () => 1,
    readPaletteRecipe: () => ({ hue: {}, domain: 0 }), customBaseTurns: () => 0,
    activateCustomHue: () => false,
    paletteEnumName: () => 'HARMONY',
  };
  handler('handleHueModeChange', context)(select);
  assert.equal(select.value, 'HARMONY');
  assert.equal(context.previousHueMode, 0);
});


test('the hue wheel uses authored custom lightness instead of canonical center', () => {
  const drawn = [];
  const context = {
    hueKeyWheelPainter: { draw: (options) => {
      drawn.push(options);
      return { points: [0], degrees: [0], scale: 1 };
    } },
    PaletteV4: { curve: { CUSTOM: 5 } },
    currentHueKeyState: () => ({}), activeHueKey: null, selectedHueKey: 0,
    hueKeyWheelDrawnPoints: [], hueKeyWheelScale: 1, syncHueKeyHandles: () => {},
  };
  const draw = handler('drawHueKeyWheel', context);
  draw({ lightness: { curve: 5, center: 0.62, custom: [0.1, 0.4, 0.7] } });
  assert.ok(Math.abs(drawn[0].lightness - 0.4) < 1e-12);
  draw({ lightness: { curve: 0, center: 0.7, custom: [0, 0, 0] } });
  assert.equal(drawn[1].lightness, 0.7);
});
