// SegmentController against a fake Worker and an injected fake driver.
import { installFakeTimers } from './helpers/fake_timers.js';
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { unpinnedEngineMethods } from './helpers/fake_engine.js';
import { fakeColorAttribute } from './helpers/fake_three.js';
import { FakeWorker } from './helpers/fake_worker.js';
import { Daydream } from '../src/renderer/driver.js';
import { createRenderAdapter } from '../src/app/app_lifecycle.js';
import {
  BOOT_WATCHDOG_MS,
  INIT_WATCHDOG_MS,
  RENDER_WATCHDOG_MS,
} from '../src/segments/segment_controller.js';
import { ModuleWarmer, warmModules, EMPTY_WASM } from './fixtures/module_warmer_fixture.js';
import { FAULT_POOL } from '../src/segments/worker_protocol.js';
import {
  installSegmentControllerHarness,
  driver,
  setDisplayGrid,
  makeController,
  deliverBooted,
  readyController,
  flush,
  deliverFrame,
  fakeEngine,
} from './helpers/segment_controller_harness.js';

installSegmentControllerHarness();

test('a worker clone failure records no delivered message', () => {
  const worker = new FakeWorker('worker.js', {});
  assert.throws(() => worker.postMessage({ type: 'bad', value: Symbol('uncloneable') }),
    { name: 'DataCloneError' });
  assert.deepEqual(worker.sent, []);
  assert.deepEqual(worker.posted, []);
  assert.deepEqual(worker.transfers, []);
});

test('a warmed binary is compiled once and handed to every worker', async () => {
  await warmModules({
    baseUrl: 'http://localhost:8000/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url) => Promise.resolve({
      arrayBuffer: () => Promise.resolve(
        url.pathname.endsWith('.wasm') ? EMPTY_WASM.buffer : new ArrayBuffer(0)),
    }),
  });

  const c = makeController();
  c.create(2);
  const modules = FakeWorker.instances
    .map((w) => w.sent.find((m) => m.type === 'init').wasmModule);
  for (const compiled of modules) {
    assert.ok(compiled instanceof WebAssembly.Module,
      'each worker gets the compilation instead of fetching and compiling its own');
  }
  assert.equal(new Set(modules).size, 1, 'one compilation, shared');
  c.destroy();
});

// The artifacts are unversioned, so a re-fetch that fails to compile means the
// held module no longer matches the served binary.
test('a compile failure drops the module the previous warm left', async () => {
  const warmer = new ModuleWarmer();
  const serve = (bytes) => ({
    baseUrl: 'http://localhost:8000/rebuilt/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url) => Promise.resolve({
      arrayBuffer: () => Promise.resolve(
        url.pathname.endsWith('.wasm') ? bytes.buffer : new ArrayBuffer(0)),
    }),
  });

  await warmer.warm(serve(EMPTY_WASM));
  assert.ok(warmer.module instanceof WebAssembly.Module, 'the good binary compiled');

  const stub = mock.method(console, 'warn', () => {});
  try {
    await warmer.warm(serve(Uint8Array.of(0, 0x61, 0x73, 0x6d, 9, 9, 9, 9)));
  } finally {
    stub.mock.restore();
  }
  assert.equal(warmer.module, null,
    'the refused binary drops the module rather than leaving the stale one');

  const c = makeController({ moduleWarmer: warmer });
  c.create(2);
  assert.equal(FakeWorker.instances[0].posted.find((m) => m.type === 'init').wasmModule,
    undefined, 'each worker compiles its own instead of being handed a stale module');
  c.destroy();
});

// A failed re-fetch is the same evidence as a failed compile.
test('a failed binary re-fetch drops the module the previous warm left', async () => {
  const warmer = new ModuleWarmer();
  const serve = (binaryResponse) => ({
    baseUrl: 'http://localhost:8000/redeployed/segment_controller.js',
    minIntervalMs: 0,
    fetch: (url) => (url.pathname.endsWith('.wasm')
      ? binaryResponse()
      : Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) })),
  });

  await warmer.warm(serve(() => Promise.resolve({
    arrayBuffer: () => Promise.resolve(EMPTY_WASM.buffer),
  })));
  assert.ok(warmer.module instanceof WebAssembly.Module, 'the good binary compiled');

  await warmer.warm(serve(() => Promise.reject(new TypeError('Failed to fetch'))));
  assert.equal(warmer.module, null,
    'the unfetchable binary drops the module rather than leaving the stale one');

  const c = makeController({ moduleWarmer: warmer });
  c.create(2);
  assert.equal(FakeWorker.instances[0].posted.find((m) => m.type === 'init').wasmModule,
    undefined, 'each worker compiles its own instead of being handed a stale module');
  c.destroy();
});

