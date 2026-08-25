//
// Builds daydream.js's composition root against injected seams (document, page
// target, navigator, driver, GUI factory, module loader), so a case can assert
// on the assembly the root actually produced rather than on its source text.
// Shared by tests/daydream_start.test.js and tests/daydream_boot.test.js.
import { fakeElement, installDocument } from './fake_dom.js';

// bootstrap.js starts the app on import when a document already exists, and
// daydream.js pulls it in for the failure overlay — so the module graph is
// loaded here, at import time, before any test installs one.
const { start, createSegmentPoolSpawner, SHADER_DOCUMENT_EFFECTS } =
  await import('../daydream.js');

export { createSegmentPoolSpawner, SHADER_DOCUMENT_EFFECTS };

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
 * @returns {Object} The controller double.
 */
function fakeController(owner, object, property, args = []) {
  const controller = {
    object,
    property,
    args,
    value: undefined,
    calls: [],
    // The effect panel styles, labels and re-parents its rows through this.
    domElement: fakeElement('div'),
    name(text) { controller.label = text; return controller; },
    onChange(fn) { controller.changed = fn; return controller; },
    setValue(v) { controller.value = v; controller.changed?.(v); return controller; },
    // Two implementations, told apart the way lil-gui does: a controller add()
    // built from an options list is an OptionController, whose options() updates
    // its <select> in place and hands back the same controller; any other
    // controller is destroyed and a replacement carrying the copied name is
    // appended to the end of the panel. Pinned by tests/lil_gui_contract.test.js.
    options(choices) {
      if (isOptionList(controller.args[0])) {
        controller.args = [choices];
        return controller;
      }
      controller.destroyed = true;
      const replacement = fakeController(owner, object, property, [choices]);
      replacement.label = controller.label;
      const at = owner.controllers.indexOf(controller);
      if (at >= 0) owner.controllers.splice(at, 1);
      owner.controllers.push(replacement);
      return replacement;
    },
    enable() { controller.enabled = true; return controller; },
    disable() { controller.enabled = false; return controller; },
    listen() { return controller; },
  };
  return controller;
}

/**
 * A DeepLinkGUI (gui.js) root or folder: records the controllers, folders, and
 * stored values built on it.
 * @param {string} namespace - Root namespace or folder title.
 * @returns {Object} The GUI double.
 */
export function fakeGui(namespace) {
  const gui = {
    namespace,
    domElement: fakeElement('div'),
    controllers: [],
    folders: [],
    stored: new Map(),
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
    addMigrated(target, property, legacyProps, ...args) {
      const c = gui.add(target, property, ...args);
      c.legacyProps = legacyProps;
      return c;
    },
    addUnhydrated(target, property, ...args) {
      const c = gui.add(target, property, ...args);
      c.unhydrated = true;
      return c;
    },
    addFolder(title) {
      const folder = fakeGui(title);
      gui.folders.push(folder);
      return folder;
    },
    // A display folder prefixes no deep-link key, so its controls answer to the
    // same names they would at the root.
    addDisplayFolder(title) {
      const folder = fakeGui(title);
      folder.display = true;
      gui.folders.push(folder);
      return folder;
    },
    appendElement(element) { gui.domElement.appendChild(element); },
    readStoredNumber(prop) {
      const value = gui.stored.get(prop);
      return typeof value === 'number' ? value : undefined;
    },
    readStoredString(prop) {
      const value = gui.stored.get(prop);
      return value === undefined ? undefined : String(value);
    },
    writeStoredValue(prop, value) { gui.stored.set(prop, value); },
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
    pixels: null,
    dotMesh: { instanceColor: { array: null, needsUpdate: false } },
    renderer: { setAnimationLoop(frame) { this.frame = frame; } },
    keys: [],
    frames: 0,
    invalidate() { this.invalidated = true; },
    keydown(e) { this.keys.push(e); },
    setStrobeColumns(strobe) { this.strobe = strobe; },
    updateResolution(w, h, dotSize) { this.resolution = [w, h, dotSize]; },
    // The real driver's render() calls the adapter it is handed; a fake that
    // swallowed it would leave every per-frame wiring undriven.
    render(adapter) { this.frames += 1; adapter.drawFrame(); },
    dispose() { this.disposed = true; },
  };
}

/**
 * Builds the app against fakes.
 * @param {{loadModule?: () => Promise<Object>, nav?: Object,
 *   daydreamMode?: string, search?: string}} [options] - Seam overrides.
 *   daydreamMode stamps documentElement, the attribute start() reads to route
 *   the workbench page; search is the query string URLSync hydrates from and
 *   the redirect builds its target against.
 * @returns {Object} The pieces a case asserts on, plus the global restorer.
 */
export function startApp({
  loadModule = () => new Promise(() => {}),
  nav = { hardwareConcurrency: 8 },
  daydreamMode = undefined,
  search = '',
} = {}) {
  const savedGlobals = new Map([
    'document', 'window', 'ResizeObserver', 'requestAnimationFrame',
    'cancelAnimationFrame',
  ].map((key) => [key, globalThis[key]]));
  const ids = ['gui-container', 'effect-sidebar', 'apply-notice-dismiss',
    'apply-notice-body', 'apply-notice-text', 'canvas-container',
    'loading-overlay', 'apply-notice', 'segment-stats'];
  const elements = new Map(ids.map((id) => [id, fakeElement('div')]));
  const docListeners = [];
  // Every id the app asks the document for, in order, so a case can pin what the
  // wiring resolves instead of restating it.
  const queried = [];
  const doc = installDocument({
    getElementById: (id) => { queried.push(id); return elements.get(id) ?? null; },
    createElement: (tag) => fakeElement(tag),
    addEventListener: (type, handler) => docListeners.push([type, handler]),
    removeEventListener: (type, handler) => {
      const at = docListeners.findIndex(([t, h]) => t === type && h === handler);
      if (at >= 0) docListeners.splice(at, 1);
    },
    body: fakeElement('body'),
    documentElement: { dataset: daydreamMode ? { daydreamMode } : {} },
  });
  for (const element of elements.values()) element.ownerDocument = doc;
  const listeners = [];
  /** @type {string[]} Targets win.location.replace() was sent to. */
  const replaced = [];
  /** @type {string[]} URLs written through history.replaceState(). */
  const urlWrites = [];
  const win = {
    addEventListener: (type, handler) => listeners.push([type, handler]),
    removeEventListener: (type, handler) => {
      const at = listeners.findIndex(([t, h]) => t === type && h === handler);
      if (at >= 0) listeners.splice(at, 1);
    },
    location: {
      pathname: '/',
      search,
      hash: '',
      href: `http://localhost:8000/${search}`,
      replace: (url) => replaced.push(url),
    },
    history: { replaceState: (state, title, url) => urlWrites.push(url) },
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
  const restore = () => {
    for (const [key, value] of savedGlobals) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  };
  return {
    teardown, driver, guis, listeners, docListeners, elements, queried, win,
    replaced, urlWrites, restore,
  };
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
