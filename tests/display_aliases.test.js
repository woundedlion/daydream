//
// The display aliases: the Three.js instanceColor attribute, its array, and the
// driver's own pixel handle must all reference one WASM view, or the sphere
// shows the previous buffer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeColorAttribute } from './fake_three.js';
import { displayAliasesDiverged, repointDisplayAliases } from '../display_aliases.js';

/**
 * Driver double carrying the two display aliases.
 * @returns {Object} The driver double.
 */
function fakeDriver() {
  return { pixels: null, dotMesh: { instanceColor: fakeColorAttribute(null) } };
}

// Display aliases: the Three.js instanceColor attribute, its array, and the
// driver's own pixel handle must all reference one WASM view.

test('re-pointing aliases the view everywhere and flags the upload', () => {
  const driver = fakeDriver();
  const view = new Uint16Array(4);

  repointDisplayAliases(driver, view);

  assert.equal(driver.pixels, view);
  assert.equal(driver.dotMesh.instanceColor.array, view);
  assert.equal(driver.dotMesh.instanceColor.version, 1,
    'a re-pointed attribute uploads, or the sphere shows the previous buffer');
});

test('aliases agree only when both reference the same view', () => {
  const driver = fakeDriver();
  const view = new Uint16Array(4);
  repointDisplayAliases(driver, view);
  assert.equal(displayAliasesDiverged(driver, view), false);

  driver.pixels = new Uint16Array(4);
  assert.equal(displayAliasesDiverged(driver, view), true);

  repointDisplayAliases(driver, view);
  driver.dotMesh.instanceColor.array = new Uint16Array(4);
  assert.equal(displayAliasesDiverged(driver, view), true);
});
