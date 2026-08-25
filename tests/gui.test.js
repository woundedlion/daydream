//
// gui.js — DeepLinkGUI URL hydration (dropdown, slider, checkbox), per-root key
// namespacing, and the debounced URL writer, against a stubbed lil-gui.
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { URL } from 'node:url';
import {
  AppState,
  URLSync,
  URL_FLUSH_DEBOUNCE_MS,
  getActiveURLSync,
} from '../state.js';
import { engineParamValue } from '../param_sync.js';
import {
  snapshotEffectControlState,
  restoreEffectControlState,
} from '../effect_sequencing.js';
import { fakeElement } from './fake_dom.js';

// Restore globalThis.window after each test so the stub never leaks to another suite.
const savedWindow = globalThis.window;
// Roots created by a test; destroy() cancels the 200ms URL-write debounce so no
// timer survives the teardown that drops the window stub.
const liveRoots = [];
afterEach(() => {
  while (liveRoots.length) liveRoots.pop().destroy();
  getActiveURLSync()?.dispose();
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
});

// Minimal lil-gui stub exposing the chaining surface DeepLinkGUI relies on.
class StubController {
  /**
   * Binds the controller to a target object property.
   * @param {Object} object - The object whose property this controller edits.
   * @param {string} prop - The property name bound by this controller.
   */
  constructor(object, prop) { this.object = object; this.prop = prop; this.on = null; }
  /**
   * Registers the change callback, mirroring lil-gui's chaining API.
   * @param {Function} fn - Handler invoked with the new value on setValue.
   * @returns {StubController} This controller, for chaining.
   */
  onChange(fn) { this.on = fn; return this; }
  /**
   * Reads the current bound value.
   * @returns {*} The current value of the bound property.
   */
  getValue() { return this.object[this.prop]; }
  /**
   * Writes the bound value and fires the registered onChange handler. Writing
   * the value already bound is a no-op, as in lil-gui.
   * @param {*} v - The new value to assign to the bound property.
   * @returns {StubController} This controller, for chaining.
   */
  setValue(v) {
    if (this.getValue() === v) return this;
    this.object[this.prop] = v;
    if (this.on) this.on(v);
    return this;
  }
  /**
   * No-op display refresh that preserves the chaining surface.
   * @returns {StubController} This controller, for chaining.
   */
  updateDisplay() { return this; }
  /**
   * No-op label setter that preserves the chaining surface.
   * @returns {StubController} This controller, for chaining.
   */
  name() { return this; }
}
// Minimal lil-gui root stub handing back StubControllers and nested folders.
class StubGUI {
  /**
   * Creates the root stub over DOM doubles, so the panel element and the
   * controller container enforce Node-ness on insertion as the real ones do.
   */
  constructor() {
    this.domElement = fakeElement('div');
    this._closed = false;
    this.$children = fakeElement('div');
    this.destroyed = false;
  }
  /**
   * Creates a controller bound to a target property.
   * @param {Object} object - The object whose property the controller edits.
   * @param {string} prop - The property name to bind.
   * @returns {StubController} A controller bound to (object, prop).
   */
  add(object, prop) { return new StubController(object, prop); }
  /**
   * Creates a color controller bound to a target property.
   * @param {Object} object - The object whose property the controller edits.
   * @param {string} prop - The property name to bind.
   * @returns {StubController} A controller bound to (object, prop).
   */
  addColor(object, prop) { return new StubController(object, prop); }
  /**
   * Creates a nested folder.
   * @returns {StubGUI} A fresh nested GUI stub.
   */
  addFolder() { return new StubGUI(); }
  /** @param {boolean} [open=true] Whether the panel is expanded. */
  open(open = true) { this._closed = !open; }
  /** @returns {void} Closes the panel. */
  close() { this._closed = true; }
  /**
   * Records that the wrapper tore this panel down.
   * @returns {void}
   */
  destroy() { this.destroyed = true; }
}

mock.module('lil-gui', { namedExports: { GUI: StubGUI } });

const { GUI: BaseGUI, makeUrlParamWriter, resetGUI } = await import('../gui.js');

// GUI root that registers itself for teardown in afterEach.
class DeepLinkGUI extends BaseGUI {
  /**
   * @param {...*} args - Forwarded to the wrapped GUI constructor.
   */
  constructor(...args) {
    super(...args);
    liveRoots.push(this);
  }
}

