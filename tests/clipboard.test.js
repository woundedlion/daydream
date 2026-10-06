//
// Clipboard writes, execCommand fallbacks, focus restoration, copy-block wiring,
// and copyWithFeedback's transient label swap.
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './helpers/fake_dom.js';

const {
  copyToClipboard,
  copyWithFeedback,
  wireCopyBlock,
} = await import('../src/shared/clipboard.js');

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

let savedNavigator;

beforeEach(() => {
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
  });
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.timers.reset();
  Object.defineProperty(globalThis, 'navigator', savedNavigator);
});

/** Verifies a second copy before the first revert timer still restores the real idle label, not "Copied!". */
test('a second copy within revertMs still reverts to the idle label', async () => {
  const el = fakeButton('Copy');

  await copyWithFeedback('a', { element: el, copiedText: 'Copied!', revertMs: 1500 });
  assert.equal(el.textContent, 'Copied!', 'first copy shows the copied label');

  mock.timers.tick(500);
  await copyWithFeedback('b', { element: el, copiedText: 'Copied!', revertMs: 1500 });
  assert.equal(el.textContent, 'Copied!');

  // t=1600: past the first copy's 1500ms deadline, inside the second's 2000ms one.
  mock.timers.tick(1100);
  assert.equal(el.textContent, 'Copied!', 'the second copy cancelled the first revert timer');

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
  assert.equal(el.classList.contains('text-gray-500'), false, 'idle class removed while flashed');

  mock.timers.tick(2000);
  assert.equal(el.textContent, '');
  assert.equal(el.classList.contains('text-gray-500'), true, 'idle class restored after revert');
});

/** A rejected clipboard write flashes the failure label and reverts, never latching "Copied!". */
test('a rejected clipboard write flashes the failure label, not "Copied!"', async () => {
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

  const el = fakeButton('Copy');
  const ok = await copyWithFeedback('x', {
    element: el, copiedText: 'Copied!', failedText: 'Copy failed', revertMs: 1500,
  });
  assert.equal(ok, false, 'copy reports failure');
  assert.equal(el.textContent, 'Copy failed', 'failure label flashed, not "Copied!"');

  mock.timers.tick(2000);
  assert.equal(el.textContent, 'Copy', 'element reverts to idle');
});

/** Verifies the legacy textarea path copies and removes its temporary node. */
test('copyToClipboard falls back to execCommand', async () => {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    configurable: true,
  });
  const body = fakeElement('body');
  let textarea;
  let command;
  installDocument({
    body,
    createElement: (tag) => {
      textarea = fakeElement(tag);
      textarea.focus = () => { textarea.focused = true; };
      textarea.select = () => { textarea.selected = true; };
      return textarea;
    },
    execCommand: (name) => {
      command = name;
      assert.equal(body.children[0], textarea);
      return true;
    },
  });

  assert.equal(await copyToClipboard('legacy text'), true);
  assert.equal(command, 'copy');
  assert.equal(textarea.value, 'legacy text');
  assert.equal(textarea.focused, true);
  assert.equal(textarea.selected, true);
  assert.equal(body.children.length, 0);
});

/** The fallback's temporary textarea must hand focus back to the trigger. */
test('copyToClipboard restores focus after the execCommand fallback', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  const trigger = fakeElement('button');
  let refocused = false;
  trigger.focus = () => { refocused = true; };
  installDocument({
    activeElement: trigger,
    body: fakeElement('body'),
    createElement: (tag) => {
      const element = fakeElement(tag);
      element.focus = () => {};
      element.select = () => {};
      return element;
    },
    execCommand: () => {
      assert.equal(refocused, false, 'focus returns only after the copy');
      return true;
    },
  });

  assert.equal(await copyToClipboard('legacy text'), true);
  assert.equal(refocused, true, 'the trigger regained focus');
});

test('copyToClipboard falls back after an async clipboard rejection', async () => {
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: { writeText: async () => { throw new Error('denied'); } },
    },
    configurable: true,
  });
  let command;
  installDocument({
    body: fakeElement('body'),
    createElement: (tag) => {
      const element = fakeElement(tag);
      element.focus = () => {};
      element.select = () => {};
      return element;
    },
    execCommand: (name) => {
      command = name;
      return true;
    },
  });

  assert.equal(await copyToClipboard('fallback text'), true);
  assert.equal(command, 'copy');
});

/** Verifies both wireCopyBlock triggers copy the source and flash the prompt. */
test('wireCopyBlock wires the button and block triggers', async () => {
  const writes = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { writes.push(text); } } },
    configurable: true,
  });

  const source = fakeElement('code');
  source.textContent = 'generated output';
  const button = fakeElement('button');
  const block = fakeElement('pre');
  const prompt = fakeElement('span');

  const detach = wireCopyBlock({ source, button, prompt, block });
  button.dispatch('click');
  await Promise.resolve();
  block.dispatch('click');
  await Promise.resolve();

  assert.equal(block.tabIndex, -1);
  assert.equal(block.getAttribute('role'), null);
  assert.equal(block.getAttribute('aria-label'), null);
  let prevented = 0;
  for (const key of ['Enter', ' ', 'Tab']) {
    if (block.dispatch('keydown', { key }).defaultPrevented) prevented++;
    await Promise.resolve();
  }
  assert.equal(prevented, 0);
  assert.deepEqual(writes, Array(2).fill('generated output'));
  assert.equal(prompt.textContent, 'Copied!');
  detach();
  button.dispatch('click');
  block.dispatch('click');
  await Promise.resolve();
  assert.equal(writes.length, 2);
});
