import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakePanelGui } from './helpers/fake_app.js';
import { fakeCopyText } from './helpers/effect_gui_harness.js';
import {
  createEffectActions,
  EXPORT_COPIED,
  EXPORT_FAILED,
  FLASH_MS,
} from '../src/ui/effect_actions.js';

afterEach(() => { mock.timers.reset(); });

/**
 * The action row over a fake GUI and fake deps.
 * @param {Object} [options]
 * @returns {Object} The handle, its record, and the calls its deps saw.
 */
function actions({
  presetCount = 0,
  presetIndex = 0,
  accept = true,
  exported = { text: 'copied text' },
  copyText = fakeCopyText(),
} = {}) {
  const fx = { gui: fakePanelGui() };
  const calls = [];
  const warnings = [];
  const state = { presetIndex, active: true };
  const handle = createEffectActions(fx, {
    presets: {
      count: () => presetCount,
      index: () => state.presetIndex,
      select: (index) => {
        calls.push(`select:${index}`);
        if (accept) state.presetIndex = index;
        return accept;
      },
    },
    onPresetChange: (count, index) => calls.push(`change:${count}:${index}`),
    onReset: () => calls.push('reset'),
    buildExport: () => { calls.push('build'); return exported; },
    copyText,
    isActive: (record) => record === fx && state.active,
    logWarn: (...args) => warnings.push(args),
  });
  const ctrl = (property) => fx.gui.ctrl(property);
  const status = () => fx.gui.$children.children[0].querySelector('.visually-hidden');
  return { handle, fx, calls, warnings, state, copyText, ctrl, status };
}

test('Reset runs the coordinator callback and nothing else', () => {
  const a = actions();
  a.ctrl('reset').object.reset();
  assert.deepEqual(a.calls, ['reset']);
});

test('Export copies the text the coordinator builds and flashes success', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const a = actions();
  await a.ctrl('export').object.export();
  assert.deepEqual(a.copyText.copied, ['copied text']);
  assert.equal(a.ctrl('export').label, '\u2713');
  assert.equal(a.ctrl('export').$button.getAttribute('title'), EXPORT_COPIED);
  assert.equal(a.status().textContent, EXPORT_COPIED);
  mock.timers.tick(FLASH_MS);
  assert.equal(a.ctrl('export').label, '\u29c9');
  assert.equal(a.status().textContent, '');
});

test('an Export the coordinator refuses logs its reason and copies nothing', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const a = actions({ exported: { error: 'Export: blocked' } });
  a.ctrl('export').object.export();
  assert.deepEqual(a.copyText.copied, []);
  assert.deepEqual(a.warnings, [['Export: blocked']]);
  assert.equal(a.ctrl('export').label, '\u2717');
  assert.equal(a.status().textContent, EXPORT_FAILED);
});

test('an Export refusal with a cause logs the cause beside the reason', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const cause = new Error('format');
  const a = actions({ exported: { error: 'Export: formatting failed', cause } });
  a.ctrl('export').object.export();
  assert.deepEqual(a.warnings, [['Export: formatting failed', cause]]);
});

test('a failed or rejected copy flashes failure', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const refused = actions({ copyText: fakeCopyText(false) });
  await refused.ctrl('export').object.export();
  assert.equal(refused.ctrl('export').label, '\u2717');
  assert.deepEqual(refused.warnings, [['Export: clipboard copy failed']]);

  const error = new Error('denied');
  const rejected = actions({ copyText: fakeCopyText(error) });
  await rejected.ctrl('export').object.export();
  assert.equal(rejected.ctrl('export').label, '\u2717');
  assert.deepEqual(rejected.warnings, [['Export: clipboard copy failed', error]]);
});

test('a copy that lands after the record was replaced flashes nothing', async () => {
  for (const outcome of [true, new Error('late')]) {
    const a = actions({ copyText: fakeCopyText(outcome) });
    const pending = a.ctrl('export').object.export();
    a.state.active = false;
    await pending;
    assert.equal(a.ctrl('export').label, '\u29c9');
  }
});

test('cancel drops the pending Export label revert', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const a = actions({ exported: { error: 'Export: blocked' } });
  a.ctrl('export').object.export();
  a.handle.cancel();
  mock.timers.tick(FLASH_MS);
  assert.equal(a.ctrl('export').label, '\u2717');
});

