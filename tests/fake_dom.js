//
// Shared DOM double for the suites that run without a browser: one element
// stand-in plus the globalThis.document install/restore helpers. Covers the
// surface the daydream modules actually touch — extend this instead of
// hand-rolling another one-off fake.
//
// Not modelled: layout and the box model, CSS, hit-testing, pointer capture.
// So these ship green here and only a real browser catches them: zero-width or
// overflowing chips, off-screen flyouts, scroll arrows that never appear,
// scrollTop clamping, a renamed or deleted CSS rule, a display:none control that
// still takes a click, focus landing on a non-focusable node, and a drag that
// loses pointer capture or ignores pointercancel. scripts/workbench-probe.mjs
// and scripts/browser-smoke.mjs are the jobs that do.
import { afterEach } from 'node:test';

// Nodes standing in for ones the page already carries. A parentless node is
// connected only if it is in here, so isConnected derives from the parent chain
// and a fresh element reads disconnected as in the DOM.
const rooted = new WeakSet();

// The ownerDocument every fake element carries, as every element in a browser
// does: enough of a document for a module that builds a node of its own.
const ownerDocument = { createElement: (tag) => fakeElement(tag) };

/**
 * The installed document stand-in, when there is one. It carries the
 * activeElement the modules read focus from.
 * @returns {Object|null} The document, or null when none is installed.
 */
function activeDocument() {
  const doc = globalThis.document;
  return doc && typeof doc === 'object' ? doc : null;
}

/**
 * Hands focus to the body when a node leaving its parent holds it, as the DOM
 * does: removal blurs, and a re-insert does not give the focus back.
 * @param {any} node - Node leaving its parent.
 * @returns {void}
 */
function blurRemoved(node) {
  const doc = activeDocument();
  const focused = doc && doc.activeElement;
  if (!focused || !node || typeof node.contains !== 'function') return;
  if (node.contains(focused)) doc.activeElement = doc.body || null;
}

/**
 * Links appended element nodes back to their parent. Strings (text nodes) carry
 * no parent and are skipped.
 * @param {Array<any>} nodes - Nodes just inserted.
 * @param {Object|null} parent - New parent, or null on removal.
 * @returns {void}
 */
function reparent(nodes, parent) {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    node.parentNode = parent;
    if (parent) continue;
    // A removal takes the node out of the page, so a stand-in for one the page
    // carried stops reading as connected.
    rooted.delete(node);
    blurRemoved(node);
  }
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
    if (!parent || !Array.isArray(parent.childNodes)) continue;
    const at = parent.childNodes.indexOf(node);
    if (at < 0) continue;
    parent.childNodes.splice(at, 1);
    blurRemoved(node);
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
  if (!/^(?:\.[\w-]+|\[[\w-]+\]|[a-z][\w-]*)$/i.test(selector)) {
    throw new Error(`unsupported selector: ${selector}`);
  }
  if (selector.startsWith('.')) return node.classList.contains(selector.slice(1));
  if (selector.startsWith('[')) return node.getAttribute(selector.slice(1, -1)) !== null;
  return node.tagName === selector.toUpperCase();
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

// A CSS <length>/<percentage>, or a bare zero, which needs no unit.
const LENGTH = '(?:0|-?\\d+(?:\\.\\d+)?(?:px|em|rem|%|vw|vh))';
// One grid track: a size, a fraction, or a content keyword.
const TRACK = `(?:auto|min-content|max-content|${LENGTH}|-?\\d+(?:\\.\\d+)?fr)`;
const TRACK_SIZE = `(?:${TRACK}|minmax\\(\\s*${TRACK}\\s*,\\s*${TRACK}\\s*\\))`;
const TRACKS = `(?:${TRACK_SIZE}(?:\\s+${TRACK_SIZE})*)`;
// A track list, `repeat()` included. The repetition count is a positive
// integer: repeat(0, …) is the shape a row that counted no children emits, and
// a browser drops the whole declaration rather than laying out one column.
const TRACK_LIST = new RegExp(
  `^(?:|none|${TRACKS}|repeat\\(\\s*[1-9]\\d*\\s*,\\s*${TRACKS}\\s*\\))$`);

// The value each of these properties accepts, the empty string (which clears a
// declaration) included. A property with no entry takes any value STYLE_REJECTED
// below does not catch.
const STYLE_VALUES = {
  display: /^(?:|none|block|inline|inline-block|flex|inline-flex|grid|inline-grid|contents)$/,
  gridAutoFlow: /^(?:|row|column|dense|row dense|column dense)$/,
  gridTemplateColumns: TRACK_LIST,
  gridTemplateRows: TRACK_LIST,
  left: new RegExp(`^(?:|auto|${LENGTH})$`),
  opacity: /^(?:|0|1|0?\.\d+|\d{1,3}%)$/,
  position: /^(?:|static|relative|absolute|fixed|sticky)$/,
};

// Tokens no property takes: what a template literal leaves behind when the
// number or object it interpolated was missing. Every one reaches a browser as a
// dropped declaration, so none may read back here.
const STYLE_REJECTED = /undefined|NaN|Infinity|\[object [A-Za-z]*\]/;

