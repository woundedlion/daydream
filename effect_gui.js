/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The effect panel's whole lifecycle — build, mount, per-frame value sync,
 * Export, and teardown — with lil-gui, the engine, the worker pool, the
 * copy operation, and the document injected. daydream.js owns only the wiring
 * that names those collaborators, so the panel's rules (which control an engine
 * parameter maps to, which value stream feeds the sliders, what blocks an
 * Export, what a destroyed GUI must release) are unit-testable without a
 * browser or a WASM engine.
 */

import {
  resolveParamSync,
  enumChoices,
  paramControlKind,
  engineParamValue,
  paramExportBlocker,
  paramGenerationStale,
  paramValueSkew,
  selectorControlValue,
} from "./param_sync.js";
import { formatExportParams } from "./tools/export_params.js";

// How long a transient button label (Export status) stays before reverting.
export const FLASH_MS = 1500;
// Transient Export button labels.
export const EXPORT_COPIED = '\u2713 Copied!';
export const EXPORT_FAILED = '\u2717 Copy failed';
const EXPORT_ICON = '\u29c9';
const RESET_ICON = '\u21ba';
const PREVIOUS_ICON = '\u25c0';
const NEXT_ICON = '\u25b6';
export const FULL_CONFIG_STORAGE_KEY = '__fullConfig';
const RESERVED_CONTROL_NAMES = new Set([
  'reset', 'export', 'presetIndex', 'previousPreset', 'nextPreset', 'pause'
]);
export const SHADERBALL_STAGE_ORDER = [
  'Camera',
  'Lens',
  'Surface Noise',
  'Projection Frame',
  'Projection',
  'Planar Warp 1',
  'Planar Warp 2',
  'Function',
  'Signal Weight',
  'Value Transfer',
  'Coverage',
  'Colorize',
];
export const CURL_LATTICE_STAGE_ORDER = [
  'Camera',
  'Surface Noise',
  'Projection Frame',
  'Projection',
  'Function',
  'Colorize',
];
export const FACET_GRID_STAGE_ORDER = [
  'Camera',
  'Projection Frame',
  'Projection',
  'Planar Warp 2',
  'Function',
  'Colorize',
];
const CURL_LATTICE_STAGE_TITLES = new Map([
  ['Camera', 'Camera'],
  ['Surface Noise', 'Curl'],
  ['Projection Frame', 'Spin + Wander'],
  ['Projection', 'Folded Sinusoidal'],
  ['Function', 'Primitive Lattice'],
  ['Colorize', 'Generated Triadic'],
]);
const FACET_GRID_STAGE_TITLES = new Map([
  ['Camera', 'Camera'],
  ['Projection Frame', 'Spin + Wander'],
  ['Projection', 'Stereographic'],
  ['Planar Warp 2', 'Mirror Tile'],
  ['Function', 'Grid'],
  ['Colorize', 'Generated Analogous'],
]);
const FIXED_SHADER_MODE_FIELDS = new Map([
  ['Function', ['slots.function', [
    'Twin Wave', 'Rings', 'Spiral', 'Grid', 'Noise Contour (Projected)',
    'Primitive Lattice', 'Noise Contour (Sphere)',
  ]]],
  ['Projection', ['slots.projection', [
    'Folded Sinusoidal', 'Stereographic', 'Gnomonic', 'Bonne',
    'Peirce Quincuncial', 'Dymaxion / Airocean', 'Equirectangular',
  ]]],
  ['Projection Frame', ['slots.projection_frame', [
    'Identity', 'Spin + Wander',
  ]]],
  ['Surface Noise', ['slots.surface_noise', ['None', 'Direct', 'Curl']]],
  ['Lens', ['slots.surface_lens', [
    'None',
    'Glitch',
    'Twist',
    'Kaleidoscope (Azimuthal 6-fold)',
    'Mobius',
    'Tangent Noise',
    'Kaleidoscope (Tetrahedral)',
    'Kaleidoscope (Octahedral / Cubic)',
    'Kaleidoscope (Dodecahedral / Icosahedral)',
    'Kaleidoscope (Triangular Prism)',
    'Kaleidoscope (Square Prism)',
    'Kaleidoscope (Pentagonal Prism)',
    'Kaleidoscope (Hexagonal Prism)',
    'Kaleidoscope (Octagonal Prism)',
  ]]],
  ['Planar Warp 1', ['slots.warp_program.outer.kind', [
    'None', 'Stereo Noise', 'Affine Transform', 'Wave Shear', 'Vortex',
    'Projected Vector Noise', 'Projected Curl Flow', 'Mirror Tile',
    'Polar Chart',
  ]]],
  ['Planar Warp 2', ['slots.warp_program.inner.kind', [
    'None', 'Stereo Noise', 'Affine Transform', 'Wave Shear', 'Vortex',
    'Projected Vector Noise', 'Projected Curl Flow', 'Mirror Tile',
    'Polar Chart',
  ]]],
  ['Signal Weight', ['slots.signal_weight', ['None', 'Projection']]],
  ['Value Transfer', ['slots.value_transfer', [
    'Linear', 'Ridge', 'Iso Contour', 'Smooth Bands',
  ]]],
  ['Coverage', ['slots.coverage', [
    'Opaque', 'Projection Weight Squared', 'Value Cutout', 'Edge Fade',
    'Projection Weight',
  ]]],
  ['Colorize', ['slots.palette', [
    'Generated Triadic', 'Generated Complementary', 'Generated Analogous',
  ]]],
]);
const SHADERBALL_STAGE_BOUNDARIES = new Map([
  ['Function', 'Function'],
  ['Projection', 'Projection'],
  ['Projection Frame', 'Projection Frame'],
  ['Camera Wander', 'Camera'],
  ['Surface Noise', 'Surface Noise'],
  ['Lens', 'Lens'],
  ['Planar Warp 1', 'Planar Warp 1'],
  ['Planar Warp 2', 'Planar Warp 2'],
  ['Signal Weight', 'Signal Weight'],
  ['Value Transfer', 'Value Transfer'],
  ['Coverage', 'Coverage'],
  ['Palette', 'Colorize'],
]);
const SHADERBALL_SIGNATURE = [
  'Function', 'Projection', 'Lens', 'Planar Warp 1', 'Planar Warp 2',
  'Signal Weight', 'Value Transfer', 'Coverage', 'Palette',
];
const CURL_LATTICE_STAGE_BY_PARAMETER = new Map([
  ['Camera Wander', 'Camera'],
  ['Surface Noise Scale', 'Surface Noise'],
  ['Surface Noise Strength', 'Surface Noise'],
  ['Surface Noise Speed', 'Surface Noise'],
  ['Projection Spin Speed', 'Projection Frame'],
  ['Projection Wander', 'Projection Frame'],
  ['Pole Fade', 'Projection'],
  ['Central Meridian', 'Projection'],
  ['Lattice Cell Scale', 'Function'],
  ['Lattice Shape', 'Function'],
  ['Lattice Softness', 'Function'],
  ['Lattice Radius', 'Function'],
  ['Palette Chroma', 'Colorize'],
  ['Mapping Frequency', 'Colorize'],
  ['Mapping Phase', 'Colorize'],
  ['Phase Oscillation Depth', 'Colorize'],
  ['Phase Oscillation Speed', 'Colorize'],
  ['Brightness Depth', 'Colorize'],
  ['Value Opacity Low', 'Colorize'],
  ['Value Opacity High', 'Colorize'],
  ['Hue Shift Amount', 'Colorize'],
  ['Hue Noise Scale', 'Colorize'],
  ['Hue Noise Speed', 'Colorize'],
]);
const FACET_GRID_STAGE_BY_PARAMETER = new Map([
  ['Camera Wander', 'Camera'],
  ['Projection Spin Speed', 'Projection Frame'],
  ['Projection Wander', 'Projection Frame'],
  ['Pole Fade', 'Projection'],
  ['Planar Warp 2 Speed', 'Planar Warp 2'],
  ['Planar Warp 2 Rotation', 'Planar Warp 2'],
  ['Planar Warp 2 Cell X', 'Planar Warp 2'],
  ['Planar Warp 2 Cell Y', 'Planar Warp 2'],
  ['Planar Warp 2 Offset X', 'Planar Warp 2'],
  ['Planar Warp 2 Offset Y', 'Planar Warp 2'],
  ['Pattern Freq', 'Function'],
  ['Speed', 'Function'],
  ['Source Angle Speed', 'Function'],
  ['Complexity', 'Function'],
  ['Pattern Mix', 'Function'],
  ['Drift', 'Function'],
  ['Palette Chroma', 'Colorize'],
  ['Mapping Frequency', 'Colorize'],
  ['Mapping Phase', 'Colorize'],
  ['Phase Oscillation Depth', 'Colorize'],
  ['Phase Oscillation Speed', 'Colorize'],
  ['Value Opacity Low', 'Colorize'],
  ['Value Opacity High', 'Colorize'],
  ['Hue Shift Amount', 'Colorize'],
  ['Hue Noise Scale', 'Colorize'],
  ['Hue Noise Speed', 'Colorize'],
]);

