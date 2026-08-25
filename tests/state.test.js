import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installConsoleCapture } from './fake_console.js';
import {
  AppState,
  URLSync,
  getActiveURLSync,
  overlayUrlParam,
  replaceUrl,
  roundUrlNumber,
  URL_FLUSH_DEBOUNCE_MS,
  URL_FLUSH_MAX_RETRIES,
  URL_FLUSH_RETRY_MS,
  writeUrl,
} from '../state.js';

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

test('AppState reads no key it was never given', () => {
  const s = new AppState({ a: 1 });
  assert.equal(s.get('toString'), undefined,
    'an inherited member must not answer as state');
  s.set('toString', 'x');
  assert.equal(s.get('toString'), 'x');
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

test('AppState.update does not re-announce a key a re-entrant write restored', () => {
  const s = new AppState({ a: 0, b: 0 });
  const events = [];
  s.subscribe((key, value, old) => {
    events.push([key, value, old]);
    // While the batch drains on 'a', drive the still-queued 'b' away and back to
    // the value the batch queued.
    if (key === 'a') { s.set('b', 9); s.set('b', 2); }
  });

  s.update({ a: 1, b: 2 });

  // 'b' ends at the queued value, but it was already dispatched: firing the batch
  // tuple would announce b=2 twice, the second time as a 0 -> 2 transition that
  // never happened.
  assert.deepEqual(events, [['a', 1, 0], ['b', 9, 2], ['b', 2, 9]]);
});

test('AppState.update notifies a nested update of an already-dispatched key', () => {
  const s = new AppState({ a: 0, b: 0 });
  const events = [];
  let reentered = false;
  s.subscribe((key, value, old) => {
    events.push([key, value, old]);
    // Re-enter update() on 'a', which this batch has already dispatched.
    if (key === 'b' && !reentered) { reentered = true; s.update({ a: 7 }); }
  });

  s.update({ a: 1, b: 2 });

  // The nested write is a transition of its own, so it is announced like the
  // same write through set() would be, and neither batch fires a key twice.
  assert.deepEqual(events, [['a', 1, 0], ['b', 2, 0], ['a', 7, 1]]);
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

test('AppState.subscribe unsubscribes one registration of a shared callback', () => {
  const s = new AppState({ a: 1 });
  let count = 0;
  const shared = () => count++;
  const offFirst = s.subscribe(shared);
  s.subscribe(shared);

  offFirst();
  s.set('a', 2);
  assert.equal(count, 1, 'the second registration survives');

  offFirst(); // double invoke must not drop the survivor
  s.set('a', 3);
  assert.equal(count, 2);
});

test('AppState.notify skips a listener unsubscribed earlier in the same dispatch', () => {
  const s = new AppState({ a: 1 });
  const seen = [];
  let offSecond;
  s.subscribe(() => { offSecond(); });
  offSecond = s.subscribe((key, value) => seen.push(value));

  s.set('a', 2);
  assert.deepEqual(seen, [], 'a listener torn down mid-dispatch gets no callback');
});

test('AppState.notify still calls the surviving duplicate of a callback disposed mid-dispatch', () => {
  const s = new AppState({ a: 1 });
  const seen = [];
  const shared = (key, value) => seen.push(value);
  let offFirst;
  s.subscribe(() => { offFirst(); });
  offFirst = s.subscribe(shared);
  s.subscribe(shared);

  s.set('a', 2);
  assert.deepEqual(seen, [2], 'the disposed registration is skipped, its twin is not');
});

test('AppState.notify skips a listener added during the same dispatch', () => {
  const s = new AppState({ a: 1 });
  const seen = [];
  s.subscribe(() => { s.subscribe((key, value) => seen.push(value)); });

  s.set('a', 2);
  assert.deepEqual(seen, [], 'a listener added mid-dispatch waits for the next event');
  s.set('a', 3);
  assert.deepEqual(seen, [3]);
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

/**
 * A one-slot timer source a URLSync case fires by hand.
 * @returns {Object} The stand-in and its scheduled delays.
 */
function fakeUrlTimer() {
  const delays = [];
  let pending = null;
  return {
    delays,
    setTimeout(fn, ms) {
      pending = fn;
      delays.push(ms);
      return 0;
    },
    /** Runs the pending timer. @returns {void} */
    fire() {
      const fn = pending;
      pending = null;
      assert.ok(fn, 'a timer is pending');
      fn();
    },
  };
}

test('writeUrl assembles pathname, query and hash', () => {
  const calls = installWindow('', '/sim', '#frag');
  writeUrl(new URLSearchParams('effect=Voronoi&speed=2'));
  assert.deepEqual(calls, ['/sim?effect=Voronoi&speed=2#frag']);
});

test('writeUrl drops the query separator when no params survive', () => {
  const calls = installWindow('?effect=Voronoi', '/sim', '#frag');
  writeUrl(new URLSearchParams());
  assert.deepEqual(calls, ['/sim#frag']);
});

test('the URL layer reads and writes the window it was handed', () => {
  const globalCalls = installWindow('?effect=Global', '/global', '');
  const injectedCalls = [];
  const injected = {
    location: { search: '?effect=Injected', pathname: '/injected', hash: '' },
    history: { replaceState: (state, title, url) => { injectedCalls.push(url); } },
  };
  const state = new AppState({ effect: 'Seeded' });
  const sync = new URLSync(state, ['effect'], {}, injected);

  assert.equal(state.get('effect'), 'Injected');
  sync.flush();

  assert.deepEqual(injectedCalls, ['/injected?effect=Injected']);
  assert.deepEqual(globalCalls, []);
});

test('URLSync.reset leaves a bare path when nothing survives', () => {
  const calls = installWindow('?effect=Voronoi&speed=2', '/sim', '#frag');
  const sync = new URLSync(new AppState({ effect: 'Voronoi' }), []);

  sync.reset();
  sync.flush();

  assert.deepEqual(calls, ['/sim#frag']);
});

/**
 * replaceState is rate-limited (WebKit throws past ~100 writes per 30 s) and the
 * URL is cosmetic: a refused write must not surface as an app failure, least of
 * all inside a switch rollback, where it would be read as unrecoverable state.
 */
test('a refused history write does not propagate out of the URL layer', () => {
  globalThis.window = {
    location: { search: '', pathname: '/sim', hash: '' },
    history: { replaceState() { throw new Error('rate limit'); } },
  };
  const captured = installConsoleCapture('warn');
  try {
    assert.doesNotThrow(() => replaceUrl('/sim?effect=Voronoi'));
    assert.doesNotThrow(() => writeUrl(new URLSearchParams('effect=Voronoi')));

    const sync = new URLSync(new AppState({ effect: 'Voronoi' }), ['effect']);
    assert.doesNotThrow(() => { sync.reset(); sync.flush(); });
    assert.doesNotThrow(() => sync.flush());
  } finally {
    captured.restore();
  }
  assert.equal(captured.calls.length, 4, 'every refused write is reported once');
});

/**
 * A tracked key is re-read from state on every flush, so a refused write costs
 * it nothing. An ad-hoc GUI param lives only in the buffer: dropping it there
 * would lose the value with nothing left to re-assert it.
 */
test('URLSync holds its ad-hoc buffer through a refused history write', () => {
  const written = [];
  let refuse = true;
  const timer = fakeUrlTimer();
  const realSetTimeout = globalThis.setTimeout;
  const captured = installConsoleCapture('warn');
  globalThis.setTimeout = timer.setTimeout;
  globalThis.window = {
    location: { search: '', pathname: '/sim', hash: '' },
    history: {
      replaceState: (state, title, url) => {
        if (refuse) throw new Error('rate limit');
        written.push(url);
      },
    },
  };
  try {
    const sync = new URLSync(new AppState({ effect: 'Voronoi' }), ['effect']);
    sync.setParam('scale', 3);

    sync.flush();
    assert.deepEqual(written, [], 'the refused write left the URL as it was');
    assert.equal(timer.delays.at(-1), URL_FLUSH_RETRY_MS, 'a retry is armed');

    refuse = false;
    timer.fire();
    assert.deepEqual(written, ['/sim?effect=Voronoi&scale=3'],
      'the retry re-asserts the buffered ad-hoc param');

    sync.flush();
    assert.deepEqual(written.at(-1), '/sim?effect=Voronoi',
      'a landed ad-hoc write is not replayed from the buffer');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    captured.restore();
  }
});

/**
 * The rate limit the retry waits out clears on its own. A sandboxed iframe or a
 * file:// document refuses every write for the page's lifetime, and an unbounded
 * retry answers that with a 2-second timer and a console line per iteration,
 * forever, holding a buffer nothing will ever land.
 */
test('URLSync bounds its retries of a refused history write', () => {
  const written = [];
  let refuse = true;
  const timer = fakeUrlTimer();
  const realSetTimeout = globalThis.setTimeout;
  const captured = installConsoleCapture('warn');
  globalThis.setTimeout = timer.setTimeout;
  globalThis.window = {
    location: { search: '', pathname: '/sim', hash: '' },
    history: {
      replaceState: (state, title, url) => {
        if (refuse) throw new Error('SecurityError');
        written.push(url);
      },
    },
  };
  try {
    const sync = new URLSync(new AppState({ effect: 'Voronoi' }), ['effect']);
    sync.setParam('scale', 3);
    timer.delays.length = 0;

    sync.flush();
    for (let i = 1; i < URL_FLUSH_MAX_RETRIES; i++) timer.fire();

    assert.equal(timer.delays.length, URL_FLUSH_MAX_RETRIES - 1,
      'the retry kept re-arming past the bound');
    assert.equal(captured.messages.filter((m) => m.startsWith('URLSync:')).length, 1,
      'the exhaustion is reported once, not once per refused write');

    refuse = false;
    sync.flush();
    assert.deepEqual(written, ['/sim?effect=Voronoi'],
      'a tracked key is re-read from state, but the abandoned ad-hoc param is gone');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    captured.restore();
  }
});

/**
 * The bounded ladder is sized to outlast a 30-second rate-limit window. Letting
 * a concurrent write re-arm it at the debounce would spend all twenty attempts
 * inside that window and drop the buffer while the refusal was still standing.
 */
test('URLSync will not let a concurrent write shorten an armed retry', () => {
  const written = [];
  let refuse = true;
  const timer = fakeUrlTimer();
  const realSetTimeout = globalThis.setTimeout;
  const warn = console.warn;
  console.warn = () => {};
  globalThis.setTimeout = timer.setTimeout;
  globalThis.window = {
    location: { search: '', pathname: '/sim', hash: '' },
    history: {
      replaceState: (state, title, url) => {
        if (refuse) throw new Error('rate limit');
        written.push(url);
      },
    },
  };
  try {
    const state = new AppState({ effect: 'Voronoi' });
    const sync = new URLSync(state, ['effect']);

    sync.flush();
    assert.deepEqual(timer.delays, [URL_FLUSH_RETRY_MS], 'the refusal armed the retry');

    sync.setParam('scale', 3);
    assert.deepEqual(timer.delays, [URL_FLUSH_RETRY_MS],
      'an ad-hoc write did not re-arm at the debounce');

    state.set('effect', 'Hankin');
    assert.deepEqual(timer.delays, [URL_FLUSH_RETRY_MS],
      'a tracked-key change did not re-arm at the debounce either');

    refuse = false;
    timer.fire();
    assert.deepEqual(written, ['/sim?effect=Hankin&scale=3'],
      'the armed retry flushes both concurrent writes');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    console.warn = warn;
  }
});

test('URLSync reads initial tracked keys from the URL into state', () => {
  installWindow('?effect=Voronoi&res=high&untracked=1');
  const s = new AppState({ effect: 'Moire', res: 'low' });
  new URLSync(s, ['effect', 'res']);
  assert.equal(s.get('effect'), 'Voronoi');
  assert.equal(s.get('res'), 'high');
});

test('URLSync defers a tracked identity rewrite until resume', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=ShaderBall', '/sim');
    const state = new AppState({ effect: 'ShaderBall' });
    const sync = new URLSync(state, ['effect']);
    sync.suspend();
    state.set('effect', 'Shader');
    mock.timers.tick(1000);
    assert.equal(calls.length, 0);
    assert.equal(globalThis.window.location.search, '?effect=ShaderBall');

    sync.resume();
    mock.timers.tick(1000);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /effect=Shader/u);
  } finally {
    mock.timers.reset();
  }
});

test('URLSync counts nested suspensions and writes on the outermost resume', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=ShaderBall', '/sim');
    const state = new AppState({ effect: 'ShaderBall' });
    const sync = new URLSync(state, ['effect']);
    sync.suspend();
    sync.suspend();
    state.set('effect', 'Shader');
    mock.timers.tick(1000);
    assert.equal(calls.length, 0);

    sync.resume();
    mock.timers.tick(1000);
    assert.equal(calls.length, 0, 'the inner resume released the whole suspension');

    sync.resume();
    mock.timers.tick(1000);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /effect=Shader/u);
  } finally {
    mock.timers.reset();
  }
});

