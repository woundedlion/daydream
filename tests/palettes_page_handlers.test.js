import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import { fakeElement } from './helpers/fake_dom.js';
import { replaceUrl } from '../src/app/state.js';
import { PaletteV4, defaultPaletteRecipe } from '../src/workbench/palettes/palette_controls.js';
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

test('loading a recipe clears a stale hue-key refusal and renders the loaded recipe', () => {
  const status = { textContent: 'Choose another key.' };
  const recipeModel = new PaletteRecipeModel();
  let rendered;
  const context = {
    hueKeyWheel: { clearStatus: () => { status.textContent = ''; } },
    recipeModel, scheduleUpdate: () => {},
    renderRecipeControls: () => { rendered = recipeModel.reading('domain'); },
  };
  const recipe = defaultPaletteRecipe();
  recipe.domain = PaletteV4.domain.MIRROR;
  handler('loadRecipe', context)(recipe);
  assert.equal(status.textContent, '');
  assert.equal(rendered, 'MIRROR');
});