test('DeepLinkGUI appends custom content to the wrapped controller container', () => {
  installWindow('');
  const gui = new DeepLinkGUI({ autoPlace: false });
  const element = fakeElement('div');

  gui.appendElement(element);

  assert.deepEqual(gui.gui.$children.children, [element]);
  assert.throws(() => gui.appendElement('text'), TypeError,
    'the container takes a node, not a stand-in for one');
});

test('DeepLinkGUI exposes and changes the wrapped panel state', () => {
  installWindow('');
  const gui = new DeepLinkGUI({ autoPlace: false });

  assert.equal(gui.closed, false);
  gui.close();
  assert.equal(gui.closed, true);
  gui.open();
  assert.equal(gui.closed, false);
  gui.open(false);
  assert.equal(gui.closed, true);
});

/**
 * Installs a minimal global window so gui.js can read location.search and call
 * history.replaceState during the test.
 * @param {string} search - The raw query string, including the leading '?' (e.g. '?resolution=X').
 */
function installWindow(search) {
  globalThis.window = {
    location: { search, pathname: '/', hash: '' },
    history: { replaceState() {} },
  };
}

const RES = ['Holosphere (96x20)', 'Phantasm (288x144)'];

/**
 * Runs `body` with console.warn captured so a rejection path's diagnostic is
 * asserted instead of printed into the suite output.
 * @param {Function} body - Code to run under the capture.
 * @returns {Array<string>} One joined message per console.warn call.
 */
function captureWarnings(body) {
  const warnings = [];
  const stub = mock.method(console, 'warn',
    (...args) => { warnings.push(args.map(String).join(' ')); });
  try { body(); } finally { stub.mock.restore(); }
  return warnings;
}

test('rollback restores an unflushed control value to runtime sinks and URL', () => {
  let lastUrl = '/?Speed=0.1';
  globalThis.window = {
    location: { search: '?Speed=0.1', pathname: '/', hash: '' },
    history: {
      replaceState(state, title, url) {
        lastUrl = url;
        globalThis.window.location.search = new URL(url, 'http://x').search;
      },
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  new URLSync(new AppState({ effect: 'Old' }), ['effect']);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const makeEffect = () => {
      const model = { Speed: 0 };
      const runtime = { engine: 0, workers: 0 };
      const controller = new DeepLinkGUI({ autoPlace: false })
        .add(model, 'Speed', 0, 1)
        .onChange((value) => {
          runtime.engine = value;
          runtime.workers = value;
        });
      return {
        model,
        runtime,
        effect: {
          controllerByName: new Map([['Speed', controller]]),
          writableParamNames: ['Speed'],
          pause: { animationState: { pause: false }, controller: null },
        },
      };
    };

    const previous = makeEffect();
    previous.effect.controllerByName.get('Speed').setValue(0.75);
    const snapshot = snapshotEffectControlState(previous.effect);
    assert.equal(new URL(lastUrl, 'http://x').searchParams.get('Speed'), '0.1');

    const rebuilt = makeEffect();
    restoreEffectControlState(rebuilt.effect, snapshot);
    mock.timers.tick(200);

    assert.equal(rebuilt.model.Speed, 0.75);
    assert.deepEqual(rebuilt.runtime, { engine: 0.75, workers: 0.75 });
    assert.equal(new URL(lastUrl, 'http://x').searchParams.get('Speed'), '0.75');
  } finally {
    mock.timers.reset();
  }
});

/**
 * Verifies a garbage ?resolution= does not survive DeepLinkGUI hydration. add()
 * re-reads the raw URL; an out-of-list value would re-inject an invalid
 * resolution into appState (where applyResolution() silently no-ops, leaving a
 * black canvas), so the value is rejected against the option list. Because the
 * value was rejected, the bound default is left in place and the applyOnLoad
 * replay does NOT fire — replaying would push the default back through onChange,
 * spuriously re-persisting it to the URL.
 */
test('DeepLinkGUI.add ignores an out-of-list URL value for a dropdown', () => {
  installWindow('?resolution=GARBAGE');
  // Rejecting the value rewrites the URL through the 200ms debounce; drive it
  // under mock timers so the pending write can't fire after afterEach drops window.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const obj = { resolution: 'Phantasm (288x144)' };
    const replayed = [];
    const warnings = captureWarnings(() => {
      const gui = new DeepLinkGUI({ autoPlace: false });
      gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));
    });

    assert.equal(obj.resolution, 'Phantasm (288x144)');
    assert.deepEqual(replayed, []);
    assert.equal(warnings.length, 1, 'the rejection is reported exactly once');
    assert.match(warnings[0], /ignoring out-of-range URL value "GARBAGE" for "resolution"/);
  } finally {
    mock.timers.reset();
  }
});

