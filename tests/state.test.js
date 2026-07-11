// @ts-check
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { AppState, URLSync, getActiveURLSync } from '../state.js';

// Dispose the active URLSync before restoring window: a debounced flush() would
// otherwise fire into a deleted window after teardown.
const savedWindow = globalThis.window;
afterEach(() => {
  const sync = getActiveURLSync();
  if (sync) sync.dispose();
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
});

test('AppState.get returns defaults and set updates', () => {
  const s = new AppState({ a: 1, b: 'x' });
  assert.equal(s.get('a'), 1);
  assert.equal(s.get('b'), 'x');
  s.set('a', 2);
  assert.equal(s.get('a'), 2);
});

test('AppState.set notifies with (key, new, old) and skips no-op writes', () => {
  const s = new AppState({ a: 1 });
  const events = [];
  s.subscribe((key, value, old) => events.push([key, value, old]));

  s.set('a', 1);            // no-op: same value
  s.set('a', 2);
  assert.deepEqual(events, [['a', 2, 1]]);
});

test('AppState.update batches and only fires for changed keys', () => {
  const s = new AppState({ a: 1, b: 2, c: 3 });
  const events = [];
  s.subscribe((key, value, old) => events.push([key, value, old]));

  s.update({ a: 1, b: 20, c: 30 }); // a unchanged
  assert.deepEqual(events, [['b', 20, 2], ['c', 30, 3]]);
});

test('AppState.update skips a queued tuple a re-entrant set already superseded', () => {
  const s = new AppState({ a: 0, b: 0 });
  const events = [];
  s.subscribe((key, value, old) => {
    events.push([key, value, old]);
    // While the batch drains on 'a', re-enter set() on the still-queued 'b'.
    if (key === 'a') s.set('b', 99);
  });

  s.update({ a: 1, b: 2 }); // both change; 'a' fires first and supersedes 'b'

  // 'b' is notified once with the live re-entrant value (99); the stale batch
  // tuple ([b, 2, 0]) is skipped rather than firing a superseded notification.
  assert.deepEqual(events, [['a', 1, 0], ['b', 99, 2]]);
});

test('AppState.subscribe returns an unsubscribe function', () => {
  const s = new AppState({ a: 1 });
  let count = 0;
  const off = s.subscribe(() => count++);
  s.set('a', 2);
  off();
  s.set('a', 3);
  assert.equal(count, 1);
});

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
 * @param {string} [hash] - The location.hash the stub reports (always a string in a
 *   real browser; '' when no fragment).
 * @returns {Array<string>} A live array that collects each URL passed to history.replaceState.
 */
function installWindow(search = '', pathname = '/', hash = '') {
  const calls = [];
  globalThis.window = {
    location: { search, pathname, hash },
    history: {
      replaceState: (state, title, url) => { calls.push(url); },
    },
  };
  return calls;
}

test('URLSync reads initial tracked keys from the URL into state', () => {
  installWindow('?effect=Voronoi&res=high&untracked=1');
  const s = new AppState({ effect: 'Moire', res: 'low' });
  new URLSync(s, ['effect', 'res']);
  assert.equal(s.get('effect'), 'Voronoi');
  assert.equal(s.get('res'), 'high');
});

test('URLSync validator rejects an invalid URL value and keeps the default', () => {
  installWindow('?effect=Voronoi&res=bogus');
  const s = new AppState({ effect: 'Moire', res: 'low' });
  new URLSync(s, ['effect', 'res'], { res: (v) => v === 'high' || v === 'low' });
  assert.equal(s.get('effect'), 'Voronoi');
  assert.equal(s.get('res'), 'low');
});

test('URLSync coerces a URL value to a numeric default key', () => {
  installWindow('?count=42');
  const s = new AppState({ count: 0 });
  new URLSync(s, ['count']);
  assert.strictEqual(s.get('count'), 42);
});

test('URLSync keeps a numeric default when the URL value is non-finite', () => {
  installWindow('?count=abc');
  const s = new AppState({ count: 7 });
  new URLSync(s, ['count']);
  assert.strictEqual(s.get('count'), 7);
});

test('URLSync keeps a numeric default for an empty URL value', () => {
  installWindow('?count=');
  const s = new AppState({ count: 5 });
  new URLSync(s, ['count']);
  assert.strictEqual(s.get('count'), 5);
});

test('URLSync coerces a boolean default tracked key from truthy URL tokens', () => {
  for (const raw of ['true', '1', 'yes', 'on', 'TRUE', ' On ']) {
    installWindow(`?flag=${encodeURIComponent(raw)}`);
    const s = new AppState({ flag: false });
    new URLSync(s, ['flag']);
    assert.strictEqual(s.get('flag'), true, `"${raw}" coerces to true`);
    getActiveURLSync().dispose();
  }
});

test('URLSync coerces a boolean default tracked key from falsy URL tokens', () => {
  for (const raw of ['false', '0', 'no', 'off', 'OFF']) {
    installWindow(`?flag=${encodeURIComponent(raw)}`);
    const s = new AppState({ flag: true });
    new URLSync(s, ['flag']);
    assert.strictEqual(s.get('flag'), false, `"${raw}" coerces to false`);
    getActiveURLSync().dispose();
  }
});

test('URLSync keeps a boolean default for an unrecognized URL token', () => {
  installWindow('?flag=maybe');
  const s = new AppState({ flag: true });
  new URLSync(s, ['flag']);
  assert.strictEqual(s.get('flag'), true, 'a garbage token keeps the default');
});

