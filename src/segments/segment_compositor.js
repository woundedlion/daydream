// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */
import { compositeSegment, computeSegmentRange, stampBoundaries } from './segment_layout.js';
import { FAULT_RENDER } from './worker_protocol.js';
import { errorDetail } from '../shared/banner.js';

/**
 * A composited frame result for one segment, kept across the one-frame pipeline.
 * `pixels` is the segment's RGB16 rectangle ((x1-x0)*(y1-y0)*3), null if absent.
 * @typedef {{
 *   pixels: Uint16Array | null,
 *   x0: number, x1: number, y0: number, y1: number,
 * }} FrameResult
 */

/** Display-buffer composition; worker lifetime and publication stay with the controller. */
export class SegmentCompositor {
  /** Throttle for the composite alias-divergence warning. */
  #aliasDivergenceLogged = false;

  // Boundary-overlay seam coordinates, cached per band table.
  /** @type {number[]} */
  #boundaryYs = [];

  /** @type {number[]} */
  #boundaryXs = [];

  /** @type {import('./segment_layout.js').SegRange[] | null} */
  #boundaryBands = null;

  // Per-segment band rectangles, cached by segment count and dimensions.
  /** @type {import('./segment_layout.js').SegRange[] | null} */
  #bands = null;

  #bandCount = 0;

  #bandW = 0;

  #bandH = 0;

  /**
   * @param {Object} deps
   * @param {{W:number, H:number}} deps.driver - Current display dimensions.
   * @param {() => unknown} deps.refreshPixelView
   * @param {() => Uint16Array|null} deps.getMemoryView
   * @param {(view:Uint16Array) => void} deps.repointDisplayAliases
   * @param {(view:Uint16Array) => boolean} deps.displayAliasesDiverged
   * @param {(segment:number, message:string) => void} deps.onFault
   */
  constructor({ driver, refreshPixelView, getMemoryView, repointDisplayAliases,
    displayAliasesDiverged, onFault }) {
    this.driver = driver;
    this.refreshPixelView = refreshPixelView;
    this.getMemoryView = getMemoryView;
    this.repointDisplayAliases = repointDisplayAliases;
    this.displayAliasesDiverged = displayAliasesDiverged;
    this.onFault = onFault;
  }

  reset() {
    this.#aliasDivergenceLogged = false;
  }

