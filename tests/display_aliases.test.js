// The display aliases: the Three.js instanceColor attribute, its array, and the
// driver's own pixel handle must all reference one WASM view, or the sphere
// shows the previous buffer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeColorAttribute, fakeAliasDriver } from './helpers/fake_three.js';
import {
  createDriverAliasGuard, displayAliasesDiverged, repointDisplayAliases,
} from '../src/engine/display_aliases.js';

test('re-pointing aliases the view everywhere and flags the upload', () => {
  const driver = fakeAliasDriver();
  const view = new Uint16Array(4);

  repointDisplayAliases(driver, view);

  assert.equal(driver.pixels, view);
  assert.equal(driver.dotMesh.instanceColor.array, view);
  assert.equal(driver.dotMesh.instanceColor.version, 1,
    'a re-pointed attribute uploads, or the sphere shows the previous buffer');
});

test('aliases agree only when both reference the same view', () => {
  const driver = fakeAliasDriver();
  const view = new Uint16Array(4);
  repointDisplayAliases(driver, view);
  assert.equal(displayAliasesDiverged(driver, view), false);

  driver.pixels = new Uint16Array(4);
  assert.equal(displayAliasesDiverged(driver, view), true);

  repointDisplayAliases(driver, view);
  driver.dotMesh.instanceColor.array = new Uint16Array(4);
  assert.equal(displayAliasesDiverged(driver, view), true);
});


test('display aliases reject a mesh-size mismatch without changing either alias', () => {
  const original = new Uint16Array(6);
  const driver = { pixels: original, dotMesh: { count: 2,
    instanceColor: fakeColorAttribute(original) } };
  assert.throws(() => repointDisplayAliases(driver, new Uint16Array(9)), RangeError);
  assert.equal(driver.pixels, original);
  assert.equal(driver.dotMesh.instanceColor.array, original);
  const next = new Uint16Array(6);
  repointDisplayAliases(driver, next);
  assert.equal(driver.pixels, next);
});

test('a detached alias without a mesh count accepts a replacement view', () => {
  const original = new Uint16Array(6);
  const driver = { pixels: original, dotMesh: { instanceColor: { array: original } } };
  assert.throws(() => repointDisplayAliases(driver, new Uint16Array(9)), RangeError);
  structuredClone(original.buffer, { transfer: [original.buffer] });
  const next = new Uint16Array(9);
  repointDisplayAliases(driver, next);
  assert.equal(driver.pixels, next);
  assert.equal(driver.dotMesh.instanceColor.array, next);
});

test('the alias guard heals every divergence, logs once, and re-arms on reset', () => {
  const driver = fakeAliasDriver();
  const view = new Uint16Array(4);
  const errors = [];
  const guard = createDriverAliasGuard(driver, 'site', (message) => errors.push(message));
  repointDisplayAliases(driver, view);

  assert.equal(guard.heal(view), false);
  assert.deepEqual(errors, []);

  driver.pixels = new Uint16Array(4);
  assert.equal(guard.heal(view), true);
  assert.equal(driver.pixels, view);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^site: display-buffer alias diverged /);

  driver.dotMesh.instanceColor.array = new Uint16Array(4);
  assert.equal(guard.heal(view), true);
  assert.equal(driver.dotMesh.instanceColor.array, view);
  assert.equal(errors.length, 1, 'a second divergence heals silently');

  guard.reset();
  driver.pixels = new Uint16Array(4);
  guard.heal(view);
  assert.equal(errors.length, 2, 'reset re-arms the report');
});
