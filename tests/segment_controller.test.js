// @ts-nocheck
//
// SegmentController — unit coverage for the simulator's highest-risk, mostly
// DOM-free glue: the generation-fence drop, the worker-fault deadlock-break
// latch, and the quadrant compositor. Driven by a fake Worker
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

/**
 * Stand-in for the Web Worker the controller spawns: captures postMessage
 * payloads and exposes onmessage/onerror so tests can drive the protocol by
 * hand. Every constructed instance is recorded in the static `instances` array.
 */
class FakeWorker {
  /** @type {Array<FakeWorker>} Every instance constructed since the last reset. */
  static instances = [];
  /**
   * @param {string} url - Worker script URL the controller requested.
   * @param {Object} opts - Worker options bag (e.g. `{ type: 'module' }`).
   */
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
  /**
   * Records a posted message instead of dispatching it to a real worker.
   * @param {Object} msg - Protocol message the controller sent.
   * @returns {void}
   */
  postMessage(msg) { this.posted.push(msg); }
  /**
   * Marks this fake worker as terminated.
   * @returns {void}
   */
  terminate() { this.terminated = true; }
}

/**
 * Build a controller wired to fake injected host deps.
 * @param {Object} [config] - Overrides for the controller's host environment.
 * @param {string} [config.resolution] - Initial app-state resolution key.
 * @param {string} [config.effect] - Initial app-state effect name.
 * @param {Object} [config.presets] - Resolution-preset map keyed by resolution name.
 * @returns {SegmentController} Controller wired to fake injected deps.
 */
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

/**
 * Drive a worker's 'ready' message; once all arrive the controller is ready.
 * @param {SegmentController} controller - Controller owning the worker pool.
 * @param {number} segId - Index of the worker to signal ready.
 * @returns {void}
 */
function deliverReady(controller, segId) {
  controller.workers[segId].onmessage({ data: { type: 'ready' } });
}

/**
 * Build a controller with `n` workers all signalled ready.
 * @param {number} [n] - Number of workers to create and mark ready.
 * @param {Object} [opts] - Options forwarded to makeController().
 * @returns {SegmentController} A ready controller with `n` workers.
 */
function readyController(n = 2, opts = {}) {
  const c = makeController(opts);
  c.create(n);
  for (let s = 0; s < n; s++) deliverReady(c, s);
  return c;
}

/**
 * Let the renderParallel() promise's .then (pendingFrame/renderInFlight) run.
 * @returns {Promise<void>} Resolves on the next macrotask tick.
 */
const flush = () => new Promise((r) => setImmediate(r));

/**
 * Deliver a worker->controller 'frame' message to segment `segId`.
 * @param {SegmentController} controller - Controller owning the worker pool.
 * @param {number} segId - Index of the worker delivering the frame.
 * @param {Object} [overrides] - Per-field overrides for the frame payload.
 * @param {number} [overrides.quadW] - Quadrant width in pixels.
 * @param {number} [overrides.quadH] - Quadrant height in pixels.
 * @param {Uint16Array} [overrides.pixels] - RGB16 quadrant pixel buffer.
 * @param {number} [overrides.x0] - Inclusive left display-buffer column.
 * @param {number} [overrides.x1] - Exclusive right display-buffer column.
 * @param {number} [overrides.y0] - Inclusive top display-buffer row.
 * @param {number} [overrides.y1] - Exclusive bottom display-buffer row.
 * @param {number} [overrides.elapsed] - Simulated elapsed time for the frame.
 * @param {number} [overrides.renderUs] - Reported render time in microseconds.
 * @param {Object} [overrides.arenaMetrics] - Optional arena-metrics payload.
 * @returns {void}
 */
