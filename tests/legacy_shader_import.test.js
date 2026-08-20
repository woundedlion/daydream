import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  importLegacyShaderSelection,
  LEGACY_SHADER_PRESETS,
  PIPELINE_EFFECTS,
} from '../legacy_shader_import.js';

// shaderball_migration.json is the manifest the promoted effects were cut from,
// so it — not a count written next to the table — says how many legacy presets
// the import must land.
const MANIFEST = JSON.parse(readFileSync(
  new URL('../shader/patterns/shaderball_migration.json', import.meta.url), 'utf8'));
const RETIRED = new Set(MANIFEST.retired_legacy_presets);

/**
 * The engine effect name a manifest effect id denotes.
 * @param {string} effectId - Kebab-case manifest effect id.
 * @returns {string} The registered effect name.
 */
const effectName = (effectId) => effectId.split('-')
  .map((word) => word[0].toUpperCase() + word.slice(1)).join('');

test('every legacy preset the manifest lists has a stable destination', () => {
  const destinations = new Map(
    MANIFEST.destinations.map((entry) => [entry.legacy_preset, entry]));
  assert.equal(LEGACY_SHADER_PRESETS.length,
    Math.max(...destinations.keys(), ...RETIRED) + 1,
    'the table must be indexed by legacy preset across the manifest range');

  for (let presetIndex = 0; presetIndex < LEGACY_SHADER_PRESETS.length; ++presetIndex) {
    const result = importLegacyShaderSelection('ShaderBall', {
      schemaVersion: 2, presetIndex, runtime: [presetIndex],
    });
    assert.equal(result.effect, LEGACY_SHADER_PRESETS[presetIndex][0]);
    assert.equal(result.presetId, LEGACY_SHADER_PRESETS[presetIndex][1]);
    assert.deepEqual(result.handoff, [presetIndex]);

    if (RETIRED.has(presetIndex)) {
      assert.equal(result.effect, MANIFEST.authoring_effect,
        `retired legacy preset ${presetIndex} opens in the authoring effect`);
      continue;
    }
    const destination = destinations.get(presetIndex);
    assert.ok(destination, `the manifest must claim legacy preset ${presetIndex}`);
    assert.equal(result.effect, effectName(destination.effect_id));
    assert.equal(result.presetId, destination.preset_id);
  }
});

test('every manifest pipeline routes a custom configuration', () => {
  const expected = Object.fromEntries(MANIFEST.destinations
    .map((entry) => [entry.pipeline, effectName(entry.effect_id)]));
  // The retired preset's pipeline has no destination row; a custom save built on
  // it opens in the authoring effect rather than a promoted one.
  expected.PEIRCE_DODECAHEDRAL_GRID = MANIFEST.authoring_effect;
  assert.deepEqual({ ...PIPELINE_EFFECTS }, expected);
});

test('custom fixed configurations retain parameters and runtime handoff', () => {
  const result = importLegacyShaderSelection('ShaderBall', {
    schemaVersion: 2,
    acceptedPipeline: 'SINUSOIDAL_CURL_LATTICE',
    accepted: [1, 2, 3],
    runtime: [4, 5],
  });
  assert.equal(result.effect, 'CurlLattice');
  assert.equal(result.presetId, undefined);
  assert.deepEqual(result.customParameters, [1, 2, 3]);
  assert.deepEqual(result.handoff, [4, 5]);
});

test('renamed effects and the retired Peirce look migrate to live destinations', () => {
  assert.equal(LEGACY_SHADER_PRESETS[2][0], 'AlienOcean');
  assert.equal(LEGACY_SHADER_PRESETS[4][0], 'Shader');
  assert.equal(LEGACY_SHADER_PRESETS[18][0], 'CosmicEyeball');
  assert.equal(LEGACY_SHADER_PRESETS[23][0], 'SignalWeave');

  const retired = importLegacyShaderSelection('ShaderBall', {
    schemaVersion: 2,
    acceptedPipeline: 'PEIRCE_DODECAHEDRAL_GRID',
    accepted: [1, 2, 3],
  });
  assert.equal(retired.effect, 'Shader');
  assert.deepEqual(retired.customParameters, [1, 2, 3]);
});

test('structural pending state opens in Shader without conflating endpoints', () => {
  const snapshot = {
    schemaVersion: 2,
    acceptedPipeline: 'SINUSOIDAL_CURL_LATTICE',
    pendingPipeline: 'GNOMONIC_GLITCH_GRID_MIRROR',
    accepted: [1], requested: [2], pending: [1], runtime: [3],
  };
  const result = importLegacyShaderSelection('ShaderBall', snapshot);
  assert.equal(result.effect, 'Shader');
  assert.equal(result.snapshot, snapshot);
  assert.match(result.notice, /pending and runtime state/);
});

test('invalid and unrelated identities are classified explicitly', () => {
  assert.deepEqual(importLegacyShaderSelection('CurlLattice'),
    { effect: 'CurlLattice', migrated: false });
  const invalid = importLegacyShaderSelection('ShaderBall', []);
  assert.equal(invalid.effect, 'Shader');
  assert.equal(invalid.diagnostic, 'INVALID_LEGACY_SHADER_SNAPSHOT');
});
