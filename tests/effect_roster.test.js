import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favoritesFor, resolutionEffects, resolveActiveEffect } from '../src/effects/effect_roster.js';

test('unknown resolutions use the high-resolution favorites', (t) => {
  const messages = [];
  t.mock.method(console, 'error', (...args) => messages.push(args));
  assert.deepEqual(favoritesFor('no-such-preset'), favoritesFor('Phantasm (288x144)'));
  assert.ok(favoritesFor('Holosphere (96x20)').includes('Dynamo'));
  assert.equal(messages.length, 1);
});

const RESO_EFFECTS = ['Voronoi', 'Comets', 'MobiusGrid'];

test('resolveActiveEffect keeps an effect the resolution offers', () => {
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'Comets'), 'Comets');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'Voronoi'), 'Voronoi');
});

test('resolveActiveEffect falls back to the first effect for an off-list request', () => {
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'NotHere'), 'Voronoi');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'GARBAGE_FROM_URL'), 'Voronoi');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, undefined), 'Voronoi');
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
