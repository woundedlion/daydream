import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';
import {
  createEffectGui,
  addParamControl,
  EXPORT_COPIED,
  FULL_CONFIG_STORAGE_KEY,
  FLASH_MS,
  SHADERBALL_STAGE_ORDER,
  isShaderBallSchema,
  legacyShaderBallParamNames,
  shaderBallStageAssignments,
} from '../effect_gui.js';

// createEffectGui owns the effect panel: which control an engine parameter maps
// to, which value stream feeds the sliders each frame, what an Export may copy,
// and what a destroyed panel must release. Every collaborator is injected, so
// this suite drives the real module over doubles for lil-gui, the engine, the
// worker pool, the clipboard copy operation, and the window.

afterEach(() => { mock.timers.reset(); });

const ENUM = { value: 0, requestedValue: 0, options: ['None'], animated: true };

function shaderBallParams() {
  return [
    { name: 'Function', ...ENUM },
    { name: 'Pattern Freq', value: 1, min: 0, max: 10, animated: true },
    { name: 'Projection', ...ENUM },
    { name: 'Pole Fade', value: 1, min: 0, max: 2, animated: true },
    { name: 'Projection Frame', ...ENUM },
    { name: 'Projection Wander', value: 0, min: 0, max: 1, animated: true },
    { name: 'Camera Wander', value: 1, min: 0, max: 1, animated: true },
    { name: 'Surface Noise', ...ENUM },
    { name: 'Surface Noise Scale', value: 1, min: 0, max: 8, animated: true },
    { name: 'Lens', ...ENUM },
    { name: 'Planar Warp 1', ...ENUM },
    { name: 'Planar Warp 1 Strength', value: 1, min: 0, max: 4, animated: true },
    { name: 'Planar Warp 2', ...ENUM },
    { name: 'Signal Weight', ...ENUM },
    { name: 'Value Transfer', ...ENUM },
    { name: 'Coverage', ...ENUM },
    { name: 'Palette', ...ENUM },
    { name: 'Hue Shift Mode', ...ENUM },
    { name: 'Hue Shift Amount', value: 0, min: 0, max: 1, animated: true },
  ];
}

/**
 * lil-gui controller double: records the add() arguments, the label, the
 * onChange handler, and every display refresh. Like lil-gui, it exposes exactly
 * one focusable widget for the control kind add() implies — $select for a
 * choices object, $button for a function, $input otherwise — so focus lands
 * where the browser would put it.
 * @param {Object} object - The value object the controller is bound to.
 * @param {string} property - The bound property name.
 * @param {Array<any>} args - Extra arguments add() was called with.
 * @returns {Object} The controller double.
 */
function fakeController(object, property, args) {
  const domElement = fakeElement('div');
  const kind = args[0] !== null && typeof args[0] === 'object' ? 'select'
    : typeof object[property] === 'function' ? 'button'
    : 'input';
  const widget = fakeElement(kind);
  domElement.appendChild(widget);
  return {
    object,
    property,
    args,
    domElement,
    [`$${kind}`]: widget,
    label: property,
    decimalsSet: null,
    disabled: false,
    dragging: false,
    displayUpdates: 0,
    valueSets: [],
    replayOnChange: false,
    handler: null,
    name(label) { this.label = label; return this; },
    decimals(n) { this.decimalsSet = n; return this; },
    disable() { this.disabled = true; return this; },
    onChange(fn) {
      this.handler = fn;
      if (this.replayOnChange) fn(this.getValue());
      return this;
    },
    getValue() { return this.object[this.property]; },
    setValue(v) {
      if (this.getValue() === v) return this;
      this.valueSets.push(v);
      this.object[this.property] = v;
      if (this.handler) this.handler(v);
      this.updateDisplay();
      return this;
    },
    updateDisplay() { this.displayUpdates += 1; return this; },
  };
}

/**
 * lil-gui root double.
 * @returns {Object} The GUI double.
 */
