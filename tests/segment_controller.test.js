//
// SegmentController — unit coverage for the generation-fence drop, the
// worker-fault deadlock-break latch, and the quadrant compositor. Driven by a
// fake Worker, a fake driver, and a mocked ./driver.js.
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { unpinnedEngineMethods } from './fake_engine.js';

// Stand-in for the injected Daydream renderer: only the grid and display buffer
// the compositor reads.
const driver = { W: 0, H: 0, pixels: null };


const { SegmentController, MAX_BOOT_RETRIES, warmModules } =
  await import('../segment_controller.js');
const { PROTOCOL_VERSION } = await import('../worker_protocol.js');

const EXPECTED_CONSOLE_MESSAGES = {
  log: [
    /^\[Segmented\] Spawning \d+ workers\.\.\.$/,
    /^\[Segmented\] All \d+ workers ready$/,
  ],
  warn: [
    /^\[Segmented\] seg \d+ module failed to load \(attempt \d+\/\d+\); rebuilding pool$/,
    /^\[Segmented\] additional worker fault \(seg -?\d+\): /,
  ],
  error: [
    /^\[Segmented\] Worker seg \d+ error:/,
    /^\[Segmented\] Worker seg \d+ message deserialization failed$/,
    /^\[Segmented\] frame from invalid segId /,
    /^SegmentController\.composite: display-buffer alias diverged /,
  ],
};
const PASSTHROUGH_CONSOLE_MESSAGES = {
  error: [/^\(node:\d+\) ExperimentalWarning: Module mocking is an experimental feature/],
};
const originalConsole = Object.fromEntries(
  Object.keys(EXPECTED_CONSOLE_MESSAGES)
    .map((method) => [method, console[method].bind(console)]),
);
const capturedConsole = [];
const consoleMocks = Object.keys(EXPECTED_CONSOLE_MESSAGES)
  .map((method) => mock.method(console, method, (...args) => {
    capturedConsole.push({ method, args });
    const expected = EXPECTED_CONSOLE_MESSAGES[method]
      .some((pattern) => pattern.test(String(args[0])));
    if (!expected) originalConsole[method](...args);
  }));

test('warmModules refreshes the worker, glue, and binary cache entries', async () => {
  const calls = [];
  const response = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  await warmModules({
    baseUrl: 'http://localhost:8000/segment_controller.js',
    fetch: (url, options) => {
      calls.push([url.href, options]);
      return Promise.resolve(response);
    },
  });

  assert.deepEqual(calls.map(([url]) => url), [
    'http://localhost:8000/segment_worker.js',
    'http://localhost:8000/holosphere_wasm.js',
    'http://localhost:8000/holosphere_wasm.wasm',
  ]);
  for (const [, options] of calls)
    assert.deepEqual(options, { cache: 'reload' });
});

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
  static constructionCount = 0;
  static failConstructionAt = -1;
  static failInitialPostAt = -1;
  /** @type {number} Index whose postMessage throws for `failPostType`. */
  static failPostAt = -1;
  /** @type {string|null} Message type postMessage throws on at `failPostAt`. */
  static failPostType = null;
  /**
   * @param {string} url - Worker script URL the controller requested.
   * @param {Object} opts - Worker options bag (e.g. `{ type: 'module' }`).
   */
  constructor(url, opts) {
    this.index = FakeWorker.constructionCount++;
    if (this.index === FakeWorker.failConstructionAt)
      throw new DOMException('worker blocked', 'SecurityError');
    this.url = url;
    this.opts = opts;
    this.posted = [];
    /** @type {Array<Transferable[]|null>} Transfer list per posted message. */
    this.transfers = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    FakeWorker.instances.push(this);
  }
  /**
   * Records a posted message instead of dispatching it to a real worker, and
   * detaches every transferred buffer the way structured-clone transfer does.
   * @param {Object} msg - Protocol message the controller sent.
   * @param {Transferable[]} [transfer] - Transfer list the controller supplied.
   * @returns {void}
   */
  postMessage(msg, transfer) {
    if (msg.type === 'init' && this.index === FakeWorker.failInitialPostAt)
      throw new DOMException('message rejected', 'DataCloneError');
    if (msg.type === FakeWorker.failPostType && this.index === FakeWorker.failPostAt)
      throw new DOMException('message rejected', 'DataCloneError');
    this.posted.push(msg);
    this.transfers.push(transfer ?? null);
    for (const buffer of transfer ?? []) buffer.transfer();
  }
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
    driver,
    getWasmEngine: () => null,
    refreshPixelView: () => {},
    getMemoryView: () => driver.pixels,
  });
}

beforeEach(() => {
  driver.W = 0;
  driver.H = 0;
  driver.pixels = null;
  FakeWorker.instances = [];
  FakeWorker.constructionCount = 0;
  FakeWorker.failConstructionAt = -1;
  FakeWorker.failInitialPostAt = -1;
  FakeWorker.failPostAt = -1;
  FakeWorker.failPostType = null;
});

