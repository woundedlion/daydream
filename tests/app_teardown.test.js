// The page-discard teardown: release order, idempotence, and failure isolation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './helpers/fake_dom.js';
import { createAppTeardown } from '../src/app/app_teardown.js';
import { EngineHost } from '../src/engine/engine_host.js';

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
  // Records a step, or throws when the case asked that collaborator to fail.
  const note = (entry) => {
    if (failing.has(entry) || (entry.startsWith('segments.dispose ') && failing.has('segments.dispose')))
      throw new Error(`${entry} failed`);
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
  // Registered as the app registers them.
  for (const [type, handler, target = pageTarget] of listeners) {
    target.addEventListener(type, handler);
  }
  for (const target of [pageTarget, noticeTarget]) {
    const remove = target.removeEventListener.bind(target);
    target.removeEventListener = (type, handler) => {
      log.push(`remove ${type}`);
      remove(type, handler);
    };
  }
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
    releaseAppServices: () => note('releaseAppServices'),
    effectGui: { destroy() { note('effectGui.destroy'); } },
    shaderDocuments: { dispose() { note('shaderDocuments.dispose'); } },
    globalGui: { destroy() { note('globalGui.destroy'); } },
    host,
    urlSync: { dispose() { note('urlSync.dispose'); } },
    sidebar: { dispose() { note('sidebar.dispose'); } },
    driver: { dispose() { note('driver.dispose'); } },
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
  };
}

test('the teardown listens for the page discard', () => {
  const t = makeTeardown();

  assert.deepEqual(t.pageTarget.listeners.map((l) => l.type).sort(),
    ['keydown', 'pagehide', 'unhandledrejection']);
});

const TEARDOWN_STEPS = [
  'remove keydown', 'remove unhandledrejection', 'remove click', 'remove pagehide',
  'switches.dispose', 'releaseAppServices', 'effectGui.destroy', 'shaderDocuments.dispose',
  'globalGui.destroy', 'recorder.dispose', 'engine.delete adapter=null', 'urlSync.dispose',
  'sidebar.dispose', 'driver.dispose', 'strandSegmentWork',
  'segments.dispose active=false epoch=1', 'removeOverlay',
];

/**
 * Asserts the teardown ran each expected step once and kept its ordering
 * contract: listeners come off before the GUI and scene teardown, the engine
 * host goes before the driver, and the pool is stranded before it is destroyed.
 * @param {string[]} log - The recorded steps.
 * @param {string[]} steps - The steps expected to have run.
 * @param {string} [message] - Failure message for the step set.
 */
function assertTeardown(log, steps, message) {
  assert.deepEqual([...log].sort(), [...steps].sort(), message);
  const at = (step) => log.indexOf(step);
  const lastRemoval = Math.max(...log.map((step, i) => step.startsWith('remove ') ? i : -1));
  for (const step of ['effectGui.destroy', 'globalGui.destroy', 'driver.dispose']) {
    if (at(step) >= 0) assert.ok(lastRemoval < at(step), `listeners come off before ${step}`);
  }
  for (const step of ['recorder.dispose', 'engine.delete adapter=null'])
    assert.ok(at(step) < at('driver.dispose'), `${step} precedes driver.dispose`);
  assert.ok(at('strandSegmentWork') < at('segments.dispose active=false epoch=1'));
}

test('dispose releases in an order nothing can re-enter', () => {
  const t = makeTeardown();

  t.teardown.dispose();

  assertTeardown(t.log, TEARDOWN_STEPS);
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

  assertTeardown(t.log, TEARDOWN_STEPS.filter((step) => step !== 'globalGui.destroy'),
    'dispose runs once, so a stranded release leaks the URL debounce, the '
    + 'WebGL context, and the worker pool with no retry left');
  assert.equal(t.errors.length, 1, 'the failure is still reported');
  assert.match(t.errors[0].message, /global GUI/);
});

test('every dispose step is independent of the ones before it', () => {
  const failing = new Set([
    'switches.dispose', 'releaseAppServices', 'effectGui.destroy', 'shaderDocuments.dispose', 'globalGui.destroy',
    'urlSync.dispose', 'sidebar.dispose', 'driver.dispose', 'strandSegmentWork', 'segments.dispose', 'removeOverlay',
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
