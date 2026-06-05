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
 * Single shared URL writer for the whole app.
 *
 * Both the AppState→URL sync (URLSync, below) and the GUI param→URL sync
 * (gui.js) route their changes through this one writer instead of each keeping
 * its own debounce timer and pre-computed URL string. That fixes a race in the
 * old two-layer design: gui.js captured the URL synchronously at change time
 * and wrote that stale string ~200ms later, so a GUI param edit could clobber a
 * concurrent effect/resolution change. Here, queued changes are *merged into a
 * fresh read* of the URL at flush time, and there is exactly one debounce, so
 * writes from both sources coalesce instead of fighting.
 */
class UrlWriter {
  constructor(debounceMs = 200) {
    this._pending = new Map(); // key -> value; null => delete the param
    this._timer = null;
    this._debounceMs = debounceMs;
  }

  /** Queue a param write (value coerced to string by URLSearchParams). */
  set(key, value) {
    this._pending.set(key, value === undefined ? null : value);
    this._schedule();
  }

  /** Queue a param deletion. */
  delete(key) {
    this._pending.set(key, null);
    this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), this._debounceMs);
  }

  /** Apply all queued changes to a FRESH read of the URL and write once. */
  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    if (this._pending.size === 0) return;
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of this._pending) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    this._pending.clear();
    window.history.replaceState(
      {}, '', `${window.location.pathname}?${params.toString()}`);
  }
}

/** App-wide URL writer instance shared by URLSync and the GUI. */
export const urlWriter = new UrlWriter();

/**
 * URL synchronization layer.
 * Subscribes to an AppState and keeps URL params in sync via the shared
 * urlWriter. Also reads initial values from URL on construction.
 */
export class URLSync {
  /**
   * @param {AppState} state - The app state to sync
   * @param {string[]} trackedKeys - Which state keys to sync to URL
   */
  constructor(state, trackedKeys) {
    this.state = state;
    this.trackedKeys = new Set(trackedKeys);

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

    // Route changes through the shared writer (fresh-read merge at flush).
    state.subscribe((key, value) => {
      if (!this.trackedKeys.has(key)) return;
      urlWriter.set(key, value);
    });
  }
}
