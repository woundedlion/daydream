//
// fake_dom.js's event propagation, pinned on its own. Fifteen suites dispatch
// through this fake, and a listener that runs at the wrong attachment point —
// or a stopPropagation that stops nothing — would read there as an assertion
// about the module under test rather than about the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';

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

test('the target node runs both capture and bubble listeners in registration order', () => {
  const { leaf, log, listen } = chain();
  listen('leaf', 'second', false);
  listen('leaf', 'first', true);

  leaf.dispatch('click');

  assert.deepEqual(log, ['second', 'first'],
    'at the target the capture flag orders nothing, as in the DOM');
});

test('every listener sees the dispatching node as target and its own node as currentTarget', () => {
  const { root, mid, leaf } = chain();
  const seen = [];
  const record = (node) => node.addEventListener('click',
    (e) => seen.push([e.target, e.currentTarget]));
  record(root);
  record(mid);
  record(leaf);

  leaf.dispatch('click');

  assert.deepEqual(seen, [[leaf, leaf], [leaf, mid], [leaf, root]]);
});

test('a caller-named target overrides the dispatching node', () => {
  const { mid, log, listen } = chain();
  const detached = fakeElement('span');
  let target = null;
  listen('mid', 'mid', false, (e) => { target = e.target; });

  mid.dispatch('click', { target: detached });

  assert.deepEqual(log, ['mid']);
  assert.equal(target, detached);
});

test('stopPropagation halts the walk but leaves the current node listeners running', () => {
  const { leaf, log, listen } = chain();
  listen('leaf', 'leaf-stops', false, (e) => e.stopPropagation());
  listen('leaf', 'leaf-after');
  listen('mid', 'mid-bubble');
  listen('root', 'root-bubble');

  leaf.dispatch('click');

  assert.deepEqual(log, ['leaf-stops', 'leaf-after']);
});

test('stopPropagation during capture keeps the event from reaching the target', () => {
  const { leaf, log, listen } = chain();
  listen('root', 'root-capture', true, (e) => e.stopPropagation());
  listen('mid', 'mid-capture', true);
  listen('leaf', 'leaf');

  leaf.dispatch('click');

  assert.deepEqual(log, ['root-capture']);
});

test('stopImmediatePropagation also drops the rest of the current node listeners', () => {
  const { leaf, log, listen } = chain();
  listen('leaf', 'leaf-stops', false, (e) => e.stopImmediatePropagation());
  listen('leaf', 'leaf-after');
  listen('root', 'root-bubble');

  leaf.dispatch('click');

  assert.deepEqual(log, ['leaf-stops']);
});

test('the event owns its stop methods, so a caller-supplied one cannot disarm them', () => {
  const { leaf, log, listen } = chain();
  listen('leaf', 'leaf', false, (e) => e.stopPropagation());
  listen('root', 'root-bubble');

  leaf.dispatch('click', { stopPropagation: () => {} });

  assert.deepEqual(log, ['leaf'], 'propagation stopped despite the supplied no-op');
});

test('a non-bubbling event reaches the target and its capturing ancestors only', () => {
  const { leaf, log, listen } = chain();
  listen('root', 'root-capture', true);
  listen('leaf', 'leaf');
  listen('mid', 'mid-bubble');

  leaf.dispatch('click', { bubbles: false });

  assert.deepEqual(log, ['root-capture', 'leaf']);
});

test('a removed subtree propagates within itself and no further', () => {
  const { mid, leaf, log, listen } = chain();
  listen('root', 'root-bubble');
  listen('mid', 'mid-bubble');
  listen('leaf', 'leaf');
  mid.remove();

  leaf.dispatch('click');

  assert.deepEqual(log, ['leaf', 'mid-bubble'],
    'the removed subtree keeps its own parent links and loses the root');
});

test('a {once} ancestor listener drops after the bubbled event runs it', () => {
  const { root, leaf, log, listen } = chain();
  listen('root', 'root-once', { once: true });

  leaf.dispatch('click');
  leaf.dispatch('click');

  assert.deepEqual(log, ['root-once']);
  assert.deepEqual(root.listeners, []);
});

test('a listener an earlier handler removed does not run', () => {
  const { root, leaf, log, listen } = chain();
  const later = () => log.push('root-later');
  listen('leaf', 'leaf', false, () => root.removeEventListener('click', later));
  root.addEventListener('click', later);

  leaf.dispatch('click');

  assert.deepEqual(log, ['leaf']);
});
