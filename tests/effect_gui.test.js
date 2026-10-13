import { CHAIN_SNAPSHOT_STORAGE_KEY } from '../src/effects/effect_persistence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, restoreDocumentAfterEach } from './helpers/fake_dom.js';

import { createEffectGui } from '../src/ui/effect_gui.js';
import { stageGrouping } from '../src/effects/shader_stages.js';
import {
  chainSnapshot,
  chainSnapshotParams,
  kaleidoscopeMeltParams,
  kaleidoscopeSmoothParams,
  makeHarness,
  SPEED,
  GLOW,
  TELEMETRY,
  wiring,
  chainParams,
} from './helpers/effect_gui_harness.js';

const KALEIDOSCOPE_MELT_STAGE_ORDER = ['Camera', 'Surface Noise', 'Projection Frame', 'Projection', 'Function', 'Colorize'];
const KALEIDOSCOPE_SMOOTH_STAGE_ORDER = ['Camera', 'Projection Frame', 'Projection', 'Planar Warp 2', 'Function', 'Colorize'];

restoreDocumentAfterEach();

// createEffectGui's effect panel, driven over doubles for every injected
// collaborator.

// Collaborators are checked once, where the page is composed.

test('a wiring carrying every demanded member constructs, config and all optionals absent', () => {
  const panel = createEffectGui(wiring());
  assert.equal(panel.active(), null);
});

test('construction names the collaborator a missing member belongs to', () => {
  for (const [group, member] of [
    ['engine', 'setParam'], ['engine', 'animationsPaused'],
    ['segments', 'paramValues'], ['host', 'createGui'],
  ]) {
    const deps = wiring();
    delete deps[group][member];
    assert.throws(() => createEffectGui(deps),
      new RegExp(`${group}\\.${member} must be a function`),
      `a missing ${group}.${member} must be reported`);
  }
});

test('construction rejects an uncallable member and a missing group', () => {
  const uncallable = wiring();
  uncallable.engine.selectPreset = true;
  assert.throws(() => createEffectGui(uncallable), /engine\.selectPreset must be a function/);

  const optional = wiring();
  optional.host.paramFilter = 'none';
  assert.throws(() => createEffectGui(optional), /host\.paramFilter must be a function/);

  const inert = wiring();
  inert.config = { inUse: null };
  assert.throws(() => createEffectGui(inert), /config\.inUse must be a function/);

  const dropped = wiring();
  delete dropped.segments;
  assert.throws(() => createEffectGui(dropped), /the segments collaborator is missing/);
});

test('construction rejects a drag target that listens to nothing', () => {
  const deps = wiring();
  deps.host.dragTarget = {};
  assert.throws(() => createEffectGui(deps), /host\.dragTarget must be an event target/);
});

test('sparse enum controls roundtrip numeric IDs and reject gaps before a write', () => {
  const parameter = { name: 'Pattern', value: 0, requestedValue: 6, acceptedValue: 0,
    options: ['Cubic', 'Octet Truss', 'Shells'], optionValues: [0, 1, 6], animated: true };
  const h = makeHarness({ params: [parameter], engineValues: [6] });
  h.panel.build();
  const controller = h.gui().ctrl('Pattern');
  assert.deepEqual({ ...controller.args[0] }, { Cubic: 0, 'Octet Truss': 1, Shells: 6 });
  assert.equal(controller.getValue(), 6);
  for (const value of [0, 1, 6]) {
    controller.setValue(value);
    assert.equal(controller.getValue(), value);
  }
  assert.ok(h.writes.includes('engine:Pattern=6'));
  assert.ok(h.writes.includes('worker:Pattern=6'));
  const before = h.writes.length;
  controller.setValue(2);
  assert.equal(controller.getValue(), 6);
  assert.equal(h.writes.length, before);
  parameter.requestedValue = 1;
  h.panel.sync();
  assert.equal(controller.getValue(), 1);
  h.state.ownsDisplay = true;
  h.state.segmentValues = [6];
  h.panel.sync();
  assert.equal(controller.getValue(), 6);
});

test('stage controls sharing a visible label keep distinct accessible names', () => {
  const params = kaleidoscopeMeltParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });

  h.panel.build();

  const labelled = params
    .map((p) => h.gui().ctrl(p.name))
    .filter((c) => c.folder !== undefined);
  const shared = labelled.filter((c) => c.label === 'Wander');
  assert.ok(shared.length > 1, 'camera and projection share the visible Wander label');
  const widget = (c) => c.$select ?? c.$input ?? c.$button;
  for (const controller of shared) {
    assert.equal(widget(controller).getAttribute('aria-labelledby'), null,
      'the shared visible label is not the accessible name');
  }
  const names = labelled.map((c) => widget(c).getAttribute('aria-label'));
  assert.equal(new Set(names).size, names.length,
    'every stage control has its own accessible name');
  assert.equal(widget(h.gui().ctrl('Camera Wander')).getAttribute('aria-label'),
    'Camera Wander');
});

