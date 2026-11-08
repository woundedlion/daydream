import {test} from 'node:test';
import assert from 'node:assert/strict';
import {scratchChainDocument} from '../src/workbench/shader/chain_document_store.js';
import {POTENTIAL_PARAMETER_GROUPS} from '../src/workbench/shader/chain_presentation.js';
import {CATALOG, BASE, makeStrip, paramsOf, rowFor, controlIn, chipByLabel, runFrame} from './helpers/chain_strip_harness.js';

function potentialDocument(values = {}, labels = ['potential']) {
  const source = scratchChainDocument(CATALOG, [
    ...labels.map((label) => ({label, operator: 'sphere.displace.potential.v1'})),
    {label: 'project', operator: 'project.stereographic.v2'},
    {label: 'sample', operator: 'sample.tessellation.v3'},
    {label: 'color', operator: 'colorize.generated-palette.v4'},
  ]);
  Object.assign(source.preset_bank.presets[0].values, values);
  return source;
}

const potentialGroup = (h, name, label = 'potential') => paramsOf(h, label)
  .querySelectorAll('.chain-param-group').find((group) => group.getAttribute('aria-label') === name);
const potentialToggle = (h, term, label) => potentialGroup(h, `Term ${term}`, label)
  .querySelector('.chain-param-group-toggle');
const potentialFields = (h, term, label) => potentialGroup(h, `Term ${term}`, label)
  .querySelector('.chain-param-group-fields');

test('Potential Lens groups overall controls and names each independent term', async () => {
  const source = potentialDocument();
  const h = await makeStrip({source});
  chipByLabel(h, 'potential').dispatch('click');
  const groups = paramsOf(h, 'potential').querySelectorAll('.chain-param-group');
  assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')),
    POTENTIAL_PARAMETER_GROUPS.map((group) => group.name));
  for (const { name, fields } of POTENTIAL_PARAMETER_GROUPS) {
    const rows = name.startsWith('Term ') ? potentialFields(h, name.slice('Term '.length))
      : potentialGroup(h, name);
    assert.deepEqual(rows.querySelectorAll('.chain-param').map((row) => row.dataset.parameter),
      fields.map((field) => `potential.${field}`));
  }
  assert.equal(paramsOf(h, 'potential').querySelector('.chain-param-note'), null);
  assert.equal(rowFor(h, 'potential', 'potential.drift').querySelector('.chain-param-name')
    .getAttribute('title'), null);
  for (let term = 1; term <= 4; term += 1) {
    const group = potentialGroup(h, `Term ${term}`);
    assert.equal(group.getAttribute('role'), 'group');
    assert.deepEqual(group.querySelectorAll('.chain-param-name').map((label) => label.textContent),
      ['Type', 'Kind', 'Degree', 'Order', 'Amplitude', 'Phase']);
    const toggle = potentialToggle(h, term);
    assert.equal(toggle.tagName, 'BUTTON');
    assert.equal(toggle.type, 'button');
    assert.equal(toggle.getAttribute('aria-label'), `Term ${term}`);
    assert.equal(toggle.getAttribute('aria-controls'), potentialFields(h, term).getAttribute('id'));
    assert.equal(toggle.getAttribute('aria-expanded'), String(term === 1));
    assert.equal(potentialFields(h, term).hidden, term !== 1);
    assert.equal(controlIn(rowFor(h, 'potential', `potential.term-${term}-l`)).getAttribute('aria-label'), 'Degree');
    assert.equal(controlIn(rowFor(h, 'potential', `potential.term-${term}-m`)).getAttribute('aria-label'), 'Order');
  }
  assert.deepEqual(h.store.document(), source);
  assert.deepEqual(h.edits, []);
  assert.equal(h.store.canUndo(), false);
});

test('Potential Lens opens loaded active terms and keeps unused terms collapsed', async () => {
  const source = potentialDocument({'potential.term-2-amplitude': -0.7, 'potential.term-4-amplitude': 1});
  const h = await makeStrip({source});
  assert.deepEqual([1, 2, 3, 4].map((term) => potentialFields(h, term).hidden),
    [false, false, true, false]);
  assert.equal(Number(controlIn(rowFor(h, 'potential', 'potential.term-2-amplitude')).value), -0.7);
  assert.deepEqual(h.store.document(), source);
});