/**
 * @param {string} name - Canonical engine parameter name.
 * @returns {Array<string>} Former names accepted from saved deep links.
 */
export function legacyShaderBallParamNames(name) {
  if (name === 'Camera Wander') return ['Outer Wander'];
  if (name === 'Palette') return ['Colorizer'];
  if (name === 'Hue Shift Amount') return ['Hue Noise Amount', 'Hue Shift'];
  for (const [prefix, legacy] of [
    ['Planar Warp 1', 'Outer'],
    ['Planar Warp 2', 'Inner'],
  ]) {
    if (name === prefix) return [`${legacy} Warp`];
    if (!name.startsWith(`${prefix} `)) continue;
    const suffix = name.slice(prefix.length + 1);
    if (['Strength', 'Scale', 'Time', 'Envelope'].includes(suffix)) {
      return [`${legacy} Warp ${suffix}`];
    }
    return [`${legacy} ${suffix}`];
  }
  return [];
}

/**
 * Whether a parameter schema is ShaderBall's, recognized by its per-stage
 * selectors. The panel's stage grouping and the app's choice of persistence
 * strategy both key off this predicate, so the two cannot disagree about which
 * effect is loaded.
 * @param {Array<Object>} params - Engine parameter definitions.
 * @returns {boolean} True when every stage selector is registered.
 */
export function isShaderBallSchema(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  return SHADERBALL_SIGNATURE.every((name) => names.has(name));
}

/**
 * @param {Array<Object>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to pipeline-stage title.
 */
export function shaderBallStageAssignments(params) {
  if (!isShaderBallSchema(params)) return null;
  const assignments = new Map();
  let stage = 'Function';
  for (const parameter of params) {
    stage = SHADERBALL_STAGE_BOUNDARIES.get(parameter.name) ?? stage;
    assignments.set(parameter.name, stage);
  }
  return assignments;
}

/**
 * @param {Array<Object>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function curlLatticeStageAssignments(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  if ([...CURL_LATTICE_STAGE_BY_PARAMETER.keys()].some((name) => !names.has(name))) {
    return null;
  }
  return new Map(params.map((parameter) =>
    [parameter.name, CURL_LATTICE_STAGE_BY_PARAMETER.get(parameter.name)]));
}

/**
 * @param {Array<Object>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function facetGridStageAssignments(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  if ([...FACET_GRID_STAGE_BY_PARAMETER.keys()].some((name) => !names.has(name))) {
    return null;
  }
  return new Map(params.map((parameter) =>
    [parameter.name, FACET_GRID_STAGE_BY_PARAMETER.get(parameter.name)]));
}

/**
 * @param {Array<Object>} params - Fixed Shader parameter definitions.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function fixedShaderStageAssignments(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  if (!names.has('Camera Wander') || !names.has('Palette Chroma')
      || !names.has('Mapping Frequency') || isShaderBallSchema(params)) {
    return null;
  }
  const hasGenericWarp = [...names].some((name) => name.startsWith('Warp '));
  const mirrorStage = hasGenericWarp || names.has('Planar Warp 2 Speed')
    ? 'Planar Warp 2' : 'Planar Warp 1';
  const warpStage = [...names].some((name) => name.startsWith('Polar '))
    ? 'Planar Warp 2' : 'Planar Warp 1';
  const stageFor = (name) => {
    if (name === 'Camera Wander') return 'Camera';
    if (name.startsWith('Surface Noise ')) return 'Surface Noise';
    if (name === 'Projection Spin Speed' || name === 'Projection Wander') {
      return 'Projection Frame';
    }
    if (/^(Pole Fade|Central Meridian|Projection |Peirce |Bonne |Gnomonic )/.test(name)) {
      return 'Projection';
    }
    if (name.startsWith('Planar Warp 1 ')) return 'Planar Warp 1';
    if (name.startsWith('Planar Warp 2 ')) return 'Planar Warp 2';
    if (name.startsWith('Mirror ')) return mirrorStage;
    if (name.startsWith('Warp ')) return warpStage;
    if (name.startsWith('Affine ') || name.startsWith('Polar ')) {
      return 'Planar Warp 1';
    }
    if (name.startsWith('Mobius ')) return 'Lens';
    if (/^(Iso |Band )/.test(name)) return 'Value Transfer';
    if (/^(Edge(?: Fade)?|Cutout )/.test(name)) return 'Coverage';
    if (/^(Pattern|Speed$|Source |Complexity|Drift|Lattice )/.test(name)) {
      return 'Function';
    }
    return 'Colorize';
  };
  return new Map(params.map((parameter) => [parameter.name, stageFor(parameter.name)]));
}

/**
 * @param {Object|null} snapshot - Versioned Shader configuration snapshot.
 * @param {Array<Object>|null} fields - Snapshot field definitions.
 * @returns {Map<string, string>|null} Fixed stage position to selected mode.
 */