test('an accepted preset selection hands count and index to the coordinator', () => {
  const a = actions({ presetCount: 3, presetIndex: 0 });
  assert.equal(a.handle.hasPresets(), true);
  assert.equal(a.handle.movePreset(-1), true);
  assert.deepEqual(a.calls, ['select:2', 'change:3:2']);
  a.ctrl('nextPreset').object.nextPreset();
  assert.deepEqual(a.calls.slice(2), ['select:0', 'change:3:0']);
});

test('a refused preset selection shows the engine preset and skips the coordinator', () => {
  const a = actions({ presetCount: 3, presetIndex: 1, accept: false });
  a.ctrl('presetIndex').setValue(2);
  assert.deepEqual(a.calls, ['select:2']);
  assert.equal(a.ctrl('presetIndex').getValue(), 1);
  assert.equal(a.handle.displayedPresetIndex(), 1);
});

test('showPreset moves the displayed index without selecting', () => {
  const a = actions({ presetCount: 3, presetIndex: 0 });
  a.handle.showPreset(3, 2);
  assert.equal(a.handle.displayedPresetIndex(), 2);
  assert.equal(a.ctrl('presetIndex').displayUpdates, 1);
  a.handle.showPreset(3, 2);
  a.handle.showPreset(0, 1);
  assert.equal(a.ctrl('presetIndex').displayUpdates, 1);
  assert.deepEqual(a.calls, []);
});

test('a row without presets builds no preset controls and moves nowhere', () => {
  const a = actions();
  assert.equal(a.handle.hasPresets(), false);
  assert.equal(a.handle.displayedPresetIndex(), null);
  assert.equal(a.handle.movePreset(1), false);
  a.handle.showPreset(3, 1);
  assert.deepEqual(a.handle.focusTargets().map(([key]) => key), ['reset', 'export']);
  assert.deepEqual(a.calls, []);
});

test('navigation on an emptied preset list selects nothing', () => {
  let count = 2;
  const fx = { gui: fakePanelGui() };
  const selects = [];
  const handle = createEffectActions(fx, {
    presets: { count: () => count, index: () => 0, select: (i) => selects.push(i) > 0 },
    onPresetChange: () => {}, onReset: () => {}, buildExport: () => ({ text: '' }),
    copyText: fakeCopyText(), isActive: () => true, logWarn: () => {},
  });
  count = 0;
  assert.equal(handle.movePreset(1), false);
  fx.gui.ctrl('presetIndex').setValue(1);
  assert.deepEqual(selects, []);
});

test('focusTargets keys every action controller by its bound property', () => {
  const a = actions({ presetCount: 2 });
  assert.deepEqual(a.handle.focusTargets(),
    ['reset', 'export', 'previousPreset', 'presetIndex', 'nextPreset']
      .map((property) => [property, a.ctrl(property)]));
});

test('detach returns the controllers to the GUI children and removes the row', () => {
  const a = actions({ presetCount: 2 });
  const row = a.fx.gui.$children.children[0];
  const targets = a.handle.focusTargets();
  a.handle.detach();
  assert.equal(row.parentNode, null);
  assert.equal(targets.length, 5);
  for (const [, controller] of targets) {
    assert.equal(controller.domElement.parentNode, a.fx.gui.$children);
  }
  assert.doesNotThrow(() => a.fx.gui.destroy());
});

test('a row that fails mid-build detaches what it built', () => {
  const gui = fakePanelGui();
  const add = gui.add;
  gui.add = (target, property, ...rest) => {
    if (property === 'export') throw new Error('add failed');
    return add(target, property, ...rest);
  };
  assert.throws(() => createEffectActions({ gui }, {
    presets: { count: () => 0, index: () => 0, select: () => false },
    onPresetChange: () => {}, onReset: () => {}, buildExport: () => ({ text: '' }),
    copyText: fakeCopyText(), isActive: () => true, logWarn: () => {},
  }), /add failed/);
  assert.equal(gui.ctrl('reset').domElement.parentNode, gui.$children);
  assert.equal(gui.$children.querySelector('.effect-action-row'), null);
});
