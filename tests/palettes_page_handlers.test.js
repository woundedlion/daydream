import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import { fakeElement } from './helpers/fake_dom.js';
import { hueKeyNudgeTurns } from '../src/workbench/palettes/palette_wheel.js';
import { replaceUrl } from '../src/app/state.js';
import { PaletteV4, defaultPaletteRecipe, paletteRecipeFromControls, paletteControlsFromRecipe, paletteEnumName, paletteEnumOrdinal, customHueKeyState, customHueSweepRepresentable } from '../src/workbench/palettes/palette_controls.js';
import { captureConsole } from './helpers/fake_console.js';

const handler = pageHandlers(new URL('../src/workbench/palettes/palettes_page.js', import.meta.url));

test('tab switches rebuild the palette when browser URL updates are refused', () => {
  for (const refused of [false, true]) {
    const button = fakeElement();
    button.dataset.tab = 'generative';
    const panel = fakeElement();
    panel.id = 'tab-content-generative';
    let updated = 0;
    const urls = [];
    let replaced;
    const win = { history: { replaceState(state, title, url) {
      urls.push(url);
      if (refused) throw new Error('rate limit');
    } } };
    const context = {
      activeTab: 'procedural', window: { location: { href: 'https://example.test/tools/palettes.html' } },
      document: {
        getElementById: () => fakeElement(), querySelector: () => fakeElement(),
        querySelectorAll: selector => selector === '.tab-btn' ? [button] : [panel],
      },
      paletteTabUrl: (url, tab) => `${url}?tab=${tab}`,
      replaceUrl: url => { replaced = replaceUrl(url, win); }, updatePalette: () => { updated++; },
    };
    const captured = captureConsole(() => handler('switchTab', context)('generative'));
    assert.deepEqual(urls, ['https://example.test/tools/palettes.html?tab=generative']);
    assert.equal(replaced, !refused);
    assert.deepEqual(captured.messages, refused ? ['URL update skipped: Error: rate limit'] : []);
    assert.equal(updated, 1);
    assert.equal(button.tabIndex, 0);
    assert.equal(panel.hidden, false);
    assert.equal(context.activeTab, 'generative');
  }
});

