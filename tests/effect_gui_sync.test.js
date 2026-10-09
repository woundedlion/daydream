import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, restoreDocumentAfterEach } from './helpers/fake_dom.js';

import {
  makeHarness,
  SPEED,
  GLOW,
  pointerDown,
  pointerUp,
} from './helpers/effect_gui_harness.js';

restoreDocumentAfterEach();

// createEffectGui's per-frame sync, schema rebuilds and presets, driven over
// doubles for every injected collaborator.

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

test('sync leaves a control whose input has focus alone', () => {
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.9, 1] });
  h.panel.build();
  const input = fakeElement('input');
  h.gui().ctrl('Speed').domElement.appendChild(input);
  h.state.focused = input;

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.1, 'the typed value stands');
  assert.equal(h.gui().ctrl('Glow').getValue(), true, 'other controls still track');
});

for (const ownsDisplay of [false, true]) {
  test(`focused readonly telemetry follows changing values (worker=${ownsDisplay})`, () => {
    const h = makeHarness({
      params: [{ name: 'Unfinished Rays', value: 0, min: 0, max: 42050, readonly: true }, SPEED],
      engineValues: [12, 0.9], segmentValues: [12, 0.9], ownsDisplay,
    });
    h.panel.build();
    const telemetry = h.gui().ctrl('Unfinished Rays');
    h.state.focused = telemetry.$input;
    h.gui().ctrl('Speed').dragging = true;
    h.panel.sync();
    assert.equal(telemetry.getValue(), 12);
    assert.equal(telemetry.$input.getAttribute('readonly'), 'readonly');
    assert.equal(h.gui().ctrl('Speed').getValue(), SPEED.value);

    h.state.engineValues = [27, 0.9];
    h.state.segmentValues = [27, 0.9];
    h.panel.sync();
    assert.equal(telemetry.getValue(), 27);
    assert.equal(h.state.focused, telemetry.$input);
    assert.deepEqual(h.writes, []);
  });

  test(`focused readonly enums follow rendered values (worker=${ownsDisplay})`, () => {
    const h = makeHarness({
      params: [{
        name: 'Status', value: 0, requestedValue: 0, readonly: true,
        options: ['Idle', 'Working', 'Done'], optionValues: [0, 12, 27], animated: true,
      }],
      engineValues: [12], segmentValues: [12], ownsDisplay,
    });
    h.panel.build();
    const telemetry = h.gui().ctrl('Status');
    h.state.focused = telemetry.$select;
    h.panel.sync();
    assert.equal(telemetry.getValue(), 12);
    h.state.engineValues = [27];
    h.state.segmentValues = [27];
    h.panel.sync();
    assert.equal(telemetry.getValue(), 27);
    assert.equal(telemetry.$select.getAttribute('aria-readonly'), 'true');
    assert.deepEqual(h.writes, []);
  });
}

test('sync tracks every control when the focus is outside the panel', () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.9] });
  h.panel.build();
  h.state.focused = fakeElement('body');

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);
});

test('sync adopts programmatic changes to an ordinary parameter', () => {
  const h = makeHarness({
    params: [{ name: 'Speed', value: 0.1, min: 0, max: 1 }],
    engineValues: [0.9],
  });
  h.panel.build();

  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);
});

test('a segmented Lens dropdown follows the renderer', () => {
  const lens = {
    name: 'Lens', value: 3, requestedValue: 0, acceptedValue: 0,
    options: ['None', 'Glitch', 'Twist', 'Kaleidoscope', 'Mobius', 'Tangent Noise'],
    animated: true,
  };
  const h = makeHarness({ params: [lens], segmentValues: [3], ownsDisplay: true });
  h.panel.build();
  const controller = h.gui().ctrl('Lens');

  controller.domElement.dispatch('pointerdown', pointerDown());
  assert.equal(controller.dragging, false, 'a dropdown never claims continuous-drag ownership');
  assert.deepEqual(h.dragTarget.listeners, []);

  h.panel.sync();

  assert.equal(controller.getValue(), 3);
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

// getParamValues() is the per-frame stream; the definitions are a snapshot, and
// only an enum selector needs the requestedValue they alone carry.
test('sync marshals no definitions for an effect with no enum control', () => {
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.4, 1] });
  h.panel.build();
  const before = h.paramDefinitionReads();

  h.panel.sync();

  assert.equal(h.paramDefinitionReads(), before);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.4, 'values still track');
  assert.equal(h.gui().ctrl('Glow').getValue(), true);
});

