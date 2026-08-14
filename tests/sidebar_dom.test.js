import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EffectSidebar } from '../sidebar.js';

// Drives EffectSidebar.onKeyDown against a minimal fake button/list so no real
// DOM is needed; the handler only touches the DOM through these hooks.
// `activeFor` picks what the owner document's activeElement is, defaulting to
// the option.
function driveKey(key, activeFor = (btn) => btn) {
  const state = { selected: 0, selectedName: null, prevented: 0 };
  const focused = { dataset: { effect: 'Voronoi' }, focus() {} };
  const self = {
    doc: { activeElement: activeFor(focused) },
    listEl: { querySelectorAll: () => [focused] },
    tabbableBtn: focused,
    setRovingTabbable() {},
    onSelect(name) {
      state.selected++;
      state.selectedName = name;
    },
  };
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

test('onKeyDown: Enter selects nothing when focus is not on an option', () => {
  // Keydown reaches the list from a focused non-option (a scrollbar drag, or a
  // child the list wraps): there is no effect name to select.
  const bare = driveKey('Enter', () => ({ dataset: {}, focus() {} }));
  assert.equal(bare.selected, 0);
  assert.equal(bare.prevented, 1);

  const none = driveKey('Enter', () => null);
  assert.equal(none.selected, 0);
  assert.equal(none.prevented, 1);
});

// Drives onKeyDown against a multi-button fake so the DOM focus wiring (which
// button is focused, roving-tabbable, and whether the native default is
// suppressed) is exercised, not just the index math in sidebar_logic.test.js.
function driveNav(key, startIdx = 0, count = 3, gridStyle = null) {
  const focusLog = [];
  const rovingLog = [];
  const state = { prevented: 0 };
  const btns = Array.from({ length: count }, (_, i) => ({
    dataset: { effect: `E${i}` },
    focus() { focusLog.push(i); },
  }));
  const listEl = {
    querySelectorAll: () => btns,
    ownerDocument: gridStyle
      ? { defaultView: { getComputedStyle: () => gridStyle } }
      : undefined,
  };
  const self = {
    doc: { activeElement: btns[startIdx] },
    listEl,
    tabbableBtn: btns[startIdx],
    setRovingTabbable(b) { rovingLog.push(btns.indexOf(b)); },
    onSelect() {},
  };
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

// The mobile list is a column-flow grid; the stride comes from the resolved
// grid-template-rows so the stylesheet alone states the layout.
const MOBILE_GRID = {
  gridAutoFlow: 'column',
  gridTemplateRows: '20px 20px 20px 20px 20px 20px 20px 20px',
};

test('onKeyDown: horizontal arrows cross columns in the mobile grid', () => {
  const right = driveNav('ArrowRight', 0, 20, MOBILE_GRID);
  assert.deepEqual(right.focusLog, [8], 'Right lands in the next column, same row');
  assert.equal(right.prevented, 1);

  const left = driveNav('ArrowLeft', 8, 20, MOBILE_GRID);
  assert.deepEqual(left.focusLog, [0]);

  // Vertical arrows still walk the column one option at a time.
  const down = driveNav('ArrowDown', 0, 20, MOBILE_GRID);
  assert.deepEqual(down.focusLog, [1]);
});

test('onKeyDown: a list that is not a column grid strides by one option', () => {
  const desktop = { gridAutoFlow: 'row', gridTemplateRows: 'none' };
  assert.deepEqual(driveNav('ArrowRight', 0, 20, desktop).focusLog, [1]);
  // No view to resolve styles from (a detached list): one option per press.
  assert.deepEqual(driveNav('ArrowRight', 0, 20).focusLog, [1]);
});

test('onKeyDown: Home focuses the first button, End the last', () => {
  const home = driveNav('Home', 2);
  assert.deepEqual(home.focusLog, [0]);
  assert.equal(home.prevented, 1);

  const end = driveNav('End', 0);
  assert.deepEqual(end.focusLog, [2]);
  assert.equal(end.prevented, 1);
});
