// @ts-nocheck
//
// segment_worker — unit coverage for the Web Worker's DOM-free, mostly-pure
// glue: the per-segment clip application, the quadrant row-extraction copy, the
// arena-metrics marshalling (including the throw path), the setResolution gate
// (a rejected resolution must leave geometry/clip untouched), and the serialized
// message queue's failure isolation + rethrow.
//
// Driven by a fake `self` (postMessage captured, onmessage invoked by hand) and
// a mocked ./holosphere_wasm.js so the real WASM module is never loaded in Node.
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Fakes — installed BEFORE importing the worker, which binds self.postMessage
// and assigns self.onmessage at module-evaluation time.
// ---------------------------------------------------------------------------

// Stable postMessage sink. The worker binds `self.postMessage` once at import,
// so the function reference must never change — it forwards into this mutable
// array, which tests clear in beforeEach.
const posted = [];
/** @type {{ postMessage: Function, onmessage: ?Function }} */
const fakeSelf = {
  postMessage(msg, transfer) { posted.push({ msg, transfer }); },
  onmessage: null,
};
globalThis.self = fakeSelf;

/**
 * Stand-in for the WASM HolosphereEngine. Records the method calls the worker
 * makes and synthesizes a deterministic pixel buffer so extraction is
 * verifiable. setResolution only adopts a new size when `resolutionOk` is true,
 * mirroring the real factory's "can't build that size" failure.
 */
class FakeEngine {
  constructor() {
    this.curW = 0;
    this.curH = 0;
    this.resolutionOk = true;
    this.clip = null;
    this.effect = null;
    this.params = [];
    this.paused = false;
    this.metricsThrows = false;
    this.calls = [];
  }
  setResolution(w, h) {
    this.calls.push(['setResolution', w, h]);
    if (!this.resolutionOk) return false;
    this.curW = w;
    this.curH = h;
    return true;
  }
  // Model the real engine's setEffect: it rebuilds the effect with DEFAULT
  // params, so any tuned values must be (re-)applied AFTER it. Clearing params
  // here makes that ordering observable — a handler that applied params before
  // setEffect would have them wiped by this rebuild.
  setEffect(name) { this.calls.push(['setEffect', name]); this.effect = name; this.params = []; }
  setParameter(name, value) { this.params.push([name, value]); }
  setAnimationsPaused(p) { this.paused = p; }
  setClip(x0, x1, y0, y1) { this.clip = { y0, y1, x0, x1 }; }
  drawFrame() { this.calls.push(['drawFrame']); }
  getRenderUs() { return 1234; }
  /** Each channel encodes its flat canvas index so extraction can be checked. */
  getPixels() {
    const buf = new Uint16Array(this.curW * this.curH * 3);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) & 0xffff;
    return buf;
  }
  getArenaMetrics() {
    if (this.metricsThrows) throw new Error('binding gone');
    const arena = (u, hw, c) => ({ usage: u, high_water_mark: hw, capacity: c });
    return {
      scratch_arena_a: arena(1, 2, 3),
      scratch_arena_b: arena(4, 5, 6),
      persistent_arena: arena(7, 8, 9),
    };
  }
}

/** The single engine the mocked factory hands back, so tests can configure it. */
let engineInstance = null;
mock.module('../holosphere_wasm.js', {
  defaultExport: async () => ({
    HolosphereEngine: class {
      constructor() {
        engineInstance = new FakeEngine();
        return engineInstance;
      }
    },
  }),
});

// performance.now is a Node global; the worker only needs it to return a number.
await import('../segment_worker.js');

/**
 * Deliver one protocol message through the worker's serialized queue and wait
 * for it (and any rethrow task) to settle. Uses setImmediate so a stubbed
 * setTimeout in the rethrow test cannot stall draining.
 * @param {Object} msg - Protocol message to deliver.
 * @returns {Promise<void>}
 */
