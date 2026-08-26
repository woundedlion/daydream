/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The two canvas painters of the palette tool page (tools/palettes.html): the
 * gradient strip with its drag-selection overlay, and the RGB
 * wave graph. Both take their canvas and 2D context as arguments and read the
 * palette only through get()/getChannelValues(), so a recording context double
 * exercises them without a browser. The page keeps the pointer/keyboard wiring.
 */

import { linearToSrgbFloat } from './color.js';
import { waveGraphBand } from './palette_math.js';

/**
 * @typedef {{get: (t: number) => number[]}} StripPalette
 *   Sampled per strip column for linear [R, G, B].
 */

/**
 * @typedef {{getChannelValues: (t: number) => number[]}} WavePalette
 *   Sampled per graph column for sRGB [R, G, B].
 */

/**
 * Sizes a canvas' backing store to its display box in device pixels and scales
 * the context so drawing stays in CSS pixels.
 * @param {HTMLCanvasElement} canvas - Canvas to size to its display box.
 * @param {CanvasRenderingContext2D} ctx - Its 2D context.
 * @returns {{width: number, height: number}} The canvas' size in CSS pixels.
 */
function fitCanvasToDisplay(canvas, ctx) {
  const pixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
  let width;
  let height;

  if (canvas.clientWidth && canvas.clientHeight) {
    width = Math.max(1, Math.round(canvas.clientWidth));
    height = Math.max(1, Math.round(canvas.clientHeight));
    const renderWidth = Math.round(width * pixelRatio);
    const renderHeight = Math.round(height * pixelRatio);
    if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
      canvas.width = renderWidth;
      canvas.height = renderHeight;
    }
  } else {
    // An unlaid-out canvas has no display size to fit to. Its backing store is
    // already in device pixels, so sizing it from itself would multiply by the
    // ratio again on every call.
    width = Math.max(1, Math.round(canvas.width / pixelRatio));
    height = Math.max(1, Math.round(canvas.height / pixelRatio));
  }

  // Setting canvas.width resets the context state, so the transform is applied
  // after any resize.
  ctx.setTransform?.(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return { width, height };
}

/**
 * Builds the color-strip painter, which owns the offscreen gradient cache.
 *
 * Caching the rendered gradient avoids rebuilding ImageData while a drag only
 * changes the selection overlay. Call invalidate() whenever the palette
 * changes; a canvas size change is detected here.
 * @param {Object} opts - Painter context.
 * @param {HTMLCanvasElement} opts.canvas - The visible strip canvas.
 * @param {CanvasRenderingContext2D} opts.ctx - Its 2D context.
 * @param {Document} [opts.doc] - Document the offscreen cache canvas is created in.
 * @returns {{invalidate: () => void, draw: (palette: StripPalette, selectionRange?: {start: number, end: number}?, view?: {start: number, end: number}) => void}} The painter.
 */
