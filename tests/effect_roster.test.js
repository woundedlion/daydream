import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favoritesFor, resolveActiveEffect } from '../src/effects/effect_roster.js';

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
