/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import {paramControlKind, selectorControlValue, acceptedParamValue, engineParamValue,
  replayParameterWrites} from '../effects/param_sync.js';
import {addParamControl, nameStageControl, paramWarningTexts, presentReadonlyParam,
  stageGrouping} from './effect_param_controls.js';

/** @typedef {import('./effect_gui.js').EffectRecord} EffectRecord */
/** @typedef {import('./effect_gui.js').PauseToggle} PauseToggle */
/** @typedef {import('./effect_param_controls.js').ParameterDefinition} ParameterDefinition */
/** @typedef {import('./effect_param_controls.js').GuiController} GuiController */

/**
 * @param {object} deps - Parameter editing and persistence callbacks.
 * @param {() => {external: true}|null} deps.paramFilter - External parameter ownership.
 * @param {() => boolean} deps.usesChainSnapshot - Snapshot persistence availability.
 * @param {(message: string) => void} deps.logWarn - Parameter grouping warning sink.
 * @param {(name: string, value: number, gesture?: object) => boolean} deps.setEngineParam - Main-engine parameter writer.
 * @param {(name: string, value: number) => void} deps.setWorkerParam - Worker parameter writer.
 * @param {(pause: PauseToggle) => void} deps.adoptEnginePause - Pause state reconciliation.
 */
export function createParamControllers({paramFilter, usesChainSnapshot, logWarn,
  setEngineParam, setWorkerParam, adoptEnginePause}) {
  let unstagedWarned = '';
  /**
   * Build one controller per engine parameter, recording the value-stream order.
   * @param {EffectRecord} fx - The effect record being built.
   * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
   * @param {PauseToggle} pause - The effect's pause toggle.
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
      const controller = addParamControl(controlGui, state, p, {
        hydrate: !previousParamNames?.has(p.name),
        persist: persistParamKeys,
      });
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
        const accepted = offered && setEngineParam(p.name, value, fx.edits.dragGesture(controller)) !== false;
        if (!offered) {
          controller.object[controller.property] = acceptedControlValue;
          controller.updateDisplay();
        }
        if (accepted) {
          acceptedControlValue = v;
          setWorkerParam(p.name, value);
          fx.advisoriesDirty = true;
        }
        if (!fx.hydrating) adoptEnginePause(pause);
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
  return addParamControllers;
}