test('a previous slider blur preserves the new locked drag', () => {
  const sliders = { red: fakeElement(), green: fakeElement() };
  const definitions = Object.keys(sliders).map((param) => ({ param, group: 'offset', scale: 1 }));
  for (const slider of Object.values(sliders)) Object.assign(slider, { value: '0.5', min: '0', max: '1' });
  const input = {};
  const context = {
    parameters: { red: 0.5, green: 0.5 }, sliderDefinitions: definitions, sliderHandles: {},
    lockedDragStartValues: {}, lockedDragOwner: null, sliderAriaLabel: () => '',
    document: { getElementById: (id) => id === 'lock_offset' ? { checked: true } : sliders[id.replace('_slider', '')] },
    createSlider: (container, options, callback) => {
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
    paletteRecipeFromControls: () => ({ hue: {}, domain: 0 }),
    recipeTemplate: {}, paletteControlReadings: () => ({}), controlValue: () => {}, customHueOffsets: [],
    customBaseTurns: () => 0,
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
    currentHueKeyState: () => ({ offsets: [0, 0.3, 0.6] }), activeHueKey: null, selectedHueKey: 0,
    hueKeyWheelDrawnPoints: [], hueKeyWheelScale: 1, syncHueKeyHandles: () => {},
  };
  const draw = handler('drawHueKeyWheel', context);
  draw({ lightness: { curve: 5, center: 0.62, custom: [0.1, 0.4, 0.7, 0] } });
  assert.ok(Math.abs(drawn[0].lightness - 0.4) < 1e-12);
  draw({ lightness: { curve: 0, center: 0.7, custom: [0, 0, 0] } });
  assert.equal(drawn[1].lightness, 0.7);
});

test('base hue arrow keys step in useful degrees without changing the recipe mode', () => {
  const slider = {value: '359.25', dispatchEvent(event) { assert.equal(event.type, 'input'); }};
  const keydown = handler('handleBaseHueKeyDown', {
    hueKeyNudgeTurns: (key, shift) => key === 'ArrowRight' ? (shift ? 10 : 1) / 360 : key === 'ArrowLeft' ? -1 / 360 : null,
    wrapTurns: (value) => ((value % 1) + 1) % 1, Event,
  });
  let prevented = 0;
  const press = (key, shiftKey = false) => keydown({key, shiftKey, currentTarget: slider, preventDefault() { prevented++; }});
  press('ArrowRight');
  assert.ok(Math.abs(Number(slider.value) - 0.25) < 1e-8);
  press('ArrowRight', true);
  assert.ok(Math.abs(Number(slider.value) - 10.25) < 1e-8);
  press('ArrowLeft');
  assert.ok(Math.abs(Number(slider.value) - 9.25) < 1e-8);
  press('Enter');
  assert.equal(prevented, 3);
});

test('a keyboard resample follows the selected hue key through later nudges', () => {
  let mode = 'HARMONY';
  let focused = 1;
  const moved = [];
  const context = {
    selectedHueKey: 1, customHueOffsets: [0, 0.25, 0.5],
    hueKeyNudgeTurns, wrapTurns: value => value % 1,
    PaletteV4: { hueMode: { CUSTOM: 'CUSTOM' } },
    readPaletteRecipe: () => ({ hue: { mode } }),
    activateCustomHue: () => { context.selectedHueKey = 2; mode = 'CUSTOM'; return true; },
    drawHueKeyWheel: () => {},
    hueKeyHandles: [0, 1, 2].map(index => ({ focus: () => { focused = index; } })),
    customBaseTurns: () => 0,
    moveCustomHueKey: (base, offsets, index) => { moved.push(index); return offsets; },
    scheduleUpdate: () => {},
  };
  const nudge = handler('handleHueKeyNudge', context);
  const event = { key: 'ArrowRight', shiftKey: false, preventDefault() {} };
  nudge(event, focused);
  assert.equal(focused, 2);
  nudge(event, focused);
  assert.deepEqual(moved, [2, 2]);
  nudge({...event, key: 'Enter', preventDefault: assert.fail}, 0);
  assert.deepEqual(moved, [2, 2]);
  assert.equal(context.selectedHueKey, 2);
});

test('loading a recipe clears a stale hue-key refusal', () => {
  const status = { textContent: 'Choose another key.' };
  const fields = new Map();
  const context = {
    document: {
      getElementById: (id) => {
        if (id === 'hue_key_status') return status;
        if (!fields.has(id)) fields.set(id, {});
        return fields.get(id);
      },
    },
    structuredClone, recipeTemplate: null, customHueOffsets: null, previousHueMode: null,
    PALETTE_CONTROL_IDS: new Proxy({}, { get: (_, name) => String(name) }),
    paletteControlsFromRecipe: () => ({
      spreadTurns: 0, customHueOffsets: [], baseTurns: 0, window: { offset: 0, span: 1 },
    }),
    syncRecipeSliderLabels: () => {}, setCustomBaseTurns: () => {}, setRecipeWindow: () => {},
    setAxisEndpoints: () => {}, syncRecipeControlAvailability: () => {}, scheduleUpdate: () => {},
  };
  context.clearHueKeyStatus = handler('clearHueKeyStatus', context);
  handler('loadRecipe', context)({ hue: { mode: 0 } });
  assert.equal(status.textContent, '');
});

test('the hue dropdown resamples authored harmony and rejects a multi-turn loop sweep', () => {
  for (const mode of [PaletteV4.hueMode.HARMONY, PaletteV4.hueMode.SWEEP]) {
    const recipe = defaultPaletteRecipe();
    Object.assign(recipe.hue, {
      mode, harmony: PaletteV4.harmony.SPLIT_COMPLEMENTARY, spreadTurns: 0.2,
      sweepTurns: 3, baseTurns: 0.25,
    });
    if (mode === PaletteV4.hueMode.SWEEP) recipe.domain = PaletteV4.domain.LOOP;
    const controls = { ...paletteControlsFromRecipe(recipe), hueMode: 'CUSTOM' };
    const select = { value: 'CUSTOM' };
    let source;
    const context = {
      PaletteV4, paletteRecipeFromControls, paletteEnumName, paletteEnumOrdinal,
      recipeTemplate: recipe, paletteControlReadings: () => controls,
      controlValue: () => {}, customHueOffsets: [], previousHueMode: mode,
      customBaseTurns: () => recipe.hue.baseTurns, selectedHueKey: 2, activeHueKey: 1,
      activateCustomHue: value => { source = value; return customHueSweepRepresentable(value); },
    };
    handler('handleHueModeChange', context)(select);
    assert.equal(source.hue.mode, mode);
    assert.equal(source.hue.baseTurns, recipe.hue.baseTurns);
    if (mode === PaletteV4.hueMode.HARMONY) {
      assert.deepEqual(customHueKeyState(source), customHueKeyState(recipe));
      assert.equal(source.hue.spreadTurns, 0.2);
      assert.equal(select.value, 'CUSTOM');
    } else {
      assert.equal(source.hue.sweepTurns, 3);
      assert.equal(select.value, 'SWEEP');
    }
  }
});
