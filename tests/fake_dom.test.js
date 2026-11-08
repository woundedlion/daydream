// fake_dom.js behaviour other suites rely on, pinned on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentEvents, fakeElement, installAnimationFrames, installDocument,
  restoreDocumentAfterEach,
} from './helpers/fake_dom.js';

restoreDocumentAfterEach();

/**
 * Builds a root > mid > leaf chain whose every listener appends to one log.
 * @returns {{root: Object, mid: Object, leaf: Object, log: Array<string>,
 *   listen: Function}} The chain, the log, and a listener-adding helper.
 */
function chain() {
  const root = fakeElement('div');
  const mid = fakeElement('div');
  const leaf = fakeElement('button');
  root.appendChild(mid);
  mid.appendChild(leaf);
  const log = [];
  const named = { root, mid, leaf };
  /**
   * @param {string} name - Which node of the chain to listen on.
   * @param {string} tag - Label appended to the log when the listener runs.
   * @param {boolean|Object} [options] - addEventListener's third argument.
   * @param {Function} [body] - Extra work, given the event.
   */
  const listen = (name, tag, options, body) => {
    named[name].addEventListener('click', (e) => {
      log.push(tag);
      if (body) body(e);
    }, options);
  };
  return { root, mid, leaf, log, listen };
}

test('an event runs capture root-first, then the target, then bubbles back up', () => {
  const { leaf, log, listen } = chain();
  listen('root', 'root-capture', true);
  listen('mid', 'mid-capture', true);
  listen('leaf', 'leaf-capture', true);
  listen('leaf', 'leaf-bubble');
  listen('mid', 'mid-bubble');
  listen('root', 'root-bubble');

  leaf.dispatch('click');

  assert.deepEqual(log, [
    'root-capture', 'mid-capture',
    'leaf-capture', 'leaf-bubble',
    'mid-bubble', 'root-bubble',
  ]);
});

test('a disabled control gates activation and input while allowing pointer and focus events', () => {
  const leaf = fakeElement('button');
  const seen = [];
  for (const type of ['click', 'keydown', 'pointerdown', 'input', 'change',
    'focusin', 'focusout', 'chain-applied']) {
    leaf.addEventListener(type, () => seen.push(type));
  }
  leaf.disabled = true;

  for (const type of ['click', 'keydown', 'pointerdown', 'input', 'change',
    'focusin', 'focusout', 'chain-applied']) leaf.dispatch(type);

  assert.deepEqual(seen, ['pointerdown', 'focusin', 'focusout', 'chain-applied']);
});

test('textContent and setAttribute hand back the strings a browser stores', () => {
  const el = fakeElement('div');
  const stale = fakeElement('span');
  el.append(stale);

  el.textContent = 7;
  assert.equal(el.textContent, '7');
  assert.deepEqual(el.childNodes, ['7']);
  assert.equal(stale.parentNode, null, 'the replaced child stayed parented');
  el.textContent = null;
  assert.equal(el.textContent, '', 'null reads back as the empty string');
  assert.deepEqual(el.childNodes, []);
  el.textContent = undefined;
  assert.equal(el.textContent, '');

  el.setAttribute('tabindex', -1);
  assert.equal(el.getAttribute('tabindex'), '-1');
});

test('a dataset write is reachable by an [attr] selector', () => {
  const parent = fakeElement('div');
  const tagged = fakeElement('span');
  const bare = fakeElement('span');
  parent.append(tagged, bare);
  tagged.dataset.index = 0;

  assert.deepEqual(parent.querySelectorAll('[data-index]'), [tagged]);
  assert.equal(tagged.matches('[data-index]'), true);
  assert.equal(bare.matches('[data-index]'), false);
});

test('a selector the fake does not implement throws instead of matching nothing', () => {
  const el = fakeElement('span');
  el.className = 'op-row';
  el.dataset.index = 0;

  assert.throws(() => el.matches('.op-row.selected'), /unsupported selector/,
    'a compound class selector would otherwise never match');
  assert.throws(() => el.matches('[data-index="0"]'), /unsupported selector/,
    'an attribute-value selector would otherwise never match');
  assert.equal(el.matches('.op-row'), true);
  assert.equal(el.matches('[data-index]'), true);
});

test('a removal with no listener behind it throws unless the fixture opts out', () => {
  const strict = fakeElement('div');
  const handler = () => {};
  assert.throws(() => strict.removeEventListener('click', handler), /no click listener/,
    'a removal that never had an add to pair with would otherwise pass silently');

  const lenient = fakeElement('div', { allowRedundantRemoval: true });
  lenient.addEventListener('click', handler);
  lenient.removeEventListener('click', handler);
  assert.doesNotThrow(() => lenient.removeEventListener('click', handler),
    'an idempotent disposal cannot be driven twice');
  assert.deepEqual(lenient.listeners, [], 'the second removal put the listener back');
});

