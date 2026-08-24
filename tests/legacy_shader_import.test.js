import test from 'node:test';
import assert from 'node:assert/strict';

import { importLegacyShaderSelection } from '../legacy_shader_import.js';

test('the retired identity opens Shader and unrelated identities pass through', () => {
  assert.deepEqual(importLegacyShaderSelection('ShaderBall'), {
    effect: 'Shader',
    migrated: true,
    notice: 'ShaderBall is now Shader; opened with defaults.',
  });
  assert.deepEqual(importLegacyShaderSelection('LatticeMelt'),
    { effect: 'LatticeMelt', migrated: false });
});
