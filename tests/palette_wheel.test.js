// The palette tool's hue-key wheel, run end to end against a recording context
// double: the gamut raster, the marker and label geometry laid over it, and the
// pointer and keyboard arithmetic a key is moved by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HUE_KEY_GRAB_RADIUS, HUE_KEY_NAMES,
  canvasPoint, createHueKeyWheelPainter, hueKeyDegrees, hueKeyHandoff,
  hueKeyLabelBoxes, hueKeyMarkerPoints, hueKeyNudgeTurns, paintHueWheelRaster,
  wheelTurnAt,
} from '../tools/palette_wheel.js';
import { hitTestHueKeyMarker, oklchLinearRgb } from '../tools/palette_controls.js';
import { linearToSrgbFloat } from '../tools/color.js';

// Slate-900: what the raster paints outside the gamut.
const BACKDROP = [15, 23, 42];

/**
 * Rasters one wheel.
 * @param {number} lightness - OKLCH L to paint the slice at.
 * @param {number} [size] - Raster width and height, in pixels.
 * @returns {{data: Uint8ClampedArray, size: number, at: (x: number, y: number) => number[]}}
 *   The pixels, and a reader for one RGBA quadruple.
 */
function raster(lightness, size = 16) {
  const data = new Uint8ClampedArray(size * size * 4);
  paintHueWheelRaster(data, size, size, lightness);
  return {
    data,
    size,
    at: (x, y) => Array.from(data.slice((y * size + x) * 4, (y * size + x) * 4 + 4)),
  };
}

test('the wheel raster paints the gamut inside its rim and a backdrop outside', () => {
  const { at, data, size } = raster(0.62);

  assert.deepEqual(at(0, 0), [...BACKDROP, 255], 'the corner is outside the rim');
  assert.deepEqual(at(size - 1, size - 1), [...BACKDROP, 255]);
  assert.notDeepEqual(at(size / 2, size / 2).slice(0, 3), BACKDROP,
    'the neutral center is always in gamut');

  for (let index = 3; index < data.length; index += 4)
    assert.equal(data[index], 255, 'every pixel is opaque');
});

test('the wheel raster reaches the sRGB encoding of the OKLCH slice it draws', () => {
  const { at } = raster(0.62, 256);
  // The pixel nearest the center carries almost no chroma, so it is the neutral
  // of the slice's own lightness.
  const neutral = Math.round(
    linearToSrgbFloat(oklchLinearRgb(0.62, 0, 0)[0]) * 255);
  const [r, g, b] = at(128, 128);

  for (const channel of [r, g, b])
    assert.ok(Math.abs(channel - neutral) <= 2, `${channel} is near ${neutral}`);
});

test('a brighter slice rasters brighter than a darker one', () => {
  const dark = raster(0.3).at(8, 8);
  const light = raster(0.9).at(8, 8);

  for (let channel = 0; channel < 3; channel++)
    assert.ok(light[channel] > dark[channel],
      'the wheel must show the lightness it was asked for');
});

test('the wheel raster leaves the out-of-gamut corners of its own rim behind', () => {
  const { data } = raster(0.62, 32);
  let backdrop = 0;
  let painted = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] === BACKDROP[0] && data[index + 1] === BACKDROP[1]
      && data[index + 2] === BACKDROP[2]) backdrop++;
    else painted++;
  }

  assert.ok(backdrop > 0, 'the square corners fall outside the wheel');
  assert.ok(painted > 0, 'the wheel itself must be painted');
});

test('hue key markers ring the wheel at the turns their offsets name', () => {
  const points = hueKeyMarkerPoints({ baseTurns: 0, offsets: [0, 0.25, 0.5] },
    200, 200);
  const radius = 200 * 0.405;

  assert.equal(points.length, 3);
  assert.ok(Math.abs(points[0].x - (100 + radius)) < 1e-9);
  assert.ok(Math.abs(points[0].y - 100) < 1e-9);
  assert.ok(Math.abs(points[1].y - (100 + radius)) < 1e-9, 'a quarter turn is down');
  assert.ok(Math.abs(points[2].x - (100 - radius)) < 1e-9, 'a half turn is left');
});

test('a marker is grabbable within the wheel grab radius and not beyond it', () => {
  const points = hueKeyMarkerPoints({ baseTurns: 0, offsets: [0, 0.5] }, 200, 200);

  assert.equal(hitTestHueKeyMarker(points[1].x + HUE_KEY_GRAB_RADIUS - 1,
    points[1].y, points, HUE_KEY_GRAB_RADIUS), 1);
  assert.equal(hitTestHueKeyMarker(points[1].x + HUE_KEY_GRAB_RADIUS + 1,
    points[1].y, points, HUE_KEY_GRAB_RADIUS), null);
});

