import {fakeElement} from './fake_dom.js';

// The third add() argument that makes lil-gui build an OptionController: a list
// of choices, or an object mapping labels to them.
const isOptionList = (arg) =>
  Array.isArray(arg) || (arg !== null && typeof arg === 'object');

/**
 * A lil-gui controller as the root uses one: named, bound, and re-settable.
 * @param {Object} owner - The GUI the controller belongs to.
 * @param {Object} object - The value object the controller is bound to.
 * @param {string} property - The bound property name.
 * @param {Array<any>} args - Range/options arguments add() was called with.
 * @param {boolean} [optionsReplaces=false] - Whether options() replaces the controller.
 * @returns {Object} The controller double.
 */
function fakeController(owner, object, property, args = [], optionsReplaces = false) {
  // lil-gui exposes one focusable widget per control kind: $select for a choices
  // list, $button for a function, $input otherwise.
  const kind = isOptionList(args[0]) ? 'select'
    : typeof object[property] === 'function' ? 'button' : 'input';
  const widget = fakeElement(kind);
  const domElement = fakeElement('div');
  domElement.appendChild(widget);
  const controller = {
    object,
    property,
    args,
    label: property,
    decimalsSet: null,
    disabled: false,
    dragging: false,
    displayUpdates: 0,
    valueSets: [],
    replayOnChange: false,
    acceptedUrlValues: [],
    handlers: [],
    value: undefined,
    domElement,
    [`$${kind}`]: widget,
    getValue() { return object[property]; },
    decimals(n) { controller.decimalsSet = n; return controller; },
    name(text) { controller.label = text; return controller; },
    onChange(fn) {
      if (controller.session) controller.handlers = [fn];
      else controller.handlers.push(fn);
      controller.changed = controller.session ? fn
        : (value) => {
          const results = controller.handlers.map((handler) => handler(value));
          return results.some((result) => result?.then) ? Promise.all(results) : undefined;
        };
      if (controller.replayOnChange) fn(controller.getValue());
      return controller;
    },
    acceptUrlValue(value) { controller.acceptedUrlValues.push(value); return controller; },
    updateDisplay() { controller.displayUpdates += 1; return controller; },
    setValue(v) {
      if (object[property] === v) return controller;
      controller.valueSets.push(v);
      object[property] = v;
      controller.value = v;
      controller.changed?.(v);
      controller.updateDisplay();
      return controller;
    },
    // As in lil-gui: an OptionController (add() given an options list) rebuilds
    // its <select> in place, updates its display and returns itself; any other
    // controller is destroyed and a replacement carrying the copied name is
    // appended.
    options(choices) {
      if (!optionsReplaces && isOptionList(controller.args[0])) {
        controller.args = [choices];
        controller.updateDisplay();
        return controller;
      }
      controller.destroyed = true;
      const replacement = fakeController(
        owner, object, property, [choices], optionsReplaces);
      replacement.label = controller.label;
      const at = owner.controllers.indexOf(controller);
      if (at >= 0) owner.controllers.splice(at, 1);
      owner.controllers.push(replacement);
      controller.domElement.remove();
      owner.$children.appendChild(replacement.domElement);
      return replacement;
    },
    enable() { controller.enabled = true; controller.disabled = false; return controller; },
    disable() { controller.enabled = false; controller.disabled = true; return controller; },
    max(value) { controller.args[1] = value; return controller; },
    listen() { controller.listening = true; return controller; },
  };
  return controller;
}

/** Throws DeepLinkGUI's unsupported-property TypeError unless the property can back a control. */
function rejectUnsupported(target, property, choices) {
  if (Object(choices) === choices || ['number', 'boolean', 'string', 'function'].includes(typeof target[property])) return;
  throw new TypeError(`DeepLinkGUI: unsupported property "${property}"`);
}

/**
 * @param {string} [namespace=''] - Root namespace.
 * @param {{optionsReplaces?: boolean, hydrated?: Object}} [options={}] - Controller behavior and saved values.
 * @returns {Object} Deep-link GUI double.
 */
export function fakeGui(namespace = '', { optionsReplaces = false, hydrated = {} } = {}) {
  if (typeof namespace !== 'string') throw new TypeError('GUI namespace must be a string');
  return buildGui(namespace, optionsReplaces, false, hydrated, {});
}

/**
 * @param {{hydrated?: Object, stored?: Object}} [values={}] - Saved panel values.
 * @returns {Object} Effect-panel GUI double.
 */
