import test from 'node:test';
import assert from 'node:assert/strict';

import {
  importLegacyShaderSelection,
  LEGACY_SHADER_PRESETS,
} from '../legacy_shader_import.js';

test('all nineteen legacy presets have stable effect and preset destinations', () => {
  assert.equal(LEGACY_SHADER_PRESETS.length, 19);
  for (let presetIndex = 0; presetIndex < LEGACY_SHADER_PRESETS.length; ++presetIndex) {
    const result = importLegacyShaderSelection('ShaderBall', {
      schemaVersion: 2, presetIndex, runtime: [presetIndex],
    });
    assert.equal(result.effect, LEGACY_SHADER_PRESETS[presetIndex][0]);
    assert.equal(result.presetId, LEGACY_SHADER_PRESETS[presetIndex][1]);
    assert.deepEqual(result.handoff, [presetIndex]);
  }
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
