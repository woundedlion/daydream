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
 * allocated, so the result is always an independent object — callers can safely
 * retain it or hold several at once. Pass a reusable `out` to avoid allocation
 * in hot loops (e.g. setupDots).
 * @param {number} x - The pixel x-coordinate [0, Daydream.W - 1].
 * @param {number} y - The pixel y-coordinate [0, Daydream.H - 1].
 * @param {THREE.Spherical} [out] - Target to write into (default: new Spherical).
 * @returns {THREE.Spherical} `out`, set to the spherical coordinates (radius 1).
 */
export const pixelToSpherical = (x, y, out = new THREE.Spherical()) => {
  out.set(1, (y * Math.PI) / (Daydream.H - 1), (x * TWO_PI) / Daydream.W);
  return out;
};
