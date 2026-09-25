/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Simulation frames per second. */
export const FPS = 16;

/** Per-frame time (ms) above which a frame or segment is flagged as slow. */
export const SLOW_FRAME_MS = Math.round(1000 / FPS);
