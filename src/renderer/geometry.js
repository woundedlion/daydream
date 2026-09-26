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
 * Latitude endpoints are LED-center angles exported by the engine.
 * @param {number} x - The pixel x-coordinate [0, dims.W - 1].
 * @param {number} y - The pixel y-coordinate [0, dims.H - 1].
 * @param {{W:number, H:number, DISPLAY_NORTH_PHI:number, DISPLAY_SOUTH_PHI:number}} dims - Sphere resolution (e.g. the Daydream driver): column count W, row count H, and LED-center polar angles.
 * @param {THREE.Spherical} [out] - Target to write into (default: new Spherical).
 * @returns {THREE.Spherical} `out`, set to the spherical coordinates (radius 1).
 */
export const pixelToSpherical = (x, y, dims, out = new THREE.Spherical()) => {
  const phi = dims.DISPLAY_NORTH_PHI
    + y * (dims.DISPLAY_SOUTH_PHI - dims.DISPLAY_NORTH_PHI) / Math.max(1, dims.H - 1);
  out.set(1, phi, Math.PI / 2 - (x * TWO_PI) / (dims.W || 1));
  return out;
};

/**
 * Read the compiled engine's display geometry.
 * @param {{DISPLAY_PROFILE:number, DISPLAY_NORTH_PHI:number, DISPLAY_SOUTH_PHI:number}} module - Engine module.
 * @returns {{DISPLAY_PROFILE:number, DISPLAY_NORTH_PHI:number, DISPLAY_SOUTH_PHI:number}} Display geometry.
 */
export function displayGeometryFromModule(module) {
  const { DISPLAY_PROFILE, DISPLAY_NORTH_PHI, DISPLAY_SOUTH_PHI } = module;
  if (![0, 1].includes(DISPLAY_PROFILE)
      || !Number.isFinite(DISPLAY_NORTH_PHI) || !Number.isFinite(DISPLAY_SOUTH_PHI)
      || DISPLAY_NORTH_PHI < 0 || DISPLAY_SOUTH_PHI > Math.PI + 1e-6
      || DISPLAY_NORTH_PHI >= DISPLAY_SOUTH_PHI) {
    throw new Error('Engine display geometry is missing or invalid.');
  }
  return { DISPLAY_PROFILE, DISPLAY_NORTH_PHI, DISPLAY_SOUTH_PHI };
}