test('a schema rebuild keeps the stage folders the user collapsed', () => {
  const params = kaleidoscopeMeltParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
    generation: 7,
  });
  h.panel.build();
  h.panel.mount();
  const folder = (name) => h.gui().folders.find((f) => f.name === name);
  folder('Curl').close();
  folder('Generated Analogous').close();

  h.state.generation = 8;
  h.panel.sync();

  assert.equal(h.guis.length, 2, 'the panel was rebuilt');
  assert.deepEqual(h.gui().folders.map((f) => f.name), ['Camera', 'Curl', 'Spin + Wander', 'Equirectangular', 'Primitive Lattice', 'Generated Analogous']);
  assert.equal(folder('Curl').closed, true);
  assert.equal(folder('Generated Analogous').closed, true);
  assert.equal(folder('Primitive Lattice').closed, false, 'the rest stay open');
});

test('KaleidoscopeMelt controls use the fixed pipeline modes as folders', () => {
  const params = kaleidoscopeMeltParams();
  const assignments = stageGrouping(params).assignments;
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });

  h.panel.build();

  assert.deepEqual([...new Set(assignments.values())].sort(),
    [...KALEIDOSCOPE_MELT_STAGE_ORDER].sort());
  assert.deepEqual(h.gui().folders.map((folder) => folder.name),
    ['Camera', 'Curl', 'Spin + Wander', 'Equirectangular',
      'Primitive Lattice', 'Generated Analogous']);
  assert.equal(h.gui().ctrl('Camera Wander').folder, 'Camera');
  assert.equal(h.gui().ctrl('Camera Wander').label, 'Wander');
  assert.equal(h.gui().ctrl('Surface Noise Strength').folder, 'Curl');
  assert.equal(h.gui().ctrl('Surface Noise Strength').label, 'Strength');
  assert.equal(h.gui().ctrl('Projection Spin Speed').folder, 'Spin + Wander');
  assert.equal(h.gui().ctrl('Projection Spin Speed').label, 'Spin Speed');
  assert.equal(h.gui().ctrl('Central Meridian').folder, 'Equirectangular');
  assert.equal(h.gui().ctrl('Lattice Cell Scale').folder, 'Primitive Lattice');
  assert.equal(h.gui().ctrl('Lattice Cell Scale').label, 'Cell Scale');
  assert.equal(h.gui().ctrl('Hue Noise Speed').folder, 'Generated Analogous');
  assert.deepEqual(h.warnings, [], 'every parameter reached a stage');
});

test('a staged schema builds an unclaimed parameter at the top level', () => {
  const params = [...kaleidoscopeMeltParams(),
    { name: 'Palette Surprise', value: 0.5, min: 0, max: 1, animated: true }];
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });

  h.panel.build();

  assert.ok(h.panel.active(), 'the panel is published');
  assert.equal(h.gui().destroyed, 0, 'the panel is not disposed');
  assert.equal(h.gui().ctrl('Palette Surprise').folder, undefined,
    'the orphan sits above the stage folders');
  assert.deepEqual(params.map((parameter) => parameter.name)
    .filter((name) => h.gui().ctrl(name).folder === undefined),
    ['Palette Surprise'], 'every claimed parameter still reaches its stage');
  assert.deepEqual(h.warnings,
    ['Effect GUI: no pipeline stage claims Palette Surprise']);

  // A rebuild over the same schema: every preset and every warning move makes
  // one, and none of them is news.
  h.panel.mount();
  h.state.generation += 1;
  h.panel.sync();

  assert.equal(h.guis.length, 2, 'the panel was rebuilt');
  assert.deepEqual(h.warnings,
    ['Effect GUI: no pipeline stage claims Palette Surprise'],
    'the same unclaimed set is reported once');
});

