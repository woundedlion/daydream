//
// Builds daydream.js's composition root against injected seams (document, page
// target, navigator, driver, GUI factory, module loader), so a case can assert
// on the assembly the root actually produced rather than on its source text.
// Shared by tests/daydream_start.test.js and tests/daydream_boot.test.js.
import { fakeElement, installDocument } from './fake_dom.js';

// bootstrap.js starts the app on import when a document already exists, and
// daydream.js pulls it in for the failure overlay — so the module graph is
// loaded here, at import time, before any test installs one.
const { start } = await import('../daydream.js');

/**
 * A lil-gui controller as the root uses one: named, bound, and re-settable.
 * @param {Object} owner - The GUI the controller belongs to.
 * @param {Object} object - The value object the controller is bound to.
 * @param {string} property - The bound property name.
 * @param {Array<any>} args - Range/options arguments add() was called with.
 * @returns {Object} The controller double.
 */
function fakeController(owner, object, property, args = []) {
  const controller = {
    object,
    property,
    args,
    value: undefined,
    calls: [],
    name(text) { controller.label = text; return controller; },
    onChange(fn) { controller.changed = fn; return controller; },
    setValue(v) { controller.value = v; controller.changed?.(v); return controller; },
    // lil-gui destroys the receiver and returns a replacement, which is why the
    // root re-binds the resolution controller after narrowing its options.
    options(choices) {
      controller.destroyed = true;
      const replacement = fakeController(owner, object, property, [choices]);
      const at = owner.controllers.indexOf(controller);
      if (at >= 0) owner.controllers[at] = replacement;
      return replacement;
    },
    enable() { controller.enabled = true; return controller; },
    disable() { controller.enabled = false; return controller; },
    listen() { return controller; },
  };
  return controller;
}

/**
 * A lil-gui root or folder: records the controllers and folders built on it.
 * @param {string} namespace - Root namespace or folder title.
 * @returns {Object} The GUI double.
 */
export function fakeGui(namespace) {
  const gui = {
    namespace,
    domElement: fakeElement('div'),
    controllers: [],
    folders: [],
    destroyed: false,
    add(target, property, ...args) {
      const c = fakeController(gui, target, property, args);
      gui.controllers.push(c);
      return c;
    },
    // Session controls carry no deep link, so the two are told apart here.
    addSession(target, property, ...args) {
      const c = fakeController(gui, target, property, args);
      c.session = true;
      gui.controllers.push(c);
      return c;
    },
    addFolder(title) {
      const folder = fakeGui(title);
      gui.folders.push(folder);
      return folder;
    },
    close() { return gui; },
    open() { return gui; },
    destroy() { gui.destroyed = true; },
    collectUrlKeys() { return []; },
  };
  return gui;
}

/**
 * The Daydream driver as the root uses one.
 * @returns {Object} The driver double.
 */
export function fakeDriver() {
  return {
    isMobile: false,
    canvas: fakeElement('canvas'),
    frameInterval: 62.5,
    labelAxes: false,
    cullBackSphere: false,
    showPip: false,
    columnFillOverlap: 1,
    recorder: null,
    renderer: { setAnimationLoop(frame) { this.frame = frame; } },
    keys: [],
    invalidate() { this.invalidated = true; },
    keydown(e) { this.keys.push(e); },
    render() {},
    dispose() { this.disposed = true; },
  };
}

/**
 * Builds the app against fakes.
 * @param {{loadModule?: () => Promise<Object>, nav?: Object}} [options] - Seam overrides.
 * @returns {Object} The pieces a case asserts on.
 */
export function startApp({
  loadModule = () => new Promise(() => {}),
  nav = { hardwareConcurrency: 8 },
} = {}) {
  const ids = ['gui-container', 'effect-sidebar', 'apply-notice-dismiss',
    'apply-notice-body', 'apply-notice-text', 'canvas-container',
    'loading-overlay', 'apply-notice', 'segment-stats'];
  const elements = new Map(ids.map((id) => [id, fakeElement('div')]));
  const docListeners = [];
  const doc = installDocument({
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => fakeElement(tag),
    addEventListener: (type, handler) => docListeners.push([type, handler]),
    removeEventListener: (type, handler) => {
      const at = docListeners.findIndex(([t, h]) => t === type && h === handler);
      if (at >= 0) docListeners.splice(at, 1);
    },
    body: fakeElement('body'),
  });
  for (const element of elements.values()) element.ownerDocument = doc;
  const listeners = [];
  const win = {
    addEventListener: (type, handler) => listeners.push([type, handler]),
    removeEventListener: (type, handler) => {
      const at = listeners.findIndex(([t, h]) => t === type && h === handler);
      if (at >= 0) listeners.splice(at, 1);
    },
    location: { pathname: '/', search: '', hash: '' },
    history: { replaceState() {} },
  };
  // Browser globals the sidebar and URL sync reach for directly.
  globalThis.window = win;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  const driver = fakeDriver();
  const guis = [];
  const teardown = start({
    doc,
    win,
    nav,
    createDriver: () => driver,
    createGui: (options, namespace) => {
      const gui = fakeGui(namespace);
      guis.push(gui);
      return gui;
    },
    loadModule,
  });
  return { teardown, driver, guis, listeners, docListeners, elements, win };
}

/**
 * The segment-count slider of a started app.
 * @param {Object} app - A startApp() result.
 * @returns {Object} The 'segments' controller in the Segmented POV folder.
 */
export function segmentCountControl({ guis }) {
  return guis[0].folders
    .find((folder) => folder.namespace === 'Segmented POV').controllers
    .find((controller) => controller.property === 'segments');
}
