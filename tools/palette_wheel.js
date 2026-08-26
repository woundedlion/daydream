/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The palette tool's OKLCH hue-key wheel (tools/palettes.html): the gamut raster
 * it is painted on, the key markers and the labels laid out around them, and the
 * pointer and keyboard arithmetic that moves a key. The painter takes its canvas
 * and 2D context as arguments and reads the keys only as a base turn plus
 * offsets, so a recording context double exercises it without a browser. The
 * page keeps the event wiring and the ARIA handles.
 */

import { linearToSrgbFloat } from './color.js';
import { maxSrgbGamutChroma, oklchLinearRgb, wrapTurns } from './palette_controls.js';

/**
 * @typedef {{baseTurns: number, offsets: number[]}} HueKeyState
 *   The wheel's keys: the first key's wrapped turn and every key's signed offset
 *   from it, as palette_controls.js's hueKeyState returns them.
 */

/**
 * @typedef {object} HueKeyLabel
 * @property {string} text - The drawn caption.
 * @property {number} width - Box width, including both paddings.
 * @property {number} height - Box height.
 * @property {number} paddingX - Inset the caption is drawn at.
 * @property {number} x - Box left, in canvas pixels.
 * @property {number} y - Box top, in canvas pixels.
 */

/** Key captions, in key order. */
export const HUE_KEY_NAMES = Object.freeze(['A', 'B', 'C', 'D']);

/** Grab radius around a key marker, in canvas pixels. */
export const HUE_KEY_GRAB_RADIUS = 16;

// Slate-900, so the region outside the gamut reads as a boundary rather than as
// the canvas edge.
const BACKDROP = Object.freeze([15, 23, 42]);
// A channel this far outside [0, 1] is still drawn: the bisected gamut boundary
// lands on it from either side.
const GAMUT_LOW = -0.0001;
const GAMUT_HIGH = 1.0001;
const RASTER_RADIUS = 0.47;
const MARKER_RADIUS = 0.405;
const MARKER_DOT_RADIUS = 8;
const LABEL_FONT = '700 20px Inter, sans-serif';
const LABEL_HEIGHT = 28;
const LABEL_PADDING_X = 7;
const LABEL_INSET = 18;
// Lightness steps the raster is cached at: rebuilding it costs a 360x12 gamut
// bisection plus a 65k-sample raster, which a lightness drag would otherwise pay
// per slider tick for a step the wheel cannot show.
const LIGHTNESS_STEPS = 64;

/**
 * Paints the OKLCH gamut slice at one lightness into an RGBA pixel buffer: hue
 * around the wheel, chroma out from the center, scaled so the rim is the widest
 * in-gamut chroma at that lightness.
 * @param {Uint8ClampedArray|number[]} data - RGBA bytes, `width * height * 4` long, filled in place.
 * @param {number} width - Raster width, in pixels.
 * @param {number} height - Raster height, in pixels.
 * @param {number} lightness - OKLCH L the slice is taken at.
 * @returns {void}
 */
export function paintHueWheelRaster(data, width, height, lightness) {
  const radius = Math.min(width, height) * RASTER_RADIUS;
  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const maximumChroma = Math.max(0.001, maxSrgbGamutChroma(lightness));
  const chromaPerPixel = maximumChroma / radius;
  const turnsPerRadian = 1 / (Math.PI * 2);
  // 65k samples: the colour conversion fills this one array rather than
  // returning a fresh triple per pixel.
  const rgb = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - centerY;
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - centerX;
      const distance = Math.hypot(dx, dy);
      const offset = (y * width + x) * 4;
      oklchLinearRgb(lightness, distance * chromaPerPixel,
        wrapTurns(Math.atan2(dy, dx) * turnsPerRadian), rgb);
      const inGamut = distance <= radius
        && rgb[0] >= GAMUT_LOW && rgb[0] <= GAMUT_HIGH
        && rgb[1] >= GAMUT_LOW && rgb[1] <= GAMUT_HIGH
        && rgb[2] >= GAMUT_LOW && rgb[2] <= GAMUT_HIGH;
      for (let channel = 0; channel < 3; channel++) {
        data[offset + channel] = inGamut
          ? Math.round(
            Math.max(0, Math.min(1, linearToSrgbFloat(rgb[channel]))) * 255)
          : BACKDROP[channel];
      }
      data[offset + 3] = 255;
    }
  }
}

