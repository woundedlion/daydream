import { fakePanelGui } from './helpers/fake_app.js';
import { CHAIN_SNAPSHOT_STORAGE_KEY } from '../src/effects/effect_persistence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement, restoreDocumentAfterEach } from './helpers/fake_dom.js';

import {
  createEffectGui,
  addParamControl,
  sliderDecimals,
} from '../src/ui/effect_gui.js';
import {
  LATTICE_MELT_STAGE_ORDER,
  KALEIDOSCOPE_SMOOTH_STAGE_ORDER,
  latticeMeltStageAssignments,
  kaleidoscopeSmoothStageAssignments,
  composedStageAssignments,
} from '../src/effects/shader_stages.js';
import {
  chainSnapshot,
  chainSnapshotParams,
  latticeMeltParams,
  kaleidoscopeSmoothParams,
  makeHarness,
  SPEED,
  GLOW,
  TELEMETRY,
  wiring,
} from './helpers/effect_gui_harness.js';

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

// addParamControl maps one engine parameter definition onto a lil-gui control.

test('a numeric param becomes a slider bounded by the definition', () => {
  const gui = fakePanelGui();
  const state = { Speed: 0.1 };
  const controller = addParamControl(gui, state, SPEED);

  assert.deepEqual(controller.args, [0, 1]);
  assert.equal(controller.decimalsSet, 3);
  assert.equal(controller.isBoolean, false);
});

test('a narrow numeric range displays its nonzero slider steps', () => {
  const gui = fakePanelGui();
  const speed = {
    name: 'Hue Noise Speed', value: 0.000016, min: -0.008, max: 0.008,
    animated: true,
  };
  const state = { 'Hue Noise Speed': speed.value };
  const controller = addParamControl(gui, state, speed);

  assert.equal(controller.decimalsSet, 5);
  assert.equal(controller.getValue(), 0.000016);
});

// lil-gui steps a bounded control by span/1000 with no explicit step, so a
// display coarser than that step prints adjacent steps as the same string and
// its arrow-key increment() re-parses that string back into the live value.
test('slider decimals resolve one lil-gui step of the range', () => {
  const step = (min, max) => Math.abs(max - min) / 1000;
  for (const [min, max] of [
    [0, 1], [0, 0.15], [0.5, 1], [0, 0.8], [-0.008, 0.008], [0, 10],
    [0, 2 * Math.PI], [-1, 1], [0, 100], [0, 0.01],
  ]) {
    const decimals = sliderDecimals(min, max);
    assert.ok(Math.pow(10, -decimals) <= step(min, max) * (1 + 1e-9),
      `[${min}, ${max}] must print finer than its ${step(min, max)} step`);
    assert.notEqual(min.toFixed(decimals), (min + step(min, max)).toFixed(decimals),
      `[${min}, ${max}] must print adjacent steps differently`);
  }
});

test('slider decimals fall back on a degenerate range', () => {
  assert.equal(sliderDecimals(1, 1), 3);
  assert.equal(sliderDecimals(0, Infinity), 3);
  assert.equal(sliderDecimals(0, NaN), 3);
});

test('an integer param becomes a slider stepped to whole values', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Burst: 4 },
    { name: 'Burst', value: 4, min: 1, max: 32, step: 1 });

  assert.deepEqual(controller.args, [1, 32, 1]);
  assert.equal(controller.decimalsSet, 0);
  assert.equal(controller.isBoolean, false);
});

test('a boolean param becomes a toggle with no range arguments', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Glow: false }, GLOW);

  assert.deepEqual(controller.args, []);
  assert.equal(controller.isBoolean, true);
});

test('an enumerated param becomes a dropdown of labels to engine indices', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Mode: 0 },
    { name: 'Mode', value: 0, options: ['Off', 'On', 'Auto'] });

  // The choices table carries a null prototype, so it is spread to compare.
  assert.equal(controller.args.length, 1);
  assert.deepEqual({ ...controller.args[0] }, { Off: 0, On: 1, Auto: 2 });
  assert.equal(controller.isBoolean, false);
  assert.equal(controller.isContinuous, false);
});

test('stage controls sharing a visible label keep distinct accessible names', () => {
  const params = latticeMeltParams();
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
  const params = latticeMeltParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
    generation: 7,
  });
  h.panel.build();
  h.panel.mount();
  const folder = (name) => h.gui().folders.find((f) => f.name === name);
  folder('Curl').close();
  folder('Generated Triadic').close();

  h.state.generation = 8;
  h.panel.sync();

  assert.equal(h.guis.length, 2, 'the panel was rebuilt');
  assert.deepEqual(h.gui().folders.map((f) => f.name), ['Camera', 'Curl', 'Spin + Wander', 'Folded Sinusoidal', 'Primitive Lattice', 'Generated Triadic']);
  assert.equal(folder('Curl').closed, true);
  assert.equal(folder('Generated Triadic').closed, true);
  assert.equal(folder('Primitive Lattice').closed, false, 'the rest stay open');
});

