import { test } from "node:test";
import assert from "node:assert/strict";
import { scratchChainDocument } from "../../src/workbench/shader/chain_document_store.js";
import { deactivatedParameterIds } from "../../src/workbench/shader/chain_presentation.js";
import { CATALOG, BASE, runFrame, makeStrip, chipByLabel, paletteOf, lastAnnounced, paramsOf, rowsOf, rowFor, controlIn } from ".././helpers/chain_strip_harness.js";

test('syncHistory repaints Undo and Redo without rebuilding the strip', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').dispatch('click');
  const chip = chipByLabel(h, 'camera');
  assert.equal(h.container.querySelector('.chain-undo').disabled, true);

  h.store.setPresetValue(BASE.document.preset_bank.presets[0].preset_id, 'camera.wander', 0.5);
  h.strip.syncHistory();

  assert.equal(h.container.querySelector('.chain-undo').disabled, false);
  assert.equal(chipByLabel(h, 'camera'), chip, 'no rebuild: the chips are the same');
});

test('history buttons retain focus while enabled and fall back to a chip at exhaustion', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').dispatch('click');
  for (const value of [0.2, 0.3]) {
    h.store.setPresetValue(BASE.document.preset_bank.presets[0].preset_id, 'camera.wander', value);
    h.store.endValueRun();
  }
  h.strip.syncHistory();
  const undo = h.container.querySelector('.chain-undo');
  undo.focus();
  undo.dispatch('click');
  assert.equal(h.doc.activeElement, h.container.querySelector('.chain-undo'));
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.equal(h.doc.activeElement, chipByLabel(h, 'camera'));
  h.container.querySelector('.chain-redo').dispatch('click');
  assert.equal(h.doc.activeElement, h.container.querySelector('.chain-redo'));
  h.container.querySelector('.chain-redo').dispatch('click');
  assert.equal(h.doc.activeElement, chipByLabel(h, 'camera'));
});

// The union-schema rule reads the document's declarations and the preset values
// that gate them.
test('deactivatedParameterIds follows the engine topology gates', () => {
  const parameters = [
    { id: 'sample.coverage-mode', storage: 'enum8' },
    { id: 'sample.edge-width', storage: 'binary32' },
    { id: 'warp1.envelope', storage: 'enum8' },
    { id: 'warp1.edge-width', storage: 'binary32' },
    { id: 'camera.wander', storage: 'binary32' },
    { id: 'colorize.brightness-envelope', storage: 'enum8' },
    { id: 'colorize.brightness-bottom', storage: 'binary32' },
    { id: 'colorize.brightness-top', storage: 'binary32' },
  ];
  const values = {
    'sample.coverage-mode': 'weight',
    'sample.edge-width': 0.1,
    'warp1.envelope': 'edge-fade',
    'warp1.edge-width': 0.1,
    'camera.wander': 0,
    'colorize.brightness-envelope': 'none',
    'colorize.brightness-bottom': 0,
    'colorize.brightness-top': 1,
  };
  const chain = [
    { label: 'sample', operator: 'sample.grid.v4' },
    { label: 'warp1', operator: 'warp.wave-shear.v2' },
    { label: 'camera', operator: 'sphere.rotate.v2' },
    { label: 'colorize', operator: 'colorize.generated-palette.v4' },
  ];
  assert.deepEqual([...deactivatedParameterIds(parameters, values, chain, CATALOG)],
    ['sample.edge-width', 'colorize.brightness-bottom',
      'colorize.brightness-top']);
  assert.deepEqual([...deactivatedParameterIds(
    [{ id: 'sample.edge-width', storage: 'binary32' }],
    { 'sample.edge-width': 0.1 }, chain, CATALOG)],
  [], 'an unset gate field deactivates nothing');
});

test('parameter gate predicates match every catalog live value', () => {
  const gates = CATALOG.operators.flatMap(operator => operator.params
    .filter(parameter => parameter.gated_by)
    .map(parameter => ({ operator, parameter })));
  assert.ok(gates.length > 0);
  for (const { operator, parameter } of gates) {
    const gate = parameter.gated_by;
    const choices = operator.params.find(candidate => candidate.id === gate.field).values;
    const active = choices.filter((value) => {
      const result = deactivatedParameterIds([{ id: `stage.${parameter.id}` }],
        { [`stage.${gate.field}`]: value }, [{ label: 'stage', operator: operator.id }], CATALOG);
      return !result.has(`stage.${parameter.id}`);
    });
    assert.deepEqual(active, gate.values, `${operator.id}.${parameter.id}`);
  }
});