test('URLSync ignores a resume with no suspension outstanding', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=ShaderBall', '/sim');
    const state = new AppState({ effect: 'ShaderBall' });
    const sync = new URLSync(state, ['effect']);

    sync.resume();
    mock.timers.tick(1000);
    assert.equal(calls.length, 0, 'a bare resume scheduled a write');

    // A stray resume that drove the depth negative would leave the next
    // suspension unable to bracket anything.
    sync.suspend();
    state.set('effect', 'Shader');
    mock.timers.tick(1000);
    assert.equal(calls.length, 0, 'the suspension after a bare resume did not hold');

    sync.resume();
    mock.timers.tick(1000);
    assert.equal(calls.length, 1);
  } finally {
    mock.timers.reset();
  }
});

test('URLSync suspend disarms the flush the constructor already armed', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=bogus', '/sim');
    const state = new AppState({ effect: 'ShaderBall' });
    // Rejected by the validator, so the constructor arms a canonicalizing flush.
    const sync = new URLSync(state, ['effect'], { effect: (v) => v === 'Shader' });
    sync.suspend();
    state.set('effect', 'Shader');
    mock.timers.tick(1000);
    assert.equal(calls.length, 0, 'a flush fired inside the suspension');
    assert.equal(globalThis.window.location.search, '?effect=bogus');

    sync.resume();
    mock.timers.tick(1000);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /effect=Shader/u);
  } finally {
    mock.timers.reset();
  }
});

