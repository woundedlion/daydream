import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUI } from '../src/ui/gui.js';
import { Daydream } from '../src/renderer/driver.js';
import { AppState, URLSync } from '../src/app/state.js';
import { fakeDriver, fakeGui, fakePanelGui } from './helpers/fake_app.js';

for (const factory of [fakeGui, fakePanelGui]) {
  test(`${factory.name} clears stored companions and rejects nonnumeric values`, () => {
    const gui = factory();
    gui.writeStoredValue('key', 3);
    assert.equal(gui.readStoredNumber('key'), 3);
    assert.equal(gui.readStoredString('key'), '3');
    for (const value of [null, undefined, NaN, Infinity, -Infinity]) {
      gui.writeStoredValue('key', 3);
      gui.writeStoredValue('key', value);
      assert.equal(gui.readStoredNumber('key'), undefined);
      assert.equal(gui.readStoredString('key'), undefined);
    }
    for (const value of [true, false, 'invalid']) {
      gui.writeStoredValue('key', value);
      assert.equal(gui.readStoredNumber('key'), undefined);
      assert.equal(gui.readStoredString('key'), String(value));
    }
  });
}

test('stored companion writes match DeepLinkGUI pending and flushed URLs', () => {
  const win = {
    location: new URL('https://example.test/'),
    setTimeout: () => 1, clearTimeout() {},
    history: { replaceState(state, title, url) { win.location = new URL(url, win.location); } },
  };
  const sync = new URLSync(new AppState({}), [], {}, win);
  const real = new GUI(fakeGui(), 'test', null, win);
  const doubles = [fakeGui(), fakePanelGui()];
  try {
    for (const value of [3, NaN, 3, Infinity, 3, -Infinity, true, false, 'invalid', null, undefined]) {
      for (const gui of [real, ...doubles]) gui.writeStoredValue('key', value);
      for (const gui of doubles) assert.equal(gui.readStoredString('key'), real.readStoredString('key'));
      sync.flush();
      for (const gui of doubles) assert.equal(gui.readStoredString('key'), real.readStoredString('key'));
    }
  } finally {
    sync.dispose();
    real.destroy();
  }
});


test('fake driver matches the real driver method and data surface', () => {
  const fields = new Set([...Daydream.toString().matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)]
    .map((match) => match[1]));
  for (const [name, value] of Object.entries(fakeDriver())) {
    if (typeof value === 'function') {
      assert.equal(typeof Daydream.prototype[name], 'function', name);
    } else {
      assert.ok(name === 'keys' || name === 'frames' || fields.has(name), name);
    }
  }
});

for (const factory of [fakeGui, fakePanelGui]) {
  test(`${factory.name} methods match the real GUI surface`, () => {
    for (const [name, value] of Object.entries(factory())) {
      if (typeof value === 'function' && name !== 'ctrl')
        assert.equal(typeof GUI.prototype[name], 'function', name);
    }
  });
}