test('dispose drops the held compilation that destroy keeps for the next pool',
  async () => {
    const warmer = new ModuleWarmer();
    await warmer.warm({
      baseUrl: 'http://localhost:8000/segment_controller.js',
      minIntervalMs: 0,
      fetch: () => Promise.resolve({
        arrayBuffer: () => Promise.resolve(EMPTY_WASM.buffer),
      }),
    });
    assert.ok(warmer.module instanceof WebAssembly.Module, 'the warm compiled');

    const c = makeController({ moduleWarmer: warmer });
    c.create(2);
    c.destroy();
    assert.ok(warmer.module instanceof WebAssembly.Module,
      'a segmented toggle-off must keep the warm, or re-enabling pays a compile '
      + 'per worker for a module the page already has');

    c.dispose();
    assert.equal(warmer.module, null,
      'the page teardown must release the compiled module; nothing left will '
      + 'spawn a pool that could be handed it');
  });

// ---------------------------------------------------------------------------
// The `active` flag
// ---------------------------------------------------------------------------

// A truthy non-boolean would read as enabled.
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
// can rebuild it.
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
  assert.equal(c.frameState.pending, 2);

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  assert.ok(c.frameState.scratch[0], 'matching-generation frame is staged');
  assert.equal(c.frameState.scratch[0].x1, 2);
  assert.equal(c.frameState.pending, 1);

  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
  assert.equal(c.frameState.pending, 0);
  await done;
});

test('frames delivered out of order within a generation land in their own slots', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();
  assert.equal(c.frameState.pending, 2);

  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
  assert.ok(c.frameState.scratch[1], 'seg-1 frame staged despite arriving first');
  assert.equal(c.frameState.scratch[1].x1, 4);
  assert.equal(c.frameState.scratch[0], null, 'seg-0 slot still empty');
  assert.equal(c.frameState.pending, 1);

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  assert.ok(c.frameState.scratch[0], 'seg-0 frame staged when it arrives');
  assert.equal(c.frameState.scratch[0].x1, 2);
  assert.equal(c.frameState.pending, 0);
  await done;
});

/**
 * A worker whose engine refuses a parameter or a preset renders a configuration
 * its peers do not, and console.error on a worker thread reaches no one; the
 * frame's notices are the pool's only channel for it.
 */
test('the divergence notices each worker reports are published per segment', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();
  assert.deepEqual(c.frameState.warnings, [null, null], 'a dispatch starts every segment clean');

  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2, warnings: ['Ghost refused'] });
  assert.deepEqual(c.frameState.warnings, [null, ['Ghost refused']]);
  await done;

  /** @type {Object|null} */
  let painted = null;
  c.statsView.update = (state) => { painted = state; };
  c.updateStats();
  assert.deepEqual(painted?.warnings, [null, ['Ghost refused']],
    'the overlay payload carries them');

  c.renderParallel();
  assert.deepEqual(c.frameState.warnings, [null, null],
    'a segment that goes silent must not keep a prior generation notice');
});

test('a frame dispatched before a resolution change is dropped but still settles', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();

  c.setResolution(8, 8);
  assert.notEqual(c.frameState.inflightGen, c.frameState.renderGen);

  deliverFrame(c, 0);
  assert.equal(c.frameState.scratch[0], null, 'stale-generation result is discarded');
  assert.equal(c.frameState.pending, 1, 'but pending still decremented');

  deliverFrame(c, 1);
  assert.equal(c.frameState.scratch[1], null);
  assert.equal(c.frameState.pending, 0);
  await done;
});

