import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createColorStripPainter, drawWaveGraph, drawRecipeDiagnostics,
} from '../tools/palette_canvas.js';
import { waveGraphBand } from '../tools/palette_math.js';
import { linearToSrgbFloat } from '../tools/color.js';

/**
 * Recording stand-in for a CanvasRenderingContext2D. Every drawing call lands in
 * `ops` in order, and every state assignment is a plain property, so a test can
 * assert both what was drawn and the state it was drawn under.
 * @returns {Object} The context double.
 */
function fakeContext() {
  const ops = [];
  return {
    ops,
    canvasFor: null,
    clearRect: (...a) => ops.push(['clearRect', ...a]),
    fillRect: (...a) => ops.push(['fillRect', ...a]),
    strokeRect: (...a) => ops.push(['strokeRect', ...a]),
    beginPath: () => ops.push(['beginPath']),
    moveTo: (...a) => ops.push(['moveTo', ...a]),
    lineTo: (...a) => ops.push(['lineTo', ...a]),
    stroke: function stroke() { ops.push(['stroke', this.strokeStyle, this.lineWidth]); },
    setLineDash: (a) => ops.push(['setLineDash', a.join(',')]),
    drawImage: (image, x, y) => ops.push(['drawImage', image, x, y]),
    createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: function putImageData(image) { this.painted = image; },
    fillText: (...a) => ops.push(['fillText', ...a]),
  };
}

/**
 * Document double whose createElement('canvas') yields an offscreen canvas
 * carrying its own recording context.
 * @returns {{doc: Object, created: Array<Object>}} The document and the canvases it made.
 */
function fakeDoc() {
  const created = [];
  const doc = {
    createElement(tag) {
      assert.equal(tag, 'canvas', 'the strip cache is an offscreen canvas');
      const ctx = fakeContext();
      const canvas = { width: 0, height: 0, ctx, getContext: () => ctx };
      created.push(canvas);
      return canvas;
    },
  };
  return { doc, created };
}

/**
 * Palette double counting the samples each painter takes.
 * @returns {Object} The palette, with `getCalls` and `channelCalls` tallies.
 */
function fakePalette() {
  return {
    getCalls: 0,
    channelCalls: 0,
    get(t) { this.getCalls++; return [t, t * 0.5, 1 - t]; },
    getChannelValues(t) { this.channelCalls++; return [t, 1 - t, 2 * t - 0.5]; },
  };
}

/**
 * A strip painter over a fresh canvas.
 * @param {number} [width] - Canvas width.
 * @param {number} [height] - Canvas height.
 * @returns {Object} The painter plus the doubles it draws through.
 */
function stripSetup(width = 8, height = 4) {
  const canvas = { width, height };
  const ctx = fakeContext();
  const { doc, created } = fakeDoc();
  const palette = fakePalette();
  const painter = createColorStripPainter({ canvas, ctx, doc });
  return { painter, canvas, ctx, doc, created, palette };
}

const opNames = (ctx) => ctx.ops.map(([name]) => name);

test('the strip bakes its gradient once and reuses it for later frames', () => {
  const { painter, palette, created } = stripSetup(8, 4);
  painter.draw(palette, 0);
  assert.equal(created.length, 1, 'one offscreen cache canvas');
  assert.equal(palette.getCalls, 8, 'the gradient samples one color per column');

  painter.draw(palette, 0.5);
  painter.draw(palette, 0.75);
  assert.equal(palette.getCalls, 8, 'a marker sweep must not re-evaluate the palette');
  assert.equal(created.length, 1, 'the cache canvas is reused');
});

test('invalidate forces the next draw to re-evaluate the palette', () => {
  const { painter, palette, created } = stripSetup(8, 4);
  painter.draw(palette, 0);
  painter.invalidate();
  painter.draw(palette, 0);
  assert.equal(palette.getCalls, 16, 'the palette changed, so the gradient must be rebuilt');
  assert.equal(created.length, 1, 'an unchanged size reuses the cache canvas');
});

test('a canvas resize rebuilds the cache without an explicit invalidate', () => {
  const { painter, canvas, palette, created } = stripSetup(8, 4);
  painter.draw(palette, 0);
  canvas.width = 16;
  painter.draw(palette, 0);
  assert.equal(created.length, 2, 'a stale-size cache would blit at the wrong scale');
  assert.deepEqual([created[1].width, created[1].height], [16, 4]);
  assert.equal(palette.getCalls, 8 + 16);
});