const savedGlobals = { Worker: globalThis.Worker, document: globalThis.document };
const restoreGlobal = (key, val) => {
  if (val === undefined) delete globalThis[key];
  else globalThis[key] = val;
};
after(() => {
  for (const stub of consoleMocks) stub.mock.restore();
  restoreGlobal('Worker', savedGlobals.Worker);
  restoreGlobal('document', savedGlobals.document);

  const unexpected = capturedConsole.filter(({ method, args }) => {
    const message = String(args[0]);
    return !EXPECTED_CONSOLE_MESSAGES[method].some((pattern) => pattern.test(message))
      && !(PASSTHROUGH_CONSOLE_MESSAGES[method] ?? [])
        .some((pattern) => pattern.test(message));
  });
  assert.deepEqual(
    unexpected.map(({ method, args }) => `${method}: ${args.map(String).join(' ')}`),
    [],
    'unexpected console diagnostics',
  );
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
  controller.workers[segId].onmessage({ data: { type: 'booted', version: PROTOCOL_VERSION } });
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
 * @param {Uint16Array} [overrides.pixels] - RGB16 quadrant pixel buffer.
 * @param {number} [overrides.x0] - Inclusive left display-buffer column.
 * @param {number} [overrides.x1] - Exclusive right display-buffer column.
 * @param {number} [overrides.y0] - Inclusive top display-buffer row.
 * @param {number} [overrides.y1] - Exclusive bottom display-buffer row.
 * @param {number} [overrides.elapsed] - Simulated elapsed time for the frame.
 * @param {Object} [overrides.arenaMetrics] - Optional arena-metrics payload.
 * @param {number[]} [overrides.paramValues] - Post-frame param values the worker reports.
 * @returns {void}
 */
function deliverFrame(controller, segId, overrides = {}) {
  const defW = 2;
  const defH = 2;
  const px = overrides.pixels ?? new Uint16Array(defW * defH * 3);
  controller.workers[segId].onmessage({
    data: {
      type: 'frame', segId,
      // Must be the Uint16Array view, not a bare ArrayBuffer: composite() indexes
      // pixels element-wise.
      pixels: px,
      x0: overrides.x0 ?? 0, x1: overrides.x1 ?? defW,
      y0: overrides.y0 ?? 0, y1: overrides.y1 ?? defH,
      elapsed: overrides.elapsed ?? 1,
      arenaMetrics: overrides.arenaMetrics ?? null,
      paramValues: overrides.paramValues ?? null,
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
  assert.ok(c.scratch[0], 'matching-generation frame is staged');
  assert.equal(c.scratch[0].x1, 2);
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
  assert.ok(c.scratch[1], 'seg-1 frame staged despite arriving first');
  assert.equal(c.scratch[1].x1, 4);
  assert.equal(c.scratch[0], null, 'seg-0 slot still empty');
  assert.equal(c.pending, 1);

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  assert.ok(c.scratch[0], 'seg-0 frame staged when it arrives');
  assert.equal(c.scratch[0].x1, 2);
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
  assert.equal(c.scratch[0], null, 'stale-generation result is discarded');
  assert.equal(c.pending, 1, 'but pending still decremented');

  deliverFrame(c, 1);
  assert.equal(c.scratch[1], null);
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
// Segment-0 parameter publish — the GUI's only live param source in segmented
// mode, since the main-thread engine is never stepped.
// ---------------------------------------------------------------------------

test('a segment-0 frame publishes its param values for the GUI to read', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();
  assert.equal(c.getParamValues(), null, 'nothing published before the first frame');

  deliverFrame(c, 0, { paramValues: [0.25, 1] });
  assert.deepEqual(c.getParamValues(), [0.25, 1],
    'segment 0 mirrors its post-frame params into the controller');

  deliverFrame(c, 1);
  await done;
});

test('a frame from a non-zero segment never publishes param values', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();

  deliverFrame(c, 1, { paramValues: [9, 9] });
  assert.equal(c.getParamValues(), null,
    'only segment 0 is the GUI parameter source; another arm cannot bind the sliders');

  deliverFrame(c, 0);
  await done;
});

test('a frame carrying no param values leaves the published set intact', async () => {
  const c = makeController();
  c.create(2);

  let done = c.renderParallel();
  deliverFrame(c, 0, { paramValues: [0.25, 1] });
  deliverFrame(c, 1);
  await done;

  done = c.renderParallel();
  deliverFrame(c, 0);
  assert.deepEqual(c.getParamValues(), [0.25, 1],
    'a params-less frame is not a publish; the GUI keeps its last real values');

  deliverFrame(c, 1);
  await done;
});

test('a doubled segment-0 frame cannot republish over the generation first frame', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();

  const firstPixels = new Uint16Array([1, 2, 3]);
  const firstArena = { persistent: 10 };
  deliverFrame(c, 0, {
    pixels: firstPixels, elapsed: 2, arenaMetrics: firstArena,
    paramValues: [0.25, 1],
  });
  deliverFrame(c, 0, {
    pixels: new Uint16Array([9, 9, 9]), elapsed: 9,
    arenaMetrics: { persistent: 99 }, paramValues: [9, 9],
  });

  assert.deepEqual(c.getParamValues(), [0.25, 1],
    "segment 0's first frame this generation is the only publish");
  assert.strictEqual(c.scratch[0].pixels, firstPixels, 'the first pixels stay staged');
  assert.equal(c.timings[0], 2, 'the first timing stays staged');
  assert.strictEqual(c.arenas[0], firstArena, 'the first arena metrics stay staged');
  assert.equal(c.pending, 1, 'the duplicate settles nothing');

  deliverFrame(c, 1);
  await done;
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

test('a latched fault terminates the pool so no worker heap stays resident', () => {
  const c = makeController();
  c.create(2);

  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 2 });

  assert.ok(c.workers.every((w) => w.terminated), 'every worker was terminated');
  assert.ok(
    c.workers.every((w) => w.onmessage === null && w.onerror === null
      && w.onmessageerror === null),
    'handlers detached so a late report cannot log success under the overlay');
  assert.equal(c.workers.length, 2, 'the pool array stays populated for the recovery gate');
  assert.equal(c.faulted, true, 'the latch is held so the UI still reports the fault');
  assert.deepEqual(c.faultInfo, { segId: 0, message: 'boom' });
});

test('create posts init stamped with the protocol version', () => {
  const c = makeController();
  c.create(2);
  for (const w of c.workers) {
    const init = w.posted.find((m) => m.type === 'init');
    assert.ok(init, 'init posted');
    assert.equal(init.version, PROTOCOL_VERSION);
  }
});

test('create() is the sole writer of count, so it matches the pool it describes', () => {
  const c = readyController(4);
  assert.equal(c.count, 4);
  assert.equal(c.results.length, 4);

  c.create(2);
  assert.equal(c.count, 2, 'count follows the rebuilt pool, never leads it');
  assert.equal(c.results.length, 2);
  assert.equal(c.frameSeen.length, 2);
});

test('a synchronous worker-N construction failure terminates the partial pool', () => {
  FakeWorker.failConstructionAt = 1;
  const c = makeController();

  assert.doesNotThrow(() => c.create(4));

  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(FakeWorker.instances[0].terminated, true);
  assert.equal(c.workers.length, 1, 'the terminated partial pool stays populated');
  assert.ok(c.workers.every((w) => w.onmessage === null && w.onerror === null
    && w.onmessageerror === null), 'handlers detached');
  assert.equal(c.faulted, true);
  assert.equal(c.faultInfo.segId, 1);
  assert.match(c.faultInfo.message, /construction failed: SecurityError: worker blocked/);
  assert.equal(c.bootWatchdog, null);
  assert.equal(c.initWatchdog, null);
});

test('a synchronous worker-N init post failure terminates the partial pool', () => {
  FakeWorker.failInitialPostAt = 1;
  const c = makeController();

  assert.doesNotThrow(() => c.create(4));

  assert.equal(FakeWorker.instances.length, 2);
  assert.ok(FakeWorker.instances.every((worker) => worker.terminated));
  assert.equal(c.workers.length, 2, 'the terminated partial pool stays populated');
  assert.ok(c.workers.every((w) => w.onmessage === null && w.onerror === null
    && w.onmessageerror === null), 'handlers detached');
  assert.equal(c.faulted, true);
  assert.equal(c.faultInfo.segId, 1);
  assert.match(c.faultInfo.message, /initialization failed: DataCloneError: message rejected/);
  assert.equal(c.bootWatchdog, null);
  assert.equal(c.initWatchdog, null);
});

// A postMessage that throws part-way through a dispatch leaves the un-posted
// workers silent: `pending` never drains and no watchdog has been armed yet.
test('a throwing render dispatch faults instead of wedging the pipeline', async () => {
  const c = readyController(2);
  FakeWorker.failPostAt = 1;
  FakeWorker.failPostType = 'render';

  c.tick();
  await flush();

  assert.equal(c.faulted, true, 'a mid-dispatch throw latches a fault');
  assert.equal(c.faultInfo.segId, 1);
  assert.match(c.faultInfo.message, /render dispatch to seg 1 failed: DataCloneError/);
  assert.equal(c.renderInFlight, false, 'the in-flight latch is released');
  assert.equal(c.pending, 0, 'the barrier cannot deadlock on the un-posted workers');
});

test('a throwing broadcast faults instead of escaping to the GUI caller', () => {
  const c = readyController(2);
  FakeWorker.failPostAt = 0;
  FakeWorker.failPostType = 'setParameter';

  assert.doesNotThrow(() => c.setParameter('Speed', 0.5));

  assert.equal(c.faulted, true, 'a failed broadcast latches a fault');
  assert.equal(c.faultInfo.segId, 0);
  assert.match(c.faultInfo.message, /broadcast of 'setParameter' to seg 0 failed/);
  assert.equal(c.workers[1].posted.some((m) => m.type === 'setParameter'), false,
    'the broadcast stops at the faulting worker');
});

// A construction failure at segment 0 latches with `workers` empty, so no
// recovery trigger may gate on the pool's length.
test('a startup abort with nothing constructed still recovers on a rebuild', () => {
  FakeWorker.failConstructionAt = 0;
  const c = makeController();
  c.active = true;
  c.create(2);
  assert.equal(c.faulted, true);
  assert.equal(c.workers.length, 0);

  FakeWorker.failConstructionAt = -1;
  c.setResolution(4, 4);
  assert.equal(c.faulted, false, 'recreating the pool cleared the fault latch');
  assert.equal(c.workers.length, 2, 'a fresh pool of workers was built');
});

test('a booted ping with a mismatched protocol version faults fast', () => {
  const c = makeController();
  c.create(2);
  c.workers[0].onmessage({ data: { type: 'booted', version: PROTOCOL_VERSION + 1 } });
  assert.equal(c.faulted, true);
  assert.equal(c.faultInfo.segId, 0);
  assert.match(c.faultInfo.message, /protocol version/);
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

test('an engineRejected worker message faults the pool with the reason and segId', () => {
  const c = makeController();
  c.create(2);
  c.workers[1].onmessage({
    data: { type: 'engineRejected', reason: 'resolution 9000x9000 exceeds the worker arena' },
  });

  assert.equal(c.faulted, true, 'an unbuildable resolution faults fast rather than deadlocking');
  assert.equal(c.faultInfo.segId, 1, 'the fault carries the reporting segment index');
  assert.match(c.faultInfo.message, /engine rejected/);
  assert.doesNotMatch(c.faultInfo.message, /init failed/,
    'a post-init rejection is never reported as an init failure');
  assert.match(c.faultInfo.message, /9000x9000 exceeds the worker arena/);
});

test('an unknown worker message faults instead of being silently dropped', () => {
  const c = makeController();
  c.create(2);
  c.workers[1].onmessage({ data: { type: 'readyish', segId: 1 } });

  assert.equal(c.faulted, true, 'protocol drift faults rather than waiting out a watchdog');
  assert.equal(c.faultInfo.segId, 1);
  assert.match(c.faultInfo.message, /unknown message type readyish/);
});

/**
 * Deliver a raw 'frame' payload with an arbitrary segId, bypassing deliverFrame's
 * number-typed parameter, so the controller's own validation is what is tested.
 * @param {SegmentController} controller - Controller owning the worker pool.
 * @param {number} worker - Index of the worker delivering the frame.
 * @param {unknown} segId - segId field to put on the wire.
 * @returns {void}
 */
function deliverFrameWithSegId(controller, worker, segId) {
  controller.workers[worker].onmessage({
    data: {
      type: 'frame', segId,
      pixels: new Uint16Array(2 * 2 * 3),
      x0: 0, x1: 2, y0: 0, y1: 2,
      elapsed: 1, arenaMetrics: null,
    },
  });
}

test('a frame with a non-integer segId is dropped without settling the barrier', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();

  // Each of these fails both range comparisons, so a range-only guard would let
  // it index by string key and decrement `pending` for an absent segment.
  for (const segId of [undefined, NaN, null, '1', 1.5]) {
    deliverFrameWithSegId(c, 0, segId);
    assert.equal(c.pending, 2, `segId ${String(segId)} must not settle the barrier`);
    assert.deepEqual(c.scratch, [null, null],
      `segId ${String(segId)} must not write a staging slot`);
    assert.deepEqual(c.frameSeen, [false, false],
      `segId ${String(segId)} must not mark a segment seen`);
  }
  assert.equal(c.faulted, false, 'a malformed segId is a loud drop, not a pool fault');

  // The real segments still complete the generation.
  deliverFrame(c, 0);
  deliverFrame(c, 1);
  assert.equal(c.pending, 0);
  await done;
});

test('a surviving worker responding after a fault does not drive pending negative', async () => {
  const c = makeController();
  c.create(2);
  c.renderInFlight = true;
  const done = c.renderParallel();
  // The fault detaches every handler, so a post-fault report can only arrive
  // from an event already dispatched when the latch closed; hold that handler.
  const seg1 = c.workers[1].onmessage;

  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.pending, 0);
  await done;

  seg1({
    data: {
      type: 'frame', segId: 1,
      pixels: new Uint16Array(2 * 2 * 3),
      x0: 0, x1: 2, y0: 0, y1: 2,
      elapsed: 1, arenaMetrics: null,
    },
  });
  assert.equal(c.pending, 0, 'post-fault frame leaves pending at 0, not negative');
  assert.equal(c.scratch[1], null, 'no result is recorded for the halted pool');
});

test('only the first fault of a session is recorded', () => {
  const c = makeController();
  c.create(2);
  // Held before the latch closes: the first fault detaches every handler.
  const seg1 = c.workers[1].onerror;
  c.workers[0].onerror({ message: 'first', filename: '', lineno: 0, colno: 0 });
  seg1({ message: 'second', filename: '', lineno: 0, colno: 0 });
  assert.deepEqual(c.faultInfo, { segId: 0, message: 'first' });
});

test('a bare-Event boot fault auto-rebuilds the pool instead of latching', () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const c = makeController();
    c.active = true; // the app sets this before create(); the retry path checks it
    c.create(2);
    const firstPool = c.workers.slice();

    // A module-graph load failure fires a message-less Event before ready.
    c.workers[0].onerror({});
    assert.equal(c.faulted, false, 'a transient module-load fault does not latch');
    assert.ok(firstPool.every((w) => w.terminated),
      'the failing pool is torn down before the backoff window, not left instantiating WASM');
    assert.deepEqual(c.workers, [], 'no survivor can re-enter the fault path during the backoff');

    timers[timers.length - 1](); // drive the scheduled rebuild
    assert.equal(c.bootAttempt, 1, 'retry index advanced');
    assert.equal(c.faulted, false);
    assert.equal(c.workers.length, 2, 'pool respawned at the same segment count');
    assert.notEqual(c.workers[0], firstPool[0], 'rebuilt with fresh workers');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a bare-Event boot fault latches once the retry budget is exhausted', () => {
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const c = makeController();
    c.active = true;
    c.create(2);

    for (let a = 0; a < MAX_BOOT_RETRIES; a++) {
      c.workers[0].onerror({});
      assert.equal(c.faulted, false, `attempt ${a + 1} retries rather than latching`);
      timers[timers.length - 1](); // drive the rebuild
      assert.equal(c.bootAttempt, a + 1);
    }
    // One failure past the budget must latch instead of retrying forever.
    c.workers[0].onerror({});
    assert.equal(c.faulted, true, 'a load fault past the retry budget latches');
    assert.equal(c.faultInfo.segId, 0);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a message-less error after the pool is ready still latches fast', () => {
  // Post-ready there is no module to load, so a bare Event is a real worker fault.
  const c = readyController(2);
  c.workers[0].onerror({});
  assert.equal(c.faulted, true);
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
    c.create(4);
    deliverBooted(c, 0); // only seg 0 boots; 1..3 hang
    timers[0]();
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /1\/4 booted/);
    assert.match(c.faultInfo.message, /never booted: 1, 2, 3/);
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

test('the render watchdog faults when a worker accepts render but stops progressing', async () => {
  const c = readyController(2);
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const done = c.renderParallel();
    deliverFrame(c, 0); // only seg 0 replies; seg 1 hangs
    assert.equal(c.pending, 1, 'one segment still outstanding');
    timers[timers.length - 1](); // the re-armed watchdog fires with seg 1 still hung
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /render stalled/);
    assert.match(c.faultInfo.message, /1\/2 segments responded/);
    assert.equal(c.faultInfo.segId, -2,
      'render-timeout sentinel, distinct from the pool-init -1');
    assert.equal(c.pending, 0, 'fault settles pending so the loop cannot deadlock');
    assert.equal(c.renderWatchdog, null);
    await done; // onWorkerFault resolved the in-flight frame
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a progress frame re-arms the render watchdog so a slow render does not fault', async () => {
  const c = readyController(2);
  const realSetTimeout = globalThis.setTimeout;
  const timers = [];
  globalThis.setTimeout = (fn) => { timers.push(fn); return { unref() {} }; };
  try {
    const done = c.renderParallel();
    assert.equal(timers.length, 1, 'watchdog armed once at dispatch');
    deliverFrame(c, 0); // one segment reports; the other is still rendering
    assert.equal(c.pending, 1);
    assert.equal(timers.length, 2, 'watchdog re-armed on the progress frame');
    assert.notEqual(c.renderWatchdog, null);
    deliverFrame(c, 1); // the slow segment finally reports
    assert.equal(c.pending, 0);
    assert.equal(c.renderWatchdog, null, 'watchdog cleared once the frame settles');
    assert.equal(c.faulted, false);
    await done;
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a completed render clears the render watchdog so it cannot fault later', async () => {
  const c = readyController(2);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({ unref() {} });
  try {
    const done = c.renderParallel();
    assert.notEqual(c.renderWatchdog, null, 'watchdog armed at dispatch');
    deliverFrame(c, 0);
    deliverFrame(c, 1);
    assert.equal(c.pending, 0);
    assert.equal(c.renderWatchdog, null, 'watchdog cleared once the frame settles');
    assert.equal(c.faulted, false);
    await done;
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
  c.create(2);
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

test('setEffect on a faulted active pool rebuilds it and clears the fault', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  const beforeCount = FakeWorker.instances.length;
  c.workers[0].onerror({ message: 'x', filename: '', lineno: 0, colno: 0 });
  assert.equal(c.faulted, true);

  c.setEffect('NewEffect');
  assert.equal(c.faulted, false, 'recreating the pool cleared the fault latch');
  assert.equal(c.workers.length, 2, 'a fresh pool of workers was built');
  assert.equal(FakeWorker.instances.length, beforeCount + 2, 'new workers were spawned');
});

// A slider drag fires setParameter per pointer move; a rebuild there would
// respawn the whole pool (a multi-MB WASM load each) on every event.
for (const [label, act] of [
  ['setParameter', (c) => c.setParameter('Speed', 0.5)],
  ['setAnimationsPaused', (c) => c.setAnimationsPaused(true)],
  ['setPoleLod', (c) => c.setPoleLod(1)],
]) {
  test(`${label} on a faulted active pool stays latched`, () => {
    const c = makeController();
    c.active = true;
    c.create(2);
    const beforeCount = FakeWorker.instances.length;
    const worker = c.workers[0];
    worker.onerror({ message: 'x', filename: '', lineno: 0, colno: 0 });
    assert.equal(c.faulted, true);
    const postedBefore = worker.posted.length;

    act(c);
    assert.equal(c.faulted, true, 'the fault latch is held');
    assert.equal(FakeWorker.instances.length, beforeCount, 'no workers were respawned');
    assert.equal(worker.posted.length, postedBefore, 'nothing is broadcast to dead workers');
  });
}

test('a pause toggled on a faulted pool is carried into the rebuilt one', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  c.workers[0].onerror({ message: 'x', filename: '', lineno: 0, colno: 0 });

  c.setAnimationsPaused(true);
  c.setResolution(8, 8);

  for (const w of c.workers) {
    const init = w.posted.find((m) => m.type === 'init');
    assert.equal(init.paused, true, 'the rebuilt pool starts paused');
  }
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
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.count = 2;
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(111);
  c.results = [null, { pixels: quad, x0: 2, x1: 4, y0: 0, y1: 2 }];

  c.composite();

  assert.equal(driver.pixels[idx(2, 0, 4)], 111);
  assert.equal(driver.pixels[idx(3, 1, 4)], 111);
  assert.equal(driver.pixels[idx(0, 0, 4)], 0);
  assert.equal(driver.pixels[idx(1, 1, 4)], 0);
});

test('composite() faults on a rectangle that overflows the current display buffer', () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(222);
  c.results = [{ pixels: quad, x0: 0, x1: 99, y0: 0, y1: 2 }]; // x1=99 overshoots W=4

  const blitted = c.composite();
  assert.equal(blitted, 0, 'a leading out-of-bounds rect blits nothing');
  assert.equal(c.faulted, true, 'an overflow latches a fault instead of throwing');
  assert.match(c.faultInfo.message, /out of bounds/);
  assert.ok(driver.pixels.every((v) => v === 0),
    'a leading out-of-bounds rect is never partially blitted');
});

test('composite() faults atomically when a non-leading segment overflows', () => {
  // The bounds pre-pass validates every result before any blit, so a good
  // segment ahead of the overflowing one is never composited — no partial frame.
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.count = 2;
  c.showBoundaries = false;
  const good = new Uint16Array(2 * 2 * 3).fill(111);
  const bad = new Uint16Array(2 * 2 * 3).fill(222);
  c.results = [
    { pixels: good, x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: bad, x0: 2, x1: 99, y0: 0, y1: 2 }, // x1=99 overshoots W=4
  ];

  const blitted = c.composite();
  assert.equal(blitted, 0, 'a later out-of-bounds rect blits nothing');
  assert.equal(c.faulted, true);
  assert.match(c.faultInfo.message, /segment 1 .* out of bounds/);
  assert.ok(driver.pixels.every((v) => v === 0),
    'the good leading segment is not blitted when a later segment overflows');
});

test('composite() faults on an empty/inverted segment rect', () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(123);
  c.results = [{ pixels: quad, x0: 2, x1: 2, y0: 0, y1: 2 }]; // x1 == x0

  const blitted = c.composite();
  assert.equal(blitted, 0, 'an empty/inverted rect blits nothing');
  assert.equal(c.faulted, true, 'a zero-area rect latches a fault instead of masking corruption');
  assert.match(c.faultInfo.message, /empty\/inverted/);
  assert.ok(driver.pixels.every((v) => v === 0), 'nothing is blitted on an empty/inverted rect');
});

test('composite() faults on a pixel buffer whose length disagrees with its rect', () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.showBoundaries = false;
  // rect [0,0)-[2,2) expects 2 * 2 * 3 = 12 elements; supply 6.
  const short = new Uint16Array(6).fill(123);
  c.results = [{ pixels: short, x0: 0, x1: 2, y0: 0, y1: 2 }];

  const blitted = c.composite();
  assert.equal(blitted, 0, 'a length-mismatched buffer blits nothing');
  assert.equal(c.faulted, true, 'a rect/buffer mismatch latches a fault instead of blitting a truncated row');
  assert.match(c.faultInfo.message, /pixel buffer length/);
  assert.ok(driver.pixels.every((v) => v === 0), 'nothing is blitted on a buffer-length mismatch');
});

test('composite() faults on a rect that is not that segment\'s band of the layout', () => {
  // A worker that missed a resolution change answers under the current generation
  // with a rect that is in bounds and matches its own buffer, so only re-deriving
  // the band catches it before it blits into another segment's rows.
  driver.W = 4; driver.H = 4;
  driver.pixels = new Uint16Array(4 * 4 * 3);

  const c = makeController();
  c.count = 4;
  c.showBoundaries = false;
  // Segment 1's band is [0,2)-[2,4); this is segment 3's, and the same size.
  const quad = new Uint16Array(2 * 2 * 3).fill(123);
  c.results = [null, { pixels: quad, x0: 2, x1: 4, y0: 2, y1: 4 }];

  const blitted = c.composite();
  assert.equal(blitted, 0, 'a misplaced band blits nothing');
  assert.equal(c.faulted, true, 'a wrong-band rect latches a fault instead of blitting');
  assert.match(c.faultInfo.message, /segment 1 .* is not its band/);
  assert.ok(driver.pixels.every((v) => v === 0), 'nothing is blitted on a band mismatch');
});

test('composite() faults when the layout admits no band for a segment', () => {
  driver.W = 4; driver.H = 4;
  driver.pixels = new Uint16Array(4 * 4 * 3);

  const c = makeController();
  c.count = 3; // no arm split exists for an odd segment count
  c.showBoundaries = false;
  const quad = new Uint16Array(2 * 2 * 3).fill(123);
  c.results = [{ pixels: quad, x0: 0, x1: 2, y0: 0, y1: 2 }];

  const blitted = c.composite();
  assert.equal(blitted, 0, 'an underivable layout blits nothing');
  assert.equal(c.faulted, true, 'a throwing layout derivation latches a fault instead of escaping');
  assert.match(c.faultInfo.message, /no segment-0 band exists/);
});

test('composite() marks both the internal split and the x=0 wrap seam', () => {
  // On the wrapped cylinder a 2-arm split has two boundaries: the internal split
  // at x=2 and the wrap seam at x=0 where arm 1 meets arm 0.
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  c.count = 2;
  c.showBoundaries = true;
  const quadL = new Uint16Array(2 * 2 * 3).fill(111);
  const quadR = new Uint16Array(2 * 2 * 3).fill(222);
  c.results = [
    { pixels: quadL, x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: quadR, x0: 2, x1: 4, y0: 0, y1: 2 },
  ];

  c.composite();

  const isCyan = (x, y) => {
    const i = idx(x, y, 4);
    return driver.pixels[i] === 0 && driver.pixels[i + 1] === 65535 &&
           driver.pixels[i + 2] === 65535;
  };
  assert.ok(isCyan(2, 0) && isCyan(2, 1), 'internal arm split at x=2 marked');
  assert.ok(isCyan(0, 0) && isCyan(0, 1), 'wrap-seam boundary at x=0 marked');
  assert.equal(driver.pixels[idx(1, 0, 4)], 111, 'arm-0 interior untouched');
  assert.equal(driver.pixels[idx(3, 0, 4)], 222, 'arm-1 interior untouched');
});

test('composite() marks every internal split plus the wrap seam for an 8-segment layout', () => {
  // Eight segments are two arms of four Y-bands each: internal boundaries at
  // x=4 and y=2,4,6 plus the wrap seam at x=0. The >2-segment case exercises
  // production row-seam handling the 2-segment test cannot.
  driver.W = 8; driver.H = 8;
  driver.pixels = new Uint16Array(8 * 8 * 3);

  const c = makeController();
  c.count = 8;
  c.showBoundaries = true;
  // Bands run 0, 1, 3, 2 down an arm: its southern half counts back from the pole.
  const bandYs = [[0, 2], [2, 4], [6, 8], [4, 6]];
  c.results = Array.from({ length: 8 }, (_, s) => {
    const [y0, y1] = bandYs[s % 4];
    const x0 = s < 4 ? 0 : 4;
    return {
      pixels: new Uint16Array(4 * 2 * 3).fill(111 * (s + 1)),
      x0, x1: x0 + 4, y0, y1,
    };
  });

  c.composite();

  const isCyan = (x, y) => {
    const i = idx(x, y, 8);
    return driver.pixels[i] === 0 && driver.pixels[i + 1] === 65535 &&
           driver.pixels[i + 2] === 65535;
  };
  for (const x of [0, 4])
    assert.ok(isCyan(x, 0) && isCyan(x, 7), `arm boundary at x=${x} marked`);
  for (const y of [2, 4, 6])
    assert.ok(isCyan(0, y) && isCyan(7, y), `band seam at y=${y} marked`);
  assert.equal(driver.pixels[idx(1, 0, 8)], 111, 'arm-0 north band interior untouched');
  assert.equal(driver.pixels[idx(1, 3, 8)], 222, 'arm-0 second band interior untouched');
  assert.equal(driver.pixels[idx(5, 7, 8)], 777, 'arm-1 south band interior untouched');
  assert.equal(driver.pixels[idx(5, 5, 8)], 888, 'arm-1 third band interior untouched');
});

test('composite() marks the horizontal seam between stacked Y-band segments', () => {
  // Four segments split each arm in Y (top band y[0,2), bottom band y[2,4)), so
  // the horizontal boundary at y=2 runs the full width across both arms.
  driver.W = 4; driver.H = 4;
  driver.pixels = new Uint16Array(4 * 4 * 3);

  const c = makeController();
  c.count = 4;
  c.showBoundaries = true;
  const band = (fill) => new Uint16Array(2 * 2 * 3).fill(fill);
  c.results = [
    { pixels: band(111), x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: band(222), x0: 0, x1: 2, y0: 2, y1: 4 },
    { pixels: band(333), x0: 2, x1: 4, y0: 0, y1: 2 },
    { pixels: band(444), x0: 2, x1: 4, y0: 2, y1: 4 },
  ];

  c.composite();

  const isCyan = (x, y) => {
    const i = idx(x, y, 4);
    return driver.pixels[i] === 0 && driver.pixels[i + 1] === 65535 &&
           driver.pixels[i + 2] === 65535;
  };
  assert.ok([0, 1, 2, 3].every((x) => isCyan(x, 2)),
    'horizontal band seam at y=2 marked across the row');
  assert.ok(isCyan(2, 0) && isCyan(0, 0), 'arm split at x=2 and wrap seam at x=0 marked');
  assert.equal(driver.pixels[idx(1, 0, 4)], 111, 'top-band interior untouched');
  assert.equal(driver.pixels[idx(1, 3, 4)], 222, 'bottom-band interior untouched');
});

test('composite() draws no x=0 line when only one arm reported', () => {
  // The x=0 line is arm 1's leading edge seen across the wrap, so a frame whose
  // only results start at x=0 has no vertical boundary at all.
  driver.W = 4; driver.H = 4;
  driver.pixels = new Uint16Array(4 * 4 * 3);

  const c = makeController();
  c.count = 4;
  c.showBoundaries = true;
  const band = (fill) => new Uint16Array(2 * 2 * 3).fill(fill);
  c.results = [
    { pixels: band(111), x0: 0, x1: 2, y0: 0, y1: 2 },
    { pixels: band(222), x0: 0, x1: 2, y0: 2, y1: 4 },
    null, null,
  ];

  c.composite();

  const isCyan = (x, y) => {
    const i = idx(x, y, 4);
    return driver.pixels[i] === 0 && driver.pixels[i + 1] === 65535 &&
           driver.pixels[i + 2] === 65535;
  };
  assert.ok(!isCyan(0, 0) && !isCyan(2, 0), 'no vertical seam is drawn');
  assert.ok([0, 1, 2, 3].every((x) => isCyan(x, 2)), 'the band seam is still marked');
  assert.equal(driver.pixels[idx(0, 0, 4)], 111, 'top-band interior untouched');
  assert.equal(driver.pixels[idx(2, 0, 4)], 0, 'the unreported arm stays black');
});

test('composite() self-heals a broken display-buffer alias instead of throwing', () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = makeController();
  const target = new Uint16Array(4 * 2 * 3);
  c.getMemoryView = () => target;
  c.results = [];

  assert.doesNotThrow(() => c.composite());
  assert.equal(driver.pixels, target,
    'driver.pixels re-pointed at the composite target');
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
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

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
  assert.ok(driver.pixels.some((v) => v === 111),
    'the composited quadrants reached the display buffer');
  assert.equal(c.renderInFlight, true, 'the following frame was dispatched');
  assert.equal(c.pending, 2);
});

