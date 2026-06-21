// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppState, URLSync, getActiveURLSync } from '../state.js';

/** Verifies get() returns initial defaults and set() updates a value in place. */
test('AppState.get returns defaults and set updates', () => {
  const s = new AppState({ a: 1, b: 'x' });
  assert.equal(s.get('a'), 1);
  assert.equal(s.get('b'), 'x');
  s.set('a', 2);
  assert.equal(s.get('a'), 2);
});

/** Verifies set() notifies subscribers with (key, newValue, oldValue) and skips writes that don't change the value. */
test('AppState.set notifies with (key, new, old) and skips no-op writes', () => {
  const s = new AppState({ a: 1 });
  const events = [];
  s.subscribe((key, value, old) => events.push([key, value, old]));

  s.set('a', 1);            // same value → no notification
  s.set('a', 2);            // change → one notification
  assert.deepEqual(events, [['a', 2, 1]]);
});

/** Verifies update() applies a batch of writes and only notifies for keys whose value actually changed. */
test('AppState.update batches and only fires for changed keys', () => {
  const s = new AppState({ a: 1, b: 2, c: 3 });
  const events = [];
  s.subscribe((key, value, old) => events.push([key, value, old]));

  s.update({ a: 1, b: 20, c: 30 }); // a unchanged
  assert.deepEqual(events, [['b', 20, 2], ['c', 30, 3]]);
});

/** Verifies subscribe() returns a function that detaches the listener so later changes no longer notify it. */
test('AppState.subscribe returns an unsubscribe function', () => {
  const s = new AppState({ a: 1 });
  let count = 0;
  const off = s.subscribe(() => count++);
  s.set('a', 2);
  off();
  s.set('a', 3);
  assert.equal(count, 1);
});

/** Verifies snapshot() returns a detached copy that does not mutate the live state when modified. */
test('AppState.snapshot is a detached copy', () => {
  const s = new AppState({ a: 1 });
  const snap = s.snapshot();
  snap.a = 99;
  assert.equal(s.get('a'), 1);
});

// --- URLSync (needs a minimal window stub) ---

/**
 * Installs a minimal global `window` stub so URLSync can read location.search
 * and so history.replaceState writes can be captured for assertions.
 * @param {string} [search] - The location.search query string (e.g. '?effect=Voronoi').
 * @param {string} [pathname] - The location.pathname the stub reports.
 * @returns {Array<string>} A live array that collects each URL passed to history.replaceState.
 */
function installWindow(search = '', pathname = '/') {
  const calls = [];
  globalThis.window = {
    location: { search, pathname },
    history: {
      replaceState: (_state, _title, url) => { calls.push(url); },
    },
  };
  return calls;
}

/** Verifies URLSync seeds state from tracked URL params on construction and ignores untracked ones. */
test('URLSync reads initial tracked keys from the URL into state', () => {
  installWindow('?effect=Voronoi&res=high&untracked=1');
  const s = new AppState({ effect: 'Moire', res: 'low' });
  new URLSync(s, ['effect', 'res']);
  assert.equal(s.get('effect'), 'Voronoi');
  assert.equal(s.get('res'), 'high');
});

/** Verifies the optional per-key validator rejects an invalid URL value and keeps the state default. */
test('URLSync validator rejects an invalid URL value and keeps the default', () => {
  installWindow('?effect=Voronoi&res=bogus');
  const s = new AppState({ effect: 'Moire', res: 'low' });
  new URLSync(s, ['effect', 'res'], { res: (v) => v === 'high' || v === 'low' });
  assert.equal(s.get('effect'), 'Voronoi'); // unvalidated key still seeded
  assert.equal(s.get('res'), 'low');        // invalid 'bogus' rejected → default kept
});

/** Verifies the validator admits a valid URL value (a passing predicate is a no-op gate). */
test('URLSync validator admits a valid URL value', () => {
  installWindow('?res=high');
  const s = new AppState({ res: 'low' });
  new URLSync(s, ['res'], { res: (v) => v === 'high' || v === 'low' });
  assert.equal(s.get('res'), 'high');
});

/** Verifies a newly constructed URLSync registers itself as the active URL writer returned by getActiveURLSync(). */
test('URLSync registers itself as the active URL writer', () => {
  installWindow('');
  const s = new AppState({});
  const sync = new URLSync(s, ['effect']);
  assert.equal(getActiveURLSync(), sync);
});

/** Verifies _flush() writes tracked state plus ad-hoc params (rounded to 4 dp) onto the current pathname. */
test('URLSync._flush writes tracked state and ad-hoc params to the URL', () => {
  const calls = installWindow('', '/sim');
  const s = new AppState({ effect: 'Voronoi' });
  const sync = new URLSync(s, ['effect']);

  sync.setParam('speed', 1.23456); // rounded to 4 dp
  sync._flush();

  assert.equal(calls.length, 1);
  const params = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(params.get('effect'), 'Voronoi');
  assert.equal(params.get('speed'), '1.2346');
  assert.ok(calls[0].startsWith('/sim?'));
});

/** Verifies _flush() clears the ad-hoc buffer so a later programmatic state change wins over a stale ad-hoc value for the same tracked key. */
test('URLSync._flush clears the ad-hoc buffer so a tracked key is not permanently overridden', () => {
  const calls = installWindow('', '/sim');
  const s = new AppState({ resolution: 'low' });
  const sync = new URLSync(s, ['resolution']);

  // The GUI writes a tracked key as an ad-hoc param (mirrors the DeepLinkGUI URL
  // writer for the Resolution control).
  sync.setParam('resolution', 'high');
  sync._flush();
  let params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('resolution'), 'high');

  // A later programmatic state change must win at the next flush: _flush clears
  // the ad-hoc buffer so the stale 'high' can't be re-applied over it.
  s.set('resolution', 'medium');
  sync._flush();
  params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('resolution'), 'medium');
});
