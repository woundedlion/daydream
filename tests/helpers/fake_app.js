//
// Builds daydream.js's composition root against injected seams (document, page
// target, navigator, driver, GUI factory, module loader).
import { fakeElement, installDocument } from './fake_dom.js';
import { fakeColorAttribute } from './fake_three.js';
import { EffectSetResult, ParamSetResult, ResolutionSetResult } from './fake_engine.js';
import { Daydream } from '../../src/renderer/driver.js';

import { start } from '../../src/app/daydream.js';

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
    handler: null,
    handlers: [],
    value: undefined,
    calls: [],
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
      controller.handler = controller.changed;
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
    // As in lil-gui: an OptionController (add() given an options list) updates
    // its <select> in place and returns itself; any other controller is
    // destroyed and a replacement carrying the copied name is appended.
    options(choices) {
      if (!optionsReplaces && isOptionList(controller.args[0])) {
        controller.args = [choices];
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
    listen() { return controller; },
  };
  return controller;
}

const supportedProperty = (target, property, choices) =>
  Object(choices) === choices || ['number', 'boolean', 'string', 'function'].includes(typeof target[property]);

/**
 * @param {string} [namespace=''] - Root namespace.
 * @param {{optionsReplaces?: boolean}} [options={}] - Controller replacement behavior.
 * @returns {Object} Deep-link GUI double.
 */
export function fakeGui(namespace = '', { optionsReplaces = false } = {}) {
  if (typeof namespace !== 'string') throw new TypeError('GUI namespace must be a string');
  return buildGui(namespace, optionsReplaces, false, {}, {});
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
    controllers: [],
    folders: [],
    $children: childrenElement,
    stored: panel ? stored : new Map(),
    storedReads: [],
    storedWrites: [],
    destroyed: panel ? 0 : false,
    destroyThrows: null,
    closed: false,
    ctrl(property) { return this.controllers.find((c) => c.property === property); },
    add(target, property, ...args) {
      if (!supportedProperty(target, property, args[0])) throw new TypeError(`Unsupported GUI property: ${property}`);
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
      if (!supportedProperty(target, property, args[0])) throw new TypeError(`DeepLinkGUI: unsupported property "${property}"`);
      const c = fakeController(gui, target, property, args, optionsReplaces);
      c.session = true;
      gui.controllers.push(c);
      childrenElement.appendChild(c.domElement);
      return c;
    },
    addUnhydrated(target, property, ...args) {
      if (!supportedProperty(target, property, args[0])) throw new TypeError(`Unsupported GUI property: ${property}`);
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
      if (value == null) {
        if (panel) delete stored[prop];
        else gui.stored.delete(prop);
      } else if (panel) stored[prop] = value;
      else gui.stored.set(prop, value);
      gui.storedWrites.push([prop, value]);
    },
    close() { return gui.open(false); },
    open(open = true) { gui.closed = !open; return gui; },
    destroy() {
      gui.destroyed = panel ? gui.destroyed + 1 : true;
      if (gui.destroyThrows) throw gui.destroyThrows;
      for (const controller of gui.controllers) {
        if (controller.domElement.parentNode !== childrenElement)
          throw new Error(`controller ${controller.property} has the wrong parent`);
        childrenElement.removeChild(controller.domElement);
      }
    },
    collectUrlKeys(prefix = panel ? '' : namespace) {
      const keys = gui.controllers.filter((controller) => !controller.session
        && typeof controller.object[controller.property] !== 'function').map((controller) => {
        const folder = panel && gui.folders.find((candidate) => candidate.name === controller.folder);
        return [prefix, folder && !folder.display ? folder.name : '', controller.property].filter(Boolean).join('.');
      });
      if (!panel) for (const folder of gui.folders)
        keys.push(...folder.collectUrlKeys([prefix, folder.display ? '' : folder.namespace].filter(Boolean).join('.')));
      return keys;
    },
  };
  gui.domElement.ownerDocument = childrenElement.ownerDocument;
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

/**
 * The Daydream driver as the root uses one.
 * @returns {Object} The driver double.
 */