/**
 * Verifies a URL value that is in the option list is adopted and replayed
 * through onChange.
 */
test('DeepLinkGUI.add adopts a valid in-list URL value for a dropdown', () => {
  installWindow('?resolution=' + encodeURIComponent('Holosphere (96x20)'));
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { resolution: 'Phantasm (288x144)' };
  const replayed = [];
  gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));

  assert.equal(obj.resolution, 'Holosphere (96x20)');
  assert.deepEqual(replayed, ['Holosphere (96x20)']);
});

/**
 * Verifies a slider-style add() (a numeric min, not an option list) has no
 * option list, so the URL value is adopted unconditionally — list validation
 * applies only to dropdowns.
 */
test('DeepLinkGUI.add leaves a non-enumerated control (no option list) untouched', () => {
  installWindow('?speed=2.5');
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { speed: 1.0 };
  gui.add(obj, 'speed', 0, 10);
  assert.equal(obj.speed, 2.5);
});

/**
 * Verifies that when no URL param matches the control, the bound default value
 * is kept and no applyOnLoad replay fires.
 */
test('DeepLinkGUI.add with no matching URL param keeps the default', () => {
  installWindow('?other=x');
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { resolution: 'Phantasm (288x144)' };
  const replayed = [];
  gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));
  assert.equal(obj.resolution, 'Phantasm (288x144)');
  assert.deepEqual(replayed, []);
});

/**
 * Verifies the numeric (slider) path clamps an out-of-range URL value to the
 * control's registered min/max — the add(obj, prop, min, max) bounds. A deep
 * link past the slider range must land at the boundary, not drive the engine
 * out of range, the clamped value replays through onChange, and the corrected
 * value is written back to the URL so the stale out-of-range one is replaced.
 */
test('DeepLinkGUI.add clamps an out-of-range numeric URL value to the slider min/max', () => {
  let lastUrl = '/';
  globalThis.window = {
    location: { search: '?speed=99', pathname: '/', hash: '' },
    history: { replaceState(s, t, url) { lastUrl = url; } },
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const guiHi = new DeepLinkGUI({ autoPlace: false });
    const objHi = { speed: 1.0 };
    const hi = [];
    guiHi.add(objHi, 'speed', 0, 10).onChange((v) => hi.push(v));
    assert.equal(objHi.speed, 10, 'value above max clamps to max');
    assert.deepEqual(hi, [10], 'the clamped value replays through onChange');
    mock.timers.tick(200);
    assert.equal(new URL(lastUrl, 'http://x').searchParams.get('speed'), '10',
      'the clamped value replaces the out-of-range one in the URL');

    globalThis.window.location.search = '?speed=-5';
    lastUrl = '/';
    const guiLo = new DeepLinkGUI({ autoPlace: false });
    const objLo = { speed: 1.0 };
    const lo = [];
    guiLo.add(objLo, 'speed', 0, 10).onChange((v) => lo.push(v));
    assert.equal(objLo.speed, 0, 'value below min clamps to min');
    assert.deepEqual(lo, [0]);
    mock.timers.tick(200);
    assert.equal(new URL(lastUrl, 'http://x').searchParams.get('speed'), '0',
      'the clamped low value replaces the out-of-range one in the URL');
  } finally {
    mock.timers.reset();
  }
});

/**
 * The URL path bypasses lil-gui's own step snapping, so a numeric add() carrying
 * a step snaps the deep-linked value onto the step grid and rewrites the stale
 * off-grid one. A value already on the grid is left alone: the snap multiply's
 * float noise (0.3 → 0.30000000000000004) is inside the step tolerance, so it
 * must not read as a correction and re-persist the value.
 */
