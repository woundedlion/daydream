/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Significant digits kept by roundUrlNumber. A lil-gui slider's implicit step is
// a thousandth of its range, so 5 digits resolve every step of a param at any
// magnitude, including one whose whole range is a small fraction of 1.
const URL_SIGNIFICANT_DIGITS = 5;

/**
 * Round a numeric URL-param value to URL_SIGNIFICANT_DIGITS significant digits,
 * dropping trailing-zero noise. Number() re-parses the rounded string so 0.50000
 * collapses back to 0.5.
 * @param {number} value - The numeric value to serialize.
 * @returns {number|null} The rounded value, or null for a non-finite input so
 *   callers drop the key rather than emit a misleading 0. Rounding preserves
 *   magnitude, so only an exact 0 serializes as 0.
 */
export function roundUrlNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toPrecision(URL_SIGNIFICANT_DIGITS));
}

/**
 * Serialize a value the way the URL stores it: numbers through roundUrlNumber,
 * everything else stringified. The one serialization rule behind every deep-link
 * write, so no writer can drift from another.
 * @param {*} value - The value to serialize.
 * @returns {string|null} The param string, or null when the value has no URL
 *   representation (null/undefined, or a non-finite number) and the key is
 *   dropped instead of serializing a 0 the app never held.
 */
export function canonicalUrlParam(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    const rounded = roundUrlNumber(value);
    return rounded === null ? null : String(rounded);
  }
  return String(value);
}

/**
 * Overlay one key onto a URLSearchParams under the canonical serialization,
 * deleting the key when the value has no URL representation.
 * @param {URLSearchParams} params - The params object to mutate.
 * @param {string} key - The param name.
 * @param {*} value - The value to serialize.
 * @returns {void}
 */
export function overlayUrlParam(params, key, value) {
  const str = canonicalUrlParam(value);
  if (str === null) params.delete(key);
  else params.set(key, str);
}

// A URL number must be wholly numeric: parseFloat would take the leading digits
// of "42abc" and read "0x10" as 0, and Number() accepts "0x10" as 16.
const URL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

const URL_TRUE = new Set(['true', '1', 'yes', 'on']);
const URL_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * Parse a URL param string as a number under the one URL scalar grammar shared
 * by every deep-link reader: surrounding whitespace is allowed, the rest must be
 * a plain decimal (optionally signed, optionally exponent) and finite.
 * @param {string} raw - The raw URL param string.
 * @returns {number|null} The parsed number, or null when the string is not one.
 */
export function parseUrlNumber(raw) {
  const t = raw.trim();
  if (!URL_NUMBER.test(t)) return null;
  const num = Number(t);
  return Number.isFinite(num) ? num : null;
}

/**
 * Parse a URL param string as a boolean under the one token table shared by
 * every deep-link reader; case- and whitespace-insensitive.
 * @param {string} raw - The raw URL param string.
 * @returns {boolean|null} The parsed boolean, or null for an unrecognized token.
 */
export function parseUrlBoolean(raw) {
  const t = raw.trim().toLowerCase();
  if (URL_TRUE.has(t)) return true;
  if (URL_FALSE.has(t)) return false;
  return null;
}

// Debounce window collapsing a burst of URL writes into one replaceState. Long
// enough to swallow a slider drag, short enough that a copied link is current.
export const URL_FLUSH_DEBOUNCE_MS = 200;

// Re-arm delay after a refused replaceState. Longer than the debounce so a retry
// run does not spend the browser's write budget faster than the rate limit it is
// waiting out.
export const URL_FLUSH_RETRY_MS = 2000;

// Consecutive refused writes before the retry gives up and the buffer is
// dropped. The product outlasts WebKit's 30 s rate-limit window, which is the
// refusal a wait clears; a sandboxed iframe or a file:// document refuses every
// write for the page's lifetime, and no number of retries reaches one.
export const URL_FLUSH_MAX_RETRIES = 20;

/**
 * Replace the current history entry with a URL, reporting a refused write
 * instead of propagating it.
 * @details Browsers rate-limit replaceState (WebKit: ~100 per 30 s) and throw
 *   past the limit. Every URL write is cosmetic, so a throw must not escape into
 *   an apply or rollback path that would read it as a state failure.
 * @param {string} url - The URL to write.
 * @returns {boolean} Whether the URL was written; false when the browser refused it.
 */
export function replaceUrl(url) {
  try {
    window.history.replaceState({}, '', url);
    return true;
  } catch (e) {
    console.warn('URL update skipped:', e);
    return false;
  }
}

/**
 * The single assembly point for every deep-link URL write: replaceState with
 * pathname + query + the existing location.hash, which rebuilding from pathname
 * alone would drop.
 * @param {URLSearchParams} params - The query params to write; empty writes a bare path.
 * @returns {boolean} Whether the URL was written; false when the browser refused it.
 */
