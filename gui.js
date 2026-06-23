
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
      sync.setParam(key, value);
      return;
    }
    pendingUrlWrites.set(key, value);
    clearTimeout(urlTimer);
    urlTimer = setTimeout(() => {
      const params = getUrlParams(); // read at fire time so we don't clobber
      for (const [k, v] of pendingUrlWrites) {
        if (v === null || v === undefined) {
          params.delete(k);
        } else if (typeof v === 'number') {
          params.set(k, roundUrlNumber(v));
        } else {
          params.set(k, v);
        }
      }
      pendingUrlWrites.clear();
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
    }, 200);
  };
};

// Module-level default writer for standalone callers (and the unit test). Each
// DeepLinkGUI instance creates its own via makeUrlParamWriter() instead of
// sharing this one.
export const setUrlParam = makeUrlParamWriter();

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
    // URL param keys this GUI manages a deep-link writer for, plus child
    // folders, so callers can ask which params belong to this GUI subtree
    // (e.g. to exclude the global controls from a per-effect resetGUI).
    this._urlKeys = new Set();
    this._children = [];
    // This GUI tree's own fallback URL writer (its own debounce buffer/timer);
    // addFolder() shares the root's writer down the subtree. Distinct GUIs get
    // distinct writers so they don't share module-global debounce state.
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
   * any later caller onChange(fn) to a user slot that runs ahead of the writer.
   * lil-gui keeps a single onChange slot, so without this a caller doing
   * `gui.add(...).onChange(cb)` would silently overwrite the URL writer and break
   * deep-link persistence for that control.
   * @param {Object} controller - The lil-gui controller to wrap.
   * @param {Function} writeUrl - Callback that persists the control's value to the URL.
   * @param {boolean} [applyOnLoad=false] - When true (value hydrated from URL), replay the caller's onChange once on first registration so its side effect runs at startup.
   * @returns {Object} The same controller, for chaining.
   */
  _attachUrlWriter(controller, writeUrl, applyOnLoad = false) {
    let userOnChange = null;
    let replayed = false;
    controller.onChange((v) => {
      if (userOnChange) userOnChange(v);
      writeUrl(v);
    });
    controller.onChange = (fn) => {
      userOnChange = fn;
      // When the control's value was hydrated from the URL, the caller's
      // onChange isn't attached until *after* add() returns, so the deep-linked
      // value was never pushed through the behavior the handler drives — the UI
      // would show e.g. "Pause" checked while setPaused() never ran. Fire the
      // handler once now with the loaded value so deep links don't lie about
      // state. Controls without a registered onChange (property-bound ones read
      // each frame) never reach here, so they're unaffected.
      //
      // Replay only on the *first* registration: re-registering onChange is a
      // legitimate lil-gui pattern, and re-firing the side effect on every
      // registration would be wrong.
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

    // 1. Load initial value from URL (skip for buttons). urlApplied tracks
    // whether a URL value was actually accepted into the bound state; it gates
    // the apply-on-load replay (step 3) so a rejected value never fires a
    // spurious onChange that re-persists the default back to the URL.
    const params = getUrlParams();
    let urlApplied = false;
    if (!isFunction && params.has(key)) {
      let val = params.get(key);
      const currentVal = object[prop];
      urlApplied = true; // cleared below if any validation rejects the value
      if (typeof currentVal === 'number') {
        val = parseFloat(val);
        // A non-numeric deep link (?Speed=fast → NaN) must never reach the
        // engine; fall back to the validated bound value.
        if (!Number.isFinite(val)) {
          console.warn(`DeepLinkGUI: ignoring non-numeric URL value "${params.get(key)}" for "${key}"`);
          val = currentVal;
          urlApplied = false;
        } else {
          // Clamp to the control's registered range. lil-gui's numeric add()
          // signature is add(obj, prop, min, max, step), so the bounds (when
          // present) are args[0]/args[1].
          const min = args[0], max = args[1];
          if (typeof min === 'number' && val < min) val = min;
          if (typeof max === 'number' && val > max) val = max;
        }
      } else if (typeof currentVal === 'boolean') {
        // Accept the common truthy/falsy spellings rather than treating
        // everything but the exact string 'true' as false: a hand-edited or
        // shared deep link with ?flag=1 or ?flag=on otherwise silently reads as
        // false. An unrecognized token warns and falls back to the bound value,
        // matching the numeric branch's warn-and-keep-default behavior.
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
      // For an enumerated control, a URL value outside the option list would
      // poison state: lil-gui shows it unselected, and the applyOnLoad replay
      // (step 3) would push the bogus value through the caller's onChange —
      // re-injecting it into appState and re-persisting it to the URL even
      // after upstream validation already corrected the value. Reject it,
      // clear urlApplied so step 3 doesn't replay, and keep the bound value.
      const allowed = optionValues(args[0]);
      if (allowed && !allowed.includes(val)) {
        console.warn(`DeepLinkGUI: ignoring out-of-range URL value "${params.get(key)}" for "${key}"`);
        urlApplied = false;
      } else {
        object[prop] = val;
      }
    }

    // 2. Create Controller
    const controller = this.gui.add(object, prop, ...args);

    // 3. Attach URL/State Listener (skip for buttons). Apply-on-load only when a
    // URL value was actually accepted — a rejected value left the bound default
    // in place, so replaying onChange would just re-persist that default.
    if (!isFunction) {
      this._urlKeys.add(key);
      this._attachUrlWriter(controller, (v) => this._urlWriter(key, v), urlApplied);
    }

    // 4. Update Display (only when a URL value was applied; a rejected value
    // left the controller showing its default already).
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
    // 1. Load from URL (validated). Unlike add()'s NaN/range/enum guards,
    // addColor previously hydrated the raw string straight into lil-gui's color
    // parser, which silently accepts garbage and renders a broken swatch. Reject
    // anything that is not a valid color literal and keep the bound default.
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

    // 2. Create Controller
    const controller = this.gui.addColor(object, prop);

    // 3. Attach URL/State Listener. Apply-on-load only when the URL color was
    // valid and applied — a rejected color left the bound default, so replaying
    // onChange would just re-persist that default.
    this._urlKeys.add(key);
    this._attachUrlWriter(controller, (v) => {
      let strVal = v;
      if (typeof v === 'object' && v.getHexString) {
        strVal = '#' + v.getHexString();
      } else if (Array.isArray(v)) {
        strVal = `rgb(${v[0]},${v[1]},${v[2]})`;
      }
      this._urlWriter(key, strVal);
    }, urlApplied);

    // 4. Update Display
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
    wrapped._urlWriter = this._urlWriter; // share the root tree's debounce writer
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

// compatibility with import * as gui from 'gui'
export const gui = { GUI: DeepLinkGUI };
export { DeepLinkGUI as GUI };
export default { GUI: DeepLinkGUI };
