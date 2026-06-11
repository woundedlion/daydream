
import { GUI as LilGUI } from "lil-gui";
import { getActiveURLSync } from "./state.js";

// Helper to read URL state.
const getUrlParams = () => new URLSearchParams(window.location.search);

// The set of values lil-gui will accept for an enumerated control
// (`add(obj, prop, $1)`): an array of choices, or an object whose *values* are
// the choices. Anything else ($1 a number → a slider's min, or absent) is not
// enumerated, so there is no list to validate against (returns null).
const optionValues = (options) => {
  if (Array.isArray(options)) return options;
  if (options && typeof options === 'object') return Object.values(options);
  return null;
};

// URL writes funnel through the app's single URLSync writer when present (the
// main simulator), so GUI param changes and effect/resolution changes can't
// clobber each other. Standalone pages without a URLSync (the tool pages) fall
// back to a self-contained debounced write that reads the URL at fire time.
//
// Pending writes are accumulated per key (mirroring URLSync._adhoc) and merged
// in a single flush: a shared timer that only remembered the last key would drop
// the first of two params changed within the debounce window from the deep link.
let urlTimer = null;
const pendingUrlWrites = new Map(); // key -> value (null/undefined => delete)
export const setUrlParam = (key, value) => {
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
        params.set(k, parseFloat(v.toFixed(4)));
      } else {
        params.set(k, v);
      }
    }
    pendingUrlWrites.clear();
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
  }, 200);
};

class DeepLinkGUI {
  constructor(options) {
    // Handle wrapping existing instance or creating new one
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
  }

  // All deep-link URL param keys managed by this GUI and its sub-folders.
  collectUrlKeys() {
    const keys = [...this._urlKeys];
    for (const child of this._children) keys.push(...child.collectUrlKeys());
    return keys;
  }

  get domElement() { return this.gui.domElement; }
  get width() { return this.gui.width; }

  _getKey(prop) {
    let keys = [prop];
    let curr = this;
    while (curr.parent) {
      if (curr.folderName) keys.unshift(curr.folderName);
      curr = curr.parent;
    }
    return keys.join('.');
  }

  // Install our deep-link URL writer as the controller's onChange and redirect
  // any later caller onChange(fn) to a user slot that runs *ahead* of the
  // writer. lil-gui keeps a single onChange slot, so without this a caller
  // doing `gui.add(...).onChange(cb)` would silently overwrite the URL writer
  // and break deep-link persistence for that control.
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

  add(object, prop, ...args) {
    const key = this._getKey(prop);
    const isFunction = typeof object[prop] === 'function';

    // 1. Load initial value from URL (skip for buttons)
    const params = getUrlParams();
    if (!isFunction && params.has(key)) {
      let val = params.get(key);
      const currentVal = object[prop];
      if (typeof currentVal === 'number') {
        val = parseFloat(val);
        // A non-numeric deep link (?Speed=fast → NaN) must never reach the
        // engine; fall back to the validated bound value.
        if (!Number.isFinite(val)) {
          console.warn(`DeepLinkGUI: ignoring non-numeric URL value "${params.get(key)}" for "${key}"`);
          val = currentVal;
        } else {
          // Clamp to the control's registered range. lil-gui's numeric add()
          // signature is add(obj, prop, min, max, step), so the bounds (when
          // present) are args[0]/args[1].
          const min = args[0], max = args[1];
          if (typeof min === 'number' && val < min) val = min;
          if (typeof max === 'number' && val > max) val = max;
        }
      } else if (typeof currentVal === 'boolean') {
        val = (val === 'true');
      }
      // For an enumerated control, a URL value outside the option list would
      // poison state: lil-gui shows it unselected, and the applyOnLoad replay
      // (step 3) would push the bogus value through the caller's onChange —
      // re-injecting it into appState and re-persisting it to the URL even
      // after upstream validation already corrected the value. Reject it and
      // keep the already-validated bound value instead.
      const allowed = optionValues(args[0]);
      if (allowed && !allowed.includes(val)) {
        console.warn(`DeepLinkGUI: ignoring out-of-range URL value "${params.get(key)}" for "${key}"`);
      } else {
        object[prop] = val;
      }
    }

    // 2. Create Controller
    const controller = this.gui.add(object, prop, ...args);

    // 3. Attach URL/State Listener (skip for buttons). Apply-on-load when the
    // value came from the URL so onChange-driven behavior runs at startup.
    if (!isFunction) {
      this._urlKeys.add(key);
      this._attachUrlWriter(controller, (v) => setUrlParam(key, v), params.has(key));
    }

    // 4. Update Display
    if (!isFunction && params.has(key)) {
      try { controller.updateDisplay(); }
      catch (e) { console.warn(`DeepLinkGUI: updateDisplay failed for "${key}":`, e); }
    }

    return controller;
  }

  addColor(object, prop) {
    const key = this._getKey(prop);
    // 1. Load from URL
    const params = getUrlParams();
    if (params.has(key)) {
      object[prop] = params.get(key);
    }

    // 2. Create Controller
    const controller = this.gui.addColor(object, prop);

    // 3. Attach URL/State Listener
    this._urlKeys.add(key);
    this._attachUrlWriter(controller, (v) => {
      // Handle Color Serialization
      let strVal = v;
      if (typeof v === 'object' && v.getHexString) {
        strVal = '#' + v.getHexString();
      } else if (Array.isArray(v)) {
        strVal = `rgb(${v[0]},${v[1]},${v[2]})`;
      }
      setUrlParam(key, strVal);
    }, params.has(key));

    // 4. Update Display
    if (params.has(key)) {
      try { controller.updateDisplay(); }
      catch (e) { console.warn(`DeepLinkGUI: updateDisplay failed for "${key}":`, e); }
    }

    return controller;
  }

  addFolder(name) {
    const folder = this.gui.addFolder(name);
    const wrapped = new DeepLinkGUI(folder);
    wrapped.parent = this;
    wrapped.folderName = name;
    this._children.push(wrapped);
    return wrapped;
  }

  static reset(excludedKeys = []) {
    resetGUI(excludedKeys);
  }

  open() { this.gui.open(); }
  close() { this.gui.close(); }
  destroy() { if (this.gui.destroy) this.gui.destroy(); }
}

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
