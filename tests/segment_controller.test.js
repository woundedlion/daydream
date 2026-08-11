//
// SegmentController — unit coverage for the generation-fence drop, the
// worker-fault deadlock-break latch, and the quadrant compositor. Driven by a
// fake Worker and a fake driver injected as a constructor dependency.
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { unpinnedEngineMethods } from './fake_engine.js';
import { fakeElement } from './fake_dom.js';
import { fakeColorAttribute } from './fake_three.js';
import { repointDisplayAliases } from '../app_lifecycle.js';

// Stand-in for the injected Daydream renderer: the grid and display buffer the
// compositor reads, plus the dot mesh the second display alias lives on.
const driver = {
  W: 0, H: 0, pixels: null,
  dotMesh: { instanceColor: fakeColorAttribute(null) },
};


const {
  SegmentController,
  SEGMENT_CONTROLLER_API_VERSION,
  MAX_BOOT_RETRIES,
  MAX_FAULTED_REBUILDS,
  BOOT_RETRY_DELAY_MS,
  BOOT_WATCHDOG_MS,
  INIT_WATCHDOG_MS,
  RENDER_WATCHDOG_MS,
  WARM_INTERVAL_MS,
  maxSegmentCount,
  warmModules,
} = await import('../segment_controller.js');
const { PROTOCOL_VERSION } = await import('../worker_protocol.js');

test('segment controller publishes its composition-root API version', () => {
  assert.equal(SEGMENT_CONTROLLER_API_VERSION, 1);
});

