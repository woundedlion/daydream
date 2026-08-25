import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeElement } from './fake_dom.js';
import {
  createEffectGui,
  addParamControl,
  sliderDecimals,
  EXPORT_COPIED,
  EXPORT_FAILED,
  FULL_CONFIG_STORAGE_KEY,
  FLASH_MS,
} from '../effect_gui.js';
import {
  LATTICE_MELT_STAGE_ORDER,
  KALEIDOSCOPE_SMOOTH_STAGE_ORDER,
  SHADERBALL_STAGE_ORDER,
  latticeMeltStageAssignments,
  kaleidoscopeSmoothStageAssignments,
  fixedShaderStageAssignments,
  fixedShaderStageTitles,
  isShaderBallSchema,
  legacyShaderBallParamNames,
  shaderBallStageAssignments,
} from '../shader_stages.js';
import { FullConfigRestoreResult } from './fake_engine.js';

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
    { name: 'Singularity Fade', value: 1, min: 0, max: 2, animated: true },
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

function latticeMeltParams() {
  return [
    'Lattice Cell Scale',
    'Lattice Shape',
    'Lattice Softness',
    'Lattice Radius',
    'Singularity Fade',
    'Central Meridian',
    'Projection Spin Speed',
    'Projection Wander',
    'Camera Wander',
    'Surface Noise Scale',
    'Surface Noise Strength',
    'Surface Noise Speed',
    'Palette Chroma',
    'Palette Mapping',
    'Mapping Frequency',
    'Mapping Phase',
    'Phase Oscillation Depth',
    'Phase Oscillation Speed',
    'Brightness Depth',
    'Value Opacity Low',
    'Value Opacity High',
    'Hue Shift Amount',
    'Hue Noise Scale',
    'Hue Noise Speed',
  ].map((name) => ({ name, value: 0.5, min: 0, max: 1, animated: true }));
}

function kaleidoscopeSmoothParams() {
  return [
    'Pattern Freq',
    'Speed',
    'Source Angle Speed',
    'Complexity',
    'Pattern Mix',
    'Drift',
    'Singularity Fade',
    'Projection Spin Speed',
    'Projection Wander',
    'Camera Wander',
    'Planar Warp 2 Speed',
    'Planar Warp 2 Rotation',
    'Planar Warp 2 Cell X',
    'Planar Warp 2 Cell Y',
    'Planar Warp 2 Offset X',
    'Planar Warp 2 Offset Y',
    'Palette Chroma',
    'Palette Mapping',
    'Mapping Frequency',
    'Mapping Phase',
    'Phase Oscillation Depth',
    'Phase Oscillation Speed',
    'Value Opacity Low',
    'Value Opacity High',
    'Hue Shift Amount',
    'Hue Noise Scale',
    'Hue Noise Speed',
  ].map((name) => ({ name, value: 0.5, min: 0, max: 1, animated: true }));
}

