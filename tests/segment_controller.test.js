// @ts-nocheck
//
// SegmentController — unit coverage for the generation-fence drop, the
// worker-fault deadlock-break latch, and the quadrant compositor. Driven by a
// fake Worker and a mocked ./driver.js.
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

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
    getWasmEngine: () => null,
    refreshPixelView: () => {},
    getMemoryView: () => Daydream.pixels,
  });
}

beforeEach(() => { FakeWorker.instances = []; });

const savedGlobals = { Worker: globalThis.Worker, document: globalThis.document };
const restoreGlobal = (key, val) => {
  if (val === undefined) delete globalThis[key];
  else globalThis[key] = val;
};
after(() => {
  restoreGlobal('Worker', savedGlobals.Worker);
  restoreGlobal('document', savedGlobals.document);
});

globalThis.Worker = FakeWorker;

// getElementById -> null makes updateStats() early-return, keeping tick() tests DOM-free.
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
 * Drive a worker's 'booted' ping (module body ran, static imports resolved).
 * @param {SegmentController} controller - Controller owning the worker pool.
 * @param {number} segId - Index of the worker to signal booted.
 * @returns {void}
 */
function deliverBooted(controller, segId) {
  controller.workers[segId].onmessage({ data: { type: 'booted' } });
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
      // Must be the Uint16Array view, not a bare ArrayBuffer: composite() indexes
      // pixels element-wise.
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
  const done = c.renderParallel();
  assert.equal(c.pending, 2);

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  assert.ok(c.results[0], 'matching-generation frame is kept');
  assert.equal(c.results[0].x1, 2);
  assert.equal(c.pending, 1);

  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
  assert.equal(c.pending, 0);
  await done;
});

test('frames delivered out of order within a generation land in their own slots', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();
  assert.equal(c.pending, 2);

  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
  assert.ok(c.results[1], 'seg-1 frame stored despite arriving first');
  assert.equal(c.results[1].x1, 4);
  assert.equal(c.results[0], null, 'seg-0 slot still empty');
  assert.equal(c.pending, 1);

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  assert.ok(c.results[0], 'seg-0 frame stored when it arrives');
  assert.equal(c.results[0].x1, 2);
  assert.equal(c.pending, 0);
  await done;
});

test('a frame dispatched before a resolution change is dropped but still settles', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();

  c.setResolution(8, 8);
  assert.notEqual(c.inflightGen, c.renderGen);

  deliverFrame(c, 0);
  assert.equal(c.results[0], null, 'stale-generation result is discarded');
  assert.equal(c.pending, 1, 'but pending still decremented');

  deliverFrame(c, 1);
  assert.equal(c.results[1], null);
  assert.equal(c.pending, 0);
  await done;
});

test('destroy() bumps the generation so a stale in-flight .then cannot arm a new pool', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();
  const dispatchGen = c.inflightGen;

  // Recreate the pool while a render is in flight; destroy() settles `done`.
  c.create(2);
  await done;

  // The stale .then's guard (inflightGen === renderGen) must fail.
  assert.equal(c.inflightGen, dispatchGen, 'inflight snapshot is unchanged');
  assert.notEqual(c.inflightGen, c.renderGen, 'generation moved on under it');
});

// ---------------------------------------------------------------------------
// Fault latch (deadlock break)
// ---------------------------------------------------------------------------

test('a worker fault latches, zeroes pending, and resolves the in-flight frame', async () => {
  const c = makeController();
  c.create(2);
  c.renderInFlight = true;
  const done = c.renderParallel();

  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 2 });

  assert.equal(c.faulted, true);
  assert.deepEqual(c.faultInfo, { segId: 0, message: 'boom' });
  assert.equal(c.pending, 0, 'pending zeroed so the loop cannot deadlock');
  assert.equal(c.renderInFlight, false);
  assert.equal(c.frameResolve, null);
  await done;
});

test('a worker onmessageerror latches the fault the same way onerror does', async () => {
  const c = makeController();
  c.create(2);
  c.renderInFlight = true;
  const done = c.renderParallel();

  // A failed structured-clone deserialization fires onmessageerror, not onerror.
  c.workers[1].onmessageerror({ type: 'messageerror' });

  assert.equal(c.faulted, true);
  assert.deepEqual(c.faultInfo, { segId: 1, message: 'message deserialization failed' });
  assert.equal(c.pending, 0, 'pending zeroed so the loop cannot deadlock');
  assert.equal(c.renderInFlight, false);
  assert.equal(c.frameResolve, null);
  await done;
});

