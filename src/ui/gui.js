/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { GUI as LilGUI } from "lil-gui";
import { parseUrlNumber } from '../app/state.js';
import { getUrlParams, makeUrlParamWriter } from './url_params.js';
import { hydrate as hydrateValue, optionValues, hydrationWarnings } from './url_hydration.js';
import { KeyPath } from './deep_link_keys.js';
import { isClosed } from './lil_gui_adapter.js';
export { makeUrlParamWriter, resetGUI } from './url_params.js';

/** @typedef {import('lil-gui').Controller & {acceptUrlValue?: (value: unknown) => import('lil-gui').Controller}} UrlController */
/** @typedef {import('./url_params.js').UrlWriter} UrlWriter */

/** @param {unknown} value @returns {value is LilGUI} */
function isGui(value) {
  if (!value || typeof value !== 'object') return false;
  const candidate = /** @type {Partial<LilGUI>} */ (value);
  return Boolean(candidate.domElement && candidate.addFolder);
}

/**
 * lil-gui wrapper that deep-links controls added through add() and
 * addUnhydrated() to URL query params, giving the app shareable links.
 * add() hydrates from the URL on creation; both write back on change.
 * addSession() controls and buttons are not persisted.
 */
class DeepLinkGUI {
  /**
   * @param {ConstructorParameters<typeof LilGUI>[0]|LilGUI} options - Either lil-gui constructor options or an
   *   existing lil-gui instance to wrap (detected by its domElement/addFolder members).
   * @param {string|null} [rootNamespace] - Prefix segment for every deep-link key in
   *   this root's subtree (e.g. 'fx', 'view'), keeping independent GUI roots out
   *   of one flat key namespace. Omitted for an unnamespaced root.
   * @param {DeepLinkGUI|null} [parent] - Enclosing GUI when this is a sub-folder; a
   *   child shares its root's URL writer instead of owning one.
   * @param {Window|null} [win] - The window this subtree reads deep links from and
   *   writes them back to; inherited from `parent`, else the ambient one.
   */
  constructor(options, rootNamespace = null, parent = null, win = null) {
    if (isGui(options)) {
      this.gui = options;
    } else {
      this.gui = new LilGUI(options);
    }
    this.rootNamespace = rootNamespace;
    this.parent = parent;
    this.keyPath = new KeyPath(rootNamespace, parent?.keyPath ?? null);
    /** @type {Set<string>} */
    this.urlKeys = new Set();
    /** @type {DeepLinkGUI[]} */
    this.children = [];
    this.win = win ?? parent?.win ?? null;
    this.urlWriter = /** @type {UrlWriter} */ (parent ? parent.urlWriter : makeUrlParamWriter(this.win));
  }

  /** @returns {HTMLButtonElement} The folder title button. */
  get titleElement() { return /** @type {HTMLButtonElement} */ (this.gui.$title); }

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
   * "fx.Effects.Speed".
   * @param {string} prop - The control's property name.
   * @returns {string} The dot-joined param key.
   */
  getKey(prop) {
    return this.keyPath.key(prop);
  }