test('DeepLinkGUI.add snaps a numeric URL value to the control step', () => {
  const offGrid = installRecordingWindow('?speed=2.7');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const obj = { speed: 1 };
    const replayed = [];
    new DeepLinkGUI({ autoPlace: false })
      .add(obj, 'speed', 0, 10, 0.5)
      .onChange((v) => replayed.push(v));
    assert.equal(obj.speed, 2.5, 'the URL value snaps to a step multiple');
    assert.deepEqual(replayed, [2.5], 'the snapped value replays through onChange');
    mock.timers.tick(200);
    assert.equal(new URL(offGrid.written(), 'http://x').searchParams.get('speed'), '2.5',
      'the snapped value replaces the off-grid one in the URL');

    const onGrid = installRecordingWindow('?speed=0.3');
    const gridObj = { speed: 1 };
    new DeepLinkGUI({ autoPlace: false }).add(gridObj, 'speed', 0, 1, 0.1);
    assert.ok(Math.abs(gridObj.speed - 0.3) < 1e-9, 'an on-grid value survives the snap');
    mock.timers.tick(200);
    assert.equal(onGrid.written(), '/', 'an on-grid value triggers no URL rewrite');
  } finally {
    mock.timers.reset();
  }
});

/**
 * lil-gui keeps a single onChange slot, so DeepLinkGUI fans caller handlers out:
 * a second registration composes with the first instead of clobbering it, and
 * the URL writer still runs behind both.
 */
test('DeepLinkGUI.add fans a change out to every registered onChange handler', () => {
  const url = installRecordingWindow('');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const first = [];
    const second = [];
    const controller = new DeepLinkGUI({ autoPlace: false }).add({ speed: 1 }, 'speed', 0, 10);
    controller.onChange((v) => first.push(v));
    controller.onChange((v) => second.push(v));
    controller.setValue(5);
    mock.timers.tick(200);

    assert.deepEqual(first, [5], 'the first-registered handler still fires');
    assert.deepEqual(second, [5], 'the second-registered handler fires too');
    assert.equal(new URL(url.written(), 'http://x').searchParams.get('speed'), '5',
      'the URL writer survives behind the fan-out');
  } finally {
    mock.timers.reset();
  }
});

test('DeepLinkGUI persists the accepted value after handler fanout', () => {
  const url = installRecordingWindow('');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const first = [];
    const second = [];
    let accepted = 0;
    const controller = new DeepLinkGUI({ autoPlace: false }, 'fx')
      .add({ Mode: 0 }, 'Mode', { Off: 0, On: 1, Invalid: 2 });
    controller.onChange((value) => {
      first.push(value);
      if (value !== 2) accepted = value;
      controller.acceptUrlValue(accepted);
    });
    controller.onChange((value) => second.push(value));

    controller.setValue(1);
    controller.setValue(2);
    mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);

    assert.deepEqual(first, [1, 2]);
    assert.deepEqual(second, [1, 2]);
    assert.equal(controller.getValue(), 2, 'the refused request remains visible');
    assert.equal(new URL(url.written(), 'http://x').searchParams.get('fx.Mode'), '1');
  } finally {
    mock.timers.reset();
  }
});

test('a refused hydrated value is corrected before the next reload', () => {
  const url = installRecordingWindow('?fx.Mode=2');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const controller = new DeepLinkGUI({ autoPlace: false }, 'fx')
      .add({ Mode: 0 }, 'Mode', { Off: 0, On: 1, Invalid: 2 });
    controller.onChange((value) => {
      assert.equal(value, 2);
      controller.acceptUrlValue(1);
    });
    mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);

    const corrected = new URL(url.written(), 'http://x');
    assert.equal(corrected.searchParams.get('fx.Mode'), '1');
    installWindow(corrected.search);
    const reloaded = { Mode: 0 };
    new DeepLinkGUI({ autoPlace: false }, 'fx')
      .add(reloaded, 'Mode', { Off: 0, On: 1, Invalid: 2 });
    assert.equal(reloaded.Mode, 1);
  } finally {
    mock.timers.reset();
  }
});

/**
 * addSession is the deep-link opt-out: a session control is neither seeded from
 * the URL nor written back, so a copied link cannot auto-activate a cycler or a
 * recording toggle.
 */
test('DeepLinkGUI.addSession keeps a session control out of the URL', () => {
  const url = installRecordingWindow('?Cycle=on');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gui = new DeepLinkGUI({ autoPlace: false });
    const obj = { Cycle: false, Record: false };
    gui.addSession(obj, 'Cycle');
    gui.addSession(obj, 'Record').setValue(true);
    mock.timers.tick(200);

    assert.equal(obj.Cycle, false, 'a session control is not seeded from the URL');
    assert.deepEqual(gui.collectUrlKeys(), [], 'no session key is deep-linked');
    assert.equal(url.written(), '/', 'a session change writes no URL param');
  } finally {
    mock.timers.reset();
  }
});