test('URLSync resume keeps a suspended retry at the ladder delay', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const warn = console.warn;
  console.warn = () => {};
  try {
    installWindow('?effect=bogus', '/sim');
    globalThis.window.history.replaceState = () => { throw new Error('rate limited'); };
    const state = new AppState({ effect: 'ShaderBall' });
    const sync = new URLSync(state, ['effect'], { effect: (v) => v === 'Shader' });
    mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
    assert.equal(sync.armedDelayMs, URL_FLUSH_RETRY_MS, 'the refusal armed the ladder');

    sync.suspend();
    sync.resume();
    assert.equal(sync.armedDelayMs, URL_FLUSH_RETRY_MS,
      'resume pulled the ladder forward to the debounce');
  } finally {
    console.warn = warn;
    mock.timers.reset();
  }
});

test('URLSync validator rejects an invalid URL value and keeps the default', () => {
  installWindow('?effect=Voronoi&res=bogus');
  const s = new AppState({ effect: 'Moire', res: 'low' });
  new URLSync(s, ['effect', 'res'], { res: (v) => v === 'high' || v === 'low' });
  assert.equal(s.get('effect'), 'Voronoi');
  assert.equal(s.get('res'), 'low');
});

test('URLSync validates against its own validators, not inherited members', () => {
  installWindow('?propertyIsEnumerable=high');
  const s = new AppState({ propertyIsEnumerable: 'low' });
  // Object.prototype.propertyIsEnumerable called on the validator map answers
  // false for every raw value, so an inherited hit would reject the whole key.
  new URLSync(s, ['propertyIsEnumerable'], {});
  assert.equal(s.get('propertyIsEnumerable'), 'high');
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

test('URLSync keeps a numeric default when the URL value has trailing garbage', () => {
  for (const raw of ['42abc', '0x10', '1,5', '4 2', 'Infinity', '1.2.3']) {
    installWindow(`?count=${encodeURIComponent(raw)}`);
    const s = new AppState({ count: 7 });
    new URLSync(s, ['count']);
    assert.strictEqual(s.get('count'), 7, `"${raw}" is rejected whole`);
    getActiveURLSync().dispose();
  }
});

test('URLSync coerces well-formed numeric URL values', () => {
  for (const [raw, want] of [['42', 42], ['-3.5', -3.5], ['.25', 0.25], ['1e3', 1000], [' 8 ', 8]]) {
    installWindow(`?count=${encodeURIComponent(raw)}`);
    const s = new AppState({ count: 7 });
    new URLSync(s, ['count']);
    assert.strictEqual(s.get('count'), want, `"${raw}" coerces to ${want}`);
    getActiveURLSync().dispose();
  }
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

test('URLSync skips an unseeded tracked key rather than seeding the raw string', () => {
  installWindow('?flag=false');
  const errors = mock.method(console, 'error', () => {});
  try {
    const s = new AppState({});
    new URLSync(s, ['flag']);
    assert.strictEqual(s.get('flag'), undefined, 'no target type: the key stays unset');
    assert.equal(errors.mock.callCount(), 1, 'the misconfiguration is reported');
  } finally {
    errors.mock.restore();
  }
});

test('overlayUrlParam serializes a boolean through String(val)', () => {
  const params = new URLSearchParams();
  overlayUrlParam(params, 'flag', true);
  assert.equal(params.get('flag'), 'true', 'true round-trips as the string "true"');
  overlayUrlParam(params, 'flag', false);
  assert.equal(params.get('flag'), 'false', 'false round-trips as the string "false"');
});

test('overlayUrlParam rounds numbers and deletes values with no URL form', () => {
  const params = new URLSearchParams('keep=1&speed=9');
  overlayUrlParam(params, 'speed', 1.234567);
  assert.equal(params.get('speed'), '1.2346', 'a float is cut to 5 significant digits');
  overlayUrlParam(params, 'count', 42);
  assert.equal(params.get('count'), '42', 'an integer keeps no decimal tail');
  for (const empty of [null, undefined, NaN, Infinity]) {
    overlayUrlParam(params, 'speed', 1.5);
    overlayUrlParam(params, 'speed', empty);
    assert.equal(params.has('speed'), false, `${empty} drops the param`);
  }
  assert.equal(params.get('keep'), '1', 'unrelated params survive');
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

test('URLSync construction disposes the previous writer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=Voronoi', '/sim');
    const s = new AppState({ effect: 'Voronoi' });
    const first = new URLSync(s, ['effect']);
    const second = new URLSync(s, ['effect']);

    assert.equal(getActiveURLSync(), second);
    assert.equal(first.unsubscribe, null, 'the orphan dropped its subscription');

    s.set('effect', 'Moire');
    mock.timers.tick(200);
    assert.equal(calls.length, 1, 'only the live writer flushes');
  } finally {
    mock.timers.reset();
  }
});

test('URLSync.dispose stops a later setParam from re-arming the flush', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=Voronoi', '/sim');
    const s = new AppState({ effect: 'Voronoi' });
    const sync = new URLSync(s, ['effect']);

    sync.dispose();
    sync.setParam('resolution', 'high'); // a stale reference writing into a discarded page
    sync.schedule();
    mock.timers.tick(200);

    assert.equal(calls.length, 0, 'a disposed writer never touches history');
  } finally {
    mock.timers.reset();
  }
});

test('URLSync.flush writes tracked state and ad-hoc params to the URL', () => {
  const calls = installWindow('', '/sim');
  const s = new AppState({ effect: 'Voronoi' });
  const sync = new URLSync(s, ['effect']);

  sync.setParam('speed', 1.23456); // rounded to 5 significant digits
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

test('URLSync.setParam cannot override a tracked key with a stale value', () => {
  const calls = installWindow('', '/sim');
  const s = new AppState({ resolution: 'low' });
  const sync = new URLSync(s, ['resolution']);

  // The GUI can address a tracked key as an ad-hoc param; the state still wins.
  sync.setParam('resolution', 'high');
  sync.flush();
  let params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('resolution'), 'low');

  s.set('resolution', 'medium');
  sync.flush();
  params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('resolution'), 'medium');
});

/**
 * A rejected resolution switch re-asserts the rolled-back value; a valid switch
 * landing inside the same debounce window must still be what the shareable URL
 * advertises, since nothing schedules a correction after the flush.
 */
test('a re-asserted tracked value does not survive a later switch in the same window', () => {
  const calls = installWindow('?resolution=low', '/sim');
  const s = new AppState({ resolution: 'low' });
  const sync = new URLSync(s, ['resolution']);

  sync.setParam('resolution', s.get('resolution')); // the rejected switch's re-assert
  s.set('resolution', 'high');                      // accepted, inside the window
  sync.flush();

  const params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('resolution'), 'high', 'the link carries the applied value');

  sync.flush();
  const after = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(after.get('resolution'), 'high', 'and no buffered write resurrects the old one');
});

