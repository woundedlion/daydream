/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";

const TWO_PI = 2 * Math.PI;

/**
 * Converts 2D pixel coordinates to spherical coordinates on a unit sphere.
 *
 * Writes into `out` and returns it. When `out` is omitted a fresh Spherical is
 * allocated, so the result is always an independent object. Pass a reusable
 * `out` to avoid allocation in hot loops (e.g. setupDots).
 *
 * The azimuth is `π/2 − θ`, not `θ`: THREE.Spherical measures theta from +Z
 * (`x = sinφ·sinθ`), but the engine's `pixel_to_vector` measures it from +X
 * (`x = sinφ·cosθ`, README §2: column x=0 sits at +X). The `π/2 − θ` complement
 * makes THREE reproduce the engine vector exactly, avoiding an x↔z mirror
 * (det=−1 reflection) that would render chiral content opposite-handed.
 *
 * Latitude uses `y·π/(H + H_OFFSET − 1)`, matching the engine's
 * `pixel_to_vector`, which maps phi over `H + H_OFFSET` virtual rows
 * (core/geometry.h). The WASM/sim build runs with `Daydream.H_OFFSET == 0`
 * (virtual row count == H), so the simulator maps the full sphere; the device's
 * south-pole clipping (H_OFFSET == 3) is a compile-time engine fork the sim
 * does not reproduce (see the device/host divergence ledger).
 * @param {number} x - The pixel x-coordinate [0, dims.W - 1].
 * @param {number} y - The pixel y-coordinate [0, dims.H - 1].
 * @param {{W:number, H:number, H_OFFSET?:number}} dims - Sphere resolution (e.g. the Daydream driver): column count W, row count H, and virtual-row offset H_OFFSET.
 * @param {THREE.Spherical} [out] - Target to write into (default: new Spherical).
 * @returns {THREE.Spherical} `out`, set to the spherical coordinates (radius 1).
 */
export const pixelToSpherical = (x, y, dims, out = new THREE.Spherical()) => {
  const hVirt = dims.H + (dims.H_OFFSET ?? 0);
  out.set(1, (y * Math.PI) / Math.max(1, hVirt - 1), Math.PI / 2 - (x * TWO_PI) / (dims.W || 1));
  return out;
};
