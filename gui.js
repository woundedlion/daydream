
import { GUI as LilGUI } from "lil-gui";
import { getActiveURLSync, roundUrlNumber } from "./state.js";

/**
 * Reads the current URL query string into a parsed params object.
 * @returns {URLSearchParams} The query parameters of the current location.
 */
const getUrlParams = () => new URLSearchParams(window.location.search);

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
 * Whether a URL string is a color literal lil-gui's color parser can accept.
 * Matches the two forms _attachUrlWriter serializes — `#hex` (3/4/6/8 digits)
 * and `rgb()/rgba()` with numeric components — so a malformed deep link is
 * rejected before it reaches the parser and renders a broken swatch.
 * @param {*} s - Candidate value from the URL.
 * @returns {boolean} True if `s` is a valid #hex or rgb()/rgba() color string.
 */
const isValidColorString = (s) =>
  typeof s === 'string' &&
  (/^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(s) ||
   /^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(s));

/**
 * Builds an independent debounced URL-param writer with its OWN pending-writes
 * buffer and timer. Each `DeepLinkGUI` owns one (shared down its folder subtree),
 * so two separate GUIs on a single tool page no longer share one module-global
 * debounce — a footgun where one GUI's flush could swallow or race the other's.
 *
 * The returned writer persists a single GUI control value to the URL query
 * params. When the app's single URLSync writer is present (the main simulator)
 * writes funnel through it so GUI param changes and effect/resolution changes
 * can't clobber each other; the per-instance fallback below is only reached on
 * standalone tool pages that have no URLSync.
 *
 * Pending writes are accumulated per key and merged in a single flush: a timer
 * that only remembered the last key would drop the first of two params changed
 * within the debounce window from the deep link.
 * @returns {(key: string, value: (string|number|boolean|null|undefined)) => void}
 *   A writer; `value` null/undefined deletes the key.
 */
const makeUrlParamWriter = () => {
  let urlTimer = null;
  const pendingUrlWrites = new Map(); // key -> value (null/undefined => delete)
  return (key, value) => {
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
    urlTimer = setTimeout(() => {
      const params = getUrlParams();
      for (const [k, v] of pendingUrlWrites) {
        if (v === null || v === undefined) {
          params.delete(k);
        } else if (typeof v === 'number') {
          params.set(k, String(roundUrlNumber(v)));
        } else {
          params.set(k, v);
        }
      }
      pendingUrlWrites.clear();
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    }, 200);
  };
};

export { makeUrlParamWriter };

/**
 * lil-gui wrapper that persists every control's value to URL query params,
 * giving the app shareable deep links. Wraps add/addColor/addFolder to hydrate
 * from the URL on creation and write back on change.
 */
class DeepLinkGUI {
  /**
   * @param {(Object|LilGUI)} options - Either lil-gui constructor options or an
   *   existing lil-gui instance to wrap (detected by its domElement/addFolder members).
   */
  constructor(options) {
    if (options && options.domElement && options.addFolder) {
      this.gui = options;
    } else {
      this.gui = new LilGUI(options);
    }
    this.parent = null;
    this.folderName = null;
    this._urlKeys = new Set();
    this._children = [];
    this._urlWriter = makeUrlParamWriter();
  }

  /**
   * Collects all deep-link URL param keys managed by this GUI and its sub-folders.
   * @returns {Array<string>} The flattened list of managed param keys.
   */
  collectUrlKeys() {
    const keys = [...this._urlKeys];
    for (const child of this._children) keys.push(...child.collectUrlKeys());
    return keys;
  }

  /**
   * The root DOM element of the wrapped lil-gui instance.
   * @returns {HTMLElement} The GUI's container element.
   */
  get domElement() { return this.gui.domElement; }
  /**
   * The pixel width of the wrapped lil-gui instance.
   * @returns {number} The GUI width in pixels.
   */
  get width() { return this.gui.width; }

