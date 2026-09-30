import { test } from 'node:test';
import assert from 'node:assert/strict';
import { favoritesFor } from '../src/effects/effect_roster.js';

test('unknown resolutions use the high-resolution favorites', (t) => {
  const messages = [];
  t.mock.method(console, 'error', (...args) => messages.push(args));
  assert.deepEqual(favoritesFor('no-such-preset'), favoritesFor('Phantasm (288x144)'));
  assert.ok(favoritesFor('Holosphere (96x20)').includes('Dynamo'));
  assert.equal(messages.length, 1);
});
