import test from 'node:test';
import assert from 'node:assert/strict';
import { importLegacyShaderSelection } from '../src/effects/legacy_shader_import.js';

test('legacy identities select the chain importer and preserve the original identity in the notice', () => {
  for (const effect of ['Shader', 'ShaderBall', 'ShaderWorkbench']) {
    const result = importLegacyShaderSelection(effect);
    assert.equal(result.effect, 'ShaderChain');
    assert.equal(result.migrated, true);
    assert.match(result.notice, new RegExp(effect));
    assert.match(result.notice, /original configuration is preserved/);
  }
  for (const effect of ['LatticeMelt', 'ShaderChain', null])
    assert.deepEqual(importLegacyShaderSelection(effect), {effect, migrated: false});
});