test('Potential Lens keeps explicit section choices across rerenders and renaming', async () => {
  const h = await makeStrip({source: potentialDocument()});
  chipByLabel(h, 'potential').dispatch('click');
  const term2 = potentialToggle(h, 2);
  term2.focus();
  term2.dispatch('click');
  assert.equal(h.doc.activeElement, term2);
  potentialToggle(h, 1).dispatch('click');
  assert.equal(h.store.canUndo(), false);
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.edits, []);
  h.strip.render();
  assert.equal(potentialFields(h, 1).hidden, true);
  assert.equal(potentialFields(h, 2).hidden, false);
  const preset = h.store.document().preset_bank.presets[0].preset_id;
  assert.equal(h.store.setPresetValue(preset, 'potential.term-3-amplitude', 0.5).ok, true);
  h.strip.render();
  assert.equal(potentialFields(h, 3).hidden, false, 'a loaded active term opens until the user chooses otherwise');
  potentialToggle(h, 3).dispatch('click');
  assert.equal(h.store.setPresetValue(preset, 'potential.term-3-amplitude', 0.75).ok, true);
  h.strip.render();
  assert.equal(potentialFields(h, 3).hidden, true);
  const rename = paramsOf(h, 'potential').querySelector('.chain-chip-rename');
  rename.value = 'motion';
  rename.dispatch('change');
  assert.equal(potentialFields(h, 1, 'motion').hidden, true);
  assert.equal(potentialFields(h, 2, 'motion').hidden, false);
  assert.equal(potentialFields(h, 3, 'motion').hidden, true);
  assert.equal(h.store.undo(), true);
  h.strip.render();
  assert.equal(potentialFields(h, 2).hidden, true, 'the retired label uses default section choices');
});

for (const retirement of ['rename', 'delete']) {
  test(`a Potential stage added after ${retirement} starts with default section choices`, async () => {
    const h = await makeStrip({source: potentialDocument({}, ['displace'])});
    potentialToggle(h, 1, 'displace').dispatch('click');
    potentialToggle(h, 2, 'displace').dispatch('click');
    if (retirement === 'rename') {
      const rename = paramsOf(h, 'displace').querySelector('.chain-chip-rename');
      rename.value = 'motion';
      rename.dispatch('change');
      assert.equal(potentialFields(h, 2, 'motion').hidden, false);
    } else {
      assert.equal(h.store.replaceSpan(0, 1, []).ok, true);
      h.strip.render();
    }
    assert.equal(h.store.replaceSpan(0, 0, [{operator: 'sphere.displace.potential.v1'}]).ok, true);
    h.strip.render();
    assert.equal(potentialFields(h, 1, 'displace').hidden, false);
    assert.equal(potentialFields(h, 2, 'displace').hidden, true);
  });
}

