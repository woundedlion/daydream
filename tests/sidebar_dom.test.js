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

// Drives onKeyDown against a multi-button fake so the DOM focus wiring (which
// button is focused, roving-tabbable, and whether the native default is
// suppressed) is exercised, not just the index math in sidebar_logic.test.js.
function driveNav(key, startIdx = 0, count = 3) {
  const focusLog = [];
  const rovingLog = [];
  const state = { prevented: 0 };
  const btns = Array.from({ length: count }, (_, i) => ({
    dataset: { effect: `E${i}` },
    focus() { focusLog.push(i); },
  }));
  const self = {
    listEl: { querySelectorAll: () => btns },
    tabbableBtn: btns[startIdx],
    setRovingTabbable(b) { rovingLog.push(btns.indexOf(b)); },
    onSelect() {},
  };
  globalThis.document = { activeElement: btns[startIdx] };
  const e = { key, preventDefault() { state.prevented++; } };
  EffectSidebar.prototype.onKeyDown.call(self, e);
  return { focusLog, rovingLog, prevented: state.prevented };
}

test('onKeyDown: ArrowDown focuses the next button and suppresses the default', () => {
  const r = driveNav('ArrowDown', 0);
  assert.deepEqual(r.focusLog, [1]);
  assert.deepEqual(r.rovingLog, [1]);
  assert.equal(r.prevented, 1);
});

test('onKeyDown: ArrowUp wraps focus to the last button', () => {
  const r = driveNav('ArrowUp', 0);
  assert.deepEqual(r.focusLog, [2]);
  assert.deepEqual(r.rovingLog, [2]);
  assert.equal(r.prevented, 1);
});

test('onKeyDown: Home focuses the first button, End the last', () => {
  const home = driveNav('Home', 2);
  assert.deepEqual(home.focusLog, [0]);
  assert.equal(home.prevented, 1);

  const end = driveNav('End', 0);
  assert.deepEqual(end.focusLog, [2]);
  assert.equal(end.prevented, 1);
});
