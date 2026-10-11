import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageGrouping } from '../src/effects/shader_stages.js';
import { kaleidoscopeSmoothParams, latticeMeltParams } from './helpers/effect_gui_harness.js';

test('stageGrouping uses registered titles and pipeline order', () => {
  const params = latticeMeltParams();
  const grouping = stageGrouping(params);
  assert.deepEqual(grouping.order, ['Camera', 'Surface Noise', 'Projection Frame', 'Projection', 'Function', 'Colorize']);
  assert.equal(grouping.titles.get('Surface Noise'), 'Curl');
  assert.equal(grouping.titles.get('Function'), 'Primitive Lattice');
  assert.equal(grouping.assignments.size, params.length);
  const other = stageGrouping(kaleidoscopeSmoothParams());
  assert.equal(other.titles.get('Planar Warp 2'), 'Mirror Tile');
});

test('stageGrouping assigns unfamiliar labels from engine metadata', () => {
  const grouping = stageGrouping([
    {name: 'Vapor Ridges', group: {name: 'Function', title: 'Cloud Shape', order: 7}},
    {name: 'View Jitter', group: {name: 'Camera', title: 'Camera', order: 0}},
    {name: 'Unassigned'},
  ]);
  assert.deepEqual(grouping.order, ['Camera', 'Function']);
  assert.deepEqual([...grouping.assignments], [['Vapor Ridges', 'Function'], ['View Jitter', 'Camera']]);
  assert.deepEqual([...grouping.titles], [['Camera', 'Camera'], ['Function', 'Cloud Shape']]);
});

test('stageGrouping does not infer a group from a familiar label', () => {
  assert.equal(stageGrouping([{name: 'Camera Wander'}, {name: 'Palette Chroma'}, {name: 'Mapping Frequency'}]), null);
  assert.equal(stageGrouping([]), null);
});
