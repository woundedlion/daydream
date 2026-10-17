// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Persistent two-arm display, sampled from one frozen image per half-turn. */
export class PovSweep {
  /** @param {number} width @param {number} height @param {Uint16Array} initial */
  constructor(width, height, initial) {
    this.width = width;
    this.height = height;
    this.source = initial.slice();
    this.pixels = initial.slice();
    this.column = 0;
  }

  /** @param {Uint16Array} source Next half-turn's image. */
  beginFrame(source) {
    this.advance(1);
    this.source.set(source);
    this.column = 0;
  }

  /**
   * @param {number} fraction Elapsed fraction of the half-turn, in [0, 1].
   * @returns {boolean} Whether any columns were refreshed.
   */
  advance(fraction) {
    const half = this.width / 2;
    const end = Math.min(half, Math.max(0, Math.floor(fraction * half)));
    if (end <= this.column) return false;
    for (let y = 0; y < this.height; y++) {
      for (let arm = 0; arm < this.width; arm += half) {
        const start = (y * this.width + arm + this.column) * 3;
        const stop = (y * this.width + arm + end) * 3;
        this.pixels.set(this.source.subarray(start, stop), start);
      }
    }
    this.column = end;
    return true;
  }
}