test('the baked gradient carries the sRGB-encoded palette, opaque, on every row', () => {
  const { painter, palette, created } = stripSetup(4, 2);
  painter.draw(palette, 0);
  const { data } = created[0].ctx.painted;

  const width = 4;
  for (let x = 0; x < width; x++) {
    const t = x / (width - 1);
    const expected = [t, t * 0.5, 1 - t]
      .map((v) => Math.round(linearToSrgbFloat(Math.max(0, Math.min(1, v))) * 255));
    for (let y = 0; y < 2; y++) {
      const i = (y * width + x) * 4;
      assert.deepEqual([data[i], data[i + 1], data[i + 2]], expected,
        `column ${x} row ${y} is not the sRGB-encoded palette color`);
      assert.equal(data[i + 3], 255, 'the strip must be opaque');
    }
  }
});

test('the marker lands on the column the phase names and leaves no shadow behind', () => {
  const { painter, ctx, palette, created } = stripSetup(9, 4);
  painter.draw(palette, 0.5);

  assert.deepEqual(ctx.ops[0], ['drawImage', created[0], 0, 0],
    'the cached gradient must be blitted first — it also clears the last marker');
  assert.ok(ctx.ops.some(([n, x]) => n === 'moveTo' && x === 4),
    'the marker must sit at round(t * (width - 1))');
  assert.ok(ctx.ops.some(([n, x, y]) => n === 'lineTo' && x === 4 && y === 4));
  assert.equal(ctx.shadowBlur, 0, 'a left-on shadow would blur the next overlay');

  ctx.ops.length = 0;
  painter.draw(palette, 1);
  assert.ok(ctx.ops.some(([n, x]) => n === 'moveTo' && x === 8), 'phase 1 marks the last column');
});

test('the strip samples and locates its marker within the visible phase window', () => {
  const { painter, ctx, palette, created } = stripSetup(5, 2);
  painter.draw(palette, 0.4, null, { start: 0.2, end: 0.6 });

  const { data } = created[0].ctx.painted;
  const red = (column) => data[column * 4];
  assert.equal(red(0), Math.round(linearToSrgbFloat(0.2) * 255));
  assert.equal(red(4), Math.round(linearToSrgbFloat(0.6) * 255));
  assert.ok(ctx.ops.some(([name, x]) => name === 'moveTo' && x === 2),
    'phase 0.4 is centered in the 0.2..0.6 viewport');
});

test('changing the visible phase window rebuilds the strip cache', () => {
  const { painter, palette } = stripSetup(8, 4);
  painter.draw(palette, 0.5);
  painter.draw(palette, 0.5, null, { start: 0.25, end: 0.75 });
  assert.equal(palette.getCalls, 16);
});

test('a selection overlay is drawn only when one is passed, in either drag direction', () => {
  const { painter, ctx, palette } = stripSetup(10, 4);
  painter.draw(palette, 0.2);
  assert.ok(!opNames(ctx).includes('fillRect'), 'no selection means no overlay');

  ctx.ops.length = 0;
  painter.draw(palette, 0.2, { start: 0.2, end: 0.7 });
  const forward = ctx.ops.filter(([n]) => n === 'fillRect' || n === 'strokeRect');
  assert.deepEqual(forward, [['fillRect', 2, 0, 5, 4], ['strokeRect', 2, 0, 5, 4]]);

  ctx.ops.length = 0;
  painter.draw(palette, 0.2, { start: 0.7, end: 0.2 });
  const backward = ctx.ops.filter(([n]) => n === 'fillRect' || n === 'strokeRect');
  assert.deepEqual(backward, forward, 'a backwards drag must select the same span');
});

test('the wave graph samples every column once for all three channels', () => {
  const canvas = { width: 32, height: 100 };
  const ctx = fakeContext();
  const palette = fakePalette();
  drawWaveGraph({ canvas, ctx, palette });
  assert.equal(palette.channelCalls, 32,
    'one getChannelValues per column — a per-channel pass would triple the LUT work');
  assert.equal(palette.getCalls, 0, 'the graph plots channel values, not colors');
});

test('the wave graph fits its backing buffer to the displayed size and pixel density', () => {
  const canvas = { width: 1024, height: 300, clientWidth: 400, clientHeight: 120 };
  const ctx = fakeContext();
  ctx.setTransform = (...args) => ctx.ops.push(['setTransform', ...args]);
  const palette = fakePalette();
  const originalPixelRatio = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 2;

  try {
    drawWaveGraph({ canvas, ctx, palette });
  } finally {
    if (originalPixelRatio === undefined) delete globalThis.devicePixelRatio;
    else globalThis.devicePixelRatio = originalPixelRatio;
  }

  assert.deepEqual([canvas.width, canvas.height], [800, 240]);
  assert.deepEqual(ctx.ops[0], ['setTransform', 2, 0, 0, 2, 0, 0]);
  assert.deepEqual(ctx.ops[1], ['clearRect', 0, 0, 400, 120]);
  assert.equal(palette.channelCalls, 400);
});

