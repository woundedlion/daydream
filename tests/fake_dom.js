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
 * Unlinks nodes from the child list they currently sit in, so an insert moves a
 * node the way the DOM does instead of listing it twice. Re-appending a node to
 * its own parent therefore moves it to the end.
 * @param {Array<any>} nodes - Nodes about to be inserted somewhere.
 * @returns {void}
 */
function detach(nodes) {
  for (const node of nodes) {
    const parent = node && typeof node === 'object' ? node.parentNode : null;
    if (!parent || !Array.isArray(parent.children)) continue;
    const at = parent.children.indexOf(node);
    if (at >= 0) parent.children.splice(at, 1);
  }
}

/**
 * Normalizes the third addEventListener/removeEventListener argument to the
 * capture flag the DOM keys listeners on: a bare boolean, an options bag's
 * `capture`, or false when omitted.
 * @param {boolean|Object|undefined} options - Legacy useCapture or options bag.
 * @returns {boolean} The capture flag.
 */
function captureFlag(options) {
  if (typeof options === 'boolean') return options;
  return Boolean(options && options.capture);
}

/**
 * Matches one node against a single compound-free selector. Class, attribute-
 * presence, and tag selectors are supported; anything else throws rather than
 * silently matching nothing.
 * @param {Object} node - Candidate element.
 * @param {string} selector - '.class', '[attr]', or a tag name.
 * @returns {boolean} True when the node matches.
 */
function matchesOne(node, selector) {
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  if (selector.startsWith('[') && selector.endsWith(']')) {
    return node.getAttribute(selector.slice(1, -1)) !== null;
  }
  if (/^[a-z][\w-]*$/i.test(selector)) return node.tagName === selector.toUpperCase();
  throw new Error(`unsupported selector: ${selector}`);
}

/**
 * Matches one node against a selector list.
 * @param {Object} node - Candidate element.
 * @param {string} selector - Comma-separated selectors.
 * @returns {boolean} True when the node matches any of them.
 */
function matches(node, selector) {
  return selector.split(',').some((one) => matchesOne(node, one.trim()));
}

/**
 * The attribute a dataset key reads and writes, under the DOM's camelCase to
 * `data-*` mapping.
 * @param {string} key - Dataset key.
 * @returns {string} Attribute name.
 */
