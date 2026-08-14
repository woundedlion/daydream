import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EffectSidebar } from '../sidebar.js';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

// EffectSidebar's DOM-lifecycle methods (constructor, setEffects, applySortOrder,
// setActive, updateScrollArrows, dispose) touch the DOM only through a narrow set
// of node methods. There is no jsdom, so this file constructs a real sidebar over
// the shared fake nodes and asserts the leak-prevention contract: dispose detaches
// every listener/observer and clears every ref the constructor created.

const observers = [];
class FakeResizeObserver {
  constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = false; observers.push(this); }
  observe(el) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
}

const rafCallbacks = new Map();
let rafId = 0;
const cancelledRaf = [];

const saved = {
  ResizeObserver: globalThis.ResizeObserver,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};

function installDom() {
  observers.length = 0;
  rafCallbacks.clear();
  cancelledRaf.length = 0;
  rafId = 0;
  installDocument({ createElement: (tag) => fakeElement(tag), activeElement: null });
  globalThis.ResizeObserver = FakeResizeObserver;
  // Defer, matching the browser: store the callback but do not run it, so
  // setEffects' scroll-arrow measurement does not fire synchronously.
  globalThis.requestAnimationFrame = (cb) => { const id = ++rafId; rafCallbacks.set(id, cb); return id; };
  globalThis.cancelAnimationFrame = (id) => { cancelledRaf.push(id); rafCallbacks.delete(id); };
}

restoreDocumentAfterEach();

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
});

function makeSidebar() {
  installDom();
  const container = fakeElement('div');
  container.ownerDocument = globalThis.document;
  const selected = [];
  const sidebar = new EffectSidebar(container, (name) => selected.push(name));
  return { sidebar, container, selected };
}

test('constructor mounts its five nodes and wires listeners + observer', () => {
  const { sidebar, container } = makeSidebar();
  // heading, sortRow, listEl, arrowLeft, arrowRight.
  assert.equal(container.children.length, 5);
  assert.ok(container.children.includes(sidebar.listEl));
  // keydown + scroll listeners on the list.
  assert.deepEqual(sidebar.listEl.listeners.map((l) => l.type).sort(), ['keydown', 'scroll']);
  assert.equal(observers.length, 1);
  assert.deepEqual(observers[0].observed, [sidebar.listEl]);
});

test('setEffects builds one button per name and sizes only when > 0', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['Voronoi', 'Comets'], { Voronoi: 2048, Comets: 0 });
  assert.equal(sidebar.buttons.size, 2);
  assert.equal(sidebar.listEl.children.length, 2);
  assert.equal(sidebar.items.length, 2);
  // Voronoi (size>0): name span + size span; Comets (size 0): name span only.
  assert.equal(sidebar.buttons.get('Voronoi').children.length, 2);
  assert.equal(sidebar.buttons.get('Comets').children.length, 1);
  // No active effect yet: roving tab stop falls to the first option.
  assert.equal(sidebar.tabbableBtn, sidebar.listEl.children[0]);
  assert.equal(sidebar.tabbableBtn.tabIndex, 0);
});

test('setEffects rebuilds cleanly without leaking the old roster', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B', 'C'], {});
  const firstA = sidebar.buttons.get('A');
  sidebar.setEffects(['X', 'Y'], {});
  assert.equal(sidebar.buttons.size, 2);
  assert.equal(sidebar.listEl.children.length, 2);
  assert.ok(!sidebar.buttons.has('A'));
  // Old button was detached from the list (innerHTML='' cleared it).
  assert.equal(firstA.parentNode, null);
});

test('applySortOrder reorders the existing button nodes in place', () => {
  const { sidebar, selected } = makeSidebar();
  sidebar.setEffects(['Charlie', 'alpha', 'Bravo'], {});
  const order = () => sidebar.listEl.children.map((b) => b.dataset.effect);
  const bravo = sidebar.buttons.get('Bravo');
  const bravoClick = bravo.onclick;
  sidebar.setActive('Bravo');
  document.activeElement = bravo;

  sidebar.sortBy('name', 'asc');
  assert.deepEqual(order(), ['alpha', 'Bravo', 'Charlie']);
  sidebar.sortBy('name', 'desc');
  assert.deepEqual(order(), ['Charlie', 'Bravo', 'alpha']);

  // The node was moved, not recreated: the roster entry and the listed node are
  // still the button captured before the sorts.
  assert.equal(sidebar.buttons.get('Bravo'), bravo, 'the roster keeps the same node');
  assert.equal(sidebar.listEl.children[1], bravo, 'the list holds that same node');
  assert.equal(sidebar.buttons.size, 3);
  // Moving the node blurred it; the sort handed focus back.
  assert.equal(document.activeElement, bravo);
  assert.equal(bravo.focusCalls, 2, 'one restore per sort');
  assert.ok(sidebar.listEl.children.includes(document.activeElement),
    'the focused node is still in the list');
  // The roving tab stop is that node, so Tab still lands on the active effect.
  assert.equal(sidebar.tabbableBtn, bravo);
  assert.equal(bravo.tabIndex, 0);
  // The click closure attached at build time is untouched and still selects.
  assert.equal(bravo.onclick, bravoClick);
  bravo.onclick();
  assert.deepEqual(selected, ['Bravo']);
});