test('URLSync.reset re-asserts tracked state over an ad-hoc write of the same key', () => {
  const calls = installWindow('?speed=2', '/sim');
  const s = new AppState({ resolution: 'high' });
  const sync = new URLSync(s, ['resolution']);

  sync.setParam('resolution', 'low');
  sync.reset(['resolution']);
  sync.flush();

  const params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('resolution'), 'high');
  assert.equal(params.has('speed'), false, 'unexcluded params are cleared');
});

test('URLSync.reset carries an excluded ad-hoc write over the value it replaces', () => {
  const calls = installWindow('?speed=2&junk=1', '/sim');
  const s = new AppState({ resolution: 'high' });
  const sync = new URLSync(s, ['resolution']);

  sync.setParam('speed', 3); // untracked, still buffered inside the debounce window
  sync.setParam('junk', 9);
  sync.reset(['resolution', 'speed']);
  sync.flush();

  const params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('speed'), '3', 'the buffered write survives, not the URL value it replaces');
  assert.equal(params.has('junk'), false, 'an unexcluded ad-hoc write is dropped with its param');
  assert.equal(params.get('resolution'), 'high', 'tracked state is re-asserted');
});

/**
 * reset() only schedules the clear, so a reader inside the debounce window still
 * sees the params on their way out — the deep-link GUI rebuilds an effect panel
 * there, and would hydrate it from the outgoing effect's values.
 */