test('KaleidoscopeSmooth controls use the fixed pipeline modes as folders', () => {
  const params = kaleidoscopeSmoothParams();
  const assignments = stageGrouping(params).assignments;
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });

  h.panel.build();

  assert.deepEqual([...new Set(assignments.values())].sort(),
    [...KALEIDOSCOPE_SMOOTH_STAGE_ORDER].sort());
  assert.deepEqual(h.gui().folders.map((folder) => folder.name),
    ['Camera', 'Spin + Wander', 'Stereographic', 'Mirror Tile', 'Grid',
      'Generated Analogous']);
  assert.equal(h.gui().ctrl('Camera Wander').folder, 'Camera');
  assert.equal(h.gui().ctrl('Projection Spin Speed').folder, 'Spin + Wander');
  assert.equal(h.gui().ctrl('Singularity Fade').folder, 'Stereographic');
  assert.equal(h.gui().ctrl('Mirror Cell Y').folder, 'Mirror Tile');
  assert.equal(h.gui().ctrl('Mirror Cell Y').label, 'Cell Y');
  assert.equal(h.gui().ctrl('Pattern Mix').folder, 'Grid');
  assert.equal(h.gui().ctrl('Hue Noise Speed').folder, 'Generated Analogous');
});

test('composed-effect controls file each slot parameter into its stage folder', () => {
  const params = [
    'Camera Wander', 'Singularity Fade', 'Planar Warp 1 Speed', 'Warp Strength',
    'Planar Warp 2 Speed', 'Mirror Rotation', 'Pattern Freq',
    'Edge Width', 'Palette Chroma', 'Mapping Frequency',
  ].map((name, i) => {
    const groups = ['Camera', 'Projection', 'Planar Warp 1', 'Planar Warp 1', 'Planar Warp 2', 'Planar Warp 2', 'Function', 'Coverage', 'Colorize', 'Colorize'];
    return { name, group: {name: groups[i], title: groups[i], order: [0, 4, 5, 5, 6, 6, 7, 9, 10, 10][i]}, value: 0, min: 0, max: 1, animated: true };
  });
  const h = makeHarness({
    params,
    engineValues: params.map(() => 0),
  });

  h.panel.build();

  assert.deepEqual(h.gui().folders.map((folder) => folder.name),
    ['Camera', 'Projection', 'Planar Warp 1', 'Planar Warp 2', 'Function',
      'Coverage', 'Colorize']);
  assert.equal(h.gui().ctrl('Warp Strength').folder, 'Planar Warp 1');
  assert.equal(h.gui().ctrl('Mirror Rotation').folder, 'Planar Warp 2');
  assert.equal(h.gui().ctrl('Edge Width').folder, 'Coverage');
  assert.deepEqual(h.warnings, [],
    'the composed stage rules file every name they are given');
});

test('warp ownership follows registered groups independently of stream order', () => {
  const assignments = stageGrouping([
    {name: 'Mirror Rotation', group: {name: 'Planar Warp 1', title: 'Outer', order: 5}},
    {name: 'Mirror Cell X', group: {name: 'Planar Warp 2', title: 'Inner', order: 6}},
  ]).assignments;
  assert.equal(assignments.get('Mirror Rotation'), 'Planar Warp 1');
  assert.equal(assignments.get('Mirror Cell X'), 'Planar Warp 2');
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
  assert.equal(fx.hasParams, true);
});

test('building untouched controls does not persist accepted defaults', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  assert.deepEqual(h.gui().storedWrites, []);
});

test('build restores the last accepted value before replaying an invalid request', () => {
  const outer = {
    name: 'Planar Warp 1', value: 1, requestedValue: 1, acceptedValue: 1,
    options: ['None', 'Stereo Noise', 'Vector Noise', 'Curl Flow'],
  };
  const h = makeHarness({
    params: [outer],
    hydrated: { 'Planar Warp 1': 3 },
    acceptedStored: { '__accepted.Planar Warp 1': 0 },
    onEngineParam: (name, value) => {
      outer.requestedValue = value;
      if (value !== 3) {
        outer.value = value;
        outer.acceptedValue = value;
      }
    },
  });

  h.panel.build();

  assert.deepEqual(h.writes, [
    'engine:Planar Warp 1=0',
    'engine:Planar Warp 1=3',
    'worker:Planar Warp 1=3',
  ]);
  assert.equal(h.gui().ctrl('Planar Warp 1').getValue(), 3);
  assert.equal(h.gui().stored['__accepted.Planar Warp 1'], 0);
});

test('a failed initial panel build reports an unavailable control panel', () => {
  const h = makeHarness({ params: null });
  h.panel.build();
  assert.equal(h.panel.active(), null);
  assert.deepEqual(h.configNotices, ['Effect controls could not be built.']);
  assert.match(h.warnings[0], /panel construction failed/);
  assert.equal(h.guis[0].destroyed, 1);
});

