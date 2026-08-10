//
// The segmented POV path's central claim, run end to end against the real
// shipped WASM module: N clipped segment renders, stitched, are the frame one
// unclipped engine draws.
//
// segment_worker.test.js drives the worker protocol against a FakeEngine whose
// pixels are a ramp — identical under every clip, so it can only check that the
// right rectangle was copied. segment_controller.test.js composites frames it
// was handed. Neither runs a clip through the rasterizer. Here each segment gets
// its own WASM instance, as each worker does, driven through the same message
// sequence: setResolution, setEffect, setClip, then the renders. Workers agree
// only because they reach the same effect-load count on the same message
// sequence, which is what makes the stitch meaningful and is checked below.
//
// Run: node --test --experimental-test-module-mocks "tests/segment_composite_wasm.test.js"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import createHolosphereModule from '../holosphere_wasm.js';
import {
  computeSegmentRange, extractSegment, compositeSegment,
} from '../segment_layout.js';

// The smaller of the two shipped presets: every instance below is a whole WASM
// module with its own arena, so the canvas is kept cheap.
const W = 96, H = 20;
const FULL = { x0: 0, x1: W, y0: 0, y1: H, w: W, h: H };
// Enough renders that an effect's per-frame state has moved off its seed.
const FRAMES = 3;
// Non-stateful: its filter pipeline does not cross segment bands, so the clip
// narrows and the segment renders are genuinely partial.
const CLIPPED_EFFECT = 'DisplacementField';
// Cross-segment stateful: setClip keeps the full canvas, so each worker draws
// the whole frame and slices its rectangle out of the readback.
const FULL_FRAME_EFFECT = 'MeshFeedback';

/**
 * The name an embind enum value carries. Each module instance owns its own enum
 * objects, so a caller comparing results across instances needs the name; the
 * members sit beside embind's own plumbing properties, so they are picked out
 * by instanceof.
 * @param {Function} type - The enum constructor, e.g. M.ClipSetResult.
 * @param {Object} value - A value the engine returned.
 * @returns {string} The member's name.
 */
function enumName(type, value) {
  const name = Object.keys(type)
    .filter((k) => type[k] instanceof type)
    .find((k) => type[k] === value);
  assert.ok(name, 'the engine returned a value outside its declared enum');
  return name;
}

/**
 * Builds one engine on its own module instance and drives it through the
 * worker's init sequence and FRAMES renders.
 * @param {string} effect - Effect name to install.
 * @param {{x0:number,x1:number,y0:number,y1:number}} rect - Clip to apply.
 * @param {number} frames - Renders to draw.
 * @returns {Promise<{clip: string, pixels: Uint16Array}>} The clip result's
 *   name and a detached copy of the full canvas readback.
 */
async function renderWith(effect, rect, frames) {
  const M = await createHolosphereModule({ print() {}, printErr() {} });
  const engine = new M.HolosphereEngine();
  const resolution = enumName(M.ResolutionSetResult, engine.setResolution(W, H));
  assert.ok(resolution === 'RESIZED' || resolution === 'ALREADY_ACTIVE',
    `${W}x${H} must be buildable, got ${resolution}`);
  assert.equal(enumName(M.EffectSetResult, engine.setEffect(effect)), 'INSTALLED',
    `${effect} must be a registered effect`);
  const clip = engine.setClip(rect.x0, rect.x1, rect.y0, rect.y1);
  for (let f = 0; f < frames; f++) engine.drawFrame();
  return {
    clip: enumName(M.ClipSetResult, clip),
    pixels: Uint16Array.from(engine.getPixels()),
  };
}

/**
 * Renders every segment of a `total`-way split on its own engine and stitches
 * the results, using the same extract/composite pair the worker and the
 * controller use across the postMessage boundary.
 * @param {string} effect - Effect name to install in every worker.
 * @param {number} total - Segment count.
 * @param {number} frames - Renders to draw.
 * @returns {Promise<{canvas: Uint16Array, clips: string[], compacts: Uint16Array[],
 *   rects: Array<Object>}>} The composited canvas and the per-segment pieces.
 */
