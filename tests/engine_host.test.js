import { detachedView } from './helpers/fake_buffer.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineHost } from '../src/engine/engine_host.js';
import { unpinnedEngineMethods } from './helpers/fake_engine.js';

test('a RuntimeError latches death without a module flag and prevents deletion', () => {
  const host = new EngineHost();
  let deleted = false;
  host.engine = { delete() { deleted = true; } };
  assert.equal(host.moduleDead(new Error('ordinary')), false);
  assert.equal(host.moduleDead(new WebAssembly.RuntimeError('out of bounds')), true);
  host.dispose();
  assert.equal(deleted, false);
  assert.equal(host.moduleDead(), true);
});

function pixelEngine(getPixels, getBufferLength) {
  return { getPixels, getBufferLength };
}

test('pixelEngine mocks only methods the real engine surface pins', () => {
  assert.deepEqual(
    unpinnedEngineMethods(pixelEngine(() => new Uint16Array(4), () => 4)),
    [],
    'engine_contract_wasm.test.js never checks these against the real module',
  );
});

test('view is the accessor method, not a shadowing data field', () => {
  const host = new EngineHost();
  assert.equal(Object.hasOwn(host, 'view'), false);
  assert.equal(host.view, EngineHost.prototype.view);
});

test('view() is null until the first refresh()', () => {
  const host = new EngineHost();
  assert.equal(host.view(), null);
});

test('refresh() fetches the engine view, caches it, and notifies the alias sync', () => {
  const fresh = new Uint16Array(4);
  let notified = null;
  const host = new EngineHost((view) => { notified = view; });
  host.engine = pixelEngine(() => fresh, () => fresh.length);

  host.refresh();

  assert.equal(host.view(), fresh);
  assert.equal(notified, fresh);
});

test('refresh() reuses a live view without re-fetching or re-notifying', () => {
  const live = new Uint16Array(4);
  let getPixelsCalls = 0;
  let notifyCalls = 0;
  const host = new EngineHost(() => { notifyCalls++; });
  host.pixelView = live;
  host.engine = pixelEngine(
    () => { getPixelsCalls++; return new Uint16Array(4); },
    () => live.length,
  );

  assert.equal(host.refresh(), false);

  assert.equal(host.view(), live);
  assert.equal(getPixelsCalls, 0);
  assert.equal(notifyCalls, 0);
});

// A re-fetch replaces the buffer and the aliases move with it.
test('refresh() reports whether it fetched a fresh view', () => {
  const fresh = new Uint16Array(4);
  const host = new EngineHost();
  assert.equal(host.refresh(), false, 'no engine fetches nothing');

  host.engine = pixelEngine(() => fresh, () => fresh.length);
  assert.equal(host.refresh(), true, 'the first refresh fetches');
  assert.equal(host.refresh(), false, 'a live view is reused');

  host.invalidateView();
  assert.equal(host.refresh(), true, 'an invalidated view is re-fetched');
});

test('invalidateView() forces the next refresh() to re-fetch', () => {
  const first = new Uint16Array(4);
  const second = new Uint16Array(4);
  let next = first;
  const host = new EngineHost();
  host.engine = pixelEngine(() => next, () => next.length);

  host.refresh();
  assert.equal(host.view(), first);

  host.invalidateView();
  assert.equal(host.view(), null);

  next = second;
  host.refresh();
  assert.equal(host.view(), second);
});

test('refresh() re-fetches when the held view no longer spans the engine buffer', () => {
  const POV_CHANNELS = 96 * 20 * 3;
  const PHANTASM_CHANNELS = 288 * 144 * 3;
  const stale = new Uint16Array(POV_CHANNELS);
  const fresh = new Uint16Array(PHANTASM_CHANNELS);
  let notified = null;
  const host = new EngineHost((view) => { notified = view; });
  host.pixelView = stale;
  host.engine = pixelEngine(() => fresh, () => PHANTASM_CHANNELS);

  assert.equal(host.refresh(), true);

  assert.equal(host.view(), fresh);
  assert.equal(notified, fresh);
});

test('refresh() survives a resolution change without invalidateView()', () => {
  const small = new Uint16Array(5760);
  const large = new Uint16Array(41472);
  const host = new EngineHost();
  let length = 5760;
  host.engine = pixelEngine(
    () => (length === 5760 ? small : large),
    () => length,
  );

  host.refresh();
  assert.equal(host.view(), small);

  length = 41472;
  host.refresh();

  assert.equal(host.view(), large);
});

test('paramGeneration() reports the engine\'s effect-load counter', () => {
  const host = new EngineHost();
  let loads = 3;
  host.engine = { getParamGeneration: () => loads };

  assert.equal(host.paramGeneration(), 3);
  loads = 4;
  assert.equal(host.paramGeneration(), 4);
});

test('paramGeneration() requires the accessor on a loaded module', () => {
  const host = new EngineHost();
  host.engine = pixelEngine(() => new Uint16Array(4), () => 4);

  assert.throws(() => host.paramGeneration(), TypeError);
});

