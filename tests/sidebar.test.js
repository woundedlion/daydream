// @ts-check
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EffectSidebar } from '../sidebar.js';

// EffectSidebar's DOM-lifecycle methods (constructor, setEffects, applySortOrder,
// setActive, updateScrollArrows, dispose) touch the DOM only through a narrow set
// of node methods. There is no jsdom, so this file constructs a real sidebar over
// minimal fake nodes and asserts the leak-prevention contract: dispose detaches
// every listener/observer and clears every ref the constructor created.

// Minimal fake element: tracks children, listeners, classes, and removal so the
// lifecycle contract is observable. Only the surface sidebar.js actually calls.
class FakeEl {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.listeners = [];
    this.classes = new Set();
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.tabIndex = 0;
    this.onclick = null;
    this.parentNode = null;
    this.scrollLeft = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.removed = false;
    this.scrolledIntoView = 0;
    this.innerHTMLSetCount = 0;
    this.classList = {
      add: (c) => this.classes.add(c),
      remove: (c) => this.classes.delete(c),
      toggle: (c, on) => { if (on) this.classes.add(c); else this.classes.delete(c); },
      contains: (c) => this.classes.has(c),
    };
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    this.children.push(c);
    c.parentNode = this;
    return c;
  }
  removeChild(c) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    if (c.parentNode === this) c.parentNode = null;
    return c;
  }
  remove() {
    this.removed = true;
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  addEventListener(type, fn) { this.listeners.push({ type, fn }); }
  removeEventListener(type, fn) {
    const i = this.listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) this.listeners.splice(i, 1);
  }
  set innerHTML(v) {
    this.innerHTMLSetCount++;
    if (v === '') { for (const c of this.children) c.parentNode = null; this.children = []; }
  }
  get innerHTML() { return ''; }
  querySelector(sel) {
    const cls = sel.replace(/^\./, '');
    return this.children.find((c) => c.classes.has(cls)) || null;
  }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '');
    return this.children.filter((c) => c.classes.has(cls));
  }
  scrollIntoView() { this.scrolledIntoView++; }
}

// className is a plain string in the DOM but sidebar.js also reads classList; keep
// them separate by mirroring className assignments into the class set so
// setActive's later classList checks see constructor-time classes.
Object.defineProperty(FakeEl.prototype, 'className', {
  get() { return this.classNameStr || ''; },
  set(v) {
    this.classNameStr = v;
    this.classes = new Set(String(v).split(/\s+/).filter(Boolean));
  },
});

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
  document: globalThis.document,
  ResizeObserver: globalThis.ResizeObserver,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};

function installDom() {
  observers.length = 0;
  rafCallbacks.clear();
  cancelledRaf.length = 0;
  rafId = 0;
  globalThis.document = { createElement: (tag) => new FakeEl(tag), activeElement: null };
  globalThis.ResizeObserver = FakeResizeObserver;
  // Defer, matching the browser: store the callback but do not run it, so
  // setEffects' scroll-arrow measurement does not fire synchronously.
  globalThis.requestAnimationFrame = (cb) => { const id = ++rafId; rafCallbacks.set(id, cb); return id; };
  globalThis.cancelAnimationFrame = (id) => { cancelledRaf.push(id); rafCallbacks.delete(id); };
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete globalThis[k];
    else globalThis[k] = v;
  }
});

function makeSidebar() {
  installDom();
  const container = new FakeEl('div');
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
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['Charlie', 'alpha', 'Bravo'], {});
  const order = () => sidebar.listEl.children.map((b) => b.dataset.effect);
  sidebar.sortBy('name', 'asc');
  assert.deepEqual(order(), ['alpha', 'Bravo', 'Charlie']);
  sidebar.sortBy('name', 'desc');
  assert.deepEqual(order(), ['Charlie', 'Bravo', 'alpha']);
  // Same node identities throughout (nodes moved, not recreated).
  assert.equal(sidebar.buttons.size, 3);
});

test('setActive toggles active/aria-selected on only the old and new buttons', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  sidebar.setActive('A');
  const a = sidebar.buttons.get('A');
  const b = sidebar.buttons.get('B');
  assert.ok(a.classes.has('active'));
  assert.equal(a.getAttribute('aria-selected'), 'true');
  assert.equal(sidebar.tabbableBtn, a);

  sidebar.setActive('B');
  assert.ok(!a.classes.has('active'));
  assert.equal(a.getAttribute('aria-selected'), 'false');
  assert.ok(b.classes.has('active'));
  assert.equal(b.getAttribute('aria-selected'), 'true');
  assert.equal(sidebar.activeName, 'B');
  assert.ok(b.scrolledIntoView > 0);
});

test('setActive keeps the current selection when the name is off-list', () => {
  const { sidebar } = makeSidebar();
  sidebar.setEffects(['A', 'B'], {});
  sidebar.setActive('A');
  const a = sidebar.buttons.get('A');

  sidebar.setActive('ZZZ'); // no such button

  assert.equal(sidebar.activeName, 'A', 'activeName is not stripped by an off-list name');
  assert.ok(a.classes.has('active'), 'the active button stays selected');
  assert.equal(a.getAttribute('aria-selected'), 'true');
});

test('updateScrollArrows reflects scroll geometry', () => {
  const { sidebar } = makeSidebar();
  // No overflow: neither arrow visible.
  sidebar.listEl.scrollLeft = 0;
  sidebar.listEl.scrollWidth = 100;
  sidebar.listEl.clientWidth = 100;
  sidebar.updateScrollArrows();
  assert.ok(!sidebar.arrowLeft.classes.has('visible'));
  assert.ok(!sidebar.arrowRight.classes.has('visible'));
  // Overflow, scrolled to start: only the right arrow shows.
  sidebar.listEl.scrollWidth = 400;
  sidebar.updateScrollArrows();
  assert.ok(!sidebar.arrowLeft.classes.has('visible'));
  assert.ok(sidebar.arrowRight.classes.has('visible'));
  // Scrolled to the end: only the left arrow shows.
  sidebar.listEl.scrollLeft = 300;
  sidebar.updateScrollArrows();
  assert.ok(sidebar.arrowLeft.classes.has('visible'));
  assert.ok(!sidebar.arrowRight.classes.has('visible'));
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
  assert.ok(sidebar.heading.removed && sidebar.listEl.removed && sidebar.arrowRight.removed);
});