/**
 * Verifies a non-numeric URL value for a numeric control (e.g. ?speed=fast →
 * NaN) is rejected: the bound default is kept and no applyOnLoad replay fires, so
 * a malformed deep link never reaches the engine as NaN.
 */
test('DeepLinkGUI.add rejects a non-numeric URL value for a slider', () => {
  installWindow('?speed=fast');
  // Rejecting the value strips it from the URL through the 200ms debounce; drive
  // it under mock timers so the pending write can't fire after afterEach drops window.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const obj = { speed: 1.0 };
    const replayed = [];
    const warnings = captureWarnings(() => {
      const gui = new DeepLinkGUI({ autoPlace: false });
      gui.add(obj, 'speed', 0, 10).onChange((v) => replayed.push(v));
    });
    assert.equal(obj.speed, 1.0, 'NaN URL value falls back to the bound default');
    assert.deepEqual(replayed, []);
    assert.equal(warnings.length, 1, 'the rejection is reported exactly once');
    assert.match(warnings[0], /ignoring non-numeric URL value "fast" for "speed"/);
  } finally {
    mock.timers.reset();
  }
});

/**
 * Verifies the boolean (checkbox) path adopts the common truthy/falsy spellings
 * a hand-edited or shared deep link can carry (on/1/yes/true, off/0/no/false),
 * adopting and replaying each, while an unrecognized token keeps the default and
 * does not replay.
 */
test('DeepLinkGUI.add maps boolean URL spellings for a checkbox', () => {
  // The unrecognized-token case strips the param from the URL through the 200ms
  // debounce; drive all writes under mock timers so none fire after afterEach.
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const warnings = captureWarnings(() => {
      for (const truthy of ['true', '1', 'yes', 'on']) {
        installWindow(`?glow=${truthy}`);
        const gui = new DeepLinkGUI({ autoPlace: false });
        const obj = { glow: false };
        const replayed = [];
        gui.add(obj, 'glow').onChange((v) => replayed.push(v));
        assert.equal(obj.glow, true, `"${truthy}" adopted as true`);
        assert.deepEqual(replayed, [true]);
      }
      for (const falsy of ['false', '0', 'no', 'off']) {
        installWindow(`?glow=${falsy}`);
        const gui = new DeepLinkGUI({ autoPlace: false });
        const obj = { glow: true };
        const replayed = [];
        gui.add(obj, 'glow').onChange((v) => replayed.push(v));
        assert.equal(obj.glow, false, `"${falsy}" adopted as false`);
        assert.deepEqual(replayed, [false]);
      }
      installWindow('?glow=maybe');
      const gui = new DeepLinkGUI({ autoPlace: false });
      const obj = { glow: false };
      const replayed = [];
      gui.add(obj, 'glow').onChange((v) => replayed.push(v));
      assert.equal(obj.glow, false, 'unrecognized boolean keeps the default');
      assert.deepEqual(replayed, []);
    });
    assert.equal(warnings.length, 1, 'only the unrecognized token warns');
    assert.match(warnings[0], /ignoring unrecognized boolean URL value "maybe" for "glow"/);
  } finally {
    mock.timers.reset();
  }
});

/**
 * Pins the deep-link path an effect GUI relies on: addParamControllers() adds a
 * control and only then registers the onChange that writes the engine, so the
 * URL value reaches the engine solely through the load-time replay. Mirrors that
 * wiring — 'fx' root, add() then onChange() — for a slider and a checkbox.
 */
test('a ?param=value deep link reaches the engine through the replayed handler', () => {
  installWindow('?fx.Speed=0.7&fx.Glow=on');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gui = new DeepLinkGUI({ autoPlace: false }, 'fx');
    const state = { Speed: 0.2, Glow: false };
    const engine = {};
    for (const [name, args] of [['Speed', [0, 1]], ['Glow', []]]) {
      gui.add(state, name, ...args)
        .onChange((v) => { engine[name] = engineParamValue(v); });
    }

    assert.deepEqual(engine, { Speed: 0.7, Glow: 1.0 });
  } finally {
    mock.timers.reset();
  }
});

/**
 * Verifies a root namespace prefixes every deep-link key in that root's subtree,
 * so two independent GUI roots binding the same property name address different
 * URL params instead of clobbering one another.
 */