  /**
   * Builds a control's URL param key by joining its enclosing folder names with
   * the property, e.g. "Effects.Speed", so nested controls get distinct keys.
   * @param {string} prop - The control's property name.
   * @returns {string} The dot-joined param key.
   */
  _getKey(prop) {
    let keys = [prop];
    let curr = this;
    while (curr.parent) {
      if (curr.folderName) keys.unshift(curr.folderName);
      curr = curr.parent;
    }
    return keys.join('.');
  }

  /**
   * Installs the deep-link URL writer as the controller's onChange and redirects
   * any later caller onChange(fn) to user handlers that run ahead of the writer.
   * lil-gui keeps a single onChange slot, so without this a caller doing
   * `gui.add(...).onChange(cb)` would silently overwrite the URL writer and break
   * deep-link persistence for that control. Every caller handler is fanned out, so
   * repeated onChange(fn) registrations compose rather than clobber one another.
   * @param {Object} controller - The lil-gui controller to wrap.
   * @param {Function} writeUrl - Callback that persists the control's value to the URL.
   * @param {boolean} [applyOnLoad=false] - When true (value hydrated from URL), replay the caller's onChange once on first registration so its side effect runs at startup.
   * @returns {Object} The same controller, for chaining.
   */
  _attachUrlWriter(controller, writeUrl, applyOnLoad = false) {
    const userOnChange = [];
    let replayed = false;
    controller.onChange((v) => {
      for (const fn of userOnChange) fn(v);
      writeUrl(v);
    });
    controller.onChange = (fn) => {
      if (fn) userOnChange.push(fn);
      // For a URL-hydrated value, fire the just-registered handler once so its
      // side effect runs the deep-linked state — but only on first registration.
      if (applyOnLoad && fn && !replayed) {
        replayed = true;
        fn(controller.getValue());
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
    const key = this._getKey(prop);
    const isFunction = typeof object[prop] === 'function';

    const params = getUrlParams();
    let urlApplied = false;
    let valClamped = false;
    if (!isFunction && params.has(key)) {
      let val = params.get(key);
      const currentVal = object[prop];
      urlApplied = true;
      if (typeof currentVal === 'number') {
        val = parseFloat(val);
        if (!Number.isFinite(val)) {
          console.warn(`DeepLinkGUI: ignoring non-numeric URL value "${params.get(key)}" for "${key}"`);
          val = currentVal;
          urlApplied = false;
        } else {
          // lil-gui numeric add() signature is add(obj, prop, min, max, step).
          const min = args[0], max = args[1], step = args[2];
          const raw = val;
          if (typeof min === 'number' && val < min) val = min;
          if (typeof max === 'number' && val > max) val = max;
          // The URL path bypasses lil-gui's step snapping, so snap to a step multiple.
          if (Number.isFinite(step) && step > 0) {
            const anchor = typeof min === 'number' ? min : 0;
            val = anchor + Math.round((val - anchor) / step) * step;
          }
          valClamped = val !== raw;
        }
      } else if (typeof currentVal === 'boolean') {
        const t = val.trim().toLowerCase();
        if (t === 'true' || t === '1' || t === 'yes' || t === 'on') {
          val = true;
        } else if (t === 'false' || t === '0' || t === 'no' || t === 'off') {
          val = false;
        } else {
          console.warn(`DeepLinkGUI: ignoring unrecognized boolean URL value "${params.get(key)}" for "${key}"`);
          val = currentVal;
          urlApplied = false;
        }
      }
      const allowed = optionValues(args[0]);
      if (allowed) {
        // Deep-link values arrive as strings, but an enum's option values may be
        // numbers (or other non-strings); fall back to a string-form match so a
        // typed option isn't rejected for being unequal to the raw URL string.
        let idx = allowed.indexOf(val);
        if (idx < 0) idx = allowed.findIndex((opt) => String(opt) === String(val));
        if (idx < 0) {
          console.warn(`DeepLinkGUI: ignoring out-of-range URL value "${params.get(key)}" for "${key}"`);
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
      this._urlKeys.add(key);
      this._attachUrlWriter(controller, (v) => this._urlWriter(key, v), urlApplied);
    }

    if (!isFunction && valClamped) {
      // The applied value differs from the URL string (number clamped/snapped, or
      // out-of-range enum rejected): rewrite the URL so it no longer holds the stale one.
      this._urlWriter(key, controller.getValue());
    }

    if (!isFunction && urlApplied) {
      try { controller.updateDisplay(); }
      catch (e) { console.warn(`DeepLinkGUI: updateDisplay failed for "${key}":`, e); }
    }

    return controller;
  }

  /**
   * Adds a color control, seeding from the URL and serializing changes to a
   * string (#rrggbb for THREE.Color-like values, rgb(r,g,b) for arrays).
   * @param {Object} object - The object holding the bound color property.
   * @param {string} prop - The color property name to control.
   * @returns {Object} The created lil-gui color controller.
   */
  addColor(object, prop) {
    const key = this._getKey(prop);
    // lil-gui's color parser silently accepts garbage, so reject invalid literals.
    const params = getUrlParams();
    let urlApplied = false;
    if (params.has(key)) {
      const urlVal = params.get(key);
      if (isValidColorString(urlVal)) {
        object[prop] = urlVal;
        urlApplied = true;
      } else {
        console.warn(`DeepLinkGUI: ignoring invalid URL color "${urlVal}" for "${key}"`);
      }
    }

    const controller = this.gui.addColor(object, prop);

    this._urlKeys.add(key);
    this._attachUrlWriter(controller, (v) => {
      let strVal = v;
      if (typeof v === 'object' && v.getHexString) {
        strVal = '#' + v.getHexString();
      } else if (Array.isArray(v)) {
        strVal = `rgb(${v[0]},${v[1]},${v[2]})`;
      } else if (typeof v === 'number') {
        strVal = '#' + ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0');
      } else if (typeof v === 'string') {
        strVal = /^[0-9a-fA-F]{6}$/.test(v) ? `#${v}` : v;
      }
      this._urlWriter(key, strVal);
    }, urlApplied);

    if (urlApplied) {
      try { controller.updateDisplay(); }
      catch (e) { console.warn(`DeepLinkGUI: updateDisplay failed for "${key}":`, e); }
    }

    return controller;
  }

  /**
   * Creates a child folder wrapped as a DeepLinkGUI, linked into this GUI's
   * subtree so its name prefixes the keys of controls added inside it.
   * @param {string} name - The folder's display name and key prefix.
   * @returns {DeepLinkGUI} The wrapped child folder.
   */
  addFolder(name) {
    const folder = this.gui.addFolder(name);
    const wrapped = new DeepLinkGUI(folder);
    wrapped.parent = this;
    wrapped.folderName = name;
    wrapped._urlWriter = this._urlWriter;
    this._children.push(wrapped);
    return wrapped;
  }

  /**
   * Clears all deep-link params except the given keys.
   * @param {Array<string>} [excludedKeys=[]] - Param keys to preserve.
   * @returns {void}
   */
  static reset(excludedKeys = []) {
    resetGUI(excludedKeys);
  }

  /**
   * Opens (expands) the wrapped GUI panel.
   * @returns {void}
   */
  open() { this.gui.open(); }
  /**
   * Closes (collapses) the wrapped GUI panel.
   * @returns {void}
   */
  close() { this.gui.close(); }
  /**
   * Destroys the wrapped lil-gui instance and its DOM, if supported.
   * @returns {void}
   */
  destroy() { if (this.gui.destroy) this.gui.destroy(); }
}

/**
 * Removes deep-link URL params, preserving the given keys. Delegates to the
 * app's URLSync when present, else rewrites the query string directly.
 * @param {Array<string>} [excludedKeys=[]] - Param keys to preserve.
 * @returns {void}
 */
export const resetGUI = (excludedKeys = []) => {
  const sync = getActiveURLSync();
  if (sync) {
    sync.reset(excludedKeys);
    return;
  }
  const params = getUrlParams();
  for (const key of Array.from(params.keys())) {
    if (!excludedKeys.includes(key)) {
      params.delete(key);
    }
  }
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
};

export { DeepLinkGUI as GUI };
