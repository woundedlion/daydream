// @ts-nocheck
//
// clipboard.js — coverage for copyWithFeedback's transient label swap, which
// every tool page reuses. The regression of record (finding 259): a second
// copy within revertMs must not latch the element on "Copied!".
//
// Run: node --test --experimental-test-module-mocks "tests/*.test.js"
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// copyToClipboard prefers navigator.clipboard.writeText; stub it to succeed.
// Node exposes a read-only `navigator`, so override it via defineProperty.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
});

const { copyWithFeedback } = await import('../tools/clipboard.js');

/** Minimal stand-in for the button element copyWithFeedback mutates. */
function fakeElement(label) {
  return {
    textContent: label,
    classList: { add() {}, remove() {} },
  };
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
});

test('a second copy within revertMs still reverts to the idle label', async () => {
  const el = fakeElement('Copy');

  await copyWithFeedback('a', { element: el, copiedText: 'Copied!', revertMs: 1500 });
  assert.equal(el.textContent, 'Copied!', 'first copy shows the copied label');

  // Second copy fires before the first revert timer — the bug captured the live
  // "Copied!" as the text to restore, latching it permanently.
  mock.timers.tick(500);
  await copyWithFeedback('b', { element: el, copiedText: 'Copied!', revertMs: 1500 });
  assert.equal(el.textContent, 'Copied!');

  // Let every pending timer fire: the label must return to the real idle text.
  mock.timers.tick(2000);
  assert.equal(el.textContent, 'Copy', 'element reverts to idle, not "Copied!"');

  mock.timers.reset();
});