test('URLSync serializes a boolean tracked key through String(val)', () => {
  installWindow('', '/sim');
  const s = new AppState({ flag: true });
  const sync = new URLSync(s, ['flag']);
  const params = new URLSearchParams();
  sync.setTrackedParam(params, 'flag', s.get('flag'));
  assert.equal(params.get('flag'), 'true', 'true round-trips as the string "true"');
  sync.setTrackedParam(params, 'flag', false);
  assert.equal(params.get('flag'), 'false', 'false round-trips as the string "false"');
});

test('URLSync validator admits a valid URL value', () => {
  installWindow('?res=high');
  const s = new AppState({ res: 'low' });
  new URLSync(s, ['res'], { res: (v) => v === 'high' || v === 'low' });
  assert.equal(s.get('res'), 'high');
});

test('URLSync registers itself as the active URL writer', () => {
  installWindow('');
  const s = new AppState({});
  const sync = new URLSync(s, ['effect']);
  assert.equal(getActiveURLSync(), sync);
});

test('URLSync.flush writes tracked state and ad-hoc params to the URL', () => {
  const calls = installWindow('', '/sim');
  const s = new AppState({ effect: 'Voronoi' });
  const sync = new URLSync(s, ['effect']);

  sync.setParam('speed', 1.23456); // rounded to 4 dp
  sync.flush();

  assert.equal(calls.length, 1);
  const params = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(params.get('effect'), 'Voronoi');
  assert.equal(params.get('speed'), '1.2346');
  assert.ok(calls[0].startsWith('/sim?'));
});

test('URLSync.flush preserves an existing location.hash', () => {
  const calls = installWindow('', '/sim', '#frag');
  const s = new AppState({ effect: 'Voronoi' });
  const sync = new URLSync(s, ['effect']);

  sync.flush();

  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('#frag'), `expected hash preserved, got ${calls[0]}`);
  assert.equal(new URLSearchParams(calls[0].split('?')[1].split('#')[0]).get('effect'), 'Voronoi');
});

test('URLSync.flush clears the ad-hoc buffer so a tracked key is not permanently overridden', () => {
  const calls = installWindow('', '/sim');
  const s = new AppState({ resolution: 'low' });
  const sync = new URLSync(s, ['resolution']);

  // The GUI can write a tracked key as an ad-hoc param.
  sync.setParam('resolution', 'high');
  sync.flush();
  let params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('resolution'), 'high');

  s.set('resolution', 'medium');
  sync.flush();
  params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('resolution'), 'medium');
});

test('URLSync.setParam(k, null) drops the key from the URL on flush', () => {
  const calls = installWindow('?keep=1', '/sim');
  const s = new AppState({});
  const sync = new URLSync(s, []);

  sync.setParam('speed', 1.5); // first write the param
  sync.flush();
  let params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('speed'), '1.5');

  sync.setParam('speed', null); // deletion marker
  sync.flush();
  params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.has('speed'), false, 'null marker removes the param');
  assert.equal(params.get('keep'), '1', 'unrelated params survive');
});

test('URLSync.setParam(k, NaN) drops the key from the URL on flush', () => {
  const calls = installWindow('?keep=1', '/sim');
  const s = new AppState({});
  const sync = new URLSync(s, []);

  sync.setParam('speed', 1.5); // first write the param
  sync.flush();
  let params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('speed'), '1.5');

  sync.setParam('speed', NaN); // non-finite rounds to null: drop, don't serialize a 0
  sync.flush();
  params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.has('speed'), false, 'non-finite numeric drops the param');
  assert.equal(params.get('keep'), '1', 'unrelated params survive');
});

test('URLSync.reset preserves the excluded keys and clears the rest', () => {
  const calls = installWindow('?effect=Voronoi&speed=2&junk=x', '/sim');
  const s = new AppState({ effect: 'Voronoi' });
  const sync = new URLSync(s, ['effect']);

  sync.reset(['junk']);

  assert.equal(calls.length, 1);
  const params = new URLSearchParams(calls[0].split('?')[1]);
  assert.equal(params.get('junk'), 'x', 'excluded key preserved');
  assert.equal(params.get('effect'), 'Voronoi', 'tracked state re-asserted');
  assert.equal(params.has('speed'), false, 'unexcluded, untracked key cleared');
});

test('URLSync auto-flushes a tracked-key change once after the debounce', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=Voronoi', '/sim');
    const s = new AppState({ effect: 'Voronoi' });
    new URLSync(s, ['effect']);

    s.set('effect', 'Moire'); // arms the 200 ms debounce
    assert.equal(calls.length, 0, 'no synchronous write on set');
    mock.timers.tick(199);
    assert.equal(calls.length, 0, 'nothing before the debounce elapses');
    mock.timers.tick(1);
    assert.equal(calls.length, 1, 'exactly one debounced write at 200 ms');
    const params = new URLSearchParams(calls[0].split('?')[1]);
    assert.equal(params.get('effect'), 'Moire', 'the new value is written');
  } finally {
    mock.timers.reset();
  }
});

test('URLSync.reset cancels a pending debounced flush', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=Voronoi', '/sim');
    const s = new AppState({ effect: 'Voronoi' });
    const sync = new URLSync(s, ['effect']);

    s.set('effect', 'Moire'); // arms the 200 ms debounce
    sync.reset();             // resets immediately and must cancel the pending flush
    assert.equal(calls.length, 1, 'reset wrote once');

    mock.timers.tick(200);    // would fire the cancelled flush if still armed
    assert.equal(calls.length, 1, 'no stale debounced write fired after reset');
    const params = new URLSearchParams(calls[0].split('?')[1]);
    assert.equal(params.get('effect'), 'Moire', 'reset re-asserted current state');
  } finally {
    mock.timers.reset();
  }
});
