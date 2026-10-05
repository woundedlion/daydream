import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGui, fakePanelGui } from './helpers/fake_app.js';

for (const factory of [fakeGui, fakePanelGui]) {
  test(`${factory.name} clears stored companions and rejects nonnumeric values`, () => {
    const gui = factory();
    gui.writeStoredValue('key', 3);
    assert.equal(gui.readStoredNumber('key'), 3);
    assert.equal(gui.readStoredString('key'), '3');
    for (const value of [null, undefined]) {
      gui.writeStoredValue('key', 3);
      gui.writeStoredValue('key', value);
      assert.equal(gui.readStoredNumber('key'), undefined);
      assert.equal(gui.readStoredString('key'), undefined);
    }
    for (const value of [true, false, 'invalid', NaN, Infinity]) {
      gui.writeStoredValue('key', value);
      assert.equal(gui.readStoredNumber('key'), undefined);
      assert.equal(gui.readStoredString('key'), String(value));
    }
  });
}