test('sync marshals the definitions once for an effect with an enum control', () => {
  const mode = {
    name: 'Mode', value: 0, requestedValue: 0, options: ['Off', 'On'],
    animated: true,
  };
  const h = makeHarness({ params: [mode, SPEED], engineValues: [0, 0.4] });
  h.panel.build();
  const before = h.paramDefinitionReads();
  h.state.params = [{ ...mode, requestedValue: 1 }, SPEED];

  h.panel.sync();

  assert.equal(h.paramDefinitionReads(), before + 1);
  assert.equal(h.gui().ctrl('Mode').getValue(), 1, 'the requested enum is adopted');
});

test('a selector the engine does not drive costs no per-frame marshal', () => {
  const mode = {
    name: 'Mode', value: 0, requestedValue: 0, options: ['Off', 'On'],
  };
  const h = makeHarness({ params: [mode, SPEED], engineValues: [0, 0.4] });
  h.panel.build();
  const before = h.paramDefinitionReads();

  h.panel.sync();
  h.panel.sync();

  assert.equal(h.paramDefinitionReads(), before, 'the definitions are not marshalled');
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.4, 'the value stream still mirrors');

  const driven = makeHarness({
    params: [{ ...mode, animated: true }, SPEED],
    engineValues: [0, 0.4],
  });
  driven.panel.build();
  const drivenBefore = driven.paramDefinitionReads();

  driven.panel.sync();

  assert.equal(driven.paramDefinitionReads(), drivenBefore + 1,
    'an engine-driven selector still reads its requested value each frame');
});

test('a frame that did not step the simulation skips the definition marshal', () => {
  const mode = {
    name: 'Mode', value: 0, requestedValue: 0, options: ['Off', 'On'],
    animated: true,
  };
  const h = makeHarness({ params: [mode, SPEED], engineValues: [0, 0.4] });
  h.panel.build();
  const before = h.paramDefinitionReads();
  h.state.params = [{ ...mode, requestedValue: 1 }, SPEED];

  h.panel.sync(false);

  assert.equal(h.paramDefinitionReads(), before, 'the definitions are not marshalled');
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.4, 'the value stream still mirrors');

  h.panel.sync(true);

  assert.equal(h.gui().ctrl('Mode').getValue(), 1,
    'a stepped frame adopts the requested enum');
});

test('sync leaves a selector the user has open alone', () => {
  const mode = {
    name: 'Mode', value: 0, requestedValue: 0, options: ['Off', 'On'],
    animated: true,
  };
  const h = makeHarness({ params: [mode, SPEED], engineValues: [0, 0.4] });
  h.panel.build();
  const selector = h.gui().ctrl('Mode');
  const displays = selector.displayUpdates;
  h.state.focused = selector.$select;
  h.state.params = [{ ...mode, requestedValue: 1 }, SPEED];

  h.panel.sync();

  assert.equal(selector.getValue(), 0, 'the open dropdown keeps its selection');
  assert.equal(selector.displayUpdates, displays, 'and is not re-rendered');

  h.state.focused = null;
  h.panel.sync();

  assert.equal(selector.getValue(), 1, 'the requested value lands once focus leaves');
});

test('sync rebuilds before reading the main engine value stream', () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.9], generation: 3 });
  h.panel.build();
  h.state.generation = 4;

  h.panel.sync();

  assert.equal(h.guis.length, 2);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);
  assert.equal(h.panel.active().paramGeneration, 4);
});

