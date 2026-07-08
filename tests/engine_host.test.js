// @ts-check
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