export function createColorStripPainter({ canvas, ctx, doc = document }) {
  /** @type {HTMLCanvasElement?} */
  let cache = null;
  let dirty = true;
  /** @type {number?} */
  let cachedViewStart = null;
  /** @type {number?} */
  let cachedViewEnd = null;

  /**
   * Repaints the offscreen gradient when the palette, the canvas width or the
   * phase window changed. Each column is one flat color, so the cache is one
   * device pixel tall and the blit stretches it over the strip's height.
   * @param {StripPalette} palette - Palette sampled per column.
   * @param {number} width - Cache width, in device pixels.
   * @param {{start: number, end: number}} view - Phase window shown by the strip.
   * @returns {HTMLCanvasElement} The cache canvas, current as of this call.
   */
  function refreshCache(palette, width, view) {
    if (!cache || cache.width !== width) {
      cache = doc.createElement('canvas');
      cache.width = width;
      cache.height = 1;
      dirty = true;
    }
    if (view.start !== cachedViewStart || view.end !== cachedViewEnd) dirty = true;
    if (!dirty) return cache;

    const cacheCtx = /** @type {CanvasRenderingContext2D} */ (cache.getContext('2d'));
    const imageData = cacheCtx.createImageData(width, 1);
    const data = imageData.data;

    for (let x = 0; x < width; x++) {
      const position = width === 1 ? 0 : x / (width - 1);
      const phase = view.start + position * (view.end - view.start);
      const [r, g, b] = palette.get(phase);

      // Plain 8-bit round, no dither: the strip mirrors the device's own
      // 16->8 truncation (the LED output applies no dithering), so the
      // preview stays faithful to what the hardware actually shows rather
      // than a smoother fiction. If output dithering is ever added to the
      // engine, mirror it here.
      const rInt = Math.round(linearToSrgbFloat(Math.max(0, Math.min(1, r))) * 255);
      const gInt = Math.round(linearToSrgbFloat(Math.max(0, Math.min(1, g))) * 255);
      const bInt = Math.round(linearToSrgbFloat(Math.max(0, Math.min(1, b))) * 255);

      const index = x * 4;
      data[index] = rInt;
      data[index + 1] = gInt;
      data[index + 2] = bInt;
      data[index + 3] = 255; // Alpha
    }
    cacheCtx.putImageData(imageData, 0, 0);
    cachedViewStart = view.start;
    cachedViewEnd = view.end;
    dirty = false;
    return cache;
  }

  return {
    /**
     * Marks the cached gradient stale, so the next draw rebuilds it.
     * @returns {void}
     */
    invalidate() {
      dirty = true;
    },

    /**
     * Draws the color strip and an optional selection overlay.
     * @param {StripPalette} palette - The palette to render.
     * @param {{start: number, end: number}|null} [selectionRange] - Drag selection as strip positions.
     * @param {{start: number, end: number}} [view] - Phase window shown by the strip.
     * @returns {void}
     */
    draw(palette, selectionRange = null, view = { start: 0, end: 1 }) {
      if (!ctx) return;
      const { width, height } = fitCanvasToDisplay(canvas, ctx);

      // One palette sample per device pixel: the gradient is baked at the
      // backing store's size, then blitted over the CSS-pixel box the fitted
      // transform scales by, so a column lands on a pixel.
      const gradient = refreshCache(palette, canvas.width, view);

      // Blit the cached gradient, stretched over the strip's height and
      // clearing the previous selection overlay.
      ctx.drawImage(gradient, 0, 0, width, height);

      if (selectionRange) {
        // Ensure startX is the smaller value
        const startRaw = selectionRange.start * width;
        const endRaw = selectionRange.end * width;
        const startX = Math.min(startRaw, endRaw);
        const endX = Math.max(startRaw, endRaw);

        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1;

        ctx.fillRect(startX, 0, endX - startX, height);
        ctx.strokeRect(startX, 0, endX - startX, height);
      }
    },
  };
}
// Red, Green, Blue.
const WAVE_COLORS = ['#EF4444', '#22C55E', '#3B82F6'];

/**
 * Draws the R, G, and B wave functions on the graph canvas.
 * @param {Object} opts - Draw context.
 * @param {HTMLCanvasElement} opts.canvas - The graph canvas.
 * @param {CanvasRenderingContext2D} opts.ctx - Its 2D context.
 * @param {WavePalette} opts.palette - The palette to plot.
 * @returns {void}
 */
export function drawWaveGraph({ canvas, ctx, palette }) {
  if (!ctx) return;
  const { width, height } = fitCanvasToDisplay(canvas, ctx);
  ctx.clearRect(0, 0, width, height);

  // toY() is the single place the value-to-canvas-y mapping lives; every
  // wave and overlay draw below goes through it or the band edges.
  const { yTop, yBottom, toY } = waveGraphBand(height);

  // Background grid and center line
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#475569';
  ctx.lineWidth = 1;

  // Draw the range-boundary lines at the top/bottom of the value band (10%
  // and 90% of the canvas height).
  ctx.beginPath();
  ctx.moveTo(0, yTop);
  ctx.lineTo(width, yTop);
  ctx.moveTo(0, yBottom);
  ctx.lineTo(width, yBottom);
  ctx.stroke();

  // Draw center line (0.5 reference)
  const yCenter = toY(0.5);
  ctx.strokeStyle = '#475569';
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(0, yCenter);
  ctx.lineTo(width, yCenter);
  ctx.stroke();
  ctx.setLineDash([]); // Reset dashed line

  // Sample all three channels per column up front: a generative palette
  // reconstructs its whole LUT entry per sample, so asking one channel at a
  // time would redo that (and its pows) three times over.
  const samples = new Array(width);
  for (let x = 0; x < width; x++) {
    samples[x] = palette.getChannelValues(width === 1 ? 0 : x / (width - 1));
  }

  WAVE_COLORS.forEach((color, channelIndex) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;

    for (let x = 0; x < width; x++) {
      const mappedY = toY(samples[x][channelIndex]);

      if (x === 0) {
        ctx.moveTo(x, mappedY);
      } else {
        ctx.lineTo(x, mappedY);
      }
    }
    ctx.stroke();
  });

}
