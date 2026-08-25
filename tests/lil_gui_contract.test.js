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
                        'updateDisplay', 'disable', 'listen', 'destroy',
                        'decimals']) {
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

// effect_gui.js reaches past domElement for the node that takes keyboard focus
// ($select ?? $input ?? $button) and for the Reset/Export buttons it re-labels.
// A lil-gui rename turns those into a browser TypeError, which is invisible to a
// double that carries every property.
test('each controller exposes the focusable widget the GUI layer reaches for', async () => {
  const gui = await realGUI();
  const params = { count: 1, label: 'x', on: true, run() {} };

  for (const [prop, extra] of [['count', [0, 10, 1]], ['label', []], ['on', []]]) {
    const controller = gui.add(params, prop, ...extra);
    assert.equal(controller.$input?.tagName, 'INPUT', `${prop}.$input`);
    assert.equal(controller.$button, undefined, `${prop} carries a $button`);
    assert.equal(typeof controller.$input.focus, 'function');
  }

  const action = gui.add(params, 'run');
  assert.equal(action.$input, undefined, 'a button controller carries an $input');
  assert.ok(action.$button, 'FunctionController no longer exposes $button');
  assert.equal(action.domElement.contains(action.$button), true,
    'the button must sit inside the row the panel lays out');
  assert.equal(typeof action.$button.focus, 'function');
});

// gui.js's URL writer registers an onChange per controller and replays stored
// values into them on boot; a write that matches the standing value must not
// echo back into the URL.
test('setValue() with the standing value fires no onChange', async () => {
  const gui = await realGUI();
  const controller = gui.add({ count: 1 }, 'count', 0, 10, 1);
  const calls = [];
  controller.onChange((v) => calls.push(v));

  controller.setValue(1);
  assert.deepEqual(calls, [], 'an unchanged write still notified');

  controller.setValue(2);
  controller.setValue(2);
  assert.deepEqual(calls, [2], 'the repeated write notified a second time');
});

// effect_gui.js's disposeEffect re-parents its action-row controllers back into
// the panel before destroy() for exactly this reason.
test('destroy() throws when the controller row hangs off another parent', async () => {
  const gui = await realGUI();
  const controller = gui.add({ count: 1 }, 'count', 0, 10, 1);
  const elsewhere = fakeElement('div');
  elsewhere.appendChild(controller.domElement);

  assert.throws(() => controller.destroy(), /not a child/,
    'destroy() removes from the panel container, not from the current parent');
});

test('decimals chains and rounds the display without moving the value', async () => {
  const gui = await realGUI();

  const integral = gui.add({ v: 0 }, 'v', 0, 10, 1);
  assert.equal(integral.decimals(0), integral, 'decimals must return the receiver to chain off');
  integral.setValue(3.7);
  assert.equal(integral.$input.value, '4', 'an integer param rendered a fraction');
  assert.equal(integral.getValue(), 3.7, 'decimals rounded the value, not the display');

  const fractional = gui.add({ v: 0 }, 'v', 0, 10).decimals(3);
  fractional.setValue(3.14159);
  assert.equal(fractional.$input.value, '3.142');
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
