// @ts-check
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

// geometry.js only needs Daydream.W / Daydream.H / Daydream.H_OFFSET from
// driver.js; stub it so the test doesn't drag in the whole browser-only
// driver/GUI graph.
const Daydream = { W: 288, H: 144, H_OFFSET: 0 };
mock.module('../driver.js', { namedExports: { Daydream } });

const { pixelToSpherical } = await import('../geometry.js');

const W = 288, H = 144;

/**
 * Reference implementation of the engine's pixel_to_vector (core/geometry.h,
 * README §2), with azimuth (theta) measured from +X.
 * @param {number} x - Pixel column index in [0, W).
 * @param {number} y - Pixel row index in [0, H).
 * @returns {Array<number>} The world-space unit vector [x, y, z] the engine renders for that pixel.
 */
function engineVector(x, y) {
  const phi = (y * Math.PI) / (H - 1);
  const theta = (x * 2 * Math.PI) / W;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

/**
 * Verifies that pixelToSpherical reproduces the engine's world vector across a
 * spread of columns/rows, requiring sub-1e-12 agreement with engineVector so the
 * sim places each dot exactly where the engine renders it (azimuth from +X, not
 * its x<->z mirror).
 */
test('pixelToSpherical matches the engine convention (theta from +X)', () => {
  const v = new THREE.Vector3();
  for (const x of [0, 1, 72, 144, 216, 287]) {
    for (const y of [0, 1, 72, 143]) {
      v.setFromSpherical(pixelToSpherical(x, y));
      const [ex, ey, ez] = engineVector(x, y);
      assert.ok(
        Math.abs(v.x - ex) < 1e-12 && Math.abs(v.y - ey) < 1e-12 && Math.abs(v.z - ez) < 1e-12,
        `pixel (${x},${y}) -> (${v.x},${v.y},${v.z}); engine (${ex},${ey},${ez})`);
    }
  }
});

/**
 * Verifies a non-zero H_OFFSET maps phi over `H + H_OFFSET` virtual rows, so the
 * sim can preview the device's row->latitude mapping (device H_OFFSET == 3).
 */
test('H_OFFSET widens the latitude denominator to H + H_OFFSET - 1', () => {
  try {
    Daydream.H_OFFSET = 3;
    const phi = pixelToSpherical(0, 50).phi;
    assert.ok(Math.abs(phi - (50 * Math.PI) / (H + 3 - 1)) < 1e-12,
      `phi should use H + H_OFFSET - 1, got ${phi}`);
  } finally {
    Daydream.H_OFFSET = 0;
  }
});

/**
 * Pins the azimuth origin directly: column x=0 must land on +X with z~0,
 * guarding against an x<->z swap that would put it at +Z.
 */
test('the x=0 column maps to +X, not +Z', () => {
  const v = new THREE.Vector3().setFromSpherical(pixelToSpherical(0, 72));
  assert.ok(v.x > 0.99, `x=0 should sit near +X, got x=${v.x}`);
  assert.ok(Math.abs(v.z) < 1e-9, `x=0 should have z~0, got z=${v.z}`);
});