test('URLSync.applyPendingReset hides the params a scheduled reset will clear', () => {
  installWindow('?speed=2&keep=1', '/sim');
  const sync = new URLSync(new AppState({ resolution: 'high' }), ['resolution']);

  const before = new URLSearchParams('speed=2&keep=1');
  sync.applyPendingReset(before);
  assert.equal(before.get('speed'), '2', 'nothing is hidden with no reset pending');

  sync.reset(['keep']);
  const during = new URLSearchParams('speed=2&keep=1');
  sync.applyPendingReset(during);
  assert.equal(during.has('speed'), false);
  assert.equal(during.get('keep'), '1', 'an excluded key is still readable');

  sync.flush();
  const after = new URLSearchParams('speed=2&keep=1');
  sync.applyPendingReset(after);
  assert.equal(after.get('speed'), '2', 'the flush ends the window');
});

/**
 * setParam() only buffers; the write reaches the URL on the next flush. A reader
 * inside that window — the deep-link GUI rebuilding a panel — has to see the
 * buffered value, not the query-string one it is about to replace.
 */
test('URLSync.overlayPending applies the writes buffered for the next flush', () => {
  installWindow('?speed=2&drop=1', '/sim');
  const sync = new URLSync(new AppState({ resolution: 'high' }), ['resolution']);

  const before = new URLSearchParams('speed=2&drop=1');
  sync.overlayPending(before);
  assert.equal(before.get('speed'), '2', 'nothing is overlaid with no write buffered');

  sync.setParam('speed', 3);
  sync.setParam('drop', null);
  const during = new URLSearchParams('speed=2&drop=1');
  sync.overlayPending(during);
  assert.equal(during.get('speed'), '3', 'the buffered write wins over the URL value');
  assert.equal(during.has('drop'), false, 'a deletion marker drops the key');

  sync.flush();
  const after = new URLSearchParams('speed=2&drop=1');
  sync.overlayPending(after);
  assert.equal(after.get('speed'), '2', 'the flush empties the buffer');
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

test('URLSync.setParam keeps a small non-zero value instead of collapsing it to 0', () => {
  const calls = installWindow('?keep=1', '/sim');
  const s = new AppState({});
  const sync = new URLSync(s, []);

  sync.setParam('speed', 1.5);
  sync.flush();
  let params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('speed'), '1.5');

  sync.setParam('speed', 1e-6);
  sync.flush();
  params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('speed'), '0.000001', 'a small magnitude survives the link');
  assert.equal(params.get('keep'), '1', 'unrelated params survive');
});

