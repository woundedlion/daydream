/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { GUI as LilGUI } from "lil-gui";
import {
  getActiveURLSync,
  overlayUrlParam,
  parseUrlBoolean,
  parseUrlNumber,
  URL_FLUSH_DEBOUNCE_MS,
  writeUrl,
} from "./state.js";

/**
 * Reads the current URL query string into a parsed params object, then applies
 * what the URL writer has decided but not yet flushed: the keys a scheduled
 * reset will drop, and the buffered writes that will replace their query-string
 * values. An effect switch resets and rebuilds the panel inside that one
 * debounce window, so a raw read would hydrate the incoming effect's controls
 * from the outgoing effect's params.
 * @param {Window} [win] - The window whose location is read.
 * @returns {URLSearchParams} The query parameters of the current location.
 */
const getUrlParams = (win = window) => {
  const params = new URLSearchParams(win.location.search);
  const sync = getActiveURLSync();
  sync?.applyPendingReset(params);
  sync?.overlayPending(params);
  return params;
};

/**
 * Extracts the set of values lil-gui will accept for an enumerated control
 * (`add(obj, prop, $1)`): an array of choices, or an object whose values are the
 * choices. Anything else ($1 a number meaning a slider's min, or absent) is not
 * enumerated, so there is no list to validate against.
 * @param {(Array|Object|number|undefined)} options - The third argument passed to lil-gui's add().
 * @returns {(Array|null)} The list of allowed choices, or null when not enumerated.
 */
const optionValues = (options) => {
  if (Array.isArray(options)) return options;
  if (options && typeof options === 'object') return Object.values(options);
  return null;
};

/**
 * Builds an independent debounced URL-param writer with its own pending-writes
 * buffer and timer, one per DeepLinkGUI subtree. When the app's single URLSync
 * writer is present, writes funnel through it (so GUI and effect/resolution
 * changes can't clobber each other); the per-instance fallback is reached only
 * on standalone tool pages with no URLSync. Writes accumulate per key and merge
 * in one flush.
 * @param {Window} [win] - The window this writer reads and rewrites; the
 *   ambient one when omitted.
 * @returns {(key: string, value: (string|number|boolean|null|undefined)) => void}
 *   A writer; `value` null/undefined deletes the key.
 */
const makeUrlParamWriter = (win = null) => {
  let urlTimer = null;
  const pendingUrlWrites = new Map(); // key -> value (null/undefined => delete)
  const commit = () => {
    const target = win ?? window;
    const params = getUrlParams(target);
    for (const [k, v] of pendingUrlWrites) overlayUrlParam(params, k, v);
    pendingUrlWrites.clear();
    writeUrl(params, target);
  };
  const writer = (key, value) => {
    const sync = getActiveURLSync();
    if (sync) {
      // Flush any writes buffered before the sync registered mid-debounce so
      // they funnel through the same authority instead of being stranded.
      if (pendingUrlWrites.size) {
        clearTimeout(urlTimer);
        urlTimer = null;
        for (const [k, v] of pendingUrlWrites) sync.setParam(k, v);
        pendingUrlWrites.clear();
      }
      sync.setParam(key, value);
      return;
    }
    pendingUrlWrites.set(key, value);
    clearTimeout(urlTimer);
    urlTimer = setTimeout(commit, URL_FLUSH_DEBOUNCE_MS);
  };
  // Symmetric with URLSync.dispose(): a discarded GUI must not leave the
  // debounced timer firing history.replaceState into a dead page.
  writer.cancel = () => { clearTimeout(urlTimer); urlTimer = null; pendingUrlWrites.clear(); };
  return writer;
};

export { makeUrlParamWriter };

/**
 * lil-gui wrapper that persists every control's value to URL query params,
 * giving the app shareable deep links. Wraps add/addFolder to hydrate
 * from the URL on creation and write back on change.
 */