function fixedShaderConfig(overrides = {}) {
  const values = new Map([
    ['slots.function', 5],
    ['slots.projection', 2],
    ['slots.projection_frame', 1],
    ['slots.surface_noise', 0],
    ['slots.surface_lens', 0],
    ['slots.warp_program.outer.kind', 1],
    ['slots.warp_program.inner.kind', 0],
    ['slots.signal_weight', 1],
    ['slots.value_transfer', 0],
    ['slots.coverage', 3],
    ['slots.palette', 0],
  ]);
  for (const [name, value] of Object.entries(overrides)) values.set(name, value);
  return {
    fields: [...values.keys()].map((name, id) => ({ name, id })),
    snapshot: { accepted: [...values.values()] },
  };
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
    acceptedUrlValues: [],
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
    acceptUrlValue(value) {
      this.acceptedUrlValues.push(value);
      return this;
    },
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
    _closed: false,
    get closed() { return this._closed; },
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
    open(open = true) { this._closed = !open; },
    close() { this.open(false); },
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
      _closed: false,
      get closed() { return this._closed; },
      open(open = true) { this._closed = !open; },
      close() { this.open(false); },
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
 * The live region the action row announces an Export outcome through.
 * @param {Object} h - A built harness.
 * @returns {Object} The status element.
 */
function exportStatus(h) {
  return h.gui().$children.children[0].querySelector('.visually-hidden');
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
 * @param {boolean} [options.rebuildOnApply] - Makes the injected applyEffect run
 *   the app's real destroy/build/mount sequence instead of only recording the
 *   call, which is what the Reset button drives.
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
  rebuildOnApply = false,
  onSynchronizePreset = () => {},
  presetCount = 0,
  presetIndex = 0,
  presetSelectionAccepted = true,
  presetSyncAccepted = true,
  fullConfig = false,
  fullConfigSnapshot = null,
  fullConfigFieldDefinitions = null,
  restoreFullConfigAccepted = true,
  configImportNotice = '',
} = {}) {
  const state = {
    params,
    focused: null,
    paramFilter: null,
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
    fullConfigFieldDefinitions,
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
      return onEngineParam(name, value, state) !== false;
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
    applyEffect: () => {
      writes.push('applyEffect');
      if (!rebuildOnApply) return;
      panel.destroy();
      panel.build();
      panel.mount();
    },
    guiContainer: () => state.container,
    isMobile: () => isMobile,
    dragTarget,
    focusedElement: () => state.focused,
    paramFilter: () => state.paramFilter,
    copyText: state.copyText,
    usesFullConfigSnapshot: () => fullConfig,
    getFullConfigSnapshot: () => state.fullConfigSnapshot,
    getFullConfigFieldDefinitions: () => state.fullConfigFieldDefinitions,
    restoreFullConfigSnapshot: (snapshot) => {
      restoredFullConfigs.push(snapshot);
      return restoreFullConfigAccepted
        ? FullConfigRestoreResult.APPLIED : FullConfigRestoreResult.INVALID_VALUE;
    },
    fullConfigRestoreResults: () => FullConfigRestoreResult,
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

  assert.equal(controller.decimalsSet, 5);
  assert.equal(controller.getValue(), 0.000016);
  controller.setValue(0);
  assert.equal(controller.getValue(), 0);
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

test('a schema rebuild keeps the stage folders the user collapsed', () => {
  const params = shaderBallParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
    generation: 7,
  });
  h.panel.build();
  h.panel.mount();
  const folder = (name) => h.gui().folders.find((f) => f.name === name);
  folder('Surface Noise').close();
  folder('Colorize').close();

  h.state.generation = 8;
  h.panel.sync();

  assert.deepEqual(h.gui().folders.map((f) => f.name), SHADERBALL_STAGE_ORDER,
    'the panel was rebuilt');
  assert.equal(folder('Surface Noise').closed, true);
  assert.equal(folder('Colorize').closed, true);
  assert.equal(folder('Function').closed, false, 'the rest stay open');
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
  assert.equal(h.gui().ctrl('Planar Warp 2 Cell Y').folder, 'Mirror Tile');
  assert.equal(h.gui().ctrl('Planar Warp 2 Cell Y').label, 'Cell Y');
  assert.equal(h.gui().ctrl('Pattern Mix').folder, 'Grid');
  assert.equal(h.gui().ctrl('Hue Noise Speed').folder, 'Generated Analogous');
});

test('promoted Shader controls use their accepted structural modes as folders', () => {
  const params = [
    'Camera Wander', 'Projection Spin Speed', 'Singularity Fade',
    'Planar Warp 1 Translation X', 'Pattern Freq', 'Edge Fade Width',
    'Palette Chroma', 'Mapping Frequency',
  ].map((name) => ({ name }));
  const assignments = fixedShaderStageAssignments(params);
  const { snapshot, fields } = fixedShaderConfig();
  const titles = fixedShaderStageTitles(snapshot, fields);
  const h = makeHarness({
    params,
    engineValues: params.map(() => 0),
    fullConfigSnapshot: snapshot,
    fullConfigFieldDefinitions: fields,
  });

  h.panel.build();

  assert.equal(assignments.get('Camera Wander'), 'Camera');
  assert.equal(assignments.get('Projection Spin Speed'), 'Projection Frame');
  assert.equal(assignments.get('Singularity Fade'), 'Projection');
  assert.equal(assignments.get('Planar Warp 1 Translation X'), 'Planar Warp 1');
  assert.equal(assignments.get('Pattern Freq'), 'Function');
  assert.equal(assignments.get('Edge Fade Width'), 'Coverage');
  assert.equal(assignments.get('Palette Chroma'), 'Colorize');
  assert.equal(titles.get('Planar Warp 1'), 'Affine Frame');
  assert.deepEqual(h.gui().folders.map((folder) => folder.name),
    ['Camera', 'Spin + Wander', 'Gnomonic', 'Affine Frame',
      'Primitive Lattice', 'Edge Fade', 'Generated Triadic']);
  assert.equal(h.gui().ctrl('Planar Warp 1 Translation X').label,
    'Translation X');
});

