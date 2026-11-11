// The palette tool's hue-key wheel, run end to end against a recording context
// double: the gamut raster, the marker and label geometry laid over it, and the
// pointer and keyboard arithmetic a key is moved by.
import {oklchLinearRgb, HUE_KEY_GRAB_RADIUS, HUE_KEY_NAMES, canvasPoint, createHueKeyWheelPainter, hueKeyDegrees, hueKeyHandoff, hueKeyLabelBoxes, hueKeyMarkerPoints, hueKeyNudgeTurns, paintHueWheelRaster, wheelTurnAt, maxSrgbGamutChroma, RASTER_RADIUS, LIGHTNESS_STEPS, hitTestHueKeyMarker} from '../src/workbench/palettes/palette_wheel.js';
import { fakeContext, withPixelRatio } from './helpers/fake_canvas.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linearToSrgbFloat } from '../src/shared/color.js';

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
  const backdrop = at(0, 0);

  assert.deepEqual(at(size - 1, size - 1), backdrop,
    'opposite corners outside the rim share the backdrop');
  assert.notDeepEqual(at(size / 2, size / 2), backdrop,
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
  const size = 32;
  const { data, at } = raster(0.62, size);
  const backdrop = at(0, 0);
  const rim = size * RASTER_RADIUS;
  let outsideRim = 0;
  let insideRim = 0;
  let painted = 0;
  for (let index = 0; index < data.length; index += 4) {
    const pixel = index / 4;
    const dx = (pixel % size) + 0.5 - size / 2;
    const dy = Math.floor(pixel / size) + 0.5 - size / 2;
    if (data[index] === backdrop[0] && data[index + 1] === backdrop[1]
      && data[index + 2] === backdrop[2]) {
      if (Math.hypot(dx, dy) <= rim) insideRim++;
      else outsideRim++;
    } else painted++;
  }

  assert.ok(outsideRim > 0, 'the square corners fall outside the wheel');
  assert.ok(painted > 0, 'the wheel itself must be painted');
  assert.ok(insideRim > 0,
    'hues narrower than the slice max drop out before the rim');
});

test('hue key markers ring the wheel at the turns their offsets name', () => {
  const points = hueKeyMarkerPoints({ baseTurns: 0, offsets: [0, 0.25, 0.5] },
    200, 200);
  const radius = points[0].x - 100;

  assert.equal(points.length, 3);
  assert.ok(radius > 0 && radius < 100, 'the ring sits inside the canvas');
  for (const point of points)
    assert.ok(Math.abs(Math.hypot(point.x - 100, point.y - 100) - radius) < 1e-9,
      'every marker is on one ring');
  assert.ok(Math.abs(points[0].y - 100) < 1e-9, 'offset zero is right');
  assert.ok(Math.abs(points[1].x - 100) < 1e-9 && points[1].y < 100, 'a quarter turn is up');
  assert.ok(Math.abs(points[2].y - 100) < 1e-9 && points[2].x < 100, 'a half turn is left');
});

test('a marker is grabbable within the wheel grab radius and not beyond it', () => {
  const points = hueKeyMarkerPoints({ baseTurns: 0, offsets: [0, 0.5] }, 200, 200);

  assert.equal(hitTestHueKeyMarker(points[1].x + HUE_KEY_GRAB_RADIUS - 1,
    points[1].y, points, HUE_KEY_GRAB_RADIUS), 1);
  assert.equal(hitTestHueKeyMarker(points[1].x + HUE_KEY_GRAB_RADIUS + 1,
    points[1].y, points, HUE_KEY_GRAB_RADIUS), null);
});

test('hue key hit testing ignores blank wheel space', () => {
  const points = [{ x: 20, y: 20 }, { x: 80, y: 20 }, { x: 50, y: 80 }];

  assert.equal(hitTestHueKeyMarker(22, 21, points, 12), 0);
  assert.equal(hitTestHueKeyMarker(68, 20, points, 12), 1);
  assert.equal(hitTestHueKeyMarker(50, 50, points, 12), null);
});

test('key hues are reported in whole degrees, wrapped past the seam', () => {
  assert.deepEqual(
    hueKeyDegrees({ baseTurns: 0.98, offsets: [0, 0.04, -0.25] }),
    [353, 7, 263]);
  assert.deepEqual(hueKeyDegrees({ baseTurns: 0.9999, offsets: [0] }), [0],
    'a hue that rounds to a full turn reads as zero, not 360');
});