test('DeepLinkGUI namespaces deep-link keys per root', () => {
  installWindow('?fx.pause=true&view.pause=false');
  const fx = new DeepLinkGUI({ autoPlace: false }, 'fx');
  const view = new DeepLinkGUI({ autoPlace: false }, 'view');
  const fxObj = { pause: false };
  const viewObj = { pause: true };
  fx.add(fxObj, 'pause');
  view.add(viewObj, 'pause');

  assert.equal(fxObj.pause, true);
  assert.equal(viewObj.pause, false);
  assert.deepEqual(fx.collectUrlKeys(), ['fx.pause']);
  assert.deepEqual(view.collectUrlKeys(), ['view.pause']);

  const folder = fx.addFolder('Shape');
  folder.add({ sides: 3 }, 'sides', 0, 10);
  assert.deepEqual(folder.collectUrlKeys(), ['fx.Shape.sides']);
});

test('display folders do not change descendant deep-link keys', () => {
  installWindow('?fx.Speed=4');
  const gui = new DeepLinkGUI({ autoPlace: false }, 'fx');
  const folder = gui.addDisplayFolder('Function');
  const state = { Speed: 1 };

  folder.add(state, 'Speed', 0, 10);

  assert.equal(state.Speed, 4);
  assert.deepEqual(folder.collectUrlKeys(), ['fx.Speed']);
});

test('addMigrated rewrites a legacy deep-link key without changing its value', () => {
  const url = installRecordingWindow('?fx.Outer+Warp=2&keep=1');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gui = new DeepLinkGUI({ autoPlace: false }, 'fx');
    const folder = gui.addDisplayFolder('Planar Warp 1');
    const state = { 'Planar Warp 1': 0 };

    folder.addMigrated(state, 'Planar Warp 1', ['Outer Warp'],
      { None: 0, Mirror: 1, Curl: 2 });
    mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);

    const params = new URL(url.written(), 'http://x').searchParams;
    assert.equal(state['Planar Warp 1'], 2);
    assert.equal(params.get('fx.Planar Warp 1'), '2');
    assert.equal(params.has('fx.Outer Warp'), false);
    assert.equal(params.get('keep'), '1');
  } finally {
    mock.timers.reset();
  }
});

test('readStoredNumber migrates a legacy companion key', () => {
  const url = installRecordingWindow('?fx.__accepted.Outer+Warp=6');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gui = new DeepLinkGUI({ autoPlace: false }, 'fx');
    const value = gui.readStoredNumber('__accepted.Planar Warp 1',
      ['__accepted.Outer Warp']);
    mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);

    const params = new URL(url.written(), 'http://x').searchParams;
    assert.equal(value, 6);
    assert.equal(params.get('fx.__accepted.Planar Warp 1'), '6');
    assert.equal(params.has('fx.__accepted.Outer Warp'), false);
  } finally {
    mock.timers.reset();
  }
});

test('readStoredString returns an opaque namespaced companion value', () => {
  const snapshot = '{"schemaVersion":2,"accepted":[4294967295]}';
  installWindow(`?fx.__fullConfig=${encodeURIComponent(snapshot)}`);
  const gui = new DeepLinkGUI({ autoPlace: false }, 'fx');

  assert.equal(gui.readStoredString('__fullConfig'), snapshot);
  assert.deepEqual(gui.collectUrlKeys(), ['fx.__fullConfig']);
});

test('addUnhydrated keeps the current value but still deep-links later edits', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const url = installRecordingWindow('?fx.Speed=9');
  try {
    const state = { Speed: 2 };
    const gui = new DeepLinkGUI({ autoPlace: false }, 'fx');
    const controller = gui.addUnhydrated(state, 'Speed', 0, 10);

    assert.equal(state.Speed, 2);
    controller.setValue(4);
    mock.timers.tick(URL_FLUSH_DEBOUNCE_MS);
    assert.equal(new URL(url.written(), 'http://x').searchParams.get('fx.Speed'), '4');
  } finally {
    mock.timers.reset();
  }
});

/**
 * A folder's key prefix is fixed when the folder is created, so controls added
 * before and after a later same-name sibling appears share one scheme instead of
 * splitting the folder's deep links across two key spellings.
 */