/**
 * The engine's tightest slider ranges (GSReactionDiffusion's dA/dB are [0, 0.05])
 * carry a lil-gui implicit step of a thousandth of the range. Every step must
 * reach the URL as a distinct value, or a shared link silently snaps elsewhere.
 */
test('roundUrlNumber resolves every step of the engine\'s tightest param range', () => {
  const min = 0, max = 0.05, step = (max - min) / 1000;
  const seen = new Set();
  for (let k = 0; k <= 1000; k++) {
    const rounded = roundUrlNumber(min + k * step);
    assert.notEqual(rounded, null, `step ${k} has no URL representation`);
    seen.add(String(rounded));
  }
  assert.equal(seen.size, 1001, 'adjacent slider steps must not share a URL value');
});

test('roundUrlNumber is a fixed point under re-serialization', () => {
  for (const v of [1.23456, 0.000012345, 5e-5, 1234.5678, 0.30000000000000004, 0, 2000]) {
    const once = roundUrlNumber(v);
    assert.equal(roundUrlNumber(Number(String(once))), once, `${v} is not stable`);
  }
});

test('URLSync serializes an exact zero rather than dropping it', () => {
  const calls = installWindow('', '/sim');
  const s = new AppState({ speed: 0 });
  const sync = new URLSync(s, ['speed']);

  sync.flush();
  const params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.get('speed'), '0', 'a legitimate 0 round-trips');
});