function datasetAttribute(key) {
  return `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * The dataset key a `data-*` attribute is exposed under.
 * @param {string} name - Attribute name, `data-` prefix included.
 * @returns {string} Dataset key.
 */
function datasetKey(name) {
  return name.slice('data-'.length).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * DOMStringMap stand-in: a live view over the element's `data-*` attributes
 * that stringifies every write, as the platform does. Backing the map with the
 * attributes is what the DOM does too, so a dataset write is visible to
 * getAttribute and to an `[attr]` selector.
 * @param {Object} element - Element the map belongs to.
 * @returns {Object} The dataset view.
 */
function fakeDataset(element) {
  const attributeFor = (key) => (typeof key === 'string' ? datasetAttribute(key) : null);
  const present = (key) => {
    const name = attributeFor(key);
    return name !== null && name in element.attributes;
  };
  return new Proxy({}, {
    get: (_, key) => (present(key) ? element.attributes[attributeFor(key)] : undefined),
    set: (_, key, value) => {
      element.attributes[datasetAttribute(String(key))] = String(value);
      return true;
    },
    has: (_, key) => present(key),
    deleteProperty: (_, key) => {
      if (present(key)) delete element.attributes[attributeFor(key)];
      return true;
    },
    ownKeys: () => Object.keys(element.attributes)
      .filter((name) => name.startsWith('data-')).map(datasetKey),
    getOwnPropertyDescriptor: (_, key) => (present(key)
      ? {
        value: element.attributes[attributeFor(key)],
        writable: true,
        enumerable: true,
        configurable: true,
      }
      : undefined),
  });
}

/**
 * Prototype every fakeElement() carries, so a module guarding on
 * `target instanceof Element` can be exercised: install it as globalThis.Element
 * with installElement().
 */
export class FakeElement {}

/**
 * Element stand-in carrying the attribute, class, child, and listener surface
 * the daydream modules read and write. Non-empty innerHTML assignments throw so
 * tests cannot silently accept markup construction that a browser would parse.
 * setAttribute, textContent and dataset stringify what they are given, as the
 * platform does, so a test cannot assert a type back that a browser never
 * yields; dataset is a view over the element's `data-*` attributes, so a write
 * through it is visible to getAttribute and to an `[attr]` selector.
 * Listeners are recorded with their options bag so a test can dispatch(type,
 * event), read {passive}/{signal}, and assert removal; a {once} listener drops
 * as it fires, a listener an earlier handler removed does not fire, and removal
 * pairs on the capture flag, as in the DOM, so a capture-mismatched removal
 * leaves the listener on the list. focus() and
 * scrollIntoView() record their call counts the same way. Removing a listener
 * that was never added throws rather than no-opping as the DOM does, so a
 * fixture that omits the add cannot hide a removal that never happens.
 *
 * dispatch() propagates over the parentNode chain the way the DOM does, so a
 * listener's attachment point is observable: capture listeners run root-first,
 * then every listener on the dispatching node in registration order, then the
 * non-capture listeners back up to the root. The event carries `target` (the
 * dispatching node unless the caller names one), `currentTarget`,
 * stopPropagation() and stopImmediatePropagation(); the two stop methods are
 * the event's own and overwrite any the caller passed. Events bubble unless the
 * caller passes {bubbles: false}.
 * @param {string} [tag] - Tag name.
 * @returns {Object} Fake element.
 */
export function fakeElement(tag = 'div') {
  const classes = new Set();
  const element = {
    listeners: [],
    tagName: String(tag).toUpperCase(),
    id: '',
    style: {},
    attributes: {},
    children: [],
    parentNode: null,
    focusCalls: 0,
    scrollIntoViewCalls: 0,
    get firstElementChild() {
      return this.children.find((node) => node && typeof node === 'object') || null;
    },
    classList: {
      add: (...names) => { for (const name of names) classes.add(name); },
      remove: (...names) => { for (const name of names) classes.delete(name); },
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    append(...nodes) { detach(nodes); reparent(nodes, this); this.children.push(...nodes); },
    appendChild(node) {
      detach([node]);
      reparent([node], this);
      this.children.push(node);
      return node;
    },
    removeChild(node) {
      const at = this.children.indexOf(node);
      if (at >= 0) this.children.splice(at, 1);
      reparent([node], null);
      return node;
    },
    remove() {
      detach([this]);
      this.parentNode = null;
    },
    matches(selector) { return matches(this, selector); },
    closest(selector) {
      for (let node = this; node; node = node.parentNode) {
        if (node.classList && matches(node, selector)) return node;
      }
      return null;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      const found = [];
      const walk = (node) => {
        for (const child of node.children || []) {
          if (!child || typeof child !== 'object' || !child.classList) continue;
          if (matches(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
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
    addEventListener(type, handler, options) {
      this.listeners.push({ type, handler, options, capture: captureFlag(options) });
    },
    removeEventListener(type, handler, options) {
      const capture = captureFlag(options);
      const at = this.listeners.findIndex(
        (l) => l.type === type && l.handler === handler && l.capture === capture);
      if (at < 0) {
        throw new Error(
          `removeEventListener: no ${type} listener registered with capture=${capture}`);
      }
      this.listeners.splice(at, 1);
    },
    dispatch(type, event = {}) {
      // Propagation path: the dispatching node, then each ancestor.
      const path = [];
      for (let node = this; node; node = node.parentNode) path.push(node);
      const ancestors = path.slice(1);

      let stopped = false;
      let stoppedHere = false;
      // stopPropagation/stopImmediatePropagation belong to the event, so they
      // overwrite anything the caller supplied rather than the reverse.
      const dispatched = {
        target: this,
        bubbles: true,
        ...event,
        currentTarget: null,
        stopPropagation() { stopped = true; },
        stopImmediatePropagation() { stopped = true; stoppedHere = true; },
      };

      /**
       * Runs one node's listeners for this event.
       * @param {Object} node - Node the event has reached.
       * @param {boolean|null} capture - Capture flag to run, or null for the
       *   at-target phase, which runs both flags in registration order.
       * @returns {void}
       */
      const fire = (node, capture) => {
        dispatched.currentTarget = node;
        stoppedHere = false;
        for (const l of [...node.listeners]) {
          if (stoppedHere) break;
          if (l.type !== type) continue;
          if (capture !== null && l.capture !== capture) continue;
          // Re-check membership: an earlier handler may have removed this one,
          // and the DOM skips a listener removed after the dispatch began.
          const at = node.listeners.indexOf(l);
          if (at < 0) continue;
          if (l.options && l.options.once) node.listeners.splice(at, 1);
          l.handler(dispatched);
        }
      };

      for (const node of [...ancestors].reverse()) {
        if (stopped) return;
        fire(node, true);
      }
      if (stopped) return;
      fire(this, null);
      if (!dispatched.bubbles) return;
      for (const node of ancestors) {
        if (stopped) return;
        fire(node, false);
      }
    },
    focus() { this.focusCalls++; },
    select() {},
    scrollIntoView() { this.scrollIntoViewCalls++; },
  };
  // className and classList are two views of one class set, as in the DOM: a
  // module may set the string and later read the list, or the reverse.
  Object.defineProperty(element, 'className', {
    enumerable: true,
    // Configurable so a test can wrap the accessor to count writes.
    configurable: true,
    get() { return [...classes].join(' '); },
    set(value) {
      classes.clear();
      for (const name of String(value).split(/\s+/)) if (name) classes.add(name);
    },
  });
  Object.defineProperty(element, 'innerHTML', {
    set(value) {
      if (value !== '') throw new Error('innerHTML must not be used');
      element.replaceChildren();
    },
  });
  // textContent is a DOMString: a write of anything else comes back stringified,
  // and null (or a missing argument) reads back as the empty string.
  let text = '';
  Object.defineProperty(element, 'textContent', {
    enumerable: true,
    configurable: true,
    get() { return text; },
    set(value) { text = value === null || value === undefined ? '' : String(value); },
  });
  Object.defineProperty(element, 'dataset', {
    enumerable: true,
    configurable: true,
    value: fakeDataset(element),
  });
  Object.setPrototypeOf(element, FakeElement.prototype);
  return element;
}

/**
 * Installs FakeElement as globalThis.Element, so a bare `instanceof Element`
 * guard sees the fakes. Pair with restoreElementAfterEach().
 * @returns {Function} The installed constructor.
 */
export function installElement() {
  globalThis.Element = FakeElement;
  return FakeElement;
}

/**
 * Registers an afterEach that restores globalThis.Element to its pre-suite
 * value, so an installed stub never leaks into another test or suite.
 * @returns {void}
 */
export function restoreElementAfterEach() {
  const saved = globalThis.Element;
  afterEach(() => {
    if (saved === undefined) delete globalThis.Element;
    else globalThis.Element = saved;
  });
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
