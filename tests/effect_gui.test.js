// @ts-nocheck
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';
import {
  createEffectGui,
  addParamControl,
  EXPORT_COPIED,
  EXPORT_FAILED,
  FLASH_MS,
} from '../effect_gui.js';

// createEffectGui owns the effect panel: which control an engine parameter maps
// to, which value stream feeds the sliders each frame, what an Export may copy,
// and what a destroyed panel must release. Every collaborator is injected, so
// this suite drives the real module over doubles for lil-gui, the engine, the
// worker pool, the clipboard, and the window.

afterEach(() => { mock.timers.reset(); });

/**
 * lil-gui controller double: records the add() arguments, the label, the
 * onChange handler, and every display refresh.
 * @param {Object} object - The value object the controller is bound to.
 * @param {string} property - The bound property name.
 * @param {Array<any>} args - Extra arguments add() was called with.
 * @returns {Object} The controller double.
 */
function fakeController(object, property, args) {
  return {
    object,
    property,
    args,
    domElement: fakeElement('div'),
    label: property,
    decimalsSet: null,
    disabled: false,
    dragging: false,
    displayUpdates: 0,
    handler: null,
    name(label) { this.label = label; return this; },
    decimals(n) { this.decimalsSet = n; return this; },
    disable() { this.disabled = true; return this; },
    onChange(fn) { this.handler = fn; return this; },
    getValue() { return this.object[this.property]; },
    setValue(v) {
      this.object[this.property] = v;
      if (this.handler) this.handler(v);
      return this;
    },
    updateDisplay() { this.displayUpdates += 1; return this; },
  };
}

/**
 * lil-gui root double.
 * @returns {Object} The GUI double.
 */
function fakeGui() {
  return {
    domElement: fakeElement('div'),
    controllers: [],
    closed: false,
    destroyed: 0,
    destroyThrows: null,
    close() { this.closed = true; },
    destroy() {
      this.destroyed += 1;
      if (this.destroyThrows) throw this.destroyThrows;
    },
    add(object, property, ...args) {
      const controller = fakeController(object, property, args);
      this.controllers.push(controller);
      return controller;
    },
    /**
     * The non-deep-linked variant: same control, flagged so a test can tell which
     * of the two entry points built it.
     * @param {Object} object - The value object to bind.
     * @param {string} property - The bound property name.
     * @param {...*} args - Forwarded to add().
     * @returns {Object} The controller double.
     */
    addSession(object, property, ...args) {
      const controller = this.add(object, property, ...args);
      controller.session = true;
      return controller;
    },
    /**
     * @param {string} property - The bound property to look up.
     * @returns {Object|undefined} The controller bound to that property.
     */
    ctrl(property) {
      return this.controllers.find((c) => c.property === property);
    },
  };
}

/**
 * Clipboard double whose writeText resolves (or rejects) on demand.
 * @param {Error|null} [failure] - Rejection value, or null to resolve.
 * @returns {Object} The clipboard double, carrying the copied texts.
 */
function fakeClipboard(failure = null) {
  const copied = [];
  return {
    copied,
    writeText(text) {
      copied.push(text);
      return failure ? Promise.reject(failure) : Promise.resolve();
    },
  };
}

/**
 * Build the module under test over doubles for every collaborator.
 * @param {Object} [options] - Engine/page state the panel reads.
 * @returns {Object} The panel plus the doubles and sinks a test asserts on.
 */
function makeHarness({
  params = [],
  engineValues = [],
  segmentValues = null,
  ownsDisplay = false,
  generation = 1,
  clipboard = fakeClipboard(),
  isMobile = false,
  container = fakeElement('div'),
} = {}) {
  const state = {
    generation,
    engineValues,
    segmentValues,
    ownsDisplay,
    activeElement: null,
    clipboard,
    container,
  };
  const writes = [];
  const warnings = [];
  const guis = [];
  const dragTarget = fakeElement('window');

  const panel = createEffectGui({
    createGui: () => { const gui = fakeGui(); guis.push(gui); return gui; },
    getParameterDefinitions: () => params,
    paramGeneration: () => state.generation,
    segmentsOwnDisplay: () => state.ownsDisplay,
    segmentParamValues: () => state.segmentValues,
    engineParamValues: () => state.engineValues,
    setEngineParam: (name, value) => writes.push(`engine:${name}=${value}`),
    setWorkerParam: (name, value) => writes.push(`worker:${name}=${value}`),
    setAnimationsPaused: (paused) => writes.push(`paused:${paused}`),
    applyEffect: () => writes.push('applyEffect'),
    guiContainer: () => state.container,
    activeElement: () => state.activeElement,
    isMobile: () => isMobile,
    dragTarget,
    clipboard: () => state.clipboard,
    logWarn: (...args) => warnings.push(args.join(' ')),
  });

  return { panel, state, writes, warnings, guis, dragTarget, container,
           gui: () => guis[guis.length - 1] };
}