export function writeUrl(params) {
  const qs = params.toString();
  const base = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  return replaceUrl(base + window.location.hash);
}

/**
 * Centralized application state with subscriber pattern and URL synchronization.
 * Separates state management from DOM manipulation — subscribers react to changes
 * independently rather than being orchestrated imperatively.
 */
export class AppState {
  /**
   * Creates an AppState seeded with optional initial values.
   * @param {Object} defaults - Initial key/value pairs seeding the state.
   */
  constructor(defaults = {}) {
    // Null prototype: keys are arbitrary strings, and an inherited one
    // ("constructor", "toString") would read back as state the app never set.
    this.state = { __proto__: null, ...defaults };
    this.listeners = [];
    this.batchDepth = 0;
    // key -> notifications dispatched since the outermost batch began. A queued
    // tuple is compared against the count taken when its batch was captured, so
    // a nested batch is measured from its own starting point rather than
    // inheriting an enclosing batch's dispatches.
    this.dispatchCounts = new Map();
  }

  /**
   * Reads a single state value by key.
   * @param {string} key - The state key to look up.
   * @returns {*} The current value for the key, or undefined if unset.
   */
  get(key) { return this.state[key]; }

  /**
   * Sets one key, notifying subscribers only when the value changes (strict
   * `===`, so keys must hold primitives — reference values mis-detect).
   * @param {string} key - The state key to write.
   * @param {*} value - The new value to store (intended to be a primitive).
   * @returns {void}
   */
  set(key, value) {
    if (this.state[key] === value) return;
    const old = this.state[key];
    this.state[key] = value;
    this.notify(key, value, old);
  }

  /**
   * Batch-sets multiple keys: all keys are written FIRST, then subscribers are
   * notified (one per changed key), so a callback reading a sibling batched key
   * sees its post-batch value. Unlike set(), which writes+notifies per key.
   * @param {Object} patch - Key/value pairs to merge into the state.
   * @returns {void}
   */
  update(patch) {
    const changes = [];
    for (const [key, value] of Object.entries(patch)) {
      if (this.state[key] !== value) {
        const old = this.state[key];
        this.state[key] = value;
        changes.push([key, value, old]);
      }
    }
    // A subscriber may re-enter set()/update() while this batch drains and notify
    // a key still queued below. Skip a queued tuple whose key went out after this
    // batch captured it: its `old` no longer describes a transition that happened.
    const captured = new Map();
    for (const [key] of changes) captured.set(key, this.dispatchCounts.get(key) ?? 0);
    this.batchDepth++;
    try {
      for (const [key, value, old] of changes) {
        if ((this.dispatchCounts.get(key) ?? 0) !== captured.get(key)) continue;
        this.notify(key, value, old);
      }
    } finally {
      if (--this.batchDepth === 0) this.dispatchCounts.clear();
    }
  }

  /**
   * Subscribes to state changes.
   * @param {Function} callback - Invoked as (key, newValue, oldValue) on each change.
   * @returns {Function} An unsubscribe function that removes this registration
   *   only; the same callback registered twice needs both disposers, and calling
   *   one twice is a no-op.
   */
  subscribe(callback) {
    // Registrations are wrapped so duplicates of one callback stay distinguishable:
    // both disposal and notify's mid-dispatch recheck key off this object.
    const registration = { fn: callback };
    this.listeners.push(registration);
    return () => {
      const i = this.listeners.indexOf(registration);
      if (i !== -1) this.listeners.splice(i, 1);
    };
  }

  /**
   * Invokes every subscriber with the change tuple.
   * @param {string} key - The key that changed.
   * @param {*} value - The new value.
   * @param {*} old - The previous value.
   * @returns {void}
   */
  notify(key, value, old) {
    if (this.batchDepth > 0) {
      this.dispatchCounts.set(key, (this.dispatchCounts.get(key) ?? 0) + 1);
    }
    // Dispatch over a snapshot so a subscriber added during dispatch is not
    // invoked for the current event; membership is re-checked per call so one
    // removed during dispatch is not invoked either.
    for (const reg of this.listeners.slice()) {
      if (this.listeners.includes(reg)) reg.fn(key, value, old);
    }
  }

}

// Single app-wide URL writer; gui.js routes its param writes through this.
let activeURLSync = null;
/**
 * Returns the app-wide active URLSync instance, or null if none is constructed.
 * @returns {URLSync|null} The single registered URL writer.
 */
export const getActiveURLSync = () => activeURLSync;

