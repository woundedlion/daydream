import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageGrouping } from '../src/ui/effect_param_controls.js';
import {
  KALEIDOSCOPE_SMOOTH_STAGE_ORDER,
  KALEIDOSCOPE_SMOOTH_STAGE_TITLES,
  LATTICE_MELT_STAGE_ORDER,
  LATTICE_MELT_STAGE_TITLES,
} from '../src/effects/shader_stages.js';
import { kaleidoscopeSmoothParams, latticeMeltParams } from './helpers/effect_gui_harness.js';

const named = (...names) => names.map((name) => ({ name, value: 0, min: 0, max: 1 }));

test('stageGrouping gives the LatticeMelt roster its fixed titles and order', () => {
  const params = latticeMeltParams();
  const grouping = stageGrouping(params);
  assert.equal(grouping.titles, LATTICE_MELT_STAGE_TITLES);
  assert.equal(grouping.order, LATTICE_MELT_STAGE_ORDER);
  assert.equal(grouping.assignments.size, params.length);
});

test('stageGrouping gives the KaleidoscopeSmooth roster its fixed titles and order', () => {
  const grouping = stageGrouping(kaleidoscopeSmoothParams());
  assert.equal(grouping.titles, KALEIDOSCOPE_SMOOTH_STAGE_TITLES);
  assert.equal(grouping.order, KALEIDOSCOPE_SMOOTH_STAGE_ORDER);
});

test('stageGrouping orders a composed list by the stages it claims, untitled', () => {
  const grouping = stageGrouping(named('Palette Chroma', 'Camera Wander', 'Mapping Frequency'));
  assert.equal(grouping.titles, null);
  assert.deepEqual(grouping.order, ['Camera', 'Colorize']);
  assert.deepEqual([...grouping.assignments],
    [['Palette Chroma', 'Colorize'], ['Camera Wander', 'Camera'], ['Mapping Frequency', 'Colorize']]);
});

test('stageGrouping claims no list that no recognizer claims', () => {
  assert.equal(stageGrouping(named('Speed', 'Camera Wander')), null);
  assert.equal(stageGrouping([]), null);
});
