import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import { fakeElement } from './helpers/fake_dom.js';
import { replaceUrl } from '../src/shared/url.js';
import { PaletteV4, defaultPaletteRecipe } from '../src/workbench/palettes/palette_controls.js';
import { PaletteRecipeModel } from '../src/workbench/palettes/palette_recipe_model.js';
import { captureConsole } from './helpers/fake_console.js';

const handler = pageHandlers(new URL('../src/workbench/palettes/palettes_page.js', import.meta.url));

for (const end of ['minimum', 'maximum']) {
  test(`an axis ${end} edit keeps the opposite endpoint and refreshes the controls`, () => {
    const writes = [];
    const context = {
      recipeModel: {
        axisEndpoints: () => ({minimum: 0.2, maximum: 0.8}),
        setAxisEndpoints: (...args) => writes.push(args),
      },
      renderRecipeControls: () => writes.push('controls'),
      scheduleUpdate: () => writes.push('preview'),
    };
    handler('handleAxisEndpointInput', context)('chroma', end, {target: {value: '0.4'}});
    assert.deepEqual(writes, [
      end === 'minimum' ? ['chroma', 0.4, 0.8] : ['chroma', 0.2, 0.4],
      'controls', 'preview',
    ]);
  });
}

test('an engine halt disposes the hue wheel and disables the palette controls once', () => {
  const controls = [fakeElement('input'), fakeElement('select')];
  const calls = [];
  const engineTrapped = handler('engineTrapped', {
    engineHalted: false,
    wasmModule: {},
    paletteOps: {},
    standDownIfHalted: (error, module, standDown) => {
      assert.ok(module);
      standDown(error.message);
      return true;
    },
    hueKeyWheel: { dispose: () => calls.push('wheel disposed') },
    scheduleUpdate: { cancel: () => calls.push('update cancelled') },
    scheduleViewportRedraw: { cancel: () => calls.push('redraw cancelled') },
    document: { querySelectorAll: () => controls },
    setPaletteOps: (ops) => assert.equal(ops, null),
    showFatalError: (message) => calls.push(message),
  });

  assert.equal(engineTrapped(new Error('engine halted')), true);
  assert.ok(controls.every((control) => control.disabled));
  assert.equal(engineTrapped(new Error('repeat')), true);
  assert.deepEqual(calls, ['wheel disposed', 'update cancelled', 'redraw cancelled', 'engine halted']);
});

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

function tabSwitchRig(refused) {
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
  return {button, panel, outgoingButton, outgoingPanel, updated, urls, replaced, captured, context};
}

test('tab switches rebuild the palette when browser URL updates are refused', () => {
  for (const refused of [false, true]) {
    const {updated, urls, replaced, captured} = tabSwitchRig(refused);
    assert.deepEqual(urls, ['https://example.test/tools/palettes.html?tab=generative']);
    assert.equal(replaced, !refused);
    assert.deepEqual(captured.messages, refused ? ['URL update skipped: Error: rate limit'] : []);
    assert.equal(updated, 1);
  }
});

test('tab switches synchronize tab and panel ARIA state', () => {
  for (const refused of [false, true]) {
    const {button, panel, outgoingButton, outgoingPanel, context} = tabSwitchRig(refused);
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
  let scheduled = 0;
  const context = {
    hueKeyWheel: { clearStatus: () => { status.textContent = ''; } },
    recipeModel, scheduleUpdate: () => { scheduled++; },
    renderRecipeControls: () => { rendered = recipeModel.reading('domain'); },
  };
  const recipe = defaultPaletteRecipe();
  recipe.domain = PaletteV4.domain.MIRROR;
  handler('loadRecipe', context)(recipe);
  assert.equal(status.textContent, '');
  assert.equal(rendered, 'MIRROR');
  assert.equal(scheduled, 1);
});


test('base hue rounding wraps the full turn without changing slider precision', () => {
  const input = fakeElement('input');
  const readout = {};
  handler('renderBaseHue', {recipeModel: {baseHueTurns: 359.9999 / 360},
    PALETTE_CONTROL_IDS: {baseHueDegrees: 'hue'},
    document: {getElementById: id => id === 'hue' ? input : readout}})();
  assert.equal(readout.textContent, '0°');
  assert.equal(input.getAttribute('aria-valuetext'), '0°');
  assert.equal(Number(input.value), 359.9999);
});

test('recipe sliders expose the formatted visual readout as their accessible value', () => {
  const elements = new Map();
  const context = {
    document: { getElementById: (id) => {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    } },
    PALETTE_CONTROL_IDS: { sweepTurns: 'sweep', offset: 'offset', span: 'span' },
    RECIPE_SLIDER_DEFINITIONS: [
      { reading: 'spreadTurns', id: 'spread', scale: 360, digits: 1, suffix: '°' },
    ],
    recipeModel: {
      reading: (reading) => reading === 'spreadTurns' ? 0.07 : '',
      window: { offset: 0.23456, span: 0.45678 },
    },
  };
  handler('renderRecipeSliders', context)();
  handler('renderRecipeWindow', context)();

  for (const [id, readoutId, formatted] of [
    ['spread', 'spread_value', '25.2°'],
    ['offset', 'gen_offset_value', '0.235'],
    ['span', 'gen_span_value', '0.457'],
  ]) {
    assert.equal(elements.get(id).getAttribute('aria-valuetext'), formatted);
    assert.equal(elements.get(readoutId).textContent, formatted);
  }
});