async function dispatch(msg) {
  fakeSelf.onmessage({ data: msg });
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

beforeEach(() => {
  posted.length = 0;
  engineInstance = null;
});

/** init builds the segRange, drives the engine setup in order, and posts ready. */
test('init applies the segment clip and posts ready', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });

  assert.ok(engineInstance, 'engine constructed');
  // setResolution(8,4) then setEffect, with the clip applied last.
  assert.deepEqual(engineInstance.calls[0], ['setResolution', 8, 4]);
  assert.equal(engineInstance.effect, 'Plasma');
  // segId 3 of 4 over 8x4 → arm B (x0=4), bottom band (y0=2): clip {2,4,4,8}.
  assert.deepEqual(engineInstance.clip, { y0: 2, y1: 4, x0: 4, x1: 8 });

  const ready = posted.find((p) => p.msg.type === 'ready');
  assert.ok(ready, 'ready posted');
  assert.equal(ready.msg.segId, 3);
});

/** render copies exactly this segment's quadrant rows out of the full buffer. */
test('render extracts only this segment quadrant from the canvas buffer', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'render' });

  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  // Quadrant is the bottom-right 4x2 block: x in [4,8), y in [2,4).
  assert.deepEqual([frame.x0, frame.x1, frame.y0, frame.y1], [4, 8, 2, 4]);
  assert.deepEqual([frame.quadW, frame.quadH], [4, 2]);

  // Rebuild the source buffer (same encoding as FakeEngine.getPixels) and verify
  // every extracted pixel maps back to its full-canvas source pixel.
  const W = 8;
  const src = new Uint16Array(W * 4 * 3);
  for (let i = 0; i < src.length; i++) src[i] = (i * 7) & 0xffff;
  for (let ry = 0; ry < 2; ry++) {
    for (let rx = 0; rx < 4; rx++) {
      for (let c = 0; c < 3; c++) {
        const dst = (ry * 4 + rx) * 3 + c;
        const sx = 4 + rx;
        const sy = 2 + ry;
        const s = (sy * W + sx) * 3 + c;
        assert.equal(frame.pixels[dst], src[s], `pixel (${rx},${ry}) ch${c}`);
      }
    }
  }
});

/** Arena metrics are marshalled into a plain, transfer-safe object. */
test('render marshals arena metrics into a plain object', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'render' });

  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  assert.deepEqual(frame.arenaMetrics, {
    scratch_arena_a: { usage: 1, high_water_mark: 2, capacity: 3 },
    scratch_arena_b: { usage: 4, high_water_mark: 5, capacity: 6 },
    persistent_arena: { usage: 7, high_water_mark: 8, capacity: 9 },
  });
  assert.equal(frame.renderUs, 1234);
});

/** A failing getArenaMetrics is surfaced as null without dropping the frame. */
test('render still posts a frame when getArenaMetrics throws', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  engineInstance.metricsThrows = true;
  posted.length = 0;
  const warn = mock.method(console, 'warn', () => {}); // silence the diagnostic
  await dispatch({ type: 'render' });
  warn.mock.restore();

  const frame = posted.find((p) => p.msg.type === 'frame');
  assert.ok(frame, 'frame still posted');
  assert.equal(frame.msg.arenaMetrics, null);
});

/**
 * Regression: setResolution returning false must leave the worker's geometry and
 * clip untouched, so it keeps extracting the old-size quadrant.
 */
test('a rejected setResolution leaves segRange and clip untouched', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });
  const clipBefore = { ...engineInstance.clip };

  engineInstance.resolutionOk = false;
  await dispatch({ type: 'setResolution', w: 16, h: 8 });
  // The engine was asked, refused, and the clip was not rewritten.
  assert.deepEqual(engineInstance.calls.find((c) => c[0] === 'setResolution' && c[1] === 16),
    ['setResolution', 16, 8]);
  assert.deepEqual(engineInstance.clip, clipBefore);

  // A render still uses the old 8x4 geometry.
  posted.length = 0;
  await dispatch({ type: 'render' });
  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  assert.deepEqual([frame.x0, frame.x1, frame.y0, frame.y1], [4, 8, 2, 4]);
});

