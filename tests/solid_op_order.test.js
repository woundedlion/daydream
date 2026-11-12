import {dropSlotIndex, dropTargetIndex, reorderPreviewShift, movedOps} from '../src/workbench/solids/solid_op_order.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** A list of uniform 20px rows, the layout the op-chain reorder math reads. */
const rows = (count, height = 20) =>
  Array.from({ length: count }, (_, i) => ({ offsetTop: i * height, offsetHeight: height }));

/** Verifies the drop slot counts the item midpoints the pointer has passed. */
test('dropSlotIndex splits on each item midpoint', () => {
  const items = rows(3);
  assert.equal(dropSlotIndex(0, items), 0);
  assert.equal(dropSlotIndex(9, items), 0);
  assert.equal(dropSlotIndex(10, items), 1); // exactly on the first midpoint
  assert.equal(dropSlotIndex(29, items), 1);
  assert.equal(dropSlotIndex(30, items), 2);
  assert.equal(dropSlotIndex(1000, items), 3); // past the last item
});

/** Verifies an empty list offers only the single slot 0, so the first op can be dropped. */
test('dropSlotIndex reports slot 0 for an empty list', () => {
  assert.equal(dropSlotIndex(0, []), 0);
  assert.equal(dropSlotIndex(500, []), 0);
});

/** Verifies rows of differing heights split on their own midpoints, not a uniform pitch. */
test('dropSlotIndex handles rows of unequal height', () => {
  const items = [
    { offsetTop: 0, offsetHeight: 40 },
    { offsetTop: 40, offsetHeight: 10 },
  ];
  assert.equal(dropSlotIndex(19, items), 0);
  assert.equal(dropSlotIndex(20, items), 1);
  assert.equal(dropSlotIndex(45, items), 2);
});

/** Verifies a slot at or before the dragged op maps straight through, since removal shifts nothing before it. */
test('dropTargetIndex passes slots at or above the drag source through', () => {
  assert.equal(dropTargetIndex(0, 2), 0);
  assert.equal(dropTargetIndex(2, 2), 2);
});

/** Verifies a slot past the dragged op loses the one index the removal frees. */
test('dropTargetIndex decrements slots past the drag source', () => {
  assert.equal(dropTargetIndex(3, 2), 2); // dropping just below itself is a no-op
  assert.equal(dropTargetIndex(4, 2), 3);
});

/**
 * Verifies the slot pair that means "leave it where it is" both resolve to the
 * source index, which is how the page detects a no-op drop.
 */
test('dropTargetIndex resolves both no-op slots to the source index', () => {
  for (const from of [0, 1, 4]) {
    assert.equal(dropTargetIndex(from, from), from);
    assert.equal(dropTargetIndex(from + 1, from), from);
  }
});

/** Verifies dragging down shifts only the ops the dragged one passes, each up one slot. */
test('reorderPreviewShift lifts the ops a downward drag passes', () => {
  // Dragging op 0 to slot 3: ops 1 and 2 move up, op 3 stays.
  assert.deepEqual([0, 1, 2, 3].map(i => reorderPreviewShift(0, 3, i)), [0, -1, -1, 0]);
});

/** Verifies dragging up shifts only the ops the dragged one passes, each down one slot. */
test('reorderPreviewShift pushes down the ops an upward drag passes', () => {
  // Dragging op 3 to slot 1: ops 1 and 2 move down, op 0 stays.
  assert.deepEqual([0, 1, 2, 3].map(i => reorderPreviewShift(3, 1, i)), [0, 1, 1, 0]);
});

/** Verifies the dragged item itself is never shifted, and a no-op drop moves nothing. */
test('reorderPreviewShift leaves the dragged item and no-op drops alone', () => {
  assert.equal(reorderPreviewShift(2, 5, 2), 0);
  assert.equal(reorderPreviewShift(2, 0, 2), 0);
  for (const slot of [2, 3]) {
    assert.deepEqual([0, 1, 2, 3].map(i => reorderPreviewShift(2, slot, i)), [0, 0, 0, 0]);
  }
});

/**
 * Verifies the preview agrees with the commit: an op previewed as shifting by one
 * slot lands exactly one place from where it started in the reordered chain.
 */
test('reorderPreviewShift matches where movedOps actually puts each op', () => {
  const ops = [0, 1, 2, 3].map(i => ({ op: `op${i}`, params: {} }));
  for (let from = 0; from < ops.length; from++) {
    for (let slot = 0; slot <= ops.length; slot++) {
      const moved = movedOps(ops, from, dropTargetIndex(slot, from));
      for (let i = 0; i < ops.length; i++) {
        if (i === from) continue;
        const landed = moved.findIndex(o => o.op === `op${i}`);
        assert.equal(landed - i, reorderPreviewShift(from, slot, i),
          `op${i} preview disagrees with the commit for from=${from} slot=${slot}`);
      }
    }
  }
});

/** Verifies movedOps reorders without aliasing or mutating the input chain. */
test('movedOps returns a reordered deep copy', () => {
  const ops = [
    { op: 'dual', params: {} },
    { op: 'truncate', params: { t: 0.3 } },
    { op: 'ambo', params: {} },
  ];
  const moved = movedOps(ops, 0, 2);
  assert.deepEqual(moved.map(o => o.op), ['truncate', 'ambo', 'dual']);
  assert.deepEqual(ops.map(o => o.op), ['dual', 'truncate', 'ambo']);
  moved[0].params.t = 0.9;
  assert.equal(ops[1].params.t, 0.3);
});
