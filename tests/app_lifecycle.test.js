import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installElement, restoreElementAfterEach } from './fake_dom.js';
import {
  repointDisplayAliases,
  displayAliasesDiverged,
  createRenderAdapter,
  createAppTeardown,
  createGlobalKeydownHandler,
  createModuleLoadHandlers,
  createPoleLodBinding,
  createUnhandledRejectionHandler,
} from '../app_lifecycle.js';

// app_lifecycle.js is the composition root's frame and teardown wiring. The
// contracts under test are the ones a browser would only reveal as a black
// sphere or a leak: all display aliases reference one WASM view, a segmented
// frame is composited instead of drawn, and dispose releases in an order that
// cannot re-enter the apply path or reach a freed engine.

/**
 * Driver double carrying the two display aliases and the dispose sink.
 * @param {Array<string>} [log] - Ordered teardown sink.
 * @returns {Object} The driver double.
 */
function fakeDriver(log = []) {
  return {
    pixels: null,
    dotMesh: { instanceColor: { array: null, needsUpdate: false } },
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
  assert.equal(driver.dotMesh.instanceColor.needsUpdate, true);
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
  assert.equal(a.driver.dotMesh.instanceColor.needsUpdate, true);
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
    listeners: [['keydown', onKeyDown], ['unhandledrejection', onUnhandledRejection]],
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

  assert.deepEqual(t.pageTarget.listeners.map((l) => l.type), ['pagehide']);
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