const SPEED = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
const GLOW = { name: 'Glow', value: false, animated: true };
const TELEMETRY = { name: 'Frames', value: 0, min: 0, max: 99, readonly: true };

// addParamControl maps one engine parameter definition onto a lil-gui control.

test('a numeric param becomes a slider bounded by the definition', () => {
  const gui = fakeGui();
  const state = { Speed: 0.1 };
  const controller = addParamControl(gui, state, SPEED);

  assert.deepEqual(controller.args, [0, 1]);
  assert.equal(controller.decimalsSet, 3);
  assert.equal(controller.isBoolean, false);
});

test('a boolean param becomes a toggle with no range arguments', () => {
  const gui = fakeGui();
  const controller = addParamControl(gui, { Glow: false }, GLOW);

  assert.deepEqual(controller.args, []);
  assert.equal(controller.isBoolean, true);
});

test('an enumerated param becomes a dropdown of labels to engine indices', () => {
  const gui = fakeGui();
  const controller = addParamControl(gui, { Mode: 0 },
    { name: 'Mode', value: 0, options: ['Off', 'On', 'Auto'] });

  assert.deepEqual(controller.args, [{ Off: 0, On: 1, Auto: 2 }]);
  assert.equal(controller.isBoolean, false);
});

test('a boolean carrying option labels stays a toggle', () => {
  const gui = fakeGui();
  const controller = addParamControl(gui, { Glow: true },
    { name: 'Glow', value: true, options: ['Off', 'On'] });

  assert.deepEqual(controller.args, []);
  assert.equal(controller.isBoolean, true);
});

// build() turns the engine's parameter definitions into the effect record the
// rest of the app reads.

test('build records the value-stream order and stamps the effect generation', () => {
  const h = makeHarness({ params: [SPEED, GLOW, TELEMETRY], generation: 7 });
  h.panel.build();
  const fx = h.panel.active();

  assert.deepEqual(fx.paramNames, ['Speed', 'Glow', 'Frames']);
  assert.deepEqual([...fx.controllerByName.keys()], ['Speed', 'Glow', 'Frames']);
  assert.equal(fx.paramGeneration, 7);
  assert.equal(fx.hasLiveParams, true);
});

test('a readonly param is disabled and excluded from the writable set', () => {
  const h = makeHarness({ params: [SPEED, TELEMETRY] });
  h.panel.build();

  assert.deepEqual(h.panel.active().writableParamNames, ['Speed']);
  assert.equal(h.gui().ctrl('Frames').disabled, true);
  assert.equal(h.gui().ctrl('Speed').disabled, false);
});

/** The engine rejects a write to a readonly param, so its control must be kept
 * out of the deep-link layer entirely: no URL seeding and no onChange handler to
 * replay a URL value into setParameter. */
test('a readonly param is a session control with no engine write-back', () => {
  const h = makeHarness({ params: [SPEED, TELEMETRY] });
  h.panel.build();

  assert.equal(h.gui().ctrl('Frames').session, true);
  assert.equal(h.gui().ctrl('Frames').handler, null);
  assert.equal(h.gui().ctrl('Speed').session, undefined);
  assert.equal(typeof h.gui().ctrl('Speed').handler, 'function');
});

test('an effect with no animated or readonly param has no live values to poll', () => {
  const h = makeHarness({ params: [{ name: 'Speed', value: 0.1, min: 0, max: 1 }] });
  h.panel.build();

  assert.equal(h.panel.active().hasLiveParams, false);
});

test('editing a control writes the engine and the worker pool as floats', () => {
  const h = makeHarness({ params: [SPEED, GLOW] });
  h.panel.build();

  h.gui().ctrl('Speed').setValue(0.75);
  h.gui().ctrl('Glow').setValue(true);

  assert.deepEqual(h.writes, [
    'engine:Speed=0.75', 'worker:Speed=0.75',
    'paused:true',
    'engine:Glow=1', 'worker:Glow=1',
  ]);
});

