import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';
import { fakeColorAttribute } from './fake_three.js';
import {
  repointDisplayAliases,
  displayAliasesDiverged,
  createRenderAdapter,
  createAppTeardown,
  createApplyNotice,
  createFrameLoopGuard,
  FRAME_GUARD_REARM_FRAMES,
  createGlobalKeydownHandler,
  createModuleLoadHandlers,
  loadWithDeadline,
  MODULE_LOAD_DEADLINE_MS,
  createPoleLodBinding,
  createRecordingSettings,
  createSegmentSpawnGuard,
  createSegmentedFallback,
  createTestAllTicker,
} from '../app_lifecycle.js';
import { EngineHost } from '../engine_host.js';

// app_lifecycle.js is the composition root's frame, timer, and teardown wiring.
// The contracts under test are the ones a browser would only reveal as a black
// sphere, a stuck walk, or a leak: all display aliases reference one WASM view,
// a segmented frame is composited instead of drawn, dispose releases in an order
// that cannot re-enter the apply path or reach a freed engine, the Test All walk
// advances its own index, a segmented toggle burst spawns one worker pool, one
// subsystem's notice survives another's clear, and a throwing frame does not
// take the render loop down with it.

/**
 * Driver double carrying the two display aliases and the dispose sink.
 * @param {Array<string>} [log] - Ordered teardown sink.
 * @returns {Object} The driver double.
 */
function fakeDriver(log = []) {
  return {
    pixels: null,
    dotMesh: { instanceColor: fakeColorAttribute(null) },
    dispose() { log.push('driver.dispose'); },
  };
}

// Display aliases: the Three.js instanceColor attribute, its array, and the
// driver's own pixel handle must all reference one WASM view.

test('re-pointing aliases the view everywhere and flags the upload', () => {
  const driver = fakeDriver();
  const view = new Uint16Array(4);

  repointDisplayAliases(driver, view);

  assert.equal(driver.pixels, view);
  assert.equal(driver.dotMesh.instanceColor.array, view);
  assert.equal(driver.dotMesh.instanceColor.version, 1,
    'a re-pointed attribute uploads, or the sphere shows the previous buffer');
});

test('aliases agree only when both reference the same view', () => {
  const driver = fakeDriver();
  const view = new Uint16Array(4);
  repointDisplayAliases(driver, view);
  assert.equal(displayAliasesDiverged(driver, view), false);

  driver.pixels = new Uint16Array(4);
  assert.equal(displayAliasesDiverged(driver, view), true);

  repointDisplayAliases(driver, view);
  driver.dotMesh.instanceColor.array = new Uint16Array(4);
  assert.equal(displayAliasesDiverged(driver, view), true);
});

/**
 * Build a render adapter over doubles for the host, driver, and worker pool.
 * @param {Object} [options] - Pool state and the view the host publishes.
 * @returns {Object} The adapter plus its doubles and sinks.
 */
function makeAdapter({ ownsDisplay = false, active = false,
                       frameComposited = false, metrics = { stack: 1 } } = {}) {
  const calls = [];
  const errors = [];
  const view = new Uint16Array(4);
  const driver = fakeDriver();
  const host = {
    engine: {
      drawFrame() { calls.push('engine.drawFrame'); },
      getArenaMetrics() { calls.push('engine.getArenaMetrics'); return metrics; },
    },
    view: () => view,
    refresh() {
      calls.push('host.refresh');
      repointDisplayAliases(driver, view);
    },
  };
  const segments = {
    ownsDisplay,
    active,
    frameComposited,
    tick() { calls.push('segments.tick'); },
    updateStats() { calls.push('segments.updateStats'); },
  };
  const adapter = createRenderAdapter({
    host,
    driver,
    segments,
    syncEffectGui: () => calls.push('effectGui.sync'),
    logError: (message) => errors.push(message),
  });
  return { adapter, calls, errors, driver, host, segments, view };
}

test('a single-engine frame renders, republishes the view, then syncs the panel', () => {
  const a = makeAdapter();

  a.adapter.drawFrame();

  assert.deepEqual(a.calls,
    ['engine.drawFrame', 'host.refresh', 'effectGui.sync']);
  assert.equal(a.driver.pixels, a.view);
  // A refresh that hands back a fresh view raises the flag, and the frame raises
  // it again unconditionally; three.js still uploads once per render.
  assert.equal(a.driver.dotMesh.instanceColor.version, 2);
});

test('a spawning pool still renders the main engine and reports its progress', () => {
  const a = makeAdapter({ active: true, ownsDisplay: false });

  a.adapter.drawFrame();

  assert.deepEqual(a.calls,
    ['segments.updateStats', 'engine.drawFrame', 'host.refresh', 'effectGui.sync']);
});

test('a pool that owns the display composites instead of drawing', () => {
  const a = makeAdapter({ active: true, ownsDisplay: true });

  a.adapter.drawFrame();

  assert.deepEqual(a.calls, ['segments.tick', 'effectGui.sync']);
});

test('a diverged alias is healed in place and reported once', () => {
  const a = makeAdapter();
  // A refresh that leaves the view live re-points nothing, so a foreign buffer
  // assigned between frames survives into the next one.
  a.host.refresh = () => a.calls.push('host.refresh');
  a.driver.pixels = new Uint16Array(4);

  a.adapter.drawFrame();
  assert.equal(a.driver.pixels, a.view, 'the frame healed the alias');
  assert.equal(a.errors.length, 1);
  assert.match(a.errors[0], /alias diverged/);

  a.driver.dotMesh.instanceColor.array = new Uint16Array(4);
  a.adapter.drawFrame();
  assert.equal(a.driver.dotMesh.instanceColor.array, a.view);
  assert.equal(a.errors.length, 1, 'the report is once per page, not per frame');
});

