/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";

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
 * Latitude uses `y·π/(H−1)`, which matches the engine's `pixel_to_vector` ONLY
 * because the WASM build runs with `H_OFFSET == 0` (virtual row count == H). On
 * a device build with `H_OFFSET == 3` the engine maps rows over `H + H_OFFSET`
 * virtual rows, so this formula would no longer line up — H_OFFSET is not
 * exposed to JS, so this is an unenforced assumption, valid for the simulator.
 * @param {number} x - The pixel x-coordinate [0, Daydream.W - 1].
 * @param {number} y - The pixel y-coordinate [0, Daydream.H - 1].
 * @param {THREE.Spherical} [out] - Target to write into (default: new Spherical).
 * @returns {THREE.Spherical} `out`, set to the spherical coordinates (radius 1).
 */
export const pixelToSpherical = (x, y, out = new THREE.Spherical()) => {
  // Guard the H === 1 single-row canvas: dividing by H - 1 would be a
  // divide-by-zero → NaN latitude. Not reachable from the shipped presets.
  out.set(1, (y * Math.PI) / Math.max(1, Daydream.H - 1), Math.PI / 2 - (x * TWO_PI) / Daydream.W);
  return out;
};