test('Potential Lens term edits retain typed input ranges topology gates and undo', async () => {
  let maximum = 1;
  const source = potentialDocument({'potential.term-1-amplitude': 0.4, 'potential.term-2-amplitude': -0.3});
  const h = await makeStrip({source, writeThrough: true,
    parameterRanges: () => [{name: 'potential.strength', min: -maximum, max: maximum}]});
  chipByLabel(h, 'potential').dispatch('click');
  const untouched = h.store.document().preset_bank.presets[0].values;
  const row = rowFor(h, 'potential', 'potential.term-2-amplitude');
  const typed = row.querySelector('.chain-param-value');
  typed.focus();
  typed.value = '0.6';
  typed.dispatch('change');
  assert.equal(h.doc.activeElement, typed);
  assert.equal(rowFor(h, 'potential', 'potential.term-2-amplitude'), row);
  assert.deepEqual(h.edits.at(-1), ['potential.term-2-amplitude', 0.6]);
  const firstEdit = h.store.document().preset_bank.presets[0].values;
  assert.deepEqual(firstEdit, {...untouched, 'potential.term-2-amplitude': 0.6});
  const slider = controlIn(row);
  slider.value = '0.8';
  slider.dispatch('input');
  runFrame();
  slider.dispatch('change');
  assert.equal(h.store.document().preset_bank.presets[0].values['potential.term-2-amplitude'], 0.8);
  assert.equal(h.store.undo(), true);
  assert.equal(h.store.document().preset_bank.presets[0].values['potential.term-2-amplitude'], 0.6);
  assert.equal(h.store.redo(), true);
  assert.equal(h.store.document().preset_bank.presets[0].values['potential.term-2-amplitude'], 0.8);
  maximum = 0.25;
  h.strip.syncParameterRows();
  const strength = rowFor(h, 'potential', 'potential.strength').querySelector('.chain-param-value');
  assert.equal(strength.max, '0.25');
  strength.value = '1';
  strength.dispatch('change');
  assert.deepEqual(h.edits.at(-1), ['potential.strength', 0.25]);
  const type = controlIn(rowFor(h, 'potential', 'potential.term-2-type'));
  type.value = 'tetrahedral';
  type.dispatch('change');
  for (const field of ['l', 'm', 'phase']) {
    const inactive = rowFor(h, 'potential', `potential.term-2-${field}`);
    assert.equal(inactive.hidden, true);
    assert.equal(inactive.querySelector('.chain-param-note'), null);
    assert.equal(controlIn(inactive).disabled, false);
    assert.equal(rowFor(h, 'potential', `potential.term-1-${field}`).hidden, false);
  }
  assert.equal(potentialFields(h, 2).hidden, false);
  assert.equal(h.store.compile().status, 'VALID');
});

