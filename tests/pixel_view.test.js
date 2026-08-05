import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isViewLive, refreshPixelView } from '../pixel_view.js';

/**
 * Builds a typed-array view whose backing ArrayBuffer has been detached, exactly
 * as Emscripten heap growth leaves a previously-fetched pixel view: byteLength 0
 * while the view object itself is still truthy.
 * @returns {Uint16Array} A view over a detached buffer.
 */
const detachedView = () => {
  const buf = new ArrayBuffer(8);
  const view = new Uint16Array(buf);
  buf.transfer();           // detaches buf in place; view.buffer.byteLength -> 0
  assert.equal(view.buffer.byteLength, 0);
  return view;
};

test('isViewLive: null/undefined are not live', () => {
  assert.equal(isViewLive(null), false);
  assert.equal(isViewLive(undefined), false);
});

test('isViewLive: a detached view (byteLength 0) is not live', () => {
  assert.equal(isViewLive(detachedView()), false);
});

test('isViewLive: an attached view is live', () => {
  assert.equal(isViewLive(new Uint16Array(4)), true);
});

test('refreshPixelView: a null view is re-fetched', () => {
  const fresh = new Uint16Array(4);
  let calls = 0;
  const r = refreshPixelView(null, () => { calls++; return fresh; });
  assert.equal(r.refreshed, true);
  assert.equal(r.view, fresh);
  assert.equal(calls, 1);
});

test('refreshPixelView: a detached view is re-fetched', () => {
  const fresh = new Uint16Array(4);
  const r = refreshPixelView(detachedView(), () => fresh);
  assert.equal(r.refreshed, true);
  assert.equal(r.view, fresh);
});

test('refreshPixelView: a live view is reused without re-fetching', () => {
  const live = new Uint16Array(4);
  let calls = 0;
  const r = refreshPixelView(live, () => { calls++; return new Uint16Array(4); });
  assert.equal(r.refreshed, false);
  assert.equal(r.view, live);
  assert.equal(calls, 0);
});

test('refreshPixelView: a live view of the expected length is reused', () => {
  const live = new Uint16Array(4);
  let calls = 0;
  const r = refreshPixelView(live, () => { calls++; return new Uint16Array(4); }, 4);
  assert.equal(r.refreshed, false);
  assert.equal(r.view, live);
  assert.equal(calls, 0);
});

// A resolution change re-spans the engine's pre-sized pixel buffer without
// reallocating it, so the stale view is still attached — only its length differs.
test('refreshPixelView: an attached view of the wrong length is re-fetched', () => {
  const stale = new Uint16Array(5760);
  const fresh = new Uint16Array(41472);
  let calls = 0;
  const r = refreshPixelView(stale, () => { calls++; return fresh; }, 41472);
  assert.equal(r.refreshed, true);
  assert.equal(r.view, fresh);
  assert.equal(calls, 1);
});

test('refreshPixelView: a shrunk buffer re-fetches an over-long view', () => {
  const stale = new Uint16Array(41472);
  const fresh = new Uint16Array(5760);
  const r = refreshPixelView(stale, () => fresh, 5760);
  assert.equal(r.refreshed, true);
  assert.equal(r.view, fresh);
});

test('refreshPixelView: an omitted length leaves detachment the only trigger', () => {
  const live = new Uint16Array(4);
  let calls = 0;
  const r = refreshPixelView(live, () => { calls++; return new Uint16Array(8); }, undefined);
  assert.equal(r.refreshed, false);
  assert.equal(r.view, live);
  assert.equal(calls, 0);
});