test('key labels sit beside their markers, inside the canvas', () => {
  const bounds = { width: 256, height: 256, measure: (text) => text.length * 10 };
  const labels = hueKeyLabelBoxes(
    [{ x: 40, y: 128 }, { x: 220, y: 128 }], [10, 20], bounds);

  assert.equal(labels[0].text, 'A 10°');
  assert.equal(labels[1].text, 'B 20°');
  assert.ok(labels[0].x > 40, 'a marker left of center is labelled to its right');
  assert.ok(labels[1].x + labels[1].width < 220,
    'a marker right of center is labelled to its left');
  for (const label of labels) {
    assert.ok(label.x >= 0 && label.x + label.width <= 256);
    assert.ok(label.y >= 0 && label.y + label.height <= 256);
  }
});

test('labels that would overlap are stacked instead of drawn on top of each other', () => {
  const bounds = { width: 256, height: 256, measure: (text) => text.length * 10 };
  const stacked = hueKeyLabelBoxes(
    [{ x: 200, y: 100 }, { x: 200, y: 105 }], [10, 20], bounds);

  assertNoOverlap(stacked);
  assert.ok(stacked[1].y > stacked[0].y, 'the later key stacks below');
  assert.equal(stacked[0].x, stacked[1].x, 'only the vertical placement moves');
});

/** @param {Array<{text: string, x: number, y: number, width: number, height: number}>} labels */
function assertNoOverlap(labels) {
  for (let index = 0; index < labels.length; index++) {
    for (let prior = 0; prior < index; prior++) {
      const a = labels[prior];
      const b = labels[index];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x
        || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(apart, `${a.text} overlaps ${b.text}`);
    }
  }
}

test('a stack that would run off the bottom is lifted back onto the canvas', () => {
  const bounds = { width: 256, height: 120, measure: () => 60 };
  const labels = hueKeyLabelBoxes(
    [{ x: 200, y: 60 }, { x: 200, y: 62 }, { x: 200, y: 64 }], [1, 2, 3], bounds);

  assert.equal(labels.length, 3, 'one box per marker');
  for (const label of labels)
    assert.ok(label.y >= 0 && label.y + label.height <= 120,
      'every box stays on the canvas');
  assertNoOverlap(labels);
});

// Tetradic keys at 68°: two markers clamp to the top inset and two to the
// bottom, so the stack the separation opens overruns the bottom and is lifted.
test('the lift off the bottom keeps the boxes it separated apart', () => {
  const bounds = { width: 256, height: 256, measure: (text) => text.length * 10 };
  const state = { baseTurns: 68 / 360, offsets: [0, 1 / 12, 0.5, 0.5 + 1 / 12] };
  const labels = hueKeyLabelBoxes(
    hueKeyMarkerPoints(state, 256, 256), hueKeyDegrees(state), bounds);

  assertNoOverlap(labels);
  for (const label of labels)
    assert.ok(label.y >= 0 && label.y + label.height <= 256,
      `${label.text} stays on the canvas`);
});

