import { test } from "node:test";
import assert from "node:assert/strict";
import { scratchChainDocument } from "../../src/workbench/shader/chain_document_store.js";
import { formatNumericValue } from "../../src/workbench/shader/chain_presentation.js";
import { CATALOG, BASE, runFrame, makeStrip, chipByLabel, bandFor, paletteEntries, lastAnnounced, labels, paramsOf, rowsOf, rowFor, controlIn, declarationsFor } from "../helpers/chain_strip_harness.js";
import { withPreset } from "../helpers/chain_study.js";
import { operatorName, renameIn } from "./fixture.js";

// ── Inline stage parameters ─────────────────────────────────────────────────

test('stage controls ignore hover and toggle immediately with the pin button', async () => {
  const h = await makeStrip();
  assert.equal(chipByLabel(h, 'sample').getAttribute('aria-expanded'), null);
  assert.ok(paramsOf(h, 'sample'), 'an unselected chip carries its controls');

  const chip = chipByLabel(h, 'sample');
  assert.equal(chip.classList.contains('chain-chip--expanded'), false);

  chip.dispatch('mouseenter');
  assert.equal(chip.classList.contains('chain-chip--expanded'), false);
  chip.dispatch('mouseleave');
  assert.equal(chip.classList.contains('chain-chip--expanded'), false);

  chip.querySelector('.chain-chip-pin').dispatch('click');
  const pinned = chipByLabel(h, 'sample');
  assert.equal(pinned.classList.contains('chain-chip--expanded'), true);
  pinned.dispatch('mouseleave');
  assert.equal(pinned.classList.contains('chain-chip--expanded'), true,
    'mouse leave preserves a pinned card');
  pinned.querySelector('.chain-chip-pin').dispatch('click');
  assert.equal(chipByLabel(h, 'sample').classList.contains('chain-chip--expanded'), false);
  assert.equal(pinned.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');

});

test('parameter rows follow declared order and numeric domains', async () => {
  const h = await makeStrip();
  const region = paramsOf(h, 'sample');
  assert.equal(region.getAttribute('role'), 'group');
  assert.equal(region.getAttribute('aria-label'), `${operatorName('sample')} · sample parameters`);
  assert.deepEqual(rowsOf(h, 'sample').map((row) => row.dataset.parameter),
    h.store.parameterDeclarations().filter((parameter) =>
      parameter.id.startsWith('sample.')).map((parameter) => parameter.id),
    'authored declarations followed by undeclared catalog controls');
  assert.deepEqual(rowsOf(h, 'sample')
    .map((row) => row.querySelector('.chain-param-name').textContent),
  rowsOf(h, 'sample').map((row) => row.dataset.parameter.slice('sample.'.length).split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1)).join(' ')),
  'a control is labeled by its field segment alone: the chip names the instance');

  // The document's declared domain and the active preset's value, not the
  // engine's idea of either.
  const freq = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  const declared = declarationsFor(h, 'sample')
    .find((parameter) => parameter.id === 'sample.pattern-freq');
  assert.equal(freq.type, 'range');
  assert.equal(freq.min, String(declared.domain.minimum));
  assert.equal(freq.max, String(declared.domain.maximum));
  const value = h.store.document().preset_bank.presets[0].values['sample.pattern-freq'];
  assert.equal(Number(freq.value), value);
  assert.equal(rowFor(h, 'sample', 'sample.pattern-freq')
    .querySelector('.chain-param-value').value, formatNumericValue(value));

  chipByLabel(h, 'camera').dispatch('click');
  assert.equal(rowsOf(h, 'camera').length, h.store.parameterDeclarations().filter(
    (parameter) => parameter.id.startsWith('camera.')).length);
});