test('the pause toggle is offered only when a param animates', () => {
  const animated = makeHarness({ params: [SPEED] });
  animated.panel.build();
  assert.equal(animated.gui().ctrl('pause').label, 'Pause Animation');
  assert.notEqual(animated.panel.active().pauseController, null);

  const static_ = makeHarness({ params: [{ name: 'Speed', value: 0.1, min: 0, max: 1 }] });
  static_.panel.build();
  assert.equal(static_.gui().ctrl('pause'), undefined);
  assert.equal(static_.panel.active().pauseController, null);
});

test('touching an animated slider takes over from the animation once', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  const pause = h.gui().ctrl('pause');

  h.gui().ctrl('Speed').setValue(0.5);
  assert.equal(h.panel.active().animationState.pause, true);
  assert.equal(pause.displayUpdates, 1);

  h.gui().ctrl('Speed').setValue(0.6);
  assert.equal(pause.displayUpdates, 1, 'an already-paused effect is not re-paused');
  assert.deepEqual(h.writes.filter((w) => w.startsWith('paused')), ['paused:true']);
});

test('the pause toggle freezes animations on every engine', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();

  h.gui().ctrl('pause').setValue(true);

  assert.deepEqual(h.writes, ['paused:true']);
});

test('the Reset button re-applies the effect', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();

  h.gui().ctrl('reset').object.reset();

  assert.deepEqual(h.writes, ['applyEffect']);
});

// sync() is the per-frame poll that mirrors engine-written values back into the
// panel without fighting the user.

test('sync adopts the engine values, coercing a toggle', () => {
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.9, 1] });
  h.panel.build();

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);
  assert.equal(h.gui().ctrl('Glow').getValue(), true);
  assert.equal(h.gui().ctrl('Speed').displayUpdates, 1);
});

test('sync leaves a dragged control alone', () => {
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.9, 1] });
  h.panel.build();
  h.gui().ctrl('Speed').dragging = true;

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.1, 'the drag owns the value');
  assert.equal(h.gui().ctrl('Glow').getValue(), true, 'other controls still track');
});

test('sync leaves the focused control alone', () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.9] });
  h.panel.build();
  h.state.activeElement = h.gui().ctrl('Speed').domElement;

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.1);
});

test('sync polls nothing for an effect with no live params', () => {
  const h = makeHarness({
    params: [{ name: 'Speed', value: 0.1, min: 0, max: 1 }],
    engineValues: [0.9],
  });
  h.panel.build();

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.1);
});

test('sync reads the worker pool once it owns the display', () => {
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.9],
    segmentValues: [0.25],
    ownsDisplay: true,
  });
  h.panel.build();

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.25);
});

test('sync skips a value stream that no longer describes the built panel', () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.9], generation: 3 });
  h.panel.build();
  h.state.generation = 4;

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.1);
  assert.equal(h.panel.liveParamValues(), null);
});

test('sync skips a detached (zero-length) value stream', () => {
  const h = makeHarness({ params: [SPEED], engineValues: new Float32Array(0) });
  h.panel.build();

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.1);
  assert.deepEqual(h.warnings, []);
});

test('a param/value length skew is warned once per episode, never bound by index', () => {
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.9] });
  h.panel.build();

  h.panel.sync();
  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.1);
  assert.deepEqual(h.warnings,
    ['Effect GUI: param/value length skew (2 vs 1); skipping sync']);

  h.state.engineValues = [0.9, 1];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);

  h.state.engineValues = [0.4];
  h.panel.sync();
  assert.equal(h.warnings.length, 2, 'a new skew episode warns again');
});

// The Export action copies the live values, and reports the outcome on its own
// button.

test('Export copies the live values as a C++ brace-init list', async () => {
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.25, 0.5] });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.clipboard.copied, ['{ 0.25f, 0.5f }']);
  assert.equal(h.gui().ctrl('export').label, EXPORT_COPIED);
});

test('Export omits engine-written readonly params from the preset', async () => {
  const h = makeHarness({
    params: [SPEED, TELEMETRY],
    engineValues: [0.25, 1234],
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.clipboard.copied, ['{ 0.25f }']);
});

test('Export on a context with no clipboard reports the failure and copies nothing', () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], clipboard: null });
  h.panel.build();

  h.gui().ctrl('export').object.export();

  assert.equal(h.gui().ctrl('export').label, EXPORT_FAILED);
  assert.deepEqual(h.warnings, ['Export: clipboard API unavailable (insecure context?)']);
});