function fakeGui(hydrated = {}, stored = {}) {
  const ownerDocument = { createElement: (tag) => fakeElement(tag) };
  const childrenElement = fakeElement('div');
  childrenElement.ownerDocument = ownerDocument;
  childrenElement.classList.add('lil-children');
  const domElement = fakeElement('div');
  domElement.ownerDocument = ownerDocument;
  const gui = {
    domElement,
    $children: childrenElement,
    controllers: [],
    folders: [],
    closed: false,
    destroyed: 0,
    destroyThrows: null,
    stored,
    storedWrites: [],
    storedReads: [],
    readStoredNumber(property, legacyProperties = []) {
      this.storedReads.push(property);
      if (this.stored[property] !== undefined) return this.stored[property];
      const legacy = legacyProperties.find((name) => this.stored[name] !== undefined);
      if (!legacy) return undefined;
      this.stored[property] = this.stored[legacy];
      delete this.stored[legacy];
      return this.stored[property];
    },
    readStoredString(property) {
      return this.stored[property];
    },
    writeStoredValue(property, value) {
      this.stored[property] = value;
      this.storedWrites.push([property, value]);
    },
    close() { this.closed = true; },
    appendElement(element) { this.$children.appendChild(element); },
    destroy() {
      this.destroyed += 1;
      if (this.destroyThrows) throw this.destroyThrows;
      for (const controller of this.controllers) {
        if (controller.domElement.parentNode !== this.$children) {
          throw new Error(`controller ${controller.property} has the wrong parent`);
        }
        this.$children.removeChild(controller.domElement);
      }
    },
    add(object, property, ...args) {
      const replayOnChange = Object.hasOwn(hydrated, property);
      if (replayOnChange) object[property] = hydrated[property];
      const controller = fakeController(object, property, args);
      controller.replayOnChange = replayOnChange;
      this.controllers.push(controller);
      this.$children.appendChild(controller.domElement);
      return controller;
    },
    addMigrated(object, property, legacyNames, ...args) {
      const legacyName = legacyNames.find((name) => Object.hasOwn(hydrated, name));
      if (legacyName && !Object.hasOwn(hydrated, property)) {
        object[property] = hydrated[legacyName];
      }
      const controller = this.add(object, property, ...args);
      controller.legacyNames = legacyNames;
      if (legacyName) controller.replayOnChange = true;
      return controller;
    },
    addUnhydrated(object, property, ...args) {
      const controller = fakeController(object, property, args);
      controller.unhydrated = true;
      this.controllers.push(controller);
      this.$children.appendChild(controller.domElement);
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
  gui.domElement.appendChild(childrenElement);
  gui.addDisplayFolder = (name) => {
    const folder = {
      name,
      add: (object, property, ...args) => {
        const controller = gui.add(object, property, ...args);
        controller.folder = name;
        return controller;
      },
      addMigrated: (object, property, legacyNames, ...args) => {
        const controller = gui.addMigrated(
          object, property, legacyNames, ...args);
        controller.folder = name;
        return controller;
      },
      addUnhydrated: (object, property, ...args) => {
        const controller = gui.addUnhydrated(object, property, ...args);
        controller.folder = name;
        return controller;
      },
      addSession: (object, property, ...args) => {
        const controller = gui.addSession(object, property, ...args);
        controller.folder = name;
        return controller;
      },
    };
    gui.folders.push(folder);
    return folder;
  };
  gui.addFolder = gui.addDisplayFolder;
  return gui;
}

/**
 * Clipboard copy double that resolves, fails, or rejects on demand.
 * @param {boolean|Error} [outcome] - Resolution value or rejection value.
 * @returns {Function} The copy operation, carrying the copied texts.
 */
function fakeCopyText(outcome = true) {
  const copied = [];
  const copyText = (text) => {
    copied.push(text);
    return outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  };
  copyText.copied = copied;
  return copyText;
}

/**
 * Build the module under test over doubles for every collaborator.
 * @param {Object} [options] - Engine/page state the panel reads.
 * @param {(p: Object) => boolean} [options.pausesOnWrite] - The engine's implicit
 *   pause rule, applied by the setEngineParam double: which parameter writes
 *   leave the engine reporting paused animations.
 * @param {boolean} [options.pauseAccessor] - False models a module that does not
 *   export getAnimationsPaused.
 * @param {Function} [options.onEngineParam] - Optional engine-side reaction to
 *   a parameter write, used to model a dynamic descriptor rebind.
 * @returns {Object} The panel plus the doubles and sinks a test asserts on.
 */
function makeHarness({
  params = [],
  engineValues = [],
  segmentValues = null,
  ownsDisplay = false,
  generation = 1,
  copyText = fakeCopyText(),
  isMobile = false,
  container = fakeElement('div'),
  hydrated = {},
  acceptedStored = {},
  pausesOnWrite = (p) => Boolean(p.animated),
  pauseAccessor = true,
  onEngineParam = () => {},
  onSynchronizePreset = () => {},
  presetCount = 0,
  presetIndex = 0,
  presetSelectionAccepted = true,
  presetSyncAccepted = true,
  fullConfig = false,
  fullConfigSnapshot = null,
  restoreFullConfigAccepted = true,
  configImportNotice = '',
} = {}) {
  const state = {
    params,
    focused: null,
    generation,
    engineValues,
    segmentValues,
    ownsDisplay,
    copyText,
    container,
    presetCount,
    presetIndex,
    hostPresetIndex: presetIndex,
    fullConfigSnapshot,
  };
  const writes = [];
  const warnings = [];
  const restoredFullConfigs = [];
  const configNotices = [];
  let configNoticeClears = 0;
  let paramDefinitionReads = 0;
  const guis = [];
  const dragTarget = fakeElement('window');
  // Engine double: owns the animation-pause state the panel now reads back,
  // driven by the same two writes the real engine drives it with.
  const engine = { paused: false };

  const panel = createEffectGui({
    createGui: () => {
      const gui = fakeGui(hydrated, acceptedStored);
      guis.push(gui);
      return gui;
    },
    getParameterDefinitions: () => { paramDefinitionReads += 1; return state.params; },
    paramGeneration: () => state.generation,
    segmentsOwnDisplay: () => state.ownsDisplay,
    segmentParamValues: () => state.segmentValues,
    engineParamValues: () => state.engineValues,
    setEngineParam: (name, value) => {
      writes.push(`engine:${name}=${value}`);
      const p = state.params.find((d) => d.name === name);
      if (p && pausesOnWrite(p)) engine.paused = true;
      onEngineParam(name, value, state);
    },
    setWorkerParam: (name, value) => writes.push(`worker:${name}=${value}`),
    setAnimationsPaused: (paused) => {
      writes.push(`paused:${paused}`);
      engine.paused = paused;
    },
    getPresetCount: () => state.presetCount,
    getPresetIndex: () => state.presetIndex,
    synchronizePreset: (index) => {
      if (state.hostPresetIndex === index) return true;
      if (!presetSyncAccepted) return false;
      writes.push(`syncPreset:${index}`);
      state.hostPresetIndex = index;
      onSynchronizePreset(index, state);
      return true;
    },
    selectPreset: (index) => {
      writes.push(`preset:${index}`);
      if (!presetSelectionAccepted) return false;
      state.presetIndex = index;
      state.hostPresetIndex = index;
      engine.paused = true;
      return true;
    },
    engineAnimationsPaused: () => (pauseAccessor ? engine.paused : undefined),
    applyEffect: () => writes.push('applyEffect'),
    guiContainer: () => state.container,
    isMobile: () => isMobile,
    dragTarget,
    focusedElement: () => state.focused,
    copyText: state.copyText,
    usesFullConfigSnapshot: () => fullConfig,
    getFullConfigSnapshot: () => state.fullConfigSnapshot,
    restoreFullConfigSnapshot: (snapshot) => {
      restoredFullConfigs.push(snapshot);
      return restoreFullConfigAccepted;
    },
    getConfigImportNotice: () => configImportNotice,
    clearConfigImportNotice: () => { configNoticeClears += 1; },
    showConfigImportNotice: (message) => configNotices.push(message),
    logWarn: (...args) => warnings.push(args.join(' ')),
  });

  return { panel, state, writes, warnings, guis, dragTarget, container, engine,
           restoredFullConfigs, configNotices,
           configNoticeClears: () => configNoticeClears,
           paramDefinitionReads: () => paramDefinitionReads,
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

test('a narrow numeric range displays its nonzero slider steps', () => {
  const gui = fakeGui();
  const speed = {
    name: 'Hue Noise Speed', value: 0.000016, min: -0.008, max: 0.008,
    animated: true,
  };
  const state = { 'Hue Noise Speed': speed.value };
  const controller = addParamControl(gui, state, speed);

  assert.equal(controller.decimalsSet, 6);
  assert.equal(controller.getValue(), 0.000016);
  controller.setValue(0);
  assert.equal(controller.getValue(), 0);
});

test('an integer param becomes a slider stepped to whole values', () => {
  const gui = fakeGui();
  const controller = addParamControl(gui, { Burst: 4 },
    { name: 'Burst', value: 4, min: 1, max: 32, step: 1 });

  assert.deepEqual(controller.args, [1, 32, 1]);
  assert.equal(controller.decimalsSet, 0);
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
  assert.equal(controller.isContinuous, false);
});

test('the ShaderBall schema is recognized by its stage selectors alone', () => {
  assert.equal(isShaderBallSchema(shaderBallParams()), true);
  assert.equal(
    isShaderBallSchema(shaderBallParams().filter((p) => p.name !== 'Coverage')),
    false, 'a missing stage selector is not the ShaderBall schema');
  assert.equal(isShaderBallSchema([SPEED, GLOW]), false);
});

test('ShaderBall parameters map to banks in evaluation order', () => {
  const assignments = shaderBallStageAssignments(shaderBallParams());

  // A stage nothing lands in builds an empty folder; a stage nothing lists
  // drops its controls on the floor.
  assert.deepEqual([...new Set(assignments.values())].sort(),
    [...SHADERBALL_STAGE_ORDER].sort(),
    'the stage list and the assignments cover the same banks');
  assert.equal(assignments.get('Projection Wander'), 'Projection Frame');
  assert.equal(assignments.get('Surface Noise Scale'), 'Surface Noise');
  assert.equal(assignments.get('Planar Warp 1 Strength'), 'Planar Warp 1');
  assert.equal(assignments.get('Hue Shift Mode'), 'Colorize');
  assert.equal(assignments.get('Hue Shift Amount'), 'Colorize');
});

test('ShaderBall builds one URL-transparent bank for every pipeline stage', () => {
  const params = shaderBallParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });

  h.panel.build();

  assert.deepEqual(h.gui().folders.map((folder) => folder.name),
    SHADERBALL_STAGE_ORDER);
  assert.equal(h.gui().ctrl('Camera Wander').folder, 'Camera');
  assert.equal(h.gui().ctrl('Camera Wander').label, 'Wander');
  assert.equal(h.gui().ctrl('Planar Warp 1').folder, 'Planar Warp 1');
  assert.equal(h.gui().ctrl('Planar Warp 1').label, 'Mode');
  assert.equal(h.gui().ctrl('Planar Warp 1 Strength').label, 'Strength');
  assert.equal(h.gui().ctrl('Function').folder, 'Function');
  assert.equal(h.gui().ctrl('Surface Noise').folder, 'Surface Noise');
  assert.equal(h.gui().ctrl('Surface Noise').label, 'Mode');
  assert.equal(h.gui().ctrl('Palette').folder, 'Colorize');
  assert.equal(h.gui().ctrl('Palette').label, 'Palette');
  assert.equal(h.gui().ctrl('Hue Shift Mode').folder, 'Colorize');
});

test('renamed ShaderBall controls accept every legacy deep-link name', () => {
  assert.deepEqual(legacyShaderBallParamNames('Camera Wander'), ['Outer Wander']);
  assert.deepEqual(legacyShaderBallParamNames('Planar Warp 1'), ['Outer Warp']);
  assert.deepEqual(legacyShaderBallParamNames('Planar Warp 1 Strength'),
    ['Outer Warp Strength']);
  assert.deepEqual(legacyShaderBallParamNames('Planar Warp 1 Vector Angle'),
    ['Outer Vector Angle']);
  assert.deepEqual(legacyShaderBallParamNames('Planar Warp 2 Noise Basis'),
    ['Inner Noise Basis']);
  assert.deepEqual(legacyShaderBallParamNames('Palette'), ['Colorizer']);
  assert.deepEqual(legacyShaderBallParamNames('Hue Shift Amount'),
    ['Hue Noise Amount', 'Hue Shift']);
});

test('an invalid param carries an actionable warning indicator and tooltip', () => {
  const gui = fakeGui();
  const warning = 'Legacy Stereo Noise requires Projection = Stereographic.';
  const controller = addParamControl(gui, { Projection: 3 }, {
    name: 'Projection',
    value: 3,
    options: ['Sinusoidal', 'Stereographic', 'Gnomonic', 'Bonne'],
    warning,
  });

  assert.equal(controller.domElement.classList.contains('param-warning'), true);
  assert.equal(controller.domElement.getAttribute('title'), warning);
  assert.equal(controller.domElement.getAttribute('aria-invalid'), 'true');
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
  assert.equal(fx.hasParams, true);
});

test('build restores the last accepted value before replaying an invalid request', () => {
  const outer = {
    name: 'Planar Warp 1', value: 1, requestedValue: 1, acceptedValue: 1,
    options: ['None', 'Stereo Noise', 'Vector Noise', 'Curl Flow'],
  };
  const h = makeHarness({
    params: [outer],
    hydrated: { 'Outer Warp': 3 },
    acceptedStored: { '__accepted.Outer Warp': 0 },
    onEngineParam: (_name, value) => {
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
  assert.equal(h.gui().stored['__accepted.Outer Warp'], undefined);
});

// The engine reports a bool param's values as JS booleans, but the companion
// deep-link key is read back through the URL number grammar, so it must hold
// the float form both writers already agree on.
test('a bool parameter stores its accepted value as a float', () => {
  const glow = {
    name: 'Glow', value: false, requestedValue: false, acceptedValue: false,
  };
  const h = makeHarness({
    params: [glow],
    onEngineParam: (_name, value) => {
      glow.value = value > 0.5;
      glow.requestedValue = glow.value;
      glow.acceptedValue = glow.value;
    },
  });

  h.panel.build();
  h.gui().ctrl('Glow').setValue(true);

  assert.equal(h.gui().stored['__accepted.Glow'], 1);
  const nonNumeric = h.gui().storedWrites.filter(([, v]) => typeof v !== 'number');
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

test('ShaderBall restores one versioned snapshot before building session controls', () => {
  const stored = {
    accepted: [0, 4294967295],
    requested: [0, 4294967295],
    pendingFieldIds: [],
    hasRuntime: false,
    runtime: [],
  };
  const current = {
    schemaVersion: 2,
    accepted: [0, 4294967295],
    requested: [0, 4294967295],
    pendingFieldIds: [],
    hasRuntime: false,
    runtime: [],
  };
  const h = makeHarness({
    params: shaderBallParams(),
    fullConfig: true,
    fullConfigSnapshot: current,
    acceptedStored: { [FULL_CONFIG_STORAGE_KEY]: JSON.stringify(stored) },
    configImportNotice: 'Imported legacy ShaderBall config.',
  });

  h.panel.build();

  assert.deepEqual(h.restoredFullConfigs, [{ ...stored, schemaVersion: 1 }]);
  assert.deepEqual(h.configNotices, ['Imported legacy ShaderBall config.']);
  assert.equal(h.configNoticeClears(), 1);
  assert.equal(h.gui().ctrl('Lens').session, true);
  assert.equal(h.gui().stored[FULL_CONFIG_STORAGE_KEY], JSON.stringify(current));
  assert.equal(h.gui().stored['__accepted.Lens'], undefined);
});

test('Lens Glitch to None persists the exhaustive snapshot bit-exactly', () => {
  const initial = {
    schemaVersion: 2,
    accepted: [1, 2147483648],
    requested: [1, 2147483648],
    pendingFieldIds: [],
    hasRuntime: false,
    runtime: [],
  };
  const updated = {
    schemaVersion: 2,
    accepted: [0, 4294967295],
    requested: [0, 4294967295],
    pendingFieldIds: [17],
    hasRuntime: true,
    runtime: [1],
  };
  const params = shaderBallParams();
  Object.assign(params.find((parameter) => parameter.name === 'Lens'), {
    value: 1, requestedValue: 1, options: ['None', 'Glitch'],
  });
  const h = makeHarness({
    params,
    fullConfig: true,
    fullConfigSnapshot: initial,
    onEngineParam: (name, value, state) => {
      if (name === 'Lens' && value === 0) state.fullConfigSnapshot = updated;
    },
  });
  h.panel.build();
  h.gui().storedWrites.length = 0;
  h.writes.length = 0;

  h.gui().ctrl('Lens').setValue(0);

  assert.deepEqual(h.writes, ['engine:Lens=0', 'worker:Lens=0']);
  assert.deepEqual(h.gui().storedWrites, [
    [FULL_CONFIG_STORAGE_KEY, JSON.stringify(updated)],
  ]);
  assert.deepEqual(JSON.parse(h.gui().stored[FULL_CONFIG_STORAGE_KEY]), updated);
});

test('build warns when engine params collide with effect controls', () => {
  const h = makeHarness({
    params: [
      { name: 'reset', value: 0, min: 0, max: 1 },
      { name: 'export', value: 0, min: 0, max: 1 },
      { name: 'pause', value: false, animated: true },
    ],
  });

  h.panel.build();

  assert.deepEqual(h.warnings, [
    'Engine parameter names conflict with effect controls: reset, export, pause',
  ]);
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

test('every parameter participates in rendered-value synchronization', () => {
  const h = makeHarness({ params: [SPEED, TELEMETRY] });
  h.panel.build();

  // sync() binds over paramNames, so a readonly param stays in the stream it is
  // kept out of the writable set for: the engine writes the value it displays.
  assert.deepEqual(h.panel.active().paramNames, ['Speed', 'Frames']);
  assert.equal(h.panel.active().hasParams, true);

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
  h.panel.applyAnimationPause();
  h.writes.length = 0;
  const pause = h.gui().ctrl('pause');

  h.gui().ctrl('Speed').setValue(0.5);
  assert.equal(h.panel.active().animationState.pause, true);
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
  assert.equal(h.panel.active().animationState.pause, false);
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

  assert.equal(h.panel.active().animationState.pause, true,
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

  assert.equal(h.panel.active().animationState.pause, false);
  assert.deepEqual(h.writes.filter((w) => w.startsWith('paused')), ['paused:false']);
});

test('without the pause accessor the panel falls back to the animated flag', () => {
  const h = makeHarness({ params: [SPEED], pauseAccessor: false });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('Speed').setValue(0.5);

  assert.equal(h.panel.active().animationState.pause, true);
  assert.deepEqual(h.writes.filter((w) => w.startsWith('paused')), ['paused:true']);
});

test('an effect with no animated param never touches the pause state', () => {
  const STATIC = { name: 'Width', value: 1, min: 0, max: 2 };
  const h = makeHarness({ params: [STATIC], pausesOnWrite: () => true });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('Width').setValue(1.5);

  assert.equal(h.panel.active().pauseController, null);
  assert.deepEqual(h.writes, ['engine:Width=1.5', 'worker:Width=1.5']);
});

test('a hydrated pause is committed after the effect renderers rebuild', () => {
  const h = makeHarness({ params: [SPEED], hydrated: { pause: true } });
  h.panel.build();

  assert.equal(h.panel.active().animationState.pause, true);
  assert.deepEqual(h.writes, []);

  h.panel.applyAnimationPause();

  assert.deepEqual(h.writes, ['paused:true']);
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

test('a Lens dropdown keeps requested state ahead of the renderer', () => {
  const lens = {
    name: 'Lens', value: 3, requestedValue: 0, acceptedValue: 0,
    options: ['None', 'Glitch', 'Twist', 'Kaleidoscope', 'Mobius', 'Tangent Noise'],
    animated: true,
  };
  const h = makeHarness({ params: [lens], segmentValues: [3], ownsDisplay: true });
  h.panel.build();
  const controller = h.gui().ctrl('Lens');

  controller.domElement.dispatch('pointerdown');
  assert.equal(controller.dragging, false, 'a dropdown never claims continuous-drag ownership');
  assert.deepEqual(h.dragTarget.listeners, []);

  h.panel.sync();

  assert.equal(controller.getValue(), 0);
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

test('a schema rebuild hands keyboard focus back to the same control', () => {
  const projection = {
    name: 'Projection', value: 0, options: ['Stereographic', 'Bonne'], animated: true,
  };
  const bonne = { name: 'Bonne Parallel', value: 0.4, min: 0.01, max: 1.5, animated: true };
  const h = makeHarness({ params: [projection], engineValues: [0], generation: 7 });
  h.panel.build();
  h.panel.mount();
  h.state.focused = h.gui().ctrl('Projection').$select;

  h.state.params = [{ ...projection, value: 1 }, bonne];
  h.state.engineValues = [1, 0.6];
  h.state.generation = 8;
  h.panel.sync();

  assert.equal(h.gui().ctrl('Projection').$select.focusCalls, 1);
  assert.equal(h.gui().ctrl('Bonne Parallel').$input.focusCalls, 0);
});

test('a schema rebuild moves focus nowhere when the panel never held it', () => {
  const projection = {
    name: 'Projection', value: 0, options: ['Stereographic', 'Bonne'], animated: true,
  };
  const h = makeHarness({ params: [projection], engineValues: [0], generation: 7 });
  h.panel.build();
  h.panel.mount();
  h.state.focused = fakeElement('input');

  h.state.params = [{ ...projection, value: 1 }];
  h.state.engineValues = [1];
  h.state.generation = 8;
  h.panel.sync();

  assert.equal(h.gui().ctrl('Projection').$select.focusCalls, 0);
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
    onSynchronizePreset(_index, state) {
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
  assert.equal(h.gui().ctrl('Function').getValue(), 6);
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
  assert.deepEqual(h.warnings,
    ['Effect GUI: param/value length skew (2 vs 1); skipping sync']);

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

// The Export action copies the live values, and reports the outcome on its own
// button.

test('preset effects expose zero-indexed selection and navigation', () => {
  const h = makeHarness({ presetCount: 3, presetIndex: 0 });
  h.panel.build();

  assert.deepEqual(h.gui().controllers.slice(0, 5).map((c) => c.property),
    ['reset', 'export', 'presetIndex', 'previousPreset', 'nextPreset']);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 0);
  assert.deepEqual(h.gui().ctrl('presetIndex').args, [{ 0: 0, 1: 1, 2: 2 }]);
  assert.equal(h.gui().ctrl('presetIndex').disabled, false);
  assert.equal(h.gui().ctrl('presetIndex').session, true);
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
  const actionRow = h.gui().$children.children[0];
  assert.ok(actionRow.classList.contains('effect-action-row'));
  // display/grid-auto-flow belong to the stylesheet; only the count is dynamic.
  assert.equal(actionRow.style.display, undefined);
  assert.equal(actionRow.style.gridAutoFlow, undefined);
  assert.equal(actionRow.style.gridTemplateColumns,
    'repeat(4, minmax(0, 1fr))');
  assert.deepEqual(actionRow.children,
    ['reset', 'export', 'previousPreset', 'nextPreset']
      .map((property) => h.gui().ctrl(property).domElement));
  assert.ok(h.gui().ctrl('previousPreset').domElement.classList
    .contains('preset-nav-previous'));
  assert.ok(h.gui().ctrl('nextPreset').domElement.classList
    .contains('preset-nav-next'));

  h.gui().ctrl('previousPreset').object.previousPreset();
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 2);
  h.gui().ctrl('nextPreset').object.nextPreset();
  assert.deepEqual(h.writes, ['preset:2', 'preset:0']);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 0);
  assert.equal(h.gui().ctrl('pause'), undefined);
});

test('the preset dropdown selects its zero-indexed value', () => {
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
    onSynchronizePreset: (_index, state) => {
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
  assert.equal(h.gui().ctrl('Function').getValue(), 6);
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

test('a rejected preset selection does not change the pause state', () => {
  const h = makeHarness({
    params: [SPEED], presetCount: 3, presetIndex: 1,
    presetSelectionAccepted: false,
  });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

  h.gui().ctrl('presetIndex').setValue(2);

  assert.equal(h.panel.active().animationState.pause, false);
  assert.equal(h.engine.paused, false);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 1);
  assert.deepEqual(h.writes, ['preset:2']);
});

test('effects without presets do not show preset navigation', () => {
  const h = makeHarness();
  h.panel.build();
  assert.equal(h.gui().ctrl('previousPreset'), undefined);
  assert.equal(h.gui().ctrl('nextPreset'), undefined);
  assert.equal(h.gui().ctrl('presetIndex'), undefined);
  assert.equal(h.gui().$children.children[0].style.gridTemplateColumns,
    'repeat(2, minmax(0, 1fr))');
});

test('Export copies the live values as a C++ brace-init list', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.25, 0.5] });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.25f, 0.5f }']);
  assert.equal(h.gui().ctrl('export').label, '\u2713');
  assert.equal(h.gui().ctrl('export').$button.getAttribute('title'), EXPORT_COPIED);
});

test('ShaderBall Export copies the versioned full-config snapshot', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const snapshot = {
    schemaVersion: 2,
    accepted: [0, 4294967295],
    requested: [1, 4294967295],
    pendingFieldIds: [0],
    hasRuntime: false,
    runtime: [],
  };
  const h = makeHarness({
    params: shaderBallParams(), fullConfig: true,
    fullConfigSnapshot: snapshot,
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, [JSON.stringify(snapshot, null, 2)]);
  assert.equal(h.gui().ctrl('export').label, '\u2713');
});

test('Export copies displayed values while a segmented snapshot is pending', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED, GLOW],
    segmentValues: null,
    ownsDisplay: true,
  });
  h.panel.build();
  h.gui().ctrl('Speed').setValue(0.75);
  h.gui().ctrl('Glow').setValue(true);

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.75f, 1.0f }']);
  assert.equal(h.gui().ctrl('export').label, '\u2713');
});

test('Export does not fall back to controls from a stale schema', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED],
    segmentValues: null,
    ownsDisplay: true,
    generation: 4,
  });
  h.panel.build();
  h.state.generation = 5;

  h.gui().ctrl('export').object.export();

  assert.deepEqual(h.state.copyText.copied, []);
  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /no parameter values matching/);
});

test('Export omits engine-written readonly params from the preset', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED, TELEMETRY],
    engineValues: [0.25, 1234],
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.25f }']);
});

