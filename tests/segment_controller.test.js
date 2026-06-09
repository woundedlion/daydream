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

// tick()'s composite/fault branches call updateStats(), which is pure DOM. Stub
// document so getElementById returns null — updateStats then early-returns,
// keeping the tick() state-machine tests DOM-free without exercising the overlay.
globalThis.document = { getElementById: () => null };

/** Drive a worker's 'ready' message; once all arrive the controller is ready. */
function deliverReady(controller, segId) {
  controller.workers[segId].onmessage({ data: { type: 'ready' } });
}

/** Build a controller with `n` workers all signalled ready. */
function readyController(n = 2, opts = {}) {
  const c = makeController(opts);
  c.create(n);
  for (let s = 0; s < n; s++) deliverReady(c, s);
  return c;
}

/** Let the renderParallel() promise's .then (pendingFrame/renderInFlight) run. */
const flush = () => new Promise((r) => setImmediate(r));

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

// ---------------------------------------------------------------------------
// tick() — the one-frame-deep render-loop state machine (review #16, the
// riskiest untested glue). Each tick (a) applies the previous frame's composite
// when one is pending, and (b) dispatches the next parallel render unless one is
// already in flight. The transitions below walk a full pipeline cycle plus the
// two guard states (not-ready, faulted).
// ---------------------------------------------------------------------------

test('tick() is a no-op until every worker has signalled ready', () => {
  const c = makeController();
  c.create(2);            // workers spawned but no 'ready' delivered yet
  assert.equal(c.ready, false);

  c.tick();

  assert.equal(c.renderInFlight, false, 'no render dispatched before ready');
  assert.equal(c.pending, 0);
  for (const w of c.workers)
    assert.ok(!w.posted.some((m) => m.type === 'render'),
      'no worker received a render message');
});

test('the first tick() once ready dispatches a parallel render', () => {
  const c = readyController(2);
  assert.equal(c.ready, true);

  c.tick();

  assert.equal(c.renderInFlight, true, 'render now in flight');
  assert.equal(c.pending, 2, 'one outstanding response per worker');
  assert.equal(c.pendingFrame, false, 'nothing to composite on the first tick');
  for (const w of c.workers)
    assert.ok(w.posted.some((m) => m.type === 'render'),
      'every worker was told to render');
});

test('a completed render arms pendingFrame and frees the in-flight slot', async () => {
  const c = readyController(2);
  c.tick();                       // dispatch frame N

  deliverFrame(c, 0);
  deliverFrame(c, 1);             // last response settles the promise
  await flush();                  // let renderParallel().then(...) run

  assert.equal(c.pending, 0);
  assert.equal(c.pendingFrame, true, 'results are waiting to be composited');
  assert.equal(c.renderInFlight, false, 'slot freed for the next dispatch');
});

test('the next tick() composites the armed frame and dispatches the following one', async () => {
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();                       // dispatch frame N

  // Frame N completes: seg 0 → left half, seg 1 → right half, each filled 111.
  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  assert.equal(c.pendingFrame, true);

  c.tick();                       // composite N, then dispatch N+1

  assert.equal(c.pendingFrame, false, 'pending frame was composited and cleared');
  assert.ok(Daydream.pixels.some((v) => v === 111),
    'the composited quadrants reached the display buffer');
  assert.equal(c.renderInFlight, true, 'the following frame was dispatched');
  assert.equal(c.pending, 2);
});

test('a faulted pool keeps tick() from dispatching another doomed render', () => {
  const c = readyController(2);
  c.tick();                       // frame in flight, pending = 2

  // Worker 0 traps: the latch zeroes pending and releases the in-flight slot.
  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.faulted, true);
  assert.equal(c.renderInFlight, false);

  const before = c.workers.map((w) => w.posted.length);
  c.tick();

  assert.equal(c.renderInFlight, false, 'faulted pool never re-dispatches');
  c.workers.forEach((w, i) =>
    assert.equal(w.posted.length, before[i], 'no new render broadcast'));
});
