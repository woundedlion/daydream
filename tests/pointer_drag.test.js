import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPointerDrag, innerRect } from '../tools/pointer_drag.js';
import { fakeElement } from './helpers/fake_dom.js';

/** A pointerdown that passes the helper's own guard unless overridden. */
const down = (pointerId = 7, extra = {}) => ({
  pointerId, isPrimary: true, button: 0, ...extra,
});

/** A drag wired onto a fake element, with each callback's calls recorded. */
const harness = (options = {}) => {
  const element = fakeElement('canvas');
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
  const event = element.dispatch('pointerdown', down(7));
  assert.deepEqual(calls.start, [event]);
  assert.ok(element.hasPointerCapture(7));
  assert.equal(event.defaultPrevented, true);
});

test('a pointerdown that is not the primary button starts nothing', () => {
  for (const extra of [{ isPrimary: false }, { button: 1 }, { button: 2 }]) {
    const { element, calls } = harness();
    const event = element.dispatch('pointerdown', down(7, extra));
    assert.equal(calls.start.length, 0, `${JSON.stringify(extra)} must not start a drag`);
    assert.equal(element.capturedPointers.size, 0);
    assert.equal(event.defaultPrevented, false);
  }
});

test('a second pointerdown while a drag runs is ignored', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  const second = element.dispatch('pointerdown', down(9));
  assert.equal(calls.start.length, 1);
  assert.ok(!element.hasPointerCapture(9));
  assert.equal(second.defaultPrevented, false);
});

test('onStart returning false declines the drag, leaving the default intact', () => {
  const { element, calls } = harness({ declineStart: true });
  const event = element.dispatch('pointerdown', down(7));
  assert.equal(calls.start.length, 1);
  assert.equal(element.capturedPointers.size, 0);
  assert.equal(event.defaultPrevented, false);
  // Declining leaves no drag behind, so the next press is free to start one.
  element.dispatch('pointermove', { pointerId: 7 });
  assert.equal(calls.move.length, 0);
  assert.equal(calls.hover.length, 1);
});

test('a move carrying the drag pointer is a move, and any other pointer a hover', () => {
  const { element, calls } = harness();
  const hoverBefore = element.dispatch('pointermove', { pointerId: 7 });
  element.dispatch('pointerdown', down(7));
  const dragged = element.dispatch('pointermove', { pointerId: 7 });
  const foreign = element.dispatch('pointermove', { pointerId: 9 });
  assert.deepEqual(calls.move, [dragged]);
  assert.deepEqual(calls.hover, [hoverBefore, foreign]);
});

test('a release drops the capture and ends the drag', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  const up = element.dispatch('pointerup', { pointerId: 7 });
  assert.deepEqual(calls.end, [up]);
  assert.equal(calls.cancel.length, 0);
  assert.equal(element.capturedPointers.size, 0);
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
  const cancel = element.dispatch('pointercancel', { pointerId: 7 });
  assert.deepEqual(calls.cancel, [cancel]);
  assert.equal(calls.end.length, 0);
  assert.equal(element.capturedPointers.size, 0);
});

test('a page with no onCancel unwinds a cancelled gesture through onEnd', () => {
  const { element, calls } = harness({ withoutCancel: true });
  element.dispatch('pointerdown', down(7));
  const cancel = element.dispatch('pointercancel', { pointerId: 7 });
  assert.deepEqual(calls.end, [cancel]);
});

test('stop() ends a running drag as a cancel, with no event', () => {
  const { element, calls, drag } = harness();
  element.dispatch('pointerdown', down(7));
  drag.stop();
  assert.deepEqual(calls.cancel, [null]);
  assert.equal(calls.end.length, 0);
  assert.equal(element.capturedPointers.size, 0);
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
  element.capturedPointers.clear();
  let released = 0;
  element.releasePointerCapture = () => { released += 1; };
  element.dispatch('pointerup', { pointerId: 7 });
  assert.equal(released, 0);
  assert.equal(calls.end.length, 1);
});

test('a capture the element lost unwinds the drag as a cancel', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  element.capturedPointers.clear();
  const lost = element.dispatch('lostpointercapture', { pointerId: 7 });
  assert.deepEqual(calls.cancel, [lost]);
  assert.equal(calls.end.length, 0);
  // Unlatched, so the element still takes the next press.
  element.dispatch('pointerdown', down(9));
  assert.equal(calls.start.length, 2);
});