test('Export without a copy operation reports the failure', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], copyText: null });
  h.panel.build();

  h.gui().ctrl('export').object.export();

  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.deepEqual(h.warnings, ['Export: clipboard copy unavailable']);
});

test('Export refuses a value stream that has skewed from the panel', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.25] });
  h.panel.build();

  h.gui().ctrl('export').object.export();

  assert.deepEqual(h.state.copyText.copied, []);
  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /param\/value length skew \(2 vs 1\)/);
});

test('a rejected clipboard copy reports the failure', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.25],
    copyText: fakeCopyText(new Error('denied')),
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /clipboard copy failed/);
});

test('a copy operation that exhausts its fallbacks reports the failure', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.25],
    copyText: fakeCopyText(false),
  });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.equal(h.gui().ctrl('export').label, '\u2717');
  assert.match(h.warnings[0], /clipboard copy failed/);
});

test('an Export that lands after an effect switch does not flash the old panel', async () => {
  const h = makeHarness({ params: [SPEED], engineValues: [0.25] });
  h.panel.build();
  const stale = h.gui();

  stale.ctrl('export').object.export();
  h.panel.build();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.25f }']);
  assert.equal(stale.ctrl('export').label, '\u29c9',
    'the replaced panel is left alone');
});

test('the Export flash reverts to the default label', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], copyText: null });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  assert.equal(h.gui().ctrl('export').label, '\u2717');

  mock.timers.tick(FLASH_MS);
  assert.equal(h.gui().ctrl('export').label, '\u29c9');
  assert.equal(h.gui().ctrl('export').$button.getAttribute('title'), 'Export');
});