test('Enter and Space toggle a tile while focus and Tab leave it collapsed', async () => {
  const h = await makeStrip();
  const initial = chipByLabel(h, 'sample');
  initial.focus();
  initial.dispatch('focusin');
  initial.dispatch('keydown', { key: 'Tab' });
  assert.equal(initial.classList.contains('chain-chip--expanded'), false);

  const enter = initial.dispatch('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  const opened = chipByLabel(h, 'sample');
  assert.equal(opened.classList.contains('chain-chip--expanded'), true);
  assert.equal(opened.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  assert.equal(h.store.selectedLabel(), 'sample');

  const space = opened.dispatch('keydown', { key: ' ' });
  assert.equal(space.defaultPrevented, true);
  const closed = chipByLabel(h, 'sample');
  assert.equal(closed.classList.contains('chain-chip--expanded'), false);
  assert.equal(closed.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
  assert.equal(h.doc.activeElement, closed);
  assert.equal(h.store.selectedLabel(), null);
});

test('a fixed stage expands to explain its parameters and allow renaming', async () => {
  const h = await makeStrip();
  bandFor(h, 'field').querySelector('.chain-band-add').dispatch('click');
  const fixed = paletteEntries(h).find((entry) => CATALOG.operators
    .find(({id}) => id === entry.dataset.operator).params.length === 0);
  fixed.dispatch('click');
  const label = h.store.chain()
    .find((entry) => entry.operator === fixed.dataset.operator).label;
  assert.deepEqual(declarationsFor(h, label), []);

  const chip = chipByLabel(h, label);
  assert.equal(chip.getAttribute('aria-current'), 'true');
  assert.equal(chip.classList.contains('chain-chip--expanded'), true);
  assert.equal(chip.querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  assert.equal(paramsOf(h, label).querySelector('.chain-strip-note').textContent,
    'No adjustable parameters');
  assert.ok(paramsOf(h, label).querySelector('.chain-chip-rename'));
});

test('stage and socket pins are independent of selection and each other', async () => {
  const h = await makeStrip();
  for (const label of ['camera', 'project']) {
    const chip = chipByLabel(h, label);
    const pin = chip.querySelector('.chain-chip-pin');
    assert.equal(pin.getAttribute('aria-pressed'), 'false');
    assert.match(pin.getAttribute('aria-label'), /^Pin /);
    assert.equal(pin.querySelector('.chain-chip-pin-icon').getAttribute('aria-hidden'), 'true');
    pin.dispatch('click');
    assert.equal(pin.getAttribute('aria-pressed'), 'true');
    assert.match(pin.getAttribute('aria-label'), /^Unpin /);
    chip.dispatch('mouseleave');
    chip.dispatch('focusout');
    chip.dispatch('keydown', { key: 'Escape' });
  }
  assert.equal(h.store.selectedLabel(), null);
  chipByLabel(h, 'lens').dispatch('click');
  chipByLabel(h, 'lens').dispatch('mouseleave');
  assert.equal(chipByLabel(h, 'lens').classList.contains('chain-chip--expanded'), true);
  for (const label of ['camera', 'project']) {
    assert.equal(chipByLabel(h, label).classList.contains('chain-chip--expanded'), true);
  }
  const camera = chipByLabel(h, 'camera');
  camera.querySelector('.chain-chip-pin').dispatch('click');
  assert.equal(camera.classList.contains('chain-chip--expanded'), false);
  camera.dispatch('mouseleave');
  assert.equal(camera.classList.contains('chain-chip--expanded'), false);
  assert.equal(chipByLabel(h, 'project').classList.contains('chain-chip--expanded'), true);
});

test('pins survive reorder and rename and disappear with removed instances', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'camera').querySelector('.chain-chip-pin').dispatch('click');
  chipByLabel(h, 'camera').dispatch('keydown', { key: 'ArrowRight', altKey: true });
  assert.equal(chipByLabel(h, 'camera').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  const rename = chipByLabel(h, 'camera').querySelector('.chain-chip-rename');
  rename.value = 'renamed';
  rename.dispatch('change');
  assert.equal(chipByLabel(h, 'renamed').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'true');
  chipByLabel(h, 'renamed').querySelector('.chain-chip-remove').dispatch('click');
  h.container.querySelector('.chain-undo').dispatch('click');
  assert.equal(chipByLabel(h, 'renamed').querySelector('.chain-chip-pin').getAttribute('aria-pressed'), 'false');
});

test('a slider edit calls back with the parameter and its value', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);

  slider.value = '5.5';
  slider.dispatch('input');

  assert.deepEqual(h.edits, [], 'the expensive write waits for the frame');
  runFrame();
  assert.deepEqual(h.edits, [['sample.pattern-freq', 5.5]]);
  assert.equal(row.querySelector('.chain-param-value').value, '5.5');
  assert.deepEqual(h.applied, [], 'a value edit is no structural edit');
  assert.equal(controlIn(rowFor(h, 'sample', 'sample.pattern-freq')), slider,
    'the strip is not rebuilt under the pointer');
});

test('live ranges bound sliders and typed values and expand without replacing controls', async () => {
  let maximum = 6;
  const h = await makeStrip({
    parameterRanges: () => [{name: 'sample.pattern-freq', min: 1, max: maximum}],
  });
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const readout = row.querySelector('.chain-param-value');
  assert.equal(Number(slider.min), 1);
  assert.equal(Number(slider.max), 6);
  assert.equal(readout.min, slider.min);
  assert.equal(readout.max, slider.max);
  slider.focus();
  slider.value = '20';
  slider.dispatch('input');
  runFrame();
  assert.deepEqual(h.edits, [['sample.pattern-freq', 6]]);
  assert.equal(Number(slider.value), 6);
  assert.equal(Number(readout.value), 6);
  maximum = 12;
  h.strip.syncParameterValues({'sample.pattern-freq': 6});
  assert.equal(Number(slider.max), 12);
  assert.equal(Number(readout.max), 12);
  assert.equal(controlIn(rowFor(h, 'sample', 'sample.pattern-freq')), slider);
  assert.equal(h.doc.activeElement, slider);
  assert.equal(h.edits.length, 1, 'changing limits writes no value');
  readout.value = '20';
  readout.dispatch('change');
  assert.deepEqual(h.edits.at(-1), ['sample.pattern-freq', 12]);
  readout.value = '-1';
  readout.dispatch('change');
  assert.deepEqual(h.edits.at(-1), ['sample.pattern-freq', 1]);
});

test('log-positive sliders map octaves and preserve value readouts across edits and live limits', async () => {
  const source = scratchChainDocument(CATALOG, [
    {label: 'project', operator: 'project.stereographic.v2'},
    {label: 'affine', operator: 'warp.affine.v4'},
    {label: 'sample', operator: 'sample.grid.v4'},
    {label: 'color', operator: 'colorize.generated-palette.v4'},
  ]);
  let ranges = [];
  const h = await makeStrip({source, writeThrough: true, parameterRanges: () => ranges});
  const row = rowFor(h, 'affine', 'affine.scale-x');
  const slider = controlIn(row);
  const readout = row.querySelector('.chain-param-value');
  const { domain, default: initial } = declarationsFor(h, 'affine')
    .find((parameter) => parameter.id === 'affine.scale-x');
  assert.deepEqual([Number(slider.min), Number(slider.max), Number(slider.value)],
    [Math.log2(domain.minimum), Math.log2(domain.maximum), Math.log2(initial)]);
  assert.deepEqual([Number(readout.min), Number(readout.max), Number(readout.value)],
    [domain.minimum, domain.maximum, initial]);
  slider.value = '-1';
  slider.dispatch('input');
  runFrame();
  assert.deepEqual(h.edits.at(-1), ['affine.scale-x', 0.5]);
  assert.equal(Number(readout.value), 0.5);
  assert.equal(slider.getAttribute('aria-valuetext'), '0.5');
  slider.dispatch('change');
  h.strip.syncParameterValues({'affine.scale-x': 2});
  assert.equal(Number(slider.value), 1);
  assert.equal(Number(readout.value), 2);
  assert.equal(slider.getAttribute('aria-valuetext'), '2');
  readout.value = '0.25';
  readout.dispatch('change');
  assert.equal(Number(slider.value), -2);
  assert.deepEqual(h.edits.at(-1), ['affine.scale-x', 0.25]);
  readout.dispatch('keydown', {key: 'ArrowUp'});
  assert.ok(Math.abs(Number(readout.value) / 0.25 - 4096 ** (1 / 1000)) < 1e-7);
  ranges = [{name: 'affine.scale-x', min: 0.25, max: 4}];
  h.strip.syncParameterRows();
  assert.deepEqual([Number(slider.min), Number(slider.max)], [-2, 2]);
  assert.deepEqual([Number(readout.min), Number(readout.max)], [0.25, 4]);
  slider.value = '6';
  slider.dispatch('input');
  slider.dispatch('change');
  assert.deepEqual(h.edits.at(-1), ['affine.scale-x', 4]);
  assert.equal(Number(slider.value), 2);
  assert.equal(Number(readout.value), 4);
  assert.equal(controlIn(rowFor(h, 'affine', 'affine.scale-x')), slider);
});

test('slider drags retain admitted limits until the edit is committed', async () => {
  let queries = 0;
  let maximum = 12;
  const h = await makeStrip({
    parameterRanges: () => {
      ++queries;
      return [{name: 'sample.pattern-freq', min: 1, max: maximum}];
    },
  });
  const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  const initialQueries = queries;
  for (const value of [4, 5, 6]) {
    slider.value = String(value);
    slider.dispatch('input');
    runFrame();
  }
  assert.equal(queries, initialQueries);
  assert.deepEqual(h.edits.map((edit) => edit[1]), [4, 5, 6]);
  maximum = 8;
  slider.dispatch('change');
  assert.equal(queries, initialQueries + 1);
  assert.equal(Number(slider.max), 8);
  assert.deepEqual(h.commits, [3]);
});

test('queued slider values respect a range tightened before the frame flush', async () => {
  let maximum = 12;
  const h = await makeStrip({
    parameterRanges: () => [{name: 'sample.pattern-freq', min: 1, max: maximum}],
  });
  const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  slider.value = '10';
  slider.dispatch('input');
  maximum = 6;
  h.strip.syncParameterValues({});
  runFrame();
  assert.deepEqual(h.edits, [['sample.pattern-freq', 6]]);
  assert.equal(Number(slider.value), 6);
});

test('live limits stay inside the document-authored numeric domain', async () => {
  const h = await makeStrip({
    parameterRanges: () => [{name: 'sample.pattern-freq', min: -1e6, max: 1e6}],
  });
  const domain = h.store.parameterDeclarations().find((p) => p.id === 'sample.pattern-freq').domain;
  const slider = controlIn(rowFor(h, 'sample', 'sample.pattern-freq'));
  assert.equal(Number(slider.min), domain.minimum);
  assert.equal(Number(slider.max), domain.maximum);
});

test('slider input coalesces to the latest value in each frame', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'sample').dispatch('click');
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);

  for (const value of ['2', '3', '4']) {
    slider.value = value;
    slider.dispatch('input');
  }
  assert.equal(row.querySelector('.chain-param-value').value, '4');
  assert.deepEqual(h.edits, []);
  runFrame();
  assert.deepEqual(h.edits, [['sample.pattern-freq', 4]]);

  slider.value = '5';
  slider.dispatch('input');
  h.strip.destroy();
  runFrame();
  assert.deepEqual(h.edits, [['sample.pattern-freq', 4]]);
});

