import { test } from "node:test";
import { withPreset } from "../helpers/chain_study.js";
import assert from "node:assert/strict";
import { scratchChainDocument } from "../../src/workbench/shader/chain_document_store.js";
import { CATALOG, makeStrip, chips, chipByLabel, bandFor, paletteOf, labels, paramsOf, rowFor, controlIn } from "../helpers/chain_strip_harness.js";
import { dragGeometry, dragPointer } from "./fixture.js";

test('the Palette card keeps palette controls and Color stages own modulation controls', async () => {
  const h = await makeStrip({ writeThrough: true });
  const groups = () => paramsOf(h, 'colorize').querySelectorAll('.chain-param-group');
  assert.deepEqual(groups().filter((group) => !group.hidden)
    .map((group) => group.getAttribute('aria-label')),
  ['Palette', 'Color mapping', 'Brightness & opacity']);
  assert.deepEqual(paramsOf(h, 'modulation').querySelectorAll('.chain-param-group')
    .filter((group) => !group.hidden).map((group) => group.getAttribute('aria-label')),
  ['Modulation', 'Noise']);
  const scale = rowFor(h, 'modulation', 'modulation.pattern-scale');
  const speed = rowFor(h, 'modulation', 'modulation.pattern-speed');
  assert.equal(scale.parentNode.getAttribute('aria-label'), 'Noise');
  assert.equal(controlIn(scale).getAttribute('aria-label'), 'Noise scale (frequency)');
  assert.equal(controlIn(speed).getAttribute('aria-label'), 'Noise speed');
  for (const field of ['pattern-scale', 'pattern-speed', 'pattern-noise-variant'])
    assert.equal(rowFor(h, 'modulation', `modulation.${field}`).hidden, false, field);
  for (const field of ['sine-frequency', 'interference-frequency', 'grid-frequency',
    'pattern-contrast', 'pattern-noise-basis']) {
    const row = rowFor(h, 'modulation', `modulation.${field}`);
    assert.equal(row.hidden, true, field);
    assert.equal(row.querySelector('.chain-param-note'), null, field);
  }
  for (const [field, value] of [['pattern-scale', '2'], ['pattern-speed', '0.0004']]) {
    const control = controlIn(rowFor(h, 'modulation', `modulation.${field}`));
    control.value = field === 'pattern-scale' ? String(Math.log2(Number(value))) : value;
    control.dispatch('input');
    control.dispatch('change');
    assert.equal(h.store.document().preset_bank.presets[0].values[`modulation.${field}`],
      Number(value));
  }
});

test('Color stages reveal their selected source and retain settings while disabled', async () => {
  const h = await makeStrip({ writeThrough: true });
  const edit = (field, value) => {
    if (field === 'modulation-enabled') {
      const control = h.container.querySelectorAll('.chain-modulation-enabled').find((node) => node.dataset.label === 'modulation');
      if ((control.getAttribute('aria-pressed') === 'false') !== (value === 'enabled'))
        control.dispatch('click');
      return;
    }
    const control = controlIn(rowFor(h, 'modulation', `modulation.${field}`));
    control.value = value;
    control.dispatch('change');
  };
  const enabled = chipByLabel(h, 'modulation').querySelector('.chain-modulation-enabled');
  assert.equal(enabled.tagName, 'BUTTON');
  assert.equal(enabled.classList.contains('chain-chip-bypass'), true);
  assert.equal(enabled.textContent, chipByLabel(h, 'lens').querySelector('.chain-chip-bypass').textContent);
  assert.equal(enabled.getAttribute('aria-pressed'), 'false');
  const noiseScale = controlIn(rowFor(h, 'modulation', 'modulation.pattern-scale')).value;
  for (const [source, shown, hidden] of [
    ['directional-sine', 'sine-frequency', 'interference-frequency'],
    ['sphere-interference', 'interference-frequency', 'grid-frequency'],
    ['sphere-smooth-grid', 'grid-frequency', 'sine-frequency'],
    ['noise', 'pattern-scale', 'interference-frequency'],
  ]) {
    edit('modulation-source', source);
    assert.equal(rowFor(h, 'modulation', `modulation.${shown}`).hidden, false);
    assert.equal(rowFor(h, 'modulation', `modulation.${hidden}`).hidden, true);
  }
  assert.equal(controlIn(rowFor(h, 'modulation', 'modulation.pattern-scale')).value, noiseScale);
  edit('modulation-enabled', 'disabled');
  assert.equal(rowFor(h, 'modulation', 'modulation.modulation-enabled'), undefined);
  assert.equal(h.container.querySelector('.chain-modulation-enabled').getAttribute('aria-pressed'), 'true');
  assert.equal(rowFor(h, 'modulation', 'modulation.modulation-source').hidden, true);
  assert.equal(rowFor(h, 'modulation', 'modulation.pattern-scale').hidden, true);
  assert.equal(h.store.undo(), true);
  h.strip.render();
  assert.equal(rowFor(h, 'modulation', 'modulation.pattern-scale').hidden, false);
  assert.equal(controlIn(rowFor(h, 'modulation', 'modulation.pattern-scale')).value, noiseScale);
  chipByLabel(h, 'modulation').dispatch('keydown', {key: 'b'});
  assert.equal(h.store.document().preset_bank.presets[0].values['modulation.modulation-enabled'], 'disabled');
  assert.equal(h.container.querySelector('.chain-modulation-enabled').getAttribute('aria-pressed'), 'true');
  assert.equal(h.store.bypassedLabels().includes('modulation'), false);
  chipByLabel(h, 'modulation').dispatch('keydown', {key: 'b'});
  assert.equal(h.container.querySelector('.chain-modulation-enabled').getAttribute('aria-pressed'), 'false');
  edit('pattern-noise-variant', 'octave-contour');
  assert.equal(rowFor(h, 'modulation', 'modulation.pattern-contrast').hidden, false);
  assert.equal(rowFor(h, 'modulation', 'modulation.pattern-noise-basis').hidden, false);
  edit('modulation-source', 'displacement');
  assert.equal(rowFor(h, 'modulation', 'modulation.pattern-scale').hidden, true);
  assert.equal(rowFor(h, 'modulation', 'modulation.modulation-amount').hidden, false);
});