test('DeepLinkGUI keeps a folder key prefix stable across a later same-name sibling', () => {
  installWindow('');
  const root = new DeepLinkGUI({ autoPlace: false });
  const first = root.addFolder('Shape');
  first.add({ sides: 3 }, 'sides', 0, 10);

  const second = root.addFolder('Shape');
  second.add({ sides: 4 }, 'sides', 0, 10);
  first.add({ glow: false }, 'glow');

  assert.deepEqual(first.collectUrlKeys(), ['Shape.sides', 'Shape.glow']);
  assert.deepEqual(second.collectUrlKeys(), ['Shape#1.sides']);
});

test('a display folder does not push a later real folder off its own key', () => {
  installWindow('');
  const root = new DeepLinkGUI({ autoPlace: false });
  const display = root.addDisplayFolder('Shape');
  display.add({ sides: 3 }, 'sides', 0, 10);

  const real = root.addFolder('Shape');
  real.add({ glow: false }, 'glow');

  assert.deepEqual(display.collectUrlKeys(), ['sides']);
  assert.deepEqual(real.collectUrlKeys(), ['Shape.glow']);
});

/**
 * Verifies the tool-page fallback writer (no active URLSync) merges, not
 * overwrites, params changed within the debounce window: two keys set before
 * the shared timer fires must both reach the URL so neither is lost from the
 * deep link.
 */
test('makeUrlParamWriter merges multiple keys changed within the debounce window', () => {
  let lastUrl = '/';
  globalThis.window = {
    location: { search: '?keep=1', pathname: '/', hash: '' },
    history: { replaceState(s, t, url) { lastUrl = url; } },
  };
  const setUrlParam = makeUrlParamWriter();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setUrlParam('a', 0.5);
    setUrlParam('b', 'two'); // before the first timer fires
    mock.timers.tick(200);
  } finally {
    mock.timers.reset();
  }
  const q = new URL(lastUrl, 'http://x').searchParams;
  assert.equal(q.get('a'), '0.5');
  assert.equal(q.get('b'), 'two');
  assert.equal(q.get('keep'), '1');
});

/**
 * The standalone-page fallback commit must preserve location.hash: a tool page
 * using a fragment would otherwise lose it on the first GUI change (URLSync,
 * used by the main app, already preserves it).
 */
test('makeUrlParamWriter preserves location.hash in the fallback commit', () => {
  let lastUrl = '/';
  globalThis.window = {
    location: { search: '?keep=1', pathname: '/', hash: '#section' },
    history: { replaceState(s, t, url) { lastUrl = url; } },
  };
  const setUrlParam = makeUrlParamWriter();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setUrlParam('a', 'one');
    mock.timers.tick(200);
  } finally {
    mock.timers.reset();
  }
  assert.match(lastUrl, /#section$/, 'the fragment survives the URL rewrite');
  assert.equal(new URL(lastUrl, 'http://x').searchParams.get('a'), 'one');
});

/**
 * The fallback commit must serialize exactly as URLSync does, so a tool page and
 * the app produce the same link for the same value: numbers rounded to
 * significant digits, and a value with no URL form dropping its param.
 */
test('makeUrlParamWriter serializes numbers and deletions like URLSync', () => {
  let lastUrl = '/';
  globalThis.window = {
    location: { search: '?keep=1&stale=9&gone=1', pathname: '/', hash: '' },
    history: { replaceState(s, t, url) { lastUrl = url; } },
  };
  const write = makeUrlParamWriter();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    write('speed', 1.234567);
    write('count', 42);
    write('stale', NaN);  // non-finite has no URL form
    write('gone', null);  // deletion marker
    mock.timers.tick(200);
  } finally {
    mock.timers.reset();
  }
  const q = new URL(lastUrl, 'http://x').searchParams;
  assert.equal(q.get('speed'), '1.2346', 'a float is cut to 5 significant digits');
  assert.equal(q.get('count'), '42', 'an integer keeps no decimal tail');
  assert.equal(q.has('stale'), false, 'a non-finite number drops the param');
  assert.equal(q.has('gone'), false, 'null removes the param');
  assert.equal(q.get('keep'), '1', 'unrelated params survive');
});

/**
 * Installs a window whose replaceState records the written URL.
 * @param {string} search - The raw query string, including the leading '?'.
 * @param {string} [hash] - The location fragment, including the leading '#'.
 * @returns {{written: () => string}} Accessor for the last URL written.
 */