test('fixed Shader controls retain stage folders without dynamic metadata', () => {
  const params = [
    'Camera Wander', 'Singularity Fade', 'Planar Warp 1 Speed', 'Warp Strength',
    'Planar Warp 2 Speed', 'Mirror Rotation', 'Pattern Freq',
    'Edge Width', 'Palette Chroma', 'Mapping Frequency',
  ].map((name) => ({ name, value: 0, min: 0, max: 1, animated: true }));
  const h = makeHarness({
    params,
    engineValues: params.map(() => 0),
    fullConfigSnapshot: null,
    fullConfigFieldDefinitions: null,
  });

  h.panel.build();

  assert.deepEqual(h.gui().folders.map((folder) => folder.name),
    ['Camera', 'Projection', 'Planar Warp 1', 'Planar Warp 2', 'Function',
      'Coverage', 'Colorize']);
  assert.equal(h.gui().ctrl('Warp Strength').folder, 'Planar Warp 1');
  assert.equal(h.gui().ctrl('Mirror Rotation').folder, 'Planar Warp 2');
  assert.equal(h.gui().ctrl('Edge Width').folder, 'Coverage');
  assert.deepEqual(h.warnings, [],
    'the Shader stage rules file every name they are given');
});

test('fixed Shader warp ownership follows each explicit slot boundary', () => {
  const names = [
    'Camera Wander', 'Palette Chroma', 'Mapping Frequency',
    'Planar Warp 1 Speed', 'Mirror Rotation',
    'Planar Warp 2 Speed', 'Mirror Cell X',
  ];
  const assignments = fixedShaderStageAssignments(
    names.map((name) => ({ name })));

  assert.equal(assignments.get('Planar Warp 1 Speed'), 'Planar Warp 1');
  assert.equal(assignments.get('Mirror Rotation'), 'Planar Warp 1');
  assert.equal(assignments.get('Planar Warp 2 Speed'), 'Planar Warp 2');
  assert.equal(assignments.get('Mirror Cell X'), 'Planar Warp 2');
});

test('a promoted Shader snapshot outranks a matching dedicated-effect schema', () => {
  const params = [...kaleidoscopeSmoothParams(), {
    name: 'Central Meridian', value: 0.5, min: 0, max: 1, animated: true,
  }];
  const { snapshot, fields } = fixedShaderConfig({
    'slots.function': 3,
    'slots.projection': 6,
    'slots.warp_program.outer.kind': 0,
    'slots.warp_program.inner.kind': 6,
    'slots.coverage': 1,
    'slots.palette': 2,
  });
  const h = makeHarness({
    params,
    engineValues: params.map(() => 0),
    fullConfigSnapshot: snapshot,
    fullConfigFieldDefinitions: fields,
  });

  h.panel.build();

  assert.equal(h.gui().ctrl('Central Meridian').folder, 'Equirectangular');
  assert.equal(h.gui().ctrl('Planar Warp 2 Cell Y').folder, 'Mirror Tile');
  assert.equal(h.gui().ctrl('Pattern Mix').folder, 'Grid');
  assert.equal(h.gui().ctrl('Hue Noise Speed').folder, 'Generated Analogous');
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
  // The wrapper is a plain div, so the state and the description belong on the
  // widget that carries the control's role.
  assert.equal(controller.domElement.getAttribute('aria-invalid'), null);
  assert.equal(controller.$select.getAttribute('aria-invalid'), 'true');

  const note = controller.domElement.querySelector('.visually-hidden');
  assert.equal(note.textContent, warning);
  assert.equal(controller.$select.getAttribute('aria-describedby'), note.id);
  assert.equal(note.id, 'param-warning-Projection');
});