test('a schema generation change atomically rebuilds and remounts the panel', () => {
  const projection = {
    name: 'Projection', value: 0, options: ['Stereographic', 'Bonne'], animated: true,
  };
  const bonne = { name: 'Bonne Parallel', value: 0.4, min: 0.01, max: 1.5, animated: true };
  const h = makeHarness({ params: [projection], engineValues: [0], generation: 7 });
  h.panel.build();
  h.panel.mount();
  const oldGui = h.gui();
  const oldProjection = oldGui.ctrl('Projection');
  oldGui.$children.scrollTop = 420;

  h.state.params = [{ ...projection, value: 1 }, bonne];
  h.state.engineValues = [1, 0.6];
  h.state.generation = 8;
  h.panel.sync();

  assert.equal(oldGui.destroyed, 1);
  assert.deepEqual(h.container.children, [h.gui().domElement]);
  assert.deepEqual(h.panel.active().paramNames, ['Projection', 'Bonne Parallel']);
  assert.equal(h.gui().ctrl('Projection').getValue(), 1);
  assert.equal(h.gui().ctrl('Bonne Parallel').getValue(), 0.6);
  assert.equal(h.gui().$children.scrollTop, 420);
  assert.equal(oldProjection.getValue(), 0, 'the retired binding is never updated');
  assert.deepEqual(h.warnings, []);

  h.panel.sync();
  assert.equal(h.gui().ctrl('Bonne Parallel').getValue(), 0.6);
});

test('a failed schema rebuild keeps the live panel and reports once per generation', () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.1], generation: 3 });
  h.panel.build();
  h.panel.mount();
  const live = h.gui();

  h.state.params = null;
  h.state.generation = 4;
  h.panel.sync();

  assert.equal(h.panel.active().gui, live, 'a record that never built was published');
  assert.equal(h.panel.active().paramGeneration, 3);
  assert.deepEqual(h.container.children, [live.domElement]);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /parameter-schema rebuild failed/);
  assert.equal(h.guis.length, 2, 'the failed rebuild allocated one panel');
  assert.equal(h.guis[1].destroyed, 1);

  h.panel.sync();
  h.panel.sync();

  assert.equal(h.warnings.length, 1, 'the same failure logged again on the next frame');
  assert.deepEqual(h.configNotices, ['Effect controls could not be rebuilt.']);
  assert.equal(h.guis.length, 2,
    'a failure the generation has not moved past re-allocated a panel per frame');

  h.state.generation = 5;
  h.panel.sync();

  assert.equal(h.warnings.length, 2, 'a fresh generation failing went unreported');
  assert.equal(h.guis.length, 3, 'a fresh generation never retried the rebuild');
  assert.equal(h.guis[2].destroyed, 1);

  // The definitions come back: the throttle must not have latched the panel out
  // of ever rebuilding.
  h.state.params = [SPEED, GLOW];
  h.state.engineValues = [0.4, true];
  h.state.generation = 6;
  h.panel.sync();

  assert.notEqual(h.panel.active().gui, live);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.4);
  assert.equal(h.guis.length, 4);
  assert.equal(h.warnings.length, 2);
});

test('a schema rebuild hands keyboard focus back to the same control', () => {
  const projection = {
    name: 'Projection', value: 0, options: ['Stereographic', 'Bonne'], animated: true,
  };
  const bonne = { name: 'Bonne Parallel', value: 0.4, min: 0.01, max: 1.5, animated: true };
  const h = makeHarness({
    params: [projection], engineValues: [0], generation: 7, isMobile: true,
  });
  h.panel.build();
  h.panel.mount();
  assert.equal(h.gui().closed, true, 'the first mobile mount keeps its default');
  h.gui().open();
  h.state.focused = h.gui().ctrl('Projection').$select;

  h.state.params = [{ ...projection, value: 1 }, bonne];
  h.state.engineValues = [1, 0.6];
  h.state.generation = 8;
  h.panel.sync();

  assert.equal(h.gui().closed, false, 'the rebuilt panel keeps the user state');
  assert.equal(h.gui().ctrl('Projection').$select.focusCalls, 1);
  assert.equal(h.gui().ctrl('Bonne Parallel').$input.focusCalls, 0);
});

test('a schema rebuild moves focus nowhere when the panel never held it', () => {
  const projection = {
    name: 'Projection', value: 0, options: ['Stereographic', 'Bonne'], animated: true,
  };
  const h = makeHarness({
    params: [projection], engineValues: [0], generation: 7, isMobile: true,
  });
  h.panel.build();
  h.panel.mount();
  assert.equal(h.gui().closed, true);
  h.state.focused = fakeElement('input');

  h.state.params = [{ ...projection, value: 1 }];
  h.state.engineValues = [1];
  h.state.generation = 8;
  h.panel.sync();

  assert.equal(h.gui().closed, true, 'a collapsed panel stays collapsed');
  assert.equal(h.gui().ctrl('Projection').$select.focusCalls, 0);
});