test('arena metrics come from the main engine only while it renders', () => {
  const single = makeAdapter({ metrics: { stack: 42 } });
  assert.deepEqual(single.adapter.getArenaMetrics(), { stack: 42 });

  const pooled = makeAdapter({ ownsDisplay: true });
  assert.equal(pooled.adapter.getArenaMetrics(), null);
  assert.deepEqual(pooled.calls, [], 'the idle main engine is not polled');
});

test('a segmented frame is capturable only once a composite has landed', () => {
  assert.equal(makeAdapter().adapter.captureReady(), true);
  assert.equal(
    makeAdapter({ ownsDisplay: true, frameComposited: false }).adapter.captureReady(),
    false);
  assert.equal(
    makeAdapter({ ownsDisplay: true, frameComposited: true }).adapter.captureReady(),
    true);
});

/**
 * Build the teardown over doubles that record their order into one log.
 * @param {Object} [options] - Host state the teardown must tolerate.
 * @param {boolean} [options.recorder] - Whether the host holds a recorder.
 * @param {boolean} [options.engine] - Whether the host holds an engine.
 * @param {Set<string>} [options.failing] - Log names whose double throws instead
 *   of recording, standing in for a collaborator already in a bad state.
 * @returns {Object} The teardown plus its doubles, the ordered log, and the
 *   errors its logError sink saw.
 */
function makeTeardown({
  recorder = true,
  engine = true,
  failing = new Set(),
} = {}) {
  const errors = [];
  const log = [];
  // Records a step, or throws in its place when the case asked that collaborator
  // to fail.
  const note = (entry) => {
    if (failing.has(entry)) throw new Error(`${entry} failed`);
    log.push(entry);
  };
  const pageTarget = fakeElement('window');
  const noticeTarget = fakeElement('button');
  const onKeyDown = () => {};
  const onUnhandledRejection = () => {};
  const onNoticeDismiss = () => {};
  const listeners = [
    ['keydown', onKeyDown],
    ['unhandledrejection', onUnhandledRejection],
    ['click', onNoticeDismiss, noticeTarget],
  ];
  // Registered as the app registers them; dispose's removal loop is only
  // observable against listeners that are actually on the target.
  for (const [type, handler, target = pageTarget] of listeners) {
    target.addEventListener(type, handler);
  }
  // The real host, so the teardown's release order is the one its dispose() runs.
  const host = new EngineHost();
  host.adapter = { drawFrame() {} };
  host.engine = engine
    ? { delete() { log.push(`engine.delete adapter=${host.adapter}`); } }
    : null;
  host.recorder = recorder ? { dispose() { note('recorder.dispose'); } } : null;
  const segments = {
    active: true,
    dispose() { note(`segments.dispose active=${segments.active} epoch=${epoch}`); },
  };
  let epoch = 0;
  const teardown = createAppTeardown({
    pageTarget,
    listeners,
    switches: { dispose() { note('switches.dispose'); } },
    stopTimers: () => note('stopTimers'),
    effectGui: { destroy() { note('effectGui.destroy'); } },
    globalGui: { destroy() { note('globalGui.destroy'); } },
    host,
    urlSync: { dispose() { note('urlSync.dispose'); } },
    sidebar: { dispose() { note('sidebar.dispose'); } },
    driver: fakeDriver(log),
    segments,
    strandSegmentWork: () => { epoch += 1; note('strandSegmentWork'); },
    removeOverlay: () => note('removeOverlay'),
    logError: (message, error) => errors.push({ message, error }),
  });
  return {
    teardown,
    log,
    errors,
    pageTarget,
    noticeTarget,
    host,
    segments,
    handlers: { onKeyDown, onUnhandledRejection },
  };
}

test('the teardown listens for the page discard', () => {
  const t = makeTeardown();

  assert.deepEqual(t.pageTarget.listeners.map((l) => l.type),
    ['keydown', 'unhandledrejection', 'pagehide']);
});

test('dispose releases in an order nothing can re-enter', () => {
  const t = makeTeardown();

  t.teardown.dispose();

  assert.deepEqual(t.log, [
    'switches.dispose',
    'stopTimers',
    'effectGui.destroy',
    'globalGui.destroy',
    'recorder.dispose',
    'engine.delete adapter=null',
    'urlSync.dispose',
    'sidebar.dispose',
    'driver.dispose',
    'strandSegmentWork',
    'segments.dispose active=false epoch=1',
    'removeOverlay',
  ]);
});

test('dispose leaves the host holding nothing', () => {
  const t = makeTeardown();

  t.teardown.dispose();

  assert.equal(t.host.recorder, null, 'a disposed recorder must not stay bound');
  assert.equal(t.host.adapter, null);
  assert.equal(t.host.engine, null);
});

test('dispose removes every listener the app installed', () => {
  const t = makeTeardown();

  t.teardown.dispose();

  assert.deepEqual(t.pageTarget.listeners, []);
  assert.deepEqual(t.noticeTarget.listeners, []);
});

test('dispose runs once however often it is called', () => {
  const t = makeTeardown();

  t.teardown.dispose();
  const first = t.log.length;
  t.teardown.dispose();

  assert.equal(t.log.length, first);
  assert.equal(t.teardown.disposed(), true);
});