test('another pointer losing its capture does not end the drag', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  element.dispatch('lostpointercapture', { pointerId: 9 });
  assert.equal(calls.cancel.length, 0);
  assert.ok(element.hasPointerCapture(7));
});

test('the lostpointercapture a release raises does not unwind the drag twice', () => {
  const { element, calls } = harness();
  element.releasePointerCapture = (id) => {
    element.capturedPointers.delete(id);
    element.dispatch('lostpointercapture', { pointerId: id });
  };
  element.dispatch('pointerdown', down(7));
  element.dispatch('pointerup', { pointerId: 7 });
  assert.equal(calls.end.length, 1);
  assert.equal(calls.cancel.length, 0);
});

test('a capture the element refuses unwinds instead of latching it', () => {
  const { element, calls } = harness();
  element.setPointerCapture = () => { throw new Error('InvalidPointerId'); };
  const refused = element.dispatch('pointerdown', down(7));
  assert.deepEqual(calls.start, [refused]);
  assert.deepEqual(calls.cancel, [refused]);
  assert.equal(refused.defaultPrevented, false);
  element.setPointerCapture = (id) => { element.capturedPointers.add(id); };
  element.dispatch('pointerdown', down(9));
  assert.equal(calls.start.length, 2);
  assert.ok(element.hasPointerCapture(9));
});

test('the element takes a new drag once the last one ended', () => {
  const { element, calls } = harness();
  element.dispatch('pointerdown', down(7));
  element.dispatch('pointerup', { pointerId: 7 });
  element.dispatch('pointerdown', down(9));
  const moved = element.dispatch('pointermove', { pointerId: 9 });
  assert.equal(calls.start.length, 2);
  assert.deepEqual(calls.move, [moved]);
  assert.ok(element.hasPointerCapture(9));
});

test('remove() detaches every listener the drag wired', () => {
  const { element, calls, drag } = harness();
  assert.deepEqual(element.listeners.map((l) => l.type).sort(),
    ['lostpointercapture', 'pointercancel', 'pointerdown', 'pointermove',
      'pointerup']);
  drag.remove();
  assert.deepEqual(element.listeners, []);
  element.dispatch('pointerdown', down(7));
  assert.equal(calls.start.length, 0);
});

// The shared fake throws on a removal with no listener behind it, so a second
// remove() cannot pass for an idempotent one.
test('remove() detaches once and does not stand in for an idempotent disposal', () => {
  const { drag } = harness();
  drag.remove();
  assert.throws(() => drag.remove(), /no pointerdown listener registered/);
});

test('a page with no callbacks at all still captures and releases', () => {
  const element = fakeElement('canvas');
  const drag = createPointerDrag({ element });
  const event = element.dispatch('pointerdown', down(7));
  assert.ok(element.hasPointerCapture(7));
  assert.equal(event.defaultPrevented, true);
  element.dispatch('pointermove', { pointerId: 7 });
  element.dispatch('pointerup', { pointerId: 7 });
  assert.equal(element.capturedPointers.size, 0);
  drag.stop();
  assert.equal(element.capturedPointers.size, 0);
});

// Tailwind's preflight gives the tool canvases a 1px border, which the border
// box carries and the bitmap does not: a pointer scaled by the rect misses both
// ends of the surface it is scrubbing.
test('innerRect reports the padding box, not the bordered rect', () => {
  const element = fakeElement('canvas');
  element.offsetLeft = 40;
  element.offsetTop = 10;
  element.offsetWidth = 1000;
  element.offsetHeight = 240;
  element.clientLeft = 1;
  element.clientTop = 1;
  element.clientWidth = 998;
  element.clientHeight = 238;

  assert.deepEqual(innerRect(element),
    { left: 41, top: 11, width: 998, height: 238 });
});

test('innerRect leaves an unbordered element its own rect', () => {
  const element = fakeElement('canvas');
  element.offsetLeft = 5;
  element.offsetTop = 6;
  element.offsetWidth = 300;
  element.offsetHeight = 100;
  element.clientWidth = 300;
  element.clientHeight = 100;

  assert.deepEqual(innerRect(element), { left: 5, top: 6, width: 300, height: 100 });
});

test('removing a live drag releases capture and cancels it once', () => {
  const { element, calls, drag } = harness();
  element.dispatch('pointerdown', down(7));
  drag.remove();
  assert.equal(element.hasPointerCapture(7), false);
  assert.deepEqual(calls.cancel, [null]);
  assert.equal(element.listeners.length, 0);
  drag.stop();
  assert.equal(calls.cancel.length, 1);
});
