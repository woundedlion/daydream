import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePanelGui } from './helpers/fake_app.js';
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
  assert.equal(controller.$input.getAttribute('aria-describedby'), note.id);
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
  syncParamAdvisories(controls, [{ name: STRENGTH.name, foldStrength: Infinity }]);
  assert.equal(controller.domElement.querySelector('.param-fold-note'), null);
});

test('panel polls changed field estimates while paused without writing strength', () => {
  const h = makeHarness({ params: [STRENGTH], engineValues: [0.7] });
  h.state.advisories = [{ name: STRENGTH.name, foldStrength: 0.2 }];
  h.panel.build();
  const controller = h.panel.active().controllerByName.get(STRENGTH.name);
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-high'), '60%');
  const writes = [...h.writes];
  h.state.advisories = [{ name: STRENGTH.name, foldStrength: 0.5 }];
  h.panel.sync(false);
  assert.equal(controller.domElement.style.getPropertyValue('--param-fold-high'), '75%');
  assert.deepEqual(h.writes, writes);
  assert.equal(controller.getValue(), 0.7);
  h.panel.destroy();
});