export function fakeDriver() {
  return {
    canvas: fakeElement('canvas'),
    frameInterval: 1 / Daydream.FPS,
    labelAxes: false,
    cullBackSphere: false,
    showPip: false,
    columnFillOverlap: 1,
    recorder: null,
    pixels: null,
    dotMesh: null,
    renderer: { setAnimationLoop(frame) { this.frame = frame; }, setScissorTest() {} },
    controls: { update() {} },
    win: { performance },
    xAxis: {}, yAxis: {}, zAxis: {},
    labelPool: { activeCount: 0 },
    renderMainView() {},
    refreshLabels() {},
    renderPip() {},
    updateCullUniforms() {},
    updateStats() {},
    stepSimulation: Daydream.prototype.stepSimulation,
    startFrameLoop(frame) { this.renderer.setAnimationLoop(frame); },
    keys: [],
    frames: 0,
    stepFrames: 0,
    heldCaptures: 0,
    needsRender: true,
    advanceFrameClock() { return true; },
    invalidate() { this.invalidated = true; this.needsRender = true; },
    stepOnce() { this.invalidate(); this.stepFrames = Math.max(1, this.stepFrames); },
    keydown(e) { this.keys.push(e); },
    setStrobeColumns(strobe) { this.strobe = strobe; },
    setDisplayGeometry(geometry) { Object.assign(this, geometry); },
    updateResolution(w, h, dotSize) {
      this.resolution = [w, h, dotSize];
      this.dotMesh = { instanceColor: fakeColorAttribute(null) };
    },
    render(adapter) {
      this.frames += 1;
      Daydream.prototype.render.call(this, adapter);
    },
    dispose() { this.disposed = true; },
  };
}

/**
 * A module the composition root can boot all the way through: enough engine
 * surface for the initial resolution apply, the effect panel and one rendered
 * frame, with the contract-pinned enums so identity comparison behaves as it
 * does against embind. The counters are what a case reads the constructions,
 * handle releases, Pole LOD replays and parameter writes off.
 * @param {{resolutions?: Array<Array<number>>, definitions?: Array<Object>,
 *   refusedWidth?: ?number, failingFrames?: number, trappingSizeQuery?: boolean}}
 *   [options] - The resolutions the engine reports it can build, the parameter
 *   definitions the effect panel is built from, a width setResolution rejects, a
 *   count of leading drawFrame calls that throw, and whether the sidebar size
 *   query trips a trap.
 * @returns {Object} The module double.
 */
export function fakeWasmModule({
  resolutions = [[288, 144], [96, 20]],
  definitions = [],
  refusedWidth = null,
  failingFrames = 0,
  trappingSizeQuery = false,
} = {}) {
  let framesToFail = failingFrames;
  const pixels = new Uint16Array(288 * 144 * 3);
  let activeWidth = 288;
  let activeHeight = 144;
  let built = 0;
  let deleted = 0;
  const poleLod = [];
  const caps = [];
  const params = [];
  const module = {
    DISPLAY_NORTH_PHI: 0,
    DISPLAY_SOUTH_PHI: Math.PI,
    HS_MODULE_DEAD: false,
    EffectSetResult,
    ParamSetResult,
    ResolutionSetResult,
    engines: () => built,
    deletes: () => deleted,
    poleLod,
    caps,
    params,
    HolosphereEngine: class {
      constructor() { built++; this.paused = false; module.engine = this; }
      static isLive() { return false; }
      static getSupportedResolutions() { return resolutions; }
      setResolution(w, h) {
        if (w === refusedWidth) return ResolutionSetResult.UNSUPPORTED;
        activeWidth = w;
        activeHeight = h;
        return ResolutionSetResult.RESIZED;
      }
      setEffect() { return EffectSetResult.INSTALLED; }
      setParameter(name, value) {
        params.push([name, value]);
        if (definitions.find((definition) => definition.name === name)?.animated) this.paused = true;
        return ParamSetResult.APPLIED;
      }
      setPoleLod(v) { poleLod.push(v); }
      setDisplayCaps(top, bottom) { caps.push([top, bottom]); return true; }
      getDisplayNorthPhi() { return (caps.at(-1)?.[0] ?? 0) * Math.PI / 100; }
      getDisplaySouthPhi() { return (1 - (caps.at(-1)?.[1] ?? 0) / 100) * Math.PI; }
      setAnimationsPaused(paused) { this.paused = paused; }
      getAnimationsPaused() { return this.paused; }
      getPresetCount() { return 0; }
      getPresetIndex() { return this.presetIndex ?? 0; }
      selectPreset(index) {
        if (index < 0 || index >= this.getPresetCount()) return false;
        this.presetIndex = index;
        this.paused = true;
        return true;
      }
      getParameterDefinitions() { return definitions.map((d) => ({ ...d })); }
      getParamValues() { return new Float32Array(0); }
      getParamGeneration() { return 1; }
      getEffectSizes() {
        // HS_CHECK raises the flag ahead of its trap, so it is already set when
        // the RuntimeError reaches the caller.
        if (trappingSizeQuery) {
          module.HS_MODULE_DEAD = true;
          throw new WebAssembly.RuntimeError('unreachable');
        }
        return {};
      }
      getEffectPresetCounts() { return {}; }
      getArenaMetrics() { return {}; }
      strobeColumns() { return false; }
      drawFrame() {
        if (framesToFail > 0) {
          framesToFail -= 1;
          throw new Error('engine drawFrame failed');
        }
      }
      getPixels() { return pixels.subarray(0, activeWidth * activeHeight * 3); }
      getBufferLength() { return activeWidth * activeHeight * 3; }
      delete() { deleted++; }
    },
  };
  return module;
}