test('Export refuses a value stream that has skewed from the panel', () => {
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.25] });
  h.panel.build();

  h.gui().ctrl('export').object.export();

  assert.deepEqual(h.state.clipboard.copied, []);
  assert.equal(h.gui().ctrl('export').label, EXPORT_FAILED);
  assert.match(h.warnings[0], /param\/value length skew \(2 vs 1\)/);
});

test('a rejected clipboard write reports the failure', async () => {
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.25],
    clipboard: fakeClipboard(new Error('denied')),
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.gui().ctrl('export').label, EXPORT_FAILED);
  assert.match(h.warnings[0], /clipboard write failed/);
});

test('an Export that lands after an effect switch does not flash the old panel', async () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.25] });
  h.panel.build();
  const stale = h.gui();

  stale.ctrl('export').object.export();
  h.panel.build();
  await Promise.resolve();

  assert.deepEqual(h.state.clipboard.copied, ['{ 0.25f }']);
  assert.equal(stale.ctrl('export').label, 'Export', 'the replaced panel is left alone');
});

test('the Export flash reverts to the default label', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], clipboard: null });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  assert.equal(h.gui().ctrl('export').label, EXPORT_FAILED);

  mock.timers.tick(FLASH_MS);
  assert.equal(h.gui().ctrl('export').label, 'Export');
});

test('destroy cancels a pending Export flash', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], clipboard: null });
  h.panel.build();
  const stale = h.gui();

  stale.ctrl('export').object.export();
  h.panel.destroy();
  mock.timers.tick(FLASH_MS);

  assert.equal(stale.ctrl('export').label, EXPORT_FAILED,
    'the flash timer fired into no destroyed controller');
});

// mount() places the built panel in the page.

test('mount hands the panel to the container as the effect GUI', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();

  h.panel.mount();

  const dom = h.gui().domElement;
  assert.deepEqual(h.container.children, [dom]);
  assert.equal(dom.classList.contains('effect-gui'), true);
  assert.equal(dom.classList.contains('global-gui'), false);
  assert.equal(h.gui().closed, false);
});

test('a mobile layout mounts the panel collapsed', () => {
  const h = makeHarness({ params: [SPEED], isMobile: true });
  h.panel.build();

  h.panel.mount();

  assert.equal(h.gui().closed, true);
});

test('a page with no GUI container mounts nothing', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.state.container = null;

  h.panel.mount();

  assert.equal(h.gui().domElement.parentNode, null);
});

test('mount before build does nothing', () => {
  const h = makeHarness({ params: [SPEED] });

  h.panel.mount();

  assert.deepEqual(h.container.children, []);
});

// destroy() must leave nothing of the panel behind.

test('a drag registers window listeners that the pointer release drains', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  const controller = h.gui().ctrl('Speed');

  controller.domElement.dispatch('pointerdown');
  assert.equal(controller.dragging, true);
  assert.deepEqual(h.dragTarget.listeners.map((l) => l.type),
    ['pointerup', 'pointercancel']);

  h.dragTarget.dispatch('pointerup');
  assert.equal(controller.dragging, false);
  assert.deepEqual(h.dragTarget.listeners, []);
  assert.equal(h.panel.active().activeDragEnds.size, 0);
});

test('destroy drains the drag listeners of a panel torn down mid-drag', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.gui().ctrl('Speed').domElement.dispatch('pointerdown');

  h.panel.destroy();

  assert.deepEqual(h.dragTarget.listeners, []);
  assert.equal(h.panel.active(), null);
});

test('a readonly control is never drag-tracked', () => {
  const h = makeHarness({ params: [TELEMETRY] });
  h.panel.build();

  h.gui().ctrl('Frames').domElement.dispatch('pointerdown');

  assert.deepEqual(h.dragTarget.listeners, []);
});

test('destroy detaches the panel DOM and tears the GUI down', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.panel.mount();
  const gui = h.gui();

  h.panel.destroy();

  assert.deepEqual(h.container.children, []);
  assert.equal(gui.domElement.parentNode, null);
  assert.equal(gui.destroyed, 1);
  assert.equal(h.panel.active(), null);
});

test('a lil-gui teardown fault still clears the panel', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.gui().destroyThrows = new Error('lil-gui blew up');

  h.panel.destroy();

  assert.equal(h.panel.active(), null);
  assert.match(h.warnings[0], /GUI destroy warning/);
});

test('destroy on an unbuilt panel is a no-op', () => {
  const h = makeHarness({ params: [SPEED] });

  h.panel.destroy();

  assert.equal(h.panel.active(), null);
  assert.deepEqual(h.warnings, []);
});
