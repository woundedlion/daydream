// SegmentController fault latch, worker faults, watchdogs and rebuild budgets.
import { installFakeTimers } from './helpers/fake_timers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeWorker } from './helpers/fake_worker.js';
import {
  MAX_BOOT_RETRIES,
  MAX_FAULTED_REBUILDS,
  BOOT_RETRY_DELAY_MS,
  BOOT_WATCHDOG_MS,
  INIT_WATCHDOG_MS,
  RENDER_WATCHDOG_MS,
} from '../src/segments/segment_controller.js';
import { ModuleWarmer, EMPTY_WASM } from './fixtures/module_warmer_fixture.js';
import { PROTOCOL_VERSION, FAULT_POOL, FAULT_RENDER } from '../src/segments/worker_protocol.js';
import {
  installSegmentControllerHarness,
  makeController,
  deliverReady,
  deliverBooted,
  readyController,
  flush,
  deliverFrame,
  fakeEngine,
} from './helpers/segment_controller_harness.js';

installSegmentControllerHarness();

// ---------------------------------------------------------------------------
// Fault latch (deadlock break)
// ---------------------------------------------------------------------------

test('a worker fault latches, zeroes pending, and resolves the in-flight frame', async () => {
  const c = readyController(2);
  c.tick();
  assert.equal(c.frameState.renderInFlight, true, 'a render is in flight');

  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 2 });

  assert.equal(c.faulted, true);
  assert.deepEqual(c.faultInfo, { segId: 0, message: 'boom' });
  assert.equal(c.frameState.pending, 0, 'pending zeroed so the loop cannot deadlock');
  assert.equal(c.frameState.renderInFlight, false);
  assert.equal(c.frameState.frameSettled, true);
  await flush();
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
  assert.equal(c.workers.length, 2, 'the terminated pool stays populated for the fault report');
  assert.equal(c.faulted, true, 'the latch is held so the UI still reports the fault');
  assert.deepEqual(c.faultInfo, { segId: 0, message: 'boom' });
});

test('create posts each worker the whole init payload', () => {
  const c = makeController({ effect: 'Plasma', presets: { lo: { w: 6, h: 3 } } });
  c.getWasmEngine = () => fakeEngine(
    [{ name: 'Speed', value: 0.5, requestedValue: 0.9, acceptedValue: 0.4 }], 6, 4);
  c.setParameter('Speed', 0.9);
  c.setAnimationsPaused(true);
  c.setPoleLod(1.5);
  c.create(4);

  c.workers.forEach((w, segId) => {
    assert.deepEqual(w.posted.filter((m) => m.type === 'init'), [{
      type: 'init',
      version: PROTOCOL_VERSION,
      segId,
      totalSegs: 4,
      w: 6,
      h: 3,
      effectName: 'Plasma',
      params: [{ name: 'Speed', value: 0.9, acceptedValue: 0.4 }],
      paused: true,
      presetIndex: 4,
      poleLod: 1.5,
      topCap: 0,
      bottomCap: 0,
      paramRevision: 1,
      wasmModule: undefined,
    }]);
  });
});

test('create spawns module workers from the segment worker URL', () => {
  const c = makeController();
  c.create(2);

  assert.equal(FakeWorker.instances.length, 2);
  for (const w of FakeWorker.instances) {
    assert.ok(String(w.url).endsWith('/segment_worker.js'),
      `spawned from ${w.url}`);
    // segment_worker.js uses static ESM imports: a classic worker fails to load
    // it, and reports only a message-less error event.
    assert.deepEqual(w.opts, { type: 'module' },
      'the worker is spawned as a module');
  }
});