  /**
   * Read a numeric companion value without creating a visible control.
   * @param {string} prop - Companion property name within this GUI namespace.
   * @returns {number|undefined} Parsed value, or undefined when absent/invalid.
   */
  readStoredNumber(prop) {
    const key = this.getKey(prop);
    this.urlKeys.add(key);
    const params = this.urlParams();
    if (!params.has(key)) return undefined;
    const value = parseUrlNumber(params.get(key) ?? '');
    if (value === null) {
      console.warn(`DeepLinkGUI: ignoring non-numeric stored value for "${key}"`);
      return undefined;
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
   * any later caller onChange(fn) to user handlers that run ahead of the writer;
   * repeated registrations compose. Only `onChange` participates in URL
   * persistence and load-time replay, not `onFinishChange`. A synchronous handler may call
   * `controller.acceptUrlValue(value)` to persist an accepted value while the
   * controller continues to display the proposed value.
   * @param {UrlController} controller - The lil-gui controller to wrap.
   * @param {(value: unknown) => void} persistUrl - Callback that persists the control's value to the URL.
   * @param {boolean} [applyOnLoad=false] - When true (value hydrated from URL), replay each onChange handler once when it registers so its side effect runs at startup.
   * @returns {UrlController} The same controller, for chaining.
   */
  attachUrlWriter(controller, persistUrl, applyOnLoad = false) {
    /** @type {Function[]} */
    const userOnChange = [];
    let urlValue = controller.getValue();
    controller.acceptUrlValue = (value) => {
      urlValue = value;
      return controller;
    };
    controller.onChange((/** @type {unknown} */ v) => {
      urlValue = v;
      for (const fn of userOnChange) fn(v);
      persistUrl(urlValue);
    });
    controller.onChange = (fn) => {
      if (fn) userOnChange.push(fn);
      if (applyOnLoad && fn) {
        const proposed = controller.getValue();
        fn(proposed);
        if (!Object.is(urlValue, proposed)) persistUrl(urlValue);
      }
      return controller;
    };
    return controller;
  }

  /**
   * Adds a control, seeding its value from the URL (when present and valid) and
   * wiring it to write changes back.
   * @template {object} T
   * @template {keyof T & string} K
   * @param {T} object - The object holding the bound property.
   * @param {K} prop - The property name to control (a function makes it a button).
   * @param {...*} args - Forwarded to lil-gui's add() (min/max/step for numbers, or a choices array/object for an enum).
   * @returns {UrlController} The created lil-gui controller.
   */
  add(object, prop, ...args) {
    return this.addWithHydration(true, object, prop, ...args);
  }

  /**
   * Adds a deep-linked control without seeding it from the current URL; later
   * edits still write its deep-link key.
   * @template {object} T
   * @template {keyof T & string} K
   * @param {T} object - The object holding the bound property.
   * @param {K} prop - The property name to control.
   * @param {...*} args - Forwarded to lil-gui's add().
   * @returns {UrlController} The created lil-gui controller.
   */
  addUnhydrated(object, prop, ...args) {
    return this.addWithHydration(false, object, prop, ...args);
  }

  /**
   * Common deep-linked control construction.
   * @param {boolean} hydrate - Whether a matching URL value may seed the control.
   * @template {object} T
   * @template {keyof T & string} K
   * @param {T} object - The object holding the bound property.
   * @param {K} prop - The property name to control.
   * @param {...*} args - Forwarded to lil-gui's add().
   * @returns {UrlController} The created lil-gui controller.
   */
  addWithHydration(hydrate, object, prop, ...args) {
    const supported = ['number', 'string', 'boolean', 'function'];
    if (!supported.includes(typeof object[prop]) && !optionValues(args[0])) {
      throw new TypeError(`DeepLinkGUI: unsupported property "${prop}"`);
    }
    const key = this.getKey(prop);
    const isFunction = typeof object[prop] === 'function';

    const params = this.urlParams();
    const result = hydrateValue({ raw: hydrate ? params.get(key) : null, current: object[prop], args });
    for (const warning of hydrationWarnings(result, key)) console.warn(warning);
    if (result.kind === 'applied' || result.kind === 'fallback') object[prop] = /** @type {T[K]} */ (result.value);
    const urlApplied = result.kind === 'applied';
    const valClamped = result.rewrite;

    const controller = this.gui.add(object, prop, ...args);
    if (!controller) {
      throw new TypeError(`DeepLinkGUI: unsupported property "${prop}"`);
    }

    if (!isFunction) {
      this.urlKeys.add(key);
      this.attachUrlWriter(controller, (v) => this.urlWriter(key, /** @type {string|number|boolean|null|undefined} */ (v)), urlApplied);
    }

    if (!isFunction && valClamped) {
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
   * written to the URL.
   * @template {object} T
   * @template {keyof T & string} K
   * @param {T} object - The object holding the bound property.
   * @param {K} prop - The property name to control.
   * @param {...*} args - Forwarded to lil-gui's add().
   * @returns {UrlController} The created lil-gui controller.
   */
  addSession(object, prop, ...args) {
    const controller = this.gui.add(object, prop, ...args);
    if (!controller) {
      throw new TypeError(`DeepLinkGUI: unsupported property "${prop}"`);
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
    const wrapped = new DeepLinkGUI(folder, null, this);
    wrapped.keyPath = this.keyPath.folder(name);
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
    wrapped.keyPath = this.keyPath.folder(name, true);
    this.children.push(wrapped);
    return wrapped;
  }

  /** @returns {boolean} Whether the wrapped GUI panel is collapsed. */
  get closed() { return isClosed(this.gui); }
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

export { DeepLinkGUI as GUI };
