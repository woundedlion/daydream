/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

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
    this._state = { ...defaults };
    this._listeners = [];
  }

  /**
   * Reads a single state value by key.
   * @param {string} key - The state key to look up.
   * @returns {*} The current value for the key, or undefined if unset.
   */
  get(key) { return this._state[key]; }

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
    if (this._state[key] === value) return;
    const old = this._state[key];
    this._state[key] = value;
    this._notify(key, value, old);
  }

  /**
   * Batch-sets multiple keys, firing one notification per changed key at the end.
   * @param {Object} patch - Key/value pairs to merge into the state.
   * @returns {void}
   */
  update(patch) {
    const changes = [];
    for (const [key, value] of Object.entries(patch)) {
      if (this._state[key] !== value) {
        const old = this._state[key];
        this._state[key] = value;
        changes.push([key, value, old]);
      }
    }
    changes.forEach(([key, value, old]) => this._notify(key, value, old));
  }

  /**
   * Subscribes to state changes.
   * @param {Function} callback - Invoked as (key, newValue, oldValue) on each change.
   * @returns {Function} An unsubscribe function that removes the callback.
   */
  subscribe(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  /**
   * Invokes every subscriber with the change tuple.
   * @param {string} key - The key that changed.
   * @param {*} value - The new value.
   * @param {*} old - The previous value.
   * @returns {void}
   */
  _notify(key, value, old) {
    this._listeners.forEach(cb => cb(key, value, old));
  }

  /**
   * Returns a shallow snapshot of the current state.
   * @returns {Object} A copy of the current key/value pairs.
   */
  snapshot() { return { ...this._state }; }
}

// The app-wide active URLSync instance. The GUI layer (gui.js) routes its
// param writes through this rather than issuing its own competing
// replaceState, so there is a single URL writer and no clobber race.
let _activeURLSync = null;
/**
 * Returns the app-wide active URLSync instance, or null if none is constructed.
 * @returns {URLSync|null} The single registered URL writer.
 */
export const getActiveURLSync = () => _activeURLSync;

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
   */
  constructor(state, trackedKeys) {
    this.state = state;
    this.trackedKeys = new Set(trackedKeys);
    this._timer = null;
    this._adhoc = new Map(); // GUI-set params (key -> string), merged on flush

    // Read initial values from URL
    const params = new URLSearchParams(window.location.search);
    const patch = {};
    for (const key of trackedKeys) {
      if (params.has(key)) {
        patch[key] = params.get(key);
      }
    }
    if (Object.keys(patch).length > 0) {
      state.update(patch);
    }

    // Subscribe to changes and debounce URL writes
    state.subscribe((key, value) => {
      if (!this.trackedKeys.has(key)) return;
      this._schedule();
    });

    // Become the app-wide URL writer the GUI delegates to.
    _activeURLSync = this;
  }

  /**
   * Debounces a URL write, collapsing bursts into one flush after 200 ms.
   * @returns {void}
   */
  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 200);
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
      // Record a deletion marker rather than forgetting the key: _flush needs
      // it to actually drop a param already present in the URL. Matches the
      // gui.js fallback path's delete-on-null semantics.
      this._adhoc.set(key, null);
    } else {
      // Round numbers to save space and avoid float jitter.
      this._adhoc.set(key,
        typeof value === 'number' ? String(parseFloat(value.toFixed(4))) : String(value));
    }
    this._schedule();
  }

  /**
   * Clears every URL param except the excluded keys, writing immediately.
   * Re-asserts current tracked-key state and surviving ad-hoc writes so an
   * in-flight (cancelled) flush does not lose a fresh value.
   * @param {string[]} excludedKeys - Param names to preserve through the reset.
   * @returns {void}
   */
  reset(excludedKeys = []) {
    clearTimeout(this._timer);
    const excl = new Set(excludedKeys);
    for (const k of [...this._adhoc.keys()]) {
      if (!excl.has(k)) this._adhoc.delete(k);
    }
    const params = new URLSearchParams(window.location.search);
    for (const k of [...params.keys()]) {
      if (!excl.has(k)) params.delete(k);
    }
    // Re-assert current state for tracked keys. Clearing this._timer above cancels
    // any flush already scheduled for an in-flight change, and excluding a key by
    // name preserves only its stale URL value; without this the new value is lost.
    for (const key of this.trackedKeys) {
      const val = this.state.get(key);
      if (val !== null && val !== undefined) params.set(key, val);
    }
    // Merge the ad-hoc writes that survived the prune above (the excluded keys).
    // The cancelled flush may hold a GUI param changed within the 200 ms window;
    // re-asserting it keeps that fresh value instead of the stale URL one.
    for (const [key, val] of this._adhoc) {
      if (val === null) params.delete(key);
      else params.set(key, val);
    }
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    // Everything is written to the URL now; drop the buffer so the (excluded)
    // entries retained above can't override a tracked key on a later flush.
    this._adhoc.clear();
  }

  /**
   * Read-modify-write the URL once: re-read current params, overlay tracked
   * state keys and surviving ad-hoc writes, then replaceState. Running at fire
   * time (not schedule time) is what lets concurrent updates merge.
   * @returns {void}
   */
  _flush() {
    const params = new URLSearchParams(window.location.search);
    for (const key of this.trackedKeys) {
      const val = this.state.get(key);
      if (val !== null && val !== undefined) {
        params.set(key, val);
      }
    }
    for (const [key, val] of this._adhoc) {
      if (val === null) params.delete(key);
      else params.set(key, val);
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
    // The URL is now the store of record for these values (the next flush re-reads
    // them from window.location.search). Clear the pending-write buffer so a stale
    // ad-hoc entry can't re-apply on every future flush and permanently override a
    // tracked key re-read from appState — e.g. a later appState.set('resolution').
    this._adhoc.clear();
  }
}