test('create() moves count and the per-segment arrays to the pool it spawned', () => {
  const c = readyController(4);
  assert.equal(c.count, 4);
  assert.equal(c.workers.length, 4);
  assert.equal(c.frameState.results.length, 4);

  c.create(2);
  assert.equal(c.count, 2, 'count follows the rebuilt pool, never leads it');
  assert.equal(c.workers.length, 2);
  assert.equal(c.frameState.results.length, 2);
  assert.equal(c.frameState.frameSeen.length, 2);
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
  assert.equal(c.frameState.renderInFlight, false, 'the in-flight latch is released');
  assert.equal(c.frameState.pending, 0, 'the barrier cannot deadlock on the un-posted workers');
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
  c.setEffect('AfterResize');
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
  const c = readyController(2);
  c.tick();

  // A failed structured-clone deserialization fires onmessageerror, not onerror.
  c.workers[1].onmessageerror({ type: 'messageerror' });

  assert.equal(c.faulted, true);
  assert.deepEqual(c.faultInfo, { segId: 1, message: 'message deserialization failed' });
  assert.equal(c.frameState.pending, 0, 'pending zeroed so the loop cannot deadlock');
  assert.equal(c.frameState.renderInFlight, false);
  assert.equal(c.frameState.frameSettled, true);
  await flush();
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

// A worker refusing to instantiate the shared compilation is evidence about the
// module, not the pool.
test('a shared module a worker refuses is dropped before the next spawn', async () => {
  const warmer = new ModuleWarmer();
  await warmer.warm({
    baseUrl: 'http://localhost:8000/shared/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url) => Promise.resolve({
      arrayBuffer: () => Promise.resolve(
        url.pathname.endsWith('.wasm') ? EMPTY_WASM.buffer : new ArrayBuffer(0)),
    }),
  });
  const c = makeController({ moduleWarmer: warmer });
  c.create(2);
  const initOf = (worker) => worker.posted.find((m) => m.type === 'init');
  assert.ok(initOf(c.workers[0]).wasmModule instanceof WebAssembly.Module,
    'the spawn hands out the warmed compilation');

  c.workers[1].onmessage({
    data: {
      type: 'engineRejected', sharedModule: true,
      reason: 'shared module instantiate failed: LinkError',
    },
  });

  assert.equal(warmer.module, null, 'the refused compilation is not held');
  c.create(2);
  assert.equal(initOf(c.workers[0]).wasmModule, undefined,
    'the rebuild compiles per worker rather than repeating the refusal');
  c.destroy();
});

test('a refused shared compilation automatically retries without the module', async () => {
  const warmer = new ModuleWarmer();
  await warmer.warm({
    baseUrl: 'http://localhost:8000/shared/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url) => Promise.resolve({
      arrayBuffer: () => Promise.resolve(
        url.pathname.endsWith('.wasm') ? EMPTY_WASM.buffer : new ArrayBuffer(0)),
    }),
  });
  const clock = installFakeTimers();
  const c = makeController({ moduleWarmer: warmer });
  try {
    c.active = true;
    c.create(2);
    assert.ok(c.workers[0].posted.find((m) => m.type === 'init').wasmModule
      instanceof WebAssembly.Module, 'the initial pool receives the shared compilation');
    c.workers[0].onmessage({ data: {
      type: 'engineRejected', sharedModule: true, reason: 'LinkError',
    } });
    assert.equal(c.faulted, false);
    assert.equal(c.workers.length, 0);
    clock.fireOnly(BOOT_RETRY_DELAY_MS, 'one rebuild');
    assert.equal(c.workers.length, 2);
    assert.equal(c.bootAttempt, 1);
    assert.equal(c.workers[0].posted.find((m) => m.type === 'init').wasmModule,
      undefined);
  } finally {
    c.destroy();
    clock.restore();
  }
});

test('shared module rejection faults after the boot retry budget is exhausted', () => {
  const clock = installFakeTimers();
  const c = makeController();
  try {
    c.active = true;
    c.create(2, MAX_BOOT_RETRIES);
    c.workers[0].onmessage({ data: {
      type: 'engineRejected', sharedModule: true, reason: 'LinkError',
    } });
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /engine rejected: LinkError/);
    assert.equal(c.retryTimer, null);
    assert.deepEqual(clock.pendingAt(BOOT_RETRY_DELAY_MS), []);
  } finally {
    c.destroy();
    clock.restore();
  }
});

test('a rejection unrelated to the shared module keeps the compilation', async () => {
  const warmer = new ModuleWarmer();
  await warmer.warm({
    baseUrl: 'http://localhost:8000/kept/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url) => Promise.resolve({
      arrayBuffer: () => Promise.resolve(
        url.pathname.endsWith('.wasm') ? EMPTY_WASM.buffer : new ArrayBuffer(0)),
    }),
  });
  const c = makeController({ moduleWarmer: warmer });
  c.create(2);

  c.workers[1].onmessage({
    data: { type: 'engineRejected', reason: 'setEffect(TestEffect) rejected' },
  });

  assert.ok(warmer.module instanceof WebAssembly.Module,
    'an effect the worker refused says nothing about the binary it instantiated');
  c.destroy();
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
    assert.deepEqual(c.frameState.scratch, [null, null],
      `segId ${String(segId)} must not write a staging slot`);
    assert.deepEqual(c.frameState.frameSeen, [false, false],
      `segId ${String(segId)} must not mark a segment seen`);
    assert.equal(c.frameState.pending, 0,
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
  assert.deepEqual(c.frameState.scratch, [null, null], 'no staging slot is written');
  assert.deepEqual(c.frameState.frameSeen, [false, false], 'no segment is marked seen');
  assert.equal(c.frameState.pending, 0);
  await done;
});