// Clicking a sort control sorts from outside the list. Focus belongs to the
// control the user is on, not to whichever option the reorder happened to move.
test('sortBy leaves focus on the sort control that drove it', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['Charlie', 'alpha'], {});
  document.activeElement = sidebar.nameBtn;

  sidebar.nameBtn.onclick();

  assert.equal(document.activeElement, sidebar.nameBtn);
  for (const btn of sidebar.buttons.values()) {
    assert.equal(btn.focusCalls, 0, 'a sort must not pull focus into the list');
  }
});

// sidebar_dom.test.js drives onKeyDown against a hand-built receiver. These go
// through the listener the constructor registered, so the wiring between the
// keydown event, the list's own query, and the roving tab stop is covered too.
test('Enter on the list selects the focused option and eats the native click', () => {
  const { sidebar, selected } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  document.activeElement = sidebar.buttons.get('B');

  const event = sidebar.listEl.dispatch('keydown', { key: 'Enter' });

  assert.deepEqual(selected, ['B']);
  assert.equal(event.defaultPrevented, true, 'a native click would double-select');
});

test('an arrow key on the list moves focus and the roving tab stop with it', () => {
  const { sidebar, selected } = makeSidebar();
  sidebar.setEffects(['A', 'B', 'C'], {});
  document.activeElement = sidebar.buttons.get('A');

  const event = sidebar.listEl.dispatch('keydown', { key: 'ArrowRight' });

  assert.equal(document.activeElement, sidebar.buttons.get('B'));
  assert.equal(sidebar.tabbableBtn, sidebar.buttons.get('B'));
  assert.equal(sidebar.buttons.get('B').tabIndex, 0);
  assert.equal(sidebar.buttons.get('A').tabIndex, -1);
  assert.deepEqual(selected, [], 'navigating is not selecting');
  assert.equal(event.defaultPrevented, true);
});

test('a key the list does not own passes through untouched', () => {
  const { sidebar, selected } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  const a = sidebar.buttons.get('A');
  document.activeElement = a;

  const event = sidebar.listEl.dispatch('keydown', { key: 'x' });

  assert.equal(event.defaultPrevented, false, 'typing still reaches the page');
  assert.deepEqual(selected, []);
  assert.equal(document.activeElement, a);
});

test('setActive toggles active/aria-selected on only the old and new buttons', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  sidebar.setActive('A');
  const a = sidebar.buttons.get('A');
  const b = sidebar.buttons.get('B');
  assert.ok(a.classList.contains('active'));
  assert.equal(a.getAttribute('aria-selected'), 'true');
  assert.equal(sidebar.tabbableBtn, a);
  assert.equal(a.tabIndex, 0);

  sidebar.setActive('B');
  assert.ok(!a.classList.contains('active'));
  assert.equal(a.getAttribute('aria-selected'), 'false');
  assert.ok(b.classList.contains('active'));
  assert.equal(b.getAttribute('aria-selected'), 'true');
  assert.equal(sidebar.activeName, 'B');
  assert.ok(b.scrollIntoViewCalls > 0);
  // Exactly one tab stop: the old anchor is demoted as the new one is promoted.
  assert.equal(a.tabIndex, -1);
  assert.equal(b.tabIndex, 0);
});

test('setEffects re-marks the active effect on its rebuilt button', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  sidebar.setActive('B');

  sidebar.setEffects(['A', 'B', 'C'], {}); // fresh nodes, same active name
  const b = sidebar.buttons.get('B');

  assert.ok(b.classList.contains('active'), 'the rebuilt button carries the active class');
  assert.equal(b.getAttribute('aria-selected'), 'true');
  // The roving tab stop follows the active effect, not the first option.
  assert.equal(sidebar.tabbableBtn, b);
  assert.equal(b.tabIndex, 0);
  assert.equal(sidebar.buttons.get('A').tabIndex, -1);
});

// A resolution change rebuilds the roster mid-keyboard-navigation. Focus left on
// <body> stops matching the list's keydown handler, and the next Space reaches
// the global one — pausing the simulation instead of selecting an effect.
test('setEffects returns focus to the rebuilt button of the focused option', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  document.activeElement = sidebar.buttons.get('B');

  sidebar.setEffects(['A', 'B', 'C'], {}); // fresh nodes, same names

  assert.equal(sidebar.buttons.get('B').focusCalls, 1);
  assert.equal(sidebar.buttons.get('A').focusCalls, 0, 'focus lands on one option');
});