test('key hues are reported in whole degrees, wrapped past the seam', () => {
  assert.deepEqual(
    hueKeyDegrees({ baseTurns: 0.98, offsets: [0, 0.04, -0.25] }),
    [353, 7, 263]);
  assert.deepEqual(hueKeyDegrees({ baseTurns: 0.9999, offsets: [0] }), [0],
    'a hue that rounds to a full turn reads as zero, not 360');
});

test('key labels sit outboard of their markers, inside the canvas', () => {
  const bounds = { width: 256, height: 256, measure: (text) => text.length * 10 };
  const labels = hueKeyLabelBoxes(
    [{ x: 40, y: 128 }, { x: 220, y: 128 }], [10, 20], bounds);

  assert.equal(labels[0].text, 'A 10°');
  assert.equal(labels[1].text, 'B 20°');
  assert.ok(labels[0].x > 40, 'a marker left of center is labelled to its right');
  assert.ok(labels[1].x + labels[1].width < 220,
    'a marker right of center is labelled to its left');
  for (const label of labels) {
    assert.ok(label.x >= 18 && label.x + label.width <= 256 - 18);
    assert.ok(label.y >= 18 && label.y + label.height <= 256 - 18);
  }
});

test('labels that would overlap are stacked instead of drawn on top of each other', () => {
  const bounds = { width: 256, height: 256, measure: (text) => text.length * 10 };
  const stacked = hueKeyLabelBoxes(
    [{ x: 200, y: 100 }, { x: 200, y: 105 }], [10, 20], bounds);

  assert.equal(stacked[0].y, 86);
  assert.equal(stacked[1].y, 86 + stacked[0].height + 2);
  assert.equal(stacked[0].x, stacked[1].x, 'only the vertical placement moves');
});

test('a stack that would run off the bottom is lifted back onto the canvas', () => {
  const bounds = { width: 256, height: 120, measure: () => 60 };
  const labels = hueKeyLabelBoxes(
    [{ x: 200, y: 60 }, { x: 200, y: 62 }, { x: 200, y: 64 }], [1, 2, 3], bounds);

  for (const label of labels)
    assert.ok(label.y >= 18 && label.y + label.height <= 120,
      'every box stays on the canvas');
});

test('a point on the wheel names the hue under it', () => {
  assert.equal(wheelTurnAt(100, 50, 100, 100), 0);
  assert.ok(Math.abs(wheelTurnAt(50, 100, 100, 100) - 0.25) < 1e-12);
  assert.ok(Math.abs(wheelTurnAt(0, 50, 100, 100) - 0.5) < 1e-12);
  assert.ok(Math.abs(wheelTurnAt(50, 0, 100, 100) - 0.75) < 1e-12,
    'a turn behind the seam wraps forward rather than going negative');
});

test('a viewport point maps onto the canvas grid a CSS-scaled canvas does not share', () => {
  const rect = { left: 10, top: 20, width: 100, height: 50 };

  assert.deepEqual(canvasPoint(60, 45, rect, 200, 100), { x: 100, y: 50 });
  assert.deepEqual(canvasPoint(10, 20, rect, 200, 100), { x: 0, y: 0 });
});

test('arrow keys nudge a hue key by a degree, ten with Shift', () => {
  assert.ok(Math.abs(hueKeyNudgeTurns('ArrowRight', false) - 1 / 360) < 1e-15);
  assert.ok(Math.abs(hueKeyNudgeTurns('ArrowUp', false) - 1 / 360) < 1e-15);
  assert.ok(Math.abs(hueKeyNudgeTurns('ArrowLeft', false) + 1 / 360) < 1e-15);
  assert.ok(Math.abs(hueKeyNudgeTurns('ArrowDown', false) + 1 / 360) < 1e-15);
  assert.ok(Math.abs(hueKeyNudgeTurns('ArrowRight', true) - 10 / 360) < 1e-15);
});

test('keys the wheel does not own are left to the page', () => {
  assert.equal(hueKeyNudgeTurns('Tab', false), null);
  assert.equal(hueKeyNudgeTurns('Enter', true), null);
  assert.equal(hueKeyNudgeTurns('a', false), null);
});

test('a handoff onto fewer keys keeps a selection and a grab that both survive', () => {
  assert.deepEqual(hueKeyHandoff(3, 1, null),
    { selectedKey: 1, activeKey: null, kept: true });
  assert.deepEqual(hueKeyHandoff(3, 2, 2),
    { selectedKey: 2, activeKey: 2, kept: true });
});