const EXPECTED_CONSOLE_MESSAGES = {
  log: [
    /^\[Segmented\] Spawning \d+ workers\.\.\.$/,
    /^\[Segmented\] All \d+ workers ready$/,
  ],
  warn: [
    /^\[Segmented\] seg \d+ module failed to load \(attempt \d+\/\d+\); rebuilding pool$/,
    /^\[Segmented\] additional worker fault \(seg -?\d+\): /,
    /^\[Segmented\] pool faulted on \d+ consecutive effect-switch rebuilds; /,
    /^\[Segmented\] shared WASM compile failed; each worker will compile its own$/,
  ],
  error: [
    /^\[Segmented\] Worker seg \d+ error:/,
    /^\[Segmented\] Worker seg \d+ message deserialization failed$/,
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

test('warmModules revalidates the worker, glue, and binary cache entries', async () => {
  const calls = [];
  const response = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  await warmModules({
    baseUrl: 'http://localhost:8000/segment_controller.js',
    minIntervalMs: 0,
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
  // 'reload' would re-download all 1.8 MB per call; 'no-cache' still refetches a
  // rebuilt binary because the artifacts are served unversioned.
  for (const [, options] of calls)
    assert.deepEqual(options, { cache: 'no-cache' });
});

test('warmModules skips a re-warm inside the dedupe window', async () => {
  let calls = 0;
  const response = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  const deps = {
    baseUrl: 'http://localhost:8000/segment_controller.js',
    fetch: () => { calls++; return Promise.resolve(response); },
  };
  await warmModules({ ...deps, minIntervalMs: 0 });
  assert.equal(calls, 3, 'a forced warm fetches the whole module graph');

  await warmModules({ ...deps, minIntervalMs: WARM_INTERVAL_MS });
  assert.equal(calls, 3, 'a slider-drag re-warm reuses the previous warm');

  await warmModules({ ...deps, minIntervalMs: 0 });
  assert.equal(calls, 6, 'a warm past the window fetches again');
});

test('the dedupe window covers one base URL, not every caller in it', async () => {
  const seen = [];
  const response = { arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
  const deps = {
    fetch: (url) => { seen.push(url.href); return Promise.resolve(response); },
  };
  await warmModules({
    ...deps, minIntervalMs: 0,
    baseUrl: 'http://localhost:8000/first/segment_controller.js',
  });
  seen.length = 0;

  // Another base URL is another module graph: serving it the first warm's
  // promise would report a warm of files it never fetched.
  await warmModules({
    ...deps, minIntervalMs: WARM_INTERVAL_MS,
    baseUrl: 'http://localhost:8000/second/segment_controller.js',
  });
  assert.deepEqual(seen, [
    'http://localhost:8000/second/segment_worker.js',
    'http://localhost:8000/second/holosphere_wasm.js',
    'http://localhost:8000/second/holosphere_wasm.wasm',
  ], 'a second base URL inside the window warms its own module graph');

  seen.length = 0;
  await warmModules({
    ...deps, minIntervalMs: WARM_INTERVAL_MS,
    baseUrl: 'http://localhost:8000/second/segment_controller.js',
  });
  assert.deepEqual(seen, [], 'a repeat of that base URL still dedupes');
});

test('a warm whose fetch throws synchronously does not claim the window', async () => {
  const baseUrl = 'http://localhost:8000/offline/segment_controller.js';
  await warmModules({
    baseUrl, minIntervalMs: 0,
    fetch: () => { throw new TypeError('network down'); },
  });

  let calls = 0;
  await warmModules({
    baseUrl, minIntervalMs: WARM_INTERVAL_MS,
    fetch: () => {
      calls++;
      return Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    },
  });
  assert.equal(calls, 3,
    'the throw warmed nothing, so the next call must not be handed a settled promise');
});

// The smallest valid module — the header alone. Compiling a real one is what
// shows the init message can carry a WebAssembly.Module across the boundary.
const EMPTY_WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

test('a warmed binary is compiled once and handed to every worker', async () => {
  await warmModules({
    baseUrl: 'http://localhost:8000/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url) => Promise.resolve({
      arrayBuffer: () => Promise.resolve(
        url.href.endsWith('.wasm') ? EMPTY_WASM.buffer : new ArrayBuffer(0)),
    }),
  });

  const c = makeController();
  c.create(2);
  const modules = FakeWorker.instances
    .map((w) => w.posted.find((m) => m.type === 'init').wasmModule);
  for (const compiled of modules) {
    assert.ok(compiled instanceof WebAssembly.Module,
      'each worker gets the compilation instead of fetching and compiling its own');
  }
  assert.equal(new Set(modules).size, 1, 'one compilation, shared');
  c.destroy();
});

test('a binary the engine refuses is reported, not left to the spawn to discover', async () => {
  const warned = [];
  const stub = mock.method(console, 'warn', (...args) => { warned.push(args); });
  try {
    await warmModules({
      baseUrl: 'http://localhost:8000/corrupt/segment_controller.js',
      minIntervalMs: 0,
      fetch: (url) => Promise.resolve({
        arrayBuffer: () => Promise.resolve(url.href.endsWith('.wasm')
          ? Uint8Array.of(0, 0x61, 0x73, 0x6d, 9, 9, 9, 9).buffer
          : new ArrayBuffer(0)),
      }),
    });
  } finally {
    stub.mock.restore();
  }

  assert.equal(warned.length, 1, 'the compile rejection reached no diagnostic');
  assert.match(String(warned[0][0]), /shared WASM compile failed/);
  assert.ok(warned[0][1] instanceof Error,
    'the rejection is carried, so the operator sees why it failed');
});

test('a device cap moves with the memory hint and the mobile layout', () => {
  assert.equal(maxSegmentCount({}, false), 8,
    'no hint (Firefox/Safari) on a desktop layout keeps the full range');
  assert.equal(maxSegmentCount({ deviceMemory: 8 }, false), 8);
  assert.equal(maxSegmentCount({ deviceMemory: 4 }, false), 4);
  assert.equal(maxSegmentCount({ deviceMemory: 0.5 }, false), 2);
  // Without deviceMemory the narrow layout is the only phone signal there is.
  assert.equal(maxSegmentCount({}, true), 4);
  assert.equal(maxSegmentCount({ deviceMemory: 8 }, true), 4,
    'the lower of the two caps wins');
  for (const gib of [undefined, 0.25, 1, 2, 3, 4, 6, 8, 64])
    for (const mobile of [false, true]) {
      const cap = maxSegmentCount({ deviceMemory: gib }, mobile);
      assert.equal(cap % 2, 0, `cap ${cap} must stay layout-legal (even)`);
      assert.ok(cap >= 2 && cap <= 8, `cap ${cap} must stay inside the slider range`);
    }
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
    repointDisplayAliases: (view) => repointDisplayAliases(driver, view),
  });
}

beforeEach(() => {
  driver.W = 0;
  driver.H = 0;
  driver.pixels = null;
  // A fresh attribute per test: the length invariant binds at first upload and
  // the cases below composite at different grid sizes.
  driver.dotMesh.instanceColor = fakeColorAttribute(null);
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
 * @typedef {Object} FakeTimer
 * @property {Function} fn - Callback the production code scheduled.
 * @property {number} delay - Delay it was scheduled at, which names it: each
 *   deadline in segment_controller.js has a distinct one.
 * @property {object} handle - Token setTimeout returned, keyed on by clearTimeout.
 */

/**
 * Swap in a setTimeout/clearTimeout pair that records timers instead of
 * scheduling them, so a test drives the watchdogs and boot backoff by hand and
 * can see a cancellation. A cleared or fired timer leaves the pending set but
 * stays in `timers`, which holds every arm in order.
 * @returns {{timers: Array<FakeTimer>, pendingAt: (delay: number) => Array<FakeTimer>,
 *   isPending: (timer: FakeTimer) => boolean, fire: (timer: FakeTimer) => void,
 *   fireOnly: (delay: number, message: string) => void, restore: () => void}}
 */
const installFakeTimers = () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  /** @type {Array<FakeTimer>} */
  const timers = [];
  /** @type {Map<object, FakeTimer>} */
  const pending = new Map();
  globalThis.setTimeout = (fn, delay) => {
    const handle = { unref() {} };
    const timer = { fn, delay, handle };
    timers.push(timer);
    pending.set(handle, timer);
    return handle;
  };
  // A handle armed before the swap belongs to the real timer queue, so hand it
  // back rather than silently dropping the cancellation.
  globalThis.clearTimeout = (handle) => {
    if (pending.delete(handle)) return;
    realClearTimeout(handle);
  };
  const isPending = (timer) => pending.has(timer.handle);
  const fire = (timer) => {
    pending.delete(timer.handle);
    timer.fn();
  };
  const pendingAt = (delay) =>
    [...pending.values()].filter((timer) => timer.delay === delay);
  const fireOnly = (delay, message) => {
    const matches = pendingAt(delay);
    assert.equal(matches.length, 1, message);
    fire(matches[0]);
  };
  return {
    timers,
    pendingAt,
    isPending,
    fire,
    fireOnly,
    restore: () => {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
};

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
 * @param {number} [overrides.paramRevision] - Parameter write revision paired with the frame.
 * @param {boolean} [overrides.fullFrame] - Whether the worker shaded the whole canvas.
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
      paramGeneration: overrides.paramGeneration ?? null,
      paramRevision: overrides.paramRevision ?? controller.paramRevision,
      presetCount: overrides.presetCount ?? null,
      presetIndex: overrides.presetIndex ?? null,
      fullFrame: overrides.fullFrame ?? false,
    },
  });
}

// ---------------------------------------------------------------------------
// The `active` flag
// ---------------------------------------------------------------------------

// The flag is read as a condition by the host's spawn guard and by ownsDisplay,
// so a truthy non-boolean reads as enabled everywhere it is consumed.
test('active rejects a non-boolean write and keeps its prior value', () => {
  const c = makeController();
  assert.equal(c.active, false, 'a fresh controller is inactive');

  for (const bad of ['true', 1, {}, null, undefined]) {
    assert.throws(() => { c.active = bad; }, TypeError,
      `active must reject ${JSON.stringify(bad) ?? String(bad)}`);
    assert.equal(c.active, false, 'a rejected write must not land');
  }

  c.active = true;
  assert.equal(c.active, true, 'a boolean write lands');
  assert.throws(() => { c.active = 0; }, TypeError,
    'active must reject a falsy non-boolean too');
  assert.equal(c.active, true, 'a rejected write must not clear the flag');
  c.active = false;
  assert.equal(c.active, false, 'a boolean write clears the flag');
});

// The pool stays latched across a fault so a user-driven setEffect/setResolution
// can rebuild it; only the host clears the flag.
test('destroy() and a fault leave active alone', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  c.onWorkerFault(0, 'boom');
  assert.equal(c.faulted, true, 'the fault latched');
  assert.equal(c.active, true, 'a fault must not clear active');
  c.destroy();
  assert.equal(c.active, true, 'destroy() must not clear active');
  assert.equal(c.ownsDisplay, false, 'a destroyed pool owns no display');
});

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

