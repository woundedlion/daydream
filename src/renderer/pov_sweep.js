// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * @param {number} age Age in units of the gamma time constant.
 * @returns {number} Survival probability of the nine-stage sustained response.
 */
export function sustainedSurvival(age) {
  if (age <= 0) return 1;
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= 8; k++) {
    term *= age / k;
    sum += term;
  }
  return Math.min(1, Math.exp(-age) * sum);
}

/** Persistent two-arm display, sampled from one frozen image per half-turn. */
export class PovSweep {
  /** Sustained-channel gamma time constant in milliseconds. */
  static RESPONSE_TAU_MS = 4.94;
  /** Largest exploratory multiplier of the response time constant. */
  static MAX_RESPONSE_SCALE = 2;
  /** Retained response duration in time constants. */
  static RESPONSE_TAIL_TAU = 40;

  /**
   * @param {number} width
   * @param {number} height
   * @param {Uint16Array} initial
   * @param {number} [initialFraction=0] Start of recorded emissions in this half-turn.
   * @param {number} [frameMs=62.5] Half-turn duration in milliseconds.
   */
  constructor(width, height, initial, initialFraction = 0, frameMs = 62.5) {
    this.width = width;
    this.height = height;
    this.frameMs = frameMs;
    this.historyFrames = Math.ceil(PovSweep.RESPONSE_TAIL_TAU * PovSweep.RESPONSE_TAU_MS
        * PovSweep.MAX_RESPONSE_SCALE / frameMs) + 1;
    this.source = initial.slice();
    this.pixels = initial.slice();
    /** @type {Uint16Array | null} */
    this.boundaryPixels = null;
    /** @type {Uint16Array | null} */
    this.responsePixels = null;
    this.emissions = [{ pixels: initial.slice(), start: initialFraction }];
    this.responseWeights = new Float64Array(this.historyFrames);
    this.column = 0;
    this.responseFraction = NaN;
    this.responseTau = NaN;
  }

  /**
   * @param {boolean} showBoundary Mark the next opposing columns in magenta.
   * @param {Uint16Array} [pixels=this.pixels] Response pixels.
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
    this.responseFraction = NaN;
    this.replaceFrame(source);
    const recycled = this.emissions.length >= this.historyFrames
      ? this.emissions.shift() : undefined;
    const pixels = recycled?.pixels ?? new Uint16Array(source.length);
    pixels.set(source);
    this.emissions.push({ pixels, start: 0 });
  }

  /** @param {Uint16Array} source Complete replacement effect image. */
  reset(source) {
    this.responseFraction = NaN;
    this.source.set(source);
    this.pixels.set(source);
    for (const frame of this.emissions) {
      frame.pixels.set(source);
      frame.start = 0;
    }
    while (this.emissions.length < this.historyFrames)
      this.emissions.push({ pixels: source.slice(), start: 0 });
  }

  /** @param {Uint16Array} source Paused raw preview; recorded emissions stay unchanged. */
  replaceFrame(source) {
    this.advance(1);
    this.source.set(source);
    this.column = 0;
  }

  /**
   * @param {number} fraction Response time within the current half-turn, in [0, 1].
   * @param {number} [responseScale=1] Sustained-channel timescale multiplier, in [0.5, 2].
   * @returns {Uint16Array} Approximate sustained visual response in linear RGB16.
   */
  visualPixels(fraction, responseScale = 1) {
    const end = Math.max(0, Math.min(1, fraction));
    const tau = PovSweep.RESPONSE_TAU_MS
      * Math.max(0.5, Math.min(PovSweep.MAX_RESPONSE_SCALE, responseScale));
    if (this.responsePixels && this.responseFraction === end && this.responseTau === tau)
      return this.responsePixels;
    const pixels = this.weightedPixels((pulseStart, pulseEnd) => Math.max(0,
      sustainedSurvival((end - pulseEnd) * this.frameMs / tau)
      - sustainedSurvival((end - pulseStart) * this.frameMs / tau)));
    this.responseFraction = end;
    this.responseTau = tau;
    return pixels;
  }

  /**
   * @param {(start: number, end: number) => number} pulseWeight Response integral for dwell endpoints measured in half-turns.
   * @returns {Uint16Array} Duty-compensated response, clipped to the display range.
   */
  weightedPixels(pulseWeight) {
    this.responseFraction = NaN;
    this.responsePixels ??= new Uint16Array(this.pixels.length);
    const sources = this.emissions.map((frame) => frame.pixels);
    const half = this.width / 2;
    const count = this.emissions.length;
    for (let column = 0; column < half; column++) {
      for (let frame = 0; frame < count; frame++) {
        const epoch = frame - count + 1;
        const pulseStart = epoch + column / half;
        const pulseEnd = epoch + (column + 1) / half;
        const recordedStart = epoch + this.emissions[frame].start;
        this.responseWeights[frame] = pulseEnd <= recordedStart ? 0
          : pulseWeight(Math.max(pulseStart, recordedStart), pulseEnd) * half;
      }
      for (let y = 0; y < this.height; y++) {
        for (let x = column; x < this.width; x += half) {
          const index = (y * this.width + x) * 3;
          for (let channel = 0; channel < 3; channel++) {
            let value = 0;
            for (let frame = 0; frame < count; frame++)
              value += sources[frame][index + channel] * this.responseWeights[frame];
            this.responsePixels[index + channel] = Math.min(65535, Math.round(value));
          }
        }
      }
    }
    return this.responsePixels;
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
