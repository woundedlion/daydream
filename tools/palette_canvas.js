/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The two canvas painters of the palette tool page (tools/palettes.html): the
 * gradient strip with its sweep marker and drag-selection overlay, and the RGB
 * wave graph. Both take their canvas and 2D context as arguments and read the
 * palette only through get()/getChannelValues(), so a recording context double
 * exercises them without a browser. The page keeps the pointer/keyboard wiring.
 */

import { linearToSrgbFloat } from './color.js';
import { waveGraphBand } from './palette_math.js';

/**
 * Builds the color-strip painter, which owns the offscreen gradient cache.
 *
 * The strip is static between palette changes; only the sweeping marker moves
 * each frame. Caching the rendered gradient makes the per-frame draw a single
 * blit plus a 2px line instead of a full ImageData build and `width` palette
 * evaluations. Call invalidate() whenever the palette changes; a canvas size
 * change is detected here.
 * @param {Object} opts - Painter context.
 * @param {{width: number, height: number}} opts.canvas - The visible strip canvas.
 * @param {Object} opts.ctx - Its 2D context.
 * @param {Document} [opts.doc] - Document the offscreen cache canvas is created in.
 * @returns {{invalidate: Function, draw: Function}} The painter.
 */
export function createColorStripPainter({ canvas, ctx, doc = document }) {
  let cache = null;
  let dirty = true;

  /**
   * Repaints the offscreen gradient when the palette or the canvas size changed.
   * @param {{get: Function}} palette - Palette sampled per column.
   * @param {number} width - Canvas width.
   * @param {number} height - Canvas height.
   * @returns {void}
   */
  function refreshCache(palette, width, height) {
    if (!cache || cache.width !== width || cache.height !== height) {
      cache = doc.createElement('canvas');
      cache.width = width;
      cache.height = height;
      dirty = true;
    }
    if (!dirty) return;

    const cacheCtx = cache.getContext('2d');
    const imageData = cacheCtx.createImageData(width, height);
    const data = imageData.data;

    for (let x = 0; x < width; x++) {
      const tx = x / (width - 1);
      const [r, g, b] = palette.get(tx); // Get color in [0, 1] range

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
     * Draws the color strip, the time marker, and an optional selection overlay.
     * @param {{get: Function}} palette - The palette to render.
     * @param {number} t - The current time parameter (0 to 1) for the marker position.
     * @param {{start: number, end: number}|null} [selectionRange] - Drag selection, in the same 0..1 domain.
     * @returns {void}
     */
    draw(palette, t, selectionRange = null) {
      if (!ctx) return;
      const width = canvas.width;
      const height = canvas.height;

      refreshCache(palette, width, height);

      // Blit the cached gradient (also clears the previous marker).
      ctx.drawImage(cache, 0, 0);

      const markerX = Math.round(t * (width - 1));

      ctx.strokeStyle = '#FFFFFF'; // Bright white marker
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
      ctx.shadowBlur = 5;

      ctx.beginPath();
      ctx.moveTo(markerX, 0);
      ctx.lineTo(markerX, height);
      ctx.stroke();

      ctx.shadowBlur = 0; // Reset shadow

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

const DIAGNOSTIC_CURVES = [
  { key: 'L', color: '#F8FAFC', axis: 'left' },
  { key: 'q', color: '#F59E0B', axis: 'left' },
  { key: 'C', color: '#A855F7', axis: 'right' },
  { key: 'Cmax', color: '#EC4899', axis: 'right' },
];

/**
 * Draws engine-returned V2 diagnostics without reproducing palette math.
 * @param {Object} opts
 * @param {{width:number,height:number}} opts.canvas
 * @param {Object} opts.ctx
 * @param {{diagnosticAt:Function,getChannelValues:Function}} opts.palette
 */
export function drawRecipeDiagnostics({ canvas, ctx, palette }) {
  if (!ctx) return;
  const { width, height } = fitCanvasToDisplay(canvas, ctx);
  const top = 24;
  const bottom = height - 24;
  const samples = Array.from({ length: width }, (_, x) => {
    const t = width > 1 ? x / (width - 1) : 0;
    return {
      ...palette.diagnosticAt(t),
      rgbFloat: palette.getChannelValues(t),
    };
  });
  const chromaMax = Math.max(1e-6, ...samples.map((sample) => sample.Cmax));
  const leftY = (value) => bottom - Math.max(0, Math.min(1, value)) * (bottom - top);
  const rightY = (value) => bottom - (value / chromaMax) * (bottom - top);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#1E293B';
  ctx.fillRect(0, 0, width, height);

  WAVE_COLORS.forEach((color, channel) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    for (let x = 0; x < width; x += 1) {
      const y = leftY(samples[x].rgbFloat[channel]);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });

  for (const curve of DIAGNOSTIC_CURVES) {
    ctx.beginPath();
    ctx.strokeStyle = curve.color;
    ctx.lineWidth = 1.5;
    for (let x = 0; x < width; x += 1) {
      const value = samples[x][curve.key];
      const y = curve.axis === 'left' ? leftY(value) : rightY(value);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = '#F43F5E';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 1) {
    if (!samples[x].fallbackMapped) continue;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }

}