class DeepLinkGUI {
  /**
   * @param {(Object|LilGUI)} options - Either lil-gui constructor options or an
   *   existing lil-gui instance to wrap (detected by its domElement/addFolder members).
   * @param {string} [rootNamespace] - Prefix segment for every deep-link key in
   *   this root's subtree (e.g. 'fx', 'view'), keeping independent GUI roots out
   *   of one flat key namespace. Omitted for an unnamespaced (tool-page) root.
   * @param {DeepLinkGUI} [parent] - Enclosing GUI when this is a sub-folder; a
   *   child shares its root's URL writer instead of owning one.
   * @param {Window} [win] - The window this subtree reads deep links from and
   *   writes them back to; inherited from `parent`, else the ambient one.
   */
  constructor(options, rootNamespace = null, parent = null, win = null) {
    if (options && options.domElement && options.addFolder) {
      this.gui = options;
    } else {
      this.gui = new LilGUI(options);
    }
    this.rootNamespace = rootNamespace;
    this.parent = parent;
    this.folderName = null;
    this.folderIndex = 0;
    this.keySegment = null;
    this.urlKeys = new Set();
    this.children = [];
    this.win = win ?? parent?.win ?? null;
    this.urlWriter = parent ? parent.urlWriter : makeUrlParamWriter(this.win);
  }

  /**
   * Reads this subtree's deep-link params, folding in the URL writer's pending
   * state.
   * @returns {URLSearchParams} The query parameters of this GUI's window.
   */
  urlParams() { return getUrlParams(this.win ?? window); }

  /**
   * Collects all deep-link URL param keys managed by this GUI and its sub-folders.
   * @returns {Array<string>} The flattened list of managed param keys.
   */
  collectUrlKeys() {
    const keys = [...this.urlKeys];
    for (const child of this.children) keys.push(...child.collectUrlKeys());
    return keys;
  }

  /**
   * The root DOM element of the wrapped lil-gui instance.
   * @returns {HTMLElement} The GUI's container element.
   */
  get domElement() { return this.gui.domElement; }
  /**
   * Appends custom content alongside this GUI's controllers.
   * @param {HTMLElement} element - Content to append.
   * @returns {void}
   */
  appendElement(element) { this.gui.$children.appendChild(element); }
  /**
   * Builds a control's URL param key by joining the root's namespace (when it has
   * one) and its enclosing folder names with the property, e.g.
   * "fx.Effects.Speed", so nested controls and separate GUI roots get distinct keys.
   * @param {string} prop - The control's property name.
   * @returns {string} The dot-joined param key.
   */
  getKey(prop) {
    const keys = [prop];
    let curr = this;
    while (curr.parent) {
      if (curr.keySegment) keys.unshift(curr.keySegment);
      curr = curr.parent;
    }
    if (curr.rootNamespace) keys.unshift(curr.rootNamespace);
    return keys.join('.');
  }

  /**
   * Read a numeric companion value without creating a visible control.
   * @param {string} prop - Companion property name within this GUI namespace.
   * @param {Array<string>} [legacyProps=[]] - Former companion property names.
   * @returns {number|undefined} Parsed value, or undefined when absent/invalid.
   */
  readStoredNumber(prop, legacyProps = []) {
    const key = this.getKey(prop);
    this.urlKeys.add(key);
    const params = this.urlParams();
    const legacyKey = legacyProps
      .map((legacyProp) => this.getKey(legacyProp))
      .find((candidate) => params.has(candidate));
    const sourceKey = params.has(key) ? key : legacyKey;
    if (!sourceKey) return undefined;
    const value = parseUrlNumber(params.get(sourceKey));
    if (value === null) {
      console.warn(`DeepLinkGUI: ignoring non-numeric stored value for "${sourceKey}"`);
      return undefined;
    }
    if (sourceKey !== key) {
      this.urlKeys.add(sourceKey);
      this.urlWriter(key, value);
      this.urlWriter(sourceKey, null);
    }
    return value;
  }

  /**
   * Read an opaque companion value without creating a visible control.
   * @param {string} prop - Companion property name within this GUI namespace.
   * @returns {string|undefined} Stored text, or undefined when absent.
   */
  readStoredString(prop) {
    const key = this.getKey(prop);
    this.urlKeys.add(key);
    const params = this.urlParams();
    return params.has(key) ? params.get(key) ?? undefined : undefined;
  }