for (const rebuild of [false, true]) test(`panel ${rebuild ? 'rebuild' : 'build'} propagates module death`, () => {
  const deps = wiring();
  const trap = new WebAssembly.RuntimeError('unreachable');
  let dead = false;
  deps.engine.getParameterDefinitions = () => { if (dead) throw trap; return []; };
  deps.engine.paramGeneration = () => dead ? 2 : 1;
  const panel = createEffectGui({ ...deps, moduleDead: (error) => error === trap });
  if (rebuild) panel.build();
  dead = true;
  assert.throws(() => rebuild ? panel.sync() : panel.build(), (error) => error === trap);
});

// The engine reports a bool param's values as JS booleans, but the companion
// deep-link key is read back through the URL number grammar, so it holds the
// float form.
test('a bool parameter stores its accepted value as a float', () => {
  const glow = {
    name: 'Glow', value: false, requestedValue: false, acceptedValue: false,
  };
  const h = makeHarness({
    params: [glow],
    onEngineParam: (name, value) => {
      glow.value = value > 0.5;
      glow.requestedValue = glow.value;
      glow.acceptedValue = glow.value;
    },
  });

  h.panel.build();
  h.gui().ctrl('Glow').setValue(true);

  assert.equal(h.gui().stored['__accepted.Glow'], 1);
  const nonNumeric = h.gui().storedWrites.filter(([key, v]) =>
    key.startsWith('__accepted.') && (typeof v !== 'number' || !Number.isFinite(v)));
  assert.deepEqual(nonNumeric, []);
});

test('restore reaches a parameter a write revealed, probing each name once', () => {
  const stage = {
    name: 'Function', value: 0, requestedValue: 0, acceptedValue: 0,
    options: ['Waves', 'Grid'],
  };
  const grid = { name: 'Grid Scale', value: 1, min: 0, max: 8 };
  const h = makeHarness({
    params: [stage, { name: 'Hue Shift', value: 0, min: 0, max: 1 }],
    acceptedStored: { '__accepted.Function': 1, '__accepted.Grid Scale': 4 },
    onEngineParam: (name, value, state) => {
      if (name !== 'Function') return;
      stage.value = value;
      stage.requestedValue = value;
      stage.acceptedValue = value;
      if (value === 1 && !state.params.includes(grid)) state.params.push(grid);
    },
  });

  h.panel.build();

  assert.deepEqual(h.writes.slice(0, 2),
    ['engine:Function=1', 'engine:Grid Scale=4']);
  const reads = h.gui().storedReads;
  assert.deepEqual(reads, [...new Set(reads)], 'no name is probed twice');
});

test('an engine-rejected unversioned snapshot is reported before session controls', () => {
  const stored = chainSnapshot();
  delete stored.schemaVersion;
  const current = chainSnapshot(0);
  const h = makeHarness({
    params: chainSnapshotParams(),
    chainSnapshotEnabled: true,
    chainSnapshot: current,
    acceptedStored: { [CHAIN_SNAPSHOT_STORAGE_KEY]: JSON.stringify(stored) },
  });

  h.panel.build();

  assert.deepEqual(h.restoredChainSnapshots, [stored]);
  assert.deepEqual(h.controllersAtRestore, [0], 'the snapshot is restored before any control is built');
  assert.deepEqual(h.configNotices, ['The chain snapshot was rejected. Its original text remains preserved.']);
  assert.deepEqual(h.warnings,
    ['Shader Workbench: chain snapshot was rejected: INVALID_VALUE']);
  assert.equal(h.gui().ctrl('sample.coverage-mode').session, true);
  assert.equal(h.gui().stored[CHAIN_SNAPSHOT_STORAGE_KEY], JSON.stringify(stored));
  assert.equal(h.gui().stored['__accepted.sample.coverage-mode'], undefined);
});

test('a rejected chain snapshot is reported and announces no import', () => {
  const stored = chainSnapshot(0);
  const h = makeHarness({
    params: chainSnapshotParams(),
    chainSnapshotEnabled: true,
    chainSnapshot: { ...stored },
    acceptedStored: { [CHAIN_SNAPSHOT_STORAGE_KEY]: JSON.stringify(stored) },
    restoreChainSnapshotAccepted: false,
  });

  h.panel.build();

  assert.deepEqual(h.restoredChainSnapshots, [stored], 'the stored snapshot is offered to the engine exactly once');
  assert.deepEqual(h.warnings,
    ['Shader Workbench: chain snapshot was rejected: INVALID_VALUE']);
  assert.deepEqual(h.configNotices, ['The chain snapshot was rejected. Its original text remains preserved.']);
});

