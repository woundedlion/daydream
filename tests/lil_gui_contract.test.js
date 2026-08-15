//
// Pins the behaviour of the lil-gui build package.json pins, so the doubles the
// GUI suites run over cannot drift from the library the browser loads. Every
// other suite
// substitutes a stand-in for lil-gui; this one imports the real module and
// drives it over tests/fake_dom.js, which is enough DOM for panel and
// controller construction.
//
// The dispatch contract matters most: add() picks a controller off `typeof
// object[prop]` and returns undefined for anything it has no controller for,
// after logging. A double that hands back a controller for every property turns
// a browser-side `TypeError: … reading 'onChange'` into a green run.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './fake_dom.js';

restoreDocumentAfterEach();

const savedWindow = globalThis.window;
afterEach(() => {
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
});

/** Installs the document and window surface lil-gui's constructors read.
 * @returns {Object} A container element the panel mounts into.
 */
function installHost() {
  installDocument({
    head: fakeElement('head'),
    body: fakeElement('body'),
    activeElement: null,
    createElement: (tag) => fakeElement(tag),
  });
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    removeEventListener() {},
  };
  return fakeElement('div');
}

/** Builds a real lil-gui panel mounted in a fake container.
 * @returns {Promise<Object>} The GUI instance.
 */
async function realGUI() {
  const container = installHost();
  const { GUI } = await import('lil-gui');
  return new GUI({ container, autoPlace: false, injectStyles: false });
}

test('add() dispatches on the seeded value type', async () => {
  const gui = await realGUI();
  const params = { count: 1, label: 'x', on: true, run() {} };

  assert.equal(gui.add(params, 'count').constructor.name, 'NumberController');
  assert.equal(gui.add(params, 'label').constructor.name, 'StringController');
  assert.equal(gui.add(params, 'on').constructor.name, 'BooleanController');
  assert.equal(gui.add(params, 'run').constructor.name, 'FunctionController');
  assert.equal(gui.add(params, 'count', [1, 2, 3]).constructor.name, 'OptionController');
});

test('add() returns undefined for a value type it has no controller for', async () => {
  const gui = await realGUI();
  const params = { missing: undefined, nested: null };
  const logged = mock.method(console, 'error', () => {});

  assert.equal(gui.add(params, 'missing'), undefined,
    'an unseeded property yields no controller to chain onChange off');
  assert.equal(gui.add(params, 'nested'), undefined);
  assert.equal(gui.add(params, 'absent'), undefined);
  assert.equal(logged.mock.callCount(), 3, 'each refusal is reported');

  logged.mock.restore();
});

test('a controller carries the surface the GUI layer chains off it', async () => {
  const gui = await realGUI();
  const controller = gui.add({ count: 1 }, 'count', 0, 10, 1);

  for (const method of ['onChange', 'name', 'setValue', 'getValue',
                        'updateDisplay', 'disable', 'listen', 'destroy']) {
    assert.equal(typeof controller[method], 'function', `controller.${method}`);
  }
  // A single onChange slot, which is why the GUI layer composes handlers itself
  // instead of registering twice.
  const calls = [];
  controller.onChange((v) => calls.push(['first', v]));
  controller.onChange((v) => calls.push(['second', v]));
  controller.setValue(4);

  assert.deepEqual(calls, [['second', 4]], 'the later registration replaced the earlier');
});

// options() has two implementations. daydream.js narrows the resolution dropdown
// through it on every boot, so which one it lands on decides whether the live
// control keeps its handler or is silently detached.
test('options() on a dropdown updates it in place and returns the same controller',
  async () => {
    const gui = await realGUI();
    const params = { resolution: 'Lo' };
    const dropdown = gui.add(params, 'resolution', ['Lo', 'Hi']).name('Resolution');
    const changes = [];
    dropdown.onChange((v) => changes.push(v));

    const narrowed = dropdown.options(['Hi']);

    assert.equal(narrowed, dropdown,
      'OptionController overrides options() to mutate its own <select>');
    assert.equal(gui.controllers.length, 1, 'no replacement is appended');
    assert.deepEqual(narrowed.$select.children.map((o) => o.textContent), ['Hi'],
      'the offered rows are the narrowed list');
    assert.equal(narrowed._name, 'Resolution', 'the name survives');

    narrowed.setValue('Hi');
    assert.deepEqual(changes, ['Hi'],
      'the handler registered before the narrowing still fires');
  });

test('options() on a non-dropdown destroys the receiver and appends a replacement',
  async () => {
    const gui = await realGUI();
    const params = { count: 1, other: 2 };
    const plain = gui.add(params, 'count').name('Count');
    gui.add(params, 'other');

    const replacement = plain.options([1, 2, 3]);

    assert.notEqual(replacement, plain,
      'the base Controller.options() cannot convert a controller in place');
    assert.equal(replacement.constructor.name, 'OptionController');
    assert.equal(replacement._name, 'Count', 'the name is copied over');
    assert.equal(gui.controllers.at(-1), replacement,
      'the replacement lands at the end of the panel, not in the old slot');
    assert.equal(gui.controllers.includes(plain), false, 'the receiver is destroyed');
  });

test('addColor and addFolder hand back the shapes the GUI layer wraps', async () => {
  const gui = await realGUI();
  const color = gui.addColor({ tint: '#ff00ff' }, 'tint');
  assert.equal(typeof color.onChange, 'function');

  const folder = gui.addFolder('Shape');
  assert.equal(typeof folder.add, 'function');
  assert.equal(typeof folder.addFolder, 'function');
  assert.ok(folder.$children, 'a folder exposes the container custom content is appended to');
  assert.equal(folder.parent, gui);

  gui.destroy();
  assert.deepEqual(gui.children, [], 'destroy() empties the panel');
});
