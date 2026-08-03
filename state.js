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
 * dropping trailing-zero noise. Shared by URLSync.setParam and gui.js's ad-hoc
 * writer so the two URL serializers cannot drift. Number() re-parses the rounded
 * string so 0.50000 collapses back to 0.5.
 * @param {number} value - The numeric value to serialize.
 * @returns {number|null} The rounded value, or null for a non-finite input so
 *   callers drop the key rather than emit a misleading 0. Rounding preserves
 *   magnitude, so only an exact 0 serializes as 0.
 */
export function roundUrlNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toPrecision(URL_SIGNIFICANT_DIGITS));
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

/**
 * The single assembly point for every deep-link URL write: replaceState with
 * pathname + query + the existing location.hash, which rebuilding from pathname
 * alone would drop.
 * @param {URLSearchParams} params - The query params to write; empty writes a bare path.
 * @returns {void}
 */
export function writeUrl(params) {
  const qs = params.toString();
  const base = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState({}, '', base + window.location.hash);
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
    this.state = { ...defaults };
    this.listeners = [];
    this.batchDepth = 0;
    this.dispatchedKeys = new Set();
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
    // a key still queued below. Skip a queued tuple whose key already went out:
    // its `old` no longer describes a transition that happened.
    this.batchDepth++;
    try {
      for (const [key, value, old] of changes) {
        if (this.dispatchedKeys.has(key)) continue;
        this.notify(key, value, old);
      }
    } finally {
      if (--this.batchDepth === 0) this.dispatchedKeys.clear();
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
    if (this.batchDepth > 0) this.dispatchedKeys.add(key);
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
    this.disposed = false;
    this.adhoc = new Map(); // GUI-set params (key -> string), merged on flush

    const params = new URLSearchParams(window.location.search);
    const patch = {};
    for (const key of trackedKeys) {
      if (!params.has(key)) continue;
      const raw = params.get(key);
      const validate = validators[key];
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
      if (params.get(key) !== this.canonicalParam(state.get(key))) {
        this.schedule();
        break;
      }
    }

    this.unsubscribe = state.subscribe((key, value) => {
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
   * @returns {void}
   */
  schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), URL_FLUSH_DEBOUNCE_MS);
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
    if (value === null || value === undefined) {
      // null is a deletion marker (drop the param on flush), not a forget.
      this.adhoc.set(key, null);
    } else if (typeof value === 'number') {
      const rounded = roundUrlNumber(value);
      // A null rounding (non-finite) drops the key rather than serializing a 0
      // the engine never rendered.
      this.adhoc.set(key, rounded === null ? null : String(rounded));
    } else {
      this.adhoc.set(key, String(value));
    }
    this.schedule();
  }

  /**
   * Clears every URL param except the excluded keys, writing immediately.
   * Re-asserts current tracked-key state and surviving ad-hoc writes so an
   * in-flight (cancelled) flush does not lose a fresh value.
   * @param {string[]} excludedKeys - Param names to preserve through the reset.
   * @returns {void}
   */
  reset(excludedKeys = []) {
    clearTimeout(this.timer);
    this.timer = null;
    const excl = new Set(excludedKeys);
    for (const k of [...this.adhoc.keys()]) {
      if (!excl.has(k)) this.adhoc.delete(k);
    }
    const params = new URLSearchParams(window.location.search);
    for (const k of [...params.keys()]) {
      if (!excl.has(k)) params.delete(k);
    }
    // Re-assert tracked state and surviving ad-hoc writes: clearing this.timer
    // cancelled any flush for a change made within the debounce window.
    for (const key of this.trackedKeys) {
      const val = this.state.get(key);
      if (val !== null && val !== undefined) this.setTrackedParam(params, key, val);
    }
    for (const [key, val] of this.adhoc) {
      if (val === null) params.delete(key);
      else params.set(key, val);
    }
    writeUrl(params);
    this.adhoc.clear();
  }

  /**
   * Serialize a tracked value the way the URL stores it, rounding numbers via
   * roundUrlNumber so they match setParam. Strings pass through unchanged.
   * @param {*} val - The value to serialize.
   * @returns {string|null} The param string, or null when the value has no URL
   *   representation and the key is dropped instead.
   */
  canonicalParam(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') {
      const rounded = roundUrlNumber(val);
      return rounded === null ? null : String(rounded);
    }
    return String(val);
  }

  /**
   * Write a tracked key into a URLSearchParams using its canonical serialization,
   * deleting the key when the value has none.
   * @param {URLSearchParams} params - The params object to mutate.
   * @param {string} key - The tracked key.
   * @param {*} val - The value to serialize.
   * @returns {void}
   */
  setTrackedParam(params, key, val) {
    const str = this.canonicalParam(val);
    if (str === null) params.delete(key);
    else params.set(key, str);
  }

  /**
   * Read-modify-write the URL once: re-read current params, overlay tracked
   * state keys and surviving ad-hoc writes, then replaceState. Running at fire
   * time (not schedule time) is what lets concurrent updates merge.
   * @returns {void}
   */
  flush() {
    const params = new URLSearchParams(window.location.search);
    for (const key of this.trackedKeys) {
      const val = this.state.get(key);
      // A cleared tracked key drops its param; leaving it would re-seed the
      // stale value into state on the next load.
      if (val === null || val === undefined) params.delete(key);
      else this.setTrackedParam(params, key, val);
    }
    for (const [key, val] of this.adhoc) {
      if (val === null) params.delete(key);
      else params.set(key, val);
    }
    writeUrl(params);
    // The URL is now the store of record; clear the buffer so a stale ad-hoc entry
    // can't re-apply on every flush.
    this.adhoc.clear();
  }
}
