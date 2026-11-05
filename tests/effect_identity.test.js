import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalEffectId, effectDisplayName } from '../src/effects/effect_identity.js';

test('engine identity metadata resolves canonical IDs and display names to display labels', () => {
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


test('identity resolution accepts metadata without a legacy_ids field', async (t) => {
  t.mock.module(new URL('../generated/engine_contract.mjs', import.meta.url).href, {
    namedExports: {EFFECT_IDENTITIES: [{id: 'study', display_name: 'Study'}]},
  });
  const identity = await import('../src/effects/effect_identity.js?field-absent');
  assert.equal(identity.canonicalEffectId('Study'), 'study');
  assert.equal(identity.effectDisplayName('study'), 'Study');
});
