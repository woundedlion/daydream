import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EngineHost } from '../engine_host.js';

test('view is the accessor method, not a shadowing data field', () => {
  const host = new EngineHost();
  assert.equal(typeof host.view, 'function');
});

test('view() is null until the first refresh()', () => {
  const host = new EngineHost();
  assert.equal(host.view(), null);
});

test('refresh() fetches the engine view, caches it, and notifies the alias sync', () => {
  const fresh = new Uint16Array(4);
  let notified = null;
  const host = new EngineHost((view) => { notified = view; });
  host.engine = { getPixels: () => fresh };

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
  host.engine = { getPixels: () => { getPixelsCalls++; return new Uint16Array(4); } };

  host.refresh();

  assert.equal(host.view(), live);
  assert.equal(getPixelsCalls, 0);
  assert.equal(notifyCalls, 0);
});

// SegmentController's composite elides its clear on the premise that the driver
// already zeroed the buffer it is about to blit into; a re-fetch replaces that
// buffer, and the aliases move with it, so this report is the only signal.
test('refresh() reports whether it fetched a fresh view', () => {
  const fresh = new Uint16Array(4);
  const host = new EngineHost();
  assert.equal(host.refresh(), false, 'no engine fetches nothing');

  host.engine = { getPixels: () => fresh };
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
  host.engine = { getPixels: () => next };

  host.refresh();
  assert.equal(host.view(), first);

  host.invalidateView();
  assert.equal(host.view(), null);

  next = second;
  host.refresh();
  assert.equal(host.view(), second);
});

test('refresh() re-fetches when the held view no longer spans the engine buffer', () => {
  const stale = new Uint16Array(5760);
  const fresh = new Uint16Array(41472);
  let notified = null;
  const host = new EngineHost((view) => { notified = view; });
  host.pixelView = stale;
  host.engine = { getPixels: () => fresh, getBufferLength: () => 41472 };

  host.refresh();

  assert.equal(host.view(), fresh);
  assert.equal(notified, fresh);
});

test('refresh() reuses a view that matches the engine buffer length', () => {
  const live = new Uint16Array(5760);
  let getPixelsCalls = 0;
  const host = new EngineHost();
  host.pixelView = live;
  host.engine = {
    getPixels: () => { getPixelsCalls++; return new Uint16Array(5760); },
    getBufferLength: () => 5760,
  };

  host.refresh();

  assert.equal(host.view(), live);
  assert.equal(getPixelsCalls, 0);
});

test('refresh() survives a resolution change without invalidateView()', () => {
  const small = new Uint16Array(5760);
  const large = new Uint16Array(41472);
  const host = new EngineHost();
  let length = 5760;
  host.engine = {
    getPixels: () => (length === 5760 ? small : large),
    getBufferLength: () => length,
  };

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

test('paramGeneration() is undefined on a module without the accessor', () => {
  const host = new EngineHost();
  host.engine = { getPixels: () => new Uint16Array(4) };

  assert.equal(host.paramGeneration(), undefined);
});

// Both accessors sit behind the object daydream.js hands SegmentController, and
// the frame loop reaches them on either side of the WASM load.
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
  host.engine = { getPixels: () => fresh, delete() {} };
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
  const host = new EngineHost();
  host.adapter = { drawFrame() {} };
  host.module = { HEAPU16: new Uint16Array(4) };
  host.recorder = { dispose() { order.push('recorder'); } };
  host.engine = {
    getPixels: () => new Uint16Array(4),
    delete() { order.push(`engine adapter=${host.adapter}`); },
  };
  host.refresh();

  host.dispose();

  assert.deepEqual(order, ['recorder', 'engine adapter=null']);
  assert.equal(host.recorder, null);
  assert.equal(host.adapter, null);
  assert.equal(host.engine, null);
  assert.equal(host.view(), null);
  assert.equal(host.module, null,
    'a held module keeps the whole Emscripten heap alive behind an inert host');
});

test('a recorder that throws on release does not strand the engine', () => {
  const host = new EngineHost();
  host.adapter = { drawFrame() {} };
  host.module = { HEAPU16: new Uint16Array(4) };
  host.recorder = { dispose() { throw new Error('stream ended'); } };
  let deleted = false;
  host.engine = { delete() { deleted = true; } };
  const logged = mock.method(console, 'error', () => {});

  assert.doesNotThrow(() => host.dispose());

  assert.equal(deleted, true,
    'the teardown will not revisit the host, so a stranded delete leaks the '
    + 'engine and the heap behind it');
  assert.equal(host.recorder, null);
  assert.equal(host.engine, null);
  assert.equal(host.module, null);
  assert.equal(logged.mock.callCount(), 1, 'the failure is still reported');
  logged.mock.restore();
});

test('an engine delete that throws still leaves the host inert', () => {
  const host = new EngineHost();
  host.adapter = { drawFrame() {} };
  host.module = { HEAPU16: new Uint16Array(4) };
  host.engine = { delete() { throw new Error('already deleted'); } };
  const logged = mock.method(console, 'error', () => {});

  assert.doesNotThrow(() => host.dispose());

  assert.equal(host.engine, null);
  assert.equal(host.adapter, null);
  assert.equal(host.module, null);
  assert.equal(logged.mock.callCount(), 1);
  logged.mock.restore();
});

test('dispose() runs on a host that never reached a module load', () => {
  const host = new EngineHost();

  host.dispose();
  host.dispose();

  assert.equal(host.engine, null);
  assert.equal(host.recorder, null);
});

test('refresh() re-fetches and re-notifies when the held view has detached', () => {
  const stale = new Uint16Array(4);
  stale.buffer.transfer(); // Emscripten heap growth detaches the backing buffer in place
  const fresh = new Uint16Array(4);
  let notified = null;
  const host = new EngineHost((view) => { notified = view; });
  host.pixelView = stale;
  host.engine = { getPixels: () => fresh };

  host.refresh();

  assert.equal(host.view(), fresh);
  assert.equal(notified, fresh);
});
