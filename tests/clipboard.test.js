// @ts-nocheck
//
// copyWithFeedback's transient label swap. Key invariant: a second copy within
// revertMs must not latch the element on "Copied!".
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

// copyToClipboard prefers navigator.clipboard.writeText; stub it to succeed.
// Node exposes a read-only `navigator`, so override it via defineProperty.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
});

const { copyWithFeedback } = await import('../tools/clipboard.js');

restoreDocumentAfterEach();

/**
 * Stand-in for the button element copyWithFeedback mutates. Its classList
 * records the live class set, so a test can assert which classes are present
 * after a flash/revert cycle.
 * @param {string} label - Initial idle text for the element's textContent.
 * @param {string[]} [initialClasses] - Classes present before the first copy.
 * @returns {Object} A fake button element.
 */
function fakeButton(label, initialClasses = []) {
  const el = fakeElement('button');
  el.textContent = label;
  el.classList.add(...initialClasses);
  return el;
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.timers.reset();
});

/** Verifies a second copy before the first revert timer still restores the real idle label, not "Copied!". */
test('a second copy within revertMs still reverts to the idle label', async () => {
  const el = fakeButton('Copy');

  await copyWithFeedback('a', { element: el, copiedText: 'Copied!', revertMs: 1500 });
  assert.equal(el.textContent, 'Copied!', 'first copy shows the copied label');

  mock.timers.tick(500);
  await copyWithFeedback('b', { element: el, copiedText: 'Copied!', revertMs: 1500 });
  assert.equal(el.textContent, 'Copied!');

  mock.timers.tick(2000);
  assert.equal(el.textContent, 'Copy', 'element reverts to idle, not "Copied!"');
});

/** With an empty revertText (no idle label to restore), the idle class is still restored on revert. */
test('revertText: "" still restores the idle class on revert', async () => {
  const el = fakeButton('Copy', ['text-gray-500']);

  await copyWithFeedback('a', {
    element: el, copiedText: 'Copied!', revertText: '', revertMs: 1500,
    copiedClasses: ['text-green-400'], idleClasses: ['text-gray-500'],
  });
  assert.equal(el.textContent, 'Copied!');
  assert.equal(el.classList.has('text-gray-500'), false, 'idle class removed while flashed');

  mock.timers.tick(2000);
  assert.equal(el.textContent, '');
  assert.equal(el.classList.has('text-gray-500'), true, 'idle class restored after revert');
});

/** A rejected clipboard write flashes the failure label and reverts, never latching "Copied!". */
test('a rejected clipboard write flashes the failure label, not "Copied!"', async () => {
  const restore = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  // Reject the async path and fail the execCommand fallback so the copy reports failure.
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
    configurable: true,
  });
  installDocument({
    createElement: fakeElement,
    body: fakeElement('body'),
    execCommand: () => false,
  });

  try {
    const el = fakeButton('Copy');
    const ok = await copyWithFeedback('x', {
      element: el, copiedText: 'Copied!', failedText: 'Copy failed', revertMs: 1500,
    });
    assert.equal(ok, false, 'copy reports failure');
    assert.equal(el.textContent, 'Copy failed', 'failure label flashed, not "Copied!"');

    mock.timers.tick(2000);
    assert.equal(el.textContent, 'Copy', 'element reverts to idle');
  } finally {
    Object.defineProperty(globalThis, 'navigator', restore);
  }
});