test('a surviving worker responding after a fault does not drive pending negative', async () => {
  const c = makeController();
  c.create(2);
  c.renderInFlight = true;
  const done = c.renderParallel();

  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.pending, 0);
  await done;

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

test('the boot watchdog faults fast when a worker never sends booted', () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const c = makeController();
    c.create(2);
    timers[0](); // boot watchdog is armed first
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /module load timed out/);
    assert.match(c.faultInfo.message, /0\/2 booted/);
    assert.match(c.faultInfo.message, /holosphere_wasm\.js/);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('the boot watchdog names the segments that never booted', () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const c = makeController();
    c.create(3);
    deliverBooted(c, 0); // only seg 0 boots; 1 and 2 hang
    timers[0]();
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /1\/3 booted/);
    assert.match(c.faultInfo.message, /never booted: 1, 2/);
    assert.equal(c.faultInfo.segId, -1, 'multiple missing -> pool-wide segId');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a single missing segment is named directly in the watchdog fault', () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const c = makeController();
    c.create(2);
    deliverBooted(c, 0);
    deliverReady(c, 0); // seg 0 fully up; seg 1 never readies
    timers[1](); // init watchdog
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /never ready: 1/);
    assert.equal(c.faultInfo.segId, 1);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a booted ping is handled and does not by itself make the pool ready', () => {
  const c = makeController();
  c.create(2);
  deliverBooted(c, 0);
  deliverBooted(c, 1);
  assert.equal(c.ready, false, 'booted alone does not signal readiness');
  assert.equal(c.faulted, false, 'a clean boot does not fault');
  deliverReady(c, 0);
  deliverReady(c, 1);
  assert.equal(c.ready, true, 'readiness still requires the ready messages');
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
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(111);
  c.results = [{ pixels: quad, x0: 2, x1: 4, y0: 0, y1: 2, quadW: 2, quadH: 2 }];

  c.composite();

  assert.equal(Daydream.pixels[idx(2, 0, 4)], 111);
  assert.equal(Daydream.pixels[idx(3, 1, 4)], 111);
  assert.equal(Daydream.pixels[idx(0, 0, 4)], 0);
  assert.equal(Daydream.pixels[idx(1, 1, 4)], 0);
});

test('composite() faults on a rectangle that overflows the current display buffer', () => {
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(222);
  c.results = [{ pixels: quad, x0: 0, x1: 99, y0: 0, y1: 2, quadW: 2, quadH: 2 }]; // x1=99 overshoots W=4

  const blitted = c.composite();
  assert.equal(blitted, 0, 'a leading out-of-bounds rect blits nothing');
  assert.equal(c.faulted, true, 'an overflow latches a fault instead of throwing');
  assert.match(c.faultInfo.message, /out of bounds/);
  assert.ok(Daydream.pixels.every((v) => v === 0),
    'a leading out-of-bounds rect is never partially blitted');
});

test('composite() faults atomically when a non-leading segment overflows', () => {
  // The bounds pre-pass validates every result before any blit, so a good
  // segment ahead of the overflowing one is never composited — no partial frame.
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = false;
  const good = new Uint16Array(2 * 2 * 3).fill(111);
  const bad = new Uint16Array(2 * 2 * 3).fill(222);
  c.results = [
    { pixels: good, x0: 0, x1: 2, y0: 0, y1: 2, quadW: 2, quadH: 2 },
    { pixels: bad, x0: 2, x1: 99, y0: 0, y1: 2, quadW: 2, quadH: 2 }, // x1=99 overshoots W=4
  ];

  const blitted = c.composite();
  assert.equal(blitted, 0, 'a later out-of-bounds rect blits nothing');
  assert.equal(c.faulted, true);
  assert.match(c.faultInfo.message, /segment 1 .* out of bounds/);
  assert.ok(Daydream.pixels.every((v) => v === 0),
    'the good leading segment is not blitted when a later segment overflows');
});

test('composite() marks both the internal split and the x=0 wrap seam', () => {
  // On the wrapped cylinder a 2-arm split has two boundaries: the internal split
  // at x=2 and the wrap seam at x=0 where arm 1 meets arm 0.
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
  assert.ok(isCyan(2, 0) && isCyan(2, 1), 'internal arm split at x=2 marked');
  assert.ok(isCyan(0, 0) && isCyan(0, 1), 'wrap-seam boundary at x=0 marked');
  assert.equal(Daydream.pixels[idx(1, 0, 4)], 111, 'arm-0 interior untouched');
  assert.equal(Daydream.pixels[idx(3, 0, 4)], 222, 'arm-1 interior untouched');
});

