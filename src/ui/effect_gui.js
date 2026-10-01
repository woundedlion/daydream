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
} from "../effects/param_sync.js";
import { createEffectPersistence, acceptedParamValue } from '../effects/effect_persistence.js';
import { createEffectPanelView, focusWidget } from './effect_panel_view.js';
import { EffectPanelEdits } from './effect_panel_edits.js';
import { formatExportParams } from "../shared/export_params.js";
import {
  LATTICE_MELT_STAGE_ORDER,
  LATTICE_MELT_STAGE_TITLES,
  KALEIDOSCOPE_SMOOTH_STAGE_ORDER,
  KALEIDOSCOPE_SMOOTH_STAGE_TITLES,
  STAGE_ORDER,
  latticeMeltStageAssignments,
  kaleidoscopeSmoothStageAssignments,
  fixedShaderStageAssignments,
  stageControlLabel,
} from "../effects/shader_stages.js";

/** @typedef {{name: string, value: number|boolean, min: number, max: number, animated?: boolean, readonly?: boolean, warning?: string, options?: string[], step?: number, acceptedValue?: number|boolean, requestedValue?: number|boolean}} ParameterDefinition */
/** @typedef {import("./effect_panel_view.js").PanelController & Record<string, any>} GuiController */
/** @typedef {import("./effect_panel_view.js").PanelFolder & Record<string, any>} Gui */
/** @typedef {Record<string, any> & {gui: Gui, pause: {animationState: {pause: boolean}, controller: GuiController|null, setPaused: (value: boolean) => void}, paramNames: string[], controllerByName: Map<string, GuiController>}} EffectRecord */

// How long a transient button label (Export status) stays before reverting.
export const FLASH_MS = 1500;
// Transient Export button labels.
export const EXPORT_COPIED = '\u2713 Copied!';
export const EXPORT_FAILED = '\u2717 Copy failed';
const EXPORT_ICON = '\u29c9';
const RESET_ICON = '\u21ba';
const PREVIOUS_ICON = '\u25c0';
const NEXT_ICON = '\u25b6';
const RESERVED_CONTROL_NAMES = new Set(['pause']);

/**
 * The id one parameter's warning text is published under, for the control's
 * aria-describedby to name.
 * @param {string} name - Engine parameter name.
 * @returns {string} The element id.
 */
function paramWarningId(name) {
  return `param-warning-${encodeURIComponent(name)}`;
}

/**
 * The warning text the engine publishes for each parameter that carries one.
 * @param {Array<ParameterDefinition>} params - Engine parameter definitions.
 * @returns {Map<string, string>} Parameter name to warning text.
 */
function paramWarningTexts(params) {
  return new Map(params.filter((p) => p.warning).map((p) => [p.name, /** @type {string} */ (p.warning)]));
}

/**
 * The `gui` method a parameter's control is added through: a session control
 * owns no deep-link key, and an unhydrated one owns its key without URL seeding.
 * @param {Gui} gui - The effect GUI to add to.
 * @param {ParameterDefinition} p - The parameter definition.
 * @param {boolean} hydrate - Whether a matching deep link may seed it.
 * @param {boolean} persist - Whether the control owns a deep-link key.
 * @returns {(object: Record<string, any>, property: string, ...rest: Array<*>) => GuiController}
 */
function paramAddMethod(gui, p, hydrate, persist) {
  if (p.readonly || !persist) return (...args) => gui.addSession(...args);
  if (!hydrate) return (...args) => gui.addUnhydrated(...args);
  return (...args) => gui.add(...args);
}

/**
 * Decimal places a bounded slider must print to resolve one step of its own
 * range. lil-gui steps a bounded control by span/1000 and its arrow-key
 * increment() re-parses the *displayed* string, so a display coarser than the
 * step prints consecutive steps identically and quantizes the live value.
 * @param {number} min - Range floor.
 * @param {number} max - Range ceiling.
 * @returns {number} Decimals for the controller's decimals().
 */
export function sliderDecimals(min, max) {
  const step = Math.abs(max - min) / 1000;
  if (!(step > 0) || !Number.isFinite(step)) return 3;
  return Math.max(0, Math.min(20, Math.ceil(-Math.log10(step) - 1e-9)));
}

/**
 * Add the lil-gui control one engine parameter definition calls for. A readonly
 * (engine-written telemetry) param becomes a session control: the engine refuses
 * to set it, so seeding it from a URL and writing it back is meaningless.
 * @param {Gui} gui - The effect GUI to add to.
 * @param {Record<string, any>} state - The GUI-bound value object.
 * @param {ParameterDefinition} p - The parameter definition.
 * @param {boolean} [hydrate=true] - Whether a matching deep link may seed it.
 * @param {boolean} [persist=true] - Whether the control owns a deep-link key.
 * @returns {GuiController} The created controller.
 */