test('arrow nudges finish independent undo entries', async () => {
  const h = await makeStrip({ writeThrough: true });
  const stored = () => h.store.document().preset_bank.presets[0].values['sample.pattern-freq'];
  const initial = stored();
  const readout = () => rowFor(h, 'sample', 'sample.pattern-freq').querySelector('.chain-param-value');
  readout().dispatch('keydown', { key: 'ArrowUp' });
  const once = stored();
  readout().dispatch('keydown', { key: 'ArrowUp' });
  assert.notEqual(stored(), once);
  assert.equal(h.store.undo(), true);
  assert.equal(stored(), once);
  assert.equal(h.store.undo(), true);
  assert.equal(stored(), initial);
  assert.deepEqual(h.commits, [1, 2]);
});

test('band insertion buttons expose the open palette state', async () => {
  const h = await makeStrip();
  const add = h.container.querySelector('.chain-band-add');
  assert.equal(add.getAttribute('aria-expanded'), 'false');
  add.dispatch('click');
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  add.dispatch('pointerdown');
  add.dispatch('click');
  assert.equal(add.getAttribute('aria-expanded'), 'false');
  assert.equal(paletteOf(h), null);
  add.dispatch('click');
  assert.equal(add.getAttribute('aria-expanded'), 'true');
  h.doc.activeElement.dispatch('keydown', { key: 'Escape' });
  assert.equal(add.getAttribute('aria-expanded'), 'false');
});

test('omitted catalog fields display defaults and become undoable document edits', async () => {
  const h = await makeStrip({ writeThrough: true });
  const before = h.store.document();
  const digest = h.store.compile().descriptor_digest;
  const declaration = h.store.parameterDeclarations().find((parameter) =>
    !before.descriptor.parameters.some((authored) => authored.id === parameter.id));
  assert.ok(declaration);
  const label = declaration.id.split('.')[0];
  chipByLabel(h, label).dispatch('click');
  const row = rowsOf(h, label).find((row) => row.dataset.parameter === declaration.id);
  const readout = row.querySelector('.chain-param-value');
  assert.equal(Number(readout.value), Number(declaration.default));
  assert.deepEqual(h.store.document(), before);
  assert.equal(h.store.compile().descriptor_digest, digest);
  assert.equal(h.store.canUndo(), false);
  readout.value = String(declaration.domain.maximum);
  readout.dispatch('change');
  assert.equal(h.store.document().preset_bank.presets[0].values[declaration.id],
    declaration.domain.maximum);
  h.strip.syncHistory();
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.deepEqual(h.store.document(), before);
  assert.equal(h.store.compile().descriptor_digest, digest);
});

test('every catalog operator exposes its parameter controls without declarations', async () => {
  const crossings = CATALOG.carriers.slice(0, -1).map((carrier, index) =>
    CATALOG.operators.find((operator) => operator.input === carrier
      && operator.output === CATALOG.carriers[index + 1]));
  for (const operator of CATALOG.operators) {
    const prefix = crossings.slice(0, CATALOG.carriers.indexOf(operator.input));
    const suffix = crossings.slice(CATALOG.carriers.indexOf(operator.output));
    const chain = [...prefix, operator, ...suffix].map((stage, index) => ({
      label: index === prefix.length ? 'audit' : `stage${index}`, operator: stage.id,
    }));
    const source = scratchChainDocument(CATALOG, chain);
    source.descriptor.parameters = source.descriptor.parameters.filter(
      (parameter) => !parameter.id.startsWith('audit.'));
    source.descriptor.serialization.fields = source.descriptor.parameters.map(
      (parameter) => parameter.id);
    for (const preset of source.preset_bank.presets)
      for (const id of Object.keys(preset.values))
        if (id.startsWith('audit.')) delete preset.values[id];
    const h = await makeStrip({ source });
    const owner = 'audit';
    chipByLabel(h, owner).dispatch('click');
    const fields = operator.params.filter((field) =>
      !(operator.id === 'color.modulate.v1' && field.id === 'modulation-enabled')
      && !(operator.id === 'colorize.generated-palette.v4' && field.id === 'palette-type'));
    if (operator.id === 'colorize.generated-palette.v4')
      assert.equal(chipByLabel(h, owner).querySelector('.chain-palette-type').value, 'cycling-generated');
    assert.deepEqual(rowsOf(h, owner).filter((row) => row.dataset.parameter.startsWith('audit.')).map((row) => row.dataset.parameter).sort(),
      fields.map((field) => `audit.${field.id}`).sort(), operator.name);
    for (const field of fields) {
      const control = controlIn(rowFor(h, owner, `audit.${field.id}`));
      if (control.type === 'checkbox') assert.equal(control.checked, field.default === 'on', `${operator.name}: ${field.id}`);
      else {
        const expected = field.curve === 'log-positive' ? Math.log2(field.default) : field.default;
        assert.equal(String(control.value), String(expected), `${operator.name}: ${field.id}`);
      }
    }
    if (operator.params.length === 0)
      assert.equal(paramsOf(h, 'audit').querySelector('.chain-strip-note').textContent,
        'No adjustable parameters');
    assert.deepEqual(h.store.document(), source);
    assert.equal(h.store.canUndo(), false);
    h.strip.destroy();
  }
});

