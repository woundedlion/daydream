import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakePanelGui} from './helpers/fake_app.js';
import {restoreDocumentAfterEach} from './helpers/fake_dom.js';
import {SPEED, GLOW} from './helpers/effect_gui_harness.js';
import {addParamControl, sliderDecimals} from '../src/ui/effect_param_controls.js';

restoreDocumentAfterEach();

test('a numeric param becomes a slider bounded by the definition', () => {
  const gui = fakePanelGui();
  const state = { Speed: 0.1 };
  const controller = addParamControl(gui, state, SPEED);

  assert.deepEqual(controller.args, [0, 1]);
  assert.equal(controller.decimalsSet, 3);
  assert.equal(controller.isBoolean, false);
});

test('a narrow numeric range displays its nonzero slider steps', () => {
  const gui = fakePanelGui();
  const speed = {
    name: 'Hue Noise Speed', value: 0.000016, min: -0.008, max: 0.008,
    animated: true,
  };
  const state = { 'Hue Noise Speed': speed.value };
  const controller = addParamControl(gui, state, speed);

  assert.equal(controller.decimalsSet, 5);
  assert.equal(controller.getValue(), 0.000016);
});

test('slider decimals resolve one lil-gui step of the range', () => {
  const step = (min, max) => Math.abs(max - min) / 1000;
  for (const [min, max] of [
    [0, 1], [0, 0.15], [0.5, 1], [0, 0.8], [-0.008, 0.008], [0, 10],
    [0, 2 * Math.PI], [-1, 1], [0, 100], [0, 0.01],
  ]) {
    const decimals = sliderDecimals(min, max);
    assert.ok(Math.pow(10, -decimals) <= step(min, max) * (1 + 1e-9),
      `[${min}, ${max}] must print finer than its ${step(min, max)} step`);
    assert.notEqual(min.toFixed(decimals), (min + step(min, max)).toFixed(decimals),
      `[${min}, ${max}] must print adjacent steps differently`);
  }
});

test('slider decimals fall back on a degenerate range', () => {
  assert.equal(sliderDecimals(1, 1), 3);
  assert.equal(sliderDecimals(0, Infinity), 3);
  assert.equal(sliderDecimals(0, NaN), 3);
});

test('an integer param becomes a slider stepped to whole values', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Burst: 4 },
    { name: 'Burst', value: 4, min: 1, max: 32, step: 1 });

  assert.deepEqual(controller.args, [1, 32, 1]);
  assert.equal(controller.decimalsSet, 0);
  assert.equal(controller.isBoolean, false);
});

test('a boolean param becomes a toggle with no range arguments', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Glow: false }, GLOW);

  assert.deepEqual(controller.args, []);
  assert.equal(controller.isBoolean, true);
});

test('an enumerated param becomes a dropdown of labels to engine indices', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Mode: 0 },
    { name: 'Mode', value: 0, options: ['Off', 'On', 'Auto'] });

  // The choices table carries a null prototype, so it is spread to compare.
  assert.equal(controller.args.length, 1);
  assert.deepEqual({ ...controller.args[0] }, { Off: 0, On: 1, Auto: 2 });
  assert.equal(controller.isBoolean, false);
  assert.equal(controller.isContinuous, false);
});

test('an invalid param carries an actionable, on-screen warning note', () => {
  const gui = fakePanelGui();
  const warning = 'Legacy Stereo Noise requires Projection = Stereographic.';
  const controller = addParamControl(gui, { Projection: 3 }, {
    name: 'Projection',
    value: 3,
    options: ['Sinusoidal', 'Stereographic', 'Gnomonic', 'Bonne'],
    warning,
  });

  assert.equal(controller.domElement.classList.contains('param-warning'), true);
  assert.equal(controller.domElement.getAttribute('title'), null,
    'the text is on screen, not behind a pointer-only tooltip');
  // The wrapper is a plain div, so the state and the description belong on the
  // widget that carries the control's role.
  assert.equal(controller.domElement.getAttribute('aria-invalid'), null);
  assert.equal(controller.$select.getAttribute('aria-invalid'), 'true');

  const note = controller.domElement.querySelector('.param-warning-note');
  assert.equal(note.textContent, warning);
  assert.equal(note.classList.contains('visually-hidden'), false);
  assert.equal(controller.$select.getAttribute('aria-describedby'), note.id);
  assert.equal(note.id, 'param-warning-Projection');
});

test('warning ids separate names that differ only in punctuation or case', () => {
  const gui = fakePanelGui();
  const warned = (name) => addParamControl(gui, { [name]: 0 },
    { name, value: 0, min: 0, max: 1, warning: `${name} is out of range.` });

  const notes = ['Hue Shift', 'Hue-Shift', 'hue shift'].map((name) => {
    const controller = warned(name);
    const note = controller.domElement.querySelector('.param-warning-note');
    assert.equal(controller.$input.getAttribute('aria-describedby'), note.id,
      'the description points at the note this control published');
    return note;
  });

  assert.equal(new Set(notes.map((note) => note.id)).size, notes.length);
});

test('a param without a warning carries no invalid state or description', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Speed: 0.1 }, SPEED);

  assert.equal(controller.$input.getAttribute('aria-invalid'), null);
  assert.equal(controller.$input.getAttribute('aria-describedby'), null);
  assert.equal(controller.domElement.querySelector('.param-warning-note'), null);
});

test('a boolean carrying option labels stays a toggle', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Glow: true },
    { name: 'Glow', value: true, options: ['Off', 'On'] });

  assert.deepEqual(controller.args, []);
  assert.equal(controller.isBoolean, true);
});