test('warning ids separate names that differ only in punctuation or case', () => {
  const gui = fakeGui();
  const warned = (name) => addParamControl(gui, { [name]: 0 },
    { name, value: 0, min: 0, max: 1, warning: `${name} is out of range.` });

  const notes = ['Hue Shift', 'Hue-Shift', 'hue shift'].map((name) => {
    const controller = warned(name);
    const note = controller.domElement.querySelector('.visually-hidden');
    assert.equal(controller.$input.getAttribute('aria-describedby'), note.id,
      'the description points at the note this control published');
    return note;
  });

  assert.equal(new Set(notes.map((note) => note.id)).size, notes.length);
});

test('a param without a warning carries no invalid state or description', () => {
  const gui = fakeGui();
  const controller = addParamControl(gui, { Speed: 0.1 }, SPEED);

  assert.equal(controller.$input.getAttribute('aria-invalid'), null);
  assert.equal(controller.$input.getAttribute('aria-describedby'), null);
  assert.equal(controller.domElement.querySelector('.visually-hidden'), null);
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

test('a rejected full-config snapshot is reported and announces no import', () => {
  const stored = {
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
    fullConfigSnapshot: { ...stored },
    acceptedStored: { [FULL_CONFIG_STORAGE_KEY]: JSON.stringify(stored) },
    restoreFullConfigAccepted: false,
    configImportNotice: 'Imported legacy ShaderBall config.',
  });

  h.panel.build();

  assert.deepEqual(h.restoredFullConfigs, [stored], 'the snapshot never reached the engine');
  assert.deepEqual(h.warnings,
    ['Shader Workbench: full-config snapshot was rejected: INVALID_VALUE']);
  assert.deepEqual(h.configNotices, [],
    'a refused restore announced an import that did not happen');
  assert.equal(h.configNoticeClears(), 0, 'a refused restore consumed the notice');
});

test('a stored snapshot that is not a config object never reaches the engine', () => {
  // The key is a URL fragment a user can hand-edit, so every shape JSON admits
  // has to stop here rather than at an embind argument conversion.
  for (const text of ['{not json', 'null', '[]', '"snapshot"', '7']) {
    const h = makeHarness({
      params: shaderBallParams(),
      fullConfig: true,
      fullConfigSnapshot: null,
      acceptedStored: { [FULL_CONFIG_STORAGE_KEY]: text },
    });

    h.panel.build();

    assert.deepEqual(h.restoredFullConfigs, [], `restored from ${text}`);
    assert.equal(h.warnings.length, 1, `warnings for ${text}`);
    assert.match(h.warnings[0], /ignoring invalid full-config snapshot/);
  }
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

  assert.equal(h.warnings.length, 1, 'one warning naming every collision');
  assert.match(h.warnings[0], /conflict with effect controls: reset, export, pause$/);
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

test('the pause toggle is offered for animated params or multiple presets', () => {
  const animated = makeHarness({ params: [SPEED] });
  animated.panel.build();
  assert.equal(animated.gui().ctrl('pause').label, 'Pause Animation');
  assert.equal(animated.panel.active().pause.controller, animated.gui().ctrl('pause'));

  const staticNoPresets = makeHarness();
  staticNoPresets.panel.build();
  assert.equal(staticNoPresets.gui().ctrl('pause'), undefined);
  assert.equal(staticNoPresets.panel.active().pause.controller, null);

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
  const h = makeHarness({ params: [SPEED], pauseAccessor: false });
  h.panel.build();
  h.panel.applyAnimationPause();
  h.writes.length = 0;

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

  // A definitions read yielding no list is what a torn-down engine hands back
  // across an async effect change.
  h.state.params = null;
  h.state.generation = 4;
  h.panel.sync();

  assert.equal(h.panel.active().gui, live, 'a record that never built was published');
  assert.equal(h.panel.active().paramGeneration, 3);
  assert.deepEqual(h.container.children, [live.domElement]);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /parameter-schema rebuild failed/);

  h.panel.sync();

  assert.equal(h.warnings.length, 1, 'the same failure logged again on the next frame');

  h.state.generation = 5;
  h.panel.sync();

  assert.equal(h.warnings.length, 2, 'a fresh generation failing went unreported');

  // The definitions come back: the throttle must not have latched the panel out
  // of ever rebuilding.
  h.state.params = [SPEED, GLOW];
  h.state.engineValues = [0.4, true];
  h.state.generation = 6;
  h.panel.sync();

  assert.notEqual(h.panel.active().gui, live);
  assert.equal(h.gui().ctrl('Speed').getValue(), 0.4);
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
    options: ['Stereographic', 'Bonne'], animated: true,
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
      state.params = [value === 1
        ? { ...projection, requestedValue: 1, warning }
        : { ...projection, requestedValue: value }];
    },
  });
  h.panel.build();
  h.panel.mount();
  h.gui().open();
  h.state.focused = h.gui().ctrl('Projection').$select;

  h.gui().ctrl('Projection').setValue(1);
  h.panel.sync();

  const controller = h.gui().ctrl('Projection');
  assert.equal(h.gui().closed, false, 'a warning rebuild keeps the panel open');
  assert.equal(controller.$select.focusCalls, 1);
  assert.equal(h.panel.active().paramGeneration, 7, 'no effect was loaded');
  assert.equal(controller.domElement.classList.contains('param-warning'), true);
  assert.equal(controller.domElement.getAttribute('title'), warning);
  assert.equal(controller.$select.getAttribute('aria-invalid'), 'true');
  const note = controller.domElement.querySelector('.visually-hidden');
  assert.equal(note.textContent, warning);
  assert.equal(controller.$select.getAttribute('aria-describedby'), note.id);
  assert.deepEqual(h.container.children, [h.gui().domElement]);

  controller.setValue(0);
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
  assert.equal(h.gui().ctrl('Speed').domElement.getAttribute('title'), warning);

  // The preset writes a value the engine accepts, withdrawing the warning with
  // no schema generation behind it.
  h.state.params = [SPEED];
  h.state.engineValues = [0.1];
  h.gui().ctrl('presetIndex').setValue(2);
  h.panel.sync();

  const speed = h.gui().ctrl('Speed');
  assert.equal(speed.domElement.classList.contains('param-warning'), false);
  assert.equal(speed.domElement.getAttribute('title'), null);
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
    onEngineParam(_name, value, state) {
      state.params = [value > 0.5 ? { ...speed, warning } : { ...speed }];
    },
  });
  h.panel.build();
  h.panel.mount();
  const controller = h.gui().ctrl('Speed');

  controller.domElement.dispatch('pointerdown');
  controller.setValue(0.9);
  h.panel.sync();

  assert.equal(h.guis.length, 1, 'the controller under the pointer survives');
  assert.equal(h.gui().ctrl('Speed').domElement.classList.contains('param-warning'),
    false);

  h.dragTarget.dispatch('pointerup');
  h.panel.sync();

  assert.equal(h.guis.length, 2);
  assert.equal(h.gui().ctrl('Speed').domElement.getAttribute('title'), warning);
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