export function addParamControl(
  gui, state, p, hydrate = true, persist = true) {
  const kind = paramControlKind(p);
  const add = paramAddMethod(gui, p, hydrate, persist);
  let controller;
  if (kind === 'boolean') {
    controller = add(state, p.name);
  } else if (kind === 'enum') {
    // Dropdown of labels whose values are the option indices the engine expects.
    controller = add(state, p.name, enumChoices(p.options ?? []));
  } else if (kind === 'integer') {
    // The engine truncates a fractional write, so offer only what it can hold.
    controller = add(state, p.name, p.min, p.max, 1).decimals(0);
  } else {
    controller = add(state, p.name, p.min, p.max)
      .decimals(sliderDecimals(p.min, p.max));
  }
  controller.isBoolean = (kind === 'boolean');
  controller.isEnum = (kind === 'enum');
  controller.enumOptions = p.options;
  controller.isContinuous = (kind === 'number' || kind === 'integer');
  if (p.warning) {
    const widget = focusWidget(controller) ?? controller.domElement;
    const note = controller.domElement.ownerDocument.createElement('span');
    note.id = paramWarningId(p.name);
    note.className = 'param-warning-note';
    note.textContent = p.warning;
    controller.domElement.appendChild(note);
    controller.domElement.classList.add('param-warning');
    widget.setAttribute('aria-invalid', 'true');
    widget.setAttribute('aria-describedby', note.id);
  }
  return controller;
}

const ENGINE_MEMBERS = [
  'getParameterDefinitions', 'paramGeneration', 'paramValues', 'setParam',
  'setAnimationsPaused', 'animationsPaused', 'getPresetCount', 'getPresetIndex',
  'synchronizePreset', 'selectPreset',
];
const SEGMENT_MEMBERS = ['ownsDisplay', 'paramValues', 'setParam'];
const HOST_MEMBERS = ['createGui', 'container', 'isMobile', 'applyEffect'];
const CONFIG_DEFAULTS = {
  inUse: () => false,
  snapshot: () => null,
  restore: () => null,
  restoreResults: () => ({}),
  showImportNotice: () => {},
};
const HOST_DEFAULTS = {
  focusedElement: () => null,
  paramFilter: () => null,
  /** @param {...any} args */
  logWarn: (...args) => console.warn(...args),
};

/**
 * Fill a collaborator group's absent members in and check that every member the
 * panel will call is callable.
 * @param {string} group - Group name, which a fault message names.
 * @template {Record<string, any>} T
 * @template {Record<string, any>} D
 * @param {T|undefined} members - What the caller passed for the group.
 * @param {Array<string>} required - Members with no stand-in.
 * @param {D} [defaults] - Members that stand in when absent.
 * @returns {T & D} The filled group.
 * @throws {TypeError} On a group that is not an object, or a member that is not
 *   a function.
 */
function checkedGroup(group, members, required, defaults = /** @type {D} */ ({})) {
  if (members === null || typeof members !== 'object') {
    throw new TypeError(`createEffectGui: the ${group} collaborator is missing.`);
  }
  const filled = { ...defaults, ...members };
  for (const name of [...required, ...Object.keys(defaults)]) {
    if (typeof filled[name] !== 'function') {
      throw new TypeError(`createEffectGui: ${group}.${name} must be a function.`);
    }
  }
  return /** @type {T & D} */ (filled);
}

