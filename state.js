/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Round a numeric URL-param value to 4 decimals, dropping trailing-zero noise.
 * Shared by URLSync.setParam and gui.js's ad-hoc writer so the two URL
 * serializers cannot drift. parseFloat re-parses the fixed-decimal string so
 * 0.5000 collapses back to 0.5.
 * @param {number} value - The numeric value to serialize.
 * @returns {number} The value rounded to 4 decimal places.
 */
export function roundUrlNumber(value) {
  return Number.isFinite(value) ? parseFloat(value.toFixed(4)) : 0;
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
  }

  /**
   * Reads a single state value by key.
   * @param {string} key - The state key to look up.
   * @returns {*} The current value for the key, or undefined if unset.
   */
  get(key) { return this.state[key]; }

  /**
   * Sets one key, notifying subscribers only when the value actually changes.
   * No-op (and no notification) if the value is unchanged.
   *
   * PRIMITIVES ONLY: change detection is strict `===`, which compares objects
   * and arrays by reference, not by contents. Mutating an array/object in place
   * and re-setting it (or setting a new object that is structurally equal) is
   * therefore either dropped as "unchanged" or fires on every set regardless of
   * content. All current keys hold primitives (strings/numbers/booleans); keep
   * it that way, or this detection will silently misbehave for reference values.
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
   * Batch-sets multiple keys, firing one notification per changed key at the end.
   *
   * BATCH-THEN-NOTIFY: every key in the patch is written into the state FIRST,
   * and only then are subscribers notified (one notification per changed key).
   * This is deliberately unlike set(), which writes and notifies one key at a
   * time — so a subscriber whose callback reads a *sibling* batched key here
   * sees that sibling's fully-advanced (post-batch) value, not its pre-batch one.
   * Keep callbacks that depend on cross-key ordering aware of this: the batch is
   * an atomic snapshot, not a sequence of independent set()s.
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
    // A subscriber may re-enter set()/update() while this batch drains, changing
    // a key still queued below. Skip a queued tuple whose value is no longer
    // current — the re-entrant write already notified with the live value, so
    // firing the stale tuple would interleave a superseded notification.
    changes.forEach(([key, value, old]) => {
      if (this.state[key] !== value) return;
      this.notify(key, value, old);
    });
  }

  /**
   * Subscribes to state changes.
   * @param {Function} callback - Invoked as (key, newValue, oldValue) on each change.
   * @returns {Function} An unsubscribe function that removes the callback.
   */
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
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
    // Snapshot so a subscriber added during dispatch is not invoked for the
    // current event (and an unsubscribe mid-dispatch stays safe).
    this.listeners.slice().forEach(cb => cb(key, value, old));
  }

  /**
   * Returns a shallow snapshot of the current state.
   * @returns {Object} A copy of the current key/value pairs.
   */
  snapshot() { return { ...this.state }; }
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
   * to tracked-key changes, and registers itself as the app-wide URL writer.
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
    this.state = state;
    this.trackedKeys = new Set(trackedKeys);
    this.timer = null;
    this.adhoc = new Map(); // GUI-set params (key -> string), merged on flush

    const params = new URLSearchParams(window.location.search);
    const patch = {};
    for (const key of trackedKeys) {
      if (!params.has(key)) continue;
      const raw = params.get(key);
      const validate = validators[key];
      if (validate && !validate(raw)) continue;
      patch[key] = raw;
    }
    if (Object.keys(patch).length > 0) {
      state.update(patch);
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
   * Without this, a pagehide discard can leave the 200 ms timer firing
   * history.replaceState into a dead page. Symmetric with disposeApp().
   * @returns {void}
   */
  dispose() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    clearTimeout(this.timer);
    this.timer = null;
    if (activeURLSync === this) activeURLSync = null;
  }

  /**
   * Debounces a URL write, collapsing bursts into one flush after 200 ms.
   * @returns {void}
   */
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  /**
   * Records an ad-hoc param write from the GUI layer, merged into the single flush.
   * @param {string} key - The URL param name to write.
   * @param {*} value - The value to set; null/undefined records a deletion marker.
   *   Numbers are rounded to 4 decimals to save space and avoid float jitter.
   * @returns {void}
   */
  setParam(key, value) {
    if (value === null || value === undefined) {
      // null is a deletion marker (drop the param on flush), not a forget.
      this.adhoc.set(key, null);
    } else {
      this.adhoc.set(key,
        typeof value === 'number' ? String(roundUrlNumber(value)) : String(value));
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
    const qs = params.toString();
    window.history.replaceState({}, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    this.adhoc.clear();
  }

  /**
   * Write a tracked key into a URLSearchParams, rounding numeric values via
   * roundUrlNumber so the tracked-key path serializes numbers the same way the
   * ad-hoc writer (setParam) does. Tracked keys are strings today, but without
   * this a future numeric tracked key would land in the URL with full float
   * noise (URLSearchParams.set just String()s it). Strings pass through
   * unchanged (String(s) === s).
   * @param {URLSearchParams} params - The params object to mutate.
   * @param {string} key - The tracked key.
   * @param {*} val - The value to serialize.
   * @returns {void}
   */
  setTrackedParam(params, key, val) {
    params.set(key, typeof val === 'number' ? String(roundUrlNumber(val)) : String(val));
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
      if (val !== null && val !== undefined) {
        this.setTrackedParam(params, key, val);
      }
    }
    for (const [key, val] of this.adhoc) {
      if (val === null) params.delete(key);
      else params.set(key, val);
    }
    const qs = params.toString();
    const newUrl = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
    // The URL is now the store of record; clear the buffer so a stale ad-hoc entry
    // can't re-apply on every flush.
    this.adhoc.clear();
  }
}