test('a bfcache freeze keeps the app alive; a real discard tears it down', () => {
  const frozen = makeTeardown();
  frozen.teardown.onPageHide({ persisted: true });
  assert.deepEqual(frozen.log, []);
  assert.equal(frozen.teardown.disposed(), false);

  const discarded = makeTeardown();
  discarded.teardown.onPageHide({ persisted: false });
  assert.equal(discarded.teardown.disposed(), true);
});

test('the registered pagehide handler is the one that disposes', () => {
  const t = makeTeardown();

  t.pageTarget.dispatch('pagehide', { persisted: false });

  assert.equal(t.teardown.disposed(), true);
});

test('a step that throws does not strand the releases behind it', () => {
  const t = makeTeardown({ failing: new Set(['globalGui.destroy']) });

  t.teardown.dispose();

  assert.deepEqual(t.log, [
    'switches.dispose',
    'stopTimers',
    'effectGui.destroy',
    'recorder.dispose',
    'engine.delete adapter=null',
    'urlSync.dispose',
    'sidebar.dispose',
    'driver.dispose',
    'strandSegmentWork',
    'segments.dispose active=false epoch=1',
    'removeOverlay',
  ], 'dispose runs once, so a stranded release leaks the URL debounce, the '
    + 'WebGL context, and the worker pool with no retry left');
  assert.equal(t.errors.length, 1, 'the failure is still reported');
  assert.match(t.errors[0].message, /global GUI/);
});

test('every dispose step is independent of the ones before it', () => {
  const failing = new Set([
    'switches.dispose', 'stopTimers', 'effectGui.destroy', 'globalGui.destroy',
    'urlSync.dispose', 'sidebar.dispose', 'strandSegmentWork', 'removeOverlay',
  ]);
  const t = makeTeardown({ failing });

  assert.doesNotThrow(() => t.teardown.dispose());

  assert.equal(t.errors.length, failing.size, 'each failure is named');
  assert.equal(t.teardown.disposed(), true);
  assert.equal(t.host.engine, null, 'the engine handle is still released');
  assert.equal(t.segments.active, false);
  assert.deepEqual(t.pageTarget.listeners, [], 'the page listeners still come off');
});

test('a listener removal that throws still leaves the others removed', () => {
  const t = makeTeardown();
  const target = t.noticeTarget;
  target.removeEventListener = () => { throw new Error('detached'); };

  t.teardown.dispose();

  assert.deepEqual(t.pageTarget.listeners, []);
  assert.equal(t.errors.length, 1);
  assert.match(t.errors[0].message, /click listener/);
});

test('dispose tolerates a page torn down before the engine or recorder existed', () => {
  const t = makeTeardown({ recorder: false, engine: false });

  t.teardown.dispose();

  assert.equal(t.host.engine, null);
  assert.equal(t.host.adapter, null);
  assert.deepEqual(t.log.filter((l) => l.includes('engine.delete')), []);
});

// Module load: the pagehide teardown is armed during module evaluation, so a
// page discard can settle before the WASM module does.

/**
 * Build the module-load handlers over a teardown double and an ordered log.
 * @param {Object} [options] - Startup behaviour and teardown availability.
 * @returns {Object} The handlers plus the log and the teardown double.
 */
function makeLoadHandlers({ start = () => {}, teardown = 'present' } = {}) {
  const log = [];
  let appDisposed = false;
  const appTeardown = {
    dispose() {
      if (appDisposed) return;
      appDisposed = true;
      log.push('dispose');
    },
    disposed: () => appDisposed,
  };
  const handlers = createModuleLoadHandlers({
    teardown: () => (teardown === 'present' ? appTeardown : null),
    start: (module) => { log.push(`start ${module.name}`); start(appTeardown); },
    discardStartup: () => log.push('discardStartup'),
    reportFailure: (err) => log.push(`reportFailure ${err.message}`),
  });
  return { handlers, log, appTeardown };
}

test('a module that arrives on a live page starts the app', () => {
  const h = makeLoadHandlers();

  h.handlers.onModuleReady({ name: 'wasm' });

  assert.deepEqual(h.log, ['start wasm']);
});

test('a module that arrives after a page discard never starts the app', () => {
  const h = makeLoadHandlers();
  h.appTeardown.dispose();
  h.log.length = 0;

  h.handlers.onModuleReady({ name: 'wasm' });

  assert.deepEqual(h.log, [],
    'startup would re-enter a disposed scene and leak a fresh engine');
});

test('a discard landing during startup releases what startup built', () => {
  const h = makeLoadHandlers({ start: (appTeardown) => appTeardown.dispose() });

  h.handlers.onModuleReady({ name: 'wasm' });

  assert.deepEqual(h.log, ['start wasm', 'dispose', 'discardStartup'],
    'dispose runs once, so the engine built behind it is nobody else\'s to free');
});

test('a failed module load reports the failure and tears the app down', () => {
  const h = makeLoadHandlers();

  h.handlers.onModuleFailed(new Error('fetch blocked'));

  assert.deepEqual(h.log, ['reportFailure fetch blocked', 'dispose'],
    'the animation loop and window listeners must not outlive the failure UI');
});

test('a failed load on an already discarded page still reports the failure', () => {
  const h = makeLoadHandlers();
  h.appTeardown.dispose();
  h.log.length = 0;

  h.handlers.onModuleFailed(new Error('fetch blocked'));

  assert.deepEqual(h.log, ['reportFailure fetch blocked']);
});

