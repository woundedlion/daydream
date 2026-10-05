import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

const makeDaydream = (north = 0, south = Math.PI) => ({
  W: 288, H: 144, DISPLAY_NORTH_PHI: north, DISPLAY_SOUTH_PHI: south,
});

const { pixelToSpherical } = await import('../src/renderer/geometry.js');

const W = 288, H = 144;

/**
 * Double-precision analytic reference for the engine's coordinate convention
 * (core/math/pixel_mapping.h, README §2), with azimuth measured from +X.
 * @param {number} x - Pixel column index in [0, W).
 * @param {number} y - Pixel row index in [0, H).
 * @returns {Array<number>} The analytic world-space unit vector [x, y, z].
 */
function engineVector(x, y) {
  const phi = (y * Math.PI) / (H - 1);
  const theta = (x * 2 * Math.PI) / W;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

/**
 * Verifies sub-1e-12 agreement with the double-precision analytic convention
 * across a spread of columns/rows, detecting an x<->z mirror. The engine uses
 * float arithmetic and trigonometric lookup tables; this is not a precision
 * comparison against its rendered vectors.
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

test('physical endpoints preserve distinct longitudes on both edge rings', () => {
  const dims = makeDaydream(0.04, Math.PI - 0.07);
  for (const y of [0, H - 1]) {
    const a = new THREE.Vector3().setFromSpherical(pixelToSpherical(0, y, dims));
    const b = new THREE.Vector3().setFromSpherical(pixelToSpherical(W / 2, y, dims));
    assert.ok(a.distanceTo(b) > 0.07);
  }
  assert.equal(pixelToSpherical(0, 0, dims).phi, 0.04);
  assert.ok(Math.abs(pixelToSpherical(0, H - 1, dims).phi - (Math.PI - 0.07)) < 1e-12);
});

// A zero column count and a single row are what a driver reports before it has
// been sized. The guarded arithmetic itself is unpinned: a future dimension
// guard is free to answer any latitude, so long as it answers a point.
test('degenerate dimensions keep spherical coordinates finite', () => {
  const spherical = pixelToSpherical(2, 1, { ...makeDaydream(), W: 0, H: 1 });
  assert.ok(Number.isFinite(spherical.phi), `phi is ${spherical.phi}`);
  assert.ok(Number.isFinite(spherical.theta), `theta is ${spherical.theta}`);
  assert.equal(spherical.radius, 1, 'the point stays on the unit sphere');
  const v = new THREE.Vector3().setFromSpherical(spherical);
  assert.ok(Math.abs(v.length() - 1) < 1e-12, `the vector is unit, got ${v.length()}`);
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

test('physical profile leaves two percent of the arc empty at each pole', () => {
  const dims = makeDaydream(0.02 * Math.PI, 0.98 * Math.PI);
  assert.ok(Math.abs(pixelToSpherical(0, 0, dims).phi / Math.PI - 0.02) < 1e-12);
  assert.ok(Math.abs(pixelToSpherical(0, H - 1, dims).phi / Math.PI - 0.98) < 1e-12);
  for (let y = 0; y < H; y++) {
    assert.ok(Math.abs(pixelToSpherical(0, y, dims).phi
      + pixelToSpherical(0, H - 1 - y, dims).phi - Math.PI) < 1e-12);
  }
});
