import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';
import {
  repointDisplayAliases,
  displayAliasesDiverged,
  createRenderAdapter,
  createAppTeardown,
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
