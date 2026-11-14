import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forceNumberDisplay} from '../src/ui/lil_gui_adapter.js';
import {addParamControl, presentReadonlyParam} from '../src/ui/effect_param_controls.js';
import {fakePanelGui} from './helpers/fake_gui.js';
import {restoreDocumentAfterEach} from './helpers/fake_dom.js';

restoreDocumentAfterEach();

test('forced number text follows each repaint and a repaint failure propagates', () => {
  const controller = {
    $input: {value: '', readOnly: false}, value: 42.5, failure: false,
    getValue() { return this.value; },
    updateDisplay() {
      if (this.failure) throw new Error('display failed');
      return this;
    },
  };
  forceNumberDisplay(controller, 1);
  assert.equal(controller.$input.readOnly, true);
  assert.equal(controller.updateDisplay(), controller);
  assert.equal(controller.$input.value, '42.5');
  controller.value = 43;
  controller.updateDisplay();
  assert.equal(controller.$input.value, '43.0');
  controller.failure = true;
  controller.value = 44;
  assert.throws(() => controller.updateDisplay(), /display failed/);
  assert.equal(controller.$input.value, '43.0');
});

test('a controller without a text box is left unchanged', () => {
  const updateDisplay = () => {};
  const controller = {getValue: () => 1, updateDisplay};
  forceNumberDisplay(controller, 0);
  assert.equal(controller.updateDisplay, updateDisplay);
});

test('readonly presentation forces continuous numbers only, at their slider decimals', () => {
  const gui = fakePanelGui();
  for (const definition of [{value: 1.25, min: 0, max: 10}, {value: 3, min: 0, max: 10, step: 1},
    {value: true}, {value: 0, options: ['ready', 'waiting']}]) {
    const {value} = definition;
    const continuous = typeof value === 'number' && !definition.options;
    const controller = addParamControl(gui, {Telemetry: value}, {name: 'Telemetry', ...definition});
    const original = controller.updateDisplay;
    if (controller.$input) controller.$input.value = 'stale';
    presentReadonlyParam(controller);
    controller.updateDisplay();
    assert.equal(controller.updateDisplay === original, !continuous);
    if (continuous) assert.equal(controller.$input.value, definition.step ? '3' : '1.25');
  }
});
