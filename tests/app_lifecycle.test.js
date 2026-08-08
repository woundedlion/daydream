import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installElement, restoreElementAfterEach } from './fake_dom.js';
import { fakeColorAttribute } from './fake_three.js';
import {
  repointDisplayAliases,
  displayAliasesDiverged,
  createRenderAdapter,
  createAppTeardown,
  createApplyNotice,
  createFrameLoopGuard,
  createGlobalKeydownHandler,
  createModuleLoadHandlers,
  createPoleLodBinding,
  createSegmentSpawnGuard,
  createTestAllTicker,
  createUnhandledRejectionHandler,
} from '../app_lifecycle.js';

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

test('the mesh alias refuses a view of a different length', () => {
  const driver = fakeDriver();
  repointDisplayAliases(driver, new Uint16Array(4));

  // A resolution change moves the active prefix of a buffer that is never
  // reallocated, so a stale view stays live at the old length. Three.js sized
  // the GPU buffer at the first upload and bufferSubDatas into it from then on,
  // which renders the wrong frame rather than throwing (README §10.2).
  assert.throws(() => repointDisplayAliases(driver, new Uint16Array(2)),
    /GPU buffer is sized/);
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
 * @returns {Object} The teardown plus its doubles and the ordered log.
 */
function makeTeardown({ recorder = true, engine = true } = {}) {
  const log = [];
  const pageTarget = fakeElement('window');
  const onKeyDown = () => {};
  const onUnhandledRejection = () => {};
  const listeners = [['keydown', onKeyDown], ['unhandledrejection', onUnhandledRejection]];
  // Registered as the app registers them; dispose's removal loop is only
  // observable against listeners that are actually on the target.
  for (const [type, handler] of listeners) pageTarget.addEventListener(type, handler);
  const host = {
    adapter: { drawFrame() {} },
    engine: engine
      ? { delete() { log.push(`engine.delete adapter=${host.adapter}`); } }
      : null,
    recorder: recorder ? { dispose() { log.push('recorder.dispose'); } } : null,
  };
  const segments = {
    active: true,
    destroy() { log.push(`segments.destroy active=${segments.active} epoch=${epoch}`); },
  };
  let epoch = 0;
  const teardown = createAppTeardown({
    pageTarget,
    listeners,
    switches: { dispose() { log.push('switches.dispose'); } },
    stopTimers: () => log.push('stopTimers'),
    effectGui: { destroy() { log.push('effectGui.destroy'); } },
    globalGui: { destroy() { log.push('globalGui.destroy'); } },
    host,
    urlSync: { dispose() { log.push('urlSync.dispose'); } },
    sidebar: { dispose() { log.push('sidebar.dispose'); } },
    driver: fakeDriver(log),
    segments,
    strandSegmentWork: () => { epoch += 1; log.push('strandSegmentWork'); },
    removeOverlay: () => log.push('removeOverlay'),
  });
  return { teardown, log, pageTarget, host, segments, handlers: { onKeyDown, onUnhandledRejection } };
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
    'urlSync.dispose',
    'sidebar.dispose',
    'driver.dispose',
    'strandSegmentWork',
    'segments.destroy active=false epoch=1',
    'removeOverlay',
    'engine.delete adapter=null',
  ]);
});

test('dispose removes every listener the app installed', () => {
  const t = makeTeardown();

  t.teardown.dispose();

  assert.deepEqual(t.pageTarget.listeners, []);
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
 * Rejection handler under test plus the sinks it writes to.
 * @returns {Object} The handler, the reported messages, and the console lines.
 */
function makeRejectionHandler() {
  const reported = [];
  const logged = [];
  const handler = createUnhandledRejectionHandler({
    report: (message) => reported.push(message),
    logError: (...args) => logged.push(args),
  });
  return { handler, reported, logged };
}

test('the rejection handler reports the reason and preventDefaults the event', () => {
  const { handler, reported, logged } = makeRejectionHandler();
  let prevented = 0;

  handler({ reason: new Error('boom'), preventDefault: () => { prevented += 1; } });

  assert.equal(prevented, 1, 'without preventDefault the browser double-logs');
  assert.deepEqual(reported, ['Something went wrong. boom']);
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], 'Unhandled promise rejection:');
});

test('the rejection handler stringifies a reason carrying no message', () => {
  const { handler, reported } = makeRejectionHandler();

  handler({ reason: 'aborted', preventDefault: () => {} });

  assert.deepEqual(reported, ['Something went wrong. aborted']);
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

test('a frame guard stringifies a thrown value carrying no message', () => {
  const { guarded, reported } = makeFrameGuard(() => { throw 'aborted'; });

  guarded();

  assert.match(reported[0], /aborted/);
});

// The global keydown guard: the shortcuts are the canvas's, so a key typed into
// a control belongs to that control. `Element` is a browser global the handler
// tests against, so the suite installs the fake one for the duration.
restoreElementAfterEach();

/**
 * Build the handler over a fake DOM tree and a recording dispatch sink.
 * @returns {Object} The handler, the tree's nodes, and the delivered keys.
 */
function makeKeydownHandler() {
  installElement();
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
  body.hidden = true;
  const timer = { fn: null, ms: null, handle: 0, cancelled: [] };
  const notice = createApplyNotice({
    doc: {
      getElementById: (id) => ({
        'apply-notice-body': body,
        'apply-notice-text': text,
      }[id] ?? null),
    },
    timeoutMs: 8000,
    schedule: (fn, ms) => { timer.fn = fn; timer.ms = ms; return ++timer.handle; },
    cancel: (handle) => { timer.cancelled.push(handle); timer.fn = null; },
  });
  return {
    notice,
    body,
    text,
    timer,
    expire: () => timer.fn(),
  };
}

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

test('a clear on an unowned element is a no-op, not a crash', () => {
  const h = makeApplyNotice();

  h.notice.show(null, 'param');

  assert.equal(h.body.hidden, true);
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

test('the dismiss button and the teardown clear whoever raised the notice', () => {
  const h = makeApplyNotice();

  h.notice.show('Effect change was rejected.', 'switch');
  h.notice.clear();

  assert.equal(h.text.textContent, '');
  assert.equal(h.body.hidden, true);
  assert.deepEqual(h.timer.cancelled, [1], 'the pending self-clear is cancelled');
});

test('the notice tolerates a page missing the element', () => {
  const notice = createApplyNotice({ doc: { getElementById: () => null } });

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
