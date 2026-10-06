/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";

const TWO_PI = 2 * Math.PI;

/**
 * Converts 2D pixel coordinates to spherical coordinates on a unit sphere.
 *
 * Writes into `out` and returns it; a fresh Spherical is allocated when omitted.
 *
 * The azimuth is `π/2 − θ`: THREE.Spherical measures theta from +Z, the engine's
 * `pixel_to_vector` from +X; the complement avoids an x↔z mirror.
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
