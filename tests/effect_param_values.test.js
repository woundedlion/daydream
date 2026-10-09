import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParamValueSync } from '../src/ui/effect_param_values.js';

/**
 * A controller double over its own bound object.
 * @param {string} name - Bound property.
 * @param {*} value - Initial displayed value.
 * @param {Object} [kind] - Controller flags (isEnum, isBoolean, isReadonly, ...).
 */
function controller(name, value, kind = {}) {
  const children = new Set();
  return {
    object: { [name]: value },
    property: name,
    displays: 0,
    dragging: false,
    isEnum: false,
    isBoolean: false,
    isReadonly: false,
    domElement: { contains: (node) => children.has(node) },
    getValue() { return this.object[name]; },
    updateDisplay() { this.displays += 1; },
    owns(node) { children.add(node); return node; },
    ...kind,
  };
}

/** A plain display over the given controllers, in stream order. */
function display(controllers, flags = {}) {
  return {
    controllerByName: new Map(controllers.map((c) => [c.property, c])),
    paramNames: controllers.map((c) => c.property),
    hasParams: controllers.length > 0,
    hasEnumControls: controllers.some((c) => c.isEnum),
    hasAnimatedEnums: false,
    ...flags,
  };
}

function harness({ values = [], definitions = [], ownsDisplay = false } = {}) {
  const state = { values, definitions, ownsDisplay, focused: null, definitionReads: 0 };
  const warnings = [];
  const sync = createParamValueSync({
    liveParamValues: () => state.values,
    segmentsOwnDisplay: () => state.ownsDisplay,
    getParameterDefinitions: () => { state.definitionReads += 1; return state.definitions; },
    focusedElement: () => state.focused,
    logWarn: (message) => warnings.push(message),
  });
  return { sync, state, warnings };
}

test('syncValues writes each live value into its controller by stream position', () => {
  const speed = controller('Speed', 0);
  const glow = controller('Glow', false, { isBoolean: true });
  const h = harness({ values: [0.25, 1] });
  h.sync.syncValues(display([speed, glow]), true, false);
  assert.equal(speed.object.Speed, 0.25);
  assert.equal(glow.object.Glow, true);
  assert.equal(speed.displays, 1);
  h.sync.syncValues(display([speed, glow]), true, false);
  assert.equal(speed.displays, 1, 'an unchanged value is not redisplayed');
});

test('syncValues leaves a dragged or focused control alone, but not focused telemetry', () => {
  const dragged = controller('A', 0, { dragging: true });
  const typed = controller('B', 0);
  const telemetry = controller('C', 0, { isReadonly: true });
  const h = harness({ values: [1, 2, 3] });
  const input = typed.owns({});
  telemetry.owns(input);
  h.state.focused = input;
  h.sync.syncValues(display([dragged, typed, telemetry]), true, false);
  assert.deepEqual([dragged.object.A, typed.object.B, telemetry.object.C], [0, 0, 3]);
});

test('syncValues skips a panel without parameters and an empty stream', () => {
  const speed = controller('Speed', 0);
  const h = harness({ values: [] });
  h.sync.syncValues(display([speed]), true, false);
  h.state.values = null;
  h.sync.syncValues(display([speed]), true, false);
  h.state.values = [5];
  h.sync.syncValues(display([speed], { hasParams: false }), true, false);
  assert.equal(speed.object.Speed, 0);
});

test('syncValues warns once per skew episode and re-arms after a paired frame', () => {
  const speed = controller('Speed', 0);
  const h = harness({ values: [1, 2] });
  const fx = display([speed]);
  h.sync.syncValues(fx, true, false);
  h.sync.syncValues(fx, true, false);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /length skew \(1 vs 2\)/);
  assert.equal(speed.object.Speed, 0, 'a skewed stream is not paired');
  h.state.values = [3];
  h.sync.syncValues(fx, true, false);
  assert.equal(speed.object.Speed, 3);
  h.state.values = [1, 2];
  h.sync.syncValues(fx, true, false);
  assert.equal(h.warnings.length, 2);
});

