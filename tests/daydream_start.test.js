//
// daydream.js's composition root, driven for real: start(deps) builds the whole
// app against injected seams (document, page target, navigator, driver, GUI
// factory, module loader), so the wiring is executed here rather than read out
// of the source. What each factory does with what it is handed is covered in
// tests/app_lifecycle.test.js; this is the assembly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

restoreDocumentAfterEach();

// bootstrap.js starts the app on import when a document already exists, and
// daydream.js pulls it in for the failure overlay — so the module graph is
// loaded once, before any test installs one.
const { start } = await import('../daydream.js');

/** A lil-gui controller as the root uses one: named, bound, and re-settable. */
function fakeController(property) {
  const controller = {
    property,
    value: undefined,
    calls: [],
    name(text) { controller.label = text; return controller; },
    onChange(fn) { controller.changed = fn; return controller; },
    setValue(v) { controller.value = v; controller.changed?.(v); return controller; },
    // lil-gui destroys the receiver and returns a replacement, which is why the
    // root re-binds the resolution controller after narrowing its options.
    options() { return fakeController(property); },
    enable() { controller.enabled = true; return controller; },
    disable() { controller.enabled = false; return controller; },
    listen() { return controller; },
  };
  return controller;
}

function fakeGui(namespace) {
  const gui = {
    namespace,
    domElement: fakeElement('div'),
    controllers: [],
    folders: [],
    destroyed: false,
    add(_target, property) {
      const c = fakeController(property);
      gui.controllers.push(c);
      return c;
    },
    addSession(_target, property) {
      const c = fakeController(property);
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

function fakeDriver() {
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
 * @param {{loadModule?: () => Promise<Object>}} [options] - Seam overrides.
 * @returns {Object} The pieces a case asserts on.
 */
function startApp({ loadModule = () => new Promise(() => {}) } = {}) {
  const ids = ['gui-container', 'effect-sidebar', 'apply-notice-dismiss',
    'canvas-container', 'loading-overlay', 'apply-notice', 'segment-stats'];
  const elements = new Map(ids.map((id) => [id, fakeElement('div')]));
  const doc = installDocument({
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => fakeElement(tag),
    addEventListener() {},
    removeEventListener() {},
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
    nav: { hardwareConcurrency: 8 },
    createDriver: () => driver,
    createGui: (_options, namespace) => {
      const gui = fakeGui(namespace);
      guis.push(gui);
      return gui;
    },
    loadModule,
  });
  return { teardown, driver, guis, listeners, elements, win };
}

test('start assembles the app and hands back its teardown', () => {
  const { teardown, guis, listeners } = startApp();

  assert.equal(typeof teardown.dispose, 'function');
  assert.equal(teardown.disposed(), false);
  assert.equal(guis[0].namespace, 'view',
    "the global GUI root must keep the 'view' namespace its deep links are built from");
  assert.deepEqual(listeners.map(([type]) => type),
    ['keydown', 'error', 'unhandledrejection', 'pagehide']);
});

test('the global GUI carries the controls a deep link names', () => {
  const { guis } = startApp();
  const root = guis[0];

  assert.deepEqual(root.controllers.map((c) => c.property),
    ['resolution', 'testAll', 'labelAxes', 'cullBackSphere', 'showPip',
      'columnFillOverlap', 'poleLod']);
  const segments = root.folders.find((f) => f.namespace === 'Segmented POV');
  assert.ok(segments, 'the segmented folder name is a deep-link key segment');
  assert.deepEqual(segments.controllers.map((c) => c.property),
    ['segmented', 'segments', 'boundaries']);
  const recording = root.folders.find((f) => f.namespace === 'Recording');
  assert.deepEqual(recording.controllers.map((c) => c.property),
    ['recQuality', 'recResolution', 'recFormat', 'record']);
});

test('the segment-count control is bounded by the device cap', () => {
  const { guis } = startApp();
  const segments = guis[0].folders.find((f) => f.namespace === 'Segmented POV');
  const count = segments.controllers.find((c) => c.property === 'segments');

  assert.match(count.label, /^Segments/,
    'the label carries the marker for the count no hardware produces');
});

test('the record button is offered only once an engine exists', () => {
  const { guis } = startApp();
  const record = guis[0].folders
    .find((f) => f.namespace === 'Recording').controllers
    .find((c) => c.property === 'record');

  assert.equal(record.enabled, false,
    'recording needs the recorder the module-ready path builds');
});

test('a keydown on the page target reaches the driver', () => {
  const { driver, listeners } = startApp();
  const [, onKeyDown] = listeners.find(([type]) => type === 'keydown');

  onKeyDown({ key: ' ', target: {}, preventDefault() {} });
  assert.equal(driver.keys.length, 1, 'the global handler must dispatch to the driver');
});

test('the teardown releases the page listeners and the GUI it built', () => {
  const { teardown, driver, guis, listeners } = startApp();

  teardown.dispose();
  assert.equal(teardown.disposed(), true);
  assert.deepEqual(listeners, [], 'every page listener must be removed');
  assert.equal(guis[0].destroyed, true, 'the global GUI must be destroyed');
  assert.equal(driver.disposed, true, 'the driver owns GPU buffers');
});

test('a failed engine load reports and disarms the Test All ticker', async () => {
  const { guis, elements } = startApp({
    loadModule: () => Promise.reject(new Error('no wasm')),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const testAll = guis[0].controllers.find((c) => c.property === 'testAll');
  assert.equal(testAll.enabled, false,
    'without an engine the ticker would spin for the page lifetime');
  assert.ok(elements.get('loading-overlay').classList.contains('error'),
    'the failure must reach the overlay, not only the console');
});
