// @ts-nocheck
//
// Shared DOM double for the suites that run without a browser: one element
// stand-in plus the globalThis.document install/restore helpers. Covers the
// surface the daydream modules actually touch — extend this instead of
// hand-rolling another one-off fake.
import { afterEach } from 'node:test';

/**
 * Links appended element nodes back to their parent. Strings (text nodes) carry
 * no parent and are skipped.
 * @param {Array<any>} nodes - Nodes just inserted.
 * @param {Object|null} parent - New parent, or null on removal.
 * @returns {void}
 */
function reparent(nodes, parent) {
  for (const node of nodes) if (node && typeof node === 'object') node.parentNode = parent;
}

/**
 * Element stand-in carrying the attribute, class, child, and listener surface
 * the daydream modules read and write. Non-empty innerHTML assignments throw so
 * tests cannot silently accept markup construction that a browser would parse.
 * Listeners are recorded so a test can dispatch(type, event) and assert removal.
 * @param {string} [tag] - Tag name.
 * @returns {Object} Fake element.
 */
export function fakeElement(tag = 'div') {
  const classes = new Set();
  const element = {
    listeners: [],
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    get firstElementChild() {
      return this.children.find((node) => node && typeof node === 'object') || null;
    },
    classList: {
      add: (...names) => { for (const name of names) classes.add(name); },
      remove: (...names) => { for (const name of names) classes.delete(name); },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    append(...nodes) { reparent(nodes, this); this.children.push(...nodes); },
    appendChild(node) { reparent([node], this); this.children.push(node); return node; },
    removeChild(node) {
      const at = this.children.indexOf(node);
      if (at >= 0) this.children.splice(at, 1);
      reparent([node], null);
      return node;
    },
    replaceChildren(...nodes) {
      reparent(this.children, null);
      reparent(nodes, this);
      this.children = nodes;
    },
    contains(node) {
      if (node === this) return true;
      return this.children.some(
        (child) => child && typeof child === 'object'
          && typeof child.contains === 'function' && child.contains(node));
    },
    addEventListener(type, handler) { this.listeners.push({ type, handler }); },
    removeEventListener(type, handler) {
      const at = this.listeners.findIndex(
        (l) => l.type === type && l.handler === handler);
      if (at >= 0) this.listeners.splice(at, 1);
    },
    dispatch(type, event = {}) {
      for (const l of this.listeners.filter((l) => l.type === type)) {
        l.handler(event);
      }
    },
    focus() {},
    select() {},
  };
  Object.defineProperty(element, 'innerHTML', {
    set(value) {
      if (value !== '') throw new Error('innerHTML must not be used');
      element.replaceChildren();
    },
  });
  return element;
}

/**
 * Installs a fake globalThis.document.
 * @param {Object} [surface] - Document members the module under test reads.
 * @returns {Object} The installed document.
 */
export function installDocument(surface = {}) {
  globalThis.document = surface;
  return surface;
}

/**
 * Registers an afterEach that restores globalThis.document to its pre-suite
 * value, so an installed stub never leaks into another test or suite.
 * @returns {void}
 */
export function restoreDocumentAfterEach() {
  const saved = globalThis.document;
  afterEach(() => {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  });
}
