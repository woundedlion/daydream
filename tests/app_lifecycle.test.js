import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';
import { fakeColorAttribute } from './fake_three.js';
import { fakeScheduler } from './fake_timers.js';
import { repointDisplayAliases } from '../display_aliases.js';
import {
  createRenderAdapter,
  createAppTeardown,
  createFrameLoopGuard,
  FRAME_GUARD_REARM_FRAMES,
  createGlobalKeydownHandler,
  createModuleLoadHandlers,
  loadWithDeadline,
  MODULE_LOAD_DEADLINE_MS,
  createTestAllTicker,
} from '../app_lifecycle.js';
import { EngineHost } from '../engine_host.js';

// app_lifecycle.js is the composition root's frame, timer, and teardown wiring.
// The contracts under test are the ones a browser would only reveal as a black
// sphere, a stuck walk, or a leak: a segmented frame is composited instead of
// drawn, dispose releases in an order that cannot re-enter the apply path or
// reach a freed engine, the Test All walk advances its own index, and a throwing
// frame does not take the render loop down with it.

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

test('a single-engine frame renders and republishes the view', () => {
  const a = makeAdapter();

  a.adapter.drawFrame();

  assert.deepEqual(a.calls, ['engine.drawFrame', 'host.refresh']);
  assert.equal(a.driver.pixels, a.view);
  // The re-point raises the flag; the per-frame upload is the driver's, flagged
  // there behind the live-view guard rather than raised again here.
  assert.equal(a.driver.dotMesh.instanceColor.version, 1);
});

test('panel reconciliation is independent of drawing a simulation frame', () => {
  const a = makeAdapter();

  a.adapter.sync();

  assert.deepEqual(a.calls, ['effectGui.sync']);
});

test('a spawning pool still renders the main engine and reports its progress', () => {
  const a = makeAdapter({ active: true, ownsDisplay: false });

  a.adapter.drawFrame();

  assert.deepEqual(a.calls,
    ['segments.updateStats', 'engine.drawFrame', 'host.refresh']);
});

test('a pool that owns the display composites instead of drawing', () => {
  const a = makeAdapter({ active: true, ownsDisplay: true });

  a.adapter.drawFrame();

  assert.deepEqual(a.calls, ['segments.tick']);
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

test('a failed load on an already discarded page is ignored', () => {
  const h = makeLoadHandlers();
  h.appTeardown.dispose();
  h.log.length = 0;

  h.handlers.onModuleFailed(new Error('fetch blocked'));

  assert.deepEqual(h.log, []);
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

test('the deadline preserves the cold-load window', () => {
  assert.equal(MODULE_LOAD_DEADLINE_MS, 90000,
    'a slow-but-working first fetch of the multi-megabyte binary must not trip it');
});

// The render loop guard: Three.js re-arms the frame request only after the
// callback returns, so a throw that escapes it freezes the page for good.

/**
 * Guard under test over a frame body the test drives, plus the sinks it writes to.
 * @param {() => void} frame - The per-frame body.
 * @param {Object} [deps] - Death-latch collaborators, defaulted off.
 * @param {() => boolean} [deps.moduleDead] - Reads the module's death flag.
 * @param {() => void} [deps.onModuleDead] - Releases the app on a dead module.
 * @returns {Object} The guarded callback, the reported messages, and the console lines.
 */
function makeFrameGuard(frame, deps = {}) {
  const reported = [];
  const logged = [];
  const guarded = createFrameLoopGuard({
    frame,
    report: (message) => reported.push(message),
    logError: (...args) => logged.push(args),
    ...deps,
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

// A trapped module is the failure the re-arm cannot be trusted through: the
// trap unwinds nothing, so drawFrame() keeps returning without throwing and the
// clean frames that retract the banner are the corrupt ones.

test('a dead module stops the frames, releases the app, and names the reload', () => {
  let frames = 0;
  let dead = false;
  let releases = 0;
  const { guarded, reported, logged } = makeFrameGuard(
    () => { frames += 1; },
    { moduleDead: () => dead, onModuleDead: () => { releases += 1; } });

  guarded();
  dead = true;
  guarded();
  guarded();

  assert.equal(frames, 2, 'the body must not run once the module is known dead');
  assert.equal(releases, 1, 'the release runs once, not per frame');
  assert.equal(reported.length, 1);
  assert.match(reported[0], /Reload the page/,
    'no call recovers a trapped module, so the banner has to say what does');
  assert.equal(logged.length, 1);
});

test('a dead module is polled on a clean frame, not only on a throw', () => {
  let dead = false;
  const { guarded, reported } = makeFrameGuard(
    () => {}, { moduleDead: () => dead });

  dead = true;
  guarded();

  assert.equal(reported.length, 1,
    'a trapped module hands back plausible frames; waiting for a throw waits '
    + 'for one that never comes');
});

test('a dead module latches past the clean-frame re-arm', () => {
  let dead = false;
  let releases = 0;
  const { guarded, reported } = makeFrameGuard(
    () => { if (!dead) throw new Error('view detached'); },
    { moduleDead: () => dead, onModuleDead: () => { releases += 1; } });

  guarded();
  assert.equal(reported.length, 1);
  dead = true;
  guarded();
  for (let i = 0; i < FRAME_GUARD_REARM_FRAMES * 2; i++) guarded();

  assert.equal(reported.length, 2,
    'death is terminal, so no run of clean frames retracts its banner');
  assert.match(reported[1], /Reload the page/,
    'the terminal report is the one left standing');
  assert.equal(releases, 1);
});

test('a release that throws still leaves the loop stopped', () => {
  let frames = 0;
  const { guarded } = makeFrameGuard(
    () => { frames += 1; },
    {
      moduleDead: () => true,
      onModuleDead: () => { throw new Error('teardown failed'); },
    });

  assert.throws(() => guarded(), /teardown failed/);
  guarded();

  assert.equal(frames, 1, 'the latch is set before the release is attempted');
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
  const timer = fakeScheduler();
  const ticker = createTestAllTicker({
    intervalMs: 1000,
    availableEffects: () => lists[state.listIndex],
    getEffect: () => state.effect,
    setEffect: (name) => {
      requested.push(name);
      if (acceptSwitch) state.effect = name;
    },
    engineReady: () => state.engineReady,
    schedule: timer.schedule,
    cancel: timer.cancel,
  });
  return {
    ticker,
    requested,
    state,
    timer,
    tick: (n = 1) => { for (let i = 0; i < n; i++) timer.fire(); },
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
