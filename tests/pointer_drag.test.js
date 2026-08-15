import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPointerDrag } from '../tools/pointer_drag.js';

/** An element that records captures and the listeners wired onto it. */
const fakeCanvas = () => {
  const listeners = new Map();
  const captured = new Set();
  return {
    captured,
    listeners,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch(type, event) { listeners.get(type)?.(event); },
    setPointerCapture(id) { captured.add(id); },
    releasePointerCapture(id) { captured.delete(id); },
    hasPointerCapture(id) { return captured.has(id); },
  };
};

/** A pointerdown that passes the helper's own guard unless overridden. */
const down = (pointerId = 7, extra = {}) => ({
  pointerId, isPrimary: true, button: 0, prevented: false,
  preventDefault() { this.prevented = true; }, ...extra,
});

/** A drag wired onto a fake element, with each callback's calls recorded. */
const harness = (options = {}) => {
  const element = fakeCanvas();
  const calls = { start: [], move: [], hover: [], end: [], cancel: [] };
  const drag = createPointerDrag({
    element,
    onStart: (event) => {
      calls.start.push(event);
      return options.declineStart ? false : undefined;
    },
    onMove: (event) => calls.move.push(event),
    onHover: (event) => calls.hover.push(event),
    onEnd: (event) => calls.end.push(event),
    ...(options.withoutCancel ? {} : { onCancel: (event) => calls.cancel.push(event) }),
  });
  return { element, calls, drag };
};

test('a primary pointerdown starts the drag, captures the pointer and suppresses the default', () => {
  const { element, calls } = harness();
  const event = down(7);
  element.dispatch('pointerdown', event);
  assert.deepEqual(calls.start, [event]);
  assert.ok(element.hasPointerCapture(7));
  assert.equal(event.prevented, true);
});

test('a pointerdown that is not the primary button starts nothing', () => {
  for (const extra of [{ isPrimary: false }, { button: 1 }, { button: 2 }]) {
    const { element, calls } = harness();
    const event = down(7, extra);
    element.dispatch('pointerdown', event);
    assert.equal(calls.start.length, 0, `${JSON.stringify(extra)} must not start a drag`);
    assert.equal(element.captured.size, 0);
    assert.equal(event.prevented, false);
  }
});

test('a second pointerdown while a drag runs is ignored', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  const second = down(9);
  element.dispatch('pointerdown', second);
  assert.equal(calls.start.length, 1);
  assert.ok(!element.hasPointerCapture(9));
  assert.equal(second.prevented, false);
});

test('onStart returning false declines the drag, leaving the default intact', () => {
  const { element, calls } = harness({ declineStart: true });
  const event = down(7);
  element.dispatch('pointerdown', event);
  assert.equal(calls.start.length, 1);
  assert.equal(element.captured.size, 0);
  assert.equal(event.prevented, false);
  // Declining leaves no drag behind, so the next press is free to start one.
  element.dispatch('pointermove', { pointerId: 7 });
  assert.equal(calls.move.length, 0);
  assert.equal(calls.hover.length, 1);
});

test('a move carrying the drag pointer is a move, and any other pointer a hover', () => {
  const { element, calls } = harness();
  const hoverBefore = { pointerId: 7 };
  element.dispatch('pointermove', hoverBefore);
  element.dispatch('pointerdown', down(7));
  const dragged = { pointerId: 7 };
  const foreign = { pointerId: 9 };
  element.dispatch('pointermove', dragged);
  element.dispatch('pointermove', foreign);
  assert.deepEqual(calls.move, [dragged]);
  assert.deepEqual(calls.hover, [hoverBefore, foreign]);
});

test('a release drops the capture and ends the drag', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  const up = { pointerId: 7 };
  element.dispatch('pointerup', up);
  assert.deepEqual(calls.end, [up]);
  assert.equal(calls.cancel.length, 0);
  assert.equal(element.captured.size, 0);
});

test('another pointer cannot end the drag', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  element.dispatch('pointerup', { pointerId: 9 });
  element.dispatch('pointercancel', { pointerId: 9 });
  assert.equal(calls.end.length, 0);
  assert.equal(calls.cancel.length, 0);
  assert.ok(element.hasPointerCapture(7));
});

test('a release with no drag running ends nothing', () => {
  const { element, calls } = harness();
  element.dispatch('pointerup', { pointerId: 7 });
  element.dispatch('pointercancel', { pointerId: 7 });
  assert.equal(calls.end.length, 0);
  assert.equal(calls.cancel.length, 0);
});

test('a cancelled gesture runs onCancel rather than onEnd', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  const cancel = { pointerId: 7 };
  element.dispatch('pointercancel', cancel);
  assert.deepEqual(calls.cancel, [cancel]);
  assert.equal(calls.end.length, 0);
  assert.equal(element.captured.size, 0);
});

test('a page with no onCancel unwinds a cancelled gesture through onEnd', () => {
  const { element, calls } = harness({ withoutCancel: true });
  element.dispatch('pointerdown', down(7));
  const cancel = { pointerId: 7 };
  element.dispatch('pointercancel', cancel);
  assert.deepEqual(calls.end, [cancel]);
});

test('stop() ends a running drag as a cancel, with no event', () => {
  const { element, calls, drag } = harness();
  element.dispatch('pointerdown', down(7));
  drag.stop();
  assert.deepEqual(calls.cancel, [null]);
  assert.equal(calls.end.length, 0);
  assert.equal(element.captured.size, 0);
});

test('stop() with no drag running is a no-op', () => {
  const { calls, drag } = harness();
  drag.stop();
  drag.stop();
  assert.equal(calls.cancel.length, 0);
  assert.equal(calls.end.length, 0);
});

/**
 * A capture the browser already dropped (the element left the document, the
 * gesture was cancelled at the OS level) must not be released a second time.
 */
test('a capture the element no longer holds is not released again', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  element.captured.clear();
  let released = 0;
  element.releasePointerCapture = () => { released += 1; };
  element.dispatch('pointerup', { pointerId: 7 });
  assert.equal(released, 0);
  assert.equal(calls.end.length, 1);
});

test('the element takes a new drag once the last one ended', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  element.dispatch('pointerup', { pointerId: 7 });
  element.dispatch('pointerdown', down(9));
  const moved = { pointerId: 9 };
  element.dispatch('pointermove', moved);
  assert.equal(calls.start.length, 2);
  assert.deepEqual(calls.move, [moved]);
  assert.ok(element.hasPointerCapture(9));
});

test('remove() detaches every listener the drag wired', () => {
  const { element, calls, drag } = harness();
  assert.deepEqual([...element.listeners.keys()].sort(),
    ['pointercancel', 'pointerdown', 'pointermove', 'pointerup']);
  drag.remove();
  assert.equal(element.listeners.size, 0);
  element.dispatch('pointerdown', down(7));
  assert.equal(calls.start.length, 0);
});

test('a page with no callbacks at all still captures and releases', () => {
  const element = fakeCanvas();
  const drag = createPointerDrag({ element });
  const event = down(7);
  element.dispatch('pointerdown', event);
  assert.ok(element.hasPointerCapture(7));
  assert.equal(event.prevented, true);
  element.dispatch('pointermove', { pointerId: 7 });
  element.dispatch('pointerup', { pointerId: 7 });
  assert.equal(element.captured.size, 0);
  drag.stop();
  assert.equal(element.captured.size, 0);
});
