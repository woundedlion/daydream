/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The lil-gui control each engine parameter definition calls for, and its
 * presentation: warnings, read-only telemetry and pipeline stage labels.
 */

import { enumChoices, paramControlKind } from "../effects/param_sync.js";
import { focusWidget } from './effect_panel_view.js';
import {
  LATTICE_MELT_STAGE_ORDER,
  LATTICE_MELT_STAGE_TITLES,
  KALEIDOSCOPE_SMOOTH_STAGE_ORDER,
  KALEIDOSCOPE_SMOOTH_STAGE_TITLES,
  STAGE_ORDER,
  latticeMeltStageAssignments,
  kaleidoscopeSmoothStageAssignments,
  composedStageAssignments,
  stageControlLabel,
} from "../effects/shader_stages.js";

/** Engine toggles omit the range fields.
 * @typedef {{name: string, value: number|boolean, min?: number, max?: number, animated?: boolean, readonly?: boolean, warning?: string, options?: string[], optionValues?: number[], step?: number, acceptedValue?: number|boolean, requestedValue?: number|boolean}} ParameterDefinition */
/** @typedef {import("./effect_panel_view.js").PanelController & Record<string, any>} GuiController */
/** @typedef {import("./effect_panel_view.js").PanelFolder & Record<string, any>} Gui */

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
export function paramWarningTexts(params) {
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
 * increment() re-parses the *displayed* string.
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
 * Add the lil-gui control one engine parameter definition calls for.
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
    controller = add(state, p.name, enumChoices(p.options ?? [], p.optionValues));
  } else if (kind === 'integer') {
    controller = add(state, p.name, p.min, p.max, 1).decimals(0);
  } else {
    controller = add(state, p.name, p.min, p.max)
      .decimals(sliderDecimals(/** @type {number} */ (p.min), /** @type {number} */ (p.max)));
  }
  controller.isBoolean = (kind === 'boolean');
  controller.isEnum = (kind === 'enum');
  controller.enumOptions = p.options;
  controller.enumOptionValues = p.optionValues;
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

/**
 * Pick the pipeline grouping for a parameter list; the first recognizer that
 * claims the list wins.
 * @param {Array<ParameterDefinition>} params - The engine's parameter definitions.
 * @returns {{assignments: Map<string, string>, titles: Map<string, string>|null,
 *   order: Array<string>}|null} The grouping, or null when none claims the list.
 */
export function stageGrouping(params) {
  const composed = composedStageAssignments(params);
  const composedGrouping = () => {
    const claimed = new Set(composed?.values());
    return {
      assignments: /** @type {Map<string, string>} */ (composed),
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
  return composed ? composedGrouping() : null;
}

/**
 * Present engine-written telemetry as a focusable read-only control.
 * @param {GuiController} controller - The controller to present.
 * @returns {void}
 */
export function presentReadonlyParam(controller) {
  controller.isReadonly = true;
  if (controller.isContinuous) {
    const updateDisplay = controller.updateDisplay.bind(controller);
    controller.updateDisplay = () => {
      const inputFocused = controller._inputFocused;
      controller._inputFocused = false;
      try { return updateDisplay(); }
      finally { controller._inputFocused = inputFocused; }
    };
  }
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
 * Label one control inside its stage folder: the visible label drops the
 * stage, and the widget's accessible name is the parameter's own name.
 * @param {GuiController} controller - The stage folder's controller.
 * @param {string} stage - The pipeline stage it was grouped under.
 * @param {string} name - Engine parameter name.
 * @returns {void}
 */
export function nameStageControl(controller, stage, name) {
  controller.name(stageControlLabel(stage, name));
  const widget = focusWidget(controller);
  if (!widget) return;
  widget.removeAttribute('aria-labelledby');
  widget.setAttribute('aria-label', name);
}