/**
 * Whether every parenthesis in a declaration closes, as a parser needs before
 * it can read the value at all.
 * @param {string} text - The value written.
 * @returns {boolean} True when the value is balanced.
 */
function balancedParens(text) {
  let depth = 0;
  for (const character of text) {
    if (character === '(') depth += 1;
    else if (character === ')' && (depth -= 1) < 0) return false;
  }
  return depth === 0;
}

/**
 * CSSStyleDeclaration stand-in. Writes are stringified, as the platform does,
 * and a value the property does not accept is dropped so the previous one
 * stands — again as the platform does, so invalid CSS cannot read back as the
 * text that was written. Two layers decide that: a per-property grammar for the
 * properties the modules compute a value for, and, for every property including
 * the ones with no grammar, a check that the value carries no interpolated
 * `undefined`/`NaN` and closes its parentheses. A dashed property name reaches
 * nothing in a browser, where the declaration is keyed camelCase, so it throws
 * rather than storing a declaration no read will ever find. An undeclared
 * property reads back as the empty string, as CSSStyleDeclaration yields, so a
 * module branching on `=== ''` takes the same path here as in a browser.
 * @returns {Object} The style view.
 */
function fakeStyle() {
  return new Proxy({}, {
    get: (declared, key) => (
      typeof key === 'symbol' || key in declared ? declared[key] : ''),
    set: (declared, key, value) => {
      const name = String(key);
      if (name.includes('-')) {
        throw new Error(`style is keyed camelCase, so "${name}" declares nothing`);
      }
      const text = String(value);
      if (STYLE_REJECTED.test(text) || !balancedParens(text)) return true;
      const accepts = STYLE_VALUES[name];
      if (!accepts || accepts.test(text)) declared[name] = text;
      return true;
    },
  });
}

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
 * scrollIntoView() record their call counts the same way; focus() also points
 * the installed document's activeElement at the node, and unparenting a node
 * that holds focus drops it to the body, so a reorder built out of re-appends
 * loses focus the way it does in the DOM. Removing a listener
 * that was never added throws rather than no-opping as the DOM does, so a
 * fixture that omits the add cannot hide a removal that never happens; pass
 * {allowRedundantRemoval: true} where the second removal is the thing under
 * test, as it is for an idempotent disposal.
 *
 * style drops a value its property does not take and refuses a dashed property
 * name, so neither reads back as written.
 *
 * childNodes lists every inserted node; children is the elements-only view, as
 * in the DOM, so a string append lands in one and not the other. append()
 * accepts strings as text nodes; appendChild() takes a node and throws on
 * anything else, so a test cannot encode a text node where the platform demands
 * an element. insertBefore() places a node ahead of a child and appends on a
 * null reference; a reference that is not a child throws rather than appending.
 * removeChild() throws on a node that is not a child, so a removal aimed at the
 * wrong parent cannot leave the node listed by its real one.
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
 * @param {Object} [options] - Fake-element options.
 * @param {boolean} [options.allowRedundantRemoval] - Let removeEventListener
 *   no-op on a listener that is not registered.
 * @param {boolean} [options.connected] - Stand in for a node the page already
 *   carries, so it and its subtree read as connected.
 * @returns {Object} Fake element.
 */
