// @ts-check
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { URL } from 'node:url';

// Minimal lil-gui stub: a controller bound to (object, prop) exposing just the
// chaining surface DeepLinkGUI relies on. The deep-link validation under test
// runs entirely inside DeepLinkGUI.add() before the underlying gui.add(), so
// the stub only has to bind and replay values, not implement a real dropdown.
class StubController {
  /**
   * Binds the controller to a target object property.
   * @param {Object} object - The object whose property this controller edits.
   * @param {string} prop - The property name bound by this controller.
   */
  constructor(object, prop) { this.object = object; this.prop = prop; this._on = null; }
  /**
   * Registers the change callback, mirroring lil-gui's chaining API.
   * @param {Function} fn - Handler invoked with the new value on setValue.
   * @returns {StubController} This controller, for chaining.
   */
  onChange(fn) { this._on = fn; return this; }
  /**
   * Reads the current bound value.
   * @returns {*} The current value of the bound property.
   */
  getValue() { return this.object[this.prop]; }
  /**
   * Writes the bound value and fires the registered onChange handler.
   * @param {*} v - The new value to assign to the bound property.
   * @returns {StubController} This controller, for chaining.
   */
  setValue(v) { this.object[this.prop] = v; if (this._on) this._on(v); return this; }
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
// Minimal lil-gui root stub: hands back StubControllers and nested folders so
// DeepLinkGUI can wrap it without a real DOM or dropdown widget.
class StubGUI {
  /**
   * Creates the root stub with a placeholder DOM element.
   */
  constructor() { this.domElement = {}; }
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
}

mock.module('lil-gui', { namedExports: { GUI: StubGUI } });

const { GUI: DeepLinkGUI, setUrlParam } = await import('../gui.js');

/**
 * Installs a minimal global window so gui.js can read location.search and call
 * history.replaceState during the test.
 * @param {string} search - The raw query string, including the leading '?' (e.g. '?resolution=X').
 */
function installWindow(search) {
  globalThis.window = {
    location: { search, pathname: '/' },
    history: { replaceState() {} },
  };
}

const RES = ['Phantasm (144x288)', 'Crystal (192x384)'];

/**
 * Verifies a garbage ?resolution= does not survive DeepLinkGUI hydration. add()
 * re-reads the raw URL; an out-of-list value would re-inject an invalid
 * resolution into appState (where applyResolution() silently no-ops, leaving a
 * black canvas), so the value is rejected against the option list. Because the
 * value was rejected, the bound default is left in place and the applyOnLoad
 * replay does NOT fire — replaying would push the default back through onChange,
 * spuriously re-persisting it to the URL (finding 122).
 */
test('DeepLinkGUI.add ignores an out-of-list URL value for a dropdown', () => {
  installWindow('?resolution=GARBAGE');
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { resolution: 'Phantasm (144x288)' }; // a known-valid option
  const replayed = [];
  gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));

  // The garbage URL value must not poison the bound object...
  assert.equal(obj.resolution, 'Phantasm (144x288)');
  // ...and a rejected value must not replay (no spurious onChange/URL write).
  assert.deepEqual(replayed, []);
});

/**
 * Verifies a URL value that is in the option list is adopted and replayed
 * through onChange.
 */
test('DeepLinkGUI.add adopts a valid in-list URL value for a dropdown', () => {
  installWindow('?resolution=' + encodeURIComponent('Crystal (192x384)'));
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { resolution: 'Phantasm (144x288)' };
  const replayed = [];
  gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));

  assert.equal(obj.resolution, 'Crystal (192x384)');
  assert.deepEqual(replayed, ['Crystal (192x384)']);
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
  const obj = { resolution: 'Phantasm (144x288)' };
  const replayed = [];
  gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));
  assert.equal(obj.resolution, 'Phantasm (144x288)');
  assert.deepEqual(replayed, []); // no URL value → no applyOnLoad replay
});

/**
 * Verifies the tool-page fallback writer (no active URLSync) merges, not
 * overwrites, params changed within the debounce window: two keys set before
 * the shared timer fires must both reach the URL so neither is lost from the
 * deep link.
 */
test('setUrlParam merges multiple keys changed within the debounce window', () => {
  let lastUrl = '/';
  globalThis.window = {
    location: { search: '?keep=1', pathname: '/' },
    history: { replaceState(_s, _t, url) { lastUrl = url; } },
  };
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setUrlParam('a', 0.5);
    setUrlParam('b', 'two'); // second change before the first timer fires
    mock.timers.tick(200);
  } finally {
    mock.timers.reset();
  }
  const q = new URL(lastUrl, 'http://x').searchParams;
  assert.equal(q.get('a'), '0.5'); // first write survived the second
  assert.equal(q.get('b'), 'two');
  assert.equal(q.get('keep'), '1'); // pre-existing params preserved
});