// The Export action copies the live values, and reports the outcome on its own
// button.

test('preset effects expose one-based labels and zero-indexed navigation', () => {
  const h = makeHarness({ presetCount: 3, presetIndex: 0 });
  h.panel.build();

  assert.deepEqual(h.gui().controllers.slice(0, 5).map((c) => c.property),
    ['reset', 'export', 'presetIndex', 'previousPreset', 'nextPreset']);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 0);
  assert.deepEqual(h.gui().ctrl('presetIndex').args, [{ 1: 0, 2: 1, 3: 2 }]);
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
  assert.equal(h.gui().ctrl('presetIndex').$select.getAttribute('aria-label'), 'Preset');
  assert.ok(h.gui().ctrl('nextPreset').domElement.classList
    .contains('preset-nav-next'));

  h.gui().ctrl('previousPreset').object.previousPreset();
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 2);
  h.gui().ctrl('nextPreset').object.nextPreset();
  assert.deepEqual(h.writes, ['preset:2', 'preset:0']);
  assert.equal(h.gui().ctrl('presetIndex').getValue(), 0);
  assert.equal(h.gui().ctrl('pause').getValue(), true);
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

test('a preset rebuild adopts the post-sync preset range and index', () => {
  const h = makeHarness({
    params: [SPEED],
    engineValues: [0.1],
    generation: 1,
    presetCount: 3,
    presetIndex: 0,
    onSynchronizePreset: (_index, state) => {
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
  assert.deepEqual(preset.args, [{ 1: 0 }]);
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

test('Export copies the live values as a C++ brace-init list', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED, GLOW], engineValues: [0.25, 0.5] });
  h.panel.build();

  h.gui().ctrl('export').object.export();
  await Promise.resolve();

  assert.deepEqual(h.state.copyText.copied, ['{ 0.25f, 0.5f }']);
  assert.equal(h.gui().ctrl('export').label, '\u2713');
  assert.equal(h.gui().ctrl('export').$button.getAttribute('title'), EXPORT_COPIED);
  assert.equal(exportStatus(h).textContent, EXPORT_COPIED);
});

test('the Export outcome is announced in a polite live region', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeHarness({ params: [SPEED], engineValues: [0.25], copyText: null });
  h.panel.build();
  const status = exportStatus(h);

  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, '');

  h.gui().ctrl('export').object.export();
  assert.equal(status.textContent, EXPORT_FAILED);

  mock.timers.tick(FLASH_MS);
  assert.equal(status.textContent, '',
    'a live region re-announces a repeat only after the text changes');
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
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /clipboard copy unavailable/);
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

  await h.gui().ctrl('export').object.export();

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