test('a point on the wheel names the hue under it', () => {
  assert.equal(wheelTurnAt(100, 50, 100, 100), 0);
  assert.ok(Math.abs(wheelTurnAt(50, 100, 100, 100) - 0.75) < 1e-12,
    'a turn behind the seam wraps forward rather than going negative');
  assert.ok(Math.abs(wheelTurnAt(0, 50, 100, 100) - 0.5) < 1e-12);
  assert.ok(Math.abs(wheelTurnAt(50, 0, 100, 100) - 0.25) < 1e-12,
    'up is a quarter turn');
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

const THREE_KEYS = { baseTurns: 0.1, offsets: [0, 0.2, 0.4] };
const FOUR_KEYS = { baseTurns: 0.1, offsets: [0, 0.2, 0.3, 0.4] };
// The three keys FOUR_KEYS resamples to: its ends, and a midpoint no key held.
const FOUR_RESAMPLED = { baseTurns: 0.1, offsets: [0, 0.25, 0.4] };
const TWO_KEYS = { baseTurns: 0.1, offsets: [0, 0.4] };

test('a handoff onto another key set keeps a selection and a grab that both survive', () => {
  assert.deepEqual(hueKeyHandoff(THREE_KEYS, THREE_KEYS, 1, null),
    { selectedKey: 1, activeKey: null, kept: true });
  assert.deepEqual(hueKeyHandoff(THREE_KEYS, THREE_KEYS, 2, 2),
    { selectedKey: 2, activeKey: 2, kept: true });
});

test('a handoff carries a key onto the index its own hue landed on', () => {
  assert.deepEqual(hueKeyHandoff(TWO_KEYS, THREE_KEYS, 1, 1),
    { selectedKey: 2, activeKey: 2, kept: true },
    'a two-key wheel hands its end key to the last of three, not the midpoint');
  assert.deepEqual(hueKeyHandoff(FOUR_KEYS, FOUR_RESAMPLED, 3, 3),
    { selectedKey: 2, activeKey: 2, kept: true });
});

test('a handoff that drops the key being acted on abandons the gesture', () => {
  assert.deepEqual(hueKeyHandoff(THREE_KEYS, THREE_KEYS, 3, null),
    { selectedKey: 2, activeKey: null, kept: false });
  assert.deepEqual(hueKeyHandoff(THREE_KEYS, THREE_KEYS, 0, 3),
    { selectedKey: 0, activeKey: null, kept: false },
    'a grab on a dropped key is released rather than moved to its neighbour');
  assert.deepEqual(hueKeyHandoff(FOUR_KEYS, FOUR_RESAMPLED, 1, 1),
    { selectedKey: 1, activeKey: null, kept: false },
    'an interior key the resample invents a midpoint for is not carried over');
});

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
  const quantum = Math.round(0.62 * LIGHTNESS_STEPS) / LIGHTNESS_STEPS;
  painter.draw({ lightness: quantum, state: STATE, activeKey: null, selectedKey: 0 });
  assert.equal(ctx.rasters, 1);

  painter.draw({
    lightness: quantum + 0.25 / LIGHTNESS_STEPS, state: STATE, activeKey: null, selectedKey: 0,
  });
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
  assert.equal(widths.length, 4);
  assert.equal(widths[2], widths[3], 'keys B and C are the highlighted pair');
  assert.ok(widths[2] > widths[1], 'a highlighted marker is wider than key A');
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
  assert.equal(widths.length, 3);
  assert.ok(widths[2] > widths[1], 'no marker is left unhighlighted by a stale selection');
});

test('the wheel caps display density at two and caches the resized raster', (t) => {
  withPixelRatio(t, 3);
  const { painter, canvas, ctx } = wheelSetup(256);
  canvas.clientWidth = 136;
  canvas.clientHeight = 136;
  const view = { lightness: 0.62, state: STATE, activeKey: null, selectedKey: 0 };
  const first = painter.draw(view);
  assert.equal(canvas.width, 272);
  assert.equal(canvas.height, 272);
  assert.equal(first.scale, 272 / 256);
  assert.deepEqual(ctx.ops.find(([name]) => name === 'setTransform'),
    ['setTransform', 272 / 256, 0, 0, 272 / 256, 0, 0]);
  painter.draw({ ...view, selectedKey: 1 });
  assert.equal(ctx.rasters, 1);
  canvas.clientWidth = canvas.clientHeight = 160;
  painter.draw(view);
  assert.equal(canvas.width, 320);
  assert.equal(ctx.rasters, 2);
});

test('oklchLinearRgb fills a caller-owned triple in place', () => {
  const out = [9, 9, 9];
  const returned = oklchLinearRgb(0.62, 0.1, 0.25, out);

  assert.equal(returned, out, 'the caller-owned array is what comes back');
  assert.deepEqual(out, oklchLinearRgb(0.62, 0.1, 0.25),
    'filling in place must not change the conversion');
});

test('gamut chroma scale finds the widest OKLCH hue boundary', () => {
  const maximum = maxSrgbGamutChroma(0.5);
  const hueSamples = 360;
  let widestSample = 0;
  let beyondBoundarySample = 0;

  for (let hue = 0; hue < hueSamples; hue++) {
    const rgb = oklchLinearRgb(0.5, maximum, hue / hueSamples);
    if (rgb.every((channel) => channel >= -0.0002 && channel <= 1.0002))
      widestSample++;
    const beyondRgb = oklchLinearRgb(0.5, maximum + 0.002, hue / hueSamples);
    if (beyondRgb.every((channel) => channel >= 0 && channel <= 1))
      beyondBoundarySample++;
  }

  assert.ok(maximum > 0.28 && maximum < 0.31);
  assert.ok(widestSample > 0);
  assert.equal(beyondBoundarySample, 0);
});
