import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { scratchChainDocument } from "../../src/workbench/shader/chain_document_store.js";
import { CATALOG, BASE, makeStrip, chips, chipByLabel, bandFor } from "../helpers/chain_strip_harness.js";
import { STUDY_CHAIN, withPreset } from "../helpers/chain_study.js";
import { compileShaderDocument } from "../../generated/shader/shader_workbench.mjs";
import { PROJECT, SAMPLE, operatorName } from "./fixture.js";

test('the strip opens a shipped pattern with one chip per stage', async () => {
  const shipped = compileShaderDocument(readFileSync(
    new URL("../../generated/shader/patterns/kaleidoscope_hex_bright.shader.json", import.meta.url), 'utf8'),
  { catalog: CATALOG });
  assert.equal(shipped.status, 'VALID');
  const h = await makeStrip({ source: structuredClone(shipped.document) });
  assert.deepEqual(chips(h).map((chip) => chip.dataset.label),
    shipped.document.descriptor.chain.map((entry) => entry.label));
});

test('a budget-exhausted chain offers no band insertion buttons', async () => {
  const catalog = structuredClone(CATALOG);
  catalog.budgets.max_chain_ops = BASE.document.descriptor.chain.length;
  const harness = await makeStrip({catalog});
  assert.equal(harness.container.querySelectorAll('.chain-band-add').length, 0);
});

test('the strip lays the chain out as editable carrier bands with sockets between them', async () => {
  const h = await makeStrip();
  const strip = h.container.querySelector('.chain-strip');
  assert.equal(strip.getAttribute('role'), null);
  assert.equal(strip.getAttribute('aria-label'), null);
  assert.equal(strip.parentNode.getAttribute('aria-label'), 'Scrollable shader chain');

  const bands = strip.querySelectorAll('.chain-band');
  assert.deepEqual(bands.map((band) => band.dataset.carrier),
    ['sphere', 'plane', 'field', 'color']);
  assert.deepEqual(bands.map((band) => band.getAttribute('aria-label')),
    ['Sphere stages', 'Plane stages', 'Field stages', 'Color stages']);
  for (const band of bands) {
    assert.equal(band.getAttribute('role'), 'group');
    assert.equal(band.querySelector('.chain-band-title').getAttribute('aria-hidden'),
      'true');
  }
  assert.deepEqual(
    bands.map((band) => band.querySelectorAll('.chain-chip').map((c) => c.dataset.label)),
    [['camera', 'lens'], ['warp2'], [], ['modulation']]);

  const sockets = strip.children.filter(
    (child) => child.classList?.contains('chain-chip--socket'));
  assert.deepEqual(sockets.map((socket) => socket.dataset.label),
    ['project', 'sample', 'colorize'],
    'a crossing sits between the two bands it joins');

  const all = chips(h);
  assert.equal(all.length, STUDY_CHAIN.length);
  // Groups, not listbox options: an option's children are presentational.
  for (const chip of all) {
    assert.equal(chip.getAttribute('role'), 'group');
    assert.equal(chip.getAttribute('aria-selected'), null);
  }
  const camera = chipByLabel(h, 'camera');
  const rotate = operatorName('camera');
  assert.equal(camera.getAttribute('aria-label'), `${rotate} · camera`);
  assert.equal(camera.querySelector('.chain-chip-name').textContent, rotate);
  assert.match(chipByLabel(h, 'project').getAttribute('aria-label'),
    /, sphere to plane$/);

  // One roving-tabindex stop and a + only where an insertion is legal.
  assert.deepEqual(all.filter((chip) => chip.getAttribute('tabindex') === '0')
    .map((chip) => chip.dataset.label), ['camera']);
  assert.equal(h.container.querySelectorAll('.chain-band-add').length, 4,
    'each band carries one + insertion control');
  assert.deepEqual(bands.map((band) => band.querySelector('.chain-band-add')
    ?.getAttribute('aria-label') ?? null),
  ['Add a Sphere stage', 'Add a Plane stage', 'Add a Field stage', 'Add a Color stage']);
});