test('style keeps only the values a browser would keep', () => {
  const el = fakeElement('div');

  assert.throws(() => { el.style['font-size'] = '10px'; }, /fake style models camelCase keys only/,
    'the fake rejects dashed property names');

  assert.equal(el.style.position, '', 'an undeclared property is the empty string');

  el.style.display = 'grid';
  el.style.display = 'blink';
  assert.equal(el.style.display, 'grid', 'a value no browser parses read back as set');
  el.style.display = '';
  assert.equal(el.style.display, '', 'clearing the declaration was dropped');

  el.style.opacity = 0;
  assert.equal(el.style.opacity, '0', 'the platform stores a DOMString');

  el.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
  el.style.gridTemplateColumns = 'repeat(0, minmax(0, 1fr))';
  assert.equal(el.style.gridTemplateColumns, 'repeat(3, minmax(0px, 1fr))',
    'a zero repetition count is a track list no browser lays out');

  el.style.left = '12px';
  el.style.left = `${Number.NaN}px`;
  assert.equal(el.style.left, '12px', 'an interpolated NaN read back as a length');

  // The interpolation and paren checks cover every property, grammar or not.
  el.style.width = '40px';
  el.style.width = `${undefined}px`;
  assert.equal(el.style.width, '40px');
  el.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4)';
  el.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.4';
  assert.equal(el.style.boxShadow, '0 2px 8px rgba(0, 0, 0, 0.4)',
    'an unclosed function read back as written');
});

/**
 * A <select> populated with options carrying the given values.
 * @param {Array<string>} values - One option per entry, text and value alike.
 * @returns {Object} The select.
 */
function selectOf(values) {
  const select = fakeElement('select');
  for (const value of values) {
    const option = fakeElement('option');
    option.textContent = value;
    select.appendChild(option);
  }
  return select;
}

test('selectedIndex and value are the two writable views of one selection', () => {
  const select = selectOf(['a', 'b', 'c']);

  select.selectedIndex = 1;
  assert.equal(select.value, 'b');
  assert.deepEqual(select.options.map((option) => option.selected),
    [false, true, false], 'the write is exclusive');

  select.value = 'c';
  assert.equal(select.selectedIndex, 2);
  assert.deepEqual(select.options.map((option) => option.selected),
    [false, false, true]);

  select.value = 'missing';
  assert.deepEqual(select.options.map((option) => option.selected),
    [false, false, false], 'an unknown value selects nothing');
  assert.deepEqual(select.selectedOptions, []);
  assert.equal(select.selectedIndex, -1);
  assert.equal(select.value, '');
});

test('documentEvents refuses a removal with no listener behind it', () => {
  const events = documentEvents();
  const handler = () => {};
  assert.throws(() => events.removeEventListener('keydown', handler),
    /no keydown listener on the document to remove/);

  events.addEventListener('keydown', handler);
  events.removeEventListener('keydown', handler);
  assert.equal(events.listenerCount('keydown'), 0);
  assert.throws(() => events.removeEventListener('keydown', handler),
    /no keydown listener on the document to remove/);
});

test('installAnimationFrames queues callbacks until a flush runs them', () => {
  const saved = globalThis.requestAnimationFrame;
  const frames = installAnimationFrames();
  try {
    const log = [];
    assert.equal(frames.pending, 0);

    const first = requestAnimationFrame(() => log.push('first'));
    const second = requestAnimationFrame(() => log.push('second'));
    assert.notEqual(first, second, 'each request answers its own handle');
    assert.equal(frames.pending, 2);
    assert.deepEqual(log, [], 'nothing runs before the flush');

    cancelAnimationFrame(first);
    assert.equal(frames.pending, 1);
    frames.flush();
    assert.deepEqual(log, ['second']);
    assert.equal(frames.pending, 0, 'a flush empties the queue');

    requestAnimationFrame(() => {
      log.push('outer');
      requestAnimationFrame(() => log.push('inner'));
    });
    frames.flush();
    assert.deepEqual(log, ['second', 'outer'],
      'a frame requested during a flush waits for the next one');
    assert.equal(frames.pending, 1);
    frames.flush();
    assert.deepEqual(log, ['second', 'outer', 'inner']);
  } finally {
    frames.restore();
  }
  assert.equal(globalThis.requestAnimationFrame, saved,
    'restore hands the globals back');
});

test('focus respects native tags, tabindex, and disabled state', () => {
  const body = fakeElement('body', { connected: true });
  const doc = installDocument({ ...documentEvents(), body });
  const button = fakeElement('button', { connected: true });
  const div = fakeElement('div', { connected: true });
  button.focus();
  assert.equal(doc.activeElement, button);
  div.focus();
  assert.equal(doc.activeElement, button);
  div.tabIndex = -1;
  div.focus();
  assert.equal(doc.activeElement, div);
  button.focus();
  button.disabled = true;
  assert.equal(doc.activeElement, body);
  button.focus();
  assert.equal(doc.activeElement, body);
});
