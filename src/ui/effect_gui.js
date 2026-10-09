/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The effect panel's coordinator — build, mount, per-frame sync, schema
 * rebuild, and teardown — with lil-gui, the engine, the worker pool, the
 * copy operation, and the document injected.
 */

import {
  paramControlKind,
  engineParamValue,
  acceptedParamValue,
  paramExportBlocker,
  paramGenerationStale,
  selectorControlValue,
  replayParameterWrites,
} from "../effects/param_sync.js";
import { createEffectPersistence } from '../effects/effect_persistence.js';
import { createEffectPanelView } from './effect_panel_view.js';
import { EffectPanelEdits } from './effect_panel_edits.js';
import {
  addParamControl,
  nameStageControl,
  paramWarningTexts,
  presentReadonlyParam,
  stageGrouping,
} from './effect_param_controls.js';
import { createParamValueSync } from './effect_param_values.js';
import { createEffectActions } from './effect_actions.js';
import { formatExportParams } from "../shared/export_params.js";

/** @typedef {import("./effect_param_controls.js").ParameterDefinition} ParameterDefinition */
/** @typedef {import("./effect_param_controls.js").GuiController} GuiController */
/** @typedef {import("./effect_param_controls.js").Gui} Gui */
/** @typedef {{animationState: {pause: boolean}, controller: GuiController|null, setPaused: (value: boolean) => void, show: (paused: boolean|undefined) => void}} PauseToggle */
/**
 * One built effect panel.
 * @typedef {Object} EffectRecord
 * @property {Gui} gui - The panel's lil-gui root.
 * @property {EffectPanelEdits} edits - In-flight pointer and keyboard edits.
 * @property {number|undefined} paramGeneration - Effect-load generation the
 *   definitions were read at.
 * @property {string[]} paramNames - Value-stream order of every parameter.
 * @property {string[]} writableParamNames - Parameters the panel writes.
 * @property {Map<string, GuiController>} controllerByName - Parameter controllers.
 * @property {boolean} hasParams - Whether the panel shows parameter controls.
 * @property {boolean} hasEnumControls - Whether any parameter control is a selector.
 * @property {boolean} hasAnimatedEnums - Whether any selector is animation-driven.
 * @property {Map<string, string>} paramWarnings - Warnings the panel was built with.
 * @property {boolean} paramsExternal - Whether parameters render outside the panel.
 * @property {Map<string, Gui>} stageFolders - Pipeline stage folders.
 * @property {PauseToggle} pause - The pause toggle.
 * @property {import("./effect_actions.js").EffectActions} actions - The action row.
 * @property {boolean} hydrating - True until construction finishes.
 * @property {boolean} animationPauseApplied - Whether pause transitions reach
 *   the engine.
 * @property {boolean} warningsDirty - Whether the warnings must be re-read.
 */