test('a rebuild over live restored state keeps it and re-persists it over the stored snapshot', () => {
  const stored = chainSnapshot(1);
  const live = chainSnapshot(0);
  const h = makeHarness({
    params: chainSnapshotParams(),
    chainSnapshotEnabled: true,
    chainSnapshot: live,
    acceptedStored: { [CHAIN_SNAPSHOT_STORAGE_KEY]: JSON.stringify(stored) },
  });

  h.panel.build({ restoreStored: false });

  assert.deepEqual(h.restoredChainSnapshots, []);
  assert.equal(h.gui().stored[CHAIN_SNAPSHOT_STORAGE_KEY], JSON.stringify(live));
});

test('a stored snapshot that is not a config object never reaches the engine', () => {
  // JS rejects non-object URL values; the engine restore validates object members.
  for (const text of ['{not json', 'null', '[]', '"snapshot"', '7']) {
    const h = makeHarness({
      params: chainSnapshotParams(),
      chainSnapshotEnabled: true,
      chainSnapshot: null,
      acceptedStored: { [CHAIN_SNAPSHOT_STORAGE_KEY]: text },
    });

    h.panel.build();

    assert.deepEqual(h.restoredChainSnapshots, [], `restored from ${text}`);
    assert.equal(h.warnings.length, 1, `warnings for ${text}`);
    assert.match(h.warnings[0], /invalid chain snapshot/);
  }
});

test('an applied chain restore clears the import notice', () => {
  const stored = chainSnapshot();
  const h = makeHarness({ params: chainParams(), chainSnapshotEnabled: true,
    chainSnapshot: stored, acceptedStored: { [CHAIN_SNAPSHOT_STORAGE_KEY]: JSON.stringify(stored) } });
  h.panel.build();
  assert.deepEqual(h.restoredChainSnapshots, [stored]);
  assert.deepEqual(h.configNotices, [null]);
});

test('Coverage weight to none persists the exhaustive snapshot bit-exactly', () => {
  const initial = chainSnapshot(1);
  const updated = chainSnapshot(0);
  const params = chainSnapshotParams();
  Object.assign(params.find((parameter) => parameter.name === 'sample.coverage-mode'), {
    value: 1, requestedValue: 1, options: ['none', 'weight'],
  });
  const h = makeHarness({
    params,
    chainSnapshotEnabled: true,
    chainSnapshot: initial,
    onEngineParam: (name, value, state) => {
      if (name === 'sample.coverage-mode' && value === 0) state.chainSnapshot = updated;
    },
  });
  h.panel.build();
  h.gui().storedWrites.length = 0;
  h.writes.length = 0;

  h.gui().ctrl('sample.coverage-mode').setValue(0);

  assert.deepEqual(h.writes, ['engine:sample.coverage-mode=0', 'worker:sample.coverage-mode=0']);
  assert.deepEqual(h.gui().storedWrites, [
    [CHAIN_SNAPSHOT_STORAGE_KEY, JSON.stringify(updated)],
  ]);
  assert.deepEqual(JSON.parse(h.gui().stored[CHAIN_SNAPSHOT_STORAGE_KEY]), updated);
});

test('build warns when an engine param claims the pause toggle deep-link key', () => {
  const h = makeHarness({
    params: [
      { name: 'reset', value: 0, min: 0, max: 1 },
      { name: 'export', value: 0, min: 0, max: 1 },
      { name: 'pause', value: false, animated: true },
    ],
  });

  h.panel.build();

  // The action buttons are functions and the preset selector is a session
  // control, so only the pause toggle shares a deep-link key with a parameter.
  assert.equal(h.warnings.length, 1, 'one warning naming every collision');
  assert.match(h.warnings[0], /conflict with effect controls: pause$/);
});

test('a param named after an action button keeps the button its focus slot', () => {
  const h = makeHarness({
    params: [{ name: 'reset', value: 0, min: 0, max: 1 }],
    rebuildOnApply: true,
  });
  h.panel.build();
  h.panel.mount();
  const stale = h.gui();
  h.state.focused = stale.ctrl('reset').$button;

  stale.ctrl('reset').object.reset();

  assert.equal(h.gui().ctrl('reset').$button.focusCalls, 1,
    'the same-named parameter took the focus slot of the Reset button');
});

