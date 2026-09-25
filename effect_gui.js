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
import { createEffectPersistence, acceptedParamValue } from './effect_persistence.js';
import { createEffectPanelView, focusWidget } from './effect_panel_view.js';
import { EffectPanelEdits } from './effect_panel_edits.js';
import { formatExportParams } from "./tools/export_params.js";
import {
  LATTICE_MELT_STAGE_ORDER,
  LATTICE_MELT_STAGE_TITLES,
  KALEIDOSCOPE_SMOOTH_STAGE_ORDER,
  KALEIDOSCOPE_SMOOTH_STAGE_TITLES,
  STAGE_ORDER,
  latticeMeltStageAssignments,
  kaleidoscopeSmoothStageAssignments,
  fixedShaderStageAssignments,
  fixedShaderStageTitles,
  legacyShaderBallParamNames,
  stageControlLabel,
  shaderStageAssignments,
} from "./shader_stages.js";

// How long a transient button label (Export status) stays before reverting.
export const FLASH_MS = 1500;
// Transient Export button labels.
export const EXPORT_COPIED = '\u2713 Copied!';
export const EXPORT_FAILED = '\u2717 Copy failed';
const EXPORT_ICON = '\u29c9';
const RESET_ICON = '\u21ba';
const PREVIOUS_ICON = '\u25c0';
const NEXT_ICON = '\u25b6';
// Panel control names an engine parameter cannot reuse. The action buttons are
// functions and the preset selector is a session control, so none of those owns
// a deep-link key; the pause toggle owns `pause`.
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
  if (hydrate && legacyNames.length > 0) {
    return (object, property, ...rest) =>
      gui.addMigrated(object, property, legacyNames, ...rest);
  }
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
    controller = add(state, p.name, p.min, p.max)
      .decimals(sliderDecimals(p.min, p.max));
  }
  controller.isBoolean = (kind === 'boolean');
  controller.isEnum = (kind === 'enum');
  controller.isContinuous = (kind === 'number' || kind === 'integer');
  if (p.warning) {
    // A visible node beside the control: a title attribute would put the text
    // behind a hover no keyboard or touch user can reach. aria-invalid and
    // aria-describedby go on the widget carrying the control's role, not on
    // the wrapper it is drawn in.
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

// Collaborator members that must be callable, and those that stand in when the
// caller leaves them out. host.dragTarget is an event target, not a function,
// so it is checked apart.
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
  fieldDefinitions: () => null,
  restore: () => null,
  restoreResults: () => ({}),
  showImportNotice: () => {},
};
const HOST_DEFAULTS = {
  focusedElement: () => null,
  paramFilter: () => null,
  logWarn: (...args) => console.warn(...args),
};

/**
 * Fill a collaborator group's absent members in and check that every member the
 * panel will call is callable.
 * @param {string} group - Group name, which a fault message names.
 * @param {Object|undefined} members - What the caller passed for the group.
 * @param {Array<string>} required - Members with no stand-in.
 * @param {Object} [defaults] - Members that stand in when absent.
 * @returns {Object} The filled group.
 * @throws {TypeError} On a group that is not an object, or a member that is not
 *   a function.
 */
function checkedGroup(group, members, required, defaults = {}) {
  if (members === null || typeof members !== 'object') {
    throw new TypeError(`createEffectGui: the ${group} collaborator is missing.`);
  }
  const filled = { ...defaults, ...members };
  for (const name of [...required, ...Object.keys(defaults)]) {
    if (typeof filled[name] !== 'function') {
      throw new TypeError(`createEffectGui: ${group}.${name} must be a function.`);
    }
  }
  return filled;
}

