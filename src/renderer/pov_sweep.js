// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Persistent two-arm display, sampled from one frozen image per half-turn. */
export class PovSweep {
  /** Maximum shutter duration, in half-turns. */
  static MAX_EXPOSURE_FRAMES = 4;

  /**
   * @param {number} width
   * @param {number} height
   * @param {Uint16Array} initial
   * @param {number} [initialFraction=0] Start of recorded emissions in this half-turn.
   */
  constructor(width, height, initial, initialFraction = 0) {
    this.width = width;
    this.height = height;
    this.source = initial.slice();
    this.previous = initial.slice();
    this.pixels = initial.slice();
    /** @type {Uint16Array | null} */
    this.boundaryPixels = null;
    /** @type {Uint16Array | null} */
    this.exposurePixels = null;
    this.emissions = [{ pixels: initial.slice(), start: initialFraction }];
    this.exposureWeights = new Float64Array(PovSweep.MAX_EXPOSURE_FRAMES + 1);
    this.column = 0;
  }

  /**
   * @param {boolean} showBoundary Mark the next opposing columns in magenta.
   * @param {Uint16Array} [pixels=this.pixels] Raw sweep or camera presentation.
   * @returns {Uint16Array} Display pixels, with an optional boundary overlay.
   */
  displayPixels(showBoundary, pixels = this.pixels) {
    if (!showBoundary) return pixels;
    this.boundaryPixels ??= new Uint16Array(this.pixels.length);
    this.boundaryPixels.set(pixels);
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
    this.replaceFrame(source);
    const recycled = this.emissions.length > PovSweep.MAX_EXPOSURE_FRAMES
      ? this.emissions.shift() : undefined;
    const pixels = recycled?.pixels ?? new Uint16Array(source.length);
    pixels.set(source);
    this.emissions.push({ pixels, start: 0 });
  }

  /** @param {Uint16Array} source Paused raw preview; recorded emissions stay unchanged. */
  replaceFrame(source) {
    this.advance(1);
    this.previous.set(this.source);
    this.source.set(source);
    this.column = 0;
  }

  /**
   * @param {number} fraction Camera time within the current half-turn, in [0, 1].
   * @param {number} exposureFrames Rectangular shutter duration in half-turns, in (0, 4].
   * @returns {Uint16Array} Normalized linear RGB16 exposure, clipped to the display range.
   */
  cameraPixels(fraction, exposureFrames) {
    this.exposurePixels ??= new Uint16Array(this.pixels.length);
    const duration = Math.max(Number.EPSILON,
      Math.min(PovSweep.MAX_EXPOSURE_FRAMES, exposureFrames));
    const end = Math.max(0, Math.min(1, fraction));
    const start = end - duration;
    const half = this.width / 2;
    const count = this.emissions.length;
    for (let column = 0; column < half; column++) {
      for (let frame = 0; frame < count; frame++) {
        const epoch = frame - count + 1;
        const pulseStart = epoch + column / half;
        const pulseEnd = epoch + (column + 1) / half;
        const recordedStart = epoch + this.emissions[frame].start;
        this.exposureWeights[frame] = Math.max(0,
          Math.min(end, pulseEnd) - Math.max(start, pulseStart, recordedStart)) * half / duration;
      }
      for (let y = 0; y < this.height; y++) {
        for (let x = column; x < this.width; x += half) {
          const index = (y * this.width + x) * 3;
          for (let channel = 0; channel < 3; channel++) {
            let value = 0;
            for (let frame = 0; frame < count; frame++)
              value += this.emissions[frame].pixels[index + channel] * this.exposureWeights[frame];
            this.exposurePixels[index + channel] = Math.min(65535, Math.round(value));
          }
        }
      }
    }
    return this.exposurePixels;
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