test('both handlers tolerate a module evaluation that never built the teardown', () => {
  const ready = makeLoadHandlers({ teardown: 'missing' });
  ready.handlers.onModuleReady({ name: 'wasm' });
  assert.deepEqual(ready.log, ['start wasm']);

  const failed = makeLoadHandlers({ teardown: 'missing' });
  failed.handlers.onModuleFailed(new Error('fetch blocked'));
  assert.deepEqual(failed.log, ['reportFailure fetch blocked']);
});

/**
 * A timer source a case fires by hand.
 * @returns {Object} The stand-in, plus the pending timers and the clears seen.
 */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    cleared: [],
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      this.cleared.push(id);
      pending.delete(id);
    },
    /** Runs the one pending timer. @returns {void} */
    fire() {
      const [id, { fn }] = [...pending][0];
      pending.delete(id);
      fn();
    },
  };
}

test('a load that beats the deadline resolves and cancels the timer', async () => {
  const timers = fakeTimers();

  const module = await loadWithDeadline(
    () => Promise.resolve({ name: 'wasm' }), { ms: 10, timers });

  assert.deepEqual(module, { name: 'wasm' });
  assert.equal(timers.cleared.length, 1, 'a live timer would fire into a loaded page');
  assert.equal(timers.pending.size, 0);
});

test('a timer handle that carries unref is unref-ed', async () => {
  // The fake above answers with a number, as a browser does; Node answers with a
  // Timeout object, and an armed deadline holding one keeps the process alive.
  const handle = { unrefs: 0, unref() { this.unrefs += 1; } };
  const cleared = [];
  const timers = {
    setTimeout: () => handle,
    clearTimeout: (timer) => { cleared.push(timer); },
  };

  await loadWithDeadline(() => Promise.resolve({ name: 'wasm' }), { ms: 10, timers });

  assert.equal(handle.unrefs, 1);
  assert.deepEqual(cleared, [handle], 'the handle itself is what gets cleared');
});

test('a load failure still rejects with its own error', async () => {
  const timers = fakeTimers();

  await assert.rejects(
    loadWithDeadline(() => Promise.reject(new Error('fetch blocked')),
      { ms: 10, timers }),
    /fetch blocked/);
  assert.equal(timers.pending.size, 0, 'the deadline is cancelled either way');
});

test('a load that throws synchronously rejects and cancels the deadline', async () => {
  const timers = fakeTimers();

  const rejected = loadWithDeadline(() => { throw new Error('bad import'); },
    { ms: 10, timers });

  await assert.rejects(rejected, /bad import/,
    'a sync throw escapes past the failure UI instead of reporting through it');
  assert.equal(timers.pending.size, 0,
    'the armed deadline would fire a second, unrelated fatal 90 s later');
  assert.equal(timers.cleared.length, 1);
});

test('a stalled load rejects at the deadline instead of spinning', async () => {
  const timers = fakeTimers();
  // The stall this bounds: a fetch that neither resolves nor errors.
  const rejected = loadWithDeadline(() => new Promise(() => {}), { ms: 10, timers });

  assert.equal([...timers.pending.values()][0].ms, 10);
  timers.fire();

  await assert.rejects(rejected, /did not load within/,
    'without this the loading overlay spins for the page lifetime');
});

test('the deadline is generous enough for a cold load of the binary', () => {
  assert.ok(MODULE_LOAD_DEADLINE_MS >= 60000,
    'a slow-but-working first fetch of the multi-megabyte binary must not trip it');
});

// The render loop guard: Three.js re-arms the frame request only after the
// callback returns, so a throw that escapes it freezes the page for good.

/**
 * Guard under test over a frame body the test drives, plus the sinks it writes to.
 * @param {() => void} frame - The per-frame body.
 * @returns {Object} The guarded callback, the reported messages, and the console lines.
 */
function makeFrameGuard(frame) {
  const reported = [];
  const logged = [];
  const guarded = createFrameLoopGuard({
    frame,
    report: (message) => reported.push(message),
    logError: (...args) => logged.push(args),
  });
  return { guarded, reported, logged };
}

test('a throwing frame is contained and the loop keeps calling the body', () => {
  let calls = 0;
  const { guarded, reported } = makeFrameGuard(() => {
    calls += 1;
    if (calls === 1) throw new Error('view detached');
  });

  guarded();
  guarded();

  assert.equal(calls, 2, 'a contained throw must not stop the frames that follow');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /view detached/);
});

test('a frame that throws every tick reports once', () => {
  const { guarded, reported, logged } = makeFrameGuard(() => {
    throw new Error('boom');
  });

  for (let i = 0; i < 5; i++) guarded();

  assert.equal(reported.length, 1, 'the banner must not be rewritten 60 times a second');
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 'Render loop frame failed:');
});

test('a loop that recovers reports its next failure again', () => {
  let boom = true;
  const { guarded, reported, logged } = makeFrameGuard(() => {
    if (boom) throw new Error('view detached');
  });

  guarded();
  boom = false;
  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES - 1; i++) guarded();
  boom = true;
  guarded();
  assert.equal(reported.length, 1,
    'a clean run short of the re-arm keeps the latch, so an intermittent throw '
    + 'cannot report at display rate');

  boom = false;
  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES; i++) guarded();
  boom = true;
  guarded();

  assert.equal(reported.length, 2,
    'a failure after the loop recovered must not be swallowed for the page lifetime');
  assert.equal(logged.length, 2);
});

test('a frame guard stringifies a thrown value carrying no message', () => {
  const { guarded, reported } = makeFrameGuard(() => { throw 'aborted'; });

  guarded();

  assert.match(reported[0], /aborted/);
});

// The global keydown guard: the shortcuts are the canvas's, so a key typed into
// a control belongs to that control.