/**
 * Where each hue key's marker sits on the wheel.
 * @param {HueKeyState} state - The keys.
 * @param {number} width - Canvas width, in pixels.
 * @param {number} height - Canvas height, in pixels.
 * @returns {Array<{x: number, y: number}>} Marker centers, in key order.
 */
export function hueKeyMarkerPoints(state, width, height) {
  const centerX = width * 0.5;
  const centerY = height * 0.5;
  const radius = Math.min(width, height) * MARKER_RADIUS;
  return state.offsets.map((offset) => {
    const angle = (state.baseTurns + offset) * Math.PI * 2;
    return {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    };
  });
}

/**
 * Every key's hue as the label reports it.
 * @param {HueKeyState} state - The keys.
 * @returns {number[]} Each key's hue in whole degrees, in [0, 360).
 */
export function hueKeyDegrees(state) {
  return state.offsets.map((offset) =>
    Math.round(wrapTurns(state.baseTurns + offset) * 360) % 360);
}

/**
 * Lays out one caption per key: outboard of its marker, inside the canvas, and
 * pushed clear of any earlier box it would overlap.
 * @param {Array<{x: number, y: number}>} points - Marker centers, in key order.
 * @param {number[]} degrees - Each key's hue, in whole degrees.
 * @param {object} bounds - Where the boxes must fit.
 * @param {number} bounds.width - Canvas width, in pixels.
 * @param {number} bounds.height - Canvas height, in pixels.
 * @param {(text: string) => number} bounds.measure - Caption width under the drawing font.
 * @returns {HueKeyLabel[]} The boxes, in key order.
 */
export function hueKeyLabelBoxes(points, degrees, { width, height, measure }) {
  const centerX = width * 0.5;
  const labels = points.map((point, index) => {
    const text = `${HUE_KEY_NAMES[index]} ${degrees[index]}°`;
    const boxWidth = measure(text) + LABEL_PADDING_X * 2;
    const preferredX = point.x < centerX ? point.x + 13 : point.x - boxWidth - 13;
    return {
      text,
      width: boxWidth,
      height: LABEL_HEIGHT,
      paddingX: LABEL_PADDING_X,
      x: Math.max(LABEL_INSET,
        Math.min(width - boxWidth - LABEL_INSET, preferredX)),
      y: Math.max(LABEL_INSET,
        Math.min(height - LABEL_HEIGHT - LABEL_INSET,
          point.y - LABEL_HEIGHT * 0.5)),
    };
  });

  const sorted = [...labels].sort((left, right) => left.y - right.y);
  for (let index = 1; index < sorted.length; index++) {
    for (let prior = 0; prior < index; prior++) {
      const horizontalOverlap =
        sorted[index].x < sorted[prior].x + sorted[prior].width &&
        sorted[index].x + sorted[index].width > sorted[prior].x;
      if (horizontalOverlap)
        sorted[index].y = Math.max(sorted[index].y,
          sorted[prior].y + sorted[prior].height + 2);
    }
  }

  const bottom = Math.max(...labels.map((label) => label.y + label.height));
  const shift = Math.max(0, bottom - height + LABEL_INSET);
  for (const label of labels) label.y = Math.max(LABEL_INSET, label.y - shift);
  return labels;
}

/**
 * The hue a point on the wheel names.
 * @param {number} x - Canvas x, in pixels.
 * @param {number} y - Canvas y, in pixels.
 * @param {number} width - Canvas width, in pixels.
 * @param {number} height - Canvas height, in pixels.
 * @returns {number} The hue, in turns, wrapped onto [0, 1).
 */
export function wheelTurnAt(x, y, width, height) {
  return wrapTurns(
    Math.atan2(y - height * 0.5, x - width * 0.5) / (Math.PI * 2));
}

/**
 * Takes a viewport point to the canvas' own pixel grid, which a CSS-scaled
 * canvas does not share with its display box.
 * @param {number} clientX - Viewport x.
 * @param {number} clientY - Viewport y.
 * @param {{left: number, top: number, width: number, height: number}} rect - The canvas' padding box, which is where the bitmap is drawn.
 * @param {number} width - Canvas width, in pixels.
 * @param {number} height - Canvas height, in pixels.
 * @returns {{x: number, y: number}} The point, in canvas pixels.
 */
