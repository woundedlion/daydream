import {test} from 'node:test';
import assert from 'node:assert/strict';
import {updateReadonlyNumber} from '../src/ui/readonly_number_adapter.js';
import {addParamControl, presentReadonlyParam} from '../src/ui/effect_param_controls.js';
import {fakePanelGui} from './helpers/fake_gui.js';
import {restoreDocumentAfterEach} from './helpers/fake_dom.js';

restoreDocumentAfterEach();

test('focused readonly numbers repaint and restore focus after success or failure', () => {
  const controller = {
    _inputFocused: true, value: 42, displayed: 0, failure: false,
    updateDisplay() {
      if (this.failure) throw new Error('display failed');
      if (!this._inputFocused) this.displayed = this.value;
      return this;
    },
  };
  updateReadonlyNumber(controller);
  assert.equal(controller.updateDisplay(), controller);
  assert.equal(controller.displayed, 42);
  assert.equal(controller._inputFocused, true);
  controller._inputFocused = false;
  controller.value = 43;
  controller.updateDisplay();
  assert.equal(controller.displayed, 43);
  assert.equal(controller._inputFocused, false);
  controller._inputFocused = true;
  controller.failure = true;
  assert.throws(() => controller.updateDisplay(), /display failed/);
  assert.equal(controller._inputFocused, true);
});

test('readonly presentation wraps continuous numbers only', () => {
  const gui = fakePanelGui();
  for (const definition of [{value: 1}, {value: 1, step: 1}, {value: true},
    {value: 0, options: ['ready', 'waiting']}]) {
    const {value} = definition;
    const continuous = typeof value === 'number' && !definition.options;
    const controller = addParamControl(gui, {Telemetry: value}, {name: 'Telemetry', ...definition});
    let displayed = null;
    controller._inputFocused = true;
    const original = controller.updateDisplay = function () {
      if (!this._inputFocused) displayed = this.getValue();
      return this;
    };
    presentReadonlyParam(controller);
    controller.updateDisplay();
    assert.equal(displayed, continuous ? value : null);
    assert.equal(controller._inputFocused, true);
    assert.equal(controller.updateDisplay === original, !continuous);
  }
});