/**
 * URL synchronization layer — the single owner of URL writes.
 * Subscribes to an AppState for tracked keys, accepts ad-hoc param writes from
 * the GUI layer, and reads initial values from the URL on construction. All
 * writes funnel through one debounced flush (read-modify-write at fire time),
 * so concurrent AppState and GUI updates merge instead of clobbering.
 */
export class URLSync {
  /**
   * Wires a URLSync to an AppState: reads initial values from the URL, subscribes
   * to tracked-key changes, and registers itself as the app-wide URL writer,
   * disposing any previously registered one.
   * @param {AppState} state - The app state to sync.
   * @param {string[]} trackedKeys - Which state keys to sync to the URL.
   * @param {Object<string, (raw: string) => boolean>} [validators] - Optional
   *   per-key predicate run against the raw URL string on the initial read; a
   *   key whose validator returns false keeps the state's existing (validated)
   *   default instead of being overwritten. Lives here, in the sync layer, so a
   *   garbage URL value can't poison state regardless of which consumer wires
   *   the URLSync — callers no longer have to re-validate after construction.
   */
  constructor(state, trackedKeys, validators = {}) {
    // Retire the previous writer: orphaned, it would keep its subscription and
    // could still arm a replaceState timer with no handle left to tear it down.
    if (activeURLSync) activeURLSync.dispose();
    this.state = state;
    this.trackedKeys = new Set(trackedKeys);
    this.timer = null;
    this.armedDelayMs = 0; // delay this.timer was armed with; 0 when unarmed
    this.disposed = false;
    this.adhoc = new Map(); // GUI-set params (key -> string), merged on flush
    this.pendingReset = null; // reset()'s excluded keys, applied by the next flush
    this.retries = 0; // consecutive refused writes, cleared by one that lands

    const params = new URLSearchParams(window.location.search);
    const patch = {};
    for (const key of trackedKeys) {
      if (!params.has(key)) continue;
      const raw = params.get(key);
      // Own keys only: Object.prototype carries a callable under every inherited
      // name, and one of those would pass every raw value it was handed.
      const validate = Object.hasOwn(validators, key) ? validators[key] : null;
      if (validate && !validate(raw)) continue;
      // Coerce to the seeded default's type so a numeric tracked key isn't left a
      // raw string; a non-finite parse keeps the default rather than seeding NaN.
      const current = state.get(key);
      if (current === undefined) {
        // No seeded default means no target type; seeding the raw string would
        // make "?flag=false" a truthy value.
        console.error(`URLSync: tracked key "${key}" has no seeded default; ignoring its URL value`);
        continue;
      }
      if (typeof current === 'number') {
        const num = parseUrlNumber(raw);
        if (num === null) continue;
        patch[key] = num;
      } else if (typeof current === 'boolean') {
        const flag = parseUrlBoolean(raw);
        if (flag === null) continue;
        patch[key] = flag;
      } else {
        patch[key] = raw;
      }
    }
    if (Object.keys(patch).length > 0) {
      state.update(patch);
    }

    // Correct a URL that advertises something the app did not adopt: a rejected
    // or unseeded value, or an accepted one that serializes differently ("on" ->
    // "true", " 8 " -> "8"). Flushing writes the canonical form, so the next load
    // finds no mismatch and schedules nothing.
    for (const key of this.trackedKeys) {
      if (!params.has(key)) continue;
      if (params.get(key) !== canonicalUrlParam(state.get(key))) {
        this.schedule();
        break;
      }
    }

    this.unsubscribe = state.subscribe((key) => {
      if (!this.trackedKeys.has(key)) return;
      this.schedule();
    });

    activeURLSync = this;
  }

  /**
   * Tear down the URLSync: drop the AppState subscription, cancel any pending
   * debounced flush, and clear the app-wide writer slot if it still points here.
   * Without this, a pagehide discard can leave the debounce timer firing
   * history.replaceState into a dead page. Symmetric with disposeApp().
   * Latches: schedule() and setParam() become no-ops afterwards, so a holder of
   * a direct reference cannot re-arm the debounce into a discarded page.
   * @returns {void}
   */
  dispose() {
    this.disposed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    clearTimeout(this.timer);
    this.timer = null;
    if (activeURLSync === this) activeURLSync = null;
  }

  /**
   * Debounces a URL write, collapsing bursts into one flush after
   * URL_FLUSH_DEBOUNCE_MS. A no-op once disposed.
   * @details A shorter delay never displaces an armed longer one: the retry
   *   ladder arms at URL_FLUSH_RETRY_MS to pace the browser's write budget, and
   *   letting a concurrent debounce pull it forward would spend the ladder
   *   inside the rate-limit window it is waiting out. Nothing is lost by
   *   waiting — the armed flush re-reads tracked state and merges the buffer at
   *   fire time.
   * @param {number} [delayMs] - Delay before the flush fires.
   * @returns {void}
   */
  schedule(delayMs = URL_FLUSH_DEBOUNCE_MS) {
    if (this.disposed) return;
    if (this.timer !== null && delayMs < this.armedDelayMs) return;
    clearTimeout(this.timer);
    this.armedDelayMs = delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
  }

