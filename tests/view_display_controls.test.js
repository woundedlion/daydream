import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createViewDisplayControls} from '../src/app/view_display_controls.js';
import {PovSweep} from '../src/renderer/pov_sweep.js';
import {fakeGui} from './helpers/fake_gui.js';

function fixture({hydratedView = {}} = {}) {
  const gui = fakeGui('view', {hydrated: hydratedView});
  const driver = {
    povFidelity: false, povResponseScale: 1, showSweepBoundary: false,
    noBlackColumns: false, paused: false, invalidated: false,
    invalidate() { this.invalidated = true; },
    stepOnce() { this.steps = (this.steps ?? 0) + 1; },
    setDisplayGeometry(geometry) { Object.assign(this, geometry); },
    resetPovNow() { this.reset = 'now'; },
    resetPovOnNextFrame() { this.reset = 'next'; },
  };
  const writes = [];
  const segments = {
    ownsDisplay: false,
    setTemporalSampling: (value) => writes.push(['temporal', value]),
    setPoleLod: (value) => writes.push(['pole', value]),
    setDisplayCaps: (top, bottom) => writes.push(['caps', top, bottom]),
  };
  const host = {
    engine: null, adapter: null,
    invalidateView: () => writes.push(['invalidate']),
    refresh: () => writes.push(['refresh']),
  };
  const controls = createViewDisplayControls({gui, driver, host, segments,
    syncEffectGui: (advanced) => writes.push(['sync', advanced])});
  return {gui, driver, host, segments, writes, controls};
}

test('display replay applies queued caps and pole LOD after the engine arrives', () => {
  const {gui, driver, host, writes, controls} = fixture();
  const control = (property) => gui.controllers.find((item) => item.property === property);
  control('topCap').setValue(2);
  control('bottomCap').setValue(3);
  control('poleLod').setValue(1.5);
  let caps = [0, 0];
  host.engine = {
    setDisplayCaps: (top, bottom) => { caps = [top, bottom]; return true; },
    getDisplayNorthPhi: () => caps[0] / 100 * Math.PI,
    getDisplaySouthPhi: () => (1 - caps[1] / 100) * Math.PI,
    setPoleLod: (value) => writes.push(['engine-pole', value]),
  };

  assert.equal(controls.replay(), true);

  assert.deepEqual(caps, [2, 3]);
  assert.equal(driver.DISPLAY_NORTH_PHI, 0.02 * Math.PI);
  assert.equal(driver.DISPLAY_SOUTH_PHI, 0.97 * Math.PI);
  assert.ok(writes.some(([operation, value]) => operation === 'engine-pole' && value === 1.5));
  host.engine.setDisplayCaps = () => false;
  assert.throws(() => control('topCap').setValue(4), /Engine rejected display cap settings/);
  assert.equal(control('topCap').getValue(), 2);
  assert.equal(driver.DISPLAY_NORTH_PHI, 0.02 * Math.PI);
  assert.equal(controls.replay(), false);
});

test('a fidelity edit repaints the paused main preview unless the pool owns it', () => {
  const {gui, driver, host, segments, writes} = fixture();
  driver.paused = true;
  host.engine = {setTemporalSampling: (value) => writes.push(['engine-temporal', value])};
  host.adapter = {drawFrame: () => writes.push(['draw'])};
  const fidelity = gui.controllers.find((control) => control.property === 'povFidelity');

  fidelity.setValue(true);
  const first = writes.splice(0);
  segments.ownsDisplay = true;
  fidelity.setValue(false);
  const second = writes.splice(0);

  const has = (log, entry) => log.some((write) => JSON.stringify(write) === JSON.stringify(entry));
  assert.ok(has(first, ['engine-temporal', true]) && has(first, ['temporal', true]),
    'both sinks receive the first edit');
  assert.equal(first.filter(([operation]) => operation === 'draw').length, 1);
  assert.equal(first.at(-1)[0], 'draw', 'the repaint follows the writes');
  assert.ok(has(second, ['engine-temporal', false]) && has(second, ['temporal', false]),
    'both sinks receive the second edit');
  assert.ok(!has(second, ['draw']), 'the pool owns the display, so the main preview is not drawn');
});

test('column defaults preserve a hydrated choice until a live edit takes precedence', () => {
  const {gui, driver, host, controls} = fixture({hydratedView: {noBlackColumns: true}});
  assert.equal(controls.columnDefaultsReady(), false);
  driver.noBlackColumns = false;
  host.engine = {};
  controls.finishColumnDefaults();
  assert.equal(driver.noBlackColumns, true);
  assert.equal(controls.columnDefaultsReady(), true);

  const column = gui.controllers.find((control) => control.property === 'noBlackColumns');
  column.setValue(false);
  controls.finishColumnDefaults();
  assert.equal(driver.noBlackColumns, false);
});

test('POV fidelity defaults off and toggling it requests a repaint', () => {
  const { gui, driver } = fixture();
  const control = gui.controllers.find((c) => c.property === 'povFidelity');
  assert.equal(control.getValue(), false);
  driver.invalidated = false;
  control.setValue(true);
  assert.equal(driver.povFidelity, true);
  assert.equal(driver.invalidated, true);
});

test('response timescale is a persistent view control', () => {
  const { gui, driver } = fixture();
  const control = gui.controllers.find((c) => c.property === 'povResponseScale');
  assert.equal(control.getValue(), 1);
  assert.deepEqual(control.args.slice(0, 2), [PovSweep.MIN_RESPONSE_SCALE, PovSweep.MAX_RESPONSE_SCALE]);
  assert.equal(control.session, undefined);
  assert.ok(gui.collectUrlKeys().includes('view.povResponseScale'));
  driver.invalidated = false;
  control.setValue(2);
  assert.equal(driver.povResponseScale, 2);
  assert.equal(driver.invalidated, true);
});

test('hydrated fidelity controls retain their response timescale', () => {
  for (const povFidelity of [false, true]) {
    const {gui} = fixture({hydratedView: {povFidelity, povResponseScale: 1.3}});
    const response = gui.controllers.find(c => c.property === 'povResponseScale');
    assert.equal(response.disabled, !povFidelity);
    assert.equal(response.getValue(), 1.3);
  }
});

test('response availability follows fidelity without resetting its value', () => {
  const { gui } = fixture();
  const control = (name) => gui.controllers.find((c) => c.property === name);
  const response = control('povResponseScale');
  const arms = control('showSweepBoundary');
  assert.equal(arms.disabled, true);
  assert.equal(response.disabled, true);
  control('povFidelity').setValue(true);
  assert.equal(arms.disabled, false);
  assert.equal(response.disabled, false);
  response.setValue(1.5);
  control('povFidelity').setValue(false);
  assert.equal(arms.disabled, true);
  assert.equal(response.disabled, true);
  assert.equal(response.getValue(), 1.5);
  control('povFidelity').setValue(true);
  assert.equal(response.disabled, false);
  assert.equal(response.getValue(), 1.5);
});

test('the sweep boundary defaults off and persists as a view control', () => {
  const { gui, driver } = fixture();
  const control = gui.controllers.find((c) => c.property === 'showSweepBoundary');
  assert.equal(control.label, 'Show arm positions');
  assert.equal(control.getValue(), false);
  assert.equal(control.session, undefined);
  assert.ok(gui.collectUrlKeys().includes('view.showSweepBoundary'));
  driver.invalidated = false;
  control.setValue(true);
  assert.equal(driver.showSweepBoundary, true);
  assert.equal(driver.invalidated, true);
});