/**
 * Build the effect GUI controller for the app's active effect.
 *
 * The four collaborators are checked once here, so a mis-wired page fails where
 * it is composed rather than at the first frame that happens to call the slot.
 *
 * @param {Object} deps - Injected app collaborators, in four groups.
 * @param {Object} deps.engine - The main engine the panel reads and writes.
 * @param {() => Array<Object>} deps.engine.getParameterDefinitions - Reads the
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
 * @param {() => Object|null} [deps.config.snapshot] - Captures that state.
 * @param {() => Array<Object>|null} [deps.config.fieldDefinitions] - Names the
 *   fields in a snapshot.
 * @param {(snapshot: Object) => unknown} [deps.config.restore] - Atomically
 *   restores a captured state, returning one FullConfigRestoreResult value.
 * @param {() => Record<string, unknown>} [deps.config.restoreResults] - The
 *   engine's FullConfigRestoreResult enum, which that value is judged against by
 *   identity.
 * @param {(message: string|null) => void} [deps.config.showImportNotice] - Shows
 *   or clears the migration notice.
 *
 * @param {Object} deps.host - The page the panel mounts into.
 * @param {() => Object} deps.host.createGui - Makes an empty effect GUI root: a
 *   DeepLinkGUI (gui.js), whose whole add/stored-value surface the panel uses.
 * @param {() => Object|null} deps.host.container - The element the panel mounts in.
 * @param {() => boolean} deps.host.isMobile - Whether to mount the panel collapsed.
 * @param {?(text: string) => Promise<boolean>} deps.host.copyText - Copies text
 *   using the browser's available clipboard path, null where there is none.
 * @param {() => void} deps.host.applyEffect - Rebuilds the panel from engine
 *   state (the Reset button).
 * @param {{addEventListener: Function, removeEventListener: Function}}
 *   deps.host.dragTarget - Where the drag-end listeners live (the window): a
 *   lil-gui drag continues outside the control's own DOM.
 * @param {() => Object|null} [deps.host.focusedElement] - The document's focused
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
export function createEffectGui({ engine, segments, config, host }) {
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
    inUse: usesFullConfigSnapshot, snapshot: getFullConfigSnapshot,
    fieldDefinitions: getFullConfigFieldDefinitions,
    restore: restoreFullConfigSnapshot, restoreResults: fullConfigRestoreResults,
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
  let activeEffect = null;
  // Throttle the param/value length-skew warning to once per skew episode.
  let skewLogged = false;
  // The unstaged-parameter set last warned about. A panel rebuilds on every
  // warning move and every preset, all over the same schema.
  let unstagedWarned = '';
  let rebuildFailureGeneration;
  const persistence = createEffectPersistence({
    getParameterDefinitions, setEngineParam, usesFullConfigSnapshot, getFullConfigSnapshot, restoreFullConfigSnapshot, fullConfigRestoreResults, showConfigImportNotice, logWarn
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
   * an effect, so the schema generation cannot report it. Deferred while an
   * edit is in flight, pointer or keyboard: the rebuild would discard the
   * controller under the pointer, or the input a held arrow key repeats into.
   * @param {Object} fx - The active effect record.
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
  function adoptPauseDisplay(fx, paused) {
    if (paused === undefined || paused === fx.pause.animationState.pause) return;
    fx.pause.animationState.pause = paused;
    fx.pause.controller?.updateDisplay();
    fx.gui.writeStoredValue('pause', paused);
  }

  /** Update the preset controller and its visibility from live engine state. */
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
   * @param {boolean} [advanced] - Whether the simulation stepped this frame.
   *   Only the enum-definition marshal is gated on it; every other caller wants
   *   the full pass and leaves it defaulted.
   * @returns {void}
   */
  function sync(advanced = true) {
    if (!activeEffect || !activeEffect.controllerByName) return;
    const presetIndex = activeEffect.preset ? getPresetIndex() : null;
    // Mirroring the preset can itself load a new schema, so the rebuild follows
    // it — but a refusal must not gate the rebuild, which is what clears the
    // stale schema a refusal comes from.
    const presetAdvanced = activeEffect.preset
      && activeEffect.preset.state.presetIndex !== presetIndex;
    const presetSynced = !activeEffect.preset || synchronizePreset(presetIndex);
    // Where the parameters render is external state: adopting a document moves
    // them onto the pipeline strip without moving the schema generation, so the
    // mode is compared against the one the panel was built with.
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
    if (advanced && activeEffect.hasEnumControls
        && (activeEffect.hasAnimatedEnums || presetAdvanced)) {
      adoptRequestedEnums(activeEffect, focused);
    }

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
   * Copy text to the clipboard and report the outcome on the Export label.
   * @param {Object} fx - The effect record owning the Export button. A copy that
   *   lands after the effect changed reports nothing: the label belongs to a
   *   panel that is gone.
   * @param {string} text - The text to copy.
   * @param {(label: string) => void} flashExport - Shows a transient Export label.
   * @returns {Promise<void>} Clipboard completion.
   */
  function copyAndFlash(fx, text, flashExport) {
    return copyText(text).then((copied) => {
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
   * Write the live parameter values to the clipboard as a C++ brace-init list.
   * @param {Object} fx - The effect record owning the Export button.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @param {(label: string) => void} flashExport - Shows a transient Export label.
   * @returns {Promise<void>|void} Clipboard completion, or nothing when blocked.
   */
  function exportParams(fx, params, flashExport) {
    if (usesFullConfigSnapshot()) {
      const snapshot = getFullConfigSnapshot();
      if (!snapshot) {
        logWarn('Export: Shader Workbench full-config snapshot is unavailable');
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
    // The controller fallback needs one control per stream slot, which the
    // selected-instance filter deliberately does not build.
    if ((!values || values.length === 0) && !fx.paramsExternal
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

    return copyAndFlash(fx, text, flashExport);
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
      // A live region re-announces a repeated message only after its text has
      // changed. The revert empties it; a repeat inside the flash window instead
      // alternates an inaudible zero-width marker.
      exportStatus.textContent = exportStatus.textContent === label
        ? `${label}\u200B` : label;
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
        const captured = view.capture(fx);
        view.rebuild(captured.closed, applyEffect);
        view.restore(activeEffect, captured);
      },
      /**
       * Copy the current parameter values to the clipboard as a C++ brace-init
       * list of float literals, then flash the outcome on the Export button.
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
      const choose = (index) => {
        const count = getPresetCount();
        if (count <= 0 || !selectPreset(index)) {
          adoptPresetDisplay(fx, count, getPresetIndex());
          return false;
        }
        // A preset rewrites every parameter, so it raises or clears warnings
        // with no schema-generation move behind them.
        fx.warningsDirty = true;
        if (!usesFullConfigSnapshot()) {
          for (const parameter of getParameterDefinitions()) {
            if (!parameter.readonly) fx.gui.writeStoredValue(parameter.name, null);
          }
        }
        persistence.persist(fx.gui);
        adoptPresetDisplay(fx, count, index);
        adoptPauseDisplay(fx, engineAnimationsPaused() ?? true);
        // The preset writes requested enum values with no simulation step behind
        // it, which is the one source sync()'s stepped-frame gate does not cover.
        adoptRequestedEnums(fx, focusedElement() ?? null);
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
   * @param {Object} fx - The effect record being built.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @param {boolean} [initialPause=false] - Initial pause state.
   * @param {boolean} [hydrate=true] - Read the stored pause value while constructing the toggle.
   * @returns {{animationState: {pause: boolean}, controller: Object|null,
   *   setPaused: (v: boolean) => void}} The toggle's state, its controller (null
   *   when neither animation surface is available), and its state transition.
   */
  function addPauseToggle(fx, params, initialPause = false, hydrate = true) {
    const animationState = { pause: Boolean(initialPause) };
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
        ? (...args) => fx.gui.add(...args)
        : (...args) => fx.gui.addUnhydrated(...args);
      controller = add(animationState, 'pause').name('Pause Animation');
      controller.onChange(transitionPaused);
    }
    return { animationState, controller, setPaused };
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
   * Pick the pipeline grouping for a parameter list. Each recognizer owns its
   * stage assignments, folder titles, and folder order together, so the three
   * cannot disagree; the first that claims the list wins.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @returns {{assignments: Map<string, string>, titles: Map<string, string>|null,
   *   order: Array<string>}|null} The grouping, or null when none claims the list.
   */
  function stageGrouping(params) {
    const shaderBall = shaderStageAssignments(params);
    if (shaderBall) {
      return {
        assignments: shaderBall, titles: null, order: STAGE_ORDER,
      };
    }
    const fixedShader = fixedShaderStageAssignments(params);
    const fixedTitles = fixedShader
      ? fixedShaderStageTitles(
        getFullConfigSnapshot(), getFullConfigFieldDefinitions(), logWarn)
      : null;
    const fixedGrouping = () => {
      const claimed = new Set(fixedShader.values());
      return {
        assignments: fixedShader,
        titles: fixedTitles,
        order: STAGE_ORDER.filter((stage) => claimed.has(stage)),
      };
    };
    // Only a Fixed Shader carrying a configuration snapshot outranks the named
    // fixed pipelines; without one it is the last resort below.
    if (fixedTitles) return fixedGrouping();
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
   * @param {Object} controller - The controller to present.
   * @returns {void}
   */
  function presentReadonlyParam(controller) {
    controller.domElement.classList.add('param-readonly');
    // Capture phase, so it lands ahead of lil-gui's own keydown on the widget,
    // which increments on an arrow key whatever attributes the widget carries.
    controller.domElement.addEventListener('keydown', (event) => {
      if (typeof event.key === 'string' && ((controller.$select && event.key.length === 1
          && !event.ctrlKey && !event.metaKey && !event.altKey) || event.key.startsWith('Arrow')
          || [' ', 'Enter', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key))) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    controller.domElement.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
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
   * @param {Object} controller - The stage folder's controller.
   * @param {string} stage - The pipeline stage it was grouped under.
   * @param {string} name - Engine parameter name.
   * @returns {void}
   */
  function nameStageControl(controller, stage, name) {
    controller.name(stageControlLabel(stage, name));
    const widget = focusWidget(controller);
    if (!widget) return;
    // lil-gui points the widget at the visible label; aria-labelledby wins over
    // aria-label, so the shared label has to go.
    widget.removeAttribute('aria-labelledby');
    widget.setAttribute('aria-label', name);
  }

  /**
   * Build one controller per engine parameter, recording the value-stream order.
   * A ?param=value deep link reaches the engine through the GUI's load-time
   * onChange replay.
   * @param {Object} fx - The effect record being built.
   * @param {Array<Object>} params - The engine's parameter definitions.
   * @param {{animationState: Object, controller: Object|null, setPaused: Function}}
   *   pause - The effect's pause toggle.
   * @param {Set<string>|null} [previousParamNames=null] - Names present before a schema rebuild.
   * @returns {void}
   */
  function addParamControllers(fx, params, pause, previousParamNames = null) {
    // paramNames records the value-stream order; sync() binds by name, not
    // index, so a C++ param reorder can't mis-bind sliders.
    const state = {};
    const external = paramFilter() !== null;
    // Fixed for the schema this build is committed to: no parameter write adds
    // or drops a stage selector.
    const persistParamKeys = !usesFullConfigSnapshot();
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
    // Keyed by stage, not by folder title: a slot the user collapsed keeps its
    // state across a rebuild that re-titles it from a new selector value.
    fx.stageFolders = stageFolders;

    params.forEach(p => {
      // A param rendered elsewhere still claims its paramNames slot: the value
      // stream is positional, so building no control must not shift the binding
      // of the ones that stay.
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
        legacyShaderBallParamNames(p.name), persistParamKeys);
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
      controller.onChange(v => {
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
      animationPauseApplied: false,
      hydrating: true,
      warningsDirty: false,
    };

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
      // Stamp before controls are attached: URL replay can synchronously write
      // engine params and make this snapshot stale, which the next sync must see.
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
   * @param {Object|null} fx - Record to release.
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
    // A rebuild that already failed for this schema generation fails the same
    // way every frame, so the retry waits for a new generation rather than
    // allocating and discarding a panel at frame rate.
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
      if (rebuildFailureGeneration !== generation) {
        logWarn('Effect GUI: parameter-schema rebuild failed', error);
        showConfigImportNotice('Effect controls could not be rebuilt.');
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