test('a refused edit republishes the warning it raised, and its withdrawal', () => {
  const projection = {
    name: 'Projection', value: 0, requestedValue: 0,
    options: ['Stereographic', 'Bonne', 'Mercator'], animated: true,
  };
  const warning = 'Bonne needs a nonzero parallel.';
  const h = makeHarness({
    params: [projection],
    engineValues: [0],
    generation: 7,
    isMobile: true,
    // A refusal publishes its reason on the definition without loading an
    // effect, so the schema generation stands still.
    onEngineParam(name, value, state) {
      if (name !== 'Projection') return;
      if (value === 1) {
        state.params = [{ ...projection, warning }];
        return false;
      }
      state.params = [{ ...projection, requestedValue: value }];
    },
  });
  h.panel.build();
  h.panel.mount();
  h.gui().open();
  h.state.focused = h.gui().ctrl('Projection').$select;

  h.gui().ctrl('Projection').setValue(1);
  h.panel.sync();

  assert.ok(!h.writes.includes('worker:Projection=1'), 'a refused value never reaches the workers');
  const controller = h.gui().ctrl('Projection');
  assert.equal(h.gui().closed, false, 'a warning rebuild keeps the panel open');
  assert.equal(controller.$select.focusCalls, 1);
  assert.equal(h.panel.active().paramGeneration, 7, 'no effect was loaded');
  assert.equal(controller.domElement.classList.contains('param-warning'), true);
  assert.equal(controller.$select.getAttribute('aria-invalid'), 'true');
  const note = controller.domElement.querySelector('.param-warning-note');
  assert.equal(note.textContent, warning);
  assert.equal(controller.$select.getAttribute('aria-describedby'), note.id);
  assert.deepEqual(h.container.children, [h.gui().domElement]);

  controller.setValue(2);
  h.panel.sync();

  const cleared = h.gui().ctrl('Projection');
  assert.equal(cleared.domElement.classList.contains('param-warning'), false);
  assert.equal(cleared.$select.getAttribute('aria-invalid'), null);
});

test('a preset selection republishes the warnings the engine now carries', () => {
  const warning = 'Speed is faster than the segment stream can follow.';
  const h = makeHarness({
    params: [{ ...SPEED, warning }],
    engineValues: [0.9],
    presetCount: 3,
    presetIndex: 0,
  });
  h.panel.build();
  h.panel.mount();
  assert.equal(h.gui().ctrl('Speed').domElement
    .querySelector('.param-warning-note').textContent, warning);

  // The preset writes a value the engine accepts, withdrawing the warning with
  // no schema generation behind it.
  h.state.params = [SPEED];
  h.state.engineValues = [0.1];
  h.gui().ctrl('presetIndex').setValue(2);
  h.panel.sync();

  const speed = h.gui().ctrl('Speed');
  assert.equal(speed.domElement.classList.contains('param-warning'), false);
  assert.equal(speed.domElement.querySelector('.param-warning-note'), null);
  assert.equal(speed.$input.getAttribute('aria-invalid'), null);
});

test('an edit that changes no warning costs one definitions read and no rebuild', () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.5], generation: 3 });
  h.panel.build();
  h.gui().ctrl('Speed').setValue(0.5);
  const before = h.paramDefinitionReads();

  h.panel.sync();
  h.panel.sync();

  assert.equal(h.paramDefinitionReads(), before + 1,
    'the warnings are re-read once per edit, not once per frame');
  assert.equal(h.guis.length, 1, 'the panel is kept');
});

test('a warning raised mid-drag lands on the pointer release', () => {
  const speed = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
  const warning = 'Speed is faster than the segment stream can follow.';
  const h = makeHarness({
    params: [speed],
    engineValues: [0.1],
    onEngineParam(name, value, state) {
      state.params = [value > 0.5 ? { ...speed, warning } : { ...speed }];
    },
  });
  h.panel.build();
  h.panel.mount();
  const controller = h.gui().ctrl('Speed');

  controller.domElement.dispatch('pointerdown', pointerDown());
  controller.setValue(0.9);
  h.panel.sync();

  assert.equal(h.guis.length, 1, 'the controller under the pointer survives');
  assert.equal(h.gui().ctrl('Speed').domElement.classList.contains('param-warning'),
    false);

  h.dragTarget.dispatch('pointerup', pointerUp());
  h.panel.sync();

  assert.equal(h.guis.length, 2);
  assert.equal(h.gui().ctrl('Speed').domElement
    .querySelector('.param-warning-note').textContent, warning);
});