test('a parameter edit persists only that parameter\'s accepted value', () => {
  const speed = { ...SPEED };
  const glow = { ...GLOW };
  const h = makeHarness({
    params: [speed, glow],
    onEngineParam: (name, value) => {
      if (name === speed.name) speed.value = value;
    },
  });
  h.panel.build();
  h.gui().storedWrites.length = 0;

  h.gui().ctrl('Speed').setValue(0.4);

  assert.deepEqual(h.gui().ctrl('Speed').acceptedUrlValues, [0.4]);
  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.4]]);
});

test('a refused parameter edit keeps the accepted deep-link value', () => {
  const speed = {
    name: 'Speed', value: 0.2, requestedValue: 0.2, acceptedValue: 0.2,
    min: 0, max: 1, animated: true,
  };
  const h = makeHarness({
    params: [speed],
    onEngineParam: () => false,
  });
  h.panel.build();
  h.gui().storedWrites.length = 0;
  const controller = h.gui().ctrl('Speed');

  controller.setValue(0.8);

  assert.equal(controller.getValue(), 0.8);
  assert.deepEqual(controller.acceptedUrlValues, [0.2]);
  assert.deepEqual(h.gui().storedWrites, [['__accepted.Speed', 0.2]]);
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

// ── The chain editor's external-parameter filter ────────────────────────────

function chainParams() {
  return [
    { name: 'camera.wander', value: 0, min: 0, max: 1, animated: true },
    { name: 'sample.pattern-freq', value: 1, min: 0.1, max: 20, animated: true },
    { name: 'sample.coverage-mode', value: 1, requestedValue: 1,
      options: ['none', 'weight', 'weight-squared', 'edge-fade'] },
    { name: 'sample.edge-width', value: 0.1, min: 0, max: 1, animated: true },
  ];
}

// §4.4: the chain's parameters render on the pipeline strip's chips, so the
// panel builds none of them — but the value stream is positional, so every one
// still claims its slot.
test('the external filter builds no parameter controls', () => {
  const params = chainParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });
  h.state.paramFilter = { external: true };

  h.panel.build();
  const fx = h.panel.active();

  assert.deepEqual([...fx.controllerByName.keys()], []);
  assert.deepEqual(fx.paramNames, params.map((parameter) => parameter.name),
    'the value-stream order stays whole');
  assert.equal(fx.hasParams, false, 'nothing to sync per frame');
});

test('a filter change rebuilds the panel on the next sync', () => {
  const params = chainParams();
  const h = makeHarness({
    params,
    engineValues: params.map((parameter) => parameter.value),
  });
  h.panel.build();
  assert.equal(h.panel.active().controllerByName.has('camera.wander'), true);

  h.state.paramFilter = { external: true };
  h.panel.sync();
  assert.equal(h.panel.active().controllerByName.has('camera.wander'), false);
  assert.equal(h.panel.active().controllerByName.has('sample.pattern-freq'), false);

  h.state.paramFilter = null;
  h.panel.sync();
  assert.equal(h.panel.active().controllerByName.has('camera.wander'), true,
    'clearing the filter restores the unfiltered panel');
});