test('destroy cancels a pending Export flash', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], copyText: null });
  h.panel.build();
  const stale = h.gui();

  stale.ctrl('export').object.export();
  h.panel.destroy();
  mock.timers.tick(FLASH_MS);

  assert.equal(stale.ctrl('export').label, '\u2717',
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

test('a slider drag defers persistence to the pointer release', () => {
  const speed = { name: 'Speed', value: 0.1, min: 0, max: 1, animated: true };
  const h = makeHarness({
    params: [speed],
    onEngineParam: (_name, value) => { speed.value = value; },
  });
  h.panel.build();
  const controller = h.gui().ctrl('Speed');
  h.gui().storedWrites.length = 0;

  controller.domElement.dispatch('pointerdown');
  controller.setValue(0.2);
  controller.setValue(0.3);

  assert.deepEqual(h.gui().storedWrites, [], 'no per-pointermove persistence');

  h.dragTarget.dispatch('pointerup');

  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.3]]);
});

test('a ShaderBall drag writes one full-config snapshot, at the release', () => {
  const snapshot = (hue) => ({
    schemaVersion: 2,
    accepted: [hue],
    requested: [hue],
    pendingFieldIds: [],
    hasRuntime: false,
    runtime: [],
  });
  const h = makeHarness({
    params: shaderBallParams(),
    fullConfig: true,
    fullConfigSnapshot: snapshot(0),
    onEngineParam: (name, value, state) => {
      if (name === 'Hue Shift Amount') state.fullConfigSnapshot = snapshot(value);
    },
  });
  h.panel.build();
  const controller = h.gui().ctrl('Hue Shift Amount');
  h.gui().storedWrites.length = 0;

  controller.domElement.dispatch('pointerdown');
  controller.setValue(0.25);
  controller.setValue(0.5);

  assert.deepEqual(h.gui().storedWrites, [], 'no snapshot per pointermove');

  h.dragTarget.dispatch('pointerup');

  assert.deepEqual(h.gui().storedWrites, [
    [FULL_CONFIG_STORAGE_KEY, JSON.stringify(snapshot(0.5))],
  ], 'the release deep-links the state the last move would have');
});

