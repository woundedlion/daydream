// @ts-check
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EffectSidebar } from '../sidebar.js';

// Restore any globalThis.document stub after each test so it never leaks.
const savedDocument = globalThis.document;
afterEach(() => {
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
});

// Drives EffectSidebar.onKeyDown against a minimal fake button/list so no real
// DOM is needed; the handler only touches the DOM through these hooks.
function driveKey(key) {
  const state = { selected: 0, selectedName: null, prevented: 0 };
  const focused = { dataset: { effect: 'Voronoi' }, focus() {} };
  const self = {
    listEl: { querySelectorAll: () => [focused] },
    tabbableBtn: focused,
    setRovingTabbable() {},
    onSelect(name) {
      state.selected++;
      state.selectedName = name;
    },
  };
  globalThis.document = { activeElement: focused };
  const e = {
    key,
    preventDefault() {
      state.prevented++;
    },
  };
  EffectSidebar.prototype.onKeyDown.call(self, e);
  return state;
}

test('onKeyDown: Enter selects the focused effect exactly once', () => {
  const r = driveKey('Enter');
  assert.equal(r.selected, 1);
  assert.equal(r.selectedName, 'Voronoi');
  assert.equal(r.prevented, 1); // suppresses the native click (no double-select)
});

test('onKeyDown: Space selects the focused effect exactly once', () => {
  const r = driveKey(' ');
  assert.equal(r.selected, 1);
  assert.equal(r.selectedName, 'Voronoi');
  assert.equal(r.prevented, 1);
});