test('a warning raised mid-key-repeat lands on the key release', () => {
  const speed = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
  const warning = 'Speed is faster than the segment stream can follow.';
  const h = makeHarness({
    params: [speed],
    engineValues: [0.1],
    onEngineParam(name, value, state) {
      state.params = [value > 0.5 ? { ...speed, warning } : { ...speed }];
    },
  });
  h.panel.build();
  h.panel.mount();
  const controller = h.gui().ctrl('Speed');

  controller.$input.dispatch('keydown', { key: 'ArrowUp' });
  controller.setValue(0.9);
  h.panel.sync();

  assert.equal(h.guis.length, 1, 'the input the key repeat lands in survives');
  assert.equal(h.gui().ctrl('Speed').domElement.classList.contains('param-warning'),
    false);

  controller.$input.dispatch('keyup', { key: 'ArrowUp' });
  h.panel.sync();

  assert.equal(h.guis.length, 2);
  assert.equal(h.gui().ctrl('Speed').domElement
    .querySelector('.param-warning-note').textContent, warning);
});

test('Lens Glitch to None survives a rebuild before the renderer advances', () => {
  const lens = {
    name: 'Lens', value: 1, requestedValue: 1, acceptedValue: 1,
    options: ['None', 'Glitch', 'Twist', 'Kaleidoscope', 'Mobius', 'Tangent Noise'],
    animated: true,
  };
  const h = makeHarness({
    params: [lens],
    segmentValues: [1],
    ownsDisplay: true,
    onEngineParam(name, value, state) {
      if (name !== 'Lens' || value !== 0) return;
      state.params = [{ ...lens, requestedValue: 0, acceptedValue: 0 }];
      state.generation = 2;
    },
  });
  h.panel.build();

  h.gui().ctrl('Lens').setValue(0);
  h.state.segmentValues = null;
  h.panel.sync();
  assert.equal(h.gui().ctrl('Lens').getValue(), 0);

  h.state.segmentValues = [0];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Lens').getValue(), 0);
});

test('requested selectors and rendered numeric values stay authoritative', () => {
  const functionDef = {
    name: 'Function', value: 4,
    options: ['Twin Wave', 'Rings', 'Spiral', 'Grid', 'Coupled / Direct',
      'Noise Contour', 'Primitive Lattice'],
    animated: true,
  };
  const projectionDef = {
    name: 'Projection', value: 6,
    options: ['Folded Sinusoidal', 'Stereographic', 'Gnomonic', 'Bonne',
      'Peirce Quincuncial', 'Dymaxion / Airocean', 'Equirectangular'],
    animated: true,
  };
  const h = makeHarness({
    params: [functionDef, projectionDef, SPEED],
    segmentValues: [4, 6, 0.1],
    ownsDisplay: true,
    presetCount: 3,
    presetIndex: 0,
    onEngineParam(name, value, state) {
      if (name !== 'Projection' || value !== 0) return;
      state.params = [functionDef,
        { ...projectionDef, requestedValue: 0, acceptedValue: 0 }, SPEED];
      state.generation = 2;
    },
    onSynchronizePreset(index, state) {
      state.params = [
        { ...functionDef, value: 6 },
        { ...projectionDef, value: 0 },
        { ...SPEED, value: 0.9 },
      ];
      state.generation = 3;
    },
  });
  h.panel.build();

  h.gui().ctrl('Projection').setValue(0);
  h.state.segmentValues = null;
  h.panel.sync();
  assert.equal(h.gui().ctrl('Projection').getValue(), 0);

  h.state.segmentValues = [4, 0, 0.2];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Projection').getValue(), 0);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.2);

  h.gui().ctrl('Speed').dragging = true;
  h.state.segmentValues = [4, 0, 0.4];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.2);
  h.gui().ctrl('Speed').dragging = false;
  h.panel.sync();
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.4);

  h.state.presetIndex = 2;
  h.state.segmentValues = [4, 0, 0.55];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Function').getValue(), 4);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.55);

  h.state.segmentValues = [6, 0, 0.9];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Function').getValue(), 6);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);
});