test('setEffects falls back to the tab stop when the focused option is gone', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  sidebar.setActive('A');
  document.activeElement = sidebar.buttons.get('B');

  sidebar.setEffects(['A', 'C'], {}); // B left the roster

  assert.equal(sidebar.tabbableBtn, sidebar.buttons.get('A'));
  assert.equal(sidebar.tabbableBtn.focusCalls, 1, 'focus stays inside the list');
});

test('setEffects leaves focus alone when it was outside the list', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  const elsewhere = fakeElement('input');
  document.activeElement = elsewhere;

  sidebar.setEffects(['A', 'B'], {});

  assert.equal(elsewhere.focusCalls, 0);
  for (const btn of sidebar.buttons.values()) {
    assert.equal(btn.focusCalls, 0, 'a rebuild must not pull focus into the list');
  }
});

test('setActive keeps the current selection when the name is off-list', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  sidebar.setActive('A');
  const a = sidebar.buttons.get('A');

  sidebar.setActive('ZZZ'); // no such button

  assert.equal(sidebar.activeName, 'A', 'activeName is not stripped by an off-list name');
  assert.ok(a.classList.contains('active'), 'the active button stays selected');
  assert.equal(a.getAttribute('aria-selected'), 'true');
});

test('updateScrollArrows reflects scroll geometry', () => {
  const { sidebar } = makeSidebar();
  // No overflow: neither arrow visible.
  sidebar.listEl.scrollLeft = 0;
  sidebar.listEl.scrollWidth = 100;
  sidebar.listEl.clientWidth = 100;
  sidebar.updateScrollArrows();
  assert.ok(!sidebar.arrowLeft.classList.contains('visible'));
  assert.ok(!sidebar.arrowRight.classList.contains('visible'));
  // Overflow, scrolled to start: only the right arrow shows.
  sidebar.listEl.scrollWidth = 400;
  sidebar.updateScrollArrows();
  assert.ok(!sidebar.arrowLeft.classList.contains('visible'));
  assert.ok(sidebar.arrowRight.classList.contains('visible'));
  // Scrolled to the end: only the left arrow shows.
  sidebar.listEl.scrollLeft = 300;
  sidebar.updateScrollArrows();
  assert.ok(sidebar.arrowLeft.classList.contains('visible'));
  assert.ok(!sidebar.arrowRight.classList.contains('visible'));
});

test('sort controls expose the current order in their accessible name', () => {
  const { sidebar } = makeSidebar();
  const glyph = (btn) => btn.querySelector('.sort-glyph');

  // Only the active control carries a direction; the inactive one has none yet.
  assert.equal(sidebar.nameBtn.getAttribute('aria-label'), 'Sort by name, ascending');
  assert.equal(sidebar.sizeBtn.getAttribute('aria-label'), 'Sort by size');
  // The direction arrow is presentational; the name carries the direction.
  assert.equal(glyph(sidebar.nameBtn).getAttribute('aria-hidden'), 'true');
  assert.equal(glyph(sidebar.nameBtn).textContent, '▲');
  assert.equal(sidebar.nameBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(sidebar.sizeBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(sidebar.listEl.getAttribute('aria-label'), 'Effects, sorted by name ascending');

  sidebar.sortBy('size', 'desc');

  assert.equal(sidebar.nameBtn.getAttribute('aria-label'), 'Sort by name');
  assert.equal(sidebar.sizeBtn.getAttribute('aria-label'), 'Sort by size, descending');
  assert.equal(sidebar.nameBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(sidebar.sizeBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(glyph(sidebar.nameBtn).textContent, '⇅');
  assert.equal(glyph(sidebar.sizeBtn).textContent, '▼');
  assert.equal(sidebar.listEl.getAttribute('aria-label'), 'Effects, sorted by size descending');
});

test('dispose detaches every listener/observer and clears refs', () => {
  const { sidebar, container } = makeSidebar();
  sidebar.setEffects(['A', 'B'], { A: 1024 });
  const listEl = sidebar.listEl;
  const btnA = sidebar.buttons.get('A');
  const observer = observers[0];
  const raf = sidebar.scrollArrowsRaf;

  sidebar.dispose();

  // Listeners drained, observer disconnected and reference dropped.
  assert.equal(listEl.listeners.length, 0);
  assert.ok(observer.disconnected);
  assert.equal(sidebar.resizeObs, null);
  // The pending scroll-arrow rAF is cancelled.
  assert.ok(cancelledRaf.includes(raf));
  // Button click closures nulled, roster map emptied.
  assert.equal(btnA.onclick, null);
  assert.equal(sidebar.buttons.size, 0);
  assert.equal(sidebar.nameBtn.onclick, null);
  assert.equal(sidebar.sizeBtn.onclick, null);
  // Every node the constructor appended is detached from the container.
  assert.equal(container.children.length, 0);
  assert.equal(sidebar.heading.parentNode, null);
  assert.equal(sidebar.listEl.parentNode, null);
  assert.equal(sidebar.arrowRight.parentNode, null);
});
