import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePanelGui } from './helpers/fake_gui.js';
import { restoreDocumentAfterEach } from './helpers/fake_dom.js';
import { addParamControl } from '../src/ui/effect_param_controls.js';
import { syncParamAdvisories } from '../src/ui/effect_param_advisories.js';
import { makeHarness } from './helpers/effect_gui_harness.js';

restoreDocumentAfterEach();

const STRENGTH = { name: 'flow.strength', value: 0.7, min: -1, max: 1 };

test('fold advisory paints both signed tails and leaves the admitted value available', () => {
  const controller = addParamControl(fakePanelGui(), { 'flow.strength': 0.7 }, STRENGTH);
  const controls = new Map([[STRENGTH.name, controller]]);
  syncParamAdvisories(controls, [{ name: STRENGTH.name, foldStrength: 0.2 }]);
  assert.equal(controller.domElement.classList.contains('param-fold-advisory'), true);
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-low'), '40%');
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-high'), '60%');
  assert.equal(controller.getValue(), 0.7);
  assert.deepEqual(controller.args, [-1, 1]);
  assert.equal(controller.valueSets.length, 0);
  assert.equal(controller.$input.getAttribute('aria-invalid'), null);
  const note = controller.domElement.querySelector('.param-fold-note');
  assert.match(note.textContent, /0.200/);
  assert.equal(controller.$input.getAttribute('aria-describedby'), `param-range-flow.strength ${note.id}`);
});

test('updated estimates move the band and preserve refusal descriptions', () => {
  const controller = addParamControl(fakePanelGui(), { 'flow.strength': 0.7 },
    { ...STRENGTH, warning: 'Strength exceeds the arc limit.' });
  const controls = new Map([[STRENGTH.name, controller]]);
  const refusal = controller.$input.getAttribute('aria-describedby');
  syncParamAdvisories(controls, [{ name: STRENGTH.name, foldStrength: 0.2 }]);
  syncParamAdvisories(controls, [{ name: STRENGTH.name, foldStrength: 0.5 }]);
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-high'), '75%');
  assert.equal(controller.domElement.querySelectorAll('.param-fold-note').length, 1);
  assert.ok(controller.$input.getAttribute('aria-describedby').startsWith(`${refusal} `));
  syncParamAdvisories(controls, []);
  assert.equal(controller.domElement.classList.contains('param-fold-advisory'), false);
  assert.equal(controller.domElement.querySelector('.param-fold-note'), null);
  assert.equal(controller.$input.getAttribute('aria-describedby'), refusal);
});

test('positive strength ranges shade only values above the estimate', () => {
  const controller = addParamControl(fakePanelGui(), { 'flow.strength': 0.7 },
    { ...STRENGTH, min: 0, max: 2 });
  const controls = new Map([[STRENGTH.name, controller]]);
  syncParamAdvisories(controls, [{ name: STRENGTH.name, foldStrength: 0.5 }]);
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-low'), '0%');
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-high'), '25%');
});

test('empty, zero and invalid estimates leave unrelated controls usable', () => {
  const gui = fakePanelGui();
  const strength = addParamControl(gui, { 'flow.strength': 0.7 }, STRENGTH);
  const mode = addParamControl(gui, { mode: 0 }, { name: 'mode', value: 0, options: ['A', 'B'] });
  const controls = new Map([[STRENGTH.name, strength], ['mode', mode]]);
  syncParamAdvisories(controls, []);
  assert.equal(strength.domElement.querySelector('.param-fold-note'), null);
  syncParamAdvisories(controls, [{ name: STRENGTH.name, foldStrength: 0 }]);
  assert.equal(strength.domElement.style.getPropertyValue('--param-fold-low'), '50%');
  assert.equal(strength.domElement.style.getPropertyValue('--param-fold-high'), '50%');
  assert.equal(mode.domElement.querySelector('.param-fold-note'), null);
  syncParamAdvisories(controls, [{ name: STRENGTH.name, foldStrength: -0.2 }]);
  assert.equal(strength.domElement.querySelector('.param-fold-note'), null);
  for (const foldStrength of [Infinity, NaN]) {
    syncParamAdvisories(controls, [{name: STRENGTH.name, foldStrength}]);
    assert.equal(strength.domElement.querySelector('.param-fold-note'), null);
  }
  syncParamAdvisories(controls, []);
  assert.equal(strength.$input.getAttribute('aria-describedby'), 'param-range-flow.strength');
  assert.equal(strength.getValue(), 0.7);
});