  /**
   * Composite segment results into the display buffer (segment-rectangle model).
   * @returns {number} How many segment rectangles were blitted. 0 when every
   *   result was null/empty or a check latched a fault. -1 when there is no
   *   display buffer (no engine view): nothing was read or written and the caller
   *   must keep the generation pending. Composites over the buffer's previous
   *   contents except where a refreshed view is cleared.
   * @param {number} count
   * @param {boolean} showBoundaries
   * @param {Array<FrameResult | null>} results - One whole generation, indexed
   *   by segment. Only the published generation is coherent: a staging buffer
   *   mid-fill composites a half-updated mix.
   */
  composite(results, count, showBoundaries) {
    const refreshed = this.refreshPixelView() === true;
    const dst = this.getMemoryView();
    // No engine view: not a fault.
    if (!dst) return -1;

    const w = this.driver.W;
    const h = this.driver.H;

    // Checked before any write: a wrong length would otherwise throw from the blit.
    if (dst.length !== w * h * 3) {
      this.onFault(FAULT_RENDER,
        `SegmentController.composite: display buffer length ${dst.length} != ` +
        `expected ${w * h * 3} for the ${w}x${h} grid — the driver geometry ran ` +
        `ahead of the engine's active resolution`);
      return 0;
    }

    // A refreshed view missed Daydream.stepSimulation()'s per-tick clear.
    if (refreshed) dst.fill(0);

    // Self-heal an alias divergence: re-point both display aliases at dst.
    if (this.displayAliasesDiverged(dst)) {
      if (!this.#aliasDivergenceLogged) {
        console.error(
          "SegmentController.composite: display-buffer alias diverged " +
          "from getMemoryView() — re-pointing the display aliases at the " +
          "composite target");
        this.#aliasDivergenceLogged = true;
      }
      this.repointDisplayAliases(dst);
    }

    // The configured segment count, not results.length.
    const n = count;

    const bands = this.segmentBands(n, w, h);
    if (!bands) return 0;

    // Validate every result before blitting any, so a fault leaves no partial frame.
    for (let s = 0; s < n; s++) {
      const r = results[s];
      if (!r || !r.pixels) continue;
      if (r.x0 < 0 || r.y0 < 0 || r.x1 > w || r.y1 > h) {
        this.onFault(s,
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is out of bounds for the ` +
          `${w}x${h} display buffer — the generation fence let a stale-resolution ` +
          `result through (layout/fence invariant violated)`);
        return 0;
      }
      if (r.x1 <= r.x0 || r.y1 <= r.y0) {
        this.onFault(s,
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is empty/inverted — a zero or ` +
          `negative expectedLen would mask layout corruption (segment-rect ` +
          `invariant violated)`);
        return 0;
      }
      const expectedLen = (r.x1 - r.x0) * (r.y1 - r.y0) * 3;
      if (!(r.pixels instanceof Uint16Array) || r.pixels.length !== expectedLen) {
        this.onFault(s,
          `SegmentController.composite: segment ${s} pixel buffer length ` +
          `${r.pixels.length} != expected ${expectedLen} for rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) — a rect/buffer mismatch would ` +
          `blit a truncated row (segment-result invariant violated)`);
        return 0;
      }
      // A worker that missed a setResolution answers under the current
      // generation with a self-consistent rect for the wrong band.
      const band = bands[s];
      if (r.x0 !== band.x0 || r.x1 !== band.x1
          || r.y0 !== band.y0 || r.y1 !== band.y1) {
        this.onFault(s,
          `SegmentController.composite: segment ${s} rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) is not its band ` +
          `[${band.x0},${band.y0})-[${band.x1},${band.y1}) of the ${n}-segment ` +
          `${w}x${h} layout — a stale-geometry frame would composite into the ` +
          `wrong rows (segment-layout invariant violated)`);
        return 0;
      }
    }

    let blitted = 0;
    for (let s = 0; s < n; s++) {
      const r = results[s];
      if (!r || !r.pixels) continue;
      compositeSegment(dst, r.pixels, w, r);
      blitted++;
    }

    // Markers are baked into the recorded buffer; skipped on a fully fenced frame.
    if (showBoundaries && blitted > 0) {
      if (this.#boundaryBands !== bands) this.rebuildBoundaries(bands);
      stampBoundaries(dst, w, h, this.#boundaryXs, this.#boundaryYs);
    }

    return blitted;
  }

  /**
   * The current layout's band rectangles, cached by segment count and dimensions.
   * @param {number} n - Segment count.
   * @param {number} w - Display buffer width.
   * @param {number} h - Display buffer height.
   * @returns {import('./segment_layout.js').SegRange[] | null} The bands, or
   *   null when the layout admits none, having latched a fault.
   */
  segmentBands(n, w, h) {
    if (this.#bands && this.#bandCount === n
        && this.#bandW === w && this.#bandH === h) {
      return this.#bands;
    }
    const bands = new Array(n);
    for (let s = 0; s < n; s++) {
      try {
        bands[s] = computeSegmentRange(s, n, w, h);
      } catch (error) {
        this.onFault(s,
          `SegmentController.composite: no segment-${s} band exists for a ` +
          `${n}-segment ${w}x${h} display buffer — ${errorDetail(error)}`);
        return null;
      }
    }
    this.#bands = bands;
    this.#bandCount = n;
    this.#bandW = w;
    this.#bandH = h;
    return bands;
  }

  /**
   * Recompute the cached boundary-overlay seam coordinates from the band table,
   * keyed by that table.
   * @param {import('./segment_layout.js').SegRange[]} bands - The current layout.
   * @returns {void}
   */
  rebuildBoundaries(bands) {
    const yBounds = new Set();
    const xBounds = new Set();
    for (const band of bands) {
      // Y does not wrap; X wraps, so x == 0 is a seam once the layout is split.
      if (band.y0 > 0) yBounds.add(band.y0);
      if (band.x0 > 0) xBounds.add(band.x0);
    }
    if (xBounds.size > 0) xBounds.add(0);
    this.#boundaryYs = [...yBounds];
    this.#boundaryXs = [...xBounds];
    this.#boundaryBands = bands;
  }

}