test('a readonly param reads out as read-only and stays out of the writable set',
  () => {
    const h = makeHarness({ params: [SPEED, TELEMETRY] });
    h.panel.build();

    assert.deepEqual(h.panel.active().writableParamNames, ['Speed']);
    const telemetry = h.gui().ctrl('Frames');
    assert.equal(telemetry.$input.getAttribute('aria-readonly'), 'true');
    assert.equal(telemetry.$input.getAttribute('readonly'), 'readonly');
    assert.equal(telemetry.$input.getAttribute('disabled'), null,
      'a disabled control leaves the tab order and the accessibility tree');
    assert.equal(telemetry.disabled, false);
    assert.equal(telemetry.domElement.classList.contains('param-readonly'), true);
    assert.equal(h.gui().ctrl('Speed').$input.getAttribute('aria-readonly'), null);
  });

test('an arrow key never edits an engine-written telemetry control', () => {
  const h = makeHarness({ params: [SPEED, TELEMETRY] });
  h.panel.build();
  const telemetry = h.gui().ctrl('Frames');
  let reached = false;
  telemetry.$input.addEventListener('keydown', () => { reached = true; });

  const event = telemetry.$input.dispatch('keydown', { key: 'ArrowUp' });

  assert.equal(reached, false, 'the widget never sees the key');
  assert.equal(event.defaultPrevented, true);
});

/** The engine rejects a write to a readonly param: no URL seeding and no
 * onChange handler to replay a URL value into setParameter. */
test('a readonly param is a session control with no engine write-back', () => {
  const h = makeHarness({ params: [SPEED, TELEMETRY] });
  h.panel.build();

  assert.equal(h.gui().ctrl('Frames').session, true);
  assert.equal(h.gui().ctrl('Frames').handler, null);
  assert.equal(h.gui().ctrl('Speed').session, undefined);
  assert.equal(typeof h.gui().ctrl('Speed').handler, 'function');
});

test('readonly enum type-ahead cannot move the visible selection', () => {
  const h = makeHarness({ params: [{ name: 'Mode', value: 0,
    options: ['Off', 'On', 'Auto'], readonly: true }] });
  h.panel.build();
  const control = h.gui().ctrl('Mode');
  for (const key of ['a', 'O', '1', ' ']) {
    assert.equal(control.$select.dispatch('keydown', { key }).defaultPrevented, true);
  }
  assert.equal(control.$select.dispatch('keydown', { key: 'Tab' }).defaultPrevented, false);
  assert.equal(control.$select.dispatch('click').defaultPrevented, true);
});

test('readonly enum changes restore the display before target handlers run', () => {
  const h = makeHarness({ params: [{ name: 'Mode', value: 0,
    options: ['Off', 'On'], readonly: true }] });
  h.panel.build();
  const control = h.gui().ctrl('Mode');
  let bubbled = false;
  control.$select.addEventListener('change', () => { bubbled = true; });
  const updates = control.displayUpdates;
  control.$select.dispatch('change');
  assert.equal(bubbled, false);
  assert.equal(control.displayUpdates, updates + 1);
});

test('every parameter participates in rendered-value synchronization', () => {
  const h = makeHarness({ params: [SPEED, TELEMETRY], engineValues: [0.9, 42] });
  h.panel.build();

  // sync() binds over paramNames, so a readonly param stays in the stream it is
  // kept out of the writable set for: the engine writes the value it displays.
  assert.deepEqual(h.panel.active().paramNames, ['Speed', 'Frames']);
  assert.equal(h.panel.active().hasParams, true);

  h.panel.sync();

  assert.equal(h.gui().ctrl('Frames').getValue(), 42,
    'the readonly telemetry readout adopts the engine value');
  assert.equal(h.gui().ctrl('Frames').displayUpdates, 1);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.9);

  const bare = makeHarness({ params: [] });
  bare.panel.build();
  assert.equal(bare.panel.active().hasParams, false,
    'an effect with no parameters skips the value pump');
});

test('editing a control writes the engine and the worker pool as floats', () => {
  const h = makeHarness({ params: [SPEED, GLOW] });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('Speed').setValue(0.75);
  h.gui().ctrl('Glow').setValue(true);

  assert.deepEqual(h.writes, [
    'engine:Speed=0.75', 'worker:Speed=0.75',
    'paused:true',
    'engine:Glow=1', 'worker:Glow=1',
  ]);
});