function installRecordingWindow(search, hash = '') {
  let lastUrl = '/';
  globalThis.window = {
    location: { search, pathname: '/', hash },
    history: { replaceState(state, title, url) { lastUrl = url; } },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
  return { written: () => lastUrl };
}

/**
 * The URL writer is shared root→children, so a child folder's destroy() must not
 * cancel a write the surviving root still owes: tearing down one folder of a
 * rebuilt panel would otherwise drop the pending deep link.
 */
test('destroying a child folder leaves the shared root URL writer armed', () => {
  const url = installRecordingWindow('');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const root = new DeepLinkGUI({ autoPlace: false });
    const folder = root.addFolder('Shape');
    folder.add({ sides: 3 }, 'sides', 0, 10).setValue(5);

    folder.destroy();
    assert.equal(folder.gui.destroyed, true, 'the folder panel is torn down');
    assert.equal(root.gui.destroyed, false, 'the root panel survives a child destroy');

    mock.timers.tick(200);
    assert.equal(new URL(url.written(), 'http://x').searchParams.get('Shape.sides'), '5',
      'the root writer still flushes the pending deep link');
  } finally {
    mock.timers.reset();
  }
});

/**
 * A discarded root must leave no armed timer: the 200 ms write would otherwise
 * fire history.replaceState into a page the GUI no longer belongs to.
 */
test('destroying the root cancels its pending URL write', () => {
  const url = installRecordingWindow('');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const root = new DeepLinkGUI({ autoPlace: false });
    root.add({ speed: 1 }, 'speed', 0, 10).setValue(5);

    root.destroy();
    assert.equal(root.gui.destroyed, true, 'the root panel is torn down');

    mock.timers.tick(200);
    assert.equal(url.written(), '/', 'the discarded GUI writes nothing');
  } finally {
    mock.timers.reset();
  }
});

/**
 * The no-URLSync fallback — the branch every standalone tool page takes — clears
 * deep-link params, keeps the excluded ones, and preserves the fragment.
 */
test('resetGUI clears deep-link params except the excluded ones on a tool page', () => {
  const url = installRecordingWindow('?Speed=0.5&Sides=7&keep=1', '#tool');
  resetGUI(['keep']);

  const q = new URL(url.written(), 'http://x').searchParams;
  assert.equal(q.get('keep'), '1');
  assert.equal(q.get('Speed'), null);
  assert.equal(q.get('Sides'), null);
  assert.match(url.written(), /#tool$/, 'the fragment survives the reset');
});

/** Verifies the fallback drops the query string entirely when nothing is excluded. */
test('resetGUI with no exclusions leaves a bare path on a tool page', () => {
  const url = installRecordingWindow('?Speed=0.5', '#tool');
  resetGUI();
  assert.equal(url.written(), '/#tool');
});

/**
 * resetGUI delegates to the app's URLSync when one is registered, so tracked
 * state is re-asserted rather than cleared with the deep-link params.
 */
test('resetGUI routes through the active URLSync', () => {
  const url = installRecordingWindow('?Speed=0.5&keep=1&effect=Old', '#tool');
  new URLSync(new AppState({ effect: 'Old' }), ['effect']);

  resetGUI(['keep']);
  getActiveURLSync().flush();

  const q = new URL(url.written(), 'http://x').searchParams;
  assert.equal(q.get('Speed'), null);
  assert.equal(q.get('keep'), '1');
  assert.equal(q.get('effect'), 'Old', 'tracked state is re-asserted');
  assert.match(url.written(), /#tool$/);
});

/**
 * An effect switch resets the param URL and rebuilds the panel inside one
 * debounce window, so a control added there seeds from the engine, not from the
 * URL entry on its way out — effects share param names, and the outgoing
 * effect's value would otherwise hydrate the incoming one's slider.
 */
test('a control added inside a scheduled reset ignores the params it drops', () => {
  installRecordingWindow('?fx.Alpha=0.75&view.poleLod=1.5&effect=Old');
  new URLSync(new AppState({ effect: 'Old' }), ['effect']);

  resetGUI(['effect', 'view.poleLod']);

  const incoming = { Alpha: 0.2 };
  new DeepLinkGUI({ autoPlace: false }, 'fx').add(incoming, 'Alpha', 0, 1);
  assert.equal(incoming.Alpha, 0.2, 'the outgoing effect\'s value must not hydrate');

  const global = { poleLod: 0 };
  new DeepLinkGUI({ autoPlace: false }, 'view').add(global, 'poleLod', 0, 2);
  assert.equal(global.poleLod, 1.5, 'an excluded key still hydrates');
});
