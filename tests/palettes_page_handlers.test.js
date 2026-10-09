import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import { fakeElement } from './helpers/fake_dom.js';
import { hueKeyNudgeTurns, hueKeyHandoff } from '../src/workbench/palettes/palette_wheel.js';
import { replaceUrl } from '../src/app/state.js';
import { PaletteV4, defaultPaletteRecipe, hueKeyState, customHueKeyState, customHueSweepRepresentable } from '../src/workbench/palettes/palette_controls.js';
import { PaletteRecipeModel } from '../src/workbench/palettes/palette_recipe_model.js';
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
    recipeModel: { recipe: () => ({ hue: { mode: 'TRIAD' } }), nudgeHueKey: assert.fail },
    PaletteV4: { hueMode: { CUSTOM: 'CUSTOM' } }, activateCustomHue: () => false,
    scheduleUpdate: () => { scheduled++; },
  };
  handler('handleHueKeyNudge', context)({ preventDefault: () => { prevented++; } }, 2);
  assert.equal(scheduled, 1);
  assert.equal(prevented, 1);
  assert.equal(context.selectedHueKey, 2);
});

test('the hue dropdown keeps the previous mode after a refused handoff', () => {
  let attempts = 0;
  const context = {
    recipeModel: new PaletteRecipeModel(), selectedHueKey: 2, activeHueKey: 1,
    activateCustomHue: () => { attempts++; return false; },
  };
  const change = handler('handleHueModeChange', context);
  change('CUSTOM');
  assert.equal(attempts, 1);
  assert.equal(context.recipeModel.reading('hueMode'), 'HARMONY');
  assert.equal(context.selectedHueKey, 0);
  assert.equal(context.activeHueKey, null);
  change('SWEEP');
  assert.equal(attempts, 1);
  assert.equal(context.recipeModel.reading('hueMode'), 'SWEEP');
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
  const recipeModel = new PaletteRecipeModel();
  recipeModel.setBaseHue(359.25 / 360);
  let rendered = 0;
  const keydown = handler('handleBaseHueKeyDown', {
    hueKeyNudgeTurns, recipeModel, renderBaseHue: () => { rendered++; }, scheduleUpdate: () => {},
  });
  let prevented = 0;
  const press = (key, shiftKey = false) => keydown({key, shiftKey, preventDefault() { prevented++; }});
  const degrees = () => recipeModel.baseHueTurns * 360;
  press('ArrowRight');
  assert.ok(Math.abs(degrees() - 0.25) < 1e-8);
  press('ArrowRight', true);
  assert.ok(Math.abs(degrees() - 10.25) < 1e-8);
  press('ArrowLeft');
  assert.ok(Math.abs(degrees() - 9.25) < 1e-8);
  press('Enter');
  assert.equal(prevented, 3);
  assert.equal(rendered, 3);
  assert.equal(recipeModel.reading('hueMode'), 'HARMONY');
});

test('a keyboard resample follows the selected hue key through later nudges', () => {
  let mode = 'HARMONY';
  let focused = 1;
  const moved = [];
  const context = {
    selectedHueKey: 1, hueKeyNudgeTurns,
    PaletteV4: { hueMode: { CUSTOM: 'CUSTOM' } },
    recipeModel: {
      recipe: () => ({ hue: { mode } }),
      nudgeHueKey: (index) => { moved.push(index); },
    },
    activateCustomHue: () => { context.selectedHueKey = 2; mode = 'CUSTOM'; return true; },
    drawHueKeyWheel: () => {},
    hueKeyHandles: [0, 1, 2].map(index => ({ focus: () => { focused = index; } })),
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

test('loading a recipe clears a stale hue-key refusal and renders the loaded recipe', () => {
  const status = { textContent: 'Choose another key.' };
  const recipeModel = new PaletteRecipeModel();
  let rendered;
  const context = {
    document: { getElementById: (id) => id === 'hue_key_status' ? status : assert.fail(id) },
    recipeModel, scheduleUpdate: () => {},
    renderRecipeControls: () => { rendered = recipeModel.reading('domain'); },
  };
  context.clearHueKeyStatus = handler('clearHueKeyStatus', context);
  const recipe = defaultPaletteRecipe();
  recipe.domain = PaletteV4.domain.MIRROR;
  handler('loadRecipe', context)(recipe);
  assert.equal(status.textContent, '');
  assert.equal(rendered, 'MIRROR');
});

test('the hue dropdown resamples authored harmony and rejects a multi-turn loop sweep', () => {
  for (const mode of [PaletteV4.hueMode.HARMONY, PaletteV4.hueMode.SWEEP]) {
    const recipe = defaultPaletteRecipe();
    Object.assign(recipe.hue, {
      mode, harmony: PaletteV4.harmony.SPLIT_COMPLEMENTARY, spreadTurns: 0.2,
      sweepTurns: 3, baseTurns: 0.25,
    });
    if (mode === PaletteV4.hueMode.SWEEP) recipe.domain = PaletteV4.domain.LOOP;
    const status = { textContent: '' };
    let rendered = 0;
    const context = {
      PaletteV4, hueKeyState, customHueKeyState, customHueSweepRepresentable, hueKeyHandoff,
      recipeModel: new PaletteRecipeModel(recipe), selectedHueKey: 2, activeHueKey: 1,
      document: { getElementById: () => status },
      renderRecipeControls: () => { rendered++; },
    };
    context.clearHueKeyStatus = handler('clearHueKeyStatus', context);
    context.activateCustomHue = handler('activateCustomHue', context);
    handler('handleHueModeChange', context)('CUSTOM');
    const model = context.recipeModel;
    if (mode === PaletteV4.hueMode.HARMONY) {
      const expected = customHueKeyState(recipe);
      assert.equal(model.reading('hueMode'), 'CUSTOM');
      assert.deepEqual([...model.customHueOffsets()], expected.offsets);
      assert.equal(model.baseHueTurns, expected.baseTurns);
      assert.equal(status.textContent, '');
      assert.equal(rendered, 1);
    } else {
      assert.equal(model.reading('hueMode'), 'SWEEP');
      assert.equal(model.reading('sweepTurns'), 3);
      assert.match(status.textContent, /loop sweep cannot be preserved/);
      assert.equal(rendered, 0);
    }
  }
});