async function compositeSegments(effect, total, frames) {
  const canvas = new Uint16Array(W * H * 3);
  const clips = [];
  const compacts = [];
  const rects = [];
  for (let id = 0; id < total; id++) {
    const rect = computeSegmentRange(id, total, W, H);
    const { clip, pixels } = await renderWith(effect, rect, frames);
    const compact = new Uint16Array(rect.w * rect.h * 3);
    extractSegment(pixels, compact, W, rect);
    compositeSegment(canvas, compact, W, rect);
    clips.push(clip);
    compacts.push(compact);
    rects.push(rect);
  }
  return { canvas, clips, compacts, rects };
}

/**
 * Index of the first differing component, or -1 when the two agree.
 * @param {Uint16Array} a - First buffer.
 * @param {Uint16Array} b - Second buffer.
 * @returns {number} Index of the first mismatch.
 */
function firstDifference(a, b) {
  assert.equal(a.length, b.length, 'buffers must be the same length to compare');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

// One unclipped reference frame, reused by the cases below: building a module
// per comparison is the expensive part here.
const reference = await renderWith(CLIPPED_EFFECT, FULL, FRAMES);

test('the reference frame is a real image, not a constant the stitch cannot fail', () => {
  assert.equal(reference.clip, 'APPLIED',
    `${CLIPPED_EFFECT} must accept a narrowing clip for this suite to mean anything`);
  assert.equal(reference.pixels.length, W * H * 3);
  assert.ok(new Set(reference.pixels).size > 1,
    'a uniform canvas would match any stitch of any rectangles');
});

test('four clipped segment renders stitch into the unclipped frame', async () => {
  const { canvas, clips, compacts, rects } = await compositeSegments(CLIPPED_EFFECT, 4, FRAMES);

  assert.deepEqual(clips, ['APPLIED', 'APPLIED', 'APPLIED', 'APPLIED'],
    'every band must narrow, or the workers are each drawing the whole canvas');
  const at = firstDifference(canvas, reference.pixels);
  assert.equal(at, -1, at < 0 ? '' : `component ${at}: `
    + `composited ${canvas[at]} vs full-frame ${reference.pixels[at]}`);

  // Teeth: the same pieces laid into the wrong rectangles must not match, or
  // the comparison above is satisfied by any permutation of the segments.
  const shuffled = new Uint16Array(W * H * 3);
  for (let id = 0; id < rects.length; id++) {
    compositeSegment(shuffled, compacts[(id + 1) % rects.length], W, rects[id]);
  }
  assert.notEqual(firstDifference(shuffled, reference.pixels), -1,
    'segments rotated between rectangles still matched the full frame');
});

test('the stitch holds at every device-backed segment count', async () => {
  for (const total of [2, 8]) {
    const { canvas, clips } = await compositeSegments(CLIPPED_EFFECT, total, FRAMES);
    assert.equal(clips.filter((c) => c === 'APPLIED').length, total,
      `every one of the ${total} bands must narrow`);
    const at = firstDifference(canvas, reference.pixels);
    assert.equal(at, -1, at < 0 ? '' : `${total} segments differ at component ${at}: `
      + `composited ${canvas[at]} vs full-frame ${reference.pixels[at]}`);
  }
});

test('a cross-segment stateful effect keeps its full-frame clip and still stitches', async () => {
  const full = await renderWith(FULL_FRAME_EFFECT, FULL, FRAMES);
  assert.equal(full.clip, 'FULL_FRAME_KEPT',
    `${FULL_FRAME_EFFECT} must report its clip as kept at the full canvas`);
  assert.ok(new Set(full.pixels).size > 1, 'the reference frame must carry an image');

  const { canvas, clips } = await compositeSegments(FULL_FRAME_EFFECT, 4, FRAMES);
  assert.deepEqual(clips,
    ['FULL_FRAME_KEPT', 'FULL_FRAME_KEPT', 'FULL_FRAME_KEPT', 'FULL_FRAME_KEPT'],
    'a band-clipped worker would read stale history outside its band');
  const at = firstDifference(canvas, full.pixels);
  assert.equal(at, -1, at < 0 ? '' : `component ${at}: `
    + `composited ${canvas[at]} vs full-frame ${full.pixels[at]}`);
});

test('two engines on the same message sequence reach the same frame', async () => {
  // The RNG stream is reseeded per effect load, so workers agree only by
  // reaching the same load count. Nothing else pins that they do.
  const twin = await renderWith(CLIPPED_EFFECT, FULL, FRAMES);
  assert.equal(firstDifference(twin.pixels, reference.pixels), -1,
    'a second WASM instance drew a different frame from the same sequence');
});