  /**
   * Write or clear a companion value without creating a visible control.
   * @param {string} prop - Companion property name within this GUI namespace.
   * @param {string|number|boolean|null|undefined} value - Value, or null to clear.
   * @returns {void}
   */
  writeStoredValue(prop, value) {
    const key = this.getKey(prop);
    this.urlKeys.add(key);
    this.urlWriter(key, value);
  }

  /**
   * Installs the deep-link URL writer as the controller's onChange and redirects
   * any later caller onChange(fn) to user handlers that run ahead of the writer.
   * lil-gui keeps a single onChange slot, so without this a caller doing
   * `gui.add(...).onChange(cb)` would silently overwrite the URL writer and break
   * deep-link persistence for that control. Every caller handler is fanned out, so
   * repeated onChange(fn) registrations compose rather than clobber one another.
   *
   * Only `onChange` participates in URL persistence and load-time replay;
   * `onFinishChange` is left untouched, so a control wired solely through
   * `onFinishChange` is not deep-linked. A synchronous handler may call
   * `controller.acceptUrlValue(value)` to persist an accepted value while the
   * controller continues to display the proposed value.
   * @param {Object} controller - The lil-gui controller to wrap.
   * @param {Function} writeUrl - Callback that persists the control's value to the URL.
   * @param {boolean} [applyOnLoad=false] - When true (value hydrated from URL), replay the caller's onChange once on first registration so its side effect runs at startup.
   * @returns {Object} The same controller, for chaining.
   */
  attachUrlWriter(controller, writeUrl, applyOnLoad = false) {
    const userOnChange = [];
    let urlValue = controller.getValue();
    controller.acceptUrlValue = (value) => {
      urlValue = value;
      return controller;
    };
    controller.onChange((v) => {
      urlValue = v;
      for (const fn of userOnChange) fn(v);
      writeUrl(urlValue);
    });
    controller.onChange = (fn) => {
      if (fn) userOnChange.push(fn);
      // For a URL-hydrated value, fire each newly-registered handler once so its
      // load-time side effect runs the deep-linked state — once per handler, so a
      // second fan-out consumer isn't skipped by a single shared latch.
      if (applyOnLoad && fn) {
        const proposed = controller.getValue();
        fn(proposed);
        if (!Object.is(urlValue, proposed)) writeUrl(urlValue);
      }
      return controller;
    };
    return controller;
  }

  /**
   * Adds a control, seeding its value from the URL (when present and valid) and
   * wiring it to write changes back.
   * @param {Object} object - The object holding the bound property.
   * @param {string} prop - The property name to control (a function makes it a button).
   * @param {...*} args - Forwarded to lil-gui's add() (min/max/step for numbers, or a choices array/object for an enum).
   * @returns {Object} The created lil-gui controller.
   */
  add(object, prop, ...args) {
    return this.addWithHydration(true, object, prop, [], ...args);
  }

  /**
   * Adds a control that accepts old property names and rewrites them to the
   * canonical deep-link key.
   * @param {Object} object - The object holding the bound property.
   * @param {string} prop - The canonical property name.
   * @param {Array<string>} legacyProps - Former property names.
   * @param {...*} args - Forwarded to lil-gui's add().
   * @returns {Object} The created controller.
   */
  addMigrated(object, prop, legacyProps, ...args) {
    return this.addWithHydration(true, object, prop, legacyProps, ...args);
  }

  /**
   * Adds a deep-linked control without seeding it from the current URL. Dynamic
   * effect-schema rebuilds use this for controls that already existed in the
   * previous schema: their engine values are newer than a debounced URL write,
   * but subsequent edits must keep updating the same deep-link key.
   * @param {Object} object - The object holding the bound property.
   * @param {string} prop - The property name to control.
   * @param {...*} args - Forwarded to lil-gui's add().
   * @returns {Object} The created lil-gui controller.
   */
  addUnhydrated(object, prop, ...args) {
    return this.addWithHydration(false, object, prop, [], ...args);
  }