test('the pause toggle is offered without requiring animated params or a preset bank', () => {
  const animated = makeHarness({ params: [SPEED] });
  animated.panel.build();
  assert.equal(animated.gui().ctrl('pause').label, 'Pause Presets');
  assert.equal(animated.panel.active().pause.controller, animated.gui().ctrl('pause'));

  const staticNoPresets = makeHarness();
  staticNoPresets.panel.build();
  assert.equal(staticNoPresets.gui().ctrl('pause').label, 'Pause Presets');
  staticNoPresets.panel.applyAnimationPause();
  staticNoPresets.writes.length = 0;
  staticNoPresets.gui().ctrl('pause').setValue(true);
  staticNoPresets.gui().ctrl('pause').setValue(false);
  assert.deepEqual(staticNoPresets.writes, ['paused:true', 'paused:false']);

  const singlePreset = makeHarness({ presetCount: 1 });
  singlePreset.panel.build();
  assert.equal(singlePreset.gui().ctrl('pause').label, 'Pause Presets');

  const staticPresets = makeHarness({ presetCount: 2 });
  staticPresets.panel.build();
  staticPresets.panel.applyAnimationPause();
  staticPresets.writes.length = 0;

  const pause = staticPresets.gui().ctrl('pause');
  assert.equal(pause.label, 'Pause Presets');
  staticPresets.gui().ctrl('presetIndex').setValue(1);
  assert.equal(pause.getValue(), true);
  pause.setValue(false);
  assert.equal(staticPresets.engine.paused, false);
  assert.deepEqual(staticPresets.writes, ['preset:1', 'paused:false']);
});

test('touching an animated slider takes over from the animation once', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;
  const pause = h.gui().ctrl('pause');

  h.gui().ctrl('Speed').setValue(0.5);
  assert.equal(h.panel.active().pause.animationState.pause, true);
  assert.equal(pause.displayUpdates, 1);

  h.gui().ctrl('Speed').setValue(0.6);
  assert.equal(pause.displayUpdates, 1, 'an already-paused effect is not re-paused');
  assert.deepEqual(h.writes.filter((w) => w.startsWith('paused')), ['paused:true']);
  assert.deepEqual(pause.valueSets, [true]);
});

// The engine, not the panel, decides which write pauses animations; the toggle
// reports that decision rather than predicting it.

test('a write the engine did not pause by leaves the toggle running', () => {
  const h = makeHarness({ params: [SPEED], pausesOnWrite: () => false });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('Speed').setValue(0.5);

  assert.equal(h.engine.paused, false);
  assert.equal(h.panel.active().pause.animationState.pause, false);
  assert.deepEqual(h.writes.filter((w) => w.startsWith('paused')), []);
  assert.deepEqual(h.gui().ctrl('pause').valueSets, []);
});

test('a write the engine paused by flips the toggle even on a static param', () => {
  const STATIC = { name: 'Width', value: 1, min: 0, max: 2 };
  const h = makeHarness({
    params: [SPEED, STATIC],
    pausesOnWrite: (p) => p.name === 'Width',
  });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('Width').setValue(1.5);

  assert.equal(h.panel.active().pause.animationState.pause, true,
    'the toggle must report the engine state, not the definition\'s animated flag');
  assert.deepEqual(h.writes, [
    'engine:Width=1.5', 'worker:Width=1.5', 'paused:true',
  ], 'the adopted pause must reach the worker pool too');
});

test('the toggle resumes when the engine reports animations running again', () => {
  const h = makeHarness({ params: [SPEED], pausesOnWrite: () => false });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.gui().ctrl('pause').setValue(true);
  assert.equal(h.engine.paused, true);
  h.writes.length = 0;

  // An engine-side resume the panel never asked for.
  h.engine.paused = false;
  h.gui().ctrl('Speed').setValue(0.6);

  assert.equal(h.panel.active().pause.animationState.pause, false);
  assert.deepEqual(h.writes.filter((w) => w.startsWith('paused')), ['paused:false']);
});

test('without the pause accessor the panel falls back to the animated flag', () => {
  const width = { name: 'Width', value: 1, min: 0, max: 2 };
  const h = makeHarness({ params: [SPEED, width], pauseAccessor: false });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('Width').setValue(1.5);
  assert.equal(h.panel.active().pause.animationState.pause, false);
  assert.deepEqual(h.writes.filter((w) => w.startsWith('paused')), []);

  h.gui().ctrl('Speed').setValue(0.5);

  assert.equal(h.panel.active().pause.animationState.pause, true);
  assert.deepEqual(h.writes.filter((w) => w.startsWith('paused')), ['paused:true']);
});

test('ordinary parameter tuning keeps preset advancement running', () => {
  const STATIC = { name: 'Width', value: 1, min: 0, max: 2 };
  const h = makeHarness({ params: [STATIC], pausesOnWrite: () => false });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('Width').setValue(1.5);

  assert.equal(h.panel.active().pause.controller.getValue(), false);
  assert.deepEqual(h.writes, ['engine:Width=1.5', 'worker:Width=1.5']);
});

