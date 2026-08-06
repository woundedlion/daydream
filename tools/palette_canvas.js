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
 * Builds the color-strip painter, which owns the offscreen gradient cache.
 *
 * Caching the rendered gradient avoids rebuilding ImageData while a drag only
 * changes the selection overlay. Call invalidate() whenever the palette
 * changes; a canvas size change is detected here.
 * @param {Object} opts - Painter context.
 * @param {{width: number, height: number}} opts.canvas - The visible strip canvas.
 * @param {Object} opts.ctx - Its 2D context.
 * @param {Document} [opts.doc] - Document the offscreen cache canvas is created in.
 * @returns {{invalidate: Function, draw: Function}} The painter.
 */
export function createColorStripPainter({ canvas, ctx, doc = document }) {
  let cache = null;
  let dirty = true;
  let cachedViewStart = null;
  let cachedViewEnd = null;

  /**
   * Repaints the offscreen gradient when the palette or the canvas size changed.
   * @param {{get: Function}} palette - Palette sampled per column.
   * @param {number} width - Canvas width.
   * @param {number} height - Canvas height.
   * @param {{start: number, end: number}} view - Phase window shown by the strip.
   * @returns {void}
   */
  function refreshCache(palette, width, height, view) {
    if (!cache || cache.width !== width || cache.height !== height) {
      cache = doc.createElement('canvas');
      cache.width = width;
      cache.height = height;
      dirty = true;
    }
    if (view.start !== cachedViewStart || view.end !== cachedViewEnd) dirty = true;
    if (!dirty) return;

    const cacheCtx = cache.getContext('2d');
    const imageData = cacheCtx.createImageData(width, height);
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

      for (let y = 0; y < height; y++) {
        const index = (y * width + x) * 4;
        data[index] = rInt;
        data[index + 1] = gInt;
        data[index + 2] = bInt;
        data[index + 3] = 255; // Alpha
      }
    }
    cacheCtx.putImageData(imageData, 0, 0);
    cachedViewStart = view.start;
    cachedViewEnd = view.end;
    dirty = false;
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
     * @param {{get: Function}} palette - The palette to render.
     * @param {{start: number, end: number}|null} [selectionRange] - Drag selection as strip positions.
     * @param {{start: number, end: number}} [view] - Phase window shown by the strip.
     * @returns {void}
     */
    draw(palette, selectionRange = null, view = { start: 0, end: 1 }) {
      if (!ctx) return;
      const width = canvas.width;
      const height = canvas.height;

      refreshCache(palette, width, height, view);

      // Blit the cached gradient, clearing the previous selection overlay.
      ctx.drawImage(cache, 0, 0);

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

function fitCanvasToDisplay(canvas, ctx) {
  const width = Math.max(1, Math.round(canvas.clientWidth || canvas.width));
  const height = Math.max(1, Math.round(canvas.clientHeight || canvas.height));
  const pixelRatio = Math.max(1, globalThis.devicePixelRatio || 1);
  const renderWidth = Math.round(width * pixelRatio);
  const renderHeight = Math.round(height * pixelRatio);

  if (canvas.width !== renderWidth || canvas.height !== renderHeight) {
    canvas.width = renderWidth;
    canvas.height = renderHeight;
  }
  ctx.setTransform?.(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return { width, height };
}

/**
 * Draws the R, G, and B wave functions on the graph canvas.
 * @param {Object} opts - Draw context.
 * @param {{width: number, height: number}} opts.canvas - The graph canvas.
 * @param {Object} opts.ctx - Its 2D context.
 * @param {{getChannelValues: Function}} opts.palette - The palette to plot.
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
  ctx.strokeStyle = '#475569';
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();
  ctx.setLineDash([]); // Reset dashed line

  // Sample all three channels per column up front: a generative palette
  // reconstructs its whole LUT entry per sample, so asking one channel at a
  // time would redo that (and its pows) three times over.
  const samples = new Array(width);
  for (let x = 0; x < width; x++) {
    samples[x] = palette.getChannelValues(x / (width - 1));
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

  // Draw clamped region overlay (optional, but informative)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  const y0 = toY(0), y1 = toY(1); // canvas y of the value-0 and value-1 lines
  // Area below 0 (between the value-0 line and the band bottom)
  ctx.fillRect(0, y0, width, yBottom - y0);
  // Area above 1 (between the band top and the value-1 line)
  ctx.fillRect(0, yTop, width, y1 - yTop);
}
