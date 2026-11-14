// The main WASM module load: its deadline and discard-guarded handlers.
import { fakeTimers } from './helpers/fake_timers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageHandlers } from './helpers/page_handlers.js';
import {
  createModuleLoadHandlers,
  loadWithDeadline,
  MODULE_LOAD_DEADLINE_MS,
} from '../src/app/module_load.js';
import { EngineHost } from '../src/engine/engine_host.js';

// Module load: start() arms the pagehide teardown before the load begins, so a
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

test('startup disposal runs only the app teardown', () => {
  const h = makeLoadHandlers({ start: (appTeardown) => appTeardown.dispose() });

  h.handlers.onModuleReady({ name: 'wasm' });

  assert.deepEqual(h.log, ['start wasm', 'dispose']);
  h.handlers.onModuleReady({ name: 'late' });
  assert.deepEqual(h.log, ['start wasm', 'dispose']);
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

test('both handlers tolerate a teardown reader that returns null', () => {
  const ready = makeLoadHandlers({ teardown: 'missing' });
  ready.handlers.onModuleReady({ name: 'wasm' });
  assert.deepEqual(ready.log, ['start wasm']);

  const failed = makeLoadHandlers({ teardown: 'missing' });
  failed.handlers.onModuleFailed(new Error('fetch blocked'));
  assert.deepEqual(failed.log, ['reportFailure fetch blocked']);
});

test('a load that beats the deadline resolves and cancels the timer', async () => {
  const timers = fakeTimers();

  const module = await loadWithDeadline(
    () => Promise.resolve({ name: 'wasm' }), { ms: 10, timers });

  assert.deepEqual(module, { name: 'wasm' });
  assert.equal(timers.cleared.length, 1, 'a live timer would fire into a loaded page');
  assert.equal(timers.armed(), false);
});

test('a timer handle that carries unref is unref-ed', async () => {
  // Node answers with a Timeout object, which keeps the process alive while armed.
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
  assert.equal(timers.armed(), false, 'the deadline is cancelled either way');
});

test('a load that throws synchronously rejects and cancels the deadline', async () => {
  const timers = fakeTimers();

  const rejected = loadWithDeadline(() => { throw new Error('bad import'); },
    { ms: 10, timers });

  await assert.rejects(rejected, /bad import/,
    'a sync throw escapes past the failure UI instead of reporting through it');
  assert.equal(timers.armed(), false,
    'the armed deadline would fire a second, unrelated fatal 90 s later');
  assert.equal(timers.cleared.length, 1);
});

test('a stalled load rejects at the deadline instead of spinning', async () => {
  const timers = fakeTimers();
  // The stall this bounds: a fetch that neither resolves nor errors.
  const rejected = loadWithDeadline(() => new Promise(() => {}), { ms: 10, timers });

  assert.equal(timers.delays.at(-1), 10);
  timers.fire();

  await assert.rejects(rejected, /did not load within/,
    'without this the loading overlay spins for the page lifetime');
});

test('the deadline preserves the cold-load window', () => {
  assert.ok(MODULE_LOAD_DEADLINE_MS >= 90000,
    'a slow-but-working first fetch of the multi-megabyte binary must not trip it');
});

test('failure reporting cannot prevent teardown', () => {
  let disposed = false;
  const handlers = createModuleLoadHandlers({
    teardown: () => ({ disposed: () => disposed, dispose: () => { disposed = true; } }),
    start: () => {},
    reportFailure: () => { throw new Error('report failed'); },
  });
  assert.throws(() => handlers.onModuleFailed(new Error('boot failed')), /report failed/);
  assert.equal(disposed, true);
});

test('a startup module trap reports its remedy and stops the test walk before teardown', async () => {
  const log = [];
  const host = new EngineHost();
  const reportFailure = pageHandlers(new URL('../src/app/app_boot.js', import.meta.url))(
    'reportModuleFailure', {
      host, doc: {}, win: { location: {} }, MODULE_TRAP_NOTICE: 'module trap remedy',
      console: { error: () => {} },
      testAllTicker: { stop: () => log.push('stop') },
      testAllController: { setValue: (value) => log.push(value), disable: () => log.push('disable') },
      reportBootFailure: (message) => log.push(message),
    });
  const handlers = createModuleLoadHandlers({
    teardown: () => ({ disposed: () => false, dispose: () => log.push('dispose') }),
    start: (module) => {
      host.module = module;
      throw new WebAssembly.RuntimeError('unreachable');
    },
    reportFailure,
  });
  await Promise.resolve({}).then(handlers.onModuleReady).catch(handlers.onModuleFailed);
  assert.deepEqual(log, ['stop', false, 'disable', 'module trap remedy', 'dispose']);
  assert.equal(host.moduleDead(), true);
});
