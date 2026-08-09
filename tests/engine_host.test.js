import { test } from 'node:test';
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

test('dispose() releases the recorder before the engine and leaves the host inert', () => {
  const order = [];
  const host = new EngineHost();
  host.adapter = { drawFrame() {} };
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
