import test from 'node:test';
import assert from 'node:assert/strict';

import { importLegacyShaderSelection } from '../legacy_shader_import.js';

// The engine canonicalizes both spellings (targets/wasm/engine_bindings.h), so
// a link carrying either one has to reach Shader.
test('either retired identity opens Shader and unrelated ones pass through', () => {
  assert.deepEqual(importLegacyShaderSelection('ShaderBall'), {
    effect: 'Shader',
    migrated: true,
    notice: 'ShaderBall is now Shader; opened with defaults.',
  });
  assert.deepEqual(importLegacyShaderSelection('ShaderWorkbench'), {
    effect: 'Shader',
    migrated: true,
    notice: 'ShaderWorkbench is now Shader; opened with defaults.',
  });
  assert.deepEqual(importLegacyShaderSelection('LatticeMelt'),
    { effect: 'LatticeMelt', migrated: false });
  assert.deepEqual(importLegacyShaderSelection(null),
    { effect: null, migrated: false });
});