test('disabled modulation stages expose bypass styling and accessible state across synchronization', async () => {
  const h = await makeStrip({writeThrough: true});
  const check = (disabled) => {
    const chip = chipByLabel(h, 'modulation');
    assert.equal(chip.classList.contains('chain-chip--bypassed'), disabled);
    assert.equal(chip.getAttribute('aria-label').endsWith(', bypassed'), disabled);
    assert.equal(chip.querySelector('.chain-modulation-enabled').getAttribute('aria-pressed'), String(disabled));
  };
  check(false);
  chipByLabel(h, 'modulation').querySelector('.chain-modulation-enabled').dispatch('click');
  check(true);
  assert.deepEqual(h.store.bypassedLabels(), []);
  h.strip.render();
  check(true);
  h.strip.syncParameterValues({'modulation.modulation-enabled': 'enabled'});
  check(false);
  h.strip.syncParameterValues({'modulation.modulation-enabled': 'disabled'});
  check(true);
});

test('Noise scale follows the sampling limit without replacing its controls', async () => {
  const h = await makeStrip({ writeThrough: true });
  const row = rowFor(h, 'modulation', 'modulation.pattern-scale');
  const slider = controlIn(row);
  const readout = row.querySelector('.chain-param-value');
  assert.equal(slider.max, '3');
  assert.equal(readout.max, '8');
  readout.value = '20';
  readout.dispatch('change');
  assert.equal(h.store.document().preset_bank.presets[0].values['modulation.pattern-scale'], 8);
  const evaluation = controlIn(rowFor(h, 'modulation', 'modulation.modulation-evaluation'));
  evaluation.value = 'direct';
  evaluation.dispatch('change');
  assert.equal(slider.max, '6');
  assert.equal(readout.max, '64');
  slider.value = '5';
  slider.dispatch('input');
  slider.dispatch('change');
  assert.equal(h.store.document().preset_bank.presets[0].values['modulation.pattern-scale'], 32);
  assert.ok(controlIn(rowFor(h, 'modulation', 'modulation.pattern-scale')) === slider);
});

test('modulation strength follows the selected mechanic range', async () => {
  const h = await makeStrip();
  const amount = rowFor(h, 'modulation', 'modulation.modulation-amount');
  const control = controlIn(rowFor(h, 'modulation', 'modulation.modulation-mechanic'));
  for (const [mechanic, minimum, maximum] of [
    ['opacity', '0', '1'], ['positive-lightness-lift', '0', '1'], ['hue-rotation', '-4', '4'],
  ]) {
    control.value = mechanic;
    control.dispatch('change');
    assert.equal(controlIn(amount).min, minimum);
    assert.equal(controlIn(amount).max, maximum);
    assert.equal(amount.querySelector('.chain-param-value').max, maximum);
  }
});