export function fakeElement(tag = 'div', options = {}) {
  const allowRedundantRemoval = Boolean(options && options.allowRedundantRemoval);
  const inPage = Boolean(options && options.connected);
  const classes = new Set();
  const element = {
    listeners: [],
    tagName: String(tag).toUpperCase(),
    ownerDocument,
    id: '',
    style: fakeStyle(),
    attributes: {},
    childNodes: [],
    parentNode: null,
    focusCalls: 0,
    scrollIntoViewCalls: 0,
    // Derived from the parent chain, as in the DOM: a node whose ancestor left
    // its parent is disconnected along with it, and a node that never reached
    // the page is disconnected until it is appended somewhere that has.
    get isConnected() {
      if (this.parentNode) return Boolean(this.parentNode.isConnected);
      return rooted.has(this);
    },
    // Elements-only view of childNodes, as in the DOM: appended strings are
    // text nodes and appear in neither this nor firstElementChild.
    get children() {
      return this.childNodes.filter((node) => node && typeof node === 'object');
    },
    get firstElementChild() {
      return this.children[0] || null;
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
    append(...nodes) { detach(nodes); reparent(nodes, this); this.childNodes.push(...nodes); },
    appendChild(node) {
      if (!node || typeof node !== 'object') {
        throw new TypeError(
          `appendChild: parameter 1 is not of type 'Node' (${typeof node})`);
      }
      detach([node]);
      reparent([node], this);
      this.childNodes.push(node);
      return node;
    },
    insertBefore(node, reference) {
      if (reference === null || reference === undefined) return this.appendChild(node);
      const at = this.childNodes.indexOf(reference);
      if (at < 0) throw new Error('insertBefore: the reference node is not a child');
      detach([node]);
      reparent([node], this);
      this.childNodes.splice(this.childNodes.indexOf(reference), 0, node);
      return node;
    },
    removeChild(node) {
      const at = this.childNodes.indexOf(node);
      if (at < 0) throw new Error('removeChild: the node is not a child');
      this.childNodes.splice(at, 1);
      reparent([node], null);
      return node;
    },
    remove() {
      detach([this]);
      reparent([this], null);
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
          if (!child.classList) continue;
          if (matches(child, selector)) found.push(child);
          walk(child);
        }
      };
      walk(this);
      return found;
    },
    replaceChildren(...nodes) {
      detach(nodes);
      reparent(this.childNodes, null);
      reparent(nodes, this);
      this.childNodes = nodes;
    },
    contains(node) {
      if (node === this) return true;
      return this.children.some(
        (child) => typeof child.contains === 'function' && child.contains(node));
    },
    addEventListener(type, handler, options) {
      this.listeners.push({ type, handler, options, capture: captureFlag(options) });
    },
    removeEventListener(type, handler, options) {
      const capture = captureFlag(options);
      const at = this.listeners.findIndex(
        (l) => l.type === type && l.handler === handler && l.capture === capture);
      if (at < 0) {
        if (allowRedundantRemoval) return;
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
      // The type and the propagation/default controls belong to the event, so
      // they overwrite anything the caller supplied rather than the reverse.
      const dispatched = {
        target: this,
        bubbles: true,
        ...event,
        type,
        currentTarget: null,
        defaultPrevented: false,
        stopPropagation() { stopped = true; },
        stopImmediatePropagation() { stopped = true; stoppedHere = true; },
        preventDefault() { dispatched.defaultPrevented = true; },
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
        if (stopped) break;
        fire(node, true);
      }
      if (!stopped) fire(this, null);
      if (dispatched.bubbles) {
        for (const node of ancestors) {
          if (stopped) break;
          fire(node, false);
        }
      }
      return dispatched;
    },
    focus() {
      this.focusCalls++;
      const doc = activeDocument();
      if (doc) doc.activeElement = this;
    },
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
  // An <option>'s value falls back to its text, as in the DOM, and `selected`
  // is the flag the owning <select>'s selection views read.
  if (element.tagName === 'OPTION') {
    element.selected = false;
    let optionValue = null;
    Object.defineProperty(element, 'value', {
      enumerable: true,
      configurable: true,
      get() { return optionValue === null ? text : optionValue; },
      set(value) { optionValue = String(value); },
    });
  }
  // A <select>'s views over its <option> children, live as in the DOM. One with
  // nothing explicitly selected shows its first option, so a freshly populated
  // select already has a selection, and an empty one has none.
  if (element.tagName === 'SELECT') {
    element.disabled = false;
    const options = () => element.children.filter((n) => n.tagName === 'OPTION');
    const selection = () => {
      const chosen = options().filter((option) => option.selected);
      return chosen.length > 0 ? chosen : options().slice(0, 1);
    };
    Object.defineProperty(element, 'options', {
      enumerable: true, configurable: true, get: options,
    });
    Object.defineProperty(element, 'selectedOptions', {
      enumerable: true, configurable: true, get: selection,
    });
    Object.defineProperty(element, 'selectedIndex', {
      enumerable: true,
      configurable: true,
      get() { return options().indexOf(selection()[0]); },
      set(at) {
        for (const [i, option] of options().entries()) option.selected = i === Number(at);
      },
    });
    Object.defineProperty(element, 'value', {
      enumerable: true,
      configurable: true,
      get() { return selection()[0]?.value ?? ''; },
      set(value) {
        element.selectedIndex =
          options().findIndex((option) => option.value === String(value));
      },
    });
  }
  if (inPage) rooted.add(element);
  return element;
}

/**
 * The listener surface a document stand-in needs for a module that wires a
 * document-level handler, spread into an installDocument() surface.
 * dispatch(type, event) runs the matching handlers in registration order over
 * an event whose `target` defaults to the installed document; removing a
 * listener that was never added throws, as it does on an element, so a fixture
 * that omits the add cannot hide a removal that never happens. listenerCount()
 * reports what is still attached, so a teardown is assertable.
 * @returns {Object} addEventListener, removeEventListener, listenerCount and dispatch.
 */
export function documentEvents() {
  /** @type {Array<{type: string, handler: Function}>} */
  const listeners = [];
  return {
    /** @param {string} type @param {Function} handler */
    addEventListener(type, handler) { listeners.push({ type, handler }); },
    /** @param {string} type @param {Function} handler */
    removeEventListener(type, handler) {
      const at = listeners.findIndex((l) => l.type === type && l.handler === handler);
      if (at < 0) throw new Error(`no ${type} listener on the document to remove`);
      listeners.splice(at, 1);
    },
    /** @param {string} type @returns {number} Listeners registered for the type. */
    listenerCount(type) {
      return listeners.filter((listener) => listener.type === type).length;
    },
    /** @param {string} type @param {Object} [event] @returns {Object} The dispatched event. */
    dispatch(type, event = {}) {
      const dispatched = { type, target: globalThis.document, ...event };
      for (const listener of [...listeners]) {
        if (listener.type === type) listener.handler(dispatched);
      }
      return dispatched;
    },
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