test('a generation overtaken by a resolution change is never published', async () => {
  const c = readyController(2);
  c.tick();
  const results = c.frameState.results;
  const scratch = c.frameState.scratch;

  c.setResolution(8, 8);
  deliverFrame(c, 0);
  deliverFrame(c, 1);
  await flush();

  assert.equal(c.frameState.renderInFlight, false, 'the overtaken render still settled');
  assert.equal(c.frameState.pendingFrame, false, 'nothing is queued for the compositor');
  assert.strictEqual(c.frameState.results, results, 'the live buffer was not swapped');
  assert.strictEqual(c.frameState.scratch, scratch);

  c.tick();
  assert.equal(c.frameState.frameComposited, false, 'the next tick composites nothing');
  assert.equal(c.frameState.pendingFrame, false);
  deliverFrame(c, 0);
  deliverFrame(c, 1);
  await flush();
});

test('a generation cut short by a worker fault is never published', async () => {
  const c = readyController(2);
  c.tick();
  const results = c.frameState.results;

  const error = new Event('error', { cancelable: true });
  Object.assign(error, { message: 'boom', filename: 'w.js', lineno: 1, colno: 2 });
  c.workers[1].onerror(error);
  assert.equal(error.defaultPrevented, true);
  await flush();

  assert.equal(c.frameState.pendingFrame, false, 'the unfinished generation stays unpublished');
  assert.strictEqual(c.frameState.results, results, 'the live buffer was not swapped');
});

test('destroyed generations cannot publish into a recreated pool', async () => {
  const c = readyController(2);
  c.tick();
  assert.equal(c.frameState.renderInFlight, true);
  c.create(2);
  const results = c.frameState.results;
  const scratch = c.frameState.scratch;
  await flush();
  assert.equal(c.frameState.renderInFlight, false);
  assert.equal(c.frameState.pendingFrame, false);
  assert.strictEqual(c.frameState.results, results);
  assert.strictEqual(c.frameState.scratch, scratch);
});

// ---------------------------------------------------------------------------
// Segment-0 parameter publish
// ---------------------------------------------------------------------------

test('a segment-0 frame publishes rendered param values for the GUI', async () => {
  const c = makeController();
  c.create(2);
  const done = c.renderParallel();
  assert.equal(c.getParamValues(), null, 'nothing published before the first frame');

  deliverFrame(c, 0, { paramValues: [0.25, 1],
    presetCount: 6, presetIndex: 4 });
  assert.deepEqual(c.getParamValues(), [0.25, 1],
    'segment 0 mirrors its post-frame params into the controller');
  assert.equal(c.getPresetCount(), 6);
  assert.equal(c.getPresetIndex(), 4);

  deliverFrame(c, 1);
  await done;
});

test('refreshPresetState replaces outgoing preset metadata from the main engine', () => {
  const c = makeController();
  c.presetCount = 10;
  c.presetIndex = 9;
  c.getWasmEngine = () => ({
    getPresetCount: () => 8,
    getPresetIndex: () => 0,
  });

  c.refreshPresetState();

  assert.equal(c.getPresetCount(), 8);
  assert.equal(c.getPresetIndex(), 0);
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
  deliverFrame(c, 0, { paramValues: [0.25] });
  deliverFrame(c, 1);
  await done;
  assert.deepEqual(c.getParamValues(), [0.25]);

  done = c.renderParallel();
  const staleRevision = c.paramRevision;
  c.setParameter('Speed', 0.75);
  assert.equal(c.getParamValues(), null,
    'the previous snapshot is withheld until a worker acknowledges the write');

  deliverFrame(c, 0, {
    paramValues: [0.25], paramRevision: staleRevision, presetCount: 4, presetIndex: 3,
  });
  assert.equal(c.getParamValues(), null,
    'a frame rendered before the write cannot move the slider back');
  assert.equal(c.presetCount, 4);
  assert.equal(c.presetIndex, 3, 'preset mirroring continues while slider revisions advance');
  deliverFrame(c, 1, { paramRevision: staleRevision });
  await done;

  done = c.renderParallel();
  deliverFrame(c, 0, { paramValues: [0.75] });
  assert.deepEqual(c.getParamValues(), [0.75],
    'the first frame at the current revision resumes GUI synchronization');
  deliverFrame(c, 1);
  await done;
});

