import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEffectId, effectDisplayName } from '../src/effects/effect_identity.js';

test('engine identity metadata resolves canonical and legacy names to display labels', () => {
  for (const [id, name] of [['comets', 'Comets'], ['alien-brain', 'AlienBrain'],
    ['gs-reaction-diffusion', 'GSReactionDiffusion']]) {
    assert.equal(canonicalEffectId(name), id);
    assert.equal(canonicalEffectId(id), id);
    assert.equal(effectDisplayName(name), name);
    assert.equal(effectDisplayName(id), name);
  }
});

test('unknown names remain available to callers handling an independent catalog', () => {
  assert.equal(canonicalEffectId('UnregisteredStudy'), 'UnregisteredStudy');
  assert.equal(effectDisplayName('UnregisteredStudy'), 'UnregisteredStudy');
});