function deliverFrame(controller, segId, overrides = {}) {
  const quadW = overrides.quadW ?? 2;
  const quadH = overrides.quadH ?? 2;
  const px = overrides.pixels ?? new Uint16Array(quadW * quadH * 3);
  controller.workers[segId].onmessage({
    data: {
      type: 'frame', segId,
      // The protocol delivers `pixels` as the Uint16Array view (worker_protocol
      // FrameMessage; the worker transfers its .buffer but the field is the
      // typed-array view), and composite() indexes it element-wise. Sending a
      // bare ArrayBuffer here would index to undefined->0 and blit a black quad.
      pixels: px,
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

test('frames delivered out of order within a generation land in their own slots', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel(); // pending=2, current generation
  assert.equal(c.pending, 2);

  // Workers respond in arbitrary order; the handler keys on msg.segId, so seg 1
  // arriving before seg 0 must still file each frame in its own slot and count
  // pending down to 0 regardless of arrival order.
  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
  assert.ok(c.results[1], 'seg-1 frame stored despite arriving first');
  assert.equal(c.results[1].x1, 4);
  assert.equal(c.results[0], null, 'seg-0 slot still empty');
  assert.equal(c.pending, 1);

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  assert.ok(c.results[0], 'seg-0 frame stored when it arrives');
  assert.equal(c.results[0].x1, 2);
  assert.equal(c.pending, 0);
  await done; // settles once every segment has reported, order-independent
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

test('a worker onmessageerror latches the fault the same way onerror does', async () => {
  const c = makeController();
  c.create(2);
  c.renderInFlight = true;
  const done = c.renderParallel(); // pending=2, frameResolve set

  // A payload that fails structured-clone deserialization fires onmessageerror,
  // never onerror. It must still break the deadlock: latch the fault, zero
  // pending, free the in-flight slot, and settle the frame.
  c.workers[1].onmessageerror({ type: 'messageerror' });

  assert.equal(c.faulted, true);
  assert.deepEqual(c.faultInfo, { segId: 1, message: 'message deserialization failed' });
  assert.equal(c.pending, 0, 'pending zeroed so the loop cannot deadlock');
  assert.equal(c.renderInFlight, false);
  assert.equal(c.frameResolve, null);
  await done; // the latch settled the promise
});

test('a surviving worker responding after a fault does not drive pending negative', async () => {
  const c = makeController();
  c.create(2);
  c.renderInFlight = true;
  const done = c.renderParallel(); // pending=2

  // Worker 0 traps: the latch zeroes pending and settles the frame.
  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.pending, 0);
  await done;

  // Worker 1 survived its render and now reports back. The handler must ignore
  // the late frame rather than decrement the already-zeroed counter.
  deliverFrame(c, 1);
  assert.equal(c.pending, 0, 'post-fault frame leaves pending at 0, not negative');
  assert.equal(c.results[1], null, 'no result is recorded for the halted pool');
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

test('setResolution on a faulted active pool rebuilds it and clears the fault', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  const beforeCount = FakeWorker.instances.length;
  c.workers[0].onerror({ message: 'x', filename: '', lineno: 0, colno: 0 });
  assert.equal(c.faulted, true);

  // The fault UI/docstring promise that a resolution change restarts the pool.
  c.setResolution(8, 8);
  assert.equal(c.faulted, false, 'recreating the pool cleared the fault latch');
  assert.equal(c.workers.length, 2, 'a fresh pool of workers was built');
  assert.equal(FakeWorker.instances.length, beforeCount + 2, 'new workers were spawned');
});

// ---------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------

/**
 * Index of (x,y) channel 0 in a W*H*3 RGB16 buffer.
 * @param {number} x - Pixel column.
 * @param {number} y - Pixel row.
 * @param {number} w - Buffer width in pixels.
 * @returns {number} Flat element offset of the red channel at (x, y).
 */
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

test('composite() marks both the internal split and the x=0 wrap seam', () => {
  // 2-arm layout over W=4: arm 0 = x[0,2), arm 1 = x[2,4). On the wrapped
  // cylinder there are two vertical arm boundaries — the internal split at
  // x=2 and the wrap seam at x=0 (where arm 1 meets arm 0). Both must be cyan.
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = true;
  const quadL = new Uint16Array(2 * 2 * 3).fill(111);
  const quadR = new Uint16Array(2 * 2 * 3).fill(222);
  c.results = [
    { pixels: quadL, x0: 0, x1: 2, y0: 0, y1: 2, quadW: 2, quadH: 2 },
    { pixels: quadR, x0: 2, x1: 4, y0: 0, y1: 2, quadW: 2, quadH: 2 },
  ];

  c.composite();

  const isCyan = (x, y) => {
    const i = idx(x, y, 4);
    return Daydream.pixels[i] === 0 && Daydream.pixels[i + 1] === 65535 &&
           Daydream.pixels[i + 2] === 65535;
  };
  // Internal split column x=2 is cyan top-to-bottom.
  assert.ok(isCyan(2, 0) && isCyan(2, 1), 'internal arm split at x=2 marked');
  // Wrap-seam column x=0 (arm 1 -> arm 0) is cyan top-to-bottom.
  assert.ok(isCyan(0, 0) && isCyan(0, 1), 'wrap-seam boundary at x=0 marked');
  // The arm interiors (x=1, x=3) keep their blitted pixel values.
  assert.equal(Daydream.pixels[idx(1, 0, 4)], 111, 'arm-0 interior untouched');
  assert.equal(Daydream.pixels[idx(3, 0, 4)], 222, 'arm-1 interior untouched');
});

test('composite() draws no x=0 line when the layout is not split in x', () => {
  // A single full-width segment spanning x[0,4): x does not split, so x=0 is a
  // same-segment wrap, not a boundary — no spurious cyan line down the edge.
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = true;
  const full = new Uint16Array(4 * 2 * 3).fill(123);
  c.results = [{ pixels: full, x0: 0, x1: 4, y0: 0, y1: 2, quadW: 4, quadH: 2 }];

  c.composite();
  assert.ok(Daydream.pixels.every((v) => v === 123),
    'full-width segment leaves no boundary overlay');
});

test('composite() throws if the display-buffer alias is broken', () => {
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  // getMemoryView returns a DIFFERENT buffer than Daydream.pixels.
  c._getMemoryView = () => new Uint16Array(4 * 2 * 3);
  c.results = [];

  assert.throws(() => c.composite(), /alias broken/);
});

// ---------------------------------------------------------------------------
// tick() — the one-frame-deep render-loop state machine. Each tick (a) applies
// the previous frame's composite when one is pending, and (b) dispatches the
// next parallel render unless one is already in flight. The transitions below
// walk a full pipeline cycle plus the two guard states (not-ready, faulted).
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

test('an init-phase fault still reaches the fault overlay (faulted checked before ready guard)', () => {
  // A worker that traps during startup latches `faulted` but never sends
  // 'ready', so `ready` stays false forever. A ready-first guard would return
  // at the top of every tick() and the fault overlay would never paint.
  const c = makeController();
  c.create(2);                    // workers spawned, none has signalled ready
  assert.equal(c.ready, false);

  c.workers[0].onerror({ message: 'init boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.faulted, true);

  let statsShown = 0;
  c.updateStats = () => { statsShown++; }; // observe the overlay-refresh call
  c.tick();

  assert.equal(statsShown, 1, 'tick() refreshed the fault overlay despite never being ready');
  assert.equal(c.renderInFlight, false, 'no doomed render dispatched');
});

// ---------------------------------------------------------------------------
// Broadcast paths — setEffect / setParameter / setAnimationsPaused carry the
// main thread's intent to every worker, and _snapshotParams() flattens the
// engine's tuned values for transport. setEffect must ship that snapshot in the
// SAME message so the worker re-applies it AFTER its rebuild-to-defaults; a
// dropped or reordered replay would render a different effect/params than the
// main thread — the exact divergence segment mode exists to catch.
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for the WASM engine exposing just getParameterDefinitions().
 * @param {Array<{name: string, value: number|boolean}>} defs - Param defs.
 * @returns {{ getParameterDefinitions: () => Array }} Fake engine.
 */
function fakeEngine(defs) {
  return { getParameterDefinitions: () => defs };
}

test('_snapshotParams() flattens param defs (bool -> 1/0, number passthrough)', () => {
  const c = makeController();
  c._getWasmEngine = () => fakeEngine([
    { name: 'Speed', value: 0.5 },
    { name: 'Glow', value: true },
    { name: 'Invert', value: false },
    { name: 'Count', value: 7 },
  ]);
  assert.deepEqual(c._snapshotParams(), [
    { name: 'Speed', value: 0.5 },
    { name: 'Glow', value: 1.0 },
    { name: 'Invert', value: 0.0 },
    { name: 'Count', value: 7 },
  ]);
});

test('_snapshotParams() is empty when no engine is bound', () => {
  const c = makeController(); // getWasmEngine -> null
  assert.deepEqual(c._snapshotParams(), []);
});

test('setEffect broadcasts the name plus the tuned param snapshot to every worker', () => {
  const c = readyController(2);
  c._getWasmEngine = () => fakeEngine([
    { name: 'Speed', value: 0.5 },
    { name: 'Glow', value: true },
  ]);

  c.setEffect('NewEffect');

  for (const w of c.workers) {
    const msgs = w.posted.filter((m) => m.type === 'setEffect');
    assert.equal(msgs.length, 1, 'each worker received exactly one setEffect');
    assert.equal(msgs[0].name, 'NewEffect');
    // The snapshot rides in the SAME message, so the worker's rebuild-to-defaults
    // and the param re-apply cannot be split or reordered in transit.
    assert.deepEqual(msgs[0].params, [
      { name: 'Speed', value: 0.5 },
      { name: 'Glow', value: 1.0 },
    ]);
  }
});

test('setParameter broadcasts the name/value to every worker', () => {
  const c = readyController(2);
  c.setParameter('Speed', 0.75);
  for (const w of c.workers) {
    const msgs = w.posted.filter((m) => m.type === 'setParameter');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].name, 'Speed');
    assert.equal(msgs[0].value, 0.75);
  }
});

test('setAnimationsPaused records the flag and broadcasts it to every worker', () => {
  const c = readyController(2);
  assert.equal(c._animationsPaused, false, 'unpaused by default');

  c.setAnimationsPaused(true);

  assert.equal(c._animationsPaused, true, 'controller remembers the paused state');
  for (const w of c.workers) {
    const msgs = w.posted.filter((m) => m.type === 'setAnimationsPaused');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].paused, true);
  }
});
