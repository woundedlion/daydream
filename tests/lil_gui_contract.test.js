//
// Pins the behaviour of the lil-gui build package.json pins, driving the real
// module over tests/helpers/fake_dom.js.
//
// add() picks a controller off `typeof object[prop]` and returns undefined,
// after logging, for anything it has no controller for.
import { enumChoices } from '../src/effects/param_sync.js';
import { GUI as DeepLinkGUI } from '../src/ui/gui.js';
import { createEffectGui } from '../src/ui/effect_gui.js';
import { fakePanelGui } from './helpers/fake_app.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, installDocument, restoreDocumentAfterEach } from './helpers/fake_dom.js';

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

for (const ownsDisplay of [false, true]) {
  test(`readonly numeric text refreshes during lil-gui focus (worker=${ownsDisplay})`, async () => {
    const gui = await realGUI();
    let values = [12, 0.9];
    const win = { location: new URL('https://example.test/'), setTimeout, clearTimeout };
    const panel = createEffectGui({
      engine: {
        getParameterDefinitions: () => [
          { name: 'Unfinished Rays', value: 0, min: 0, max: 42050, step: 1, readonly: true },
          { name: 'Speed', value: 0.1, min: 0, max: 1 },
        ],
        paramGeneration: () => 1, paramValues: () => values, setParam: () => true,
        setAnimationsPaused: () => {}, animationsPaused: () => false,
        getPresetCount: () => 0, getPresetIndex: () => 0,
        synchronizePreset: () => true, selectPreset: () => true,
      },
      segments: { ownsDisplay: () => ownsDisplay, paramValues: () => values, setParam: () => {} },
      host: {
        createGui: () => new DeepLinkGUI(gui, 'fx', null, win), container: () => null,
        isMobile: () => false, applyEffect: () => {}, dragTarget: fakeElement('window'),
        focusedElement: () => document.activeElement,
      },
    });
    try {
      panel.build();
      const telemetry = panel.active().controllerByName.get('Unfinished Rays');
      document.activeElement = telemetry.$input;
      telemetry.$input.dispatch('focus', {});
      panel.sync();
      assert.equal(telemetry.$input.value, '12');
      values = [27, 0.8];
      panel.sync();
      assert.equal(telemetry.$input.value, '27');
      assert.equal(document.activeElement, telemetry.$input);
      assert.equal(telemetry.$input.getAttribute('readonly'), 'readonly');

      const speed = panel.active().controllerByName.get('Speed');
      document.activeElement = speed.$input;
      speed.$input.dispatch('focus', {});
      values = [33, 0.2];
      panel.sync();
      assert.equal(speed.getValue(), 0.8);
      assert.equal(Number(speed.$input.value), 0.8);
    } finally { panel.destroy(); }
  });
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

test('add() returns undefined for a value type it has no controller for', async (t) => {
  const gui = await realGUI();
  const params = { missing: undefined, nested: null };
  const logged = t.mock.method(console, 'error', () => {});

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
  // A single onChange slot.
  const calls = [];
  controller.onChange((v) => calls.push(['first', v]));
  controller.onChange((v) => calls.push(['second', v]));
  controller.setValue(4);

  assert.deepEqual(calls, [['second', 4]], 'the later registration replaced the earlier');
});

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

// options() has two implementations.
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

// lil-gui offers no public getter for the collapse state; its own docs spell
// the toggle `gui.open( gui._closed )`.
test('_closed tracks the collapse state open() and close() set', async () => {
  const gui = await realGUI();
  const folder = gui.addFolder('Shape');

  assert.equal(gui._closed, false, 'a panel starts open');
  assert.equal(folder._closed, false, 'a folder starts open');

  gui.close();
  assert.equal(gui._closed, true, 'close() did not record the collapse');
  assert.equal(folder._closed, false, 'a folder tracks its own state, not the parent panel');

  gui.open();
  assert.equal(gui._closed, false, 'open() did not record the expansion');

  folder.open(false);
  assert.equal(folder._closed, true, 'open(false) is the collapsing spelling');
  folder.open();
  assert.equal(folder._closed, false);
});

test('the panel classes the scroll restore and the stylesheet select on hold',
  async () => {
    const gui = await realGUI();
    const dropdown = gui.add({ preset: '1' }, 'preset', ['1', '2']);

    assert.equal(gui.domElement.querySelector('.lil-children'), gui.$children,
      'the panel scroll container is no longer .lil-children');
    assert.equal(dropdown.domElement.querySelector('.lil-display'), dropdown.$display,
      'an OptionController no longer wraps its select in .lil-display');
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

for (const search of ['', '?test.value=x']) {
  test(`DeepLinkGUI and its double reject unsupported values with URL ${search}`, async (t) => {
    const logged = t.mock.method(console, 'error', () => {});
    const real = await realGUI();
    const gui = new DeepLinkGUI(real, 'test', null, {
      location: { search, pathname: '/', hash: '' },
      setTimeout: () => 1,
      clearTimeout: () => {},
    });
    const fake = fakePanelGui({ hydrated: search ? { value: 'x' } : {} });
    const factories = [() => ({}), () => ({ value: null }),
      () => ({ value: undefined }), () => ({ value: {} })];
    for (const factory of factories) {
      for (const target of [gui, fake]) {
        const object = factory();
        const before = object.value;
        assert.throws(() => target.add(object, 'value'), TypeError);
        assert.equal(object.value, before);
        assert.throws(() => target.addSession(object, 'value'), TypeError);
      }
    }
    assert.equal(logged.mock.callCount(), factories.length);
    assert.ok(gui.add({}, 'value', ['a', 'b']));
    assert.ok(fake.add({}, 'value', ['a', 'b']));
  });
}


test('real lil-gui maps the third sparse option to numeric ID six', async () => {
  const gui = await realGUI();
  const state = { Pattern: 6 };
  const controller = gui.add(state, 'Pattern',
    enumChoices(['Cubic', 'Octet Truss', 'Shells'], [0, 1, 6]));
  assert.equal(controller.getValue(), 6);
  assert.equal(controller.$select.selectedIndex, 2);
  controller.setValue(0);
  assert.equal(controller.$select.selectedIndex, 0);
  controller.$select.selectedIndex = 2;
  controller.$select.dispatch('change');
  assert.equal(state.Pattern, 6);
});