test('a numeric value can be typed directly and stays within its domain', async () => {
  const h = await makeStrip();
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const value = row.querySelector('.chain-param-value');

  value.value = '5.5';
  value.dispatch('change');
  assert.equal(slider.value, '5.5');
  assert.equal(value.value, '5.5');
  assert.deepEqual(h.edits, [['sample.pattern-freq', 5.5]]);

  value.value = '100';
  value.dispatch('change');
  assert.equal(Number(slider.value), Number(slider.max));
  assert.equal(Number(value.value), Number(slider.max));
  assert.deepEqual(h.edits.at(-1), ['sample.pattern-freq', Number(slider.max)]);
});

test('the numeric readout reads back as the binary32 it shows', async () => {
  const h = await makeStrip();
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const value = row.querySelector('.chain-param-value');

  // The engine stores binary32, so the readout a slider drag leaves behind is
  // what a later arrow-key nudge or re-entry is computed from.
  for (const authored of [3.14159274, 0.100000001, 1 / 3, 1e-7, 47.8000031]) {
    const stored = Math.fround(
      Math.min(Number(slider.max), Math.max(Number(slider.min), authored)));
    slider.value = String(stored);
    slider.dispatch('input');
    assert.equal(Math.fround(Number(value.value)), stored,
      `${value.value} must read back as ${stored}`);
  }

  // A value a shorter decimal already names keeps the shorter spelling.
  slider.value = '3.5';
  slider.dispatch('input');
  assert.equal(value.value, '3.5');
});