test('a spaced parameter name publishes resolvable fold and range description tokens', () => {
  const name = 'Flow Strength';
  const controller = addParamControl(fakePanelGui(), {[name]: 0.7}, {...STRENGTH, name});
  syncParamAdvisories(new Map([[name, controller]]), [{name, foldStrength: 0.2}]);
  const tokens = controller.$input.getAttribute('aria-describedby').split(' ');
  assert.equal(tokens.length, 2);
  for (const id of tokens)
    assert.ok(controller.domElement.querySelectorAll('[id]').some((element) => element.id === id));
});

test('panel refreshes changed parameters while paused without writing strength', () => {
  const h = makeHarness({ params: [STRENGTH], engineValues: [0.7] });
  h.state.advisories = [{ name: STRENGTH.name, foldStrength: 0.2 }];
  h.panel.build();
  const controller = h.panel.active().controllerByName.get(STRENGTH.name);
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-high'), '60%');
  const writes = [...h.writes];
  h.state.advisories = [{ name: STRENGTH.name, foldStrength: 0.5 }];
  h.state.engineValues[0] = 0.8;
  h.panel.sync(false);
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-high'), '75%');
  assert.deepEqual(h.writes, writes);
  assert.equal(controller.getValue(), 0.8);
  h.panel.destroy();
});


test('unchanged frames reuse estimates without querying parameter controls', () => {
  const h = makeHarness({ params: [STRENGTH], engineValues: [0.7] });
  h.state.advisories = [{ name: STRENGTH.name, foldStrength: 0.2 }];
  h.panel.build();
  const controller = h.panel.active().controllerByName.get(STRENGTH.name);
  const query = controller.domElement.querySelector.bind(controller.domElement);
  let queries = 0;
  controller.domElement.querySelector = (...args) => { queries += 1; return query(...args); };
  for (let frame = 0; frame < 5; frame += 1) h.panel.sync();
  assert.equal(h.state.advisoryReads, 1);
  assert.equal(queries, 0);
  h.state.engineValues[0] = 0.8;
  h.panel.sync();
  assert.equal(h.state.advisoryReads, 2);
  assert.equal(queries, 0);
  h.panel.sync();
  assert.equal(h.state.advisoryReads, 2);
  h.panel.destroy();
});

test('accepted edits refresh estimates before the live value stream advances', () => {
  const h = makeHarness({ params: [STRENGTH], engineValues: [0.7] });
  h.state.advisories = [{ name: STRENGTH.name, foldStrength: 0.2 }];
  h.panel.build();
  const controller = h.panel.active().controllerByName.get(STRENGTH.name);
  h.state.advisories = [{ name: STRENGTH.name, foldStrength: 0.5 }];
  controller.setValue(0.8);
  h.panel.sync(false);
  assert.equal(h.state.advisoryReads, 2);
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-high'), '75%');
  h.panel.sync(false);
  assert.equal(h.state.advisoryReads, 2);
  h.panel.destroy();
});


test('changed advisory estimates repaint even when their list is reused', () => {
  const h = makeHarness({params: [STRENGTH], engineValues: [0.7]});
  h.state.advisories = [{name: STRENGTH.name, foldStrength: 0.2}];
  h.panel.build();
  const root = h.panel.active().controllerByName.get(STRENGTH.name).domElement;
  h.state.advisories[0].foldStrength = 0.5;
  h.state.engineValues[0] = 0.8;
  h.panel.sync();
  assert.equal(root.style.getPropertyValue('--param-fold-high'), '75%');
  h.state.advisories = [];
  h.state.engineValues[0] = 0.9;
  h.panel.sync();
  assert.equal(root.classList.contains('param-fold-advisory'), false);
  h.panel.destroy();
});
