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

/**
 * URL synchronization layer.
 * Subscribes to an AppState and keeps URL params in sync.
 * Also reads initial values from URL on construction.
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
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._flush(), 200);
    });
  }

  _flush() {
    const params = new URLSearchParams(window.location.search);
    for (const key of this.trackedKeys) {
      const val = this.state.get(key);
      if (val !== null && val !== undefined) {
        params.set(key, val);
      }
    }
    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState({}, '', newUrl);
  }
}