test('the readout carries no step grid and nudges by arrow key', async () => {
  const h = await makeStrip();
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const value = row.querySelector('.chain-param-value');
  const declared = declarationsFor(h, 'sample')
    .find((parameter) => parameter.id === 'sample.pattern-freq');
  const nudge = (declared.domain.maximum - declared.domain.minimum) / 1000;

  assert.equal(value.step, 'any',
    'a grid based at min would report stepMismatch on the stored value');

  const before = Number(value.value);
  assert.equal(value.dispatch('keydown', { key: 'ArrowUp' }).defaultPrevented, true);
  assert.equal(Math.fround(Number(value.value)), Math.fround(before + nudge));
  assert.equal(Math.fround(Number(slider.value)), Math.fround(before + nudge));
  assert.equal(h.edits.at(-1)[0], 'sample.pattern-freq');
  assert.equal(Math.fround(h.edits.at(-1)[1]), Math.fround(before + nudge));

  assert.equal(value.dispatch('keydown', { key: 'ArrowDown' }).defaultPrevented, true);
  assert.equal(Math.fround(Number(value.value)), Math.fround(before));

  const editsBefore = h.edits.length;
  const commitsBefore = h.commits.length;
  value.value = '5.5';
  assert.equal(value.dispatch('keydown', { key: 'Enter' }).defaultPrevented, false);
  assert.equal(value.value, '5.5', 'other keys are left to the input');
  assert.equal(h.edits.length, editsBefore);
  assert.equal(h.commits.length, commitsBefore);
});