/**
 * Build the effect GUI controller for the app's active effect.
 *
 * The four collaborators are checked once here, so a mis-wired page fails where
 * it is composed rather than at the first frame that happens to call the slot.
 *
 * @param {Object} deps - Injected app collaborators, in four groups.
 * @param {(error?: *) => boolean} [deps.moduleDead] - Whether the engine module is unusable.
 * @param {Object} deps.engine - The main engine the panel reads and writes.
 * @param {() => Array<ParameterDefinition>} deps.engine.getParameterDefinitions - Reads the
 *   parameter definitions for the effect the engine currently has loaded.
 * @param {() => number|undefined} deps.engine.paramGeneration - Reads the
 *   effect-load generation, stamped onto each definitions snapshot.
 * @param {() => ArrayLike<number>|null} deps.engine.paramValues - The engine's
 *   per-frame value stream.
 * @param {(name: string, value: number) => boolean} deps.engine.setParam - Writes
 *   one parameter and reports acceptance.
 * @param {(paused: boolean) => void} deps.engine.setAnimationsPaused -
 *   Freezes/resumes animation-driven params on every engine.
 * @param {() => boolean|undefined} deps.engine.animationsPaused - Reads the
 *   animation-pause state, undefined on a module without the accessor.
 * @param {() => number} deps.engine.getPresetCount - Number of presets on the
 *   live effect.
 * @param {() => number} deps.engine.getPresetIndex - Selected preset on the live
 *   effect.
 * @param {(index: number) => boolean} deps.engine.synchronizePreset - Mirrors a
 *   live worker preset into the engine that owns GUI parameter definitions.
 * @param {(index: number) => boolean} deps.engine.selectPreset - Selects one
 *   preset on every engine.
 *
 * @param {Object} deps.segments - The worker pool, which may own the display.
 * @param {() => boolean} deps.segments.ownsDisplay - Whether the pool owns the
 *   display, making its values (not the idle main engine's) the live ones.
 * @param {() => ArrayLike<number>|null} deps.segments.paramValues - The pool's
 *   per-frame value stream.
 * @param {(name: string, value: number) => void} deps.segments.setParam - Writes
 *   one parameter to the pool.
 *
 * @param {Object} [deps.config] - The exhaustive versioned snapshot API some
 *   effects persist through. Absent leaves the panel on the per-parameter
 *   accepted-value surface.
 * @param {() => boolean} [deps.config.inUse] - Whether the active effect
 *   persists through the snapshot API.
 * @param {() => {accepted: number[]}|null} [deps.config.snapshot] - Captures that state.
 * @param {(snapshot: Object) => unknown} [deps.config.restore] - Atomically
 *   restores a captured state, returning one ChainSnapshotRestoreResult value.
 * @param {() => Record<string, unknown>} [deps.config.restoreResults] - The
 *   engine's ChainSnapshotRestoreResult enum, which that value is judged against by
 *   identity.
 * @param {(message: string|null) => void} [deps.config.showImportNotice] - Shows
 *   or clears the snapshot notice.
 *
 * @param {Object} deps.host - The page the panel mounts into.
 * @param {() => Gui} deps.host.createGui - Makes an empty effect GUI root: a
 *   DeepLinkGUI (gui.js), whose whole add/stored-value surface the panel uses.
 * @param {() => Object|null} deps.host.container - The element the panel mounts in.
 * @param {() => boolean} deps.host.isMobile - Whether to mount the panel collapsed.
 * @param {((text: string) => Promise<boolean>)|null} deps.host.copyText - Copies text
 *   using the browser's available clipboard path, null where there is none.
 * @param {() => void} deps.host.applyEffect - Rebuilds the panel from engine
 *   state (the Reset button).
 * @param {EventTarget}
 *   deps.host.dragTarget - Where the drag-end listeners live (the window): a
 *   lil-gui drag continues outside the control's own DOM.
 * @param {() => Node|null} [deps.host.focusedElement] - The document's focused
 *   element. A control whose number input has focus is being typed into, so the
 *   per-frame value stream must leave it alone.
 * @param {() => {external: true}|null} [deps.host.paramFilter] - The chain
 *   editor's marker that the active effect's parameters are rendered outside
 *   this panel, on the pipeline strip's chips: when non-null, the panel builds
 *   no parameter controls, though every parameter still claims its value-stream
 *   slot. A change is detected in sync() and rebuilds the panel.
 * @param {(message: string, error?: any) => void} [deps.host.logWarn] - Console sink.
 * @returns {{active: () => Object|null, liveParamValues: () => ArrayLike<number>|null,
 *   movePreset: (delta: number) => boolean, build: () => void,
 *   applyAnimationPause: () => void, mount: () => void,
 *   sync: (advanced?: boolean) => void,
 *   destroy: () => void}}
 * @throws {TypeError} On a missing collaborator or an uncallable member.
 */