test('composite() draws no x=0 line when the layout is not split in x', () => {
  // A single full-width segment never splits in x, so x=0 is a same-segment wrap,
  // not a boundary.
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

test('composite() self-heals a broken display-buffer alias instead of throwing', () => {
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  const target = new Uint16Array(4 * 2 * 3);
  c.getMemoryView = () => target;
  c.results = [];

  assert.doesNotThrow(() => c.composite());
  assert.equal(Daydream.pixels, target,
    'Daydream.pixels re-pointed at the composite target');
});

// ---------------------------------------------------------------------------
// tick() — the one-frame-deep render-loop state machine
// ---------------------------------------------------------------------------

test('tick() is a no-op until every worker has signalled ready', () => {
  const c = makeController();
  c.create(2);
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
  c.tick();

  deliverFrame(c, 0);
  deliverFrame(c, 1);
  await flush();

  assert.equal(c.pending, 0);
  assert.equal(c.pendingFrame, true, 'results are waiting to be composited');
  assert.equal(c.renderInFlight, false, 'slot freed for the next dispatch');
});

test('the next tick() composites the armed frame and dispatches the following one', async () => {
  Daydream.W = 4; Daydream.H = 2;
  Daydream.pixels = new Uint16Array(4 * 2 * 3);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  assert.equal(c.pendingFrame, true);

  c.tick();

  assert.equal(c.pendingFrame, false, 'pending frame was composited and cleared');
  assert.ok(Daydream.pixels.some((v) => v === 111),
    'the composited quadrants reached the display buffer');
  assert.equal(c.renderInFlight, true, 'the following frame was dispatched');
  assert.equal(c.pending, 2);
});

test('a faulted pool keeps tick() from dispatching another doomed render', () => {
  const c = readyController(2);
  c.tick();

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
  // A startup trap latches `faulted` but never sends 'ready'; a ready-first guard
  // would return before the fault overlay ever painted.
  const c = makeController();
  c.create(2);
  assert.equal(c.ready, false);

  c.workers[0].onerror({ message: 'init boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.faulted, true);

  let statsShown = 0;
  c.updateStats = () => { statsShown++; };
  c.tick();

  assert.equal(statsShown, 1, 'tick() refreshed the fault overlay despite never being ready');
  assert.equal(c.renderInFlight, false, 'no doomed render dispatched');
});

// ---------------------------------------------------------------------------
// Broadcast paths — setEffect / setParameter / setAnimationsPaused / snapshotParams
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for the WASM engine exposing just getParameterDefinitions().
 * @param {Array<{name: string, value: number|boolean}>} defs - Param defs.
 * @returns {{ getParameterDefinitions: () => Array }} Fake engine.
 */
function fakeEngine(defs) {
  return { getParameterDefinitions: () => defs };
}

test('snapshotParams() flattens param defs (bool -> 1/0, number passthrough)', () => {
  const c = makeController();
  c.getWasmEngine = () => fakeEngine([
    { name: 'Speed', value: 0.5 },
    { name: 'Glow', value: true },
    { name: 'Invert', value: false },
    { name: 'Count', value: 7 },
  ]);
  assert.deepEqual(c.snapshotParams(), [
    { name: 'Speed', value: 0.5 },
    { name: 'Glow', value: 1.0 },
    { name: 'Invert', value: 0.0 },
    { name: 'Count', value: 7 },
  ]);
});

test('snapshotParams() is empty when no engine is bound', () => {
  const c = makeController();
  assert.deepEqual(c.snapshotParams(), []);
});

test('setEffect broadcasts the name plus the tuned param snapshot to every worker', () => {
  const c = readyController(2);
  c.getWasmEngine = () => fakeEngine([
    { name: 'Speed', value: 0.5 },
    { name: 'Glow', value: true },
  ]);

  c.setEffect('NewEffect');

  for (const w of c.workers) {
    const msgs = w.posted.filter((m) => m.type === 'setEffect');
    assert.equal(msgs.length, 1, 'each worker received exactly one setEffect');
    assert.equal(msgs[0].name, 'NewEffect');
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
  assert.equal(c.animationsPaused, false, 'unpaused by default');

  c.setAnimationsPaused(true);

  assert.equal(c.animationsPaused, true, 'controller remembers the paused state');
  for (const w of c.workers) {
    const msgs = w.posted.filter((m) => m.type === 'setAnimationsPaused');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].paused, true);
  }
});