/**
 * Build the handler over a fake DOM tree and a recording dispatch sink.
 * @returns {Object} The handler, the tree's nodes, and the delivered keys.
 */
function makeKeydownHandler() {
  const keys = [];
  const handler = createGlobalKeydownHandler({ dispatch: (e) => keys.push(e.key) });

  const canvas = fakeElement('canvas');
  const textField = fakeElement('input');
  const panel = fakeElement('div');
  panel.className = 'lil-gui';
  const slider = fakeElement('div');
  panel.appendChild(slider);
  const sidebar = fakeElement('div');
  sidebar.className = 'effect-sidebar';
  const entry = fakeElement('span');
  sidebar.appendChild(entry);
  const note = fakeElement('div');
  note.setAttribute('contenteditable', '');

  return { handler, keys, canvas, textField, panel, slider, sidebar, entry, note };
}

test('a canvas hotkey reaches the simulation', () => {
  const h = makeKeydownHandler();

  h.canvas.addEventListener('keydown', h.handler);
  h.canvas.dispatch('keydown', { key: ' ' });

  assert.deepEqual(h.keys, [' '], 'nothing owns the key, so the shortcut runs');
});

test('a hotkey typed mid-text-edit never reaches the simulation', () => {
  const h = makeKeydownHandler();

  // The window listener sees the event after it bubbles, still carrying the
  // field as its target — the case a listener bound to the canvas cannot show.
  h.handler({ key: ' ', target: h.textField });
  h.handler({ key: ' ', target: h.note });

  assert.deepEqual(h.keys, [],
    'typing a space into a field must not also toggle playback');
});

test('a hotkey inside a GUI panel or the sidebar belongs to that control', () => {
  const h = makeKeydownHandler();

  // Descendants: the guard has to walk up to the panel/sidebar, not just test
  // the target itself.
  h.handler({ key: ' ', target: h.slider });
  h.handler({ key: 'ArrowRight', target: h.entry });
  h.handler({ key: ' ', target: h.panel });
  h.handler({ key: ' ', target: h.sidebar });

  assert.deepEqual(h.keys, []);
});

test('a key with no element target still reaches the simulation', () => {
  const h = makeKeydownHandler();

  h.handler({ key: 'p', target: null });
  h.handler({ key: 'p', target: globalThis });

  assert.deepEqual(h.keys, ['p', 'p'],
    'only a node in the document can own the key');
});

// The Pole LOD control is registered during module evaluation and DeepLinkGUI
// replays a URL-hydrated value's onChange right there, while the engine is
// still null — so the binding is the value's only durable home until the
// module load resolves.

/**
 * Build the binding over an engine that appears only when made to.
 * @returns {Object} The binding, the recorded pushes, and the engine switch.
 */
function makePoleLodBinding() {
  const pushed = [];
  const invalidations = { count: 0 };
  let engine = null;
  const binding = createPoleLodBinding({
    getEngine: () => engine,
    onChange: () => { invalidations.count += 1; },
  });
  return {
    binding,
    pushed,
    invalidations,
    loadEngine: () => { engine = { setPoleLod: (v) => pushed.push(v) }; },
  };
}

test('near-pole decimation is off until something turns it on', () => {
  const { binding } = makePoleLodBinding();

  assert.equal(binding.state.poleLod, 0,
    'the default must not enable decimation before any deep link is read');
});

test('a deep link applied before the engine exists still reaches it', () => {
  const h = makePoleLodBinding();

  h.binding.apply(1.5);
  assert.deepEqual(h.pushed, [], 'there is no engine yet to push into');

  h.loadEngine();
  h.binding.replay();

  assert.deepEqual(h.pushed, [1.5], 'the load carries the hydrated value in');
  assert.equal(h.invalidations.count, 1, 'the apply repainted; the replay need not');
});

test('a change made once the engine exists reaches it immediately', () => {
  const h = makePoleLodBinding();
  h.loadEngine();

  h.binding.apply(0.35);

  assert.deepEqual(h.pushed, [0.35]);
  assert.equal(h.binding.state.poleLod, 0.35, 'the state stays the durable home');
});

test('a replay before the engine loads is a no-op, not a crash', () => {
  const h = makePoleLodBinding();

  h.binding.replay();

  assert.deepEqual(h.pushed, []);
});

// The recording settings share the Pole LOD binding's problem: the GUI mounts at
// module scope, the recorder is built only when the module load resolves, and
// the recorder latches every one of these at start().

/**
 * Build the recording settings over a recorder that appears only when made to.
 * @returns {Object} The block, the recorder double, the warnings, and the load.
 */
function makeRecordingSettings() {
  const warnings = [];
  let recorder = null;
  const block = createRecordingSettings({
    getRecorder: () => recorder,
    warn: (message) => warnings.push(message),
  });
  block.define('recQuality', 16, 'bitrate',
    (rec, v) => { rec.bitrateMbps = v; });
  block.define('recFormat', 'Auto', 'format',
    (rec, v) => { rec.format = v; });
  return {
    block,
    warnings,
    getRecorder: () => recorder,
    loadRecorder: () => { recorder = { isRecording: false }; return recorder; },
  };
}

test('a setting written before the recorder exists is held, not lost', () => {
  const h = makeRecordingSettings();

  h.block.settings.recQuality = 8;
  assert.equal(h.block.settings.recQuality, 8, 'the setting is its own durable home');
  assert.deepEqual(h.warnings, [], 'there is no session to warn about yet');

  const recorder = h.loadRecorder();
  h.block.replay();

  assert.equal(recorder.bitrateMbps, 8, 'the load carries the held value in');
  assert.equal(recorder.format, 'Auto', 'an untouched setting replays its default');
});

