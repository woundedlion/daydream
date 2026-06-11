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
  constructor(defaults = {}) {
    this._state = { ...defaults };
    this._listeners = [];
  }

  get(key) { return this._state[key]; }

  set(key, value) {
    if (this._state[key] === value) return;
    const old = this._state[key];
    this._state[key] = value;
    this._notify(key, value, old);
  }

  /** Batch-set multiple keys, fires one notification per key at the end. */
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

  /** Subscribe to state changes. Callback receives (key, newValue, oldValue). */
  subscribe(callback) {
    this._listeners.push(callback);
    return () => {
      this._listeners = this._listeners.filter(l => l !== callback);
    };
  }

  _notify(key, value, old) {
    this._listeners.forEach(cb => cb(key, value, old));
  }

  /** Snapshot of current state. */
  snapshot() { return { ...this._state }; }
}

// The app-wide active URLSync instance. The GUI layer (gui.js) routes its
// param writes through this rather than issuing its own competing
// replaceState, so there is a single URL writer and no clobber race.
let _activeURLSync = null;
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
   * @param {AppState} state - The app state to sync
   * @param {string[]} trackedKeys - Which state keys to sync to URL
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

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(), 200);
  }

  /** Ad-hoc param write from the GUI layer; merged into the single flush. */
  setParam(key, value) {
    if (value === null || value === undefined) {
      // Record a deletion marker rather than forgetting the key: _flush needs
      // it to actually drop a param already present in the URL. Matches the
      // gui.js fallback path's delete-on-null semantics.
      this._adhoc.set(key, null);
    } else {
      // Round numbers to save space and avoid float jitter (matches the GUI's
      // previous behavior).
      this._adhoc.set(key,
        typeof value === 'number' ? String(parseFloat(value.toFixed(4))) : String(value));
    }
    this._schedule();
  }

  /** Clear every URL param except the excluded keys (immediate). */
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
    // Re-assert current state for tracked keys. reset() clears this._timer above,
    // which cancels any flush already scheduled for an in-flight change (e.g. an
    // effect switch reaches us via applyEffect()->resetGUI() before its flush
    // fires). Excluding a key by name only preserves its STALE url value, so
    // without this the new effect/resolution would be lost and never persisted.
    for (const key of this.trackedKeys) {
      const val = this.state.get(key);
      if (val !== null && val !== undefined) params.set(key, val);
    }
    // Merge the ad-hoc writes that survived the prune above (the excluded keys).
    // reset() cancelled the debounced flush, so a GUI param changed within the
    // 200 ms window before an effect switch was never written to the URL;
    // re-asserting it here keeps that fresh value instead of the stale one the
    // exclude-by-name path would otherwise preserve.
    for (const [key, val] of this._adhoc) {
      if (val === null) params.delete(key);
      else params.set(key, val);
    }
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    // Everything is written to the URL now; drop the buffer so the (excluded)
    // entries retained above can't override a tracked key on a later flush.
    this._adhoc.clear();
  }

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