test('URLSync.flush drops a tracked key cleared to null', () => {
  const calls = installWindow('?effect=Voronoi&keep=1', '/sim');
  const s = new AppState({ effect: 'Voronoi' });
  const sync = new URLSync(s, ['effect']);

  s.set('effect', null);
  sync.flush();

  const params = new URLSearchParams(calls[calls.length - 1].split('?')[1]);
  assert.equal(params.has('effect'), false, 'the stale value cannot re-seed state on reload');
  assert.equal(params.get('keep'), '1', 'unrelated params survive');
});

test('URLSync.reset preserves the excluded keys and clears the rest', () => {
  const calls = installWindow('?effect=Voronoi&speed=2&junk=x', '/sim');
  const s = new AppState({ effect: 'Voronoi' });
  const sync = new URLSync(s, ['effect']);

  sync.reset(['junk']);
  sync.flush();

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

test('URLSync corrects a URL advertising a rejected value, and converges', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=Bogus&keep=1', '/sim');
    const s = new AppState({ effect: 'Voronoi' });
    new URLSync(s, ['effect'], { effect: (v) => v === 'Voronoi' });

    assert.equal(calls.length, 0, 'no synchronous write on construction');
    mock.timers.tick(200);
    assert.equal(calls.length, 1, 'exactly one corrective write');
    const search = `?${calls[0].split('?')[1]}`;
    const params = new URLSearchParams(search);
    assert.equal(params.get('effect'), 'Voronoi', 'the URL advertises what renders');
    assert.equal(params.get('keep'), '1', 'unrelated params survive');

    getActiveURLSync().dispose();
    const reloaded = installWindow(search, '/sim');
    new URLSync(new AppState({ effect: 'Voronoi' }), ['effect'], { effect: (v) => v === 'Voronoi' });
    mock.timers.tick(200);
    assert.equal(reloaded.length, 0, 'the corrected URL rewrites nothing on reload');
  } finally {
    mock.timers.reset();
  }
});