test('an in-flight frame cannot republish parameter values from before a preset change', async () => {
  const c = makeController();
  c.create(2);

  let done = c.renderParallel();
  deliverFrame(c, 0, { paramValues: [0.25] });
  deliverFrame(c, 1);
  await done;
  assert.deepEqual(c.getParamValues(), [0.25]);

  done = c.renderParallel();
  const staleRevision = c.paramRevision;
  c.presetCount = 6;
  assert.equal(c.selectPreset(4), true);
  assert.equal(c.getParamValues(), null,
    'the previous snapshot is withheld until a worker acknowledges the preset');

  deliverFrame(c, 0, {
    paramValues: [0.25], paramRevision: staleRevision,
  });
  assert.equal(c.getParamValues(), null,
    'a frame rendered before the preset change cannot snap the GUI back');
  deliverFrame(c, 1, { paramRevision: staleRevision });
  await done;

  done = c.renderParallel();
  deliverFrame(c, 0, { paramValues: [0.75] });
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
  assert.strictEqual(c.frameState.scratch[0].pixels, firstPixels, 'the first pixels stay staged');
  assert.equal(c.frameState.timings[0], 2, 'the first timing stays staged');
  assert.strictEqual(c.frameState.arenas[0], firstArena, 'the first arena metrics stay staged');
  assert.equal(c.frameState.pending, 1, 'the duplicate settles nothing');

  deliverFrame(c, 1);
  await done;
});

// ---------------------------------------------------------------------------
// Broadcast paths — setEffect / setParameter / setAnimationsPaused / snapshotParams
// ---------------------------------------------------------------------------

test('fakeEngine mocks only methods the real engine surface pins', () => {
  assert.deepEqual(unpinnedEngineMethods(fakeEngine([])), [],
    'engine_contract_wasm.test.js never checks these against the real module');
});

test('snapshotParams() carries accepted and requested state independently', () => {
  const c = makeController();
  c.getWasmEngine = () => fakeEngine([
    { name: 'Speed', value: 0.5, requestedValue: 0.9, acceptedValue: 0.4 },
    { name: 'Glow', value: false, requestedValue: true, acceptedValue: false },
    { name: 'Invert', value: false },
    { name: 'Count', value: 7 },
  ]);
  assert.deepEqual(c.snapshotParams(), [
    { name: 'Speed', value: 0.9, acceptedValue: 0.4 },
    { name: 'Glow', value: 1.0, acceptedValue: 0.0 },
    { name: 'Invert', value: 0.0 },
    { name: 'Count', value: 7 },
  ]);
});

// A request the engine refused leaves the GUI holding it while the engine
// renders what it settled on. The worker replays the accepted value first and
// the request after, so a pool rebuilt under a standing rejection matches the
// main engine.
test('a refused request ships the value the engine settled on', () => {
  const c = makeController();
  c.getWasmEngine = () => fakeEngine([
    { name: 'Lens', value: 0, requestedValue: 3, acceptedValue: 0 },
  ]);

  assert.deepEqual(c.snapshotEffectState(),
    { params: [{ name: 'Lens', value: 3, acceptedValue: 0 }] },
    'the definitions are the whole source of the accepted value');
});

// A readonly param is engine-written telemetry: replaying it would cost every
// worker two setParameter calls the engine answers READONLY.
test('snapshotParams() leaves readonly telemetry out of the rebuild state', () => {
  const c = makeController();
  c.getWasmEngine = () => fakeEngine([
    { name: 'Speed', value: 0.5 },
    { name: 'Frames', value: 120, readonly: true },
    { name: 'Glow', value: true },
  ]);
  assert.deepEqual(c.snapshotParams(), [
    { name: 'Speed', value: 0.5 },
    { name: 'Glow', value: 1.0 },
  ]);
});

test('snapshotParams() is empty when no engine is bound', () => {
  const c = makeController();
  assert.deepEqual(c.snapshotParams(), []);
});

test('snapshot-capable effects rebuild from their exhaustive state', () => {
  const snapshot = {
    schemaVersion: 2,
    chain: [{instance: 'project', operator: 'project.stereographic.v2'},
      {instance: 'sample', operator: 'sample.grid.v3'},
      {instance: 'colorize', operator: 'colorize.generated-palette.v3'}],
    parameters: [{name: 'sample.pattern-freq', value: 1}],
    animationsPaused: true,
  };
  const c = makeController({ effect: 'SnapshotEffect' });
  c.getWasmEngine = () => ({
    getShaderChainBindings: () => ({getSnapshot: () => snapshot, delete: () => {}}),
    getParameterDefinitions: () => {
      throw new Error('dynamic definitions are not persistence');
    },
  });
  assert.deepEqual(c.snapshotEffectState(), { chainSnapshot: snapshot });
});