/**
 * Builds the app against fakes.
 * @param {{loadModule?: () => Promise<Object>, nav?: Object,
 *   daydreamMode?: string, search?: string, optionsReplaces?: boolean}}
 *   [options] - Seam overrides. daydreamMode stamps documentElement, the
 *   attribute start() reads to route the workbench page; search is the query
 *   string URLSync hydrates from and the redirect builds its target against;
 *   optionsReplaces puts every controller on the destroy-and-replace side of
 *   options() (see fakeController).
 * @returns {Object} The pieces a case asserts on, plus the global restorer.
 */
export function startApp({
  loadModule = () => new Promise(() => {}),
  nav = { hardwareConcurrency: 8 },
  daydreamMode = undefined,
  search = '',
  optionsReplaces = false,
} = {}) {
  const savedGlobals = new Map([
    'document', 'window', 'ResizeObserver', 'requestAnimationFrame',
    'cancelAnimationFrame',
  ].map((key) => [key, globalThis[key]]));
  const ids = ['gui-container', 'effect-sidebar', 'apply-notice-dismiss',
    'apply-notice-body', 'apply-notice-text', 'canvas-container',
    'loading-overlay', 'apply-notice', 'segment-stats'];
  const elements = new Map(ids.map((id) => [id, fakeElement('div')]));
  const docTarget = fakeElement('document');
  const docListeners = docTarget.listeners;
  // Every id the app asks the document for, in order.
  const queried = [];
  const doc = installDocument({
    getElementById: (id) => { queried.push(id); return elements.get(id) ?? null; },
    createElement: (tag) => fakeElement(tag),
    addEventListener: docTarget.addEventListener.bind(docTarget),
    removeEventListener: docTarget.removeEventListener.bind(docTarget),
    body: fakeElement('body'),
    documentElement: { dataset: daydreamMode ? { daydreamMode } : {} },
  });
  for (const element of elements.values()) element.ownerDocument = doc;
  const windowTarget = fakeElement('window');
  const listeners = windowTarget.listeners;
  /** @type {string[]} Targets win.location.replace() was sent to. */
  const replaced = [];
  /** @type {string[]} URLs written through history.replaceState(). */
  const urlWrites = [];
  const win = {
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
    removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
    location: {
      pathname: '/',
      search,
      hash: '',
      href: `http://localhost:8000/${search}`,
      replace: (url) => replaced.push(url),
    },
    history: { replaceState: (state, title, url) => urlWrites.push(url) },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  // Browser globals the app reads directly.
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
      const gui = fakeGui(namespace, { optionsReplaces });
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
