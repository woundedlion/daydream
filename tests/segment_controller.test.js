// @ts-nocheck
//
// SegmentController — unit coverage for the simulator's highest-risk, mostly
// DOM-free glue (review #8): the generation-fence drop, the worker-fault
// deadlock-break latch, and the quadrant compositor. Driven by a fake Worker
// (postMessage captured; onmessage/onerror invoked by hand) and a mocked
// ./driver.js (so the real three.js/lil-gui chain is never loaded in Node).
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mutable stand-in for the driver module's Daydream/ SLOW_FRAME_MS exports.
const Daydream = { W: 0, H: 0, pixels: null };
mock.module('../driver.js', {
  namedExports: { Daydream, SLOW_FRAME_MS: 50 },
});

const { SegmentController } = await import('../segment_controller.js');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWorker {
  static instances = [];
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.posted = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    FakeWorker.instances.push(this);
  }
  postMessage(msg) { this.posted.push(msg); }
  terminate() { this.terminated = true; }
}

/** Build a controller wired to fake injected host deps. */
function makeController({ resolution = 'lo', effect = 'TestEffect',
                         presets = { lo: { w: 4, h: 4 } } } = {}) {
  const state = { resolution, effect };
  return new SegmentController({
    resolutionPresets: presets,
    appState: { get: (k) => state[k], set: (k, v) => { state[k] = v; } },
    getWasmEngine: () => null,           // skip the initial-param snapshot
    refreshPixelView: () => {},
    getMemoryView: () => Daydream.pixels, // aliased to the cleared buffer
  });
}

beforeEach(() => { FakeWorker.instances = []; });
globalThis.Worker = FakeWorker;

/** Deliver a worker->controller 'frame' message to segment `segId`. */
function deliverFrame(controller, segId, overrides = {}) {
  const quadW = overrides.quadW ?? 2;
  const quadH = overrides.quadH ?? 2;
  const px = overrides.pixels ?? new Uint16Array(quadW * quadH * 3);
  controller.workers[segId].onmessage({
    data: {
      type: 'frame', segId,
      pixels: px.buffer,
      x0: overrides.x0 ?? 0, x1: overrides.x1 ?? quadW,
      y0: overrides.y0 ?? 0, y1: overrides.y1 ?? quadH,
      quadW, quadH,
      elapsed: overrides.elapsed ?? 1,
      renderUs: overrides.renderUs ?? 0,
      arenaMetrics: overrides.arenaMetrics ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Generation fence
// ---------------------------------------------------------------------------

test('frame at the current generation is stored and settles the frame', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel(); // pending=2, inflightGen=renderGen=0
  assert.equal(c.pending, 2);

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  assert.ok(c.results[0], 'matching-generation frame is kept');
  assert.equal(c.results[0].x1, 2);
  assert.equal(c.pending, 1);

  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
  assert.equal(c.pending, 0);
  await done; // frameResolve fired
});

test('a frame dispatched before a resolution change is dropped but still settles', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel(); // inflightGen = 0

  c.setResolution(8, 8); // renderGen -> 1, results cleared, pendingFrame=false
  assert.notEqual(c.inflightGen, c.renderGen);

  deliverFrame(c, 0); // stale generation
  assert.equal(c.results[0], null, 'stale-generation result is discarded');
  assert.equal(c.pending, 1, 'but pending still decremented');

  deliverFrame(c, 1);
  assert.equal(c.results[1], null);
  assert.equal(c.pending, 0);
  await done; // promise resolves even though every result was dropped
});

// ---------------------------------------------------------------------------
// Fault latch (deadlock break)
// ---------------------------------------------------------------------------

test('a worker fault latches, zeroes pending, and resolves the in-flight frame', async () => {
  const c = makeController();
  c.create(2);
  c.renderInFlight = true;
  const done = c.renderParallel(); // pending=2, frameResolve set

  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 2 });

  assert.equal(c.faulted, true);
  assert.deepEqual(c.faultInfo, { segId: 0, message: 'boom' });
  assert.equal(c.pending, 0, 'pending zeroed so the loop cannot deadlock');
  assert.equal(c.renderInFlight, false);
  assert.equal(c.frameResolve, null);
  await done; // the latch settled the promise
});

test('only the first fault of a session is recorded', () => {
  const c = makeController();
  c.create(2);
  c.workers[0].onerror({ message: 'first', filename: '', lineno: 0, colno: 0 });
  c.workers[1].onerror({ message: 'second', filename: '', lineno: 0, colno: 0 });
  assert.deepEqual(c.faultInfo, { segId: 0, message: 'first' });
});

test('destroy() clears the fault latch so a fresh pool can recover', () => {
  const c = makeController();
  c.create(1);
  c.workers[0].onerror({ message: 'x', filename: '', lineno: 0, colno: 0 });
  assert.equal(c.faulted, true);
  c.destroy();
  assert.equal(c.faulted, false);
  assert.equal(c.faultInfo, null);
});

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

/** Index of (x,y) channel 0 in a W*H*3 RGB16 buffer. */
const idx = (x, y, w) => (y * w + x) * 3;

test('composite() blits each quadrant to its display-buffer offset', () => {
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3); // pre-cleared background

  const c = makeController();
  c.showBoundaries = false;
  // Right-half quadrant x[2,4) y[0,2): fill with a recognizable value.
  const quad = new Uint16Array(2 * 2 * 3).fill(111);
  c.results = [{ pixels: quad, x0: 2, x1: 4, y0: 0, y1: 2, quadW: 2, quadH: 2 }];

  c.composite();

  // Blitted region carries the value...
  assert.equal(Daydream.pixels[idx(2, 0, 4)], 111);
  assert.equal(Daydream.pixels[idx(3, 1, 4)], 111);
  // ...and the untouched left half stays cleared.
  assert.equal(Daydream.pixels[idx(0, 0, 4)], 0);
  assert.equal(Daydream.pixels[idx(1, 1, 4)], 0);
});

test('composite() skips a rectangle that overflows the current display buffer', () => {
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(222);
  // x1 = 99 overshoots W=4 (e.g. a stale-resolution rect the fence missed).
  c.results = [{ pixels: quad, x0: 0, x1: 99, y0: 0, y1: 2, quadW: 2, quadH: 2 }];

  c.composite();
  assert.ok(Daydream.pixels.every((v) => v === 0),
    'out-of-bounds rect is never partially blitted');
});

test('composite() throws if the display-buffer alias is broken', () => {
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  // getMemoryView now returns a DIFFERENT buffer than Daydream.pixels.
  c._getMemoryView = () => new Uint16Array(4 * 2 * 3);
  c.results = [];

  assert.throws(() => c.composite(), /alias broken/);
});
