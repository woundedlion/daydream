import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeGui} from './helpers/fake_gui.js';
import {pageWarmer} from '../src/segments/module_warmer.js';
import {installConsoleCapture} from './helpers/fake_console.js';
import {createSegmentedPovControls, createSegmentPoolSpawner} from '../src/ui/segmented_pov_controls.js';
import {maxSegmentCount, SEGMENT_COUNT_MAX} from '../src/segments/segment_policy.js';

const NAV = { hardwareConcurrency: 8 };
const DESKTOP_CAP = maxSegmentCount(NAV, false);
const MOBILE_CAP = maxSegmentCount(NAV, true);

test('a segmented-POV failure is announced and returns the toggle', async (t) => {
  const gui = fakeGui('view');
  const notices = [];
  const segments = {
    active: false,
    count: 2,
    showBoundaries: false,
    create() { throw new Error('a worker would not start'); },
    destroy() {},
    updateStats() {},
  };
  t.mock.method(pageWarmer, 'warm', async () => {});
  createSegmentedPovControls({
    gui,
    segments,
    nav: NAV,
    win: {},
    showNotice: (message) => notices.push(message),
  });
  const enabled = gui.folders.find((f) => f.namespace === 'Segmented POV')
    .controllers.find((c) => c.property === 'segmented');

  // lil-gui writes the bound object before firing the handler.
  enabled.object[enabled.property] = true;
  const capture = installConsoleCapture('error', 'warn');
  try {
    await enabled.changed(true);
  } finally {
    capture.restore();
  }
  assert.ok(capture.messages.some((message) =>
    /Segmented POV: enable failed;.*would not start/.test(message)));

  assert.match(notices.at(-1), /Segmented POV enable failed:.*would not start/,
    'a console-only failure is invisible: the user sees the toggle flip back '
    + 'and cannot tell it from a mis-click, and the fault banner covers only '
    + 'latched runtime faults');
  assert.equal(enabled.object[enabled.property], false,
    'the failed switch leaves the bound state disabled');
});

test('segmented controls reconcile a mobile spawn and resize without a second pool', async (t) => {
  const gui = fakeGui('view');
  const created = [];
  const layout = { matches: false };
  const win = { matchMedia: () => layout };
  const segments = {
    active: false, count: SEGMENT_COUNT_MAX, showBoundaries: false,
    destroyed: 0,
    create(count) { this.count = count; created.push(count); },
    destroy() { this.destroyed += 1; },
  };
  let finishWarm;
  t.mock.method(pageWarmer, 'warm', () => new Promise(resolve => { finishWarm = resolve; }));
  const notices = [];
  createSegmentedPovControls({ gui, segments, nav: NAV, win,
    showNotice: message => notices.push(message) });
  const controls = gui.folders[0].controllers;
  const enabled = controls.find(control => control.property === 'segmented');
  const count = controls.find(control => control.property === 'segments');
  enabled.object.segmented = true;
  const start = enabled.changed(true);
  layout.matches = true;
  finishWarm();
  await start;
  assert.deepEqual(created, [MOBILE_CAP]);
  assert.equal(count.object.segments, MOBILE_CAP);
  assert.equal(segments.active, true);
  t.mock.method(pageWarmer, 'warm', async () => {});
  count.object.segments = 2;
  await count.changed(2);
  assert.deepEqual(created, [MOBILE_CAP, 2]);
  assert.equal(count.object.segments, 2);
  enabled.object.segmented = false;
  await enabled.changed(false);
  assert.equal(segments.active, false);
  assert.equal(segments.destroyed, 1);
  assert.deepEqual(notices, []);
});

test('the spawn bounds the pool by the ceiling the device carries now', () => {
  const created = [];
  let requested = SEGMENT_COUNT_MAX;
  let mobile = false;
  const spawn = createSegmentPoolSpawner(
    { create: (count) => created.push(count) },
    () => requested,
    NAV,
    () => mobile);

  spawn();
  requested = 6;
  mobile = true;
  spawn();

  assert.deepEqual(created, [Math.min(SEGMENT_COUNT_MAX, DESKTOP_CAP), Math.min(6, MOBILE_CAP)],
    'a rotation into the mobile layout must lower the next pool spawn');
});

function layoutControlRig(t) {
  const gui = fakeGui('view');
  let changed;
  let removed;
  const query = {
    matches: false,
    addEventListener(type, handler) { changed = handler; },
    removeEventListener(type, handler) { removed = handler; },
  };
  const created = [];
  const segments = { active: false, count: SEGMENT_COUNT_MAX, showBoundaries: false,
    create(count) { this.count = count; created.push(count); }, destroy() {} };
  t.mock.method(pageWarmer, 'warm', async () => {});
  const spawn = createSegmentedPovControls({ gui, segments, nav: NAV,
    win: { matchMedia: () => query }, showNotice() {} });
  const controls = gui.folders[0].controllers;
  const count = controls.find(control => control.property === 'segments');
  return {count, query, segments, spawn, created, changed: () => changed(), get listener() { return changed; }, get removed() { return removed; }};
}

test('segmented slider and pool follow viewport layout changes', async (t) => {
  const {count, query, segments, spawn, created, changed} = layoutControlRig(t);
  assert.equal(count.args[1], DESKTOP_CAP);
  assert.equal(count.label, 'Segments (6 = sim only)');
  query.matches = true;
  changed();
  assert.equal(count.args[1], MOBILE_CAP);
  assert.equal(count.label, `Segments (max ${MOBILE_CAP} here)`);
  assert.equal(count.object.segments, MOBILE_CAP);
  segments.active = true;
  await spawn.respawn();
  assert.deepEqual(created, [MOBILE_CAP]);
  query.matches = false;
  changed();
  assert.equal(count.args[1], DESKTOP_CAP);
  assert.equal(count.label, 'Segments (6 = sim only)');
  spawn.dispose();
});

test('segmented control disposal releases its viewport listener', (t) => {
  const rig = layoutControlRig(t);
  rig.spawn.dispose();
  assert.equal(rig.removed, rig.listener);
});

test('segment resize failure destroys the pool and clears Enabled while boundaries remain wired', async (t) => {
  const gui = fakeGui('view');
  const notices = [];
  const segments = { active: true, count: 2, showBoundaries: false, destroyed: 0,
    create() { throw new Error('resize refused'); },
    destroy() { this.destroyed += 1; }, updateStats() {},
  };
  t.mock.method(pageWarmer, 'warm', async () => {});
  const guard = createSegmentedPovControls({ gui, segments, nav: NAV,
    win: {}, showNotice: (message) => notices.push(message) });
  t.after(() => guard.dispose());
  const controls = gui.folders[0].controllers;
  const count = controls.find((control) => control.property === 'segments');
  const enabled = controls.find((control) => control.property === 'segmented');
  const capture = installConsoleCapture('error', 'warn');
  try {
    count.object.segments = 4;
    await count.changed(4);
  } finally { capture.restore(); }
  assert.match(notices.at(-1), /Segmented POV resize failed:.*resize refused/);
  assert.ok(capture.messages.some((message) => /resize failed/.test(message)));
  assert.ok(segments.destroyed >= 1);
  assert.equal(segments.active, false);
  assert.equal(enabled.object.segmented, false);
  const boundaries = controls.find((control) => control.property === 'boundaries');
  boundaries.setValue(true);
  assert.equal(segments.showBoundaries, true);
  boundaries.setValue(false);
  assert.equal(segments.showBoundaries, false);
});