/**
 * A needs_full_frame() effect makes every worker shade the whole canvas, so the
 * pool is not N-way parallel even though each 'frame' still names a band. The
 * per-segment flag is the only thing that separates the two.
 */
test('the clip disposition each worker reports is published per segment', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();
  assert.deepEqual(c.fullFrames, [false, false], 'a dispatch starts every segment clipped');

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2, fullFrame: true });
  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
  assert.deepEqual(c.fullFrames, [true, false]);
  await done;

  c.renderParallel();
  assert.deepEqual(c.fullFrames, [false, false],
    'a segment that goes silent must not keep a prior generation flag');
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

test('a segment-0 frame publishes paired param values and generation for the GUI', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();
  assert.equal(c.getParamValues(), null, 'nothing published before the first frame');
  assert.equal(c.getParamGeneration(), null);

  deliverFrame(c, 0, { paramValues: [0.25, 1], paramGeneration: 7,
    presetCount: 6, presetIndex: 4 });
  assert.deepEqual(c.getParamValues(), [0.25, 1],
    'segment 0 mirrors its post-frame params into the controller');
  assert.equal(c.getParamGeneration(), 7);
  assert.equal(c.getPresetCount(), 6);
  assert.equal(c.getPresetIndex(), 4);

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

test('an in-flight frame cannot republish parameter values from before a GUI write', async () => {
  const c = makeController();
  c.create(2);

  let done = c.renderParallel();
  deliverFrame(c, 0, { paramValues: [0.25], paramGeneration: 7 });
  deliverFrame(c, 1);
  await done;
  assert.deepEqual(c.getParamValues(), [0.25]);

  done = c.renderParallel();
  const staleRevision = c.paramRevision;
  c.setParameter('Speed', 0.75);
  assert.equal(c.getParamValues(), null,
    'the previous snapshot is withheld until a worker acknowledges the write');

  deliverFrame(c, 0, {
    paramValues: [0.25], paramGeneration: 7, paramRevision: staleRevision,
  });
  assert.equal(c.getParamValues(), null,
    'a frame rendered before the write cannot move the slider back');
  deliverFrame(c, 1, { paramRevision: staleRevision });
  await done;

  done = c.renderParallel();
  deliverFrame(c, 0, { paramValues: [0.75], paramGeneration: 7 });
  assert.deepEqual(c.getParamValues(), [0.75],
    'the first frame at the current revision resumes GUI synchronization');
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
    assert.equal(init.paramRevision, c.paramRevision);
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

test('a frame with a non-integer segId faults instead of stalling the barrier', async () => {
  // Each of these fails both range comparisons, so a range-only guard would let
  // it index by string key and decrement `pending` for an absent segment.
  for (const segId of [undefined, NaN, null, '1', 1.5]) {
    const c = makeController();
    c.create(2);
    const done = c.renderParallel();

    deliverFrameWithSegId(c, 0, segId);
    assert.equal(c.faulted, true, `segId ${String(segId)} faults the pool`);
    assert.equal(c.faultInfo.segId, 0, 'the fault names the worker that sent it');
    assert.ok(c.faultInfo.message.includes(`tagged segId ${String(segId)}`),
      `the fault names the offending id, not just a stall: ${c.faultInfo.message}`);
    assert.deepEqual(c.scratch, [null, null],
      `segId ${String(segId)} must not write a staging slot`);
    assert.deepEqual(c.frameSeen, [false, false],
      `segId ${String(segId)} must not mark a segment seen`);
    assert.equal(c.pending, 0,
      'the fault settles the frame rather than leaving it to the render watchdog');
    await done;
  }
});

test('a frame tagged with another segment id faults the pool', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();

  // In range and an integer, but not this worker's index: staging it would fill
  // segment 1's slot from segment 0's pixels and leave 1 outstanding.
  deliverFrameWithSegId(c, 0, 1);
  assert.equal(c.faulted, true, 'a mis-tagged frame faults rather than freezing the preview');
  assert.equal(c.faultInfo.segId, 0, 'the fault names the worker that sent it');
  assert.ok(c.faultInfo.message.includes('tagged segId 1'),
    `the fault names the offending id: ${c.faultInfo.message}`);
  assert.deepEqual(c.scratch, [null, null], 'no staging slot is written');
  assert.deepEqual(c.frameSeen, [false, false], 'no segment is marked seen');
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
  const clock = installFakeTimers();
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
    assert.deepEqual(clock.pendingAt(BOOT_WATCHDOG_MS), [],
      'the torn-down pool leaves no boot watchdog to fault the rebuild');
    assert.deepEqual(clock.pendingAt(INIT_WATCHDOG_MS), [],
      'the torn-down pool leaves no init watchdog to fault the rebuild');

    clock.fireOnly(BOOT_RETRY_DELAY_MS, 'exactly one backoff rebuild is scheduled');
    assert.equal(c.bootAttempt, 1, 'retry index advanced');
    assert.equal(c.faulted, false);
    assert.equal(c.workers.length, 2, 'pool respawned at the same segment count');
    assert.notEqual(c.workers[0], firstPool[0], 'rebuilt with fresh workers');
  } finally {
    clock.restore();
  }
});

test('a bare-Event boot fault latches once the retry budget is exhausted', () => {
  const clock = installFakeTimers();
  try {
    const c = makeController();
    c.active = true;
    c.create(2);

    for (let a = 0; a < MAX_BOOT_RETRIES; a++) {
      c.workers[0].onerror({});
      assert.equal(c.faulted, false, `attempt ${a + 1} retries rather than latching`);
      clock.fireOnly(BOOT_RETRY_DELAY_MS, `attempt ${a + 1} scheduled one rebuild`);
      assert.equal(c.bootAttempt, a + 1);
    }
    // One failure past the budget must latch instead of retrying forever.
    c.workers[0].onerror({});
    assert.equal(c.faulted, true, 'a load fault past the retry budget latches');
    assert.equal(c.faultInfo.segId, 0);
    assert.deepEqual(clock.pendingAt(BOOT_RETRY_DELAY_MS), [],
      'the latched pool schedules no further rebuild');
  } finally {
    clock.restore();
  }
});

test('a message-less error after the pool is ready still latches fast', () => {
  // Post-ready there is no module to load, so a bare Event is a real worker fault.
  const c = readyController(2);
  c.workers[0].onerror({});
  assert.equal(c.faulted, true);
});

test('the startup and render deadlines hold their documented durations', () => {
  assert.deepEqual(
    {
      retry: BOOT_RETRY_DELAY_MS,
      render: RENDER_WATCHDOG_MS,
      boot: BOOT_WATCHDOG_MS,
      init: INIT_WATCHDOG_MS,
    },
    { retry: 250, render: 5000, boot: 10000, init: 20000 },
  );
  // Init covers boot plus the WASM instantiate, so it must outlast boot or a
  // slow-but-healthy load reports as an init timeout.
  assert.ok(INIT_WATCHDOG_MS > BOOT_WATCHDOG_MS,
    'the init deadline outlasts the boot deadline it contains');
  assert.equal(
    new Set([BOOT_RETRY_DELAY_MS, RENDER_WATCHDOG_MS, BOOT_WATCHDOG_MS, INIT_WATCHDOG_MS]).size,
    4,
    'distinct delays, so a test can name a scheduled timer by the deadline it holds');
});

test('the boot watchdog faults fast when a worker never sends booted', () => {
  const clock = installFakeTimers();
  try {
    const c = makeController();
    c.create(2);
    clock.fireOnly(BOOT_WATCHDOG_MS, 'one boot watchdog armed at the boot deadline');
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /module load timed out/);
    assert.match(c.faultInfo.message, /0\/2 booted/);
    assert.match(c.faultInfo.message, /holosphere_wasm\.js/);
  } finally {
    clock.restore();
  }
});