test('the Color container adds, reorders, and removes modulation stages with undo', async () => {
  const source = withPreset(scratchChainDocument(CATALOG), 'second');
  const h = await makeStrip({source});
  const stages = () => bandFor(h, 'color').querySelectorAll('.chain-chip');
  const add = () => {
    const button = bandFor(h, 'color').querySelector('.chain-band-add');
    assert.equal(button.getAttribute('aria-haspopup'), null);
    const before = stages().length;
    button.dispatch('click');
    assert.equal(stages().length, before + 1);
    assert.equal(paletteOf(h), null);
    const added = h.store.chain().at(-1);
    assert.equal(added.operator, 'color.modulate.v1');
    assert.equal(h.store.selectedLabel(), added.label);
    assert.equal(h.doc.activeElement.dataset.label, added.label);
    assert.equal(chipByLabel(h, added.label).classList.contains('chain-chip--expanded'), true);
  };
  assert.equal(bandFor(h, 'color').querySelector('.chain-band-title').textContent, 'Color');
  assert.equal(stages().length, 0);
  add();
  add();
  assert.equal(stages().length, 2);
  assert.equal(h.container.querySelectorAll('.chain-modulation-enabled').length, 2);
  assert.equal(h.container.querySelectorAll('.chain-param').some((row) =>
    row.dataset.parameter.endsWith('.modulation-enabled')), false);
  assert.equal(chips(h).length, source.descriptor.chain.length + 2);
  const [first, second] = h.store.chain().slice(-2);
  assert.notEqual(first.label, second.label);
  const presets = h.store.document().preset_bank.presets;
  for (const [index, preset] of presets.entries()) {
    assert.equal(h.store.setPresetValues(preset.preset_id, {
      [`${first.label}.modulation-source`]: 'displacement',
      [`${first.label}.modulation-evaluation`]: 'direct',
      [`${first.label}.modulation-amount`]: 0.25 + index,
      [`${second.label}.modulation-amount`]: -0.5 - index,
    }).ok, true);
  }
  h.strip.render();
  assert.equal(rowFor(h, first.label, `${first.label}.pattern-scale`).hidden, true);
  assert.equal(rowFor(h, first.label, `${first.label}.modulation-evaluation`).hidden, true);
  const before = h.store.document();
  chipByLabel(h, second.label).dispatch('keydown', {key: 'ArrowUp', altKey: true});
  assert.deepEqual(h.store.chain().slice(-2), [second, first]);
  assert.deepEqual(h.store.document().preset_bank.presets, before.preset_bank.presets);
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(h.store.document(), before);
  stages()[0].querySelector('.chain-chip-remove').dispatch('click');
  assert.equal(stages().length, 1);
  assert.equal(h.store.document().preset_bank.presets.some((preset) =>
    Object.keys(preset.values).some((id) => id.startsWith(`${first.label}.`))), false);
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(h.store.document(), before);
  assert.equal(h.applied.length, 6);
});

test('Color stage headers click to toggle panels and drag to reorder within Color', async () => {
  const h = await makeStrip();
  bandFor(h, 'color').querySelector('.chain-band-add').dispatch('click');
  const [first, second] = h.store.chain().slice(-2);
  chipByLabel(h, first.label).querySelector('.chain-chip-header').dispatch('click');
  assert.equal(chipByLabel(h, first.label).classList.contains('chain-chip--expanded'), true);
  assert.equal(chipByLabel(h, 'colorize').classList.contains('chain-chip--expanded'), false);
  dragGeometry(h, 'color', [first.label, second.label]);
  const stages = bandFor(h, 'color').querySelectorAll('.chain-chip');
  const before = h.store.document();
  const header = stages[0].querySelector('.chain-chip-header');
  header.dispatch('pointerdown', dragPointer(25));
  header.dispatch('pointermove', dragPointer(100));
  assert.equal(stages[0].classList.contains('chain-chip--dragging'), true);
  assert.equal(stages[1].classList.contains('chain-chip--drop-after'), true);
  header.dispatch('pointerup', dragPointer(100));
  assert.deepEqual(h.store.chain().slice(-2), [second, first]);
  assert.deepEqual(h.store.document().preset_bank.presets, before.preset_bank.presets);
  assert.equal(h.doc.activeElement.dataset.label, first.label);
  assert.equal(chipByLabel(h, first.label).querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  header.dispatch('click');
  assert.equal(chipByLabel(h, first.label).classList.contains('chain-chip--expanded'), true);
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(h.store.document(), before);
  chipByLabel(h, first.label).querySelector('.chain-chip-header').dispatch('click');
  assert.equal(chipByLabel(h, first.label).classList.contains('chain-chip--expanded'), false);
});

test('the inline controls keep their own keys', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').dispatch('click');
  const slider = controlIn(rowFor(h, 'camera', 'camera.wander'));

  const right = slider.dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(right.defaultPrevented, false,
    'a slider’s own arrow keys are not the strip’s chip roving');
  slider.dispatch('keydown', { key: 'Delete' });
  assert.deepEqual(labels(h),
    ['camera', 'lens', 'project', 'warp2', 'sample', 'colorize', 'modulation']);

});