test('modulation toggles keep a stable name and announce baked controls', async () => {
  let live = true;
  const h = await makeStrip({writeThrough: true,
    parameterLive: (id) => id !== 'modulation.modulation-enabled' || live});
  const toggle = () => chipByLabel(h, 'modulation').querySelector('.chain-modulation-enabled');
  const label = `Bypass ${CATALOG.operators.find(({id}) => id === 'color.modulate.v1').name} \u00b7 modulation`;
  assert.equal(toggle().getAttribute('aria-label'), label);
  chipByLabel(h, 'modulation').dispatch('keydown', {key: 'b'});
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  assert.equal(toggle().getAttribute('aria-label'), label);
  live = false;
  h.strip.render();
  assert.equal(toggle().disabled, true);
  assert.equal(toggle().getAttribute('title'), 'This parameter is baked into the compiled build');
  const edits = h.edits.length;
  chipByLabel(h, 'modulation').dispatch('keydown', {key: 'b'});
  assert.equal(h.edits.length, edits);
  assert.equal(lastAnnounced(h), toggle().getAttribute('title'));
});

test('parameters baked into the active build cannot commit edits', async () => {
  const h = await makeStrip({ parameterLive: (id) => id !== 'sample.coverage-mode' });
  const row = rowFor(h, 'sample', 'sample.coverage-mode');
  const select = controlIn(row);
  assert.equal(select.disabled, true);
  assert.match(row.querySelector('.chain-param-note').textContent, /baked into the compiled build/);
  select.disabled = false;
  select.value = 'weight';
  select.dispatch('change');
  assert.deepEqual(h.edits, []);
  assert.equal(controlIn(rowFor(h, 'sample', 'sample.pattern-freq')).disabled, false);
});

test('header collapse stays closed while focus and the pointer remain on the tile', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const opened = chipByLabel(h, 'sample');
  opened.dispatch('mouseenter');
  const readout = rowFor(h, 'sample', 'sample.pattern-freq').querySelector('.chain-param-value');
  readout.focus();
  readout.dispatch('focusin');
  opened.querySelector('.chain-chip-header').dispatch('click');
  const closed = chipByLabel(h, 'sample');
  assert.equal(closed.classList.contains('chain-chip--expanded'), false);
  assert.equal(closed.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.activeElement, closed);
  closed.dispatch('focusin');
  closed.dispatch('mouseenter');
  closed.dispatch('keydown', { key: 'Tab' });
  assert.equal(closed.classList.contains('chain-chip--expanded'), false);
});