const RESERVED_CONTROL_NAMES = new Set(['pause']);

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
 * @param {() => import('../../generated/holosphere_wasm.js').ChainSnapshot|null} [deps.config.snapshot] - Captures that state.
 * @param {(snapshot: Object) => unknown} [deps.config.restore] - Atomically
 *   restores a captured state, returning one ChainSnapshotRestoreResult value.
 * @param {() => Record<string, unknown>} [deps.config.restoreResults] - The
 *   engine's ChainSnapshotRestoreResult enum, which that value is judged against by
 *   identity.
 * @param {(message: string|null) => void} [deps.config.showImportNotice] - Shows
 *   or clears the snapshot notice.
 *
 * @param {Object} deps.host - The page the panel mounts into.
 * @param {() => Gui} deps.host.createGui - Makes an empty effect GUI root (a
 *   DeepLinkGUI).
 * @param {() => Object|null} deps.host.container - The element the panel mounts in.
 * @param {() => boolean} deps.host.isMobile - Whether to mount the panel collapsed.
 * @param {((text: string) => Promise<boolean>)|null} deps.host.copyText - Copies text
 *   using the browser's available clipboard path, null where there is none.
 * @param {() => void} deps.host.applyEffect - Reinstalls the active effect at
 *   defaults, clears its URL params, and rebuilds the panel (the Reset button).
 * @param {EventTarget}
 *   deps.host.dragTarget - Where the drag-end listeners live (the window): a
 *   lil-gui drag continues outside the control's own DOM.
 * @param {() => Node|null} [deps.host.focusedElement] - The document's focused
 *   element. A control whose number input has focus is being typed into, so the
 *   per-frame value stream must leave it alone.
 * @param {() => {external: true}|null} [deps.host.paramFilter] - Non-null when
 *   the active effect's parameters are rendered outside this panel: the panel
 *   builds no parameter controls, though every parameter still claims its
 *   value-stream slot. A change rebuilds the panel.
 * @param {(message: string, error?: any) => void} [deps.host.logWarn] - Console sink.
 * @returns {{active: () => Object|null, liveParamValues: () => ArrayLike<number>|null,
 *   movePreset: (delta: number) => boolean,
 *   build: (options?: {restoreStored?: boolean}) => void,
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
  // The unstaged-parameter set last warned about.
  let unstagedWarned = '';
  /** @type {string|undefined} */
  let rebuildFailureGeneration;
  const persistence = createEffectPersistence({
    getParameterDefinitions, setEngineParam, usesChainSnapshot, getSnapshot, restoreSnapshot, chainSnapshotRestoreResults, showConfigImportNotice, logWarn
  });
  const view = createEffectPanelView({ focusedElement, guiContainer, isMobile });
  const valueSync = createParamValueSync({
    liveParamValues, segmentsOwnDisplay, getParameterDefinitions, focusedElement, logWarn,
  });
  /**
   * Live per-frame parameter values for the active effect: the worker pool's
   * stream while it owns the display, else the main engine's. May be null or
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
   * was built from; a refused write changes them without a schema generation
   * bump. Deferred while a pointer or keyboard edit is in flight.
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

  /**
   * Bring the panel up to date with the engine: follow a preset change,
   * rebuild a stale schema, then push the live parameter values into the
   * controllers without clobbering an active edit.
   * @param {boolean} [advanced] - Whether the simulation stepped this frame;
   *   gates only the enum-definition marshal.
   * @returns {void}
   */
  function sync(advanced = true) {
    if (!activeEffect || !activeEffect.controllerByName) return;
    const hasPresets = activeEffect.actions.hasPresets();
    const presetIndex = hasPresets ? getPresetIndex() : null;
    const presetAdvanced = hasPresets
      && activeEffect.actions.displayedPresetIndex() !== presetIndex;
    const presetSynced = !hasPresets || synchronizePreset(/** @type {number} */ (presetIndex));
    const filterStale =
      (paramFilter() !== null) !== (activeEffect.paramsExternal === true);
    const warningsStale = paramWarningsStale(activeEffect);
    if (warningsStale) rebuildFailureGeneration = undefined;
    if (paramGenerationStale(activeEffect.paramGeneration, paramGeneration())
        || warningsStale || filterStale) {
      if (!rebuildSchema()) return;
    }
    if (!presetSynced) return;
    activeEffect.pause.show(engineAnimationsPaused());
    if (activeEffect.actions.hasPresets()) {
      activeEffect.actions.showPreset(getPresetCount(), getPresetIndex());
    }
    valueSync.syncValues(activeEffect, advanced, presetAdvanced);
  }

  /**
   * The text Export copies: the chain snapshot as JSON on a snapshot effect,
   * else the typed parameters as a C++ brace-init list.
   * @param {EffectRecord} fx - The effect record owning the Export button.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @returns {import("./effect_actions.js").ExportResult} The text, or why
   *   there is none.
   */
  function buildExport(fx, params) {
    if (usesChainSnapshot()) {
      const snapshot = getSnapshot();
      if (!snapshot) return { error: 'Export: Shader Workbench chain snapshot is unavailable' };
      if (typeof copyText !== 'function') return { error: 'Export: clipboard copy unavailable' };
      return { text: JSON.stringify(snapshot, null, 2) };
    }
    let values = liveParamValues();
    if ((!values || values.length === 0) && !fx.paramsExternal
        && !paramGenerationStale(fx.paramGeneration, paramGeneration())) {
      values = fx.paramNames.map((name) =>
        engineParamValue(fx.controllerByName.get(name)?.getValue()));
    }
    const blocked = paramExportBlocker(
      values, fx.paramNames.length, typeof copyText === 'function');
    if (blocked) return { error: blocked };
    try {
      return { text: formatExportParams(params, /** @type {ArrayLike<number>} */ (values)) };
    } catch (err) {
      return { error: 'Export: parameter formatting failed', cause: err };
    }
  }

  /**
   * Adopt a preset selection the engine accepted: re-read warnings, drop the
   * stored values the preset replaced, persist, and re-seat the displays.
   * @param {EffectRecord} fx - The effect record whose preset changed.
   * @param {number} count - The live preset count.
   * @param {number} index - The selected preset.
   * @returns {void}
   */
  function adoptPresetChange(fx, count, index) {
    fx.warningsDirty = true;
    if (!usesChainSnapshot()) {
      for (const parameter of getParameterDefinitions()) {
        if (!parameter.readonly) fx.gui.writeStoredValue(parameter.name, null);
      }
    }
    persistence.persist(fx.gui);
    fx.actions.showPreset(count, index);
    fx.pause.show(engineAnimationsPaused() ?? true);
    valueSync.adoptRequestedEnums(fx, focusedElement() ?? null);
  }

  /**
   * Reinstall the active effect at defaults, clear its URL params, and rebuild
   * the panel, carrying keyboard focus and scroll offset across.
   * @param {EffectRecord} fx - The record whose Reset button was pressed.
   * @returns {void}
   */
  function resetEffect(fx) {
    const captured = view.capture(fx);
    view.rebuild(captured.closed, applyEffect);
    view.restore(activeEffect, captured);
  }

  /**
   * Build the action row onto a record under construction.
   * @param {EffectRecord} fx - The effect record being built.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @returns {import("./effect_actions.js").EffectActions} The action row handle.
   */
  function addEffectActions(fx, params) {
    return createEffectActions(fx, {
      presets: { count: getPresetCount, index: getPresetIndex, select: selectPreset },
      onPresetChange: (count, index) => adoptPresetChange(fx, count, index),
      onReset: () => resetEffect(fx),
      buildExport: () => buildExport(fx, params),
      copyText: (text) => /** @type {(text: string) => Promise<boolean>} */ (copyText)(text),
      isActive: (record) => activeEffect === record,
      logWarn,
    });
  }

  /**
   * Add the "Pause Animation" toggle when the effect has an animated param or
   * any preset available for manual selection (selecting one pauses animation).
   * @param {EffectRecord} fx - The effect record being built.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @param {boolean} [initialPause=false] - Initial pause state.
   * @param {boolean} [hydrate=true] - Read the stored pause value while constructing the toggle.
   * @returns {PauseToggle} The toggle's state, its controller (null when
   *   neither animation surface is available), its state transition, and its
   *   display-only update.
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
    /**
     * Show a pause state on the toggle without writing back to the engine.
     * @param {boolean|undefined} paused - The state to show; undefined shows nothing.
     * @returns {void}
     */
    const show = (paused) => {
      if (paused === undefined || paused === animationState.pause) return;
      animationState.pause = paused;
      controller?.updateDisplay();
      fx.gui.writeStoredValue('pause', paused);
    };
    if (params.some(p => p.animated) || getPresetCount() > 0) {
      const add = hydrate
        ? (/** @type {any[]} */ ...args) => fx.gui.add(...args)
        : (/** @type {any[]} */ ...args) => fx.gui.addUnhydrated(...args);
      controller = add(animationState, 'pause').name('Pause Animation');
      controller?.onChange(transitionPaused);
    }
    return { animationState, controller, setPaused, show };
  }

  /**
   * Re-seat the pause toggle on the engine's own animation state after a
   * parameter write: writing an animation-driven param pauses implicitly. The
   * toggle's transition carries the adopted state on to the worker pool.
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
   * Build one controller per engine parameter, recording the value-stream order.
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
    /** @type {{name: string, value: number, apply: () => boolean, persist: () => void}[]} */
    const hydrationWrites = [];
    const external = paramFilter() !== null;
    // Fixed for the schema this build is committed to.
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
      if (controller.isContinuous) {
        fx.edits.trackDrag(/** @type {GuiController & {dragging: boolean}} */ (controller));
      }
      fx.edits.trackKeyboard(controller);

      const kind = paramControlKind(p);
      let acceptedControlValue = acceptedParamValue(p);
      if (kind === 'boolean') {
        acceptedControlValue = engineParamValue(acceptedControlValue) > 0.5;
      }
      const persistValue = () => {
        controller.acceptUrlValue?.(acceptedControlValue);
        const edited = { name: p.name, accepted: acceptedControlValue };
        fx.edits.persist(controller, edited);
      };
      const applyValue = (/** @type {number|boolean} */ v) => {
        const value = engineParamValue(v);
        const offered = !p.optionValues || p.optionValues.includes(value);
        const accepted = offered && setEngineParam(p.name, value) !== false;
        if (!offered) {
          controller.object[controller.property] = acceptedControlValue;
          controller.updateDisplay();
        }
        if (accepted) acceptedControlValue = v;
        if (accepted) setWorkerParam(p.name, value);
        if (!fx.hydrating) adoptEnginePause(pause, p);
        fx.warningsDirty = true;
        return accepted;
      };
      controller.onChange((/** @type {number|boolean} */ v) => {
        if (fx.hydrating) {
          hydrationWrites.push({
            name: p.name,
            value: engineParamValue(v),
            apply: () => applyValue(v),
            persist: () => {
              persistValue();
              if (persistParamKeys) fx.gui.writeStoredValue(p.name, acceptedControlValue);
            },
          });
          return;
        }
        applyValue(v);
        persistValue();
      });
    });
    const hydrationByName = new Map(hydrationWrites.map(write => [write.name, write]));
    replayParameterWrites(hydrationWrites,
      (name) => hydrationByName.get(name)?.apply() ?? false, { APPLIED: true, INADMISSIBLE: false });
    for (const write of hydrationWrites) write.persist();
  }

  /**
   * Construct one effect record without publishing or mounting it, so a schema
   * rebuild is atomic.
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

      fx.actions = addEffectActions(fx, params);
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
    fx.actions?.cancel();
    fx.edits.dispose();
    const dom = fx.gui.domElement;
    if (dom?.parentNode) dom.parentNode.removeChild(dom);
    fx.actions?.detach();
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
    valueSync.resetSkew();
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
      return activeEffect?.actions.movePreset(delta) ?? false;
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
     * @param {{restoreStored?: boolean}} [options] - `restoreStored: false`
     *   skips replaying the URL-stored effect state, for a caller that has
     *   already restored the live state.
     * @returns {void}
     */
    build({ restoreStored = true } = {}) {
      try {
        activeEffect = createEffectRecord({ restoreAccepted: restoreStored });
      } catch (error) {
        if (moduleDead(error)) throw error;
        activeEffect = null;
        logWarn('Effect GUI: panel construction failed', error);
        showConfigImportNotice('Effect controls could not be built.');
        return;
      }
      persistence.persist(activeEffect.gui, undefined, true);
      rebuildFailureGeneration = undefined;
      valueSync.resetSkew();
    },

    /**
     * Mount the active effect GUI in the page's GUI container.
     * @returns {void}
     */
    mount() {
      view.mount(activeEffect);
    },

    /**
     * Tear down the active effect GUI and clear the effect record, draining the
     * drag-end listeners on the drag target first.
     * @returns {void}
     */
    destroy() {
      disposeEffect(activeEffect);
      activeEffect = null;
    },
  };
}