  /**
   * Common deep-linked control construction.
   * @param {boolean} hydrate - Whether a matching URL value may seed the control.
   * @param {Object} object - The object holding the bound property.
   * @param {string} prop - The property name to control.
   * @param {Array<string>} legacyProps - Former property names.
   * @param {...*} args - Forwarded to lil-gui's add().
   * @returns {Object} The created lil-gui controller.
   */
  addWithHydration(hydrate, object, prop, legacyProps, ...args) {
    const key = this.getKey(prop);
    const isFunction = typeof object[prop] === 'function';

    const params = this.urlParams();
    let urlApplied = false;
    let valClamped = false;
    const legacyKey = legacyProps
      .map((legacyProp) => this.getKey(legacyProp))
      .find((candidate) => params.has(candidate));
    const sourceKey = params.has(key) ? key : legacyKey;
    if (hydrate && !isFunction && sourceKey) {
      let val = params.get(sourceKey);
      const currentVal = object[prop];
      urlApplied = true;
      if (typeof currentVal === 'number') {
        const num = parseUrlNumber(val);
        if (num === null) {
          console.warn(`DeepLinkGUI: ignoring non-numeric URL value "${params.get(sourceKey)}" for "${sourceKey}"`);
          val = currentVal;
          urlApplied = false;
          valClamped = true;
        } else {
          val = num;
          // lil-gui numeric add() signature is add(obj, prop, min, max, step).
          const min = args[0], max = args[1], step = args[2];
          const raw = val;
          if (typeof min === 'number' && val < min) val = min;
          if (typeof max === 'number' && val > max) val = max;
          // The URL path bypasses lil-gui's step snapping, so snap to a step multiple.
          if (Number.isFinite(step) && step > 0) {
            const anchor = typeof min === 'number' ? min : 0;
            val = anchor + Math.round((val - anchor) / step) * step;
            if (typeof min === 'number' && val < min) val = min;
            if (typeof max === 'number' && val > max) val = max;
          }
          // The snap multiply introduces float noise (0.3 -> 0.30000000000000004),
          // so an already-on-grid value must not read as clamped; only a change
          // larger than a fraction of the step counts.
          const snapTol = Number.isFinite(step) && step > 0 ? Math.abs(step) * 1e-6 : 0;
          valClamped = Math.abs(val - raw) > snapTol;
        }
      } else if (typeof currentVal === 'boolean') {
        const flag = parseUrlBoolean(val);
        if (flag === null) {
          console.warn(`DeepLinkGUI: ignoring unrecognized boolean URL value "${params.get(sourceKey)}" for "${sourceKey}"`);
          val = currentVal;
          urlApplied = false;
          valClamped = true;
        } else {
          val = flag;
        }
      }
      const allowed = optionValues(args[0]);
      if (allowed) {
        // The URL carries the option value, not its label, so an object-enum
        // whose labels share a value can't round-trip to the exact label.
        const hasDuplicateValues = new Set(allowed.map(String)).size !== allowed.length;
        if (hasDuplicateValues) {
          console.warn(`DeepLinkGUI: enum "${key}" has options sharing a value; the deep link may restore a different label.`);
        }
        // Deep-link values arrive as strings, but an enum's option values may be
        // numbers (or other non-strings); fall back to a string-form match so a
        // typed option isn't rejected for being unequal to the raw URL string.
        let idx = allowed.indexOf(val);
        if (idx < 0) idx = allowed.findIndex((opt) => String(opt) === String(val));
        if (idx < 0) {
          console.warn(`DeepLinkGUI: ignoring out-of-range URL value "${params.get(sourceKey)}" for "${sourceKey}"`);
          urlApplied = false;
          valClamped = true;
        } else {
          object[prop] = allowed[idx];
        }
      } else {
        object[prop] = val;
      }
    }

    const controller = this.gui.add(object, prop, ...args);

    if (!isFunction) {
      this.urlKeys.add(key);
      this.attachUrlWriter(controller, (v) => this.urlWriter(key, v), urlApplied);
    }

    if (!isFunction && sourceKey && sourceKey !== key) {
      this.urlKeys.add(sourceKey);
      this.urlWriter(key, controller.getValue());
      this.urlWriter(sourceKey, null);
    }

    if (!isFunction && valClamped) {
      // The applied value differs from the URL string (number clamped/snapped, or
      // out-of-range enum rejected): rewrite the URL so it no longer holds the stale one.
      this.urlWriter(key, controller.getValue());
    }

    if (!isFunction && urlApplied) {
      try { controller.updateDisplay(); }
      catch (e) { console.warn(`DeepLinkGUI: updateDisplay failed for "${key}":`, e); }
    }

    return controller;
  }