test('endomorphisms carry controls; sockets carry only valid selectors', async () => {
  const h = await makeStrip();
  for (const label of ['camera', 'lens', 'warp2']) {
    const chip = chipByLabel(h, label);
    assert.ok(chip.querySelector('.chain-chip-remove'), `${label} carries ✕`);
    assert.ok(chip.querySelector('.chain-chip-bypass'), `${label} carries bypass`);
    assert.equal(chip.querySelector('.chain-chip-replace'), null);
    assert.equal(chip.querySelector('.chain-chip-name').textContent.length > 0,
      true, `${label} names its operator`);
  }
  for (const label of ['project', 'sample', 'colorize']) {
    const chip = chipByLabel(h, label);
    assert.equal(chip.querySelector('.chain-chip-remove'), null,
      'removal across a crossing is illegal by construction, so no ✕');
    assert.equal(chip.querySelector('.chain-chip-bypass'), null);
    assert.ok(chip.querySelector('.chain-chip-replace'));
    assert.equal(chip.querySelector('.chain-chip-name'), null);
    assert.ok(chip.querySelector('.chain-chip-function-label'),
      'a crossing names its function, never its instance');
  }
  for (const [label, text, accessibleName] of [
    ['project', 'Projection: ', 'Projection'],
    ['sample', 'Source: ', 'Source function'],
    ['colorize', 'Palette: ', 'Palette'],
  ]) {
    const functionLabel = chipByLabel(h, label)
      .querySelector('.chain-chip-function-label');
    assert.equal(functionLabel.childNodes[0], text);
    assert.equal(functionLabel.querySelector('.chain-chip-replace')
      .getAttribute('aria-label'), accessibleName);
  }
  const remove = chipByLabel(h, 'lens').querySelector('.chain-chip-remove');
  assert.equal(remove.textContent, '×');
  assert.match(remove.getAttribute('aria-label'), /^Remove .+ · lens$/);
  const controls = chipByLabel(h, 'camera').querySelector('.chain-chip-header')
    .querySelectorAll('button');
  assert.deepEqual(controls.map((button) => button.textContent), ['◉', '', '', '×']);
});

for (const operator of ['sample.spherical-noise.v1', 'sample.spherical-cells.v1']) {
  test(`${operator} replaces projection and planar warps with one undoable source selection`, async () => {
    assert.ok(CATALOG.operators.some((candidate) => candidate.id === operator));
    const h = await makeStrip();
    const before = h.store.document();
    const source = chipByLabel(h, 'sample').querySelector('.chain-chip-replace');
    const spherical = source.querySelectorAll('optgroup')
      .find((group) => group.label === 'Spherical sources');
    assert.deepEqual(spherical.children.map((option) => option.value),
      CATALOG.operators.filter((candidate) => candidate.input === 'sphere'
        && candidate.output === 'field').map((candidate) => candidate.id));
    assert.equal(Boolean(chipByLabel(h, 'sample').querySelector('.chain-source-scope')), false);
    assert.equal(source.value, 'planar:twin-wave');
    source.value = operator;
    source.dispatch('change');

    assert.deepEqual(h.store.chain().map((entry) => entry.operator), [
      ...before.descriptor.chain.slice(0, PROJECT).map((entry) => entry.operator),
      operator,
      ...before.descriptor.chain.slice(SAMPLE + 1).map((entry) => entry.operator),
    ]);
    assert.deepEqual(h.container.querySelectorAll('.chain-band').map((band) => band.dataset.carrier),
      ['sphere', 'field', 'color']);
    assert.equal(chipByLabel(h, 'project'), undefined);
    assert.equal(chipByLabel(h, 'warp2'), undefined);
    assert.equal(h.container.querySelectorAll('.chain-chip-replace')
      .some((select) => select.getAttribute('aria-label') === 'Projection'), false);
    assert.equal(h.applied.length, 1);
    const after = h.store.document();
    assert.deepEqual(h.store.compile().status, 'VALID');
    const active = h.store.chain().find((entry) => entry.operator === operator);
    assert.equal(chipByLabel(h, active.label).querySelector('.chain-chip-replace').value, operator);

    h.container.querySelector('.chain-undo').dispatch('click');
    assert.deepEqual(h.store.document(), before);
    assert.ok(chipByLabel(h, 'project'));
    assert.ok(chipByLabel(h, 'warp2'));
    assert.ok(bandFor(h, 'plane'));
    h.container.querySelector('.chain-redo').dispatch('click');
    assert.deepEqual(h.store.document(), after);
    assert.equal(bandFor(h, 'plane'), undefined);
  });
}