export function fixedShaderStageTitles(snapshot, fields) {
  if (!snapshot || !Array.isArray(snapshot.accepted) || !Array.isArray(fields)) {
    return null;
  }
  const fieldIds = new Map(fields.map((field) => [field.name, field.id]));
  const titles = new Map([['Camera', 'Camera']]);
  for (const [stage, [fieldName, options]] of FIXED_SHADER_MODE_FIELDS) {
    const id = fieldIds.get(fieldName);
    const mode = id === undefined ? undefined : options[snapshot.accepted[id]];
    if (mode === undefined) return null;
    titles.set(stage, mode);
  }
  return titles;
}

function shaderBallControlLabel(stage, name) {
  if (SHADERBALL_STAGE_BOUNDARIES.has(name)) {
    if (stage === 'Colorize') return 'Palette';
    return stage === 'Camera' ? 'Wander' : 'Mode';
  }
  if (name.startsWith(`${stage} `)) return name.slice(stage.length + 1);
  if (stage === 'Projection Frame' && name.startsWith('Projection ')) {
    return name.slice('Projection '.length);
  }
  if (stage === 'Function' && name.startsWith('Lattice ')) {
    return name.slice('Lattice '.length);
  }
  return name;
}

/**
 * The focusable widget a lil-gui controller built: a dropdown's select, an
 * input, or a button, whichever its control kind owns.
 * @param {Object|undefined} controller - A controller from an effect record.
 * @returns {Object|null} The element that takes focus, or null.
 */
function focusWidget(controller) {
  return controller?.$select ?? controller?.$input
    ?? controller?.$button ?? null;
}

/**
 * The id one parameter's warning text is published under, for the control's
 * aria-describedby to name.
 * @param {string} name - Engine parameter name.
 * @returns {string} The element id.
 */
