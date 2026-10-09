/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Per-frame synchronization of the effect panel's parameter controllers with
 * the engine's live values and requested selector states.
 */

import { resolveParamSync, paramValueSkew, selectorControlValue } from "../effects/param_sync.js";

/** @typedef {import("./effect_param_controls.js").GuiController} GuiController */
/** @typedef {import("./effect_param_controls.js").ParameterDefinition} ParameterDefinition */
/**
 * The parameter controllers one panel displays.
 * @typedef {Object} ParamDisplay
 * @property {Map<string, GuiController>} controllerByName - Parameter controllers.
 * @property {string[]} paramNames - Value-stream order of every parameter.
 * @property {boolean} hasParams - Whether the panel shows parameter controls.
 * @property {boolean} hasEnumControls - Whether any parameter control is a selector.
 * @property {boolean} hasAnimatedEnums - Whether any selector is animation-driven.
 */

/**
 * Bind the controller-value synchronization to its value sources.
 * @param {Object} deps
 * @param {() => ArrayLike<number>|null} deps.liveParamValues - The live value
 *   stream describing the displayed parameters, or null.
 * @param {() => boolean} deps.segmentsOwnDisplay - Whether the worker pool owns
 *   the display; its stream then drives selectors too.
 * @param {() => Array<ParameterDefinition>} deps.getParameterDefinitions - The
 *   main engine's parameter definitions.
 * @param {() => Node|null|undefined} deps.focusedElement - The document's focused
 *   element.
 * @param {(message: string) => void} deps.logWarn - Console sink.
 * @returns {{syncValues: (display: ParamDisplay, advanced: boolean, presetAdvanced: boolean) => void,
 *   adoptRequestedEnums: (display: ParamDisplay, focused: Node|null) => void,
 *   resetSkew: () => void}}
 */
export function createParamValueSync({
  liveParamValues, segmentsOwnDisplay, getParameterDefinitions, focusedElement, logWarn,
}) {
  // Throttle the param/value length-skew warning to once per skew episode.
  let skewLogged = false;

  /**
   * Re-seat the panel's enum selectors on the `requestedValue`s in the
   * engine's definitions snapshot.
   * @param {ParamDisplay} display - The displayed controllers.
   * @param {Node|null} focused - The document's focused element, or null; a
   *   focused selector is left alone.
   * @returns {void}
   */
  function adoptRequestedEnums(display, focused) {
    if (!display.hasEnumControls) return;
    for (const parameter of getParameterDefinitions()) {
      const controller = display.controllerByName.get(parameter.name);
      if (!controller?.isEnum || controller.isReadonly) continue;
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
   * Push the live parameter values into the displayed controllers without
   * clobbering a control being dragged or typed into.
   * @param {ParamDisplay} display - The displayed controllers.
   * @param {boolean} advanced - Whether the simulation stepped this frame;
   *   gates only the enum-definition marshal.
   * @param {boolean} presetAdvanced - Whether the live preset moved off the
   *   displayed one.
   * @returns {void}
   */
  function syncValues(display, advanced, presetAdvanced) {
    if (!display.hasParams) return;
    // One focus read for the whole pass: at most one element has focus.
    const focused = focusedElement() ?? null;
    // The definitions marshal allocates; run it only when an engine-driven
    // selector can have moved.
    if (!segmentsOwnDisplay() && advanced && display.hasEnumControls
        && (display.hasAnimatedEnums || presetAdvanced)) {
      adoptRequestedEnums(display, focused);
    }

    const values = liveParamValues();
    if (!values || values.length === 0) return;

    const names = display.paramNames;
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
      const c = display.controllerByName.get(names[i]);
      if (!c) continue;
      if (c.isEnum && !c.isReadonly && !segmentsOwnDisplay()) continue;
      const liveValue = c.isEnum
        ? selectorControlValue({ value: values[i], options: c.enumOptions,
          optionValues: c.enumOptionValues })
        : values[i];

      const isEditing = !c.isReadonly && (c.dragging
        || (focused !== null && c.domElement?.contains(focused) === true));

      const { update, value } = resolveParamSync(
        c.getValue(), liveValue, c.isBoolean, isEditing);
      if (!update) continue;
      c.object[c.property] = value;
      c.updateDisplay();
    }
  }

  return {
    syncValues,
    adoptRequestedEnums,
    /** Re-arm the skew warning for a newly published panel. */
    resetSkew() { skewLogged = false; },
  };
}