test('the boot watchdog names the segments that never booted', () => {
  const clock = installFakeTimers();
  try {
    const c = makeController();
    c.create(4);
    deliverBooted(c, 0); // only seg 0 boots; 1..3 hang
    clock.fireOnly(BOOT_WATCHDOG_MS, 'one boot watchdog armed at the boot deadline');
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /1\/4 booted/);
    assert.match(c.faultInfo.message, /never booted: 1, 2, 3/);
    assert.equal(c.faultInfo.segId, -1, 'multiple missing -> pool-wide segId');
  } finally {
    clock.restore();
  }
});

test('a single missing segment is named directly in the watchdog fault', () => {
  const clock = installFakeTimers();
  try {
    const c = makeController();
    c.create(2);
    deliverBooted(c, 0);
    deliverReady(c, 0); // seg 0 fully up; seg 1 never readies
    clock.fireOnly(INIT_WATCHDOG_MS, 'one init watchdog armed at the init deadline');
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /never ready: 1/);
    assert.equal(c.faultInfo.segId, 1);
  } finally {
    clock.restore();
  }
});

test('the render watchdog faults when a worker accepts render but stops progressing', async () => {
  const c = readyController(2);
  const clock = installFakeTimers();
  try {
    const done = c.renderParallel();
    deliverFrame(c, 0); // only seg 0 replies; seg 1 hangs
    assert.equal(c.pending, 1, 'one segment still outstanding');
    // The re-armed watchdog fires with seg 1 still hung.
    clock.fireOnly(RENDER_WATCHDOG_MS, 'one render watchdog armed at the render deadline');
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /render stalled/);
    assert.match(c.faultInfo.message, /1\/2 segments responded/);
    assert.equal(c.faultInfo.segId, -2,
      'render-timeout sentinel, distinct from the pool-init -1');
    assert.equal(c.pending, 0, 'fault settles pending so the loop cannot deadlock');
    assert.equal(c.renderWatchdog, null);
    await done; // onWorkerFault resolved the in-flight frame
  } finally {
    clock.restore();
  }
});