test('paramGeneration() is undefined before the load and after dispose()', () => {
  const host = new EngineHost();

  assert.equal(host.paramGeneration(), undefined);

  host.engine = { getParamGeneration: () => 5, delete() {} };
  assert.equal(host.paramGeneration(), 5);

  host.dispose();
  assert.equal(host.paramGeneration(), undefined);
});

test('refresh() is a no-op before the load and after dispose()', () => {
  let notifyCalls = 0;
  const host = new EngineHost(() => { notifyCalls++; });

  host.refresh();
  assert.equal(host.view(), null);
  assert.equal(notifyCalls, 0);

  const fresh = new Uint16Array(4);
  host.engine = { ...pixelEngine(() => fresh, () => fresh.length), delete() {} };
  host.refresh();
  assert.equal(host.view(), fresh);
  assert.equal(notifyCalls, 1);

  host.dispose();
  host.refresh();
  assert.equal(host.view(), null);
  assert.equal(notifyCalls, 1);
});

test('dispose() releases the recorder before the engine and leaves the host inert', () => {
  const order = [];
  const onViewRefreshed = () => {};
  const host = new EngineHost(onViewRefreshed);
  host.adapter = { drawFrame() {} };
  host.module = {};
  host.recorder = { dispose() { order.push('recorder'); } };
  host.engine = {
    ...pixelEngine(() => new Uint16Array(4), () => 4),
    delete() { order.push(`engine adapter=${host.adapter}`); },
  };
  host.refresh();

  host.dispose();

  assert.deepEqual(order, ['recorder', 'engine adapter=null']);
  assert.notEqual(host.onViewRefreshed, onViewRefreshed);
  assert.equal(host.recorder, null);
  assert.equal(host.adapter, null);
  assert.equal(host.engine, null);
  assert.equal(host.view(), null);
  assert.equal(host.module, null,
    'a held module keeps the whole Emscripten heap alive behind an inert host');
});

test('a recorder that throws on release does not strand the engine', (t) => {
  const host = new EngineHost();
  host.adapter = { drawFrame() {} };
  host.module = {};
  host.recorder = { dispose() { throw new Error('stream ended'); } };
  let deleted = false;
  host.engine = { delete() { deleted = true; } };
  const logged = t.mock.method(console, 'error', () => {});

  assert.doesNotThrow(() => host.dispose());

  assert.equal(deleted, true,
    'the teardown will not revisit the host, so a stranded delete leaks the '
    + 'engine and the heap behind it');
  assert.equal(host.recorder, null);
  assert.equal(host.engine, null);
  assert.equal(host.module, null);
  assert.equal(logged.mock.callCount(), 1, 'the failure is still reported');
});

test('an engine delete that throws still leaves the host inert', (t) => {
  const host = new EngineHost();
  host.adapter = { drawFrame() {} };
  host.module = {};
  host.engine = { delete() { throw new Error('already deleted'); } };
  const logged = t.mock.method(console, 'error', () => {});

  assert.doesNotThrow(() => host.dispose());

  assert.equal(host.engine, null);
  assert.equal(host.adapter, null);
  assert.equal(host.module, null);
  assert.equal(logged.mock.callCount(), 1);
});

test('dispose() runs on a host that never reached a module load', () => {
  const host = new EngineHost();

  host.dispose();
  host.dispose();

  assert.equal(host.engine, null);
  assert.equal(host.recorder, null);
});

// The glue sets Module.HS_MODULE_DEAD before HS_CHECK traps; the host reads that terminal flag.

test('moduleDead() reads false before the load and on a live module', () => {
  const host = new EngineHost();
  assert.equal(host.moduleDead(), false, 'no module has not trapped');

  host.module = {};
  assert.equal(host.moduleDead(), false);
});

test('moduleDead() reads the glue flag once the module traps', () => {
  const host = new EngineHost();
  host.module = {};

  host.module.HS_MODULE_DEAD = true;

  assert.equal(host.moduleDead(), true);
});

test('moduleDead() stays dead once observed, dispose() included', () => {
  const host = new EngineHost();
  let deleted = false;
  host.module = { HS_MODULE_DEAD: true };
  host.engine = { delete() { deleted = true; } };

  assert.equal(host.moduleDead(), true);
  host.dispose();

  assert.equal(host.moduleDead(), true,
    'dispose() drops the module reference, and a host that read dead through it '
    + 'must not read live again');
  assert.equal(deleted, false, 'a trapped module cannot safely run its destructor');
});

test('refresh() re-fetches and re-notifies when the held view has detached', () => {
  const stale = detachedView(8);
  const fresh = new Uint16Array(4);
  let notified = null;
  const host = new EngineHost((view) => { notified = view; });
  host.pixelView = stale;
  host.engine = { getPixels: () => fresh };

  host.refresh();

  assert.equal(host.view(), fresh);
  assert.equal(notified, fresh);
});