test('each render dispatch hands the retired generation buffer back for reuse', async () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = readyController(2);
  c.showBoundaries = false;
  const lastRender = (w) => w.posted.filter((m) => m.type === 'render').at(-1);

  c.tick(); // dispatch generation A
  assert.ok(c.workers.every((w) => lastRender(w).recycle === undefined),
    'nothing is retired yet, so the first dispatch leaves the worker to allocate');

  const genA = [new Uint16Array(2 * 2 * 3).fill(111), new Uint16Array(2 * 2 * 3).fill(111)];
  deliverFrame(c, 0, { pixels: genA[0], x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: genA[1], x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  c.tick(); // composite A, dispatch B: A is the live generation, not retired
  assert.ok(c.workers.every((w) => lastRender(w).recycle === undefined),
    'the generation the compositor is displaying is never handed back');

  const genB = () => new Uint16Array(2 * 2 * 3).fill(222);
  deliverFrame(c, 0, { pixels: genB(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: genB(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  c.tick(); // composite B, dispatch C carrying generation A's retired buffers

  c.workers.forEach((w, s) => {
    assert.equal(lastRender(w).recycle, genA[s], `seg ${s} gets its own retired buffer back`);
    assert.deepEqual(w.transfers.at(-1), [genA[s].buffer],
      'the buffer is transferred, not structured-cloned');
    assert.equal(genA[s].buffer.byteLength, 0,
      `seg ${s}'s retired buffer is detached on the controller side`);
  });
  assert.ok(c.results.every((r) => r.pixels.byteLength > 0 && r.pixels[0] === 222),
    'the displayed generation is still attached and untouched by the recycle');
  assert.ok(c.scratch.every((slot) => slot === null),
    'every staging slot is cleared as its buffer is consumed');
});

test('tick() re-blits the last composite when a render overruns the tick (preview holds, not black)', async () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  c.tick(); // composite the armed frame, dispatch the next (now in flight)
  assert.equal(c.pendingFrame, false);
  assert.equal(c.renderInFlight, true, 'the next render is in flight and will overrun');

  // driver.stepSimulation() clears the buffer before each tick.
  driver.pixels.fill(0);
  // Overrun tick: render still in flight, no new pendingFrame.
  c.tick();

  assert.ok(driver.pixels.some((v) => v === 111),
    'the last composite is re-blitted so the preview holds instead of flashing black');
  assert.equal(c.frameComposited, false,
    'a re-blit is not a new frame; the recorder must not capture a duplicate');
});

test('an overrun re-blit shows one whole generation, never a half-updated mix', async () => {
  // While the next generation is only partially in, its quadrants live in
  // `scratch`; an overrun re-blit must composite the last WHOLE generation from
  // `results`, never a mix of the two.
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({ unref() {} }); // stub the render watchdog
  try {
    const c = readyController(2);
    c.showBoundaries = false;
    c.tick(); // dispatch generation A

    const genA = () => new Uint16Array(2 * 2 * 3).fill(111);
    deliverFrame(c, 0, { pixels: genA(), x0: 0, x1: 2, y0: 0, y1: 2 });
    deliverFrame(c, 1, { pixels: genA(), x0: 2, x1: 4, y0: 0, y1: 2 });
    await flush();
    c.tick(); // composite generation A, dispatch generation B (now in flight)
    assert.equal(c.renderInFlight, true, 'generation B is in flight and will overrun');

    // Generation B arrives only partially: seg 0 reports, seg 1 still rendering.
    deliverFrame(c, 0, { pixels: new Uint16Array(2 * 2 * 3).fill(222), x0: 0, x1: 2, y0: 0, y1: 2 });
    assert.equal(c.pending, 1, 'generation B still has one segment outstanding');
    assert.ok(c.scratch[0] && c.scratch[0].pixels[0] === 222,
      'the partial next generation is staged in scratch, not results');
    assert.equal(c.renderInFlight, true, 'the swap has not run, so results is still generation A');

    driver.pixels.fill(0); // driver.stepSimulation() clears before the overrun tick
    c.tick(); // overrun: no new pendingFrame, so re-blit the last whole generation

    assert.ok(!driver.pixels.some((v) => v === 222),
      'the partially-arrived generation B never leaks into the re-blit');
    assert.equal(driver.pixels[idx(0, 0, 4)], 111, 'quadrant 0 holds generation A');
    assert.equal(driver.pixels[idx(2, 0, 4)], 111, 'quadrant 1 holds generation A');
    assert.equal(c.frameComposited, false, 're-blit is not a new frame');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('destroy() clears frameComposited so a respawning pool cannot capture black frames', async () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();
  c.tick();
  assert.equal(c.frameComposited, true, 'a real composite latched the flag');

  c.destroy();
  assert.equal(c.frameComposited, false, 'destroy() cleared the latch');

  c.tick(); // pool not ready yet: tick() returns before touching the flag
  assert.equal(c.frameComposited, false, 'the flag stays clear while the pool respawns');
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

test('a fault latched by composite() mid-tick() does not re-dispatch a doomed render', async () => {
  // The fence-escaping out-of-bounds result faults inside composite(), so the pool
  // is clean at tick() entry and only latches partway through — the post-composite
  // faulted re-check is what stops the second render.
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { x0: 2, x1: 99, y0: 0, y1: 2 }); // x1=99 overshoots W=4
  await flush();
  assert.equal(c.pendingFrame, true);
  assert.equal(c.faulted, false, 'not yet faulted at tick() entry');

  const before = c.workers.map((w) => w.posted.length);
  c.tick();

  assert.equal(c.faulted, true, 'composite() latched the fault during tick()');
  assert.equal(c.renderInFlight, false, 'no render dispatched to the just-faulted pool');
  c.workers.forEach((w, i) =>
    assert.equal(w.posted.length, before[i], 'no new render broadcast'));
});

test('a fault latched by the overrun re-blit paints the overlay on the same tick', async () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => ({ unref() {} }); // stub the render watchdog
  try {
    const c = readyController(2);
    c.showBoundaries = false;
    c.tick(); // dispatch generation A

    deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
    deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
    await flush();
    c.tick(); // composite A, dispatch B (in flight, so the next tick overruns)

    // Corrupt the published generation so the overrun re-blit's pre-pass faults.
    c.results[1] = { ...c.results[1], x1: 99 };
    let statsShown = 0;
    c.updateStats = () => { statsShown++; };

    c.tick(); // overrun branch: composite() latches the fault mid-tick
    assert.equal(c.faulted, true, 'the re-blit pre-pass latched the fault');
    assert.equal(statsShown, 1, 'the overlay painted on the faulting tick, not the next one');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
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

/**
 * Minimal DOM element stand-in covering the overlay surface updateStats() uses.
 * @returns {Object} A fake element recording attributes, children, and focus calls.
 */
const makeElement = () => {
  const attributes = new Map();
  return {
    style: {},
    children: [],
    focusCount: 0,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) || null; },
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...children) { this.children = children; },
    focus() { this.focusCount++; },
    get firstElementChild() {
      return this.children.find((child) => typeof child === 'object') || null;
    },
  };
};

test('the fault overlay is an alert focused once for recovery', () => {
  const stats = makeElement();
  const c = makeController();
  c.statsView.doc = {
    getElementById: (id) => id === 'segment-stats' ? stats : null,
    createElement: makeElement,
  };
  c.active = true;
  c.faulted = true;
  c.faultInfo = { segId: 0, message: 'boom' };

  c.updateStats();

  const alert = stats.firstElementChild;
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.equal(alert.tabIndex, -1);
  assert.equal(alert.focusCount, 1);

  c.updateStats();
  assert.equal(stats.firstElementChild, alert);
  assert.equal(alert.focusCount, 1);
});

test('a spawning pool reports the spawn and does not own the display', () => {
  const stats = makeElement();
  const c = makeController();
  c.statsView.doc = {
    getElementById: (id) => id === 'segment-stats' ? stats : null,
    createElement: makeElement,
  };
  c.active = true;
  c.count = 4;

  assert.equal(c.ownsDisplay, false, 'a spawning pool leaves the frame to the main engine');

  c.updateStats();
  const status = stats.firstElementChild;
  assert.equal(status.getAttribute('role'), 'status');
  assert.match(status.children.join(''), /4 workers/);

  c.updateStats();
  assert.equal(stats.firstElementChild, status, 'the status row is not rebuilt every frame');

  c.ready = true;
  assert.equal(c.ownsDisplay, true, 'a ready pool owns the display');
  c.ready = false;
  c.faulted = true;
  assert.equal(c.ownsDisplay, true, 'a faulted pool keeps the display for its overlay');
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

test('fakeEngine mocks only methods the real engine surface pins', () => {
  assert.deepEqual(unpinnedEngineMethods(fakeEngine([])), [],
    'engine_contract_wasm.test.js never checks these against the real module');
});

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
    assert.equal(msgs[0].paused, false);
  }
});

test('setEffect carries the current pause state through the worker rebuild', () => {
  const c = readyController(2);
  c.setAnimationsPaused(true);
  for (const w of c.workers) w.posted.length = 0;

  c.setEffect('NewEffect');

  assert.equal(c.animationsPaused, true);
  for (const w of c.workers) {
    const msg = w.posted.find((m) => m.type === 'setEffect');
    assert.equal(msg.paused, true);
  }
});

test('setEffect drops the outgoing effect param values so the rebuilt GUI is not bound by index', () => {
  const c = readyController(2);
  c.paramValues = [0.1, 0.2, 0.3];
  c.setEffect('NewEffect');
  assert.equal(c.getParamValues(), null,
    'stale values are cleared until segment 0 reports the new effect first frame');
});

test('setEffect bumps renderGen so an in-flight old-effect frame is fenced out', () => {
  const c = readyController(2);
  const before = c.renderGen;
  c.setEffect('NewEffect');
  assert.equal(c.renderGen, before + 1,
    'a stale in-flight frame now fails inflightGen === renderGen');
});

// A resize drops the worker's effect and its clip, and the worker cannot re-clip
// without one; a pool left that way renders correctly-sized black frames that
// pass every fence, watchdog and composite check.
test('setResolution re-applies the effect so no worker is left unclipped', () => {
  const c = readyController(2, { effect: 'Ribbons' });
  c.getWasmEngine = () => fakeEngine([{ name: 'Speed', value: 0.25 }]);

  c.setResolution(8, 8);

  for (const w of c.workers) {
    assert.deepEqual(w.posted.map((m) => m.type),
      ['init', 'setResolution', 'setEffect'],
      'the resize is followed by the effect rebuild that restores the clip');
    assert.equal(w.posted[2].name, 'Ribbons', 'the active effect is restored');
    assert.deepEqual(w.posted[2].params, [{ name: 'Speed', value: 0.25 }],
      'tuned values ride along so the rebuild does not land on defaults');
    assert.equal(w.posted[2].paused, false);
  }
});

test('setResolution carries pause state into its trailing effect rebuild', () => {
  const c = readyController(2, { effect: 'Ribbons' });
  c.setAnimationsPaused(true);
  for (const w of c.workers) w.posted.length = 0;

  c.setResolution(8, 8);

  for (const w of c.workers) {
    const msg = w.posted.find((m) => m.type === 'setEffect');
    assert.equal(msg.paused, true);
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

// The aggressiveness is a per-module-instance global in the engine, so a value
// pushed only to the main thread leaves the composited preview decimating
// differently from the slider it is calibrated on.
test('setPoleLod records the value and broadcasts it to every worker', () => {
  const c = readyController(2);
  assert.equal(c.poleLod, 0, 'decimation off by default');

  c.setPoleLod(1.5);

  assert.equal(c.poleLod, 1.5, 'controller remembers the slider value');
  for (const w of c.workers) {
    const msgs = w.posted.filter((m) => m.type === 'setPoleLod');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].value, 1.5);
  }
});

test('a pool spawned after the slider moved inherits the pole LOD', () => {
  const c = makeController();
  c.setPoleLod(0.8);
  c.create(2);

  for (const w of c.workers) {
    const init = w.posted.find((m) => m.type === 'init');
    assert.equal(init.poleLod, 0.8, 'init seeds the fresh worker engine');
  }
});

test('create with an unknown resolution latches a pool fault', () => {
  const c = makeController({ resolution: 'nope' });
  c.active = true;
  c.create(4);

  assert.equal(c.faulted, true);
  assert.equal(c.faultInfo.segId, -1, 'no single worker to blame');
  assert.match(c.faultInfo.message, /unknown resolution "nope"/);
  assert.equal(c.ownsDisplay, true, 'the fault overlay owns the display');
  assert.deepEqual(c.workers, [], 'no workers were spawned');
  assert.equal(c.count, 4);
  for (const arr of [c.results, c.scratch, c.timings, c.arenas, c.frameSeen]) {
    assert.equal(arr.length, c.count, 'count matches the per-segment array lengths');
  }
});

test('create with a layout-illegal segment count latches a pool fault', () => {
  for (const bad of [3, 0, -2, 2.5, NaN]) {
    const c = makeController();
    c.active = true;
    c.create(bad);

    assert.equal(c.faulted, true, `count ${bad} faults`);
    assert.equal(c.faultInfo.segId, -1, 'no single worker to blame');
    assert.match(c.faultInfo.message, /invalid segment count/);
    assert.deepEqual(c.workers, [], 'no workers were spawned');
  }
});