test('a progress frame re-arms the render watchdog so a slow render does not fault', async () => {
  const c = readyController(2);
  const clock = installFakeTimers();
  try {
    const done = c.renderParallel();
    assert.equal(clock.timers.length, 1, 'watchdog armed once at dispatch');
    const atDispatch = clock.timers[0];
    assert.equal(atDispatch.delay, RENDER_WATCHDOG_MS, 'armed at the render deadline');
    deliverFrame(c, 0); // one segment reports; the other is still rendering
    assert.equal(c.pending, 1);
    assert.equal(clock.timers.length, 2, 'watchdog re-armed on the progress frame');
    assert.equal(clock.isPending(atDispatch), false,
      're-arming cancels the dispatch watchdog rather than leaving two running');
    assert.equal(clock.pendingAt(RENDER_WATCHDOG_MS).length, 1,
      'exactly one render watchdog is live across the re-arm');
    assert.notEqual(c.renderWatchdog, null);
    deliverFrame(c, 1); // the slow segment finally reports
    assert.equal(c.pending, 0);
    assert.equal(c.renderWatchdog, null, 'watchdog cleared once the frame settles');
    assert.deepEqual(clock.pendingAt(RENDER_WATCHDOG_MS), [],
      'the re-armed watchdog is cancelled too, not just dropped');
    assert.equal(c.faulted, false);
    await done;
  } finally {
    clock.restore();
  }
});