  /**
   * Adds a control that is NOT deep-linked: its value is neither seeded from nor
   * written to the URL. Use for session/action controls (cyclers, recording
   * settings) that must not auto-activate from a copied link, and for controls
   * mirroring a key URLSync already owns. Render-mode controls, including the
   * segmented worker pool, are deep-linked so a shared link reproduces the
   * sender's view.
   * @param {Object} object - The object holding the bound property.
   * @param {string} prop - The property name to control.
   * @param {...*} args - Forwarded to lil-gui's add().
   * @returns {Object} The created lil-gui controller.
   */
  addSession(object, prop, ...args) {
    return this.gui.add(object, prop, ...args);
  }

  /**
   * Creates a child folder wrapped as a DeepLinkGUI, linked into this GUI's
   * subtree so its name prefixes the keys of controls added inside it.
   * @param {string} name - The folder's display name and key prefix.
   * @returns {DeepLinkGUI} The wrapped child folder.
   */
  addFolder(name) {
    const folder = this.gui.addFolder(name);
    const wrapped = new DeepLinkGUI(folder, null, this);
    wrapped.folderName = name;
    wrapped.folderIndex = this.children.length;
    // Fixed here rather than at add() time so a folder's controls can never
    // split across two naming schemes when a same-name sibling appears later.
    // A positional segment for an empty name keeps the level from collapsing;
    // the first claimant of a name keeps the bare segment, so unique-named
    // folders hold their existing (shared-link-stable) keys.
    const duplicate = this.children.some((c) => c.folderName === name);
    wrapped.keySegment = name
      ? (duplicate ? `${name}#${wrapped.folderIndex}` : name)
      : `#${wrapped.folderIndex}`;
    this.children.push(wrapped);
    return wrapped;
  }

  /**
   * Creates a visual folder without changing any descendant deep-link key.
   * @param {string} name - Folder title shown in the GUI.
   * @returns {DeepLinkGUI} The wrapped child folder.
   */
  addDisplayFolder(name) {
    const folder = this.gui.addFolder(name);
    const wrapped = new DeepLinkGUI(folder, null, this);
    wrapped.folderName = name;
    wrapped.folderIndex = this.children.length;
    wrapped.keySegment = null;
    this.children.push(wrapped);
    return wrapped;
  }

  /** @returns {boolean} Whether the wrapped GUI panel is collapsed. */
  get closed() { return Boolean(this.gui._closed); }
  /**
   * Sets the wrapped GUI panel's open state.
   * @param {boolean} [open=true] - Whether the panel is expanded.
   * @returns {void}
   */
  open(open = true) { this.gui.open(open); }
  /**
   * Closes (collapses) the wrapped GUI panel.
   * @returns {void}
   */
  close() { this.gui.close(); }
  /**
   * Destroys the wrapped lil-gui instance and its DOM, if supported.
   * @returns {void}
   */
  destroy() {
    // urlWriter is shared root→children (addFolder); only the root may cancel it.
    if (this.parent === null && this.urlWriter && this.urlWriter.cancel) this.urlWriter.cancel();
    if (this.gui.destroy) this.gui.destroy();
  }
}

/**
 * Removes deep-link URL params, preserving the given keys. Delegates to the
 * app's URLSync when present, else rewrites the query string directly.
 * @param {Array<string>} [excludedKeys=[]] - Param keys to preserve.
 * @param {Window} [win] - The window whose query string is rewritten.
 * @returns {void}
 */
export const resetGUI = (excludedKeys = [], win = window) => {
  const sync = getActiveURLSync();
  if (sync) {
    sync.reset(excludedKeys);
    return;
  }
  const params = getUrlParams(win);
  for (const key of Array.from(params.keys())) {
    if (!excludedKeys.includes(key)) {
      params.delete(key);
    }
  }
  writeUrl(params, win);
};

export { DeepLinkGUI as GUI };