// A browser's number input reports content it cannot parse as the empty
// string, which is what the listener sees when an author types letters.
test('an unparsable numeric entry restores the stored value', async () => {
  const h = await makeStrip();
  const row = rowFor(h, 'sample', 'sample.pattern-freq');
  const slider = controlIn(row);
  const value = row.querySelector('.chain-param-value');
  const authored = value.value;
  const position = slider.value;

  value.value = '';
  value.dispatch('change');

  assert.equal(value.value, authored);
  assert.equal(slider.value, position);
  assert.deepEqual(h.edits, []);
});

test('a chip renames its instance through the store', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'warp2').dispatch('click');
  const field = renameIn(h, 'warp2');
  assert.equal(field.value, 'warp2');

  field.value = ' mirror ';
  field.dispatch('change');

  assert.equal(labels(h)[3], 'mirror');
  assert.equal(h.store.selectedLabel(), 'mirror', 'the selection follows the rename');
  assert.ok(h.store.document().descriptor.parameters.some(
    (parameter) => parameter.id === 'mirror.rotation'));
  assert.equal(h.applied.length, 1, 'the program is re-applied under the new ids');
  assert.equal(renameIn(h, 'mirror').value, 'mirror');
});

test('a modulation chip can rename its instance', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'modulation').dispatch('click');
  const field = renameIn(h, 'modulation');
  field.value = 'motion';
  field.dispatch('change');
  assert.equal(renameIn(h, 'motion').value, 'motion');
  assert.ok(h.store.chain().some(entry => entry.label === 'motion'));
});

test('a refused rename reports and restores the field', async () => {
  const h = await makeStrip();
  chipByLabel(h, 'warp2').dispatch('click');
  const field = renameIn(h, 'warp2');

  field.value = 'Not.Valid';
  field.dispatch('change');

  assert.equal(field.value, 'warp2');
  assert.equal(labels(h)[3], 'warp2');
  assert.match(lastAnnounced(h), /kebab-case/);

  field.value = 'sample';
  field.dispatch('change');
  assert.equal(labels(h)[3], 'warp2');
  assert.match(lastAnnounced(h), /already carries/);
});

test('an enum renders its declared values and edits by option id', async () => {
  const source = structuredClone(BASE.document);
  const options = source.descriptor.parameters
    .find((parameter) => parameter.id === 'lens.symmetry').domain.values;
  const [authored, chosen] = options.slice(-2);
  source.preset_bank.presets[0].values['lens.symmetry'] = authored;
  const h = await makeStrip({ source });
  chipByLabel(h, 'lens').dispatch('click');
  const select = controlIn(rowFor(h, 'lens', 'lens.symmetry'));

  assert.equal(select.tagName, 'SELECT');
  assert.deepEqual(select.options.map((option) => option.value), options);
  assert.equal(select.value, authored, 'the preset’s value is selected');

  select.value = chosen;
  select.dispatch('change');

  assert.deepEqual(h.edits, [['lens.symmetry', chosen]],
    'the document stores the option id, never an index');
});