test('the wave graph draws the band edges, the three channels and the clamp overlays', () => {
  const canvas = { width: 16, height: 100 };
  const ctx = fakeContext();
  drawWaveGraph({ canvas, ctx, palette: fakePalette() });

  const { yTop, yBottom, toY } = waveGraphBand(100);
  assert.deepEqual(ctx.ops[0], ['clearRect', 0, 0, 16, 100]);

  const moves = ctx.ops.filter(([n]) => n === 'moveTo').map(([, x, y]) => [x, y]);
  assert.ok(moves.some(([x, y]) => x === 0 && y === yTop), 'the value band top edge is missing');
  assert.ok(moves.some(([x, y]) => x === 0 && y === yBottom), 'the value band bottom edge is missing');
  assert.ok(moves.some(([x, y]) => x === 0 && y === 50), 'the 0.5 reference line is missing');

  const strokes = ctx.ops.filter(([n]) => n === 'stroke').map(([, style, w]) => [style, w]);
  assert.deepEqual(strokes.slice(-3),
    [['#EF4444', 3], ['#22C55E', 3], ['#3B82F6', 3]],
    'the three channel curves must be stroked in R, G, B order');

  const fills = ctx.ops.filter(([n]) => n === 'fillRect');
  assert.deepEqual(fills[0], ['fillRect', 0, 0, 16, 100], 'the graph background');
  assert.deepEqual(fills.slice(1), [
    ['fillRect', 0, toY(0), 16, yBottom - toY(0)],
    ['fillRect', 0, yTop, 16, toY(1) - yTop],
  ], 'the below-0 and above-1 clamp bands');
});

test('the wave graph plots each channel through the shared value-to-y map', () => {
  const canvas = { width: 4, height: 100 };
  const ctx = fakeContext();
  const palette = fakePalette();
  drawWaveGraph({ canvas, ctx, palette });

  const { toY } = waveGraphBand(100);
  // The red curve is the first channel path: its moveTo opens the run of lineTo
  // that follows, one per remaining column.
  const redStart = ctx.ops.findIndex(([n, x, y]) => n === 'moveTo' && x === 0 && y === toY(0));
  assert.ok(redStart > 0, 'the red curve must start at column 0');
  const redPath = ctx.ops.slice(redStart + 1, redStart + 4).map(([n, x, y]) => [n, x, y]);
  assert.deepEqual(redPath, [
    ['lineTo', 1, toY(1 / 3)],
    ['lineTo', 2, toY(2 / 3)],
    ['lineTo', 3, toY(1)],
  ]);
});

test('the dashed reference line is reset so the channel curves stay solid', () => {
  const ctx = fakeContext();
  drawWaveGraph({ canvas: { width: 8, height: 100 }, ctx, palette: fakePalette() });
  const dashes = ctx.ops.filter(([n]) => n === 'setLineDash').map(([, a]) => a);
  assert.deepEqual(dashes, ['5,5', ''], 'a left-on dash would break the three curves');
});

test('neither painter touches a canvas it has no context for', () => {
  const painter = createColorStripPainter({ canvas: { width: 8, height: 4 }, ctx: null, doc: fakeDoc().doc });
  const palette = fakePalette();
  painter.draw(palette, 0.5);
  assert.equal(palette.getCalls, 0);

  drawWaveGraph({ canvas: { width: 8, height: 4 }, ctx: null, palette });
  assert.equal(palette.channelCalls, 0);
});

test('recipe diagnostics plot color, perceptual axes, and fallback samples', () => {
  const canvas = { width: 4, height: 100 };
  const ctx = fakeContext();
  const palette = {
    diagnosticAt(t) {
      return {
        L: t, C: t * 0.2, q: 1 - t, Cmax: 0.25,
        fallbackMapped: t > 0.5,
      };
    },
    getChannelValues(t) { return [t, 0.5, 1 - t]; },
  };

  drawRecipeDiagnostics({ canvas, ctx, palette });

  assert.deepEqual(ctx.ops[0], ['clearRect', 0, 0, 4, 100]);
  assert.equal(ctx.ops.filter(([name]) => name === 'stroke').length, 9);
  assert.ok(!ctx.ops.some(([name]) => name === 'fillText'));
});