test('a completed render clears the render watchdog so it cannot fault later', async () => {
  const c = readyController(2);
  const clock = installFakeTimers();
  try {
    const done = c.renderParallel();
    assert.notEqual(c.renderWatchdog, null, 'watchdog armed at dispatch');
    assert.equal(clock.pendingAt(RENDER_WATCHDOG_MS).length, 1,
      'one render watchdog is scheduled at the render deadline');
    const [armed] = clock.pendingAt(RENDER_WATCHDOG_MS);
    deliverFrame(c, 0);
    deliverFrame(c, 1);
    assert.equal(c.pending, 0);
    assert.equal(c.renderWatchdog, null, 'watchdog cleared once the frame settles');
    // Dropping the handle is not enough: the callback must be off the timer
    // queue, or it faults a healthy pool a render deadline later.
    assert.equal(clock.isPending(armed), false, 'the armed callback was cancelled');
    assert.deepEqual(clock.pendingAt(RENDER_WATCHDOG_MS), [],
      'no render watchdog survives the completed frame');
    assert.equal(c.faulted, false);
    await done;

    // What an uncancelled callback costs: it survives into the next render,
    // where `pending` is nonzero again, and faults a pool that is progressing.
    const leftovers = clock.pendingAt(RENDER_WATCHDOG_MS);
    const next = c.renderParallel();
    for (const timer of leftovers) clock.fire(timer);
    assert.equal(c.faulted, false, 'no watchdog from the settled frame faults the next one');
    deliverFrame(c, 0);
    deliverFrame(c, 1);
    await next;
  } finally {
    clock.restore();
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

/**
 * Latch a worker throw on segment 0 of the live pool.
 * @param {SegmentController} controller - Controller owning the worker pool.
 * @returns {void}
 */
function faultSegZero(controller) {
  controller.workers[0].onerror({ message: 'x', filename: '', lineno: 0, colno: 0 });
}

// The Test All ticker switches effects on a 1 s interval, so a fault that
// reproduces on every rebuild would respawn the pool once per tick.
test('repeated effect switches on a refaulting pool spawn a bounded worker count', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  faultSegZero(c);
  const spawnedBefore = FakeWorker.constructionCount;

  for (let i = 0; i < 10; i++) {
    c.setEffect(`Effect${i}`);
    if (!c.faulted) faultSegZero(c);
  }

  assert.equal(FakeWorker.constructionCount - spawnedBefore, MAX_FAULTED_REBUILDS * 2,
    'rebuild spawns are bounded, not one pool per switch');
  assert.equal(c.faulted, true, 'the pool stays latched once the budget is spent');
});

test('a pool that reaches ready restores the faulted effect-switch budget', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  faultSegZero(c);
  for (let i = 0; i <= MAX_FAULTED_REBUILDS; i++) {
    c.setEffect(`Effect${i}`);
    if (!c.faulted) faultSegZero(c);
  }
  assert.equal(c.faulted, true, 'the budget is spent');

  // A resolution change is user-driven and stays unbounded, as the fault banner says.
  c.setResolution(8, 8);
  assert.equal(c.faulted, false, 'the resolution change rebuilt the latched pool');
  deliverReady(c, 0);
  deliverReady(c, 1);
  assert.equal(c.faultedRebuilds, 0, 'a live pool ends the faulted-rebuild run');

  faultSegZero(c);
  const spawnedBefore = FakeWorker.constructionCount;
  c.setEffect('AfterRecovery');
  assert.equal(c.faulted, false, 'a later switch rebuilds again');
  assert.equal(FakeWorker.constructionCount - spawnedBefore, 2, 'a fresh pool was spawned');
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

/**
 * Whether the boundary colour was drawn at (x,y) of the driver's display buffer.
 * @param {number} x - Pixel column.
 * @param {number} y - Pixel row.
 * @returns {boolean} True when the pixel is cyan.
 */
const isCyan = (x, y) => {
  const i = idx(x, y, driver.W);
  return driver.pixels[i] === 0 && driver.pixels[i + 1] === 65535 &&
         driver.pixels[i + 2] === 65535;
};

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
  assert.equal(driver.dotMesh.instanceColor.array, target,
    'the mesh alias the GPU reads is re-pointed too');
  assert.equal(driver.dotMesh.instanceColor.version, 1,
    'a re-pointed attribute nobody flagged uploads the old buffer forever');
});

test('composite() heals a diverged mesh alias even while driver.pixels is aligned', () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);
  // Split the alias pair: the GPU-side attribute reads a stale buffer while
  // driver.pixels still matches the composite target.
  driver.dotMesh.instanceColor = fakeColorAttribute(new Uint16Array(4 * 2 * 3));

  const c = makeController();
  c.results = [];

  c.composite();
  assert.equal(driver.dotMesh.instanceColor.array, driver.pixels,
    'the mesh alias the GPU reads is re-pointed at the composite target');
  assert.equal(driver.dotMesh.instanceColor.version, 1,
    'the heal flags the attribute for re-upload');
});