test('a setting written once the recorder exists reaches it immediately', () => {
  const h = makeRecordingSettings();
  const recorder = h.loadRecorder();

  h.block.settings.recFormat = 'mp4';

  assert.equal(recorder.format, 'mp4');
  assert.equal(h.block.settings.recFormat, 'mp4', 'and the setting still reads back');
  assert.deepEqual(h.warnings, [], 'no session is running, so nothing is deferred');
});

test('a write during a session is reported as deferred to the next one', () => {
  const h = makeRecordingSettings();
  const recorder = h.loadRecorder();
  recorder.isRecording = true;

  h.block.settings.recQuality = 20;

  assert.equal(recorder.bitrateMbps, 20, 'the write still lands on the recorder');
  assert.equal(h.warnings.length, 1, 'and is reported exactly once');
  assert.match(h.warnings[0], /bitrate/, 'the notice names the setting');
  assert.match(h.warnings[0], /next recording/, 'and says when it takes effect');
});

// GUI-bound: lil-gui enumerates the object it is handed, so a non-enumerable
// setting would never get a control.
test('every setting is enumerable on the GUI-bound object', () => {
  const h = makeRecordingSettings();

  assert.deepEqual(Object.keys(h.block.settings), ['recQuality', 'recFormat'],
    'the settings enumerate in definition order');
});

// The Test All ticker walks the resolution's effect list on a timer. Its index
// is its own: a rejected switch reverts the effect, so an index re-derived from
// the live one would retry the rejected slot forever.

/**
 * Build the ticker over a fake interval timer and a recording effect switch.
 * @param {Object} [options] - Starting effect, the lists offered, engine state.
 * @returns {Object} The ticker, its doubles, and the requested effect names.
 */
function makeTicker({
  effect = 'Alpha',
  lists = [['Alpha', 'Beta', 'Gamma']],
  engineReady = true,
  acceptSwitch = true,
} = {}) {
  const requested = [];
  const state = { effect, engineReady, listIndex: 0 };
  const timer = { fn: null, ms: null, handle: 0, cancelled: [] };
  const ticker = createTestAllTicker({
    intervalMs: 1000,
    availableEffects: () => lists[state.listIndex],
    getEffect: () => state.effect,
    setEffect: (name) => {
      requested.push(name);
      if (acceptSwitch) state.effect = name;
    },
    engineReady: () => state.engineReady,
    schedule: (fn, ms) => { timer.fn = fn; timer.ms = ms; return ++timer.handle; },
    cancel: (handle) => { timer.cancelled.push(handle); timer.fn = null; },
  });
  return {
    ticker,
    requested,
    state,
    timer,
    tick: (n = 1) => { for (let i = 0; i < n; i++) timer.fn(); },
  };
}

test('the ticker walks the list on from the live effect', () => {
  const h = makeTicker({ effect: 'Beta' });

  h.ticker.start();
  assert.equal(h.timer.ms, 1000, 'the dwell time is the one it was built with');
  h.tick(2);

  assert.deepEqual(h.requested, ['Gamma', 'Alpha'], 'and wraps at the end');
});

test('the walk continues past an effect the engine refused', () => {
  const h = makeTicker({ acceptSwitch: false });

  h.ticker.start();
  h.tick(2);

  assert.deepEqual(h.requested, ['Beta', 'Gamma'],
    'a reverted effect must not make the ticker retry the same slot');
});

test('a live effect the list does not offer starts the walk at its head', () => {
  const h = makeTicker({ effect: 'Zeta' });

  h.ticker.start();
  h.tick();

  assert.deepEqual(h.requested, ['Alpha']);
});

test('a tick before the engine loads switches nothing and loses no ground', () => {
  const h = makeTicker({ engineReady: false });

  h.ticker.start();
  h.tick(2);
  assert.deepEqual(h.requested, [], 'there is no engine to take the switch');

  h.state.engineReady = true;
  h.tick();
  assert.deepEqual(h.requested, ['Beta'], 'the walk resumes where it started');
});

test('a resolution change mid-walk continues through the new list', () => {
  const h = makeTicker({ lists: [['Alpha', 'Beta', 'Gamma'], ['Lo1', 'Lo2']] });

  h.ticker.start();
  h.tick();
  h.state.listIndex = 1;
  h.tick(2);

  assert.deepEqual(h.requested, ['Beta', 'Lo1', 'Lo2'],
    'the index is taken modulo the list the tick actually reads');
});

test('a resolution offering nothing ticks without a switch', () => {
  const h = makeTicker({ lists: [[]] });

  h.ticker.start();
  h.tick(2);

  assert.deepEqual(h.requested, []);
});

test('stopping cancels the interval, and starting arms exactly one', () => {
  const h = makeTicker();

  h.ticker.start();
  h.ticker.start();
  assert.equal(h.timer.handle, 1, 'a re-entered toggle must not arm a second timer');
  assert.equal(h.ticker.running(), true);

  h.ticker.stop();
  assert.deepEqual(h.timer.cancelled, [1]);
  assert.equal(h.ticker.running(), false);

  h.ticker.stop();
  assert.deepEqual(h.timer.cancelled, [1], 'stopping twice cancels once');

  h.ticker.start();
  assert.equal(h.timer.handle, 2, 'a stopped ticker starts again');
});

// The shared notice element: the parameter writer and the switch coordinator
// both announce through it, so ownership decides whose message a clear drops.