test('a null chain-bindings handle rebuilds from params', () => {
  const c = makeController();
  c.getWasmEngine = () => ({
    ...fakeEngine([{ name: 'Speed', value: 0.5 }]),
    getShaderChainBindings: () => null,
  });
  assert.deepEqual(c.snapshotEffectState(), {
    params: [{ name: 'Speed', value: 0.5 }],
  });
});

test('an engine without the chain-bindings accessor rebuilds from params', () => {
  const c = makeController();
  c.getWasmEngine = () => fakeEngine([{ name: 'Speed', value: 0.5 }]);
  assert.deepEqual(c.snapshotEffectState(), {
    params: [{ name: 'Speed', value: 0.5 }],
  });
});

test('setEffect broadcasts the name plus the tuned param snapshot to every worker', () => {
  const c = readyController(2);
  c.getWasmEngine = () => fakeEngine([
    { name: 'Speed', value: 0.5 },
    { name: 'Glow', value: true },
  ]);

  const before = c.paramRevision;
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
    assert.equal(msgs[0].paramRevision, before + 1);
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

/**
 * Delivers one old-effect generation filled with 111 to both segments of a 4x2 grid.
 * @param {SegmentController} c - Controller with a render in flight.
 * @returns {Promise<void>} Resolves once the render settles.
 */
async function deliverOldEffectFrames(c) {
  deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2,
                       pixels: new Uint16Array(2 * 2 * 3).fill(111) });
  deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2,
                       pixels: new Uint16Array(2 * 2 * 3).fill(111) });
  await flush();
}

test('setEffect fences out an old-effect frame still in flight', async () => {
  setDisplayGrid(4, 2);
  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();

  c.setEffect('NewEffect');
  await deliverOldEffectFrames(c);
  c.tick();

  assert.equal(c.frameComposited, false, 'the fenced generation composited nothing');
  assert.ok(!driver.pixels.includes(111), 'no old-effect pixel reached the display');
});

test('setEffect drops an old-effect generation that settled but never composited', async () => {
  setDisplayGrid(4, 2);
  const c = readyController(2);
  c.showBoundaries = false;
  c.tick();
  await deliverOldEffectFrames(c);
  assert.equal(c.frameState.pendingFrame, true, 'the old generation is held for the compositor');

  c.setEffect('NewEffect');
  c.tick();

  assert.equal(c.frameComposited, false, 'the dropped generation composited nothing');
  assert.ok(!driver.pixels.includes(111), 'no old-effect pixel reached the display');
});

// A resize drops the worker's effect and its clip; rendering faults until the
// apply pipeline reinstalls the effect.
test('setResolution leaves one effect rebuild to the apply pipeline', () => {
  const c = readyController(2, { effect: 'Ribbons' });

  c.setResolution(8, 8);

  for (const w of c.workers) {
    assert.deepEqual(w.posted.map((m) => m.type), ['init', 'setResolution']);
  }
});

test('setResolution opens a new parameter revision', () => {
  const c = readyController(2);
  c.paramValues = [1, 2];
  const before = c.paramRevision;

  c.setResolution(8, 8);

  assert.equal(c.paramRevision, before + 1);
  assert.equal(c.getParamValues(), null);
});