test('a release that changed no value persists nothing', () => {
  const h = makeHarness({ params: [SPEED] });
  h.panel.build();
  h.gui().storedWrites.length = 0;

  h.gui().ctrl('Speed').domElement.dispatch('pointerdown');
  h.dragTarget.dispatch('pointerup');

  assert.deepEqual(h.gui().storedWrites, []);
});

test('a toggle persists without waiting for a pointer release', () => {
  const glow = { name: 'Glow', value: false, animated: true };
  const h = makeHarness({
    params: [glow],
    onEngineParam: (_name, value) => { glow.value = value > 0.5; },
  });
  h.panel.build();
  h.gui().storedWrites.length = 0;

  h.gui().ctrl('Glow').setValue(true);

  assert.deepEqual(h.gui().storedWrites, [['__accepted.Glow', 1]]);
});

test('a readonly control is never drag-tracked', () => {
  const h = makeHarness({ params: [TELEMETRY] });
  h.panel.build();

  h.gui().ctrl('Frames').domElement.dispatch('pointerdown');

  assert.deepEqual(h.dragTarget.listeners, []);
});

test('toggles and dropdowns are never drag-tracked', () => {
  const mode = { name: 'Mode', value: 0, options: ['Off', 'On'] };
  const h = makeHarness({ params: [GLOW, mode] });
  h.panel.build();

  h.gui().ctrl('Glow').domElement.dispatch('pointerdown');
  h.gui().ctrl('Mode').domElement.dispatch('pointerdown');

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
  assert.deepEqual(h.warnings, []);
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
