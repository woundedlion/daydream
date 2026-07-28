// @ts-nocheck
//
// Shared DOM double for the suites that run without a browser: one element
// stand-in plus the globalThis.document install/restore helpers. Covers the
// surface the daydream modules actually touch — extend this instead of
// hand-rolling another one-off fake.
import { afterEach } from 'node:test';

/**
 * Element stand-in carrying the attribute, class, child, and listener surface
 * the daydream modules read and write. innerHTML is absent, so a test can assert
 * markup was never assigned.
 * @param {string} [tag] - Tag name.
 * @returns {Object} Fake element.
 */
export function fakeElement(tag = 'div') {
  const classes = new Set();
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    style: {},
    attributes: {},
    children: [],
    classList: {
      add: (...names) => { for (const name of names) classes.add(name); },
      remove: (...names) => { for (const name of names) classes.delete(name); },
      has: (name) => classes.has(name),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    removeChild(node) {
      const at = this.children.indexOf(node);
      if (at >= 0) this.children.splice(at, 1);
      return node;
    },
    replaceChildren(...nodes) { this.children = nodes; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    select() {},
  };
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