/**
 * Build the notice sink over fake notice elements and a timer the test fires by
 * hand.
 * @returns {Object} The sink, the two elements, and the pending timeout.
 */
function makeApplyNotice() {
  const body = fakeElement('div');
  const text = fakeElement('span');
  const dismiss = fakeElement('button');
  body.append(text, dismiss); // index.html nests both inside the body
  body.hidden = true; // index.html renders apply-notice-body hidden
  const timer = { fn: null, ms: null, handle: 0, cancelled: [] };
  const doc = {
    activeElement: null,
    getElementById: (id) => ({
      'apply-notice-body': body,
      'apply-notice-text': text,
      'apply-notice-dismiss': dismiss,
    }[id] ?? null),
  };
  const notice = createApplyNotice({
    doc,
    timeoutMs: 8000,
    schedule: (fn, ms) => { timer.fn = fn; timer.ms = ms; return ++timer.handle; },
    cancel: (handle) => { timer.cancelled.push(handle); timer.fn = null; },
  });
  return {
    notice,
    doc,
    body,
    text,
    dismiss,
    timer,
    expire: () => timer.fn(),
  };
}

test('a document without the notice elements is reported once, not swallowed', () => {
  const warnings = [];
  const present = {};
  const notice = createApplyNotice({
    doc: { getElementById: (id) => present[id] ?? null },
    schedule: () => 1,
    cancel: () => {},
    logWarning: (message) => warnings.push(message),
  });

  notice.show('Effect change was rejected.', 'switch');
  notice.show('Parameter "spin" was rejected.', 'param');

  assert.equal(warnings.length, 1, 'the absence is named once, not once per write');
  assert.match(warnings[0], /apply-notice-body/);
  assert.match(warnings[0], /apply-notice-text/);
  assert.equal(notice.owner(), null);

  // The sink re-queries, so markup that arrives later still gets its notices.
  present['apply-notice-body'] = fakeElement('div');
  present['apply-notice-text'] = fakeElement('span');
  notice.show('Effect change was rejected.', 'switch');

  assert.equal(present['apply-notice-text'].textContent, 'Effect change was rejected.');
  assert.equal(present['apply-notice-body'].hidden, false);
  assert.equal(notice.owner(), 'switch');
  assert.equal(warnings.length, 1);
});

test('the live region is unhidden before its text is written', () => {
  const h = makeApplyNotice();
  const writes = [];
  let stored = '';
  Object.defineProperty(h.text, 'textContent', {
    get: () => stored,
    set(value) { stored = value; writes.push({ value, hidden: h.body.hidden }); },
  });

  h.notice.show('Effect change was rejected.', 'switch');
  // Hidden content is outside the accessibility tree: a write followed by the
  // unhide leaves the unhide as the only mutation assistive tech sees.
  assert.deepEqual(writes, [{ value: 'Effect change was rejected.', hidden: false }]);

  h.notice.show(null, 'switch');
  assert.deepEqual(writes[1], { value: '', hidden: true },
    'a clear hides the region before emptying it, so nothing is re-announced');
});

test('a param write does not clear a notice the switch coordinator raised', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.notice.show(null, 'param');

  assert.equal(h.text.textContent, 'Effect change was rejected.',
    'a slider nudge after a rejected switch must not erase the only '
    + 'explanation the user was given');
  assert.equal(h.body.hidden, false);
  assert.equal(h.notice.owner(), 'switch');
});

test('a raised notice takes the element over from another owner', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.notice.show('Parameter "spin" was rejected.', 'param');

  assert.equal(h.text.textContent, 'Parameter "spin" was rejected.');
  assert.equal(h.notice.owner(), 'param');
  assert.deepEqual(h.timer.cancelled, [1],
    "the displaced owner's self-clear must not fire against the new message");
});

test('an owner clears the notice it raised', () => {
  const h = makeApplyNotice();

  h.notice.show('Parameter "spin" was rejected.', 'param');
  h.notice.show(null, 'param');

  assert.equal(h.text.textContent, '');
  assert.equal(h.body.hidden, true);
  assert.equal(h.notice.owner(), null, 'a cleared element is owned by nobody');
});

test('a clear on an unowned element hides it rather than crashing', () => {
  const h = makeApplyNotice();
  // A notice on screen that no owner is recorded for, as a reload of a page
  // whose markup already carried one leaves it.
  h.body.hidden = false;
  h.text.textContent = 'Effect change was rejected.';

  h.notice.show(null, 'param');

  assert.equal(h.body.hidden, true, 'an unowned clear left the notice on screen');
  assert.equal(h.text.textContent, '');
  assert.equal(h.notice.owner(), null);
});

test('the notice self-clears so a stale rejection cannot outlive its action', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  assert.equal(h.timer.ms, 8000);
  h.expire();

  assert.equal(h.text.textContent, '');
  assert.equal(h.body.hidden, true);
  assert.equal(h.notice.owner(), null);
});

test('the self-clear waits out keyboard focus inside the notice', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.doc.activeElement = h.dismiss;
  h.expire();

  assert.equal(h.body.hidden, false,
    'hiding the body drops focus from the dismiss button the user is standing on');
  assert.equal(h.notice.owner(), 'switch');
  assert.equal(h.timer.ms, 8000, 'the dwell is served again');

  // The button is still the user's own way out, deferred dwell or not.
  h.notice.clear();
  assert.equal(h.body.hidden, true);

  h.notice.show('Effect change was rejected.', 'switch');
  h.doc.activeElement = null;
  h.expire();
  assert.equal(h.body.hidden, true);
  assert.equal(h.notice.owner(), null);
});

