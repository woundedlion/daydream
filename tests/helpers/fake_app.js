// Builds daydream.js's composition root against injected seams (document, page
// target, navigator, driver, GUI factory, module loader).
import { afterEach } from 'node:test';
import { fakeElement, installDocument, stashGlobals } from './fake_dom.js';
import { fakeColorAttribute } from './fake_three.js';
import { EffectSetResult, ParamSetResult, ResolutionSetResult } from './fake_engine.js';
import { Daydream } from '../../src/renderer/driver.js';

import { start } from '../../src/app/daydream.js';

import {fakeGui} from './fake_gui.js';

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
    paused: false,
    povFidelity: false,
    povResponseScale: 1,
    showSweepBoundary: false,
    noBlackColumns: false,
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
    resetPovOnNextFrame: Daydream.prototype.resetPovOnNextFrame,
    keydown(e) { this.keys.push(e); },
    setStrobeColumns: Daydream.prototype.setStrobeColumns,
    setDisplayGeometry(geometry) { Object.assign(this, geometry); },
    updateResolution(w, h, dotSize) {
      this.resolution = [w, h, dotSize];
      this.dotMesh = { instanceColor: fakeColorAttribute(null) };
    },
    render(adapter) {
      this.frames += 1;
      Daydream.prototype.render.call(this, adapter);
    },
    dispose() { this.disposed = true; this.recorder = null; },
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
      setTemporalSampling(enabled) { this.temporalSampling = enabled; }
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
      getParameterAdvisories() { return []; }
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
 *   daydreamMode?: string, search?: string, optionsReplaces?: boolean, hydratedView?: Object,
 *   documentIds?: string[]}}
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
  hydratedView = {},
  documentIds = [],
} = {}) {
  const restore = stashGlobals('document', 'window', 'ResizeObserver',
    'requestAnimationFrame', 'cancelAnimationFrame');
  const ids = ['gui-container', 'effect-sidebar', 'apply-notice-dismiss',
    'apply-notice-body', 'apply-notice-text', 'canvas-container', 'canvas',
    'loading-overlay', 'apply-notice', 'segment-stats', ...documentIds];
  const elements = new Map(ids.map((id) => [id, fakeElement(id === 'canvas' ? 'canvas'
    : id.endsWith('-select') ? 'select' : 'div', {connected: true})]));
  elements.get('canvas').setAttribute('tabindex', '0');
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
      const gui = fakeGui(namespace, {
        optionsReplaces, hydrated: namespace === 'view' ? hydratedView : {},
      });
      guis.push(gui);
      return gui;
    },
    loadModule,
  });
  return {
    teardown, driver, guis, listeners, docListeners, elements, queried, win,
    replaced, urlWrites, restore,
  };
}

/**
 * Registers an afterEach that disposes every app started through the returned
 * function and restores the globals each start replaced, newest first.
 * @returns {(options?: Object) => Object} startApp(), tracked for cleanup.
 */
export function trackedStartApp() {
  const started = [];
  afterEach(() => {
    while (started.length > 0) {
      const app = started.pop();
      app.teardown.dispose();
      app.restore();
    }
  });
  return (options) => {
    const app = startApp(options);
    started.push(app);
    return app;
  };
}

/**
 * @param {Object} app - A startApp() result.
 * @returns {string} The text the shared notice element is showing.
 */
export function noticeText(app) {
  return app.elements.get('apply-notice-text').textContent;
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
