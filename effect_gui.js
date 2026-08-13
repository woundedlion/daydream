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

function shaderBallControlLabel(stage, name) {
  if (SHADERBALL_STAGE_BOUNDARIES.has(name)) {
    if (stage === 'Colorize') return 'Palette';
    return stage === 'Camera' ? 'Wander' : 'Mode';
  }
  if (name.startsWith(`${stage} `)) return name.slice(stage.length + 1);
  if (stage === 'Projection Frame' && name.startsWith('Projection ')) {
    return name.slice('Projection '.length);
  }
  return name;
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
  const add = p.readonly || !persist
    ? (...args) => gui.addSession(...args)
    : hydrate && legacyNames.length > 0
        && typeof gui.addMigrated === 'function'
      ? (object, property, ...args) =>
          gui.addMigrated(object, property, legacyNames, ...args)
    : !hydrate && typeof gui.addUnhydrated === 'function'
      ? (...args) => gui.addUnhydrated(...args)
    : (...args) => gui.add(...args);
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
    controller.domElement.classList.add('param-warning');
    controller.domElement.setAttribute('title', p.warning);
    controller.domElement.setAttribute('aria-invalid', 'true');
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
 * @param {(params: Array<{name: string, value: number}>) => void}
 *   [deps.rememberWorkerAcceptedParams] - Retains accepted values needed when a
 *   worker rebuilds while the GUI holds a rejected request.
 * @param {() => void} [deps.resetWorkerAcceptedParams] - Clears accepted values
 *   belonging to the previous effect.
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
 * @param {(snapshot: Object) => boolean} [deps.restoreFullConfigSnapshot] -
 *   Atomically restores a captured state.
 * @param {() => string} [deps.getConfigImportNotice] - Reads a migration notice.
 * @param {() => void} [deps.clearConfigImportNotice] - Consumes that notice.
 * @param {(message: string|null) => void} [deps.showConfigImportNotice] - Shows
 *   or clears the migration notice.
 * @param {(message: string, error?: any) => void} [deps.logWarn] - Console sink.
 * @returns {{active: () => Object|null, liveParamValues: () => ArrayLike<number>|null,
 *   build: () => void, applyAnimationPause: () => void, mount: () => void,
 *   sync: () => void, destroy: () => void}}
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
  rememberWorkerAcceptedParams = () => {},
  resetWorkerAcceptedParams = () => {},
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
  restoreFullConfigSnapshot = () => false,
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
    if (!restoreFullConfigSnapshot(snapshot)) {
      logWarn('ShaderBall: full-config snapshot was rejected');
      return;
    }
    const notice = getConfigImportNotice();
    clearConfigImportNotice();
    showConfigImportNotice(notice || null);
  }

  function persistAcceptedParams(gui) {
    const acceptedParams = [];
    for (const parameter of getParameterDefinitions()) {
      if (parameter.readonly) continue;
      const accepted = parameter.acceptedValue
        ?? parameter.requestedValue ?? parameter.value;
      // The float form, not the raw value: restoreAcceptedParams() reads the
      // companion key back through the URL number grammar, which rejects a bool.
      const value = engineParamValue(accepted);
      acceptedParams.push({ name: parameter.name, value });
      gui?.writeStoredValue?.(acceptedStorageKey(parameter.name), value);
    }
    rememberWorkerAcceptedParams(acceptedParams);
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
   * @returns {void}
   */
  function adoptRequestedEnums(fx) {
    if (!fx.hasEnumControls) return;
    for (const parameter of getParameterDefinitions()) {
      const controller = fx.controllerByName.get(parameter.name);
      if (!controller?.isEnum) continue;
      const value = selectorControlValue(parameter);
      if (controller.getValue() === value) continue;
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
    if (paramGenerationStale(activeEffect.paramGeneration, paramGeneration())) {
      if (!rebuildSchema()) return;
    }
    if (!presetSynced) return;
    adoptPauseDisplay(activeEffect, engineAnimationsPaused());
    adoptPresetDisplay(activeEffect, presetCount, presetIndex);
    if (!activeEffect.hasParams) return;
    adoptRequestedEnums(activeEffect);

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
    // One focus read for the whole pass: at most one element has focus.
    const focused = focusedElement() ?? null;
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
    const actionRow = fx.gui.domElement.ownerDocument.createElement('div');
    actionRow.classList.add('effect-action-row');
    fx.gui.appendElement(actionRow);
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
      return controller;
    };

    /**
     * Flash a transient status label on the Export button, restoring the default
     * label after the flash window. Supersedes any flash still pending for this
     * GUI.
     * @param {string} label - The transient button label to show.
     * @returns {void}
     */
    const flashExport = (label) => {
      clearTimeout(fx.exportFlashTimer);
      presentAction(exportCtrl, label === EXPORT_COPIED ? '\u2713' : '\u2717', label);
      fx.exportFlashTimer = setTimeout(
        () => presentAction(exportCtrl, EXPORT_ICON, 'Export'), FLASH_MS);
    };

    const effectActions = {
      /**
       * Rebuild the effect GUI from the engine's current state, discarding edits.
       * @returns {void}
       */
      reset() { applyEffect(); },
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
          return;
        }
        persistEffectState(fx.gui);
        adoptPresetDisplay(fx, count, index);
        adoptPauseDisplay(fx, engineAnimationsPaused() ?? true);
      };
      preset.onChange(choose);
      const move = (delta) => {
        const count = getPresetCount();
        if (count <= 0) return;
        choose((getPresetIndex() + delta + count) % count);
      };
      effectActions.previousPreset = () => move(-1);
      effectActions.nextPreset = () => move(1);
      addAction(effectActions, 'previousPreset', PREVIOUS_ICON, 'Previous Preset',
        'preset-nav-previous');
      addAction(effectActions, 'nextPreset', NEXT_ICON, 'Next Preset',
        'preset-nav-next');
    }
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
    const stageAssignments = shaderBallStageAssignments(params);
    const stageFolders = new Map();
    if (stageAssignments) {
      for (const stage of SHADERBALL_STAGE_ORDER) {
        const addFolder = typeof fx.gui.addDisplayFolder === 'function'
          ? fx.gui.addDisplayFolder.bind(fx.gui)
          : fx.gui.addFolder.bind(fx.gui);
        stageFolders.set(stage, addFolder(stage));
      }
    }

    params.forEach(p => {
      state[p.name] = paramControlKind(p) === 'enum'
        ? selectorControlValue(p)
        : p.value;

      const stage = stageAssignments?.get(p.name);
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
      });
    });
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
   * Replace a stale parameter schema without reloading the effect. Definitions
   * always come from the main engine; segmented workers only supply live values.
   * @returns {boolean} True when a replacement record was installed.
   */
  function rebuildSchema() {
    const previous = activeEffect;
    if (!previous) return false;

    const generation = paramGeneration();
    const wasMounted = Boolean(previous.gui?.domElement?.parentNode);
    const scrollTop = scrollElement(previous.gui)?.scrollTop ?? 0;
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
      const scroller = scrollElement(next.gui);
      if (scroller) scroller.scrollTop = scrollTop;
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
      resetWorkerAcceptedParams();
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