test('Potential Lens section choices belong to each operator instance', async () => {
  const h = await makeStrip({source: potentialDocument({}, ['potential', 'other'])});
  potentialToggle(h, 2).dispatch('click');
  assert.equal(potentialFields(h, 2).hidden, false);
  assert.equal(potentialFields(h, 2, 'other').hidden, true);
  h.strip.render();
  assert.equal(potentialFields(h, 2).hidden, false);
  assert.equal(potentialFields(h, 2, 'other').hidden, true);
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

test('Potential Lens prevents invalid Degree and Order selections without changing sibling values', async () => {
  let degreeMinimum = 3;
  let orderMaximum = 4;
  const source = potentialDocument({'potential.term-1-l': 'four', 'potential.term-1-m': 'three'});
  const h = await makeStrip({source, writeThrough: true, parameterRanges: () => [
    {name: 'potential.term-1-l', min: degreeMinimum, max: 8},
    {name: 'potential.term-1-m', min: 0, max: orderMaximum},
  ]});
  const degree = controlIn(rowFor(h, 'potential', 'potential.term-1-l'));
  const order = controlIn(rowFor(h, 'potential', 'potential.term-1-m'));
  assert.deepEqual(degree.options.filter((option) => !option.disabled).map((option) => option.value),
    ['three', 'four', 'five', 'six', 'seven', 'eight']);
  assert.deepEqual(order.options.filter((option) => !option.disabled).map((option) => option.value),
    ['zero', 'one', 'two', 'three', 'four']);
  degree.value = 'two';
  degree.dispatch('change');
  assert.equal(degree.value, 'four');
  assert.deepEqual(h.edits, []);
  assert.deepEqual(h.commits, []);
  assert.equal(h.store.canUndo(), false);
  degreeMinimum = 2;
  order.value = 'two';
  order.dispatch('change');
  assert.equal(degree.options[2].disabled, false);
  assert.equal(degree.value, 'four');
  orderMaximum = 2;
  degree.value = 'two';
  degree.dispatch('change');
  assert.equal(order.value, 'two');
  assert.equal(order.options[3].disabled, true);
  order.value = 'three';
  order.dispatch('change');
  assert.equal(order.value, 'two');
  assert.deepEqual(h.edits, [['potential.term-1-m', 'two'], ['potential.term-1-l', 'two']]);
  assert.equal(h.commits.length, 2);
  const values = h.store.document().preset_bank.presets[0].values;
  assert.equal(values['potential.term-1-l'], 'two');
  assert.equal(values['potential.term-1-m'], 'two');
  assert.equal(values['potential.term-2-l'], source.preset_bank.presets[0].values['potential.term-2-l']);
});

test('Potential Lens hides non-Mode choices and respects Mode admission metadata', async () => {
  const source = potentialDocument({'potential.term-1-type': 'tetrahedral',
    'potential.term-1-l': 'four', 'potential.term-1-m': 'three'});
  let modeAllowed = true;
  const h = await makeStrip({source, parameterRanges: () => [
    {name: 'potential.term-1-type', min: modeAllowed ? 0 : 1, max: 3},
    {name: 'potential.term-1-l', min: 0, max: 8},
    {name: 'potential.term-1-m', min: 0, max: 8},
  ]});
  const degreeRow = rowFor(h, 'potential', 'potential.term-1-l');
  const degree = controlIn(degreeRow);
  const order = controlIn(rowFor(h, 'potential', 'potential.term-1-m'));
  assert.equal(degreeRow.hidden, true);
  assert.equal(degree.disabled, false);
  assert.ok(degree.options.every((option) => !option.disabled));
  assert.ok(order.options.every((option) => !option.disabled));
  modeAllowed = false;
  h.strip.syncParameterValues({'potential.term-1-l': 'two'});
  const type = controlIn(rowFor(h, 'potential', 'potential.term-1-type'));
  assert.equal(type.options[0].disabled, true);
  assert.equal(order.value, 'three');
  type.value = 'mode';
  type.dispatch('change');
  assert.equal(type.value, 'tetrahedral');
  assert.deepEqual(h.edits, []);
  modeAllowed = true;
  h.strip.syncParameterValues({'potential.term-1-m': 'one'});
  type.value = 'mode';
  type.dispatch('change');
  assert.equal(degreeRow.hidden, false);
  assert.equal(degree.value, 'two');
  assert.equal(order.value, 'one');
  assert.deepEqual(h.edits, [['potential.term-1-type', 'mode']]);
});

test('Potential Lens hides only each non-Mode term mode controls and keeps later terms independent', async () => {
  const source = potentialDocument(Object.fromEntries([1, 2, 3, 4].flatMap((term) => [
    [`potential.term-${term}-amplitude`, 0.1],
    [`potential.term-${term}-l`, 'four'], [`potential.term-${term}-m`, 'two'],
    [`potential.term-${term}-phase`, 0.7],
  ])));
  const h = await makeStrip({source, writeThrough: true});
  const selectType = (term, value) => {
    const select = controlIn(rowFor(h, 'potential', `potential.term-${term}-type`));
    select.value = value;
    select.dispatch('change');
  };
  selectType(1, 'dodecahedral');
  selectType(3, 'octahedral');
  for (const term of [1, 2, 3, 4]) {
    const group = potentialGroup(h, `Term ${term}`);
    assert.equal(group.hidden, false);
    const visible = group.querySelectorAll('.chain-param').filter((row) => !row.hidden)
      .map((row) => row.dataset.parameter);
    assert.deepEqual(visible, (term === 1 || term === 3 ? ['type', 'kind', 'amplitude']
      : ['type', 'kind', 'l', 'm', 'amplitude', 'phase']).map((field) => `potential.term-${term}-${field}`));
    assert.ok(group.querySelectorAll('.chain-param').every((row) => row.querySelector('.chain-param-note') === null));
    assert.ok(group.querySelectorAll('.chain-param-control').every((control) => !control.disabled));
  }
  const amplitude = rowFor(h, 'potential', 'potential.term-2-amplitude').querySelector('.chain-param-value');
  amplitude.value = '0.2';
  amplitude.dispatch('change');
  assert.equal(h.store.document().preset_bank.presets[0].values['potential.term-2-amplitude'], 0.2);
  selectType(1, 'mode');
  for (const [field, value] of [['l', 'four'], ['m', 'two'], ['phase', '0.7']]) {
    const row = rowFor(h, 'potential', `potential.term-1-${field}`);
    assert.equal(row.hidden, false);
    assert.equal(controlIn(row).value, value);
  }
  assert.equal(rowFor(h, 'potential', 'potential.term-3-l').hidden, true);
  assert.equal(rowFor(h, 'potential', 'potential.term-4-l').hidden, false);
});