export function fakePanelGui({ hydrated = {}, stored = {} } = {}) {
  return buildGui('', false, true, hydrated, stored);
}

function buildGui(namespace, optionsReplaces, panel, hydrated, stored) {
  const childrenElement = fakeElement('div');
  childrenElement.ownerDocument = { createElement: (tag) => fakeElement(tag) };
  childrenElement.classList.add('lil-children');
  const gui = {
    namespace,
    domElement: fakeElement('div'),
    titleElement: fakeElement('button'),
    controllers: [],
    folders: [],
    $children: childrenElement,
    stored: panel ? stored : new Map(),
    storedReads: [],
    storedWrites: [],
    destroyed: 0,
    destroyThrows: null,
    closed: false,
    ctrl(property) { return this.controllers.find((c) => c.property === property); },
    add(target, property, ...args) {
      rejectUnsupported(target, property, args[0]);
      const replay = Object.hasOwn(hydrated, property);
      if (replay) target[property] = hydrated[property];
      const c = fakeController(gui, target, property, args, optionsReplaces);
      c.replayOnChange = replay;
      gui.controllers.push(c);
      childrenElement.appendChild(c.domElement);
      return c;
    },
    // Session controls carry no deep link, so the two are told apart here.
    addSession(target, property, ...args) {
      rejectUnsupported(target, property, args[0]);
      const c = fakeController(gui, target, property, args, optionsReplaces);
      c.session = true;
      gui.controllers.push(c);
      childrenElement.appendChild(c.domElement);
      return c;
    },
    addUnhydrated(target, property, ...args) {
      rejectUnsupported(target, property, args[0]);
      const c = fakeController(gui, target, property, args, optionsReplaces);
      gui.controllers.push(c);
      childrenElement.appendChild(c.domElement);
      c.unhydrated = true;
      return c;
    },
    addFolder(title) {
      const folder = fakeGui(title, { optionsReplaces });
      gui.folders.push(folder);
      return folder;
    },
    // A display folder prefixes no deep-link key, so its controls answer to the
    // same names they would at the root.
    addDisplayFolder(title) {
      const folder = fakeGui(title, { optionsReplaces });
      folder.display = true;
      gui.folders.push(folder);
      return folder;
    },
    appendElement(element) { childrenElement.appendChild(element); },
    readStoredNumber(prop) {
      gui.storedReads.push(prop);
      const value = panel ? stored[prop] : gui.stored.get(prop);
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    },
    readStoredString(prop) {
      const value = panel ? stored[prop] : gui.stored.get(prop);
      return value == null ? undefined : String(value);
    },
    writeStoredValue(prop, value) {
      if (value == null || (typeof value === 'number' && !Number.isFinite(value))) {
        if (panel) delete stored[prop];
        else gui.stored.delete(prop);
      } else if (panel) stored[prop] = value;
      else gui.stored.set(prop, value);
      gui.storedWrites.push([prop, value]);
    },
    close() { return gui.open(false); },
    open(open = true) { gui.closed = !open; return gui; },
    destroy() {
      gui.destroyed += 1;
      if (gui.destroyThrows) throw gui.destroyThrows;
      for (const controller of gui.controllers) {
        if (controller.domElement.parentNode !== childrenElement)
          throw new Error(`controller ${controller.property} has the wrong parent`);
        childrenElement.removeChild(controller.domElement);
      }
    },
    collectUrlKeys(prefix = namespace) {
      const keys = gui.controllers.filter((controller) => !controller.session
        && typeof controller.object[controller.property] !== 'function').map(
        (controller) => [prefix, controller.property].filter(Boolean).join('.'));
      for (const folder of gui.folders)
        keys.push(...folder.collectUrlKeys([prefix, folder.display ? '' : folder.namespace].filter(Boolean).join('.')));
      return keys;
    },
  };
  gui.domElement.ownerDocument = childrenElement.ownerDocument;
  gui.domElement.appendChild(gui.titleElement);
  gui.domElement.appendChild(childrenElement);
  if (panel) {
    gui.addDisplayFolder = (name) => {
      const folder = { name, display: true, closed: false,
        open(open = true) { this.closed = !open; },
        close() { this.open(false); },
      };
      for (const method of ['add', 'addUnhydrated', 'addSession'])
        folder[method] = (...args) => {
          const control = gui[method](...args);
          if (control) control.folder = name;
          return control;
        };
      gui.folders.push(folder);
      return folder;
    };
    gui.addFolder = (name) => {
      const folder = gui.addDisplayFolder(name);
      folder.display = false;
      return folder;
    };
  }
  return gui;
}
