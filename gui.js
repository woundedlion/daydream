
import { GUI as LilGUI } from "lil-gui";
import { getActiveURLSync } from "./state.js";

// Helper to read URL state.
const getUrlParams = () => new URLSearchParams(window.location.search);

// URL writes funnel through the app's single URLSync writer when present (the
// main simulator), so GUI param changes and effect/resolution changes can't
// clobber each other. Standalone pages without a URLSync (the tool pages) fall
// back to a self-contained debounced write that reads the URL at fire time.
let urlTimer = null;
export const setUrlParam = (key, value) => {
  const sync = getActiveURLSync();
  if (sync) {
    sync.setParam(key, value);
    return;
  }
  clearTimeout(urlTimer);
  urlTimer = setTimeout(() => {
    const params = getUrlParams(); // read at fire time so we don't clobber
    if (value === null || value === undefined) {
      params.delete(key);
    } else if (typeof value === 'number') {
      params.set(key, parseFloat(value.toFixed(4)));
    } else {
      params.set(key, value);
    }
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
      if (applyOnLoad && fn) fn(controller.getValue());
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
      } else if (typeof currentVal === 'boolean') {
        val = (val === 'true');
      }
      object[prop] = val;
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
  remove(c) { this.gui.remove(c); }
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
