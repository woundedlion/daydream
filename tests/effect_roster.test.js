import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EFFECT_IDENTITIES } from '../generated/engine_contract.mjs';
import {
  favoritesFor, resolutionEffects, resolutionPresets, resolveActiveEffect, SHADER_DOCUMENT_EFFECTS,
  unlistedEffects,
} from '../src/effects/effect_roster.js';

test('the shader-document roster names exactly the documents that ship', () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../generated/shader/patterns/catalog.json', import.meta.url),
    'utf8'));

  assert.deepEqual([...SHADER_DOCUMENT_EFFECTS].sort(),
    Object.keys(manifest.source_documents).sort(),
    'the workbench offers exactly the source_documents the manifest lists, '
    + 'while this roster is what routes ?effect=<id> to the workbench page and '
    + 'what the URL validator admits: a document in one and not the other '
    + 'ships with a deep link that silently falls back to the default effect');
});

test('unknown resolutions use the high-resolution favorites', (t) => {
  const messages = [];
  t.mock.method(console, 'error', (...args) => messages.push(args));
  assert.deepEqual(favoritesFor('no-such-preset'), favoritesFor('Phantasm (288x144)'));
  assert.ok(favoritesFor('Holosphere (96x20)').includes('Dynamo'));
  assert.equal(messages.length, 1);
});

test('GridWorms is offered at both display resolutions', () => {
  for (const resolution of ['Holosphere (96x20)', 'Phantasm (288x144)']) {
    const favorites = favoritesFor(resolution);
    assert.ok(favorites.includes('GridWorms'), resolution);
    assert.equal(resolveActiveEffect(favorites, 'GridWorms'), 'GridWorms');
  }
});

test('resolution lists order their shared effects alike and repeat none', () => {
  const high = favoritesFor('Phantasm (288x144)');
  const low = favoritesFor('Holosphere (96x20)');
  assert.deepEqual(high.filter((name) => low.includes(name)), low.filter((name) => high.includes(name)));
  for (const favorites of [high, low]) assert.equal(new Set(favorites).size, favorites.length);
});

test('unlistedEffects keeps registry order and omits listed effects and ShaderChain', () => {
  const identities = ['C', 'ShaderChain', 'A', 'B', 'D'].map((display_name) => ({ display_name }));
  assert.deepEqual(unlistedEffects(identities, [['A'], ['A', 'B']]), ['C', 'D']);
  assert.deepEqual(unlistedEffects(identities, [['A', 'B', 'C', 'D']]), []);
});

test('a registered effect absent from every curated list is offered once at every resolution', async (t) => {
  const unlisted = { id: 'unlisted-study', display_name: 'UnlistedStudy' };
  t.mock.module(new URL('../generated/engine_contract.mjs', import.meta.url).href, {
    namedExports: { EFFECT_IDENTITIES: [...EFFECT_IDENTITIES, unlisted] },
  });
  const roster = await import('../src/effects/effect_roster.js?unlisted-effect');
  for (const [label, preset] of Object.entries(roster.resolutionPresets)) {
    assert.equal(preset.favorites.filter((name) => name === unlisted.display_name).length, 1, label);
    assert.equal(roster.favoritesFor(label).includes(unlisted.display_name), true, label);
  }
});

test('every registered simulator effect is offered at some resolution', () => {
  const offered = new Set(Object.values(resolutionPresets).flatMap((preset) => preset.favorites));
  const missing = EFFECT_IDENTITIES.map(({ display_name }) => display_name)
    .filter((name) => name !== 'ShaderChain' && !offered.has(name));
  assert.deepEqual(missing, []);
});

const RESO_EFFECTS = ['ShapeShifter', 'Comets', 'MobiusGrid'];

test('resolveActiveEffect keeps an effect the resolution offers', () => {
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'Comets'), 'Comets');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'ShapeShifter'), 'ShapeShifter');
});

test('resolveActiveEffect falls back to the first effect for an off-list request', () => {
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'NotHere'), 'ShapeShifter');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'GARBAGE_FROM_URL'), 'ShapeShifter');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, undefined), 'ShapeShifter');
});

test('a preset reports its own effect list', () => {
  const presets = { Lo: { favorites: ['A', 'B'] }, Hi: { favorites: ['C'] } };
  assert.deepEqual(resolutionEffects(presets, 'Lo'), ['A', 'B']);
  assert.deepEqual(resolutionEffects(presets, 'Hi'), ['C']);
});

test('an unknown preset, or one carrying no list, reports none', () => {
  assert.equal(resolutionEffects({ Lo: { favorites: ['A'] } }, 'Mid'), null);
  assert.equal(resolutionEffects({ Lo: { dotSize: 2 } }, 'Lo'), null);
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(resolutionEffects({ Lo: { favorites: ['A'] } }, name), null, name);
  }
});
