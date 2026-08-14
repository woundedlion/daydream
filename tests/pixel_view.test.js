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
  assert.equal(view.buffer.byteLength, 0, 'the fixture buffer was not detached');
  return view;
};

test('isViewLive: null/undefined are not live', () => {
  assert.equal(isViewLive(null), false, 'a null view was reported live');
  assert.equal(isViewLive(undefined), false, 'an undefined view was reported live');
});

test('isViewLive: a detached view (byteLength 0) is not live', () => {
  assert.equal(isViewLive(detachedView()), false, 'a detached view was reported live');
});

test('isViewLive: an attached view is live', () => {
  assert.equal(isViewLive(new Uint16Array(4)), true, 'an attached view was reported dead');
});

test('refreshPixelView: a null view is re-fetched', () => {
  const fresh = new Uint16Array(4);
  let calls = 0;
  const r = refreshPixelView(null, () => { calls++; return fresh; });
  assert.equal(r.refreshed, true, 'the re-fetch went unreported');
  assert.equal(r.view, fresh);
  assert.equal(calls, 1, 'the null view was not re-fetched exactly once');
});

test('refreshPixelView: a detached view is re-fetched', () => {
  const fresh = new Uint16Array(4);
  const r = refreshPixelView(detachedView(), () => fresh);
  assert.equal(r.refreshed, true, 'the re-fetch went unreported');
  assert.equal(r.view, fresh, 'the detached view was handed back');
});

test('refreshPixelView: a live view is reused without re-fetching', () => {
  const live = new Uint16Array(4);
  let calls = 0;
  const r = refreshPixelView(live, () => { calls++; return new Uint16Array(4); });
  assert.equal(r.refreshed, false, 'a reused view was reported as re-fetched');
  assert.equal(r.view, live, 'the live view was replaced');
  assert.equal(calls, 0, 'a live view was re-fetched from the engine');
});

test('refreshPixelView: a live view of the expected length is reused', () => {
  const live = new Uint16Array(4);
  let calls = 0;
  const r = refreshPixelView(live, () => { calls++; return new Uint16Array(4); }, 4);
  assert.equal(r.refreshed, false, 'a matching length was reported as re-fetched');
  assert.equal(r.view, live, 'the live view was replaced');
  assert.equal(calls, 0, 'a view of the expected length was re-fetched');
});

// A resolution change re-spans the engine's pre-sized pixel buffer without
// reallocating it, so the stale view is still attached — only its length differs.
test('refreshPixelView: an attached view of the wrong length is re-fetched', () => {
  const stale = new Uint16Array(5760);
  const fresh = new Uint16Array(41472);
  let calls = 0;
  const r = refreshPixelView(stale, () => { calls++; return fresh; }, 41472);
  assert.equal(r.refreshed, true, 'the re-fetch went unreported');
  assert.equal(r.view, fresh, 'the short view survived the resolution change');
  assert.equal(calls, 1, 'the stale view was not re-fetched exactly once');
});

test('refreshPixelView: a shrunk buffer re-fetches an over-long view', () => {
  const stale = new Uint16Array(41472);
  const fresh = new Uint16Array(5760);
  const r = refreshPixelView(stale, () => fresh, 5760);
  assert.equal(r.refreshed, true, 'the re-fetch went unreported');
  assert.equal(r.view, fresh, 'the over-long view survived the shrink');
});

test('refreshPixelView: an omitted length leaves detachment the only trigger', () => {
  const live = new Uint16Array(4);
  let calls = 0;
  const r = refreshPixelView(live, () => { calls++; return new Uint16Array(8); }, undefined);
  assert.equal(r.refreshed, false, 'an omitted length was treated as a mismatch');
  assert.equal(r.view, live, 'the live view was replaced');
  assert.equal(calls, 0, 'an omitted length triggered a re-fetch');
});