/** A successful setResolution recomputes the segRange and re-applies the clip. */
test('an accepted setResolution recomputes segRange and clip', async () => {
  await dispatch({ type: 'init', segId: 3, totalSegs: 4, w: 8, h: 4, effectName: 'Plasma' });
  await dispatch({ type: 'setResolution', w: 16, h: 8 });
  // segId 3 of 4 over 16x8 → arm B (x0=8), bottom band (y0=4): clip {4,8,8,16}.
  assert.deepEqual(engineInstance.clip, { y0: 4, y1: 8, x0: 8, x1: 16 });

  posted.length = 0;
  await dispatch({ type: 'render' });
  const frame = posted.find((p) => p.msg.type === 'frame').msg;
  assert.deepEqual([frame.x0, frame.x1, frame.y0, frame.y1], [8, 16, 4, 8]);
});

/**
 * The serialized queue must isolate a failure (later messages still run) and
 * rethrow it on a fresh task so it reaches the worker's global error handler
 * rather than vanishing as an unhandled rejection.
 */
test('a throwing message is isolated and rethrown on a fresh task', async () => {
  const captured = [];
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { captured.push(fn); return 0; };
  try {
    // An odd totalSegs makes computeSegmentRange throw inside handleMessage.
    await dispatch({ type: 'init', segId: 0, totalSegs: 3, w: 8, h: 4 });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(captured.length, 1, 'one rethrow task scheduled');
  assert.throws(() => captured[0](), /positive even number/);

  // The chain is not wedged: a following valid init still completes.
  posted.length = 0;
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  assert.ok(posted.find((p) => p.msg.type === 'ready'), 'queue still processes after a failure');
});

// ---------------------------------------------------------------------------
// Live-tuning handlers — setEffect / setParameter / setAnimationsPaused. These
// are the receiver half of the controller's broadcasts: a worker that re-applied
// params before (instead of after) setEffect's rebuild-to-defaults, or dropped a
// handler, would render a different effect/params than the main thread. The
// FakeEngine.setEffect above clears params to model that rebuild, so the
// "params AFTER rebuild" ordering is directly observable below.
// ---------------------------------------------------------------------------

test('init applies the carried params AFTER setEffect rebuilds to defaults', async () => {
  await dispatch({
    type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma',
    params: [{ name: 'Speed', value: 0.5 }, { name: 'Glow', value: 1.0 }],
  });
  assert.equal(engineInstance.effect, 'Plasma');
  // The params survived the rebuild-to-defaults, so they were applied after it.
  assert.deepEqual(engineInstance.params, [['Speed', 0.5], ['Glow', 1.0]]);
});

test('setEffect handler rebuilds, then re-applies the carried param snapshot', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({
    type: 'setEffect', name: 'Waves',
    params: [{ name: 'Freq', value: 0.25 }],
  });
  assert.equal(engineInstance.effect, 'Waves', 'switched to the new effect');
  // Applied AFTER the rebuild-to-defaults; a before-rebuild apply would be wiped.
  assert.deepEqual(engineInstance.params, [['Freq', 0.25]]);
  assert.ok(posted.find((p) => p.msg.type === 'effectReady'), 'effectReady posted');
});

test('setEffect with no params just rebuilds, leaving defaults', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  posted.length = 0;
  await dispatch({ type: 'setEffect', name: 'Waves' });
  assert.equal(engineInstance.effect, 'Waves');
  assert.deepEqual(engineInstance.params, [], 'no snapshot to re-apply');
  assert.ok(posted.find((p) => p.msg.type === 'effectReady'));
});

test('setParameter handler forwards name/value to the engine', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  await dispatch({ type: 'setParameter', name: 'Speed', value: 0.9 });
  assert.deepEqual(engineInstance.params.at(-1), ['Speed', 0.9]);
});

test('setAnimationsPaused handler forwards the flag (both directions) to the engine', async () => {
  await dispatch({ type: 'init', segId: 0, totalSegs: 2, w: 8, h: 4, effectName: 'Plasma' });
  await dispatch({ type: 'setAnimationsPaused', paused: true });
  assert.equal(engineInstance.paused, true);
  await dispatch({ type: 'setAnimationsPaused', paused: false });
  assert.equal(engineInstance.paused, false);
});
