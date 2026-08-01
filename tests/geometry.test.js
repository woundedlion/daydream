import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

/**
 * Builds the sphere-resolution stand-in pixelToSpherical takes in place of the
 * Daydream driver, keeping the tests free of the browser graph. A fresh object
 * per call so no test observes another's H_OFFSET.
 * @param {number} [hOffset=0] - Virtual rows past the panel (the device uses 3).
 * @returns {{W:number, H:number, H_OFFSET:number}} The driver stand-in.
 */
const makeDaydream = (hOffset = 0) => ({ W: 288, H: 144, H_OFFSET: hOffset });

const { pixelToSpherical } = await import('../geometry.js');

const W = 288, H = 144;

/**
 * Reference implementation of the engine's pixel_to_vector (core/math/geometry.h,
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
  const daydream = makeDaydream();
  const v = new THREE.Vector3();
  for (const x of [0, 1, 72, 144, 216, 287]) {
    for (const y of [0, 1, 72, 143]) {
      v.setFromSpherical(pixelToSpherical(x, y, daydream));
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
  const phi = pixelToSpherical(0, 50, makeDaydream(3)).phi;
  assert.ok(Math.abs(phi - (50 * Math.PI) / (H + 3 - 1)) < 1e-12,
    `phi should use H + H_OFFSET - 1, got ${phi}`);
});

/**
 * Pins the azimuth origin directly: column x=0 must land on +X with z~0,
 * guarding against an x<->z swap that would put it at +Z.
 */
test('the x=0 column maps to +X, not +Z', () => {
  const v = new THREE.Vector3().setFromSpherical(pixelToSpherical(0, 72, makeDaydream()));
  assert.ok(v.x > 0.99, `x=0 should sit near +X, got x=${v.x}`);
  assert.ok(Math.abs(v.z) < 1e-9, `x=0 should have z~0, got z=${v.z}`);
});

test('degenerate dimensions keep spherical coordinates finite', () => {
  const spherical = pixelToSpherical(2, 1, { W: 0, H: 1 });
  assert.ok(Number.isFinite(spherical.phi));
  assert.ok(Number.isFinite(spherical.theta));
  assert.equal(spherical.phi, Math.PI);
  assert.equal(spherical.theta, Math.PI / 2 - 4 * Math.PI);
});

/**
 * Hardcoded golden vectors that do NOT re-run the engine formula, so the pin is
 * independent of engineVector() above (which shares pixelToSpherical's own
 * math). Row 0 is the +Y north pole and row H-1 the -Y south pole by geometry
 * alone; the (72,36) triple is raw sin/cos of phi=36π/143 with column 72's
 * azimuth landing on the +Z meridian (worldX == 0).
 */
test('pixelToSpherical hits independent golden vectors', () => {
  const goldens = [
    { x: 0, y: 0, v: [0, 1, 0] },                                    // north pole
    { x: 0, y: 143, v: [0, -1, 0] },                                 // south pole
    { x: 72, y: 36, v: [0, 0.7032124967615111, 0.7109797355751019] },
  ];
  const daydream = makeDaydream();
  const v = new THREE.Vector3();
  for (const { x, y, v: g } of goldens) {
    v.setFromSpherical(pixelToSpherical(x, y, daydream));
    assert.ok(
      Math.abs(v.x - g[0]) < 1e-9 && Math.abs(v.y - g[1]) < 1e-9 && Math.abs(v.z - g[2]) < 1e-9,
      `pixel (${x},${y}) -> (${v.x},${v.y},${v.z}); golden (${g})`);
  }
});