test('a handoff that drops the key being acted on abandons the gesture', () => {
  assert.deepEqual(hueKeyHandoff(3, 3, null),
    { selectedKey: 2, activeKey: null, kept: false });
  assert.deepEqual(hueKeyHandoff(3, 0, 3),
    { selectedKey: 0, activeKey: null, kept: false },
    'a grab on a dropped key is released rather than moved to its neighbour');
});

/**
 * Recording stand-in for a CanvasRenderingContext2D. Every drawing call lands in
 * `ops` in order, and every state assignment is a plain property.
 * @returns {Object} The context double.
 */
function fakeContext() {
  const ops = [];
  return {
    ops,
    rasters: 0,
    createImageData(width, height) {
      this.rasters++;
      return { width, height, data: new Uint8ClampedArray(width * height * 4) };
    },
    putImageData: function putImageData(image) { this.painted = image; },
    measureText: (text) => ({ width: text.length * 10 }),
    beginPath: () => ops.push(['beginPath']),
    moveTo: (...a) => ops.push(['moveTo', ...a]),
    lineTo: (...a) => ops.push(['lineTo', ...a]),
    arc: (...a) => ops.push(['arc', ...a]),
    fill: function fill() { ops.push(['fill', this.fillStyle]); },
    stroke: function stroke() { ops.push(['stroke', this.strokeStyle, this.lineWidth]); },
    fillRect: (...a) => ops.push(['fillRect', ...a]),
    strokeRect: (...a) => ops.push(['strokeRect', ...a]),
    fillText: (...a) => ops.push(['fillText', ...a]),
  };
}

/**
 * A wheel painter over a fresh canvas.
 * @param {number} [size] - Canvas width and height, in pixels.
 * @returns {{painter: Object, ctx: Object, canvas: Object}} The painter and its doubles.
 */
function wheelSetup(size = 16) {
  const canvas = { width: size, height: size };
  const ctx = fakeContext();
  return { painter: createHueKeyWheelPainter({ canvas, ctx }), ctx, canvas };
}

const STATE = { baseTurns: 0.1, offsets: [0, 0.2, 0.5] };

test('the wheel bakes its raster once and reuses it across quantized lightnesses', () => {
  const { painter, ctx } = wheelSetup();
  painter.draw({ lightness: 0.62, state: STATE, activeKey: null, selectedKey: 0 });
  assert.equal(ctx.rasters, 1);

  painter.draw({ lightness: 0.621, state: STATE, activeKey: null, selectedKey: 0 });
  assert.equal(ctx.rasters, 1, 'a step the wheel cannot show must not re-bake it');

  painter.draw({ lightness: 0.5, state: STATE, activeKey: null, selectedKey: 0 });
  assert.equal(ctx.rasters, 2, 'a visible lightness change re-bakes the gamut');
});

test('the wheel draws a marker per key, joined in key order, and labels each one', () => {
  const { painter, ctx } = wheelSetup(256);
  const { points, degrees } = painter.draw(
    { lightness: 0.62, state: STATE, activeKey: null, selectedKey: 0 });

  assert.equal(points.length, 3);
  assert.deepEqual(degrees, hueKeyDegrees(STATE));
  assert.deepEqual(ctx.ops.filter(([name]) => name === 'moveTo'),
    [['moveTo', points[0].x, points[0].y]]);
  assert.equal(ctx.ops.filter(([name]) => name === 'lineTo').length, 2,
    'the polyline joins the keys after the first');
  assert.equal(ctx.ops.filter(([name]) => name === 'arc').length, 3);

  const captions = ctx.ops.filter(([name]) => name === 'fillText').map(([, text]) => text);
  assert.deepEqual(captions,
    degrees.map((degree, index) => `${HUE_KEY_NAMES[index]} ${degree}°`));
});

test('the wheel highlights the selected and grabbed markers and no others', () => {
  const { painter, ctx } = wheelSetup(256);
  painter.draw({ lightness: 0.62, state: STATE, activeKey: 1, selectedKey: 2 });

  // The polyline strokes first, then one stroke per marker.
  const widths = ctx.ops.filter(([name]) => name === 'stroke').map((op) => op[2]);
  assert.deepEqual(widths, [2, 2, 4, 4], 'keys B and C are the highlighted pair');
});

test('a selection past the end of a shorter key set highlights its last key', () => {
  const { painter, ctx } = wheelSetup(256);
  painter.draw({
    lightness: 0.62,
    state: { baseTurns: 0, offsets: [0, 0.3] },
    activeKey: null,
    selectedKey: 3,
  });

  const widths = ctx.ops.filter(([name]) => name === 'stroke').map((op) => op[2]);
  assert.deepEqual(widths, [2, 2, 4], 'no marker is left unhighlighted by a stale selection');
});