function paramWarningId(name) {
  return `param-warning-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

/**
 * The warning text the engine publishes for each parameter that carries one.
 * @param {Array<Object>} params - Engine parameter definitions.
 * @returns {Map<string, string>} Parameter name to warning text.
 */
function paramWarningTexts(params) {
  return new Map(params.filter((p) => p.warning).map((p) => [p.name, p.warning]));
}

/**
 * The `gui` method a parameter's control is added through: a session control
 * owns no deep-link key, a migrated one accepts its former keys too, and an
 * unhydrated one owns its key but is never seeded from the URL.
 * @param {Object} gui - The effect GUI to add to.
 * @param {Object} p - The parameter definition.
 * @param {boolean} hydrate - Whether a matching deep link may seed it.
 * @param {Array<string>} legacyNames - Former deep-link property names.
 * @param {boolean} persist - Whether the control owns a deep-link key.
 * @returns {(object: Object, property: string, ...rest: Array<*>) => Object}
 */
function paramAddMethod(gui, p, hydrate, legacyNames, persist) {
  if (p.readonly || !persist) return (...args) => gui.addSession(...args);
  if (hydrate && legacyNames.length > 0 && typeof gui.addMigrated === 'function') {
    return (object, property, ...rest) =>
      gui.addMigrated(object, property, legacyNames, ...rest);
  }
  if (!hydrate && typeof gui.addUnhydrated === 'function') {
    return (...args) => gui.addUnhydrated(...args);
  }
  return (...args) => gui.add(...args);
}

/**
 * Add the lil-gui control one engine parameter definition calls for. A readonly
 * (engine-written telemetry) param becomes a session control: the engine refuses
 * to set it, so seeding it from a URL and writing it back is meaningless.
 * @param {Object} gui - The effect GUI to add to.
 * @param {Object} state - The GUI-bound value object.
 * @param {Object} p - The parameter definition.
 * @param {boolean} [hydrate=true] - Whether a matching deep link may seed it.
 * @param {Array<string>} [legacyNames=[]] - Former deep-link property names.
 * @param {boolean} [persist=true] - Whether the control owns a deep-link key.
 * @returns {Object} The created controller.
 */
export function addParamControl(
  gui, state, p, hydrate = true, legacyNames = [], persist = true) {
  const kind = paramControlKind(p);
  const add = paramAddMethod(gui, p, hydrate, legacyNames, persist);
  let controller;
  if (kind === 'boolean') {
    controller = add(state, p.name);
  } else if (kind === 'enum') {
    // Dropdown of labels whose values are the option indices the engine expects.
    controller = add(state, p.name, enumChoices(p.options));
  } else if (kind === 'integer') {
    // The engine truncates a fractional write, so offer only what it can hold.
    controller = add(state, p.name, p.min, p.max, 1).decimals(0);
  } else {
    const decimals = Math.abs(p.max - p.min) <= 0.1 ? 6 : 3;
    controller = add(state, p.name, p.min, p.max).decimals(decimals);
  }
  controller.isBoolean = (kind === 'boolean');
  controller.isEnum = (kind === 'enum');
  controller.isContinuous = (kind === 'number' || kind === 'integer');
  if (p.warning) {
    // Assistive technology reads aria-invalid and aria-describedby off the
    // widget, not off the wrapper the control is drawn in, and reaches the
    // warning text only through a node — a title attribute is mouse-only.
    const widget = focusWidget(controller) ?? controller.domElement;
    const note = controller.domElement.ownerDocument.createElement('span');
    note.id = paramWarningId(p.name);
    note.className = 'visually-hidden';
    note.textContent = p.warning;
    controller.domElement.appendChild(note);
    controller.domElement.classList.add('param-warning');
    controller.domElement.setAttribute('title', p.warning);
    widget.setAttribute('aria-invalid', 'true');
    widget.setAttribute('aria-describedby', note.id);
  }
  return controller;
}

/**
 * Build the effect GUI controller for the app's active effect.
 *
 * @param {Object} deps - Injected app collaborators.
 * @param {() => Object} deps.createGui - Makes an empty effect GUI root.
 * @param {() => Array<Object>} deps.getParameterDefinitions - Reads the engine's
 *   parameter definitions for the effect it currently has loaded.
 * @param {() => number|undefined} deps.paramGeneration - Reads the engine's
 *   effect-load generation, stamped onto each definitions snapshot.
 * @param {() => boolean} deps.segmentsOwnDisplay - Whether the worker pool owns
 *   the display, making its values (not the idle main engine's) the live ones.
 * @param {() => ArrayLike<number>|null} deps.segmentParamValues - The pool's
 *   per-frame value stream.
 * @param {() => ArrayLike<number>|null} deps.engineParamValues - The main
 *   engine's per-frame value stream.
 * @param {(name: string, value: number) => void} deps.setEngineParam - Writes one
 *   parameter to the main engine.
 * @param {(name: string, value: number) => void} deps.setWorkerParam - Writes one
 *   parameter to the worker pool.
 * @param {(paused: boolean) => void} deps.setAnimationsPaused - Freezes/resumes
 *   animation-driven params on every engine.
 * @param {() => number} deps.getPresetCount - Number of presets on the live effect.
 * @param {() => number} deps.getPresetIndex - Selected preset on the live effect.
 * @param {(index: number) => boolean} deps.synchronizePreset - Mirrors a live
 *   worker preset into the engine that owns GUI parameter definitions.
 * @param {(index: number) => boolean} deps.selectPreset - Selects one preset on every engine.
 * @param {() => boolean|undefined} deps.engineAnimationsPaused - Reads the main
 *   engine's animation-pause state, undefined on a module without the accessor.
 * @param {() => void} deps.applyEffect - Rebuilds the panel from engine state
 *   (the Reset button).
 * @param {() => Object|null} deps.guiContainer - The element the panel mounts in.
 * @param {() => boolean} deps.isMobile - Whether to mount the panel collapsed.
 * @param {{addEventListener: Function, removeEventListener: Function}}
 *   deps.dragTarget - Where the drag-end listeners live (the window): a lil-gui
 *   drag continues outside the control's own DOM.
 * @param {() => Object|null} [deps.focusedElement] - The document's focused
 *   element. A control whose number input has focus is being typed into, so the
 *   per-frame value stream must leave it alone.
 * @param {(text: string) => Promise<boolean>} deps.copyText - Copies text using
 *   the browser's available clipboard path.
 * @param {() => boolean} [deps.usesFullConfigSnapshot] - Whether the active
 *   effect persists through the exhaustive versioned snapshot API.
 * @param {() => Object|null} [deps.getFullConfigSnapshot] - Captures that state.
 * @param {() => Array<Object>|null} [deps.getFullConfigFieldDefinitions] -
 *   Names the fields in a full configuration snapshot.
 * @param {(snapshot: Object) => string} [deps.restoreFullConfigSnapshot] -
 *   Atomically restores a captured state, returning the engine's
 *   FullConfigRestoreResult constant name ("APPLIED" on success).
 * @param {() => string} [deps.getConfigImportNotice] - Reads a migration notice.
 * @param {() => void} [deps.clearConfigImportNotice] - Consumes that notice.
 * @param {(message: string|null) => void} [deps.showConfigImportNotice] - Shows
 *   or clears the migration notice.
 * @param {(message: string, error?: any) => void} [deps.logWarn] - Console sink.
 * @returns {{active: () => Object|null, liveParamValues: () => ArrayLike<number>|null,
 *   movePreset: (delta: number) => boolean, build: () => void,
 *   applyAnimationPause: () => void, mount: () => void, sync: () => void,
 *   destroy: () => void}}
 */
export function createEffectGui({
  createGui,
  getParameterDefinitions,
  paramGeneration,
  segmentsOwnDisplay,
  segmentParamValues,
  engineParamValues,
  setEngineParam,
  setWorkerParam,
  setAnimationsPaused,
  getPresetCount,
  getPresetIndex,
  synchronizePreset,
  selectPreset,
  engineAnimationsPaused,
  applyEffect,
  guiContainer,
  isMobile,
  dragTarget,
  focusedElement = () => null,
  copyText,
  usesFullConfigSnapshot = () => false,
  getFullConfigSnapshot = () => null,
  getFullConfigFieldDefinitions = () => null,
  restoreFullConfigSnapshot = () => 'NO_ENGINE',
  getConfigImportNotice = () => '',
  clearConfigImportNotice = () => {},
  showConfigImportNotice = () => {},
  logWarn = (...args) => console.warn(...args),
}) {
  let activeEffect = null;
  // Throttle the param/value length-skew warning to once per skew episode.
  let skewLogged = false;
  let rebuildFailureGeneration;
  const acceptedStorageKey = (name) => `__accepted.${name}`;

  function persistEffectState(gui) {
    if (!usesFullConfigSnapshot()) {
      persistAcceptedParams(gui);
      return;
    }
    const snapshot = getFullConfigSnapshot();
    if (!snapshot) return;
    gui?.writeStoredValue?.(FULL_CONFIG_STORAGE_KEY, JSON.stringify(snapshot));
  }

  function restoreEffectState(gui) {
    if (!usesFullConfigSnapshot()) {
      restoreAcceptedParams(gui);
      return;
    }
    const text = gui?.readStoredString?.(FULL_CONFIG_STORAGE_KEY);
    if (text === undefined) return;
    let snapshot;
    try {
      snapshot = JSON.parse(text);
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new TypeError('snapshot must be an object');
      }
      if (!Object.hasOwn(snapshot, 'schemaVersion')) snapshot.schemaVersion = 1;
    } catch (error) {
      logWarn('ShaderBall: ignoring invalid full-config snapshot', error);
      return;
    }
    const outcome = restoreFullConfigSnapshot(snapshot);
    if (outcome !== 'APPLIED') {
      logWarn(`ShaderBall: full-config snapshot was rejected: ${outcome}`);
      return;
    }
    const notice = getConfigImportNotice();
    clearConfigImportNotice();
    showConfigImportNotice(notice || null);
  }

  function persistAcceptedParams(gui) {
    for (const parameter of getParameterDefinitions()) {
      if (parameter.readonly) continue;
      const accepted = parameter.acceptedValue
        ?? parameter.requestedValue ?? parameter.value;
      // The float form, not the raw value: restoreAcceptedParams() reads the
      // companion key back through the URL number grammar, which rejects a bool.
      gui?.writeStoredValue?.(
        acceptedStorageKey(parameter.name), engineParamValue(accepted));
    }
  }

  /**
   * Replay the stored accepted values into the engine. The definition list is
   * re-read after every write because a write can change it — a ShaderBall
   * selector swaps in the controls of the stage it selects — so parameters that
   * did not exist a write ago still get their stored value. Nothing in the loop
   * writes the stored values it reads, so one probe per name settles it and the
   * rescan costs a set lookup rather than a URL read.
   * @param {Object} gui - The effect GUI holding the stored values.
   * @returns {void}
   */
  function restoreAcceptedParams(gui) {
    if (typeof gui?.readStoredNumber !== 'function') return;
    const probed = new Set();
    for (;;) {
      let parameter;
      let value;
      for (const candidate of getParameterDefinitions()) {
        if (candidate.readonly || probed.has(candidate.name)) continue;
        probed.add(candidate.name);
        const stored = gui.readStoredNumber(
          acceptedStorageKey(candidate.name),
          legacyShaderBallParamNames(candidate.name).map(acceptedStorageKey));
        if (stored === undefined) continue;
        parameter = candidate;
        value = stored;
        break;
      }
      if (!parameter) return;
      setEngineParam(parameter.name, value);
    }
  }

  /**
   * Live per-frame parameter values for the active effect. Once the worker pool
   * owns the display the main engine is no longer stepped, so its values are
   * stale; source from segment 0's worker instead (the pool drops its values on
   * an effect switch and fences the stream on renderGen). May be null or
   * zero-length if the WASM view detached on heap growth — callers must guard.
   * @returns {ArrayLike<number>|null} Null when no stream describes the GUI's
   *   current parameter snapshot.
   */
  function liveParamValues() {
    // The main engine's value stream describes whatever effect it last loaded;
    // pairing it with a snapshot from an earlier load binds sliders to another
    // effect's values, which equal parameter counts would hide. The main engine
    // also owns the parameter definitions in segmented mode, even though segment
    // 0 owns the live values, so this identity check precedes the source choice.
    if (activeEffect
        && paramGenerationStale(activeEffect.paramGeneration, paramGeneration())) {
      return null;
    }
    if (segmentsOwnDisplay()) {
      // Worker and main-engine generations are instance-local; paramRevision
      // fences worker snapshots.
      return segmentParamValues();
    }
    return engineParamValues();
  }

  /**
   * Whether the engine's parameter warnings have moved off the ones the panel
   * was built from. A refused write raises or clears a warning without loading
   * an effect, so the schema generation cannot report it. Deferred while a drag
   * is in flight: the rebuild would discard the controller under the pointer.
   * @param {Object} fx - The active effect record.
   * @returns {boolean} True when the panel must be rebuilt to show them.
   */
  function paramWarningsStale(fx) {
    if (!fx.warningsDirty || fx.activeDragEnds.size > 0) return false;
    fx.warningsDirty = false;
    const current = paramWarningTexts(getParameterDefinitions());
    if (current.size !== fx.paramWarnings.size) return true;
    for (const [name, warning] of current) {
      if (fx.paramWarnings.get(name) !== warning) return true;
    }
    return false;
  }

  function adoptPauseDisplay(fx, paused) {
    if (paused === undefined || paused === fx.pause.animationState.pause) return;
    fx.pause.animationState.pause = paused;
    fx.pause.controller?.updateDisplay();
  }

  function adoptPresetDisplay(fx, count, index) {
    if (!fx.preset || count <= 0) return;
    if (fx.preset.state.presetIndex === index) return;
    fx.preset.state.presetIndex = index;
    fx.preset.controller.updateDisplay();
  }

  /**
   * Re-seat the effect's enum selectors on the requested values the engine
   * holds. Only the definitions carry `requestedValue`, so this reads the
   * definitions snapshot rather than the per-frame value stream — an effect
   * with no enum control skips it and keeps sync() off that marshal.
   * @param {Object} fx - The active effect record.
   * @param {Object|null} focused - The document's focused element, or null. An
   *   animated selector streams a new requested value every frame, so an open
   *   dropdown has to be left alone like any other controller under edit.
   * @returns {void}
   */
  function adoptRequestedEnums(fx, focused) {
    if (!fx.hasEnumControls) return;
    for (const parameter of getParameterDefinitions()) {
      const controller = fx.controllerByName.get(parameter.name);
      if (!controller?.isEnum) continue;
      const isEditing = focused !== null
        && controller.domElement?.contains(focused) === true;
      const { update, value } = resolveParamSync(
        controller.getValue(), selectorControlValue(parameter), false, isEditing);
      if (!update) continue;
      controller.object[controller.property] = value;
      controller.updateDisplay();
    }
  }

  /**
   * Push the engine's per-frame parameter values back into the effect GUI so
   * all rendered params track live without clobbering an active drag.
   * @returns {void}
   */
  function sync() {
    if (!activeEffect || !activeEffect.controllerByName) return;
    const presetCount = getPresetCount();
    const presetIndex = getPresetIndex();
    // Mirroring the preset can itself load a new schema, so the rebuild follows
    // it — but a refusal must not gate the rebuild, which is what clears the
    // stale schema a refusal comes from.
    const presetSynced = synchronizePreset(presetIndex);
    if (paramGenerationStale(activeEffect.paramGeneration, paramGeneration())
        || paramWarningsStale(activeEffect)) {
      if (!rebuildSchema()) return;
    }
    if (!presetSynced) return;
    adoptPauseDisplay(activeEffect, engineAnimationsPaused());
    adoptPresetDisplay(activeEffect, presetCount, presetIndex);
    if (!activeEffect.hasParams) return;
    // One focus read for the whole pass: at most one element has focus.
    const focused = focusedElement() ?? null;
    adoptRequestedEnums(activeEffect, focused);

    const values = liveParamValues();
    if (!values || values.length === 0) return;

    const names = activeEffect.paramNames;
    // A names/values length skew means the cached param list drifted from the
    // engine's value stream (e.g. a stale list after an async effect change);
    // skip rather than silently mis-bind sliders by index, mirroring the Export
    // action's check.
    if (paramValueSkew(names.length, values.length)) {
      if (!skewLogged) {
        logWarn(`Effect GUI: param/value length skew (${names.length} vs ${values.length}); skipping sync`);
        skewLogged = true;
      }
      return;
    }
    skewLogged = false;
    const n = names.length;
    for (let i = 0; i < n; i++) {
      const c = activeEffect.controllerByName.get(names[i]);
      if (!c) continue;
      if (c.isEnum) continue;

      const isEditing = c.dragging
        || (focused !== null && c.domElement?.contains(focused) === true);

      const { update, value } = resolveParamSync(
        c.getValue(), values[i], c.isBoolean, isEditing);
      if (!update) continue;
      c.object[c.property] = value;
      c.updateDisplay();
    }
  }

  /**
   * Write the live parameter values to the clipboard as a C++ brace-init list.
   * @param {Object} fx - The effect record owning the Export button.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @param {(label: string) => void} flashExport - Shows a transient Export label.
   * @returns {void}
   */
  function exportParams(fx, params, flashExport) {
    if (usesFullConfigSnapshot()) {
      const snapshot = getFullConfigSnapshot();
      if (!snapshot || typeof copyText !== 'function') {
        logWarn('Export: ShaderBall full-config snapshot is unavailable');
        flashExport(EXPORT_FAILED);
        return;
      }
      copyText(JSON.stringify(snapshot, null, 2)).then((copied) => {
        if (activeEffect !== fx) return;
        if (copied) flashExport(EXPORT_COPIED);
        else {
          logWarn('Export: clipboard copy failed');
          flashExport(EXPORT_FAILED);
        }
      }).catch((err) => {
        logWarn('Export: clipboard copy failed', err);
        if (activeEffect === fx) flashExport(EXPORT_FAILED);
      });
      return;
    }
    let values = liveParamValues();
    if ((!values || values.length === 0)
        && !paramGenerationStale(fx.paramGeneration, paramGeneration())) {
      values = fx.paramNames.map((name) =>
        engineParamValue(fx.controllerByName.get(name).getValue()));
    }
    const blocked = paramExportBlocker(
      values, fx.paramNames.length, typeof copyText === 'function');
    if (blocked) {
      logWarn(blocked);
      flashExport(EXPORT_FAILED);
      return;
    }

    let text;
    try {
      text = formatExportParams(params, values);
    } catch (err) {
      logWarn('Export: parameter formatting failed', err);
      flashExport(EXPORT_FAILED);
      return;
    }

    copyText(text).then((copied) => {
      if (activeEffect !== fx) return;
      if (copied) {
        flashExport(EXPORT_COPIED);
      } else {
        logWarn('Export: clipboard copy failed');
        flashExport(EXPORT_FAILED);
      }
    }).catch((err) => {
      logWarn('Export: clipboard copy failed', err);
      if (activeEffect !== fx) return;
      flashExport(EXPORT_FAILED);
    });
  }

  /**
   * Add the effect GUI's Reset, Export, and preset navigation buttons.
   * @param {Object} fx - The effect record being built.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @returns {void}
   */
  function addEffectActions(fx, params) {
    const ownerDocument = fx.gui.domElement.ownerDocument;
    const actionRow = ownerDocument.createElement('div');
    actionRow.classList.add('effect-action-row');
    fx.gui.appendElement(actionRow);
    fx.actionRow = actionRow;
    // The Export outcome is otherwise a glyph swap, which no screen reader
    // announces. Out of flow, so it claims no action-row grid cell.
    const exportStatus = ownerDocument.createElement('span');
    exportStatus.className = 'visually-hidden';
    exportStatus.setAttribute('role', 'status');
    exportStatus.setAttribute('aria-live', 'polite');
    actionRow.appendChild(exportStatus);
    fx.actionControllers = [];
    const presentAction = (controller, icon, label) => {
      controller.name(icon);
      const button = controller.$button ?? controller.domElement;
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    };
    const addAction = (actions, property, icon, label, className) => {
      const controller = fx.gui.add(actions, property);
      controller.domElement.classList.add('effect-action', className);
      presentAction(controller, icon, label);
      actionRow.appendChild(controller.domElement);
      fx.actionControllers.push(controller);
      return controller;
    };

    /**
     * Flash a transient status label on the Export button and announce it in the
     * action row's live region, restoring the default label after the flash
     * window. Supersedes any flash still pending for this GUI.
     * @param {string} label - The transient button label to show.
     * @returns {void}
     */
    const flashExport = (label) => {
      clearTimeout(fx.exportFlashTimer);
      presentAction(exportCtrl, label === EXPORT_COPIED ? '\u2713' : '\u2717', label);
      // Emptied on revert: a live region re-announces a repeated message only
      // after its text has changed.
      exportStatus.textContent = label;
      fx.exportFlashTimer = setTimeout(() => {
        presentAction(exportCtrl, EXPORT_ICON, 'Export');
        exportStatus.textContent = '';
      }, FLASH_MS);
    };

    const effectActions = {
      /**
       * Rebuild the effect GUI from the engine's current state, discarding
       * edits. The rebuild discards the panel this button lives in, so the
       * keyboard focus and scroll offset are carried across it.
       * @returns {void}
       */
      reset() {
        const captured = capturePanelFocus(fx);
        applyEffect();
        restorePanelFocus(activeEffect, captured);
      },
      /**
       * Copy the current parameter values to the clipboard as a C++ brace-init
       * list of float literals, then flash the outcome on the Export button.
       * @returns {void}
       */
      export() { exportParams(fx, params, flashExport); }
    };
    addAction(effectActions, 'reset', RESET_ICON, 'Reset', 'effect-action-reset');
    const exportCtrl = addAction(
      effectActions, 'export', EXPORT_ICON, 'Export', 'effect-action-export');
    const presetCount = getPresetCount();
    if (presetCount > 0) {
      effectActions.presetIndex = getPresetIndex();
      const presetOptions = enumChoices(
        Array.from({ length: presetCount }, (_, index) => String(index)));
      const addPreset = typeof fx.gui.addSession === 'function'
        ? (...args) => fx.gui.addSession(...args)
        : (...args) => fx.gui.add(...args);
      const preset = addPreset(effectActions, 'presetIndex', presetOptions)
        .name('Preset');
      fx.preset = { state: effectActions, controller: preset };
      const choose = (index) => {
        const count = getPresetCount();
        if (count <= 0 || !selectPreset(index)) {
          adoptPresetDisplay(fx, count, getPresetIndex());
          return false;
        }
        persistEffectState(fx.gui);
        adoptPresetDisplay(fx, count, index);
        adoptPauseDisplay(fx, engineAnimationsPaused() ?? true);
        return true;
      };
      preset.onChange(choose);
      const move = (delta) => {
        const count = getPresetCount();
        if (count <= 0) return false;
        return choose((getPresetIndex() + delta + count) % count);
      };
      fx.movePreset = move;
      effectActions.previousPreset = () => move(-1);
      effectActions.nextPreset = () => move(1);
      addAction(effectActions, 'previousPreset', PREVIOUS_ICON, 'Previous Preset',
        'preset-nav-previous');
      preset.domElement.classList.add('effect-action', 'preset-nav-selector');
      preset.$select?.setAttribute('aria-label', 'Preset');
      actionRow.appendChild(preset.domElement);
      fx.actionControllers.push(preset);
      addAction(effectActions, 'nextPreset', NEXT_ICON, 'Next Preset',
        'preset-nav-next');
    }
    actionRow.style.gridTemplateColumns =
      `repeat(${fx.actionControllers.length}, minmax(0, 1fr))`;
  }

  /**
   * Add the "Pause Animation" toggle, offered only when the effect has an
   * animated param.
   * @param {Object} fx - The effect record being built.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @returns {{animationState: {pause: boolean}, controller: Object|null,
   *   setPaused: (v: boolean) => void}} The toggle's state, its controller (null
   *   when no param animates), and its state transition.
   */
  function addPauseToggle(fx, params, initialPause = false, hydrate = true) {
    const animationState = { pause: Boolean(initialPause) };
    /**
     * Adopt a pause transition, applying it immediately after initial hydration
     * has been committed to the rebuilt renderers.
     * @param {boolean} v - True to freeze animations, false to resume.
     * @returns {void}
     */
    let controller = null;
    const transitionPaused = (v) => {
      animationState.pause = Boolean(v);
      if (fx.animationPauseApplied) setAnimationsPaused(animationState.pause);
    };
    const setPaused = (v) => {
      const paused = Boolean(v);
      if (controller) {
        controller.setValue(paused);
      } else {
        transitionPaused(paused);
      }
    };
    if (params.some(p => p.animated)) {
      const add = !hydrate && typeof fx.gui.addUnhydrated === 'function'
        ? (...args) => fx.gui.addUnhydrated(...args)
        : (...args) => fx.gui.add(...args);
      controller = add(animationState, 'pause').name('Pause Animation');
      controller.onChange(transitionPaused);
    }
    fx.animationState = animationState;
    fx.pauseController = controller;
    return { animationState, controller, setPaused };
  }

  /**
   * Flag a controller as dragging until the pointer is released, so sync()'s
   * value stream doesn't fight the drag. The drag-end listeners live on the drag
   * target, so they join the effect record's set for a GUI destroyed mid-drag to
   * drain. Releasing the pointer also runs the persistence the drag deferred.
   * @param {Object} fx - The effect record owning the controller.
   * @param {Object} controller - The controller to track.
   * @returns {void}
   */
  function trackDragState(fx, controller) {
    controller.domElement.addEventListener('pointerdown', () => {
      controller.dragging = true;
      const end = () => {
        controller.dragging = false;
        dragTarget.removeEventListener('pointerup', end);
        dragTarget.removeEventListener('pointercancel', end);
        fx.activeDragEnds.delete(end);
        if (!fx.persistDeferred) return;
        fx.persistDeferred = false;
        persistEffectState(fx.gui);
      };
      fx.activeDragEnds.add(end);
      dragTarget.addEventListener('pointerup', end);
      dragTarget.addEventListener('pointercancel', end);
    });
  }

  /**
   * Re-seat the pause toggle on the engine's own animation state after a
   * parameter write: the engine pauses animation-driven params implicitly when
   * one of them is written. The toggle's transition carries the adopted state on
   * to the worker pool, whose engines each keep their own copy.
   * @param {{animationState: {pause: boolean}, controller: Object|null,
   *   setPaused: (v: boolean) => void}} pause - The effect's pause toggle.
   * @param {Object} written - The definition of the parameter just written.
   * @returns {void}
   */
  function adoptEnginePause(pause, written) {
    if (!pause.controller) return;
    // undefined on a module without the accessor
    const paused = engineAnimationsPaused()
      ?? (written.animated || pause.animationState.pause);
    if (paused !== pause.animationState.pause) pause.setPaused(paused);
  }

  /**
   * Build one controller per engine parameter, recording the value-stream order.
   * A ?param=value deep link reaches the engine through the GUI's load-time
   * onChange replay.
   * @param {Object} fx - The effect record being built.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @param {{animationState: Object, controller: Object|null, setPaused: Function}}
   *   pause - The effect's pause toggle.
   * @returns {void}
   */
  function addParamControllers(fx, params, pause, previousParamNames = null) {
    // paramNames records the value-stream order; sync() binds by name, not
    // index, so a C++ param reorder can't mis-bind sliders.
    const state = {};
    fx.paramNames = [];
    fx.writableParamNames = [];
    fx.controllerByName = new Map();
    fx.hasParams = params.length > 0;
    fx.hasEnumControls = false;
    fx.paramWarnings = paramWarningTexts(params);
    const shaderBallAssignments = shaderBallStageAssignments(params);
    const curlLatticeAssignments = curlLatticeStageAssignments(params);
    const facetGridAssignments = facetGridStageAssignments(params);
    const fixedShaderCandidate = fixedShaderStageAssignments(params);
    const fullConfigSnapshot = fixedShaderCandidate
      ? getFullConfigSnapshot() : null;
    const fixedShaderTitles = fixedShaderCandidate ? fixedShaderStageTitles(
      fullConfigSnapshot, getFullConfigFieldDefinitions()) : null;
    const fixedShaderAssignments = fixedShaderTitles ? fixedShaderCandidate : null;
    const fallbackFixedAssignments = fixedShaderTitles ? null : fixedShaderCandidate;
    const stageAssignments = shaderBallAssignments ?? fixedShaderAssignments
      ?? curlLatticeAssignments ?? facetGridAssignments ?? fallbackFixedAssignments;
    const stageTitles = fixedShaderAssignments ? fixedShaderTitles
      : curlLatticeAssignments ? CURL_LATTICE_STAGE_TITLES
      : facetGridAssignments ? FACET_GRID_STAGE_TITLES
      : fixedShaderTitles;
    const stageOrder = shaderBallAssignments
      ? SHADERBALL_STAGE_ORDER
      : fixedShaderAssignments ? SHADERBALL_STAGE_ORDER.filter((stage) =>
        new Set(fixedShaderAssignments.values()).has(stage))
      : curlLatticeAssignments ? CURL_LATTICE_STAGE_ORDER
      : facetGridAssignments ? FACET_GRID_STAGE_ORDER
      : fallbackFixedAssignments ? SHADERBALL_STAGE_ORDER.filter((stage) =>
        new Set(fallbackFixedAssignments.values()).has(stage))
      : [];
    const stageFolders = new Map();
    if (stageAssignments) {
      for (const stage of stageOrder) {
        const addFolder = typeof fx.gui.addDisplayFolder === 'function'
          ? fx.gui.addDisplayFolder.bind(fx.gui)
          : fx.gui.addFolder.bind(fx.gui);
        stageFolders.set(stage, addFolder(stageTitles?.get(stage) ?? stage));
      }
    }

    const unstagedParams = [];
    params.forEach(p => {
      state[p.name] = paramControlKind(p) === 'enum'
        ? selectorControlValue(p)
        : p.value;

      const stage = stageAssignments?.get(p.name);
      if (stageAssignments && !stage) unstagedParams.push(p.name);
      const controlGui = stage ? stageFolders.get(stage) : fx.gui;
      const controller = addParamControl(
        controlGui, state, p, !previousParamNames?.has(p.name),
        legacyShaderBallParamNames(p.name), !usesFullConfigSnapshot());
      if (stage) controller.name(shaderBallControlLabel(stage, p.name));
      fx.paramNames.push(p.name);
      fx.controllerByName.set(p.name, controller);
      if (controller.isEnum) fx.hasEnumControls = true;

      if (p.readonly) {
        if (typeof controller.disable === 'function') controller.disable();
        return;
      }
      fx.writableParamNames.push(p.name);
      if (controller.isContinuous) trackDragState(fx, controller);

      controller.onChange(v => {
        const value = engineParamValue(v);
        setEngineParam(p.name, value);
        // A drag emits one onChange per pointermove and persistence reads the
        // whole effect (a definitions marshal, or ShaderBall's full-config
        // snapshot and its JSON), so it waits for the pointer release, which
        // sees the same state the last move would have.
        if (controller.dragging) fx.persistDeferred = true;
        else persistEffectState(fx.gui);
        setWorkerParam(p.name, value);
        adoptEnginePause(pause, p);
        fx.warningsDirty = true;
      });
    });
    if (unstagedParams.length > 0) {
      logWarn(`Effect GUI: no pipeline stage claims ${unstagedParams.join(', ')}; shown outside every stage folder`);
    }
  }

  /**
   * Construct one effect record without publishing or mounting it. Keeping the
   * old record live until this succeeds makes a schema rebuild atomic from the
   * panel's point of view.
   * @param {{initialPause?: boolean, hydratePause?: boolean,
   *   restoreAccepted?: boolean,
   *   previousParamNames?: Set<string>|null}} [options] - Rebuild state.
   * @returns {Object} A complete, unmounted effect record.
   */
  function createEffectRecord({
    initialPause = false,
    hydratePause = true,
    restoreAccepted = false,
    previousParamNames = null,
  } = {}) {
    const fx = {
      gui: createGui(),
      activeDragEnds: new Set(),
      animationPauseApplied: false,
      persistDeferred: false,
      warningsDirty: false,
    };

    try {
      if (restoreAccepted) restoreEffectState(fx.gui);
      const params = getParameterDefinitions();
      const reservedParams = params
        .filter((p) => RESERVED_CONTROL_NAMES.has(p.name))
        .map((p) => p.name);
      if (reservedParams.length > 0) {
        logWarn(`Engine parameter names conflict with effect controls: ${reservedParams.join(', ')}`);
      }
      // Stamp before controls are attached: URL replay can synchronously write
      // engine params and make this snapshot stale, which the next sync must see.
      fx.paramGeneration = paramGeneration();

      addEffectActions(fx, params);
      const pause = addPauseToggle(fx, params, initialPause, hydratePause);
      addParamControllers(fx, params, pause, previousParamNames);
      fx.pause = pause;
      return fx;
    } catch (error) {
      disposeEffect(fx);
      throw error;
    }
  }

  /**
   * Release one effect record without changing which record is published.
   * @param {Object|null} fx - Record to release.
   * @returns {void}
   */
  function disposeEffect(fx) {
    if (!fx?.gui) return;
    clearTimeout(fx.exportFlashTimer);
    fx.exportFlashTimer = null;
    if (fx.activeDragEnds) {
      for (const end of fx.activeDragEnds) {
        dragTarget.removeEventListener('pointerup', end);
        dragTarget.removeEventListener('pointercancel', end);
      }
      fx.activeDragEnds.clear();
    }
    const dom = fx.gui.domElement;
    if (dom?.parentNode) dom.parentNode.removeChild(dom);
    // Controller.destroy() removes each domElement from the GUI's own children
    // container; one left parented to the action row throws NotFoundError and
    // aborts destroy(), leaving the remaining controllers' listeners attached.
    for (const controller of fx.actionControllers ?? []) {
      fx.gui.appendElement(controller.domElement);
    }
    fx.actionControllers = [];
    fx.actionRow?.remove();
    fx.actionRow = null;
    try {
      fx.gui.destroy();
    } catch (e) {
      logWarn("GUI destroy warning:", e);
    }
  }

  function scrollElement(gui) {
    return gui?.domElement?.querySelector?.('.lil-children') ?? null;
  }

  /**
   * Every controller a rebuilt panel can hand keyboard focus back to, keyed by
   * the property it binds: the parameters, the pause toggle, the preset
   * selector, then the action row's buttons.
   * @param {Object|null} fx - An effect record, or null.
   * @returns {Array<[string, Object]>} Property/controller pairs.
   */
  function panelControllers(fx) {
    if (!fx) return [];
    const pairs = [...(fx.controllerByName ?? [])];
    if (fx.pauseController) pairs.push(['pause', fx.pauseController]);
    if (fx.preset?.controller) pairs.push(['presetIndex', fx.preset.controller]);
    for (const controller of fx.actionControllers ?? []) {
      pairs.push([controller.property, controller]);
    }
    return pairs;
  }

  /**
   * Which control holds keyboard focus. Discarding the focused control drops
   * focus to <body>, so a rebuild that renames nothing can still cost a full
   * document re-traverse to get back to the panel.
   * @param {Object|null} fx - The effect record about to be replaced.
   * @returns {string|null} The bound property, or null when focus is elsewhere.
   */
  function focusedControlProperty(fx) {
    const focused = focusedElement() ?? null;
    if (focused === null) return null;
    for (const [property, controller] of panelControllers(fx)) {
      if (controller.domElement?.contains(focused) === true) return property;
    }
    return null;
  }

  /**
   * Capture the panel's scroll offset and focused control ahead of a rebuild.
   * @param {Object|null} fx - The effect record about to be replaced.
   * @returns {{scrollTop: number, property: string|null}} The captured state.
   */
  function capturePanelFocus(fx) {
    return {
      scrollTop: scrollElement(fx?.gui)?.scrollTop ?? 0,
      property: focusedControlProperty(fx),
    };
  }

  /**
   * Re-seat a captured scroll offset and keyboard focus on the record that
   * replaced the captured one. A detached element cannot hold focus, so the
   * replacement must already be mounted.
   * @param {Object|null} fx - The record now published.
   * @param {{scrollTop: number, property: string|null}} captured - The state
   *   capturePanelFocus() returned.
   * @returns {void}
   */
  function restorePanelFocus(fx, captured) {
    const scroller = scrollElement(fx?.gui);
    if (scroller) scroller.scrollTop = captured.scrollTop;
    if (captured.property === null) return;
    for (const [property, controller] of panelControllers(fx)) {
      if (property !== captured.property) continue;
      focusWidget(controller)?.focus?.();
      return;
    }
  }

  /**
   * Replace a stale parameter schema without reloading the effect. Definitions
   * always come from the main engine; segmented workers only supply live values.
   * @returns {boolean} True when a replacement record was installed.
   */
  function rebuildSchema() {
    const previous = activeEffect;
    if (!previous) return false;

    const generation = paramGeneration();
    const wasMounted = Boolean(previous.gui?.domElement?.parentNode);
    const captured = capturePanelFocus(previous);
    const preservedPause = engineAnimationsPaused()
      ?? Boolean(previous.animationState?.pause);
    let next;
    try {
      next = createEffectRecord({
        initialPause: preservedPause,
        hydratePause: false,
        previousParamNames: new Set(previous.paramNames),
      });
    } catch (error) {
      if (rebuildFailureGeneration !== generation) {
        logWarn('Effect GUI: parameter-schema rebuild failed', error);
        rebuildFailureGeneration = generation;
      }
      return false;
    }

    // URL replay for newly revealed controls may itself pause the engine. Read
    // the actual state after all parameter callbacks, and update only the new
    // toggle model while it is still detached so preservation emits no write.
    const actualPause = engineAnimationsPaused() ?? preservedPause;
    next.pause.setPaused(actualPause);
    next.animationPauseApplied = previous.animationPauseApplied;

    disposeEffect(previous);
    activeEffect = next;
    rebuildFailureGeneration = undefined;
    skewLogged = false;
    if (wasMounted) {
      mountEffect(next);
      restorePanelFocus(next, captured);
    }
    return true;
  }

  /**
   * Mount one effect record in the current GUI container.
   * @param {Object} fx - Record to mount.
   * @returns {void}
   */
  function mountEffect(fx) {
    if (!fx?.gui) return;
    if (isMobile()) fx.gui.close();
    const container = guiContainer();
    if (!container) return;
    const dom = fx.gui.domElement;
    dom.classList.add('effect-gui');
    dom.classList.remove('global-gui');
    container.appendChild(dom);
  }

  return {
    /**
     * The live effect record, or null when no effect GUI is built.
     * @returns {Object|null} The active effect record.
     */
    active() { return activeEffect; },

    liveParamValues,
    sync,

    /**
     * Select a preset relative to the active one.
     * @param {number} delta - Signed preset offset.
     * @returns {boolean} Whether the preset was selected.
     */
    movePreset(delta) {
      return activeEffect?.movePreset?.(delta) ?? false;
    },

    /**
     * Commit the hydrated pause state after every renderer has rebuilt its
     * effect. Subsequent GUI transitions apply immediately.
     * @returns {void}
     */
    applyAnimationPause() {
      if (!activeEffect?.animationState) return;
      activeEffect.animationPauseApplied = true;
      setAnimationsPaused(Boolean(activeEffect.animationState.pause));
    },

    /**
     * Build the effect GUI for the engine's current effect and install it as the
     * active effect record.
     * @returns {void}
     */
    build() {
      activeEffect = createEffectRecord({ restoreAccepted: true });
      persistEffectState(activeEffect.gui);
      skewLogged = false;
    },

    /**
     * Mount the active effect GUI in the page's GUI container.
     * @returns {void}
     */
    mount() {
      mountEffect(activeEffect);
    },

    /**
     * Tear down the active effect GUI and clear the effect record. The drag's
     * pointerup/pointercancel listeners live on the drag target, not the GUI DOM,
     * so destroying the GUI mid-drag would leave them dangling — drain them first.
     * @returns {void}
     */
    destroy() {
      disposeEffect(activeEffect);
      activeEffect = null;
    },
  };
}