test('URLSync rewrites a URL value it accepted in a non-canonical form', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?flag=on&count=%208%20', '/sim');
    const s = new AppState({ flag: false, count: 0 });
    new URLSync(s, ['flag', 'count']);

    mock.timers.tick(200);
    assert.equal(calls.length, 1, 'exactly one corrective write');
    const params = new URLSearchParams(calls[0].split('?')[1]);
    assert.equal(params.get('flag'), 'true');
    assert.equal(params.get('count'), '8');
  } finally {
    mock.timers.reset();
  }
});

test('URLSync writes nothing when the URL already matches state', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=Voronoi&count=8&untracked=x', '/sim');
    const s = new AppState({ effect: 'Voronoi', count: 0 });
    new URLSync(s, ['effect', 'count']);

    mock.timers.tick(200);
    assert.equal(calls.length, 0, 'a faithful URL is left alone');
  } finally {
    mock.timers.reset();
  }
});

test('URLSync.reset collapses into the pending debounced flush', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=Voronoi&speed=2', '/sim');
    const s = new AppState({ effect: 'Voronoi' });
    const sync = new URLSync(s, ['effect']);

    s.set('effect', 'Moire'); // arms the 200 ms debounce
    sync.reset();
    assert.equal(calls.length, 0, 'no write outside the debounce');

    mock.timers.tick(200);
    assert.equal(calls.length, 1, 'the reset and the pending change share one write');
    const params = new URLSearchParams(calls[0].split('?')[1]);
    assert.equal(params.get('effect'), 'Moire', 'reset re-asserted current state');
    assert.equal(params.has('speed'), false, 'unexcluded params are cleared');
  } finally {
    mock.timers.reset();
  }
});

/**
 * Every effect switch resets the URL, so a burst must cost one write rather than
 * one per switch: spending the browser's replaceState budget is what makes it
 * throw.
 */
test('a burst of resets costs a single URL write', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const calls = installWindow('?effect=Voronoi&fx.speed=2', '/sim');
    const s = new AppState({ effect: 'Voronoi' });
    const sync = new URLSync(s, ['effect']);

    for (const effect of ['Moire', 'Comets', 'Voronoi']) {
      s.set('effect', effect);
      sync.reset(['effect']);
    }
    mock.timers.tick(200);

    assert.equal(calls.length, 1);
    const params = new URLSearchParams(calls[0].split('?')[1]);
    assert.equal(params.get('effect'), 'Voronoi');
    assert.equal(params.has('fx.speed'), false, "the outgoing effect's params are gone");
  } finally {
    mock.timers.reset();
  }
});