test('parameter and header controls keep a tile pinned without selecting it again', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const chip = chipByLabel(h, 'sample');
  const control = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  control.dispatch('click');
  control.dispatch('keydown', { key: 'Enter' });
  control.dispatch('keydown', { key: ' ' });
  assert.equal(chipByLabel(h, 'sample'), chip);
  assert.equal(chip.classList.contains('chain-chip--expanded'), true);
  assert.equal(chip.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  assert.equal(h.store.selectedLabel(), 'sample');

  chipByLabel(h, 'camera').dispatch('click');
  chipByLabel(h, 'camera').querySelector('.chain-chip-bypass').dispatch('click');
  assert.equal(chipByLabel(h, 'camera').classList.contains('chain-chip--expanded'), true);
  assert.equal(h.store.selectedLabel(), 'camera');
  const socket = chipByLabel(h, 'project');
  socket.querySelector('.chain-chip-replace').dispatch('click');
  assert.equal(socket.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(h.store.selectedLabel(), 'camera');
});

test('pointer exits, focus changes and outside presses preserve clicked tiles', async () => {
  const h = await makeStrip();
  for (const label of ['camera', 'sample']) chipByLabel(h, label).dispatch('click');
  const chip = chipByLabel(h, 'sample');
  const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  h.doc.dispatch('pointerdown', { target: slider, button: 0, pointerId: 5 });
  slider.focus();
  slider.dispatch('focusin');
  chip.dispatch('mouseleave');
  h.doc.dispatch('pointerup', { pointerId: 5 });
  h.doc.dispatch('pointercancel', { pointerId: 5 });
  h.doc.dispatch('pointerdown', { target: h.doc.body });
  slider.dispatch('focusout', { relatedTarget: chipByLabel(h, 'colorize') });
  chip.dispatch('keydown', { key: 'Escape' });
  for (const label of ['camera', 'sample']) {
    assert.equal(chipByLabel(h, label).classList.contains('chain-chip--expanded'), true);
    assert.equal(chipByLabel(h, label).querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  }
});

test('synchronized parameter values update mounted controls without changing pins', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const chip = chipByLabel(h, 'sample');
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const control = controlIn(row);
  h.strip.syncParameterValues({'sample.pattern-freq': 5.5, 'absent.parameter': 2});
  assert.equal(control.value, '5.5');
  assert.equal(row.querySelector('.chain-param-value').value, '5.5');
  assert.equal(chipByLabel(h, 'sample'), chip);
  assert.equal(chip.classList.contains('chain-chip--expanded'), true);
  assert.equal(chip.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(h.edits, []);
});

test('separate slider drags form separate undo entries', async () => {
  const h = await makeStrip({ writeThrough: true });
  for (const value of ['5.5', '6']) {
    const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
    slider.value = value;
    slider.dispatch('input');
    slider.dispatch('change');
  }
  assert.deepEqual(h.commits, [1, 2]);
  assert.equal(h.store.undo(), true);
  assert.equal(h.store.document().preset_bank.presets[0].values['sample.pattern-freq'], 5.5);
});

test('a refused slider edit closes its undo gesture before replacing the control', async () => {
  let accepted = true;
  const h = await makeStrip({writeThrough: true, acceptParameter: () => accepted});
  const drag = (value) => {
    const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
    slider.value = String(value);
    slider.dispatch('input');
    runFrame();
    return slider;
  };
  drag(5.5);
  accepted = false;
  drag(6);
  accepted = true;
  drag(7).dispatch('change');
  assert.equal(h.store.undo(), true);
  assert.equal(h.store.document().preset_bank.presets[0].values['sample.pattern-freq'], 5.5);
});

test('a refused socket replacement restores the selected operator', async () => {
  const h = await makeStrip();
  const before = h.store.document();
  h.store.replaceSpan = () => ({ ok: false, diagnostics: [{ message: 'catalog refused edit' }] });
  const select = chipByLabel(h, 'project').querySelector('.chain-chip-replace');
  select.value = 'project.bonne.v3';
  select.dispatch('change');
  assert.equal(select.value, 'project.stereographic.v2');
  assert.deepEqual(h.store.document(), before);
  assert.equal(h.applied.length, 0);
  assert.equal(lastAnnounced(h), 'catalog refused edit');
});

test('band insertion closes after pointer focusout and retains keyboard toggles', async () => {
  for (const target of ['anchor', 'null']) {
    const h = await makeStrip();
    const add = h.container.querySelector('.chain-band-add');
    add.dispatch('click');
    const option = h.doc.activeElement;
    add.dispatch('pointerdown');
    option.dispatch('focusout', {relatedTarget: target === 'anchor' ? add : null});
    add.dispatch('click');
    assert.equal(add.getAttribute('aria-expanded'), 'false', target);
    assert.equal(paletteOf(h), null);
    add.dispatch('click');
    assert.equal(add.getAttribute('aria-expanded'), 'true', 'keyboard click clears the pointer decision');
    h.doc.activeElement.dispatch('focusout', {relatedTarget: add});
    add.dispatch('click');
    assert.equal(add.getAttribute('aria-expanded'), 'false');
  }
});

test('loaded twist and glitch stages expose omitted controls and persist slider edits', async () => {
  const source = scratchChainDocument(CATALOG, [
    { label: 'twist', operator: 'sphere.lens.twist.v2' },
    { label: 'glitch', operator: 'sphere.lens.glitch.v2' },
    { label: 'project', operator: 'project.stereographic.v2' },
    { label: 'sample', operator: 'sample.grid.v4' },
    { label: 'color', operator: 'colorize.generated-palette.v4' },
  ]);
  const controls = [
    ['twist', 'sphere.lens.twist.v2', 'twist-angle', 4.5],
    ['twist', 'sphere.lens.twist.v2', 'speed', 0.035],
    ['glitch', 'sphere.lens.glitch.v2', 'polar-multiplier', 4],
    ['glitch', 'sphere.lens.glitch.v2', 'azimuth-multiplier', -2],
  ].map(([label, operator, field, value]) => [
    label, field,
    CATALOG.operators.find((entry) => entry.id === operator).params.find((param) => param.id === field).default,
    value,
  ]);
  const omitted = controls.map(([label, field]) => `${label}.${field}`);
  source.descriptor.parameters = source.descriptor.parameters.filter(
    (parameter) => !omitted.includes(parameter.id));
  source.descriptor.serialization.fields = source.descriptor.parameters.map(
    (parameter) => parameter.id);
  for (const preset of source.preset_bank.presets)
    for (const id of omitted) delete preset.values[id];
  const h = await makeStrip({ source, writeThrough: true });
  assert.deepEqual(h.store.document(), source);
  for (const [label, field, initial, value] of controls) {
    assert.notEqual(value, initial);
    chipByLabel(h, label).dispatch('click');
    const id = `${label}.${field}`;
    const slider = controlIn(rowFor(h, label, id));
    assert.equal(slider.type, 'range');
    assert.equal(Number(slider.value), initial);
    slider.value = String(value);
    slider.dispatch('input');
    runFrame();
    assert.deepEqual(h.edits.at(-1), [id, value]);
    assert.equal(h.store.document().preset_bank.presets[0].values[id], value);
    assert.ok(h.store.document().descriptor.parameters.some((parameter) => parameter.id === id));
  }
  assert.equal(h.edits.length, 4);
  assert.deepEqual(h.applied, []);
  assert.equal(h.store.compile().status, 'VALID');
});

test('Ripple random center toggles manual coordinates and follows synchronized values', async () => {
  const source = scratchChainDocument(CATALOG, [
    { label: 'ripple', operator: 'sphere.displace.ripple.v2' },
    { label: 'project', operator: 'project.stereographic.v2' },
    { label: 'sample', operator: 'sample.tessellation.v3' },
    { label: 'color', operator: 'colorize.generated-palette.v4' },
  ]);
  const h = await makeStrip({ source, writeThrough: true });
  chipByLabel(h, 'ripple').dispatch('click');
  const toggle = controlIn(rowFor(h, 'ripple', 'ripple.random-center'));
  const azimuth = rowFor(h, 'ripple', 'ripple.center-azimuth');
  const polar = rowFor(h, 'ripple', 'ripple.center-polar');
  assert.equal(toggle.type, 'checkbox');
  assert.equal(toggle.checked, true);
  assert.equal(azimuth.hidden, true);
  assert.equal(polar.hidden, true);
  toggle.checked = false;
  toggle.dispatch('change');
  assert.deepEqual(h.edits.at(-1), ['ripple.random-center', 'off']);
  assert.equal(azimuth.hidden, false);
  assert.equal(polar.hidden, false);
  h.strip.syncParameterValues({'ripple.random-center': 'on'});
  assert.equal(toggle.checked, true);
  assert.equal(azimuth.hidden, true);
  assert.equal(polar.hidden, true);
  assert.equal(h.store.compile().status, 'VALID');
});

test('the Palette selector supports every family with family-specific controls', async () => {
  const h = await makeStrip({writeThrough: true});
  const type = chipByLabel(h, 'colorize').querySelector('.chain-palette-type');
  assert.equal(rowFor(h, 'colorize', 'colorize.palette-type'), undefined);
  assert.deepEqual(type.children.map((option) => option.value),
    h.store.parameterDeclarations().find((p) => p.id === 'colorize.palette-type').domain.values);
  const visible = (field) => !rowFor(h, 'colorize', `colorize.${field}`).hidden;
  for (const [family, shown, hidden] of [
    ['generated', 'palette-harmony', 'palette-name'],
    ['procedural', 'palette-name', 'palette-harmony'],
    ['gradient', 'gradient-start-r', 'palette-name'],
    ['mutating', 'palette-name-b', 'gradient-start-r'],
    ['cycling-generated', 'palette-mode', 'palette-harmony'],
  ]) {
    type.value = family;
    type.dispatch('change');
    assert.equal(visible(shown), true, `${family}: ${shown}`);
    assert.equal(visible(hidden), false, `${family}: ${hidden}`);
    assert.equal(visible('palette-chroma'), true);
    assert.equal(visible('palette-mapping'), true);
    assert.equal(visible('value-opacity-low'), true);
    assert.equal(h.store.document().preset_bank.presets[0].values['colorize.palette-type'], family);
  }
  const colorize = h.store.document().descriptor.chain.find(({label}) => label === 'colorize');
  const operator = CATALOG.operators.find(({id}) => id === colorize.operator);
  for (const id of ['palette-harmony', 'palette-name']) {
    assert.equal(controlIn(rowFor(h, 'colorize', `colorize.${id}`)).children.length,
      operator.params.find((parameter) => parameter.id === id).values.length);
  }
  h.strip.syncParameterValues({'colorize.palette-type': 'gradient'});
  assert.equal(type.value, 'gradient');
  assert.equal(visible('gradient-start-r'), true);
  for (const stop of ['start', 'middle', 'end']) {
    for (const channel of ['r', 'g', 'b']) {
      const row = rowFor(h, 'colorize', `colorize.gradient-${stop}-${channel}`);
      const expected = `Gradient ${stop[0].toUpperCase()}${stop.slice(1)} ${channel.toUpperCase()}`;
      assert.equal(row.querySelector('.chain-param-name').textContent, expected);
      assert.equal(controlIn(row).getAttribute('aria-label'), expected);
    }
  }
});

test('a widened catalog palette gate is reflected in row visibility', async () => {
  const catalog = structuredClone(CATALOG);
  const operator = catalog.operators.find(({id}) => id === 'colorize.generated-palette.v4');
  operator.params.find(({id}) => id === 'palette-hue').gated_by.values.push('gradient');
  const h = await makeStrip({catalog, writeThrough: true});
  const type = chipByLabel(h, 'colorize').querySelector('.chain-palette-type');
  type.value = 'gradient';
  type.dispatch('change');
  assert.equal(rowFor(h, 'colorize', 'colorize.palette-hue').hidden, false);
  assert.equal(rowFor(h, 'colorize', 'colorize.palette-spread').hidden, true);
});

test('resetting declared defaults leaves the document and undo application untouched', async () => {
  const h = await makeStrip();
  const preset = h.store.document().preset_bank.presets[0].preset_id;
  const defaults = Object.fromEntries(h.store.parameterDeclarations()
    .filter(parameter => parameter.id.startsWith('camera.') && h.store.declares(parameter.id))
    .map(parameter => [parameter.id, parameter.default]));
  assert.equal(h.store.setPresetValues(preset, defaults).ok, true);
  h.strip.render();
  const before = h.store.document();
  chipByLabel(h, 'camera').querySelector('.chain-chip-reset').dispatch('click');
  assert.deepEqual(h.store.document(), before);
  assert.equal(h.applied.length, 0);
});

test('header toggling after a pin keeps selection and expansion aligned', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').querySelector('.chain-chip-pin').dispatch('click');
  chipByLabel(h, 'camera').querySelector('.chain-chip-name').dispatch('click');
  assert.equal(chipByLabel(h, 'camera').classList.contains('chain-chip--expanded'), false);
  assert.equal(h.store.selectedLabel(), null);
  chipByLabel(h, 'camera').querySelector('.chain-chip-name').dispatch('click');
  assert.equal(chipByLabel(h, 'camera').classList.contains('chain-chip--expanded'), true);
  assert.equal(h.store.selectedLabel(), 'camera');
});
