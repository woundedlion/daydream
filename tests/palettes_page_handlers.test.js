import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import { fakeElement } from './helpers/fake_dom.js';
import { replaceUrl } from '../src/shared/url.js';
import { PaletteV4, defaultPaletteRecipe } from '../src/workbench/palettes/palette_controls.js';
import { PaletteRecipeModel } from '../src/workbench/palettes/palette_recipe_model.js';
import { captureConsole } from './helpers/fake_console.js';

const handler = pageHandlers(new URL('../src/workbench/palettes/palettes_page.js', import.meta.url));

test('effect recipe changes retain arrow navigation until blur or pointer selection', () => {
  const select = fakeElement('select');
  const loaded = [];
  handler('buildEffectRecipePresets', {
    document: {getElementById: () => select, createElement: fakeElement},
    effectPalettePresets: [{name: 'First', recipe: 1}, {name: 'Second', recipe: 2}],
    loadRecipe: recipe => loaded.push(recipe),
  })();
  for (const value of ['0', '1']) {
    select.value = value;
    select.dispatch('change');
    assert.equal(select.value, value);
  }
  assert.deepEqual(loaded, [1, 2]);
  select.dispatch('blur');
  assert.equal(select.value, '');
  select.value = '1';
  select.dispatch('pointerdown');
  assert.equal(select.value, '');
});

test('tab switches rebuild the palette when browser URL updates are refused', () => {
  for (const refused of [false, true]) {
    const button = fakeElement();
    button.dataset.tab = 'generative';
    const panel = fakeElement();
    panel.id = 'tab-content-generative';
    const outgoingButton = fakeElement();
    outgoingButton.dataset.tab = 'procedural';
    outgoingButton.classList.add('active');
    outgoingButton.setAttribute('aria-selected', 'true');
    outgoingButton.tabIndex = 0;
    const outgoingPanel = fakeElement();
    outgoingPanel.id = 'tab-content-procedural';
    outgoingPanel.classList.add('active');
    outgoingPanel.hidden = false;
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
        querySelectorAll: selector => selector === '.tab-btn'
          ? [button, outgoingButton] : [panel, outgoingPanel],
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
    assert.equal(button.classList.contains('active'), true);
    assert.equal(button.getAttribute('aria-selected'), 'true');
    assert.equal(panel.hidden, false);
    assert.equal(panel.classList.contains('active'), true);
    assert.equal(outgoingButton.classList.contains('active'), false);
    assert.equal(outgoingButton.getAttribute('aria-selected'), 'false');
    assert.equal(outgoingButton.tabIndex, -1);
    assert.equal(outgoingPanel.classList.contains('active'), false);
    assert.equal(outgoingPanel.hidden, true);
    assert.equal(context.activeTab, 'generative');
  }
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


test('base hue rounding wraps the full turn without changing slider precision', () => {
  const input = {};
  const readout = {};
  handler('renderBaseHue', {recipeModel: {baseHueTurns: 359.9999 / 360},
    PALETTE_CONTROL_IDS: {baseHueDegrees: 'hue'},
    document: {getElementById: id => id === 'hue' ? input : readout}})();
  assert.equal(readout.textContent, '0°');
  assert.equal(Number(input.value), 359.9999);
});