test('a failed setResolution broadcast latches the fault and names the failed message', () => {
  for (const fails of [false, true]) {
    const c = readyController(2, { effect: 'Ribbons' });
    for (const w of c.workers) w.posted.length = 0;
    FakeWorker.failPostAt = fails ? c.workers[1].index : -1;
    FakeWorker.failPostType = 'setResolution';
    c.setResolution(8, 8);
    assert.equal(c.faulted, fails);
    if (fails) assert.match(c.faultInfo.message, /broadcast of 'setResolution' to seg 1 failed/);
    else {
      assert.equal(c.faultInfo, null);
      for (const w of c.workers) assert.deepEqual(w.posted.map(m => m.type), ['setResolution']);
    }
    c.destroy();
  }
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
  const before = c.paramRevision;
  c.setParameter('Speed', 0.75);
  for (const w of c.workers) {
    const msgs = w.posted.filter((m) => m.type === 'setParameter');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].name, 'Speed');
    assert.equal(msgs[0].value, 0.75);
    assert.equal(msgs[0].paramRevision, before + 1);
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
  const before = c.paramRevision;
  assert.equal(c.selectPreset(4), true);

  assert.equal(c.getPresetIndex(), 4);
  assert.equal(c.animationsPaused, true);
  assert.equal(c.getParamValues(), null);
  for (const w of c.workers) {
    const msg = w.posted.find((m) => m.type === 'selectPreset');
    assert.equal(msg.index, 4);
    assert.equal(msg.paramRevision, before + 1);
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

test('cap changes reach current workers and survive pool recreation', () => {
  const c = readyController(2);
  c.setDisplayCaps(2, 3);
  for (const w of c.workers) {
    assert.deepEqual(w.posted.find((m) => m.type === 'setDisplayCaps'),
      { type: 'setDisplayCaps', topCap: 2, bottomCap: 3 });
  }
  c.create(2);
  for (const w of c.workers) {
    const init = w.posted.find((m) => m.type === 'init');
    assert.equal(init.topCap, 2);
    assert.equal(init.bottomCap, 3);
  }
});

test('paused cap edits fence old frames and dispatch a replacement after they settle', async () => {
  setDisplayGrid(4, 2);
  const c = readyController(2);
  c.active = true;
  c.tick();
  driver.paused = true;
  try {
    c.setDisplayCaps(2, 3);
    assert.notEqual(c.frameState.inflightGen, c.frameState.renderGen);
    deliverFrame(c, 0);
    deliverFrame(c, 1);
    await flush();
    assert.equal(c.frameState.renderInFlight, true);
    assert.equal(c.frameState.inflightGen, c.frameState.renderGen);
    assert.ok(c.frameState.results.every((frame) => frame === null));
    deliverFrame(c, 0, { x0: 0, x1: 2, y0: 0, y1: 2 });
    deliverFrame(c, 1, { x0: 2, x1: 4, y0: 0, y1: 2 });
    await flush();
    assert.equal(c.frameState.renderInFlight, false);
    assert.ok(driver.invalidations > 0);
  } finally {
    driver.paused = false;
  }
});

test('create with an unknown resolution latches a pool fault', () => {
  const c = makeController({ resolution: 'nope' });
  c.active = true;
  c.create(4);

  assert.equal(c.faulted, true);
  assert.equal(c.faultInfo.segId, FAULT_POOL, 'no single worker to blame');
  assert.match(c.faultInfo.message, /unknown resolution "nope"/);
  assert.equal(c.ownsDisplay, true, 'the fault overlay owns the display');
  assert.deepEqual(c.workers, [], 'no workers were spawned');
  assert.equal(c.count, 4);
  for (const arr of [c.frameState.results, c.frameState.scratch, c.frameState.timings, c.frameState.arenas, c.frameState.frameSeen]) {
    assert.equal(arr.length, c.count, 'count matches the per-segment array lengths');
  }
});

test('create with a layout-illegal or oversized segment count latches a pool fault', () => {
  for (const bad of [3, 0, -2, 2.5, NaN, 10]) {
    const c = makeController();
    c.active = true;
    c.create(6);
    c.create(bad);

    assert.equal(c.faulted, true, `count ${bad} faults`);
    assert.equal(c.faultInfo.segId, FAULT_POOL, 'no single worker to blame');
    assert.match(c.faultInfo.message, /invalid segment count/);
    assert.deepEqual(c.workers, [], 'no workers were spawned');
    // The recovery rebuilds re-create() at `count`, so the banner has to name
    // the size they will actually spawn.
    assert.equal(c.count, 6, 'the rejected count does not become the pool size');
    assert.match(c.faultInfo.message, /a rebuild will use 6/);
  }
});

test('the last boot ping clears the boot watchdog before readiness', () => {
  const clock = installFakeTimers();
  const c = makeController();
  try {
    c.create(2);
    assert.equal(clock.pendingAt(BOOT_WATCHDOG_MS).length, 1);
    deliverBooted(c, 0);
    assert.equal(clock.pendingAt(BOOT_WATCHDOG_MS).length, 1);
    deliverBooted(c, 1);
    assert.deepEqual(clock.pendingAt(BOOT_WATCHDOG_MS), []);
    assert.equal(c.frameState.ready, false);
    assert.equal(clock.pendingAt(INIT_WATCHDOG_MS).length, 1);
  } finally {
    c.destroy();
    clock.restore();
  }
});

test('rendering an empty pool resolves without arming a watchdog', async () => {
  const clock = installFakeTimers();
  const c = makeController();
  try {
    let settled = false;
    const render = c.renderParallel().then(() => { settled = true; });
    await flush();
    assert.equal(settled, true);
    await render;
    assert.equal(c.frameState.pending, 0);
    assert.deepEqual(clock.pendingAt(RENDER_WATCHDOG_MS), []);
  } finally {
    c.destroy();
    clock.restore();
  }
});

test('an in-flight frame cannot revert a selected preset', async () => {
  const c = makeController();
  c.create(2);
  c.presetCount = 6;
  const pending = c.renderParallel();
  const revision = c.paramRevision;
  assert.equal(c.selectPreset(4), true);
  deliverFrame(c, 0, { presetCount: 6, presetIndex: 1, paramRevision: revision });
  deliverFrame(c, 1, { paramRevision: revision });
  await pending;
  assert.equal(c.getPresetIndex(), 4);
  const next = c.renderParallel();
  deliverFrame(c, 0, { presetCount: 6, presetIndex: 5 });
  deliverFrame(c, 1);
  await next;
  assert.equal(c.getPresetIndex(), 5);
});

test('a pool fault notifies the host once after workers stop', () => {
  const faults = [];
  const controller = makeController({ onFault: (message) => {
    assert.equal(controller.faulted, true);
    assert.ok(controller.workers.every((worker) => worker.terminated));
    faults.push(message);
  } });
  controller.create(2);
  controller.onWorkerFault(0, 'render failed');
  controller.onWorkerFault(1, 'another failure');
  assert.deepEqual(faults, ['render failed']);
  controller.destroy();
});

test('paused steps capture completed worker generations once after painting', async (t) => {
  const pixels = new Uint16Array(4 * 2 * 3);
  const captured = [];
  let displayed = -1;
  const renderer = {
    W: 4, H: 2, pixels,
    paused: true, stepFrames: 0, needsRender: false, heldCaptures: 0,
    win: { performance },
    dotMesh: { instanceColor: fakeColorAttribute(pixels) },
    advanceFrameClock: () => false,
    stepSimulation: Daydream.prototype.stepSimulation,
    invalidate: Daydream.prototype.invalidate,
    controls: { update() {} },
    xAxis: {}, yAxis: {}, zAxis: {},
    labelPool: { activeCount: 0 },
    renderer: { setScissorTest() {} },
    updateStats() {}, updateCullUniforms() {}, refreshLabels() {}, renderPip() {},
    renderMainView() { displayed = pixels[0]; },
    recorder: { isRecording: true, captureFrame() { captured.push(displayed); } },
  };
  const controller = readyController(2, { driver: renderer });
  t.after(() => controller.destroy());
  controller.active = true;
  controller.showBoundaries = false;
  const adapter = createRenderAdapter({
    driver: renderer, segments: controller, syncEffectGui() {},
    host: { engine: { drawFrame() { assert.fail('main engine stepped'); } } },
  });
  const repaint = () => Daydream.prototype.render.call(renderer, adapter);
  const complete = async (value) => {
    for (let s = 0; s < 2; s++) {
      deliverFrame(controller, s, {
        x0: s * 2, x1: s * 2 + 2, y0: 0, y1: 2,
        pixels: new Uint16Array(12).fill(value),
      });
    }
    await flush();
  };

  for (const value of [100, 200]) {
    renderer.stepFrames = 1;
    repaint();
    const previous = captured.slice();
    assert.equal(renderer.stepFrames, 0);
    await complete(value);
    assert.deepEqual(captured, previous, 'completion has not painted the canvas');
    repaint();
    assert.equal(displayed, value);
    assert.deepEqual(captured, [...previous, value]);
    renderer.invalidate();
    repaint();
    repaint();
    assert.deepEqual(captured, [...previous, value], 'camera redraw repeated a capture');
  }

  renderer.recorder.isRecording = false;
  renderer.stepFrames = 1;
  repaint();
  await complete(300);
  repaint();
  renderer.recorder.isRecording = true;
  renderer.invalidate();
  repaint();
  assert.deepEqual(captured, [100, 200], 'recording start captured an idle held frame');
});