test('initial topology hydration reveals and replays its dependent controls', () => {
  const projection = {
    name: 'Projection', value: 0, options: ['Stereographic', 'Bonne'], animated: true,
  };
  const bonne = { name: 'Bonne Parallel', value: 0.4, min: 0.01, max: 1.5, animated: true };
  const h = makeHarness({
    params: [projection],
    generation: 20,
    hydrated: { Projection: 1, 'Bonne Parallel': 0.9 },
    onEngineParam(name, value, state) {
      if (name !== 'Projection' || value !== 1) return;
      state.params = [{ ...projection, value: 1 }, bonne];
      state.generation = 21;
    },
  });

  h.panel.build();
  h.panel.mount();
  assert.deepEqual(h.panel.active().paramNames, ['Projection']);

  h.panel.sync();

  assert.deepEqual(h.panel.active().paramNames, ['Projection', 'Bonne Parallel']);
  assert.equal(h.gui().ctrl('Projection').getValue(), 1);
  assert.equal(h.gui().ctrl('Projection').unhydrated, true);
  assert.equal(h.gui().ctrl('Bonne Parallel').getValue(), 0.9);
  assert.deepEqual(h.writes.filter((w) => w.includes('Bonne Parallel')), [
    'engine:Bonne Parallel=0.9',
    'worker:Bonne Parallel=0.9',
  ]);
});

test('a schema rebuild preserves the engine pause and hydrates only new controls', () => {
  const detail = { name: 'Detail', value: 0.2, min: 0, max: 1, animated: true };
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.1],
    generation: 2,
    hydrated: { Speed: 0.8, Detail: 0.7, pause: false },
  });
  h.panel.build();
  h.panel.mount();
  h.panel.applyAnimationPause();
  h.engine.paused = true;
  h.writes.length = 0;

  h.state.params = [{ ...SPEED, value: 0.55 }, detail];
  h.state.engineValues = [0.55, 0.7];
  h.state.generation = 3;
  h.panel.sync();

  assert.equal(h.gui().ctrl('Speed').getValue(), 0.55,
    'an existing control takes the authoritative engine value');
  assert.equal(h.gui().ctrl('Speed').unhydrated, true);
  assert.equal(h.gui().ctrl('Detail').getValue(), 0.7,
    'a newly relevant deep-link value is replayed');
  assert.equal(h.gui().ctrl('pause').getValue(), true);
  assert.equal(h.gui().ctrl('pause').unhydrated, true);
  assert.deepEqual(h.writes, ['engine:Detail=0.7', 'worker:Detail=0.7'],
    'rebuilding does not write a guessed pause state');
});

test('segmented mode rebuilds from main-engine definitions before reading worker values', () => {
  const h = makeHarness({
    params: [SPEED],
    segmentValues: [0.95],
    ownsDisplay: true,
    generation: 11,
  });
  h.panel.build();
  h.panel.mount();
  const depth = { name: 'Depth', value: 0.25, min: 0, max: 1, animated: true };
  h.state.params = [depth];
  h.state.generation = 12;
  h.state.segmentValues = null;

  h.panel.sync();

  assert.deepEqual(h.panel.active().paramNames, ['Depth']);
  assert.equal(h.gui().ctrl('Depth').getValue(), 0.25,
    'the old same-length worker stream cannot bind to the new definition');

  h.state.segmentValues = [0.6];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Depth').getValue(), 0.6);
});

test('a refused preset sync still rebuilds a stale schema', () => {
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.9],
    generation: 11,
    presetCount: 3,
    presetIndex: 0,
    presetSyncAccepted: false,
  });
  h.panel.build();
  const depth = { name: 'Depth', value: 0.25, min: 0, max: 1, animated: true };
  h.state.params = [depth];
  h.state.engineValues = [0.6];
  h.state.generation = 12;
  // The live preset the main engine's older effect cannot hold: the refusal
  // that follows is exactly what the rebuild resolves.
  h.state.presetIndex = 2;

  h.panel.sync();

  assert.deepEqual(h.panel.active().paramNames, ['Depth']);
  assert.equal(h.panel.active().paramGeneration, 12);
  assert.equal(h.gui().ctrl('Depth').getValue(), 0.25,
    'the refusal still gates the value poll');

  h.state.hostPresetIndex = 2;
  h.panel.sync();
  assert.equal(h.gui().ctrl('Depth').getValue(), 0.6);
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
  assert.equal(h.warnings.length, 1, 'two syncs inside one episode warn once');
  assert.match(h.warnings[0], /param\/value length skew \(2 vs 1\)/);

  h.state.engineValues = [0.9, 1];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);

  h.state.engineValues = [0.4];
  h.panel.sync();
  assert.equal(h.warnings.length, 2, 'a new skew episode warns again');
});