test('a controller cannot be built without a two-alias display repointer', () => {
  assert.throws(
    () => new SegmentController({
      resolutionPresets: { lo: { w: 4, h: 4 } },
      appState: { get: () => 'lo' },
      driver,
      getWasmEngine: () => null,
      refreshPixelView: () => {},
      getMemoryView: () => driver.pixels,
    }),
    /repointDisplayAliases is required/,
    'an omitted repointer would heal only half the alias pair',
  );
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

  const { restore } = installFakeTimers(); // the render watchdog never fires
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
    restore();
  }
});

test('a composite short one segment is not handed to the recorder as a frame', async () => {
  driver.W = 4; driver.H = 2;
  driver.pixels = new Uint16Array(4 * 2 * 3);

  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  const quad = () => new Uint16Array(2 * 2 * 3).fill(111);
  deliverFrame(c, 0, { pixels: quad(), x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { pixels: quad(), x0: 2, x1: 4, y0: 0, y1: 2 });
  await flush();

  // The whole-array swap publishes only generations that filled every slot, so
  // an empty one stands in for that invariant breaking.
  c.results[1] = null;
  c.tick();

  assert.ok(driver.pixels.some((v) => v === 111), 'the arrived segment still blits');
  assert.equal(driver.pixels[idx(2, 0, 4)], 0, 'the missing segment leaves its band black');
  assert.equal(c.frameComposited, false,
    'a frame with a black band would be recorded as complete');
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

  const { restore } = installFakeTimers(); // the render watchdog never fires
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
    restore();
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

const makeElement = (tag) => {
  const element = fakeElement(tag);
  element.focusCount = 0;
  element.focus = () => { element.focusCount++; };
  return element;
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

test('turning segmented mode off hands the global stat bars back', () => {
  // The overlay hides page-owned elements while it stands in for them, so the
  // hand-back rides on the flag rather than on a host remembering to repaint.
  const byId = {
    'segment-stats': makeElement(),
    'global-stats-desktop': makeElement(),
    'stats-bar': makeElement(),
  };
  const c = makeController();
  c.statsView.doc = {
    getElementById: (id) => byId[id] ?? null,
    createElement: makeElement,
  };

  c.active = true;
  c.updateStats();
  assert.equal(byId['global-stats-desktop'].style.display, 'none');
  assert.equal(byId['stats-bar'].style.display, 'none');

  c.active = false;

  assert.equal(byId['segment-stats'].style.display, 'none', 'the overlay stayed up');
  assert.equal(byId['global-stats-desktop'].style.display, '');
  assert.equal(byId['stats-bar'].style.display, '');
});

// ---------------------------------------------------------------------------
// Broadcast paths — setEffect / setParameter / setAnimationsPaused / snapshotParams
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for the WASM engine exposing just getParameterDefinitions().
 * @param {Array<{name: string, value: number|boolean}>} defs - Param defs.
 * @returns {{ getParameterDefinitions: () => Array }} Fake engine.
 */
function fakeEngine(defs, presetCount = 0, presetIndex = 0) {
  return {
    getParameterDefinitions: () => defs,
    getPresetCount: () => presetCount,
    getPresetIndex: () => presetIndex,
  };
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
    assert.equal(msgs[0].paramRevision, c.paramRevision);
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

// onWorkerFault terminates the pool but leaves `workers` populated, so an
// ungated follow-up posts into dead workers and reports nothing.
test('a faulted setResolution skips its trailing effect rebuild', () => {
  const c = readyController(2, { effect: 'Ribbons' });
  for (const w of c.workers) w.posted.length = 0;
  FakeWorker.failPostAt = 1;
  FakeWorker.failPostType = 'setResolution';

  c.setResolution(8, 8);

  assert.equal(c.faulted, true);
  assert.match(c.faultInfo.message, /broadcast of 'setResolution' to seg 1 failed/);
  for (const w of c.workers)
    assert.equal(w.posted.some((m) => m.type === 'setEffect'), false,
      'no setEffect follows the fault');
});

test('broadcast reports whether every worker accepted the message', () => {
  const c = readyController(2);
  assert.equal(c.broadcast({ type: 'setPoleLod', value: 1 }), true);

  FakeWorker.failPostAt = 1;
  FakeWorker.failPostType = 'setPoleLod';
  assert.equal(c.broadcast({ type: 'setPoleLod', value: 2 }), false);
});

test('setParameter broadcasts the name/value to every worker', () => {
  const c = readyController(2);
  c.setParameter('Speed', 0.75);
  for (const w of c.workers) {
    const msgs = w.posted.filter((m) => m.type === 'setParameter');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].name, 'Speed');
    assert.equal(msgs[0].value, 0.75);
    assert.equal(msgs[0].paramRevision, c.paramRevision);
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

test('selectPreset broadcasts one exact index and invalidates parameter state', () => {
  const c = readyController(2);
  c.presetCount = 6;
  c.paramValues = [1, 2];
  c.paramGeneration = 7;
  assert.equal(c.selectPreset(4), true);

  assert.equal(c.getPresetIndex(), 4);
  assert.equal(c.animationsPaused, true);
  assert.equal(c.getParamValues(), null);
  assert.equal(c.getParamGeneration(), null);
  for (const w of c.workers) {
    const msg = w.posted.find((m) => m.type === 'selectPreset');
    assert.equal(msg.index, 4);
    assert.equal(msg.paramRevision, c.paramRevision);
  }
});

test('selectPreset rejects an unavailable index without pausing', () => {
  const c = readyController(2);
  c.presetCount = 3;

  assert.equal(c.selectPreset(3), false);

  assert.equal(c.getPresetIndex(), null);
  assert.equal(c.animationsPaused, false);
  for (const w of c.workers) {
    assert.equal(w.posted.some((m) => m.type === 'selectPreset'), false);
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
    c.create(6);
    c.create(bad);

    assert.equal(c.faulted, true, `count ${bad} faults`);
    assert.equal(c.faultInfo.segId, -1, 'no single worker to blame');
    assert.match(c.faultInfo.message, /invalid segment count/);
    assert.deepEqual(c.workers, [], 'no workers were spawned');
    // The recovery rebuilds re-create() at `count`, so the banner has to name
    // the size they will actually spawn.
    assert.equal(c.count, 6, 'the rejected count does not become the pool size');
    assert.match(c.faultInfo.message, /a rebuild will use 6/);
  }
});