test('enum admission metadata updates allowed choices at float32 integer boundaries', async () => {
  const source = structuredClone(BASE.document);
  source.preset_bank.presets[0].values['lens.symmetry'] = 'octahedral';
  let minimum = 2.0000001;
  let maximum = 5.0000001;
  const h = await makeStrip({source,
    parameterRanges: () => [{name: 'lens.symmetry', min: minimum, max: maximum}]});
  const select = controlIn(rowFor(h, 'lens', 'lens.symmetry'));
  assert.deepEqual(select.options.map((option) => option.disabled),
    [true, true, false, false, false, false, true, true, true]);
  assert.equal(select.value, 'octahedral');
  minimum = 1;
  maximum = 8;
  h.strip.syncParameterRows();
  assert.equal(controlIn(rowFor(h, 'lens', 'lens.symmetry')), select);
  assert.deepEqual(select.options.map((option) => option.disabled),
    [true, false, false, false, false, false, false, false, false]);
  assert.deepEqual(h.edits, []);
});

// The page writes every inline edit under the control's coalesce key so a
// slider drag undoes whole; a discrete control's change is a whole gesture.
test('a chosen option and an entered value each close the coalesced value run', async () => {
  const h = await makeStrip({ writeThrough: true });
  const stored = (id) => h.store.document().preset_bank.presets[0].values[id];

  for (const value of ['octahedral', 'tetrahedral']) {
    const select = controlIn(rowFor(h, 'lens', 'lens.symmetry'));
    select.value = value;
    select.dispatch('change');
  }
  assert.deepEqual(h.commits, [1, 2], 'each choice completes an edit');
  assert.equal(h.store.undo(), true);
  assert.equal(stored('lens.symmetry'), 'octahedral',
    'one Undo reverts one choice, not every choice since the strip was built');

  for (const value of ['5.5', '6']) {
    const readout = rowFor(h, 'sample', 'sample.pattern-freq')
      .querySelector('.chain-param-value');
    readout.value = value;
    readout.dispatch('change');
  }
  assert.deepEqual(h.commits, [1, 2, 3, 4]);
  assert.equal(h.store.undo(), true);
  assert.equal(stored('sample.pattern-freq'), 5.5,
    'one Undo reverts one entered value');
});

test('topology-gated controls hide and retain their values when revealed', async () => {
  const h = await makeStrip();
  bandFor(h, 'plane').querySelector('.chain-band-add').dispatch('click');
  paletteEntries(h).find((entry) => entry.dataset.operator === 'warp.wave-shear.v2')
    .dispatch('click');
  const label = h.store.chain()
    .find((entry) => entry.operator === 'warp.wave-shear.v2').label;
  chipByLabel(h, label).dispatch('click');

  const edge = rowFor(h, label, `${label}.edge-width`);
  const initial = controlIn(edge).value;
  assert.equal(edge.hidden, true,
    'the envelope gate opens on flat, which reads no edge width');
  assert.equal(edge.querySelector('.chain-param-note'), null);
  assert.equal(controlIn(edge).getAttribute('aria-describedby'), null);
  assert.equal(controlIn(edge).disabled, false);
  assert.equal(rowFor(h, label, `${label}.strength`).dataset.deactivated, undefined);

  const envelope = controlIn(rowFor(h, label, `${label}.envelope`));
  envelope.value = 'edge-fade';
  envelope.dispatch('change');

  assert.equal(edge.hidden, false);
  assert.equal(controlIn(edge).value, initial);
  assert.equal(edge.querySelector('.chain-param-note'), null);
  assert.equal(controlIn(edge).getAttribute('aria-describedby'), null);

  controlIn(edge).value = '0.4';
  controlIn(edge).dispatch('input');
  runFrame();
  assert.deepEqual(h.edits.at(-1), [`${label}.edge-width`, 0.4]);
});

test('the inline controls read the named preset', async () => {
  const source = withPreset(structuredClone(BASE.document), 'alt',
    { 'colorize.mapping-frequency': 2 });
  assert.notEqual(source.preset_bank.presets[0].values['colorize.mapping-frequency'], 2);
  const h = await makeStrip({ source, presetId: 'alt' });
  chipByLabel(h, 'colorize').dispatch('click');

  assert.equal(Number(rowFor(h, 'colorize', 'colorize.mapping-frequency').querySelector('.chain-param-value')
    .value), 2, 'the second preset’s value, not the first’s');
});
