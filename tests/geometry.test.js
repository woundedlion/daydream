// @ts-check
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

// geometry.js only needs Daydream.W / Daydream.H from driver.js; stub it so the
// test doesn't drag in the whole browser-only driver/GUI graph.
mock.module('../driver.js', { namedExports: { Daydream: { W: 288, H: 144 } } });

const { pixelToSpherical } = await import('../geometry.js');

const W = 288, H = 144;

// The engine's pixel_to_vector (core/geometry.h, README §2): theta from +X.
function engineVector(x, y) {
  const phi = (y * Math.PI) / (H - 1);
  const theta = (x * 2 * Math.PI) / W;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

// Regression for the mirrored-azimuth bug: the sim must place each dot at the
// same world vector the engine renders for that pixel, not its x<->z mirror.
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

// The headline symptom: column x=0 belongs at +X, but the old THREE-native
// mapping put it at +Z (the mirror). Pin the axis directly.
test('the x=0 column maps to +X, not +Z', () => {
  const v = new THREE.Vector3().setFromSpherical(pixelToSpherical(0, 72));
  assert.ok(v.x > 0.99, `x=0 should sit near +X, got x=${v.x}`);
  assert.ok(Math.abs(v.z) < 1e-9, `x=0 should have z~0, got z=${v.z}`);
});