test('an effect switch clears the skew latch', () => {
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.9] });
  h.panel.build();
  h.panel.sync();
  assert.equal(h.warnings.length, 1);

  h.panel.destroy();
  h.panel.build();
  h.panel.sync();

  assert.equal(h.warnings.length, 2,
    'the next effect gets its own skew episode');
});

test('preset controls carry icon labels and accessible names', () => {
  const h = makeHarness({ presetCount: 3, presetIndex: 0 });
  h.panel.build();

  assert.deepEqual(h.gui().controllers.slice(0, 5).map((c) => c.property),
    ['reset', 'export', 'presetIndex', 'previousPreset', 'nextPreset']);
  assert.equal(h.gui().ctrl('reset').label, '\u21ba');
  assert.equal(h.gui().ctrl('export').label, '\u29c9');
  assert.equal(h.gui().ctrl('previousPreset').label, '\u25c0');
  assert.equal(h.gui().ctrl('nextPreset').label, '\u25b6');
  for (const [property, label] of [
    ['reset', 'Reset'],
    ['export', 'Export'],
    ['previousPreset', 'Previous Preset'],
    ['nextPreset', 'Next Preset'],
  ]) {
    const button = h.gui().ctrl(property).$button;
    assert.equal(button.getAttribute('aria-label'), label);
    assert.equal(button.getAttribute('title'), label);
  }
});

test('the preset action row lays its controls out in one grid row', () => {
  const h = makeHarness({ presetCount: 3, presetIndex: 0 });
  h.panel.build();

  const actionRow = h.gui().$children.children[0];
  assert.ok(actionRow.classList.contains('effect-action-row'));
  // display/grid-auto-flow belong to the stylesheet; only the count is dynamic.
  assert.equal(actionRow.style.display, '');
  assert.equal(actionRow.style.gridAutoFlow, '');
  assert.equal(actionRow.style.gridTemplateColumns,
    'repeat(5, minmax(0px, 1fr))');
  // The live region is out of flow, so it takes no column of its own.
  const [status, ...controls] = actionRow.children;
  assert.equal(status.getAttribute('role'), 'status');
  assert.deepEqual(controls,
    ['reset', 'export', 'previousPreset', 'presetIndex', 'nextPreset']
      .map((property) => h.gui().ctrl(property).domElement));
  assert.ok(h.gui().ctrl('previousPreset').domElement.classList
    .contains('preset-nav-previous'));
  assert.ok(h.gui().ctrl('presetIndex').domElement.classList
    .contains('preset-nav-selector'));
  assert.ok(h.gui().ctrl('nextPreset').domElement.classList
    .contains('preset-nav-next'));
});

test('preset effects expose one-based labels and zero-indexed navigation', () => {
  const h = makeHarness({ presetCount: 3, presetIndex: 0 });
  h.panel.build();

  assert.equal(h.gui().ctrl('presetIndex').getValue(), 0);
  assert.deepEqual({ ...h.gui().ctrl('presetIndex').args[0] }, { 1: 0, 2: 1, 3: 2 });
  assert.equal(h.gui().ctrl('presetIndex').disabled, false);
  assert.equal(h.gui().ctrl('presetIndex').session, true);

  h.gui().ctrl('previousPreset').object.previousPreset();
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 2);
  h.gui().ctrl('nextPreset').object.nextPreset();
  assert.deepEqual(h.writes, ['preset:2', 'preset:0']);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 0);
  assert.equal(h.gui().ctrl('pause').getValue(), true);
  assert.equal(h.gui().stored.pause, true);
});

test('preset navigation is available to global keyboard shortcuts', () => {
  const h = makeHarness({ presetCount: 3, presetIndex: 1 });
  h.panel.build();

  assert.equal(h.panel.movePreset(-1), true);
  assert.equal(h.panel.movePreset(1), true);
  assert.deepEqual(h.writes, ['preset:0', 'preset:1']);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 1);
});

