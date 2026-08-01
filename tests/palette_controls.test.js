import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createZoomHistory, lockedGroupMove, ZOOMED_PARAMS } =
  await import('../tools/palette_controls.js');

/** The 12-coefficient shape the palette page holds, with recognizable C/D values. */
const params = () => ({
  A_R: 0.5, A_G: 0.5, A_B: 0.5,
  B_R: 0.5, B_G: 0.5, B_B: 0.5,
  C_R: 1, C_G: 2, C_B: 3,
  D_R: 0.1, D_G: 0.2, D_B: 0.3,
});

/** Verifies a fresh history holds nothing and has nothing to restore. */
test('a fresh zoom history is empty', () => {
  const history = createZoomHistory();
  assert.equal(history.zoomed, false);
  assert.equal(history.restore(), null);
});

/** Verifies a capture snapshots exactly the frequency/phase coefficients a zoom rewrites. */
test('capture snapshots only the frequency and phase coefficients', () => {
  const history = createZoomHistory();
  history.capture(params());
  assert.equal(history.zoomed, true);

  const restored = history.restore();
  assert.deepEqual(Object.keys(restored).sort(), [...ZOOMED_PARAMS].sort());
  assert.deepEqual(restored, { C_R: 1, C_G: 2, C_B: 3, D_R: 0.1, D_G: 0.2, D_B: 0.3 });
});

/** Verifies the snapshot is a copy, so later parameter edits cannot mutate the history. */
test('the snapshot is detached from the live parameter object', () => {
  const history = createZoomHistory();
  const live = params();
  history.capture(live);
  live.C_R = 99;
  assert.equal(history.restore().C_R, 1);
});

/** Verifies successive zooms keep the FIRST pre-zoom state, so reset returns to the start. */
test('a second capture does not overwrite the first pre-zoom state', () => {
  const history = createZoomHistory();
  history.capture(params());
  history.capture({ ...params(), C_R: 0.25, D_R: 0.9 });
  const restored = history.restore();
  assert.equal(restored.C_R, 1);
  assert.equal(restored.D_R, 0.1);
});

/** Verifies restore is one-shot: the history empties, so a second reset is a no-op. */
test('restore consumes the snapshot', () => {
  const history = createZoomHistory();
  history.capture(params());
  assert.notEqual(history.restore(), null);
  assert.equal(history.zoomed, false);
  assert.equal(history.restore(), null);
});

/** Verifies clear() abandons the snapshot, as a manual C/D edit must. */
test('clear discards the snapshot without restoring it', () => {
  const history = createZoomHistory();
  history.capture(params());
  history.clear();
  assert.equal(history.zoomed, false);
  assert.equal(history.restore(), null);
});

/** A locked group of three sliders sharing raw bounds, at the given start values. */
const group = (starts, min = 0, max = 1000) =>
  ['A_R', 'A_G', 'A_B'].map((param, i) => ({ param, start: starts[i], min, max }));

/** Verifies an in-range delta passes through and moves every member by the same amount. */
test('an in-range delta moves the whole group rigidly', () => {
  const { delta, values } = lockedGroupMove(100, group([200, 400, 600]));
  assert.equal(delta, 100);
  assert.deepEqual(values, { A_R: 300, A_G: 500, A_B: 700 });
});

/** Verifies the member nearest the upper bound caps the group instead of clipping alone. */
test('the member closest to the maximum caps a positive delta', () => {
  const { delta, values } = lockedGroupMove(500, group([200, 400, 900]));
  assert.equal(delta, 100);
  assert.deepEqual(values, { A_R: 300, A_G: 500, A_B: 1000 });
});

/** Verifies the member nearest the lower bound caps the group for a negative delta. */
test('the member closest to the minimum caps a negative delta', () => {
  const { delta, values } = lockedGroupMove(-500, group([200, 400, 900]));
  assert.equal(delta, -200);
  assert.deepEqual(values, { A_R: 0, A_G: 200, A_B: 700 });
});

/** Verifies a group already spanning its whole range cannot move in either direction. */
test('a group spanning the full range is pinned', () => {
  assert.equal(lockedGroupMove(50, group([0, 500, 1000])).delta, 0);
  assert.equal(lockedGroupMove(-50, group([0, 500, 1000])).delta, 0);
});

/** Verifies members whose start value could not be read are left out entirely. */
test('members with no start value are ignored', () => {
  const members = group([200, undefined, 900]);
  const { delta, values } = lockedGroupMove(500, members);
  // A_G contributes no bound and receives no value; A_B still caps the group.
  assert.equal(delta, 100);
  assert.deepEqual(values, { A_R: 300, A_B: 1000 });
});

/** Verifies negative raw bounds (the frequency/phase groups) cap the same way. */
test('negative raw bounds cap correctly', () => {
  const members = ['C_R', 'C_G', 'C_B'].map((param, i) => ({
    param, start: [-4000, 0, 4000][i], min: -5000, max: 5000,
  }));
  assert.equal(lockedGroupMove(-2000, members).delta, -1000);
  assert.equal(lockedGroupMove(2000, members).delta, 1000);
});
