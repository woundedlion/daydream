import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortItems, navTargetIndex, scrollArrowState, resolveActiveEffect } from '../sidebar_logic.js';

const items = () => [
  { name: 'Voronoi', size: 3000 },
  { name: 'Comets', size: 1000 },
  { name: 'MobiusGrid', size: 2000 },
];

test('sortItems orders by name ascending and descending', () => {
  assert.deepEqual(sortItems(items(), 'name', 'asc').map(i => i.name),
    ['Comets', 'MobiusGrid', 'Voronoi']);
  assert.deepEqual(sortItems(items(), 'name', 'desc').map(i => i.name),
    ['Voronoi', 'MobiusGrid', 'Comets']);
});

test('sortItems orders by size numerically', () => {
  assert.deepEqual(sortItems(items(), 'size', 'asc').map(i => i.size),
    [1000, 2000, 3000]);
  assert.deepEqual(sortItems(items(), 'size', 'desc').map(i => i.size),
    [3000, 2000, 1000]);
});

test('sortItems does not mutate its input', () => {
  const original = items();
  const snapshot = original.map(i => i.name);
  sortItems(original, 'name', 'asc');
  assert.deepEqual(original.map(i => i.name), snapshot);
});

test('navTargetIndex advances and wraps for Down/Right', () => {
  assert.equal(navTargetIndex(0, 3, 'ArrowDown'), 1);
  assert.equal(navTargetIndex(2, 3, 'ArrowDown'), 0);   // wrap past the end
  assert.equal(navTargetIndex(1, 3, 'ArrowRight'), 2);  // Right == Down
});

test('navTargetIndex retreats and wraps for Up/Left', () => {
  assert.equal(navTargetIndex(2, 3, 'ArrowUp'), 1);
  assert.equal(navTargetIndex(0, 3, 'ArrowUp'), 2);     // wrap before the start
  assert.equal(navTargetIndex(1, 3, 'ArrowLeft'), 0);   // Left == Up
});

test('navTargetIndex from an off-list focus (idx -1) lands on the first option', () => {
  assert.equal(navTargetIndex(-1, 3, 'ArrowDown'), 0);
});

test('navTargetIndex returns -1 for non-navigation keys and empty lists', () => {
  assert.equal(navTargetIndex(0, 3, 'Enter'), -1);
  assert.equal(navTargetIndex(0, 3, ' '), -1);
  assert.equal(navTargetIndex(0, 0, 'ArrowDown'), -1);  // empty list
});

// The mobile list is an 8-row column-flow grid, so the option to the right of
// index i sits 8 later; without the stride both horizontal arrows would walk
// down the column they are already in.
test('navTargetIndex steps a whole column for Left/Right under a stride', () => {
  assert.equal(navTargetIndex(0, 20, 'ArrowRight', 8), 8);
  assert.equal(navTargetIndex(8, 20, 'ArrowLeft', 8), 0);
  // Vertical movement stays one option per press whatever the stride is.
  assert.equal(navTargetIndex(0, 20, 'ArrowDown', 8), 1);
  assert.equal(navTargetIndex(1, 20, 'ArrowUp', 8), 0);
});

test('navTargetIndex wraps Left/Right within the row, not into the next one', () => {
  // Right past the last column returns to the first column of the same row.
  assert.equal(navTargetIndex(16, 20, 'ArrowRight', 8), 0);
  assert.equal(navTargetIndex(19, 20, 'ArrowRight', 8), 3);
  // Left before the first column lands on the row's last populated option; the
  // short trailing column leaves row 3 ending at 19 and row 4 at 12.
  assert.equal(navTargetIndex(3, 20, 'ArrowLeft', 8), 19);
  assert.equal(navTargetIndex(4, 20, 'ArrowLeft', 8), 12);
  // An off-list focus still enters at an end, and a degenerate stride is 1.
  assert.equal(navTargetIndex(-1, 20, 'ArrowRight', 8), 0);
  assert.equal(navTargetIndex(-1, 20, 'ArrowLeft', 8), 19);
  assert.equal(navTargetIndex(1, 3, 'ArrowRight', 0), 2);
});

test('navTargetIndex jumps to the first/last option for Home/End', () => {
  assert.equal(navTargetIndex(2, 5, 'Home'), 0);
  assert.equal(navTargetIndex(2, 5, 'End'), 4);
  assert.equal(navTargetIndex(0, 0, 'Home'), -1);  // empty list
  assert.equal(navTargetIndex(0, 0, 'End'), -1);
});

const RESO_EFFECTS = ['Voronoi', 'Comets', 'MobiusGrid'];

test('resolveActiveEffect keeps an effect the resolution offers', () => {
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'Comets'), 'Comets');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'Voronoi'), 'Voronoi');
});

test('resolveActiveEffect falls back to the first effect for an off-list request', () => {
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'NotHere'), 'Voronoi');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, 'GARBAGE_FROM_URL'), 'Voronoi');
  assert.equal(resolveActiveEffect(RESO_EFFECTS, undefined), 'Voronoi');
});

test('scrollArrowState hides both arrows when content fits', () => {
  assert.deepEqual(scrollArrowState(0, 100, 100), { left: false, right: false });
  assert.deepEqual(scrollArrowState(0, 80, 100), { left: false, right: false });
});

test('scrollArrowState shows the right arrow at the start of an overflow', () => {
  assert.deepEqual(scrollArrowState(0, 300, 100), { left: false, right: true });
});

test('scrollArrowState shows both arrows mid-scroll and only left near the end', () => {
  assert.deepEqual(scrollArrowState(100, 300, 100), { left: true, right: true });
  assert.deepEqual(scrollArrowState(200, 300, 100), { left: true, right: false });
});

test('scrollArrowState surfaces an arrow for a sub-deadzone overflow', () => {
  // maxScroll = 4 shrinks the deadzone to 1.5, so each end still gets an arrow.
  assert.deepEqual(scrollArrowState(0, 104, 100), { left: false, right: true });
  assert.deepEqual(scrollArrowState(4, 104, 100), { left: true, right: false });
});

test('scrollArrowState keeps the left arrow hidden for a sub-pixel overflow', () => {
  // Fractional scrollWidth (browser zoom / fractional DPI) drives maxScroll below
  // 1, where (maxScroll - 1) / 2 is negative and must clamp to a 0 deadzone.
  assert.deepEqual(scrollArrowState(0, 100.5, 100), { left: false, right: true });
  assert.deepEqual(scrollArrowState(0.5, 100.5, 100), { left: true, right: false });
  assert.deepEqual(scrollArrowState(0, 100.25, 100), { left: false, right: true });
});

test('scrollArrowState shows both arrows at the midpoint of a small overflow', () => {
  // maxScroll = 4, scrollLeft = 2 overflows both directions; the deadzone must
  // stay strictly below maxScroll/2 so neither arrow is hidden here.
  assert.deepEqual(scrollArrowState(2, 104, 100), { left: true, right: true });
});