export function createEffectGui({ engine, segments, config, host, moduleDead = () => false }) {
  const {
    getParameterDefinitions, paramGeneration, setAnimationsPaused, getPresetCount,
    getPresetIndex, synchronizePreset, selectPreset,
    paramValues: engineParamValues, setParam: setEngineParam,
    animationsPaused: engineAnimationsPaused,
  } = checkedGroup('engine', engine, ENGINE_MEMBERS);
  const {
    ownsDisplay: segmentsOwnDisplay, paramValues: segmentParamValues,
    setParam: setWorkerParam,
  } = checkedGroup('segments', segments, SEGMENT_MEMBERS);
  const {
    inUse: usesChainSnapshot, snapshot: getSnapshot,
    restore: restoreSnapshot, restoreResults: chainSnapshotRestoreResults,
    showImportNotice: showConfigImportNotice,
  } = checkedGroup('config', config ?? {}, [], CONFIG_DEFAULTS);
  const {
    createGui, container: guiContainer, isMobile, dragTarget, copyText,
    applyEffect, focusedElement, paramFilter, logWarn,
  } = checkedGroup('host', host, HOST_MEMBERS, HOST_DEFAULTS);
  if (typeof dragTarget?.addEventListener !== 'function'
      || typeof dragTarget?.removeEventListener !== 'function') {
    throw new TypeError('createEffectGui: host.dragTarget must be an event target.');
  }
  /** @type {EffectRecord|null} */
  let activeEffect = null;
  // Throttle the param/value length-skew warning to once per skew episode.
  let skewLogged = false;
  // The unstaged-parameter set last warned about. A panel rebuilds on every
  // warning move and every preset, all over the same schema.
  let unstagedWarned = '';
  /** @type {string|undefined} */
  let rebuildFailureGeneration;
  const persistence = createEffectPersistence({
    getParameterDefinitions, setEngineParam, usesChainSnapshot, getSnapshot, restoreSnapshot, chainSnapshotRestoreResults, showConfigImportNotice, logWarn
  });
  const view = createEffectPanelView({ focusedElement, guiContainer, isMobile });
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
   * an effect, so the schema generation cannot report it. Deferred while an
   * edit is in flight, pointer or keyboard: the rebuild would discard the
   * controller under the pointer, or the input a held arrow key repeats into.
   * @param {EffectRecord} fx - The active effect record.
   * @returns {boolean} True when the panel must be rebuilt to show them.
   */
  function paramWarningsStale(fx) {
    if (!fx.warningsDirty || fx.edits.active) {
      return false;
    }
    fx.warningsDirty = false;
    const current = paramWarningTexts(getParameterDefinitions());
    if (current.size !== fx.paramWarnings.size) return true;
    for (const [name, warning] of current) {
      if (fx.paramWarnings.get(name) !== warning) return true;
    }
    return false;
  }

  /** Update the pause controller without writing back to the engine. */
  /** @param {EffectRecord} fx @param {boolean|undefined} paused */
  function adoptPauseDisplay(fx, paused) {
    if (paused === undefined || paused === fx.pause.animationState.pause) return;
    fx.pause.animationState.pause = paused;
    fx.pause.controller?.updateDisplay();
    fx.gui.writeStoredValue('pause', paused);
  }

  /** Update the preset controller and its visibility from live engine state. */
  /** @param {EffectRecord} fx @param {number} count @param {number} index */
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
   * @param {EffectRecord} fx - The active effect record.
   * @param {Node|null} focused - The document's focused element, or null. An
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
   * @param {boolean} [advanced] - Whether the simulation stepped this frame.
   *   Only the enum-definition marshal is gated on it; every other caller wants
   *   the full pass and leaves it defaulted.
   * @returns {void}
   */
  function sync(advanced = true) {
    if (!activeEffect || !activeEffect.controllerByName) return;
    const presetIndex = activeEffect.preset ? getPresetIndex() : null;
    const presetAdvanced = activeEffect.preset
      && activeEffect.preset.state.presetIndex !== presetIndex;
    const presetSynced = !activeEffect.preset || synchronizePreset(/** @type {number} */ (presetIndex));
    const filterStale =
      (paramFilter() !== null) !== (activeEffect.paramsExternal === true);
    const warningsStale = paramWarningsStale(activeEffect);
    if (warningsStale) rebuildFailureGeneration = undefined;
    if (paramGenerationStale(activeEffect.paramGeneration, paramGeneration())
        || warningsStale || filterStale) {
      if (!rebuildSchema()) return;
    }
    if (!presetSynced) return;
    adoptPauseDisplay(activeEffect, engineAnimationsPaused());
    if (activeEffect.preset) adoptPresetDisplay(activeEffect, getPresetCount(), getPresetIndex());
    if (!activeEffect.hasParams) return;
    // One focus read for the whole pass: at most one element has focus.
    const focused = focusedElement() ?? null;
    // getParameterDefinitions() marshals the whole definition array, which is
    // the panel's one per-frame allocation. Only an engine-driven selector moves
    // its requested value on its own; every other source of one — a control, a
    // preset, a rebuild — re-seats the selectors itself.
    if (!segmentsOwnDisplay() && advanced && activeEffect.hasEnumControls
        && (activeEffect.hasAnimatedEnums || presetAdvanced)) {
      adoptRequestedEnums(activeEffect, focused);
    }

    const values = liveParamValues();
    if (!values || values.length === 0) return;

    const names = activeEffect.paramNames;
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
      if (c.isEnum && !segmentsOwnDisplay()) continue;
      const liveValue = c.isEnum
        ? selectorControlValue({ value: values[i], options: c.enumOptions })
        : values[i];

      const isEditing = c.dragging
        || (focused !== null && c.domElement?.contains(focused) === true);

      const { update, value } = resolveParamSync(
        c.getValue(), liveValue, c.isBoolean, isEditing);
      if (!update) continue;
      c.object[c.property] = value;
      c.updateDisplay();
    }
  }

  /**
   * Copy text to the clipboard and report the outcome on the Export label.
   * @param {EffectRecord} fx - The effect record owning the Export button. A copy that
   *   lands after the effect changed reports nothing: the label belongs to a
   *   panel that is gone.
   * @param {string} text - The text to copy.
   * @param {(label: string) => void} flashExport - Shows a transient Export label.
   * @returns {Promise<void>} Clipboard completion.
   */
  function copyAndFlash(fx, text, flashExport) {
    return /** @type {(text: string) => Promise<boolean>} */ (copyText)(text).then((copied) => {
      if (activeEffect !== fx) return;
      if (copied) {
        flashExport(EXPORT_COPIED);
      } else {
        logWarn('Export: clipboard copy failed');
        flashExport(EXPORT_FAILED);
      }
    }).catch((err) => {
      logWarn('Export: clipboard copy failed', err);
      if (activeEffect === fx) flashExport(EXPORT_FAILED);
    });
  }

  /**
   * Copy typed parameters as a C++ brace-init list, or the full config as JSON.
   * @param {EffectRecord} fx - The effect record owning the Export button.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @param {(label: string) => void} flashExport - Shows a transient Export label.
   * @returns {Promise<void>|void} Clipboard completion, or nothing when blocked.
   */
  function exportParams(fx, params, flashExport) {
    if (usesChainSnapshot()) {
      const snapshot = getSnapshot();
      if (!snapshot) {
        logWarn('Export: Shader Workbench chain snapshot is unavailable');
        flashExport(EXPORT_FAILED);
        return;
      }
      if (typeof copyText !== 'function') {
        logWarn('Export: clipboard copy unavailable');
        flashExport(EXPORT_FAILED);
        return;
      }
      return copyAndFlash(fx, JSON.stringify(snapshot, null, 2), flashExport);
    }
    let values = liveParamValues();
    if ((!values || values.length === 0) && !fx.paramsExternal
        && !paramGenerationStale(fx.paramGeneration, paramGeneration())) {
      values = fx.paramNames.map((name) =>
        engineParamValue(fx.controllerByName.get(name)?.getValue()));
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
      text = formatExportParams(params, /** @type {ArrayLike<number>} */ (values));
    } catch (err) {
      logWarn('Export: parameter formatting failed', err);
      flashExport(EXPORT_FAILED);
      return;
    }

    return copyAndFlash(fx, text, flashExport);
  }

  /**
   * Add the effect GUI's Reset, Export, and preset navigation buttons.
   * @param {EffectRecord} fx - The effect record being built.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @returns {void}
   */
  function addEffectActions(fx, params) {
    const ownerDocument = fx.gui.domElement.ownerDocument;
    const actionRow = ownerDocument.createElement('div');
    actionRow.classList.add('effect-action-row');
    fx.gui.appendElement(actionRow);
    fx.actionRow = actionRow;
    const exportStatus = ownerDocument.createElement('span');
    exportStatus.className = 'visually-hidden';
    exportStatus.setAttribute('role', 'status');
    exportStatus.setAttribute('aria-live', 'polite');
    actionRow.appendChild(exportStatus);
    fx.actionControllers = [];
    /** @param {GuiController} controller @param {string} icon @param {string} label */
    const presentAction = (controller, icon, label) => {
      controller.name(icon);
      const button = controller.$button ?? controller.domElement;
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    };
    /** @param {Record<string, any>} actions @param {string} property @param {string} icon @param {string} label @param {string} className */
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
      // A changed live-region string re-announces repeated messages.
      exportStatus.textContent = exportStatus.textContent === label
        ? `${label}\u200B` : label;
      fx.exportFlashTimer = setTimeout(() => {
        presentAction(exportCtrl, EXPORT_ICON, 'Export');
        exportStatus.textContent = '';
      }, FLASH_MS);
    };

    /** @type {{reset: () => void, export: () => Promise<void>|void, presetIndex?: number, previousPreset?: () => boolean, nextPreset?: () => boolean}} */
    const effectActions = {
      /**
       * Rebuild the effect GUI from the engine's current state, discarding
       * edits. The rebuild discards the panel this button lives in, so the
       * keyboard focus and scroll offset are carried across it.
       * @returns {void}
       */
      reset() {
        const captured = view.capture(fx);
        view.rebuild(captured.closed, applyEffect);
        view.restore(activeEffect, captured);
      },
      /**
       * Copy typed parameters as a C++ brace-init list, or the full config as
       * JSON, then flash the outcome on the Export button.
       * @returns {Promise<void>|void} Clipboard completion, or nothing when blocked.
       */
      export() { return exportParams(fx, params, flashExport); }
    };
    addAction(effectActions, 'reset', RESET_ICON, 'Reset', 'effect-action-reset');
    const exportCtrl = addAction(
      effectActions, 'export', EXPORT_ICON, 'Export', 'effect-action-export');
    const presetCount = getPresetCount();
    if (presetCount > 0) {
      effectActions.presetIndex = getPresetIndex();
      const presetOptions = enumChoices(
        Array.from({ length: presetCount }, (_, index) => String(index + 1)));
      const preset = fx.gui
        .addSession(effectActions, 'presetIndex', presetOptions)
        .name('Preset');
      fx.preset = { state: effectActions, controller: preset };
      /** @param {number} index */
      const choose = (index) => {
        const count = getPresetCount();
        if (count <= 0 || !selectPreset(index)) {
          adoptPresetDisplay(fx, count, getPresetIndex());
          return false;
        }
        fx.warningsDirty = true;
        if (!usesChainSnapshot()) {
          for (const parameter of getParameterDefinitions()) {
            if (!parameter.readonly) fx.gui.writeStoredValue(parameter.name, null);
          }
        }
        persistence.persist(fx.gui);
        adoptPresetDisplay(fx, count, index);
        adoptPauseDisplay(fx, engineAnimationsPaused() ?? true);
        adoptRequestedEnums(fx, focusedElement() ?? null);
        return true;
      };
      preset.onChange(choose);
      /** @param {number} delta */
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
      actionRow.appendChild(preset.domElement);
      fx.actionControllers.push(preset);
      addAction(effectActions, 'nextPreset', NEXT_ICON, 'Next Preset',
        'preset-nav-next');
    }
    actionRow.style.gridTemplateColumns =
      `repeat(${fx.actionControllers.length}, minmax(0, 1fr))`;
  }

  /**
   * Add the "Pause Animation" toggle when the effect has an animated param or
   * multiple presets available for manual selection.
   * @param {EffectRecord} fx - The effect record being built.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @param {boolean} [initialPause=false] - Initial pause state.
   * @param {boolean} [hydrate=true] - Read the stored pause value while constructing the toggle.
   * @returns {{animationState: {pause: boolean}, controller: GuiController|null,
   *   setPaused: (v: boolean) => void}} The toggle's state, its controller (null
   *   when neither animation surface is available), and its state transition.
   */
  function addPauseToggle(fx, params, initialPause = false, hydrate = true) {
    const animationState = { pause: Boolean(initialPause) };
    /** @type {GuiController|null} */
    let controller = null;
    /**
     * Adopt a pause transition, applying it immediately after initial hydration
     * has been committed to the rebuilt renderers.
     * @param {boolean} v - True to freeze animations, false to resume.
     * @returns {void}
     */
    const transitionPaused = (v) => {
      animationState.pause = Boolean(v);
      if (fx.animationPauseApplied) setAnimationsPaused(animationState.pause);
    };
    /** @param {boolean} v */
    const setPaused = (v) => {
      const paused = Boolean(v);
      if (controller) {
        controller.setValue(paused);
      } else {
        transitionPaused(paused);
      }
    };
    if (params.some(p => p.animated) || getPresetCount() > 0) {
      const add = hydrate
        ? (/** @type {any[]} */ ...args) => fx.gui.add(...args)
        : (/** @type {any[]} */ ...args) => fx.gui.addUnhydrated(...args);
      controller = add(animationState, 'pause').name('Pause Animation');
      controller?.onChange(transitionPaused);
    }
    return { animationState, controller, setPaused };
  }

  /**
   * Re-seat the pause toggle on the engine's own animation state after a
   * parameter write: the engine pauses animation-driven params implicitly when
   * one of them is written. The toggle's transition carries the adopted state on
   * to the worker pool, whose engines each keep their own copy.
   * @param {{animationState: {pause: boolean}, controller: GuiController|null,
   *   setPaused: (v: boolean) => void}} pause - The effect's pause toggle.
   * @param {ParameterDefinition} written - The definition of the parameter just written.
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
   * Pick the pipeline grouping for a parameter list. Each recognizer owns its
   * stage assignments, folder titles, and folder order together, so the three
   * cannot disagree; the first that claims the list wins.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @returns {{assignments: Map<string, string>, titles: Map<string, string>|null,
   *   order: Array<string>}|null} The grouping, or null when none claims the list.
   */
  function stageGrouping(params) {
    const fixedShader = fixedShaderStageAssignments(params);
    const fixedGrouping = () => {
      const claimed = new Set(fixedShader?.values());
      return {
        assignments: /** @type {Map<string, string>} */ (fixedShader),
        titles: null,
        order: STAGE_ORDER.filter((stage) => claimed.has(stage)),
      };
    };
    const latticeMelt = latticeMeltStageAssignments(params);
    if (latticeMelt) {
      return {
        assignments: latticeMelt,
        titles: LATTICE_MELT_STAGE_TITLES,
        order: LATTICE_MELT_STAGE_ORDER,
      };
    }
    const kaleidoscopeSmooth = kaleidoscopeSmoothStageAssignments(params);
    if (kaleidoscopeSmooth) {
      return {
        assignments: kaleidoscopeSmooth,
        titles: KALEIDOSCOPE_SMOOTH_STAGE_TITLES,
        order: KALEIDOSCOPE_SMOOTH_STAGE_ORDER,
      };
    }
    return fixedShader ? fixedGrouping() : null;
  }

  /**
   * Present an engine-written telemetry control. `disabled` would take it out of
   * the accessibility tree and the tab order, so the value the control exists to
   * show could not be read at all; read-only leaves it reachable and inert.
   * @param {GuiController} controller - The controller to present.
   * @returns {void}
   */
  function presentReadonlyParam(controller) {
    controller.domElement.classList.add('param-readonly');
    controller.domElement.addEventListener('keydown', (/** @type {KeyboardEvent} */ event) => {
      if (typeof event.key === 'string' && ((controller.$select && event.key.length === 1
          && !event.ctrlKey && !event.metaKey && !event.altKey) || event.key.startsWith('Arrow')
          || [' ', 'Enter', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    controller.domElement.addEventListener('click', (/** @type {Event} */ event) => {
      event.preventDefault();
      event.stopPropagation();
    }, true);
    controller.domElement.addEventListener('change', (/** @type {Event} */ event) => {
      event.stopPropagation();
      controller.updateDisplay();
    }, true);
    const widget = focusWidget(controller) ?? controller.domElement;
    widget.setAttribute('aria-readonly', 'true');
    widget.setAttribute('readonly', 'readonly');
  }

  /**
   * Label one control inside its stage folder. The folder title already carries
   * the stage, so the visible label drops it, and the truncated labels repeat
   * across folders — "Mode" once per stage — so the widget takes the parameter's
   * own name as its accessible name instead of the shared visible one.
   * @param {GuiController} controller - The stage folder's controller.
   * @param {string} stage - The pipeline stage it was grouped under.
   * @param {string} name - Engine parameter name.
   * @returns {void}
   */
  function nameStageControl(controller, stage, name) {
    controller.name(stageControlLabel(stage, name));
    const widget = focusWidget(controller);
    if (!widget) return;
    widget.removeAttribute('aria-labelledby');
    widget.setAttribute('aria-label', name);
  }

  /**
   * Build one controller per engine parameter, recording the value-stream order.
   * A ?param=value deep link reaches the engine through the GUI's load-time
   * onChange replay.
   * @param {EffectRecord} fx - The effect record being built.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @param {{animationState: {pause: boolean}, controller: GuiController|null, setPaused: (value: boolean) => void}}
   *   pause - The effect's pause toggle.
   * @param {Set<string>|null} [previousParamNames=null] - Names present before a schema rebuild.
   * @returns {void}
   */
  function addParamControllers(fx, params, pause, previousParamNames = null) {
    /** @type {Record<string, number|boolean>} */
    const state = {};
    const external = paramFilter() !== null;
    // Fixed for the schema this build is committed to: no parameter write adds
    // or drops a stage selector.
    const persistParamKeys = !usesChainSnapshot();
    fx.paramNames = [];
    fx.writableParamNames = [];
    fx.controllerByName = new Map();
    fx.hasParams = !external && params.length > 0;
    fx.hasEnumControls = false;
    fx.hasAnimatedEnums = false;
    fx.paramWarnings = paramWarningTexts(params);
    fx.paramsExternal = external;
    const grouping = external ? null : stageGrouping(params);
    const stageAssignments = grouping?.assignments ?? null;
    const stageTitles = grouping?.titles ?? null;
    const stageOrder = grouping?.order ?? [];
    const unstagedParams = stageAssignments
      ? params.filter((parameter) => !stageAssignments.has(parameter.name))
        .map((parameter) => parameter.name)
      : [];
    const unstaged = unstagedParams.join(', ');
    if (unstaged !== '' && unstaged !== unstagedWarned) {
      logWarn(`Effect GUI: no pipeline stage claims ${unstaged}`);
    }
    unstagedWarned = unstaged;
    const stageFolders = new Map();
    if (stageAssignments) {
      for (const stage of stageOrder) {
        stageFolders.set(
          stage, fx.gui.addDisplayFolder(stageTitles?.get(stage) ?? stage));
      }
    }
    fx.stageFolders = stageFolders;

    params.forEach(p => {
      // External controls still occupy slots in the positional value stream.
      if (external) {
        fx.paramNames.push(p.name);
        return;
      }
      state[p.name] = paramControlKind(p) === 'enum'
        ? selectorControlValue(p)
        : p.value;

      const stage = stageAssignments?.get(p.name);
      const controlGui = stage ? stageFolders.get(stage) : fx.gui;
      const controller = addParamControl(
        controlGui, state, p, !previousParamNames?.has(p.name),
        persistParamKeys);
      if (stage) nameStageControl(controller, stage, p.name);
      fx.paramNames.push(p.name);
      fx.controllerByName.set(p.name, controller);
      if (controller.isEnum) {
        fx.hasEnumControls = true;
        if (p.animated) fx.hasAnimatedEnums = true;
      }

      if (p.readonly) {
        presentReadonlyParam(controller);
        return;
      }
      fx.writableParamNames.push(p.name);
      if (controller.isContinuous) fx.edits.trackDrag(controller);
      fx.edits.trackKeyboard(controller);

      const kind = paramControlKind(p);
      let acceptedControlValue = acceptedParamValue(p);
      if (kind === 'boolean') {
        acceptedControlValue = engineParamValue(acceptedControlValue) > 0.5;
      }
      controller.onChange((/** @type {number|boolean} */ v) => {
        const value = engineParamValue(v);
        const accepted = setEngineParam(p.name, value) !== false;
        if (accepted) acceptedControlValue = v;
        controller.acceptUrlValue?.(acceptedControlValue);
        const edited = { name: p.name, accepted: acceptedControlValue };
        fx.edits.persist(controller, edited);
        if (accepted) setWorkerParam(p.name, value);
        if (!fx.hydrating) adoptEnginePause(pause, p);
        fx.warningsDirty = true;
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
   * @returns {EffectRecord} A complete, unmounted effect record.
   */
  function createEffectRecord({
    initialPause = false,
    hydratePause = true,
    restoreAccepted = false,
    previousParamNames = null,
  } = {}) {
    const fx = /** @type {EffectRecord} */ (/** @type {unknown} */ ({
      gui: createGui(),
      animationPauseApplied: false,
      hydrating: true,
      warningsDirty: false,
    }));

    fx.edits = new EffectPanelEdits(dragTarget, (edited) => persistence.persist(fx.gui, edited));

    try {
      if (restoreAccepted) persistence.restore(fx.gui);
      const params = getParameterDefinitions();
      const reservedParams = params
        .filter((p) => RESERVED_CONTROL_NAMES.has(p.name))
        .map((p) => p.name);
      if (reservedParams.length > 0) {
        logWarn(`Engine parameter names conflict with effect controls: ${reservedParams.join(', ')}`);
      }
      // URL hydration can advance the generation while attaching controls.
      fx.paramGeneration = paramGeneration();

      addEffectActions(fx, params);
      const pause = addPauseToggle(fx, params, initialPause, hydratePause);
      addParamControllers(fx, params, pause, previousParamNames);
      fx.pause = pause;
      fx.hydrating = false;
      return fx;
    } catch (error) {
      disposeEffect(fx);
      throw error;
    }
  }

  /**
   * Release one effect record without changing which record is published,
   * flushing the persistence an in-flight drag deferred.
   * @param {EffectRecord|null} fx - Record to release.
   * @returns {void}
   */
  function disposeEffect(fx) {
    if (!fx?.gui) return;
    clearTimeout(fx.exportFlashTimer);
    fx.exportFlashTimer = null;
    fx.edits.dispose();
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

  /**
   * Replace a stale parameter schema without reloading the effect. Definitions
   * always come from the main engine; segmented workers only supply live values.
   * @returns {boolean} True when a replacement record was installed.
   */
  function rebuildSchema() {
    const previous = activeEffect;
    if (!previous) return false;

    const generation = `${paramGeneration()}:${paramFilter() !== null}`;
    if (rebuildFailureGeneration === generation) return false;
    const wasMounted = Boolean(previous.gui?.domElement?.parentNode);
    const captured = view.capture(previous);
    const preservedPause = engineAnimationsPaused()
      ?? Boolean(previous.pause.animationState.pause);
    let next;
    try {
      next = createEffectRecord({
        initialPause: preservedPause,
        hydratePause: false,
        previousParamNames: new Set(previous.paramNames),
      });
    } catch (error) {
      if (moduleDead(error)) throw error;
      if (rebuildFailureGeneration !== generation) {
        logWarn('Effect GUI: parameter-schema rebuild failed', error);
        showConfigImportNotice('Effect controls could not be rebuilt.');
        rebuildFailureGeneration = generation;
      }
      return false;
    }

    const actualPause = engineAnimationsPaused() ?? preservedPause;
    next.pause.setPaused(actualPause);
    next.animationPauseApplied = previous.animationPauseApplied;

    disposeEffect(previous);
    activeEffect = next;
    rebuildFailureGeneration = undefined;
    skewLogged = false;
    if (wasMounted) {
      view.mount(next, captured.closed);
      view.restore(next, captured);
    }
    return true;
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
      if (!activeEffect?.pause) return;
      activeEffect.animationPauseApplied = true;
      setAnimationsPaused(Boolean(activeEffect.pause.animationState.pause));
    },

    /**
     * Build the effect GUI for the engine's current effect and install it as the
     * active effect record.
     * @returns {void}
     */
    build() {
      try {
        activeEffect = createEffectRecord({ restoreAccepted: true });
      } catch (error) {
        if (moduleDead(error)) throw error;
        activeEffect = null;
        logWarn('Effect GUI: panel construction failed', error);
        showConfigImportNotice('Effect controls could not be built.');
        return;
      }
      persistence.persist(activeEffect.gui, undefined, true);
      rebuildFailureGeneration = undefined;
      skewLogged = false;
    },

    /**
     * Mount the active effect GUI in the page's GUI container.
     * @returns {void}
     */
    mount() {
      view.mount(activeEffect);
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
