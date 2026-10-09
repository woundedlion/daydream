// @ts-check
/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** @typedef {(key: string, value: *, old: *) => void} StateListener */

// Significant digits kept by roundUrlNumber.
const URL_SIGNIFICANT_DIGITS = 7;

/**
 * Round a numeric URL-param value to URL_SIGNIFICANT_DIGITS significant digits,
 * dropping trailing-zero noise. Number() re-parses the rounded string so 0.50000
 * collapses back to 0.5.
 * @param {number} value - The numeric value to serialize.
 * @returns {number|null} The rounded value, or null for a non-finite input.
 */
export function roundUrlNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toPrecision(URL_SIGNIFICANT_DIGITS));
}

/**
 * Serialize a value the way the URL stores it: numbers through roundUrlNumber,
 * everything else stringified.
 * @param {*} value - The value to serialize.
 * @returns {string|null} The param string, or null when the value has no URL
 *   representation (null/undefined, or a non-finite number).
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
 * Parse a URL param string as a number: surrounding whitespace is allowed, the
 * rest must be a plain decimal (optionally signed, optionally exponent) and finite.
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
 * Parse a URL param string as a boolean; case- and whitespace-insensitive.
 * @param {string} raw - The raw URL param string.
 * @returns {boolean|null} The parsed boolean, or null for an unrecognized token.
 */
export function parseUrlBoolean(raw) {
  const t = raw.trim().toLowerCase();
  if (URL_TRUE.has(t)) return true;
  if (URL_FALSE.has(t)) return false;
  return null;
}

// Debounce window collapsing a burst of URL writes into one replaceState.
export const URL_FLUSH_DEBOUNCE_MS = 200;

// Re-arm delay after a refused replaceState.
export const URL_FLUSH_RETRY_MS = 2000;

// Consecutive refused writes before the buffer is dropped. The retry window
// outlasts WebKit's 30 s rate limit.
export const URL_FLUSH_MAX_RETRIES = 20;

/**
 * Replace the current history entry with a URL, reporting a refused write
 * instead of propagating it.
 * @details Browsers rate-limit replaceState (WebKit: ~100 per 30 s) and throw
 *   past the limit.
 * @param {string} url - The URL to write.
 * @param {Window} [win] - The window whose history is written.
 * @returns {boolean} Whether the URL was written; false when the browser refused it.
 */
export function replaceUrl(url, win = window) {
  try {
    win.history.replaceState({}, '', url);
    return true;
  } catch (e) {
    console.warn('URL update skipped:', e);
    return false;
  }
}

/**
 * replaceState with pathname + query + the existing location.hash.
 * @param {URLSearchParams} params - The query params to write; empty writes a bare path.
 * @param {Window} [win] - The window whose location is read and history written.
 * @returns {boolean} Whether the URL was written; false when the browser refused it.
 */
export function writeUrl(params, win = window) {
  const qs = params.toString();
  const base = qs ? `${win.location.pathname}?${qs}` : win.location.pathname;
  return replaceUrl(base + win.location.hash, win);
}

/**
 * Centralized application state with change subscribers.
 */
export class AppState {
  /**
   * Creates an AppState seeded with optional initial values.
   * @param {Object} defaults - Initial key/value pairs seeding the state.
   */
  constructor(defaults = {}) {
    // Null prototype: keys are arbitrary strings, and an inherited one
    // ("constructor", "toString") would read back as state the app never set.
    /** @type {Record<string, *>} */
    this.state = { __proto__: null, ...defaults };
    /** @type {{fn: StateListener}[]} */
    this.listeners = [];
    this.batchDepth = 0;
    // key -> notifications dispatched since the outermost batch began.
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
   * sees its post-batch value.
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
    // A subscriber may re-enter set()/update() and notify a key still queued.
    // Skip a queued tuple whose key went out after this batch captured it: its
    // `old` no longer describes a transition that happened.
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
   * @param {StateListener} callback - Invoked as (key, newValue, oldValue) on each change.
   * @returns {() => void} An unsubscribe function that removes this registration
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
      if (!this.listeners.includes(reg)) continue;
      // Report a throwing subscriber and carry on.
      try {
        reg.fn(key, value, old);
      } catch (err) {
        console.error(`AppState: subscriber threw for key "${key}"`, err);
      }
    }
  }

}

