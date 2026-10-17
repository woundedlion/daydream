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
    this.previous = initial.slice();
    this.pixels = initial.slice();
    /** @type {Uint16Array | null} */
    this.boundaryPixels = null;
    this.column = 0;
  }

  /**
   * @param {boolean} showBoundary Mark the next opposing columns in magenta.
   * @returns {Uint16Array} Display pixels, with an optional boundary overlay.
   */
  displayPixels(showBoundary) {
    if (!showBoundary) return this.pixels;
    this.boundaryPixels ??= new Uint16Array(this.pixels.length);
    this.boundaryPixels.set(this.pixels);
    const half = this.width / 2;
    const column = this.column % half;
    for (let y = 0; y < this.height; y++) {
      for (let x = column; x < this.width; x += half) {
        const index = (y * this.width + x) * 3;
        this.boundaryPixels[index] = 65535;
        this.boundaryPixels[index + 1] = 0;
        this.boundaryPixels[index + 2] = 65535;
      }
    }
    return this.boundaryPixels;
  }

  /** @param {Uint16Array} source Next half-turn's image. */
  beginFrame(source) {
    this.advance(1);
    this.previous.set(this.source);
    this.source.set(source);
    this.column = 0;
  }

  /** @param {number} fraction Position within the current half-turn, in [0, 1]. */
  seek(fraction) {
    this.pixels.set(this.previous);
    this.column = 0;
    this.advance(Math.max(0, Math.min(1, fraction)));
  }

  /**
   * @param {number} fraction Elapsed fraction of the half-turn, in [0, 1].
   * @returns {boolean} Whether any columns were refreshed.
   */
  advance(fraction) {
    if (fraction < 0) return false;
    const half = this.width / 2;
    const end = Math.min(half, Math.floor(fraction * half) + 1);
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