test('resetSkew re-arms the skew warning inside an episode', () => {
  const h = harness({ values: [1, 2] });
  const fx = display([controller('Speed', 0)]);
  h.sync.syncValues(fx, true, false);
  h.sync.resetSkew();
  h.sync.syncValues(fx, true, false);
  assert.equal(h.warnings.length, 2);
});

test('a writable selector follows its requested value, not the stream', () => {
  const mode = controller('Mode', 0, { isEnum: true, enumOptions: ['a', 'b', 'c'] });
  const h = harness({ values: [2], definitions: [
    { name: 'Mode', value: 2, requestedValue: 1, options: ['a', 'b', 'c'] }] });
  h.sync.syncValues(display([mode], { hasAnimatedEnums: true }), true, false);
  assert.equal(mode.object.Mode, 1);
});

test('enum definitions are read only when a selector can have moved', () => {
  const mode = () => controller('Mode', 0, { isEnum: true, enumOptions: ['a', 'b'] });
  const definitions = [{ name: 'Mode', value: 1, options: ['a', 'b'] }];
  const reads = (fx, advanced, presetAdvanced, ownsDisplay = false) => {
    const h = harness({ values: [1], definitions, ownsDisplay });
    h.sync.syncValues(fx, advanced, presetAdvanced);
    return h.state.definitionReads;
  };
  assert.equal(reads(display([mode()]), true, false), 0, 'static selectors, no preset move');
  assert.equal(reads(display([mode()]), true, true), 1, 'a preset move');
  assert.equal(reads(display([mode()], { hasAnimatedEnums: true }), true, false), 1);
  assert.equal(reads(display([mode()], { hasAnimatedEnums: true }), false, true), 0,
    'a frame that did not step');
  assert.equal(reads(display([mode()], { hasAnimatedEnums: true }), true, true, true), 0,
    'the worker pool owns the display');
  assert.equal(reads(display([controller('Speed', 0)]), true, true), 0, 'no selectors');
});

test('while the pool owns the display a selector follows the stream', () => {
  const mode = controller('Mode', 0, { isEnum: true, enumOptions: ['a', 'b'],
    enumOptionValues: [4, 9] });
  const h = harness({ values: [9], ownsDisplay: true });
  h.sync.syncValues(display([mode]), true, true);
  assert.equal(mode.object.Mode, 9);
});

test('syncValues skips a stream slot no controller claims', () => {
  const speed = controller('Speed', 0);
  const fx = display([speed]);
  fx.paramNames = ['External', 'Speed'];
  const h = harness({ values: [7, 8] });
  h.sync.syncValues(fx, true, false);
  assert.equal(speed.object.Speed, 8);
});

test('adoptRequestedEnums leaves a focused, read-only or non-selector control alone', () => {
  const focusedMode = controller('A', 0, { isEnum: true });
  const readonlyMode = controller('B', 0, { isEnum: true, isReadonly: true });
  const slider = controller('C', 0);
  const freeMode = controller('D', 0, { isEnum: true });
  const option = { options: ['x', 'y'], requestedValue: 1, value: 0 };
  const h = harness({
    definitions: ['A', 'B', 'C', 'D', 'Unbuilt'].map((name) => ({ name, ...option })),
  });
  const focused = focusedMode.owns({});
  h.sync.adoptRequestedEnums(display([focusedMode, readonlyMode, slider, freeMode]), focused);
  assert.deepEqual(
    [focusedMode.object.A, readonlyMode.object.B, slider.object.C, freeMode.object.D],
    [0, 0, 0, 1]);
  assert.equal(freeMode.displays, 1);
  h.sync.adoptRequestedEnums(display([freeMode]), null);
  assert.equal(freeMode.displays, 1, 'a selector already on its request is not redisplayed');
});

test('adoptRequestedEnums reads no definitions for a panel without selectors', () => {
  const h = harness({ definitions: [{ name: 'Speed', value: 1 }] });
  h.sync.adoptRequestedEnums(display([controller('Speed', 0)]), null);
  assert.equal(h.state.definitionReads, 0);
});