  /**
   * Records an ad-hoc param write from the GUI layer, merged into the single flush.
   * A no-op once disposed.
   * @details A tracked key is owned by the AppState, so it is only scheduled, never
   *   buffered: the buffer outlives the write that filled it, and re-asserting a
   *   value the state has since moved past would leave the URL advertising the old
   *   one with nothing left to correct it.
   * @param {string} key - The URL param name to write.
   * @param {*} value - The value to set; null/undefined records a deletion marker.
   *   Numbers are rounded to significant digits to save space and avoid float jitter.
   * @returns {void}
   */
  setParam(key, value) {
    if (this.disposed) return;
    if (this.trackedKeys.has(key)) {
      this.schedule();
      return;
    }
    // A null entry is a deletion marker (drop the param on flush), not a forget.
    this.adhoc.set(key, canonicalUrlParam(value));
    this.schedule();
  }

  /**
   * Clears every URL param except the excluded keys, on the same debounced flush
   * every other write takes. Tracked-key state and surviving ad-hoc writes are
   * re-asserted by that flush, so a value set inside the window is not lost.
   * @details Debounced rather than immediate because an effect switch calls this
   *   on every change: writing here would let a burst of switches spend the
   *   browser's replaceState budget on its own.
   * @param {string[]} excludedKeys - Param names to preserve through the reset.
   * @returns {void}
   */
  reset(excludedKeys = []) {
    const excl = new Set(excludedKeys);
    for (const k of [...this.adhoc.keys()]) {
      if (!excl.has(k)) this.adhoc.delete(k);
    }
    this.pendingReset = excl;
    this.schedule();
  }

  /**
   * Drop from a params object the keys a scheduled reset() will clear, so a
   * reader running inside the debounce window does not see params the app has
   * already discarded — the reset is scheduled, but the decision is made.
   * @param {URLSearchParams} params - Params to filter in place.
   * @returns {void}
   */
  applyPendingReset(params) {
    if (!this.pendingReset) return;
    for (const k of [...params.keys()]) {
      if (!this.pendingReset.has(k)) params.delete(k);
    }
  }

  /**
   * Overlay onto a params object the ad-hoc writes still buffered for the next
   * flush, so a reader running inside the debounce window sees the values the
   * app has already accepted rather than the query string they will replace.
   * @param {URLSearchParams} params - Params to update in place.
   * @returns {void}
   */
  overlayPending(params) {
    for (const [key, val] of this.adhoc) {
      if (val === null) params.delete(key);
      else params.set(key, val);
    }
  }

  /**
   * Read-modify-write the URL once: re-read current params, overlay tracked
   * state keys and surviving ad-hoc writes, then replaceState. Running at fire
   * time (not schedule time) is what lets concurrent updates merge.
   * @details A refused write (replaceState rate limit) leaves the URL as it was,
   *   so the buffered ad-hoc writes and any pending reset are kept and a retry is
   *   armed. Tracked keys are re-read from state on every flush and need no such
   *   hold. Dropping the buffer immediately would lose a GUI param permanently,
   *   since nothing but the next write on that same key would re-assert it — but
   *   the ladder is bounded at URL_FLUSH_MAX_RETRIES, past which the refusal is a
   *   standing one and the buffer is dropped rather than held by a timer that
   *   re-arms for the page's lifetime.
   * @returns {void}
   */
  flush() {
    const params = new URLSearchParams(window.location.search);
    this.applyPendingReset(params);
    // A cleared tracked key drops its param; leaving it would re-seed the stale
    // value into state on the next load.
    for (const key of this.trackedKeys) {
      overlayUrlParam(params, key, this.state.get(key));
    }
    this.overlayPending(params);
    if (!writeUrl(params)) {
      this.retries += 1;
      if (this.retries < URL_FLUSH_MAX_RETRIES) {
        this.schedule(URL_FLUSH_RETRY_MS);
        return;
      }
      if (this.retries === URL_FLUSH_MAX_RETRIES) {
        console.warn(`URLSync: ${URL_FLUSH_MAX_RETRIES} consecutive refused URL `
          + 'writes; dropping the buffered params and leaving the URL as it is.');
      }
      this.pendingReset = null;
      this.adhoc.clear();
      return;
    }
    // The URL is now the store of record; clear the buffer so a stale ad-hoc entry
    // can't re-apply on every flush.
    this.retries = 0;
    this.pendingReset = null;
    this.adhoc.clear();
  }
}