test('the dismiss button and the teardown clear whoever raised the notice', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.notice.clear();

  assert.equal(h.text.textContent, '');
  assert.equal(h.body.hidden, true);
  assert.deepEqual(h.timer.cancelled, [1], 'the pending self-clear is cancelled');
});

test('the notice tolerates a page missing the element', () => {
  const notice = createApplyNotice({
    doc: { getElementById: () => null },
    logWarning: () => {},
  });

  notice.show('Effect change was rejected.', 'switch');
  notice.clear();

  assert.equal(notice.owner(), null);
});

// The segmented spawn guard: spawning awaits a module warm-up, so a toggle burst
// leaves several continuations in flight against one worker pool.

/**
 * Build the spawn guard over warm-ups the test resolves by hand.
 * @returns {Object} The guard, the pending warm-ups, the spawn log, and the
 *   segmented-mode switch the post-await check reads.
 */
function makeSpawnGuard() {
  const warms = [];
  const spawns = [];
  const mode = { active: false };
  const guard = createSegmentSpawnGuard({
    warmModules: () => new Promise((resolve, reject) => {
      warms.push({ resolve, reject });
    }),
    spawn: () => spawns.push('create'),
    isActive: () => mode.active,
  });
  return { guard, warms, spawns, mode };
}

test('an on/off/on burst spawns one worker pool, not two', async () => {
  const h = makeSpawnGuard();

  h.mode.active = true;
  const first = h.guard.respawn();
  h.mode.active = false;
  h.guard.strand();
  h.mode.active = true;
  const second = h.guard.respawn();

  h.warms[0].resolve();
  h.warms[1].resolve();

  assert.equal(await first, false, 'the superseded attempt is stranded');
  assert.equal(await second, true);
  assert.deepEqual(h.spawns, ['create']);
});

test('the last attempt is the one that spawns, whatever order they resume in', async () => {
  const h = makeSpawnGuard();
  h.mode.active = true;

  const first = h.guard.respawn();
  const second = h.guard.respawn();
  h.warms[1].resolve();
  h.warms[0].resolve();

  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.deepEqual(h.spawns, ['create'], 'two pools would double the worker count');
});

test('a strand lands on a continuation still awaiting the warm-up', async () => {
  const h = makeSpawnGuard();
  h.mode.active = true;

  const attempt = h.guard.respawn();
  h.guard.strand(); // the page discard / pool failure path
  h.warms[0].resolve();

  assert.equal(await attempt, false);
  assert.deepEqual(h.spawns, [], 'a spawn here builds workers into a dead page');
});

test('an attempt that resumes with segmented mode off spawns nothing', async () => {
  const h = makeSpawnGuard();
  h.mode.active = true;

  const attempt = h.guard.respawn();
  h.mode.active = false;
  h.warms[0].resolve();

  assert.equal(await attempt, false);
  assert.deepEqual(h.spawns, []);
});

test('a failed warm-up rejects so the caller can fall back', async () => {
  const h = makeSpawnGuard();
  h.mode.active = true;

  const attempt = h.guard.respawn();
  h.warms[0].reject(new Error('offline'));

  await assert.rejects(attempt, /offline/);
  assert.deepEqual(h.spawns, []);
});

// What the caller falls back with. Its order is the contract: the flag goes
// false before the strand and the teardown, or a continuation resuming mid-way
// spawns a pool behind the single engine the app just fell back to.

/**
 * Build the fallback over a recording segment-controller double.
 * @returns {Object} The fallback, the ordered log, and the controller double.
 */
function makeSegmentedFallback() {
  const order = [];
  const notices = [];
  const logs = [];
  let active = true;
  const segments = {
    destroy: () => order.push('destroy'),
    updateStats: () => order.push('updateStats'),
  };
  // An accessor, as the real controller has, so the write's position is visible.
  Object.defineProperty(segments, 'active', {
    enumerable: true,
    get: () => active,
    set: (v) => { active = v; order.push(`active=${v}`); },
  });
  const fallback = createSegmentedFallback({
    segments,
    strand: () => order.push('strand'),
    showNotice: (message) => { order.push('notice'); notices.push(message); },
    showToggle: (on) => order.push(`toggle=${on}`),
    logError: (message, err) => logs.push([message, err]),
  });
  return { fallback, order, notices, logs, segments };
}

test('the segmented fallback clears the flag before it strands or tears down', () => {
  const h = makeSegmentedFallback();

  h.fallback('enable', new Error('no workers'));

  assert.deepEqual(h.order,
    ['notice', 'active=false', 'strand', 'destroy', 'updateStats', 'toggle=false'],
    'a strand or a destroy ahead of the flag leaves a window a resuming '
    + 'continuation can spawn into');
  assert.equal(h.segments.active, false, 'the host is left inactive');
});

test('the segmented fallback names what failed in both the notice and the log', () => {
  const h = makeSegmentedFallback();
  const err = new Error('no workers');

  h.fallback('resize', err);

  assert.match(h.notices[0], /resize/, 'the notice names the operation');
  assert.match(h.notices[0], /no workers/, 'and the reason');
  assert.match(h.notices[0], /single engine/, 'and what the app fell back to');
  assert.equal(h.logs.length, 1, 'the console gets the thrown value too');
  assert.equal(h.logs[0][1], err, 'unwrapped, so its stack survives');
});

test('the segmented fallback reports a thrown non-Error', () => {
  const h = makeSegmentedFallback();

  h.fallback('teardown', 'worker exploded');

  assert.match(h.notices[0], /worker exploded/,
    'a rejection carrying a bare string must not read as "[object Object]"');
});