export function canvasPoint(clientX, clientY, rect, width, height) {
  return {
    x: (clientX - rect.left) * width / rect.width,
    y: (clientY - rect.top) * height / rect.height,
  };
}

/**
 * How far one arrow-key press moves a hue key.
 * @param {string} key - KeyboardEvent key.
 * @param {boolean} shiftKey - Whether Shift was held, which nudges ten times as far.
 * @returns {?number} The signed travel, in turns, or null for keys the wheel leaves alone.
 */
export function hueKeyNudgeTurns(key, shiftKey) {
  const direction = key === 'ArrowLeft' || key === 'ArrowDown' ? -1
    : key === 'ArrowRight' || key === 'ArrowUp' ? 1 : 0;
  if (direction === 0) return null;
  return direction * (shiftKey ? 10 : 1) / 360;
}

/**
 * Carries the selected and grabbed key through a resample onto a shorter key
 * set — a four-key harmony hands off to three.
 * @param {number} keyCount - How many keys the new set has.
 * @param {number} selectedKey - Index the wheel had selected.
 * @param {?number} activeKey - Index the pointer had grabbed, or null.
 * @returns {{selectedKey: number, activeKey: ?number, kept: boolean}} The
 *   surviving indices, and whether both survived. Clamping a dropped index onto
 *   its neighbour would silently act on a different key, so `kept` is false and
 *   the caller abandons the gesture rather than applying it.
 */
export function hueKeyHandoff(keyCount, selectedKey, activeKey) {
  const grabKept = activeKey === null || activeKey < keyCount;
  return {
    selectedKey: Math.min(selectedKey, keyCount - 1),
    activeKey: grabKept ? activeKey : null,
    kept: grabKept && selectedKey < keyCount,
  };
}

/**
 * Builds the hue-key wheel painter, which owns the gamut raster cache.
 *
 * The raster is rebuilt only when the quantized lightness changes, so a drag on
 * another control repaints the markers over the raster already in hand.
 * @param {object} opts - Painter context.
 * @param {HTMLCanvasElement} opts.canvas - The wheel canvas.
 * @param {CanvasRenderingContext2D} opts.ctx - Its 2D context.
 * @returns {{draw: (view: {lightness: number, state: HueKeyState, activeKey: ?number, selectedKey: number}) => {points: Array<{x: number, y: number}>, degrees: number[]}}}
 *   The painter; draw reports the markers it drew and the hues it labelled them with.
 */
export function createHueKeyWheelPainter({ canvas, ctx }) {
  /** @type {ImageData?} */
  let raster = null;
  /** @type {number?} */
  let rasterLightness = null;

  /**
   * @param {HueKeyLabel} label - The box to draw.
   * @returns {void}
   */
  function drawLabel(label) {
    const { text, width, height, paddingX, x, y } = label;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + paddingX, y + height * 0.5);
  }

  return {
    draw({ lightness, state, activeKey, selectedKey }) {
      const { width, height } = canvas;
      const quantized = Math.round(lightness * LIGHTNESS_STEPS) / LIGHTNESS_STEPS;
      if (!raster || rasterLightness !== quantized) {
        raster = ctx.createImageData(width, height);
        paintHueWheelRaster(raster.data, width, height, quantized);
        rasterLightness = quantized;
      }
      ctx.putImageData(raster, 0, 0);

      const points = hueKeyMarkerPoints(state, width, height);
      const selected = Math.min(selectedKey, points.length - 1);
      const degrees = hueKeyDegrees(state);
      ctx.font = LABEL_FONT;
      const labels = hueKeyLabelBoxes(points, degrees, {
        width, height, measure: (text) => ctx.measureText(text).width,
      });

      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();

      points.forEach((point, index) => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, MARKER_DOT_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = '#0F172A';
        ctx.fill();
        const highlighted = index === activeKey || index === selected;
        ctx.strokeStyle = highlighted ? '#60A5FA' : '#FFFFFF';
        ctx.lineWidth = highlighted ? 4 : 2;
        ctx.stroke();
      });
      labels.forEach(drawLabel);

      return { points, degrees };
    },
  };
}