test('a preset selection adopts requested enums with no stepped frame behind it', () => {
  const mode = {
    name: 'Mode', value: 0, requestedValue: 0, options: ['Off', 'On'],
    animated: true,
  };
  const h = makeHarness({
    params: [mode, SPEED], engineValues: [0, 0.4],
    presetCount: 3, presetIndex: 0,
  });
  h.panel.build();
  h.state.params = [{ ...mode, requestedValue: 1 }, SPEED];

  h.gui().ctrl('presetIndex').setValue(2);

  assert.equal(h.gui().ctrl('Mode').getValue(), 1, 'the preset selector lands at once');

  h.panel.sync(false);

  assert.equal(h.gui().ctrl('Mode').getValue(), 1, 'and an unstepped frame keeps it');
});

test('the preset dropdown sends its zero-indexed value', () => {
  const h = makeHarness({ presetCount: 4, presetIndex: 1 });
  h.panel.build();

  h.gui().ctrl('presetIndex').setValue(3);

  assert.deepEqual(h.writes, ['preset:3']);
  assert.equal(h.state.presetIndex, 3);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 3);
});

test('natural worker preset advancement keeps live transition values', () => {
  const FUNCTION = {
    name: 'Function', value: 4,
    options: ['Twin Wave', 'Rings', 'Spiral', 'Grid', 'Coupled / Direct',
      'Noise Contour', 'Primitive Lattice'],
    animated: true,
  };
  const TARGET_FUNCTION = { ...FUNCTION, value: 6 };
  const TARGET_SPEED = { ...SPEED, value: 0.9 };
  const h = makeHarness({
    params: [FUNCTION, SPEED],
    segmentValues: [4, 0.1],
    ownsDisplay: true,
    presetCount: 3,
    presetIndex: 0,
    onSynchronizePreset: (index, state) => {
      state.params = [TARGET_FUNCTION, TARGET_SPEED];
      state.engineValues = [6, 0.9];
      state.generation = 2;
    },
  });
  h.panel.build();
  h.panel.applyAnimationPause();
  const oldGui = h.gui();
  h.writes.length = 0;

  h.state.presetIndex = 2;
  h.panel.sync();

  assert.equal(oldGui.destroyed, 1);
  assert.equal(h.gui().ctrl('Function').getValue(), 4);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.1);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 2);
  assert.equal(h.gui().ctrl('pause').getValue(), false);
  assert.deepEqual(h.writes, ['syncPreset:2']);

  h.state.segmentValues = [4, 0.45];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.45);

  h.state.segmentValues = [6, 0.9];
  h.panel.sync();
  assert.equal(h.gui().ctrl('Function').getValue(), 6);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);
});

test('a preset rebuild adopts the post-sync preset range and index', () => {
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.1],
    generation: 1,
    presetCount: 3,
    presetIndex: 0,
    onSynchronizePreset: (index, state) => {
      state.presetCount = 1;
      state.presetIndex = 0;
      state.hostPresetIndex = 0;
      state.generation = 2;
    },
  });
  h.panel.build();
  const oldGui = h.gui();

  h.state.presetIndex = 2;
  h.panel.sync();

  const preset = h.gui().ctrl('presetIndex');
  assert.equal(oldGui.destroyed, 1);
  assert.deepEqual({ ...preset.args[0] }, { 1: 0 });
  assert.equal(preset.getValue(), 0);
  assert.deepEqual(h.writes, ['syncPreset:2']);
});

test('a rejected preset selection does not change the pause state', () => {
  const h = makeHarness({
    params: [SPEED], presetCount: 3, presetIndex: 1,
    presetSelectionAccepted: false,
  });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('presetIndex').setValue(2);

  assert.equal(h.panel.active().pause.animationState.pause, false);
  assert.equal(h.engine.paused, false);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 1);
  assert.deepEqual(h.writes, ['preset:2']);
});

test('effects without presets do not show preset navigation', () => {
  const h = makeHarness();
  h.panel.build();
  assert.equal(h.panel.movePreset(1), false);
  assert.equal(h.gui().ctrl('previousPreset'), undefined);
  assert.equal(h.gui().ctrl('nextPreset'), undefined);
  assert.equal(h.gui().ctrl('presetIndex'), undefined);
  assert.equal(h.gui().$children.children[0].style.gridTemplateColumns,
    'repeat(2, minmax(0px, 1fr))');
});