// App-wide URL writer slot.
/** @type {URLSync|null} */
let activeURLSync = null;
/**
 * Returns the app-wide active URLSync instance, or null if none is constructed.
 * @returns {URLSync|null} The registered URL writer.
 */
export const getActiveURLSync = () => activeURLSync;

/**
 * URL synchronization layer. Subscribes to an AppState for tracked keys, accepts
 * ad-hoc param writes, and reads initial values from the URL on construction.
 * Writes funnel through one debounced read-modify-write flush, so concurrent
 * updates merge.
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
   *   default instead of being overwritten.
   * @param {Window} [win] - The window this writer reads and writes the URL on,
   *   and arms its debounce against.
   */
  constructor(state, trackedKeys, validators = {}, win = window) {
    // Retire the previous writer so no orphaned subscription or timer survives.
    if (activeURLSync) activeURLSync.dispose();
    this.state = state;
    this.trackedKeys = new Set(trackedKeys);
    /** @type {ReturnType<typeof setTimeout>|null} */
    this.timer = null;
    this.armedDelayMs = 0; // delay this.timer was armed with; read only while armed
    this.disposed = false;
    /** @type {Map<string, string|null>} GUI-set params, merged on flush. */
    this.adhoc = new Map();
    /** @type {Set<string>|null} reset()'s excluded keys, applied by the next flush. */
    this.pendingReset = null;
    this.suspendDepth = 0;
    this.suspendedDirty = false;
    this.suspendedDelayMs = 0; // delay of a flush suspend() disarmed, re-armed by resume()
    this.retries = 0; // consecutive refused writes, cleared by one that lands
    this.win = win;

    const params = new URLSearchParams(win.location.search);
    /** @type {Record<string, *>} */
    const patch = {};
    for (const key of trackedKeys) {
      // null only for an absent key; a present one with no value reads as ''.
      const raw = params.get(key);
      if (raw === null) continue;
      // Own keys only: Object.prototype carries a callable under every inherited
      // name, and one of those would pass every raw value it was handed.
      const validate = Object.hasOwn(validators, key) ? validators[key] : null;
      if (validate && !validate(raw)) continue;
      // Coerce to the seeded default's type so a numeric tracked key isn't left a
      // raw string; a non-finite parse keeps the default rather than seeding NaN.
      const current = state.get(key);
      if (current === undefined) {
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
    // "true", " 8 " -> "8").
    for (const key of this.trackedKeys) {
      if (!params.has(key)) continue;
      if (params.get(key) !== canonicalUrlParam(state.get(key))) {
        this.schedule();
        break;
      }
    }

    /** @type {(() => void)|null} */
    this.unsubscribe = state.subscribe((key) => {
      if (!this.trackedKeys.has(key)) return;
      this.schedule();
    });

    activeURLSync = this;
  }

  /**
   * Tear down the URLSync: drop the AppState subscription, cancel any pending
   * debounced flush, and clear the app-wide writer slot if it still points here.
   * Latches: schedule(), setParam(), and reset() become no-ops afterwards.
   * @returns {void}
   */
  dispose() {
    this.disposed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    if (this.timer !== null) this.win.clearTimeout(this.timer);
    this.timer = null;
    if (activeURLSync === this) activeURLSync = null;
  }

  /**
   * Defers tracked URL writes until resume() completes a state transaction.
   * @details Disarms an already-armed flush, carrying its delay so resume()
   *   cannot shorten a retry wait.
   * @returns {void}
   */
  suspend() {
    this.suspendDepth += 1;
    if (this.timer === null) return;
    this.win.clearTimeout(this.timer);
    this.timer = null;
    this.suspendedDirty = true;
    this.suspendedDelayMs = Math.max(this.suspendedDelayMs, this.armedDelayMs);
  }

  /** Releases one suspension and schedules the accumulated URL write. */
  resume() {
    if (this.suspendDepth === 0) return;
    this.suspendDepth -= 1;
    if (this.suspendDepth === 0 && this.suspendedDirty) {
      this.suspendedDirty = false;
      const delayMs = Math.max(this.suspendedDelayMs, URL_FLUSH_DEBOUNCE_MS);
      this.suspendedDelayMs = 0;
      this.schedule(delayMs);
    }
  }

  /**
   * Debounces a URL write, collapsing bursts into one flush after
   * URL_FLUSH_DEBOUNCE_MS. A no-op once disposed.
   * @details A shorter delay never displaces an armed longer one; the armed
   *   flush re-reads tracked state and merges the buffer at fire time.
   * @param {number} [delayMs] - Delay before the flush fires.
   * @returns {void}
   */
  schedule(delayMs = URL_FLUSH_DEBOUNCE_MS) {
    if (this.disposed) return;
    if (this.suspendDepth > 0) {
      this.suspendedDirty = true;
      this.suspendedDelayMs = Math.max(this.suspendedDelayMs, delayMs);
      return;
    }
    if (this.timer !== null) {
      if (delayMs < this.armedDelayMs) return;
      this.win.clearTimeout(this.timer);
    }
    this.armedDelayMs = delayMs;
    this.timer = this.win.setTimeout(() => {
      this.timer = null;
      this.flush();
    }, delayMs);
  }

  /**
   * Records an ad-hoc param write from the GUI layer, merged into the single flush.
   * A no-op once disposed.
   * @details A tracked key is owned by the AppState, so it is only scheduled, never
   *   buffered.
   * @param {string} key - The URL param name to write.
   * @param {*} value - The value to set; null/undefined records a deletion marker.
   *   Numbers are rounded to URL_SIGNIFICANT_DIGITS significant digits.
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
   * Clears every URL param except the excluded keys, on the debounced flush.
   * Tracked-key state and surviving ad-hoc writes are re-asserted by that flush.
   * A no-op once disposed.
   * @param {string[]} excludedKeys - Param names to preserve through the reset.
   * @returns {void}
   */
  reset(excludedKeys = []) {
    if (this.disposed) return;
    const excl = new Set(excludedKeys);
    for (const k of [...this.adhoc.keys()]) {
      if (!excl.has(k)) this.adhoc.delete(k);
    }
    this.pendingReset = excl;
    this.schedule();
  }

  /** Discards buffered writes before restoring a complete URL snapshot. */
  discardPending() {
    this.retries = 0;
    this.adhoc.clear();
    this.pendingReset = null;
    if (this.timer !== null) this.win.clearTimeout(this.timer);
    this.timer = null;
    this.suspendedDirty = false;
    this.suspendedDelayMs = 0;
  }

  /**
   * Drop from a params object the keys a scheduled reset() will clear.
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
   * flush.
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
   * state keys and surviving ad-hoc writes, then replaceState. Runs at fire
   * time so concurrent updates merge.
   * @details A refused write keeps the ad-hoc buffer and pending reset and arms a
   *   retry; after URL_FLUSH_MAX_RETRIES refusals the buffer is dropped.
   * @returns {void}
   */
  flush() {
    const params = new URLSearchParams(this.win.location.search);
    this.applyPendingReset(params);
    // A cleared tracked key drops its param; leaving it would re-seed the stale
    // value into state on the next load.
    for (const key of this.trackedKeys) {
      overlayUrlParam(params, key, this.state.get(key));
    }
    this.overlayPending(params);
    if (!writeUrl(params, this.win)) {
      this.retries += 1;
      if (this.retries < URL_FLUSH_MAX_RETRIES) {
        this.schedule(URL_FLUSH_RETRY_MS);
        return;
      }
      console.warn(`URLSync: ${URL_FLUSH_MAX_RETRIES} consecutive refused URL `
        + 'writes; dropping the buffered params and leaving the URL as it is.');
      this.retries = 0;
      this.pendingReset = null;
      this.adhoc.clear();
      return;
    }
    // The URL is now the store of record.
    this.retries = 0;
    this.pendingReset = null;
    this.adhoc.clear();
  }
}