test('a surviving worker responding after a fault does not drive pending negative', async () => {
  const c = readyController(2);
  c.tick();
  // The fault detaches every handler, so a post-fault report can only arrive
  // from an event already dispatched when the latch closed; hold that handler.
  const seg1 = c.workers[1].onmessage;

  c.workers[0].onerror({ message: 'boom', filename: 'w.js', lineno: 1, colno: 1 });
  assert.equal(c.frameState.pending, 0);
  await flush();

  seg1({
    data: {
      type: 'frame', segId: 1,
      pixels: new Uint16Array(2 * 2 * 3),
      x0: 0, x1: 2, y0: 0, y1: 2,
      elapsed: 1, arenaMetrics: null,
    },
  });
  assert.equal(c.frameState.pending, 0, 'post-fault frame leaves pending at 0, not negative');
  assert.equal(c.frameState.scratch[1], null, 'no result is recorded for the halted pool');
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

test('an invalid controller message envelope faults the sending worker', () => {
  const c = makeController();
  c.create(2);
  c.workers[1].onmessage({ data: null });
  assert.deepEqual(c.faultInfo,
    { segId: 1, message: 'worker seg 1 sent an invalid message envelope' });
});

test('a bare-Event boot fault auto-rebuilds the pool instead of latching', () => {
  const clock = installFakeTimers();
  try {
    const c = makeController();
    c.active = true; // the app sets this before create(); the retry path checks it
    c.create(2);
    const firstPool = c.workers.slice();

    // A module-graph load failure fires a message-less Event before ready.
    const error = new Event('error', { cancelable: true });
    c.workers[0].onerror(error);
    assert.equal(error.defaultPrevented, true);
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
  c.workers[0].onerror({ message: '' });
  assert.equal(c.faulted, true);
  assert.equal(c.faultInfo.message,
    'worker failed after the pool became ready without an error message');
});

test('the deadlines and rebuild budgets retain their safety limits', () => {
  for (const delay of [BOOT_RETRY_DELAY_MS, RENDER_WATCHDOG_MS, BOOT_WATCHDOG_MS, INIT_WATCHDOG_MS]) {
    assert.ok(Number.isInteger(delay) && delay > 0, `${delay} must be a positive integer delay`);
  }
  assert.ok(BOOT_RETRY_DELAY_MS < BOOT_WATCHDOG_MS,
    'a boot retry fires well inside the boot deadline');
  assert.ok(RENDER_WATCHDOG_MS >= 1000, 'the render watchdog tolerates many slow frames');
  for (const budget of [MAX_BOOT_RETRIES, MAX_FAULTED_REBUILDS]) {
    assert.ok(Number.isInteger(budget) && budget >= 1, `${budget} must allow at least one retry`);
  }
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
    assert.equal(c.faultInfo.segId, FAULT_POOL, 'multiple missing -> pool-wide segId');
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
    assert.equal(c.frameState.pending, 1, 'one segment still outstanding');
    // The re-armed watchdog fires with seg 1 still hung.
    clock.fireOnly(RENDER_WATCHDOG_MS, 'one render watchdog armed at the render deadline');
    assert.equal(c.faulted, true);
    assert.match(c.faultInfo.message, /render stalled/);
    assert.match(c.faultInfo.message, /1\/2 segments responded/);
    assert.equal(c.faultInfo.segId, FAULT_RENDER,
      'render-timeout sentinel, distinct from the pool-init -1');
    assert.equal(c.frameState.pending, 0, 'fault settles pending so the loop cannot deadlock');
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
    assert.equal(c.frameState.pending, 1);
    assert.equal(clock.timers.length, 2, 'watchdog re-armed on the progress frame');
    assert.equal(clock.isPending(atDispatch), false,
      're-arming cancels the dispatch watchdog rather than leaving two running');
    assert.equal(clock.pendingAt(RENDER_WATCHDOG_MS).length, 1,
      'exactly one render watchdog is live across the re-arm');
    assert.notEqual(c.renderWatchdog, null);
    deliverFrame(c, 1); // the slow segment finally reports
    assert.equal(c.frameState.pending, 0);
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
    assert.equal(c.frameState.pending, 0);
    assert.equal(c.renderWatchdog, null, 'watchdog cleared once the frame settles');
    // Dropping the handle is not enough: the callback must be off the timer
    // queue, or it faults a healthy pool a render deadline later.
    assert.equal(clock.isPending(armed), false, 'the armed callback was cancelled');
    assert.deepEqual(clock.pendingAt(RENDER_WATCHDOG_MS), [],
      'no render watchdog survives the completed frame');
    assert.equal(c.faulted, false);
    await done;

  } finally {
    clock.restore();
  }
});

test('a booted ping is handled and does not by itself make the pool ready', () => {
  const c = makeController();
  c.create(2);
  deliverBooted(c, 0);
  deliverBooted(c, 1);
  assert.equal(c.frameState.ready, false, 'booted alone does not signal readiness');
  assert.equal(c.faulted, false, 'a clean boot does not fault');
  deliverReady(c, 0);
  deliverReady(c, 1);
  assert.equal(c.frameState.ready, true, 'readiness still requires the ready messages');
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

// A pool spawned inside setResolution would build every worker on the outgoing
// effect before applyResolution() corrects it.
test('a faulted setResolution leaves the rebuild to the apply pipeline', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  const beforeCount = FakeWorker.instances.length;
  c.workers[0].onerror({ message: 'x', filename: '', lineno: 0, colno: 0 });
  assert.equal(c.faulted, true);

  c.setResolution(8, 8);
  assert.equal(c.faulted, true, 'the latch is held until the effect is settled');
  assert.equal(FakeWorker.instances.length, beforeCount, 'no pool was spawned');

  c.setEffect('NewEffect');
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

// A fault that reproduces on every rebuild must not respawn the pool on every
// effect switch.
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

test('toggling mode restores the rebuild budget before a new pool reaches ready', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  faultSegZero(c);
  for (let i = 0; i <= MAX_FAULTED_REBUILDS; i++) {
    c.setEffect(`Effect${i}`);
    if (!c.faulted) faultSegZero(c);
  }
  assert.ok(c.faultedRebuilds >= MAX_FAULTED_REBUILDS);
  c.active = false;
  c.destroy();
  assert.equal(c.faultedRebuilds, 0);
  c.active = true;
  c.create(2);
  faultSegZero(c);
  const spawnedBefore = FakeWorker.constructionCount;
  c.setEffect('AfterToggle');
  assert.equal(c.faulted, false);
  assert.equal(FakeWorker.constructionCount - spawnedBefore, 2);
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

  // A resolution change is user-driven and unbounded: it restores the budget the
  // setEffect behind it then spends.
  c.setResolution(8, 8);
  c.setEffect('AfterResize');
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
  ['selectPreset', (c) => c.selectPreset(2)],
  ['setDisplayCaps', (c) => c.setDisplayCaps(0.1, 0.2)],
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

    c.presetCount = 3;
    act(c);
    if (label === 'selectPreset') assert.equal(c.presetIndex, 2);
    if (label === 'setDisplayCaps') assert.deepEqual([c.topCap, c.bottomCap], [0.1, 0.2]);
    assert.equal(c.faulted, true, 'the fault latch is held');
    assert.equal(FakeWorker.instances.length, beforeCount, 'no workers were respawned');
    assert.equal(worker.posted.length, postedBefore, 'nothing is broadcast to dead workers');
    assert.deepEqual(worker.postsAfterTermination, []);
  });
}

test('a pause toggled on a faulted pool is carried into the rebuilt one', () => {
  const c = makeController();
  c.active = true;
  c.create(2);
  c.workers[0].onerror({ message: 'x', filename: '', lineno: 0, colno: 0 });

  c.setAnimationsPaused(true);
  c.setResolution(8, 8);
  c.setEffect('AfterResize');

  for (const w of c.workers) {
    const init = w.posted.find((m) => m.type === 'init');
    assert.equal(init.paused, true, 'the rebuilt pool starts paused');
  }
});