test('a hydrated pause is committed after the effect renderers rebuild', () => {
  const h = makeHarness({ params: [SPEED], hydrated: { pause: true } });
  h.panel.build();

  assert.equal(h.panel.active().pause.animationState.pause, true);
  assert.deepEqual(h.writes, []);

  h.panel.applyAnimationPause();

  assert.deepEqual(h.writes, ['paused:true']);
});

test('accepted parameter replay preserves the hydrated animation pause', () => {
  const plain = { name: 'Width', value: 1, min: 0, max: 2 };
  for (const hydrated of [{ Width: 1.5 }, { Width: 1.5, pause: false },
    { Speed: 0.5, pause: false }, { Width: 1.5, pause: true }]) {
    const h = makeHarness({
      params: [SPEED, plain], hydrated,
      acceptedStored: { '__accepted.Speed': 0.4, '__accepted.Width': 1 },
    });
    h.panel.build();
    h.panel.applyAnimationPause();
    assert.equal(h.engine.paused, hydrated.pause === true);
    assert.equal(h.panel.active().pause.animationState.pause, hydrated.pause === true);
    h.panel.destroy();
  }
});

test('a fresh effect explicitly commits the unpaused state', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();

  h.panel.applyAnimationPause();

  assert.deepEqual(h.writes, ['paused:false']);
});

test('the pause toggle freezes and resumes animations on every engine', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('pause').setValue(true);
  h.gui().ctrl('pause').setValue(false);

  assert.deepEqual(h.writes, ['paused:true', 'paused:false']);
});

test('the Reset button re-applies the effect', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();

  h.gui().ctrl('reset').object.reset();

  assert.deepEqual(h.writes, ['applyEffect']);
});

test('Reset hands keyboard focus back to the rebuilt Reset button', () => {
  const h = makeHarness({ params: [SPEED], rebuildOnApply: true, isMobile: true });
  h.panel.build();
  h.panel.mount();
  const stale = h.gui();
  assert.equal(stale.closed, true, 'the first mobile mount keeps its default');
  stale.open();
  stale.$children.scrollTop = 220;
  h.state.focused = stale.ctrl('reset').$button;

  stale.ctrl('reset').object.reset();

  assert.notEqual(h.gui(), stale, 'the panel was rebuilt');
  assert.equal(h.gui().closed, false, 'the rebuilt panel keeps the user state');
  assert.equal(h.gui().ctrl('reset').$button.focusCalls, 1);
  assert.equal(h.gui().$children.scrollTop, 220);
});

test('Reset hands keyboard focus back to the parameter that held it', () => {
  const h = makeHarness({ params: [SPEED, GLOW], rebuildOnApply: true });
  h.panel.build();
  h.panel.mount();
  const stale = h.gui();
  h.state.focused = stale.ctrl('Glow').$input;

  stale.ctrl('reset').object.reset();

  assert.equal(h.gui().ctrl('Glow').$input.focusCalls, 1);
  // The rebuilt rows are not the captured ones, so the browser's own
  // scroll-into-view would move the panel off the offset just restored.
  assert.deepEqual(h.gui().ctrl('Glow').$input.focusOptions, { preventScroll: true });
  assert.equal(h.gui().ctrl('reset').$button.focusCalls, 0);
});

test('Reset moves focus nowhere when the panel never held it', () => {
  const h = makeHarness({ params: [SPEED], rebuildOnApply: true });
  h.panel.build();
  h.panel.mount();
  const stale = h.gui();
  h.state.focused = fakeElement('input');

  stale.ctrl('reset').object.reset();

  assert.equal(h.gui().ctrl('reset').$button.focusCalls, 0);
  assert.equal(h.gui().ctrl('Speed').$input.focusCalls, 0);
});

test('a refused animated write leaves the pause toggle unchanged', () => {
  const h = makeHarness({ params: [SPEED], onEngineParam: () => false });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.gui().ctrl('Speed').setValue(0.6);
  assert.equal(h.engine.paused, false);
  assert.equal(h.gui().ctrl('pause').getValue(), false);
});


test('an effect without preset pause capability has no pause control', () => {
  const h = makeHarness({ params: [SPEED], canPausePresets: () => false });
  h.panel.build();
  assert.equal(Boolean(h.panel.active().pause.controller), false);
  assert.equal(h.gui().ctrl('pause'), undefined);
  h.panel.applyAnimationPause();
  h.gui().ctrl('Speed').setValue(0.5);
  h.panel.sync();
  assert.equal(Boolean(h.panel.active().pause.controller), false);
});
