/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Dependency-free kilobyte formatter shared by the simulator stat bars, the
// sidebar's effect sizes and the tool pages' arena readouts, so the THREE-free
// modules can import it without pulling Three.js in through shared.js.

/**
 * Format a byte count as kilobytes, rounded to a fixed number of fractional
 * digits. The unit suffix is left to the caller, whose surrounding text varies.
 * @param {number} bytes - The byte count.
 * @param {number} [digits=1] - Fractional digits to round to.
 * @returns {string} The kilobyte figure (e.g. "12.3").
 */
export function formatKB(bytes, digits = 1) {
  return (bytes / 1024).toFixed(digits);
}
