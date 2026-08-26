//
// fake_dom.js's event propagation and value coercion, pinned on their own.
// Fifteen suites dispatch and assert through this fake, so a listener that runs
// at the wrong attachment point, a stopPropagation that stops nothing, or a
// property handing back a type no browser produces would all read there as
// assertions about the module under test rather than about the harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  documentEvents, fakeElement, installAnimationFrames, installDocument,
  restoreDocumentAfterEach,
} from './fake_dom.js';

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

test('the dispatched event carries the type and a default a handler can cancel', () => {
  const { leaf, mid } = chain();
  const seen = [];
  mid.addEventListener('keydown', (e) => seen.push([e.type, e.defaultPrevented]));
  leaf.addEventListener('keydown', (e) => {
    seen.push([e.type, e.defaultPrevented]);
    e.preventDefault();
  });

  // The caller names a type of its own; the dispatched one is what listeners see.
  const cancelled = leaf.dispatch('keydown', { type: 'click', key: 'Enter' });

  assert.deepEqual(seen, [['keydown', false], ['keydown', true]],
    'the flag is unset until a handler sets it');
  assert.equal(cancelled.defaultPrevented, true);
  assert.equal(cancelled.key, 'Enter', 'the caller-supplied fields ride along');
  assert.equal(leaf.dispatch('click').defaultPrevented, false,
    'an event nobody cancels reports its default intact');
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

test('a disabled control ignores a click while its ancestors still see it', () => {
  const { leaf, log, listen } = chain();
  listen('root', 'root');
  listen('mid', 'mid');
  listen('leaf', 'leaf');
  leaf.disabled = true;

  leaf.dispatch('click');

  assert.deepEqual(log, ['mid', 'root'], 'the disabled node runs none of its own');
});

test('a disabled control still runs its listeners for events disabling never gates', () => {
  const leaf = fakeElement('button');
  const seen = [];
  for (const type of ['click', 'keydown', 'pointerdown', 'input', 'change',
    'focusin', 'focusout', 'chain-applied']) {
    leaf.addEventListener(type, () => seen.push(type));
  }
  leaf.disabled = true;

  for (const type of ['click', 'keydown', 'pointerdown', 'input', 'change',
    'focusin', 'focusout', 'chain-applied']) leaf.dispatch(type);

  assert.deepEqual(seen, ['focusin', 'focusout', 'chain-applied']);
});

test('a disabled flag on a tag that carries no such attribute gates nothing', () => {
  const div = fakeElement('div');
  const seen = [];
  div.addEventListener('click', () => seen.push('click'));
  div.disabled = true;

  div.dispatch('click');

  assert.deepEqual(seen, ['click'], 'a div is clickable whatever the expando says');
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

test('tabIndex reflects the attribute and browser focus defaults', () => {
  const box = fakeElement('div');
  assert.equal(box.tabIndex, -1);
  box.setAttribute('tabindex', '0');
  assert.equal(box.tabIndex, 0);
  box.tabIndex = -1;
  assert.equal(box.getAttribute('tabindex'), '-1');

  assert.equal(fakeElement('button').tabIndex, 0);
  assert.equal(fakeElement('a').tabIndex, -1);
  const link = fakeElement('a');
  link.setAttribute('href', '/');
  assert.equal(link.tabIndex, 0);
});

test('id and class reflect between attributes and properties', () => {
  const el = fakeElement('div');

  el.id = 'property-id';
  assert.equal(el.getAttribute('id'), 'property-id');
  el.setAttribute('id', 'attribute-id');
  assert.equal(el.id, 'attribute-id');

  el.className = 'alpha beta';
  assert.equal(el.getAttribute('class'), 'alpha beta');
  el.setAttribute('class', 'gamma');
  assert.equal(el.className, 'gamma');
  assert.equal(el.classList.contains('gamma'), true);
  el.classList.add('delta');
  assert.equal(el.getAttribute('class'), 'gamma delta');
});

test('dataset is a stringifying view over the element data- attributes', () => {
  const el = fakeElement('div');

  el.dataset.index = 3;
  el.dataset.sortLabel = 'name';

  assert.equal(el.dataset.index, '3');
  assert.equal(el.getAttribute('data-index'), '3',
    'a dataset write is a data- attribute write');
  assert.equal(el.getAttribute('data-sort-label'), 'name',
    'camelCase keys map to hyphenated attributes');
  assert.deepEqual(Object.keys(el.dataset), ['index', 'sortLabel']);

  el.setAttribute('data-index', '4');
  assert.equal(el.dataset.index, '4', 'the attribute is the backing store');

  delete el.dataset.index;
  assert.equal(el.getAttribute('data-index'), null);
  assert.equal(el.dataset.index, undefined);
  assert.equal('missing' in el.dataset, false);
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

test('an unmeasured element reports the zero box every Element carries', () => {
  const el = fakeElement('div');
  assert.deepEqual(
    [el.clientWidth, el.clientHeight, el.offsetWidth, el.offsetHeight,
      el.offsetLeft, el.offsetTop, el.scrollWidth, el.scrollHeight,
      el.scrollLeft, el.scrollTop],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(el.getBoundingClientRect(),
    { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
});

test('getBoundingClientRect reports the offset box a test writes', () => {
  const el = fakeElement('div');
  Object.assign(el, { offsetLeft: 40, offsetTop: 12, offsetWidth: 200, offsetHeight: 30 });
  assert.deepEqual(el.getBoundingClientRect(),
    { x: 40, y: 12, left: 40, top: 12, right: 240, bottom: 42, width: 200, height: 30 });
});

test('style keeps only the values a browser would keep', () => {
  const el = fakeElement('div');

  assert.throws(() => { el.style['font-size'] = '10px'; }, /keyed camelCase/,
    'a dashed name declares nothing, so no read would ever find it');

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

test('replaceChildren moves a node out of the parent it came from', () => {
  const from = fakeElement('div');
  const to = fakeElement('div');
  const moved = fakeElement('span');
  const dropped = fakeElement('span');
  from.append(moved);
  to.append(dropped);

  to.replaceChildren(moved);

  assert.deepEqual(from.children, [], 'the old parent must not still list the node');
  assert.deepEqual(to.children, [moved]);
  assert.equal(moved.parentNode, to);
  assert.equal(dropped.parentNode, null);
});

test('appended text lands in childNodes and never in children', () => {
  const box = fakeElement('div');
  const span = fakeElement('span');
  box.append('lead ', span, ' tail');

  assert.deepEqual(box.childNodes, ['lead ', span, ' tail']);
  assert.deepEqual(box.children, [span]);
  assert.equal(box.firstElementChild, span, 'a leading text node is not the first element');

  box.removeChild(span);
  assert.deepEqual(box.childNodes, ['lead ', ' tail']);
  assert.deepEqual(box.children, []);
  assert.equal(box.firstElementChild, null);
});

test('insertBefore places a node ahead of a child and moves it out of its old parent', () => {
  const from = fakeElement('div');
  const box = fakeElement('div');
  const first = fakeElement('span');
  const last = fakeElement('span');
  const moved = fakeElement('em');
  box.append(first, last);
  from.append(moved);

  box.insertBefore(moved, last);
  assert.deepEqual(box.childNodes, [first, moved, last]);
  assert.deepEqual(from.childNodes, [], 'the old parent still lists the node');
  assert.equal(moved.parentNode, box);

  box.insertBefore(moved, null);
  assert.deepEqual(box.childNodes, [first, last, moved], 'a null reference appends');

  assert.throws(() => box.insertBefore(fakeElement('b'), fakeElement('b')),
    /not a child/, 'a reference outside the parent was accepted');
});

test('removeChild refuses a node that is not a child', () => {
  const box = fakeElement('div');
  const other = fakeElement('div');
  const child = fakeElement('span');
  other.appendChild(child);

  assert.throws(() => box.removeChild(child), /not a child/,
    'a removal aimed at the wrong parent was accepted');
  assert.deepEqual(other.childNodes, [child], 'the real parent dropped the node');
  assert.equal(child.parentNode, other, 'the node lost its parent link');
});

test('appendChild refuses a string the way the platform does', () => {
  const box = fakeElement('div');
  assert.throws(() => box.appendChild('text'), TypeError);
  assert.deepEqual(box.childNodes, [], 'the rejected node was still inserted');
});

test('a freshly created node is disconnected until it reaches the page', () => {
  const page = fakeElement('div', { connected: true });
  const made = fakeElement('span');
  assert.equal(made.isConnected, false, 'an unappended element read as connected');
  page.append(made);
  assert.equal(made.isConnected, true);
});

// A liveness check reads isConnected off the node it cached, which is usually a
// descendant of the container the page swapped, not the node the swap named.
test('every detaching mutator disconnects the subtree it evicts', () => {
  const root = fakeElement('div', { connected: true });
  const branch = fakeElement('div');
  const leaf = fakeElement('span');
  root.appendChild(branch);
  branch.appendChild(leaf);
  assert.equal(leaf.isConnected, true);

  root.removeChild(branch);
  assert.equal(branch.isConnected, false, 'removeChild left the node connected');
  assert.equal(leaf.isConnected, false, 'a removed subtree stayed connected below its root');

  root.appendChild(branch);
  assert.equal(leaf.isConnected, true, 're-appending did not reconnect the subtree');

  root.replaceChildren(fakeElement('span'));
  assert.equal(branch.isConnected, false, 'replaceChildren left the evicted node connected');
  assert.equal(leaf.isConnected, false);
});

// A list that reorders itself by re-appending its rows moves the focused row
// through a removal, so the focus a real browser drops there must drop here too.
test('focus tracks the document, and unparenting the focused node blurs it', () => {
  const doc = installDocument({ activeElement: null });
  const list = fakeElement('div');
  const row = fakeElement('button');
  const label = fakeElement('span');
  list.appendChild(row);
  row.appendChild(label);

  row.focus();
  assert.equal(doc.activeElement, row);
  assert.equal(row.focusOptions, undefined, 'a bare focus() recorded an options bag');
  row.focus({ preventScroll: true });
  assert.deepEqual(row.focusOptions, { preventScroll: true },
    'the options bag focus() was handed is not readable');

  list.appendChild(row); // a move, not an insert
  assert.equal(doc.activeElement, null, 'the re-append kept focus on the moved node');
  assert.deepEqual(list.children, [row], 'the move still listed the node once');

  row.focus();
  list.removeChild(row);
  assert.equal(doc.activeElement, null);

  list.appendChild(row);
  label.focus();
  list.replaceChildren();
  assert.equal(doc.activeElement, null, 'a focused descendant kept focus through the eviction');
});

test('a node moved between parents stays connected; remove() disconnects it', () => {
  const from = fakeElement('div', { connected: true });
  const to = fakeElement('div', { connected: true });
  const moved = fakeElement('span');
  from.append(moved);
  to.append(moved);
  assert.equal(moved.isConnected, true, 'a move through append read as a detach');

  moved.remove();
  assert.equal(moved.isConnected, false);
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

test("an <option>'s value falls back to its text until one is assigned", () => {
  const option = fakeElement('option');
  option.textContent = 'Kis';
  assert.equal(option.value, 'Kis');

  option.value = 'kis';
  assert.equal(option.value, 'kis', 'an assigned value wins over the text');
  assert.equal(option.textContent, 'Kis', 'assigning a value leaves the text alone');

  option.textContent = 'Ambo';
  assert.equal(option.value, 'kis', 'the fallback does not come back');

  option.value = 7;
  assert.equal(option.value, '7', 'the value is a DOMString');

  const empty = fakeElement('option');
  assert.equal(empty.value, '', 'no text and no value reads as the empty string');
  assert.equal(empty.selected, false);
});

test('a <select> shows its first option until one is explicitly selected', () => {
  const empty = fakeElement('select');
  assert.deepEqual(empty.options, []);
  assert.deepEqual(empty.selectedOptions, []);
  assert.equal(empty.selectedIndex, -1);
  assert.equal(empty.value, '');

  const select = selectOf(['a', 'b', 'c']);
  assert.deepEqual(select.options.map((option) => option.value), ['a', 'b', 'c']);
  assert.deepEqual(select.selectedOptions.map((option) => option.value), ['a'],
    'a populated select already has a selection');
  assert.equal(select.selectedIndex, 0);
  assert.equal(select.value, 'a');

  select.options[2].selected = true;
  assert.deepEqual(select.selectedOptions.map((option) => option.value), ['c'],
    'an explicit selection displaces the implicit first option');
  assert.equal(select.selectedIndex, 2);
  assert.equal(select.value, 'c');
});

test('the <select> views are live over the option children', () => {
  const select = selectOf(['a', 'b']);
  select.options[1].selected = true;
  assert.equal(select.value, 'b');

  const added = fakeElement('option');
  added.value = 'c';
  select.appendChild(added);
  assert.equal(select.options.length, 3, 'the view reads the children, not a snapshot');
  assert.equal(select.value, 'b', 'appending does not move the selection');

  select.appendChild(fakeElement('span'));
  assert.deepEqual(select.options.map((option) => option.value), ['a', 'b', 'c'],
    'a non-option child is not an option');

  select.replaceChildren();
  assert.equal(select.selectedIndex, -1);
  assert.equal(select.value, '');
});

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
  assert.deepEqual(select.selectedOptions.map((option) => option.value), ['a'],
    'with nothing selected the first option shows again');
  assert.equal(select.selectedIndex, 0);
});

test('documentEvents runs the handlers of one type in registration order', () => {
  const doc = installDocument({});
  const events = documentEvents();
  const log = [];
  const first = () => log.push('first');
  const second = () => log.push('second');
  events.addEventListener('keydown', first);
  events.addEventListener('keydown', second);
  events.addEventListener('pointerdown', () => log.push('pointer'));

  assert.equal(events.listenerCount('keydown'), 2);
  assert.equal(events.listenerCount('wheel'), 0);

  const dispatched = events.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(log, ['first', 'second'], 'only the matching type ran');
  assert.equal(dispatched.type, 'keydown');
  assert.equal(dispatched.key, 'Escape');
  assert.equal(dispatched.target, doc, 'the target defaults to the installed document');

  log.length = 0;
  events.removeEventListener('keydown', first);
  events.dispatch('keydown');
  assert.deepEqual(log, ['second']);
  assert.equal(events.listenerCount('keydown'), 1);

  const supplied = { target: fakeElement('input') };
  assert.equal(events.dispatch('pointerdown', supplied).target, supplied.target,
    'a supplied target wins over the document');
  assert.equal(events.dispatch('pointerdown', { type: 'wheel' }).type, 'pointerdown',
    'the dispatched type wins over a supplied one');
});

test('a document event carries the default and propagation controls', () => {
  installDocument({});
  const events = documentEvents();
  const log = [];
  events.addEventListener('keydown', (event) => {
    log.push('first');
    event.preventDefault();
  });
  events.addEventListener('keydown', (event) => {
    log.push('second');
    event.stopPropagation();
    event.stopImmediatePropagation();
  });
  events.addEventListener('keydown', () => log.push('third'));

  const dispatched = events.dispatch('keydown');
  assert.deepEqual(log, ['first', 'second'],
    'stopImmediatePropagation drops the listeners still to run');
  assert.equal(dispatched.defaultPrevented, true);
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

// A browser hands every frame callback the timestamp it fires at; one that read
// an undefined argument would compute NaN deltas here and animate here alone.
test('installAnimationFrames hands each callback a frame timestamp', () => {
  const frames = installAnimationFrames();
  try {
    const stamps = [];
    requestAnimationFrame((timestamp) => stamps.push(timestamp));
    requestAnimationFrame((timestamp) => stamps.push(timestamp));
    frames.flush(1234.5);
    assert.deepEqual(stamps, [1234.5, 1234.5], 'one clock reading per frame');

    requestAnimationFrame((timestamp) => stamps.push(timestamp));
    frames.flush();
    assert.equal(typeof stamps[2], 'number', 'an undriven flush still reads a clock');
    assert.ok(stamps[2] > 0);
  } finally {
    frames.restore();
  }
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