test('LatticeMelt controls use the fixed pipeline modes as folders', () => {
  const params = latticeMeltParams();
  const assignments = latticeMeltStageAssignments(params);
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });

  h.panel.build();

  assert.deepEqual([...new Set(assignments.values())].sort(),
    [...LATTICE_MELT_STAGE_ORDER].sort());
  assert.deepEqual(h.gui().folders.map((folder) => folder.name),
    ['Camera', 'Curl', 'Spin + Wander', 'Folded Sinusoidal',
      'Primitive Lattice', 'Generated Triadic']);
  assert.equal(h.gui().ctrl('Camera Wander').folder, 'Camera');
  assert.equal(h.gui().ctrl('Camera Wander').label, 'Wander');
  assert.equal(h.gui().ctrl('Surface Noise Strength').folder, 'Curl');
  assert.equal(h.gui().ctrl('Surface Noise Strength').label, 'Strength');
  assert.equal(h.gui().ctrl('Projection Spin Speed').folder, 'Spin + Wander');
  assert.equal(h.gui().ctrl('Projection Spin Speed').label, 'Spin Speed');
  assert.equal(h.gui().ctrl('Central Meridian').folder, 'Folded Sinusoidal');
  assert.equal(h.gui().ctrl('Lattice Cell Scale').folder, 'Primitive Lattice');
  assert.equal(h.gui().ctrl('Lattice Cell Scale').label, 'Cell Scale');
  assert.equal(h.gui().ctrl('Hue Noise Speed').folder, 'Generated Triadic');
  assert.deepEqual(h.warnings, [], 'every parameter reached a stage');
});

test('a staged schema builds an unclaimed parameter at the top level', () => {
  const params = [...latticeMeltParams(),
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
  const assignments = kaleidoscopeSmoothStageAssignments(params);
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
  ].map((name) => ({ name, value: 0, min: 0, max: 1, animated: true }));
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

test('composed-effect warp ownership follows each explicit slot boundary', () => {
  const names = [
    'Camera Wander', 'Palette Chroma', 'Mapping Frequency',
    'Planar Warp 1 Speed', 'Mirror Rotation',
    'Planar Warp 2 Speed', 'Mirror Cell X',
  ];
  const assignments = composedStageAssignments(
    names.map((name) => ({ name })));

  assert.equal(assignments.get('Planar Warp 1 Speed'), 'Planar Warp 1');
  assert.equal(assignments.get('Mirror Rotation'), 'Planar Warp 1');
  assert.equal(assignments.get('Planar Warp 2 Speed'), 'Planar Warp 2');
  assert.equal(assignments.get('Mirror Cell X'), 'Planar Warp 2');
});

test('an invalid param carries an actionable, on-screen warning note', () => {
  const gui = fakePanelGui();
  const warning = 'Legacy Stereo Noise requires Projection = Stereographic.';
  const controller = addParamControl(gui, { Projection: 3 }, {
    name: 'Projection',
    value: 3,
    options: ['Sinusoidal', 'Stereographic', 'Gnomonic', 'Bonne'],
    warning,
  });

  assert.equal(controller.domElement.classList.contains('param-warning'), true);
  assert.equal(controller.domElement.getAttribute('title'), null,
    'the text is on screen, not behind a pointer-only tooltip');
  // The wrapper is a plain div, so the state and the description belong on the
  // widget that carries the control's role.
  assert.equal(controller.domElement.getAttribute('aria-invalid'), null);
  assert.equal(controller.$select.getAttribute('aria-invalid'), 'true');

  const note = controller.domElement.querySelector('.param-warning-note');
  assert.equal(note.textContent, warning);
  assert.equal(note.classList.contains('visually-hidden'), false);
  assert.equal(controller.$select.getAttribute('aria-describedby'), note.id);
  assert.equal(note.id, 'param-warning-Projection');
});

test('warning ids separate names that differ only in punctuation or case', () => {
  const gui = fakePanelGui();
  const warned = (name) => addParamControl(gui, { [name]: 0 },
    { name, value: 0, min: 0, max: 1, warning: `${name} is out of range.` });

  const notes = ['Hue Shift', 'Hue-Shift', 'hue shift'].map((name) => {
    const controller = warned(name);
    const note = controller.domElement.querySelector('.param-warning-note');
    assert.equal(controller.$input.getAttribute('aria-describedby'), note.id,
      'the description points at the note this control published');
    return note;
  });

  assert.equal(new Set(notes.map((note) => note.id)).size, notes.length);
});

test('a param without a warning carries no invalid state or description', () => {
  const gui = fakePanelGui();
  const controller = addParamControl(gui, { Speed: 0.1 }, SPEED);

  assert.equal(controller.$input.getAttribute('aria-invalid'), null);
  assert.equal(controller.$input.getAttribute('aria-describedby'), null);
  assert.equal(controller.domElement.querySelector('.param-warning-note'), null);
});

test('a boolean carrying option labels stays a toggle', () => {
  const gui = fakePanelGui();
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

test('the pause toggle is offered for animated params or any preset', () => {
  const animated = makeHarness({ params: [SPEED] });
  animated.panel.build();
  assert.equal(animated.gui().ctrl('pause').label, 'Pause Animation');
  assert.equal(animated.panel.active().pause.controller, animated.gui().ctrl('pause'));

  const staticNoPresets = makeHarness();
  staticNoPresets.panel.build();
  assert.equal(staticNoPresets.gui().ctrl('pause'), undefined);
  assert.equal(staticNoPresets.panel.active().pause.controller, null);

  const singlePreset = makeHarness({ presetCount: 1 });
  singlePreset.panel.build();
  assert.equal(singlePreset.gui().ctrl('pause').label, 'Pause Animation');

  const staticPresets = makeHarness({ presetCount: 2 });
  staticPresets.panel.build();
  staticPresets.panel.applyAnimationPause();
  staticPresets.writes.length = 0;

  const pause = staticPresets.gui().ctrl('pause');
  assert.equal(pause.label, 'Pause Animation');
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

test('an effect with no animated param never touches the pause state', () => {
  const STATIC = { name: 'Width', value: 1, min: 0, max: 2 };
  const h = makeHarness({ params: [STATIC], pausesOnWrite: () => true });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('Width').setValue(1.5);

  assert.equal(h.panel.active().pause.controller, null);
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