test('a spherical source selector can restore a planar route and undo it', async () => {
  const source = scratchChainDocument(CATALOG, [
    { label: 'camera', operator: 'sphere.rotate.v2' },
    { label: 'source', operator: 'sample.spherical-noise.v1' },
    { label: 'colorize', operator: 'colorize.generated-palette.v4' },
  ]);
  const h = await makeStrip({source});
  const before = h.store.document();
  const select = chipByLabel(h, 'source').querySelector('.chain-chip-replace');
  const key = 'project.equirectangular.v2 sample.spiral.v3';
  const planar = select.querySelectorAll('optgroup').find((group) => group.label === 'Planar sources');
  assert.ok(planar.children.some((option) => option.value === key));
  select.value = key;
  select.dispatch('change');
  assert.deepEqual(h.store.chain().map((entry) => entry.operator), [
    'sphere.rotate.v2', 'project.equirectangular.v2', 'sample.spiral.v3',
    'colorize.generated-palette.v4',
  ]);
  assert.ok(bandFor(h, 'plane'));
  assert.equal(h.container.querySelectorAll('.chain-chip-replace')
    .some((control) => control.getAttribute('aria-label') === 'Projection'), true);
  assert.equal(h.store.compile().status, 'VALID');
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(h.store.document(), before);
  assert.equal(bandFor(h, 'plane'), undefined);
});

test('each card exposes a named reset control without expanding or selecting it', async () => {
  const source = structuredClone(BASE.document);
  const wander = source.descriptor.parameters.find((parameter) => parameter.id === 'camera.wander');
  source.preset_bank.presets[0].values['camera.wander'] = wander.domain.maximum;
  const h = await makeStrip({ source });
  for (const chip of chips(h)) {
    const reset = chip.querySelector('.chain-chip-reset');
    assert.ok(reset);
    assert.match(reset.getAttribute('aria-label'), /parameters to defaults$/);
    assert.equal(reset.querySelector('.chain-chip-reset-icon').getAttribute('aria-hidden'), 'true');
  }
  chipByLabel(h, 'camera').querySelector('.chain-chip-reset').dispatch('click');
  assert.equal(h.store.selectedLabel(), null);
  assert.equal(chipByLabel(h, 'camera').classList.contains('chain-chip--expanded'), false);
  assert.equal(h.doc.activeElement, chipByLabel(h, 'camera').querySelector('.chain-chip-reset'));
});

test('a card reset restores only the active preset and is one undoable action', async () => {
  const source = withPreset(structuredClone(BASE.document), 'other');
  const h = await makeStrip({ source, presetId: 'other' });
  assert.equal(h.store.setPresetValues('other', {
    'camera.wander': 0.5, 'camera.spin-speed': 0.01, 'lens.symmetry': 'tetrahedral',
  }).ok, true);
  h.strip.render();
  const before = h.store.document();
  const defaults = Object.fromEntries(h.store.parameterDeclarations()
    .filter((parameter) => parameter.id.startsWith('camera.') && h.store.declares(parameter.id))
    .map((parameter) => [parameter.id, parameter.default]));
  chipByLabel(h, 'camera').querySelector('.chain-chip-reset').dispatch('click');
  const after = h.store.document();
  assert.deepEqual(after.preset_bank.presets[0], before.preset_bank.presets[0]);
  const otherValues = (document) => document.preset_bank.presets
    .find((preset) => preset.preset_id === 'other').values;
  assert.deepEqual(otherValues(after), { ...otherValues(before), ...defaults });
  assert.equal(h.applied.length, 1);
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(h.store.document(), before);
  h.container.querySelector('.chain-redo').dispatch('click');
  assert.deepEqual(h.store.document(), after);
});

test('a card reset leaves baked parameters unchanged', async () => {
  const h = await makeStrip({ parameterLive: (id) => id === 'camera.wander' });
  assert.equal(h.store.setPresetValue(BASE.document.preset_bank.presets[0].preset_id,
    'camera.wander', 0.5).ok, true);
  h.strip.render();
  const before = h.store.document().preset_bank.presets[0].values;
  const initial = h.store.parameterDeclarations().find((parameter) => parameter.id === 'camera.wander').default;
  assert.equal(chipByLabel(h, 'lens').querySelector('.chain-chip-reset').disabled, true);
  chipByLabel(h, 'camera').querySelector('.chain-chip-reset').dispatch('click');
  assert.deepEqual(h.store.document().preset_bank.presets[0].values,
    { ...before, 'camera.wander': initial });
});
