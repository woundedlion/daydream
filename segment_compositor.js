// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */
import { compositeSegment, computeSegmentRange, stampBoundaries } from './segment_layout.js';
import { FAULT_RENDER } from './segment_stats_view.js';
import { errorDetail } from './tools/banner.js';

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

  // Cached boundary-overlay seam coordinates, rebuilt whenever the band table
  // they were derived from is replaced.
  /** @type {number[]} */
  #boundaryYs = [];

  /** @type {number[]} */
  #boundaryXs = [];

  /** @type {import('./segment_layout.js').SegRange[] | null} */
  #boundaryBands = null;

  // Cached per-segment band rectangles composite()'s pre-pass validates
  // against, rebuilt only when the layout the cache key names moves.
  /** @type {import('./segment_layout.js').SegRange[] | null} */
  #bands = null;

  #bandGen = -1;

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
   * @returns {number} How many segment rectangles were actually blitted this
   *   call. 0 means either every result was null/empty (a fully-fenced frame),
   *   so the display buffer still holds only driver.render()'s fill(0), or a
   *   check latched a fault: the destination view's length against the driver
   *   grid, or the per-segment pre-pass (out-of-bounds/empty/inverted rect, a
   *   pixel-length mismatch, or a rect that is not that segment's band of the
   *   current layout). -1 means there was no display buffer to blit into (the
   *   engine view is missing before the WASM load and after dispose), so nothing
   *   was read or written and the caller must keep the generation pending. The
   *   caller uses this to avoid marking a black buffer as a real composited frame.
   * @param {number} count
   * @param {number} generation
   * @param {boolean} showBoundaries
   * @param {Array<FrameResult | null>} results - One whole generation, indexed
   *   by segment. Only the published generation is ever coherent: a staging
   *   buffer mid-fill composites a half-updated mix.
   */
  composite(results, count, generation, showBoundaries) {
    const refreshed = this.refreshPixelView() === true;
    const dst = this.getMemoryView();
    // Not a fault: the view is absent only while there is no engine to fetch it
    // from, which the single-engine path treats the same way.
    if (!dst) return -1;

    const w = this.driver.W;
    const h = this.driver.H;

    // Checked before anything writes to dst: the segment pre-pass below measures
    // every rect against w/h, so a display buffer that is not w*h*3 long would
    // throw a raw RangeError out of the blit instead of latching a fault.
    if (dst.length !== w * h * 3) {
      this.onFault(FAULT_RENDER,
        `SegmentController.composite: display buffer length ${dst.length} != ` +
        `expected ${w * h * 3} for the ${w}x${h} grid — the driver geometry ran ` +
        `ahead of the engine's active resolution`);
      return 0;
    }

    // No clear: driver.render() already zero-filled this buffer; we blit over it.
    // That elision holds only while dst is the buffer render() cleared, and a
    // refresh that re-fetched hands back one it never was. The refresh re-points
    // both aliases with it, so the divergence check below sees nothing wrong —
    // this report is the only signal.
    if (refreshed) dst.fill(0);

    // On a divergence, self-heal rather than fault the render loop (mirrors the
    // single-engine path): re-point both display aliases at the composite target.
    // driver.render() re-clears driver.pixels next frame, restoring the elision.
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

    // Iterate the configured segment count (the same source updateStats reads),
    // not results.length, so the two can't drift after a teardown reset.
    const n = count;

    const bands = this.segmentBands(n, w, h, generation);
    if (!bands) return 0;

    // Pre-pass: validate every result before blitting any, so a bad segment faults
    // cleanly (overlay + halt) like a worker fault rather than leaving a partial frame.
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
      if (r.pixels.length !== expectedLen) {
        this.onFault(s,
          `SegmentController.composite: segment ${s} pixel buffer length ` +
          `${r.pixels.length} != expected ${expectedLen} for rect ` +
          `[${r.x0},${r.y0})-[${r.x1},${r.y1}) — a rect/buffer mismatch would ` +
          `blit a truncated row (segment-result invariant violated)`);
        return 0;
      }
      // A rect that is self-consistent but not this segment's band blits a
      // correctly-sized frame into another segment's rows; a worker that missed a
      // setResolution answers under the current generation, so neither the fence
      // nor the checks above see anything wrong.
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

    // Boundary markers write into the recorded buffer, so they are baked into video.
    // Skip on a fully generation-fenced frame (blitted === 0): the buffer is black
    // and stamping seams would show cyan lines on an otherwise-blank sphere.
    if (showBoundaries && blitted > 0) {
      if (this.#boundaryBands !== bands) this.rebuildBoundaries(bands);
      stampBoundaries(dst, w, h, this.#boundaryXs, this.#boundaryYs);
    }

    return blitted;
  }

  /**
   * The `n` band rectangles of the current layout, cached across frames: segment
   * geometry is fixed within a generation, and renderGen bumps on every change
   * that can move it (resolution, teardown, and the create() a count change runs
   * through). The dimensions are in the key too, so a driver resize that reaches
   * composite() before the fence cannot be served a stale table.
   * @param {number} generation - Published generation.
   * @param {number} n - Segment count.
   * @param {number} w - Display buffer width.
   * @param {number} h - Display buffer height.
   * @returns {import('./segment_layout.js').SegRange[] | null} The bands, or
   *   null when the layout admits none, having latched a fault.
   */
  segmentBands(n, w, h, generation) {
    if (this.#bands && this.#bandGen === generation && this.#bandCount === n
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
    this.#bandGen = generation;
    this.#bandCount = n;
    this.#bandW = w;
    this.#bandH = h;
    return bands;
  }

  /**
   * Recompute the cached boundary-overlay seam coordinates from the band table,
   * held against the table they came from. segmentBands() replaces that table
   * only when the layout moves, so composite() reuses this cache until it does.
   * @param {import('./segment_layout.js').SegRange[]} bands - The current layout.
   * @returns {void}
   */
  rebuildBoundaries(bands) {
    const yBounds = new Set();
    const xBounds = new Set();
    for (const band of bands) {
      // Y does not wrap (y0 == 0 is the top edge); X wraps on the cylinder, so
      // the x == 0 seam is added below only once the layout is split.
      if (band.y0 > 0) yBounds.add(band.y0);
      if (band.x0 > 0) xBounds.add(band.x0);
    }
    if (xBounds.size > 0) xBounds.add(0);
    this.#boundaryYs = [...yBounds];
    this.#boundaryXs = [...xBounds];
    this.#boundaryBands = bands;
  }

}
