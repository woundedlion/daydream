// @ts-check
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

// Minimal lil-gui stub: a controller bound to (object, prop) exposing just the
// chaining surface DeepLinkGUI relies on. The deep-link validation under test
// runs entirely inside DeepLinkGUI.add() before the underlying gui.add(), so
// the stub only has to bind and replay values, not implement a real dropdown.
class StubController {
  constructor(object, prop) { this.object = object; this.prop = prop; this._on = null; }
  onChange(fn) { this._on = fn; return this; }
  getValue() { return this.object[this.prop]; }
  setValue(v) { this.object[this.prop] = v; if (this._on) this._on(v); return this; }
  updateDisplay() { return this; }
  name() { return this; }
}
class StubGUI {
  constructor() { this.domElement = {}; }
  add(object, prop) { return new StubController(object, prop); }
  addColor(object, prop) { return new StubController(object, prop); }
  addFolder() { return new StubGUI(); }
}

mock.module('lil-gui', { namedExports: { GUI: StubGUI } });

const { GUI: DeepLinkGUI } = await import('../gui.js');

function installWindow(search) {
  globalThis.window = {
    location: { search, pathname: '/' },
    history: { replaceState() {} },
  };
}

const RES = ['Phantasm (144x288)', 'Crystal (192x384)'];

// Regression for the deep-link blanking bug: a garbage ?resolution= must not
// survive DeepLinkGUI hydration. add() re-reads the raw URL, and its
// applyOnLoad replay fires the loaded value through the caller's onChange — the
// exact path that re-injected an invalid resolution into appState (where
// applyResolution() silently no-ops, leaving a black canvas) even after the
// startup re-validation had corrected it.
test('DeepLinkGUI.add ignores an out-of-list URL value for a dropdown', () => {
  installWindow('?resolution=GARBAGE');
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { resolution: 'Phantasm (144x288)' }; // already-validated value
  const replayed = [];
  gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));

  // The garbage URL value must not poison the bound object...
  assert.equal(obj.resolution, 'Phantasm (144x288)');
  // ...and the applyOnLoad replay must fire the valid value, not the garbage.
  assert.deepEqual(replayed, ['Phantasm (144x288)']);
});

test('DeepLinkGUI.add adopts a valid in-list URL value for a dropdown', () => {
  installWindow('?resolution=' + encodeURIComponent('Crystal (192x384)'));
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { resolution: 'Phantasm (144x288)' };
  const replayed = [];
  gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));

  assert.equal(obj.resolution, 'Crystal (192x384)');
  assert.deepEqual(replayed, ['Crystal (192x384)']);
});

test('DeepLinkGUI.add leaves a non-enumerated control (no option list) untouched', () => {
  // A slider-style add() ($1 is a numeric min) has no option list, so a URL
  // value is adopted as before — the validation must not regress those.
  installWindow('?speed=2.5');
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { speed: 1.0 };
  gui.add(obj, 'speed', 0, 10);
  assert.equal(obj.speed, 2.5);
});

test('DeepLinkGUI.add with no matching URL param keeps the default', () => {
  installWindow('?other=x');
  const gui = new DeepLinkGUI({ autoPlace: false });
  const obj = { resolution: 'Phantasm (144x288)' };
  const replayed = [];
  gui.add(obj, 'resolution', RES).onChange((v) => replayed.push(v));
  assert.equal(obj.resolution, 'Phantasm (144x288)');
  assert.deepEqual(replayed, []); // no URL value → no applyOnLoad replay
});
