/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The effect panel's action row: Reset, Export with its clipboard outcome, and
 * preset selection and navigation.
 */

import { enumChoices } from "../effects/param_sync.js";

/** @typedef {import("./effect_param_controls.js").GuiController} GuiController */
/** @typedef {import("./effect_param_controls.js").Gui} Gui */
/** @typedef {{text: string} | {error: string, cause?: unknown}} ExportResult */
/**
 * Services and coordinator callbacks the action row runs on.
 * @typedef {Object} EffectActionDeps
 * @property {{count: () => number, index: () => number, select: (index: number) => boolean}} presets -
 *   The live effect's presets.
 * @property {(count: number, index: number) => void} onPresetChange - Runs after
 *   a preset selection the engine accepted.
 * @property {() => void} onReset - Reinstalls the effect at defaults (the Reset button).
 * @property {() => ExportResult} buildExport - The text Export copies, or why it cannot.
 * @property {(text: string) => Promise<boolean>} copyText - Copies text to the clipboard.
 * @property {(fx: {gui: Gui}) => boolean} isActive - Whether a record is still the
 *   published one.
 * @property {(message: string, error?: unknown) => void} logWarn - Console sink.
 */
/**
 * @typedef {Object} EffectActions
 * @property {(delta: number) => boolean} movePreset - Selects a preset relative
 *   to the live one.
 * @property {() => number|null} displayedPresetIndex - The preset the selector
 *   shows, or null without presets.
 * @property {(count: number, index: number) => void} showPreset - Shows a preset
 *   index on the selector without selecting it.
 * @property {() => boolean} hasPresets - Whether the row carries preset controls.
 * @property {() => Array<[string, GuiController]>} focusTargets - Every action
 *   controller keyed by its bound property.
 * @property {() => void} cancel - Cancels the pending Export label revert.
 * @property {() => void} detach - Returns the controllers to the GUI's own
 *   children and removes the row; must run before the GUI is destroyed.
 */

// How long a transient button label (Export status) stays before reverting.
export const FLASH_MS = 1500;
// Transient Export button labels.
export const EXPORT_COPIED = '\u2713 Copied!';
export const EXPORT_FAILED = '\u2717 Copy failed';
const EXPORT_ICON = '\u29c9';
const RESET_ICON = '\u21ba';
const PREVIOUS_ICON = '\u25c0';
const NEXT_ICON = '\u25b6';

/**
 * Build one panel's action row into its GUI.
 * @param {{gui: Gui}} fx - The effect record whose GUI hosts the row.
 * @param {EffectActionDeps} deps
 * @returns {EffectActions}
 */
export function createEffectActions(fx, deps) {
  const { presets, onPresetChange, onReset, buildExport, copyText, isActive, logWarn } = deps;
  const { gui } = fx;
  /** @type {GuiController[]} */
  let controllers = [];
  /** @type {HTMLElement|null} */
  let actionRow = null;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let flashTimer;
  /** @type {GuiController|null} */
  let presetController = null;
  /** @type {{reset: () => void, export: () => Promise<void>|void, presetIndex?: number, previousPreset?: () => boolean, nextPreset?: () => boolean}} */
  const state = {
    reset() { onReset(); },
    export() { return exportAndFlash(); },
  };

  /** @param {GuiController} controller @param {string} icon @param {string} label */
  const presentAction = (controller, icon, label) => {
    controller.name(icon);
    const button = controller.$button ?? controller.domElement;
    button.setAttribute('aria-label', label);
    button.setAttribute('title', label);
  };

  /** @type {GuiController} */
  let exportCtrl;
  /** @type {HTMLElement} */
  let exportStatus;

  /**
   * Flash a transient status label on the Export button and announce it in the
   * action row's live region, restoring the default label after the flash
   * window. Supersedes any flash still pending for this row.
   * @param {string} label - The transient button label to show.
   * @returns {void}
   */
  function flashExport(label) {
    clearTimeout(flashTimer);
    presentAction(exportCtrl, label === EXPORT_COPIED ? '\u2713' : '\u2717', label);
    // A changed live-region string re-announces repeated messages.
    exportStatus.textContent = exportStatus.textContent === label
      ? `${label}\u200B` : label;
    flashTimer = setTimeout(() => {
      presentAction(exportCtrl, EXPORT_ICON, 'Export');
      exportStatus.textContent = '';
    }, FLASH_MS);
  }

  /**
   * Copy text to the clipboard and report the outcome on the Export label. A
   * copy that lands after the record was replaced reports nothing.
   * @param {string} text - The text to copy.
   * @returns {Promise<void>} Clipboard completion.
   */
  function copyAndFlash(text) {
    return copyText(text).then((copied) => {
      if (!isActive(fx)) return;
      if (copied) {
        flashExport(EXPORT_COPIED);
      } else {
        logWarn('Export: clipboard copy failed');
        flashExport(EXPORT_FAILED);
      }
    }).catch((err) => {
      logWarn('Export: clipboard copy failed', err);
      if (isActive(fx)) flashExport(EXPORT_FAILED);
    });
  }

  /** @returns {Promise<void>|void} Clipboard completion, or nothing when blocked. */
  function exportAndFlash() {
    const result = buildExport();
    if ('error' in result) {
      if (result.cause === undefined) logWarn(result.error);
      else logWarn(result.error, result.cause);
      flashExport(EXPORT_FAILED);
      return;
    }
    return copyAndFlash(result.text);
  }

  /** @param {number} count @param {number} index */
  function showPreset(count, index) {
    if (!presetController || count <= 0) return;
    if (state.presetIndex === index) return;
    state.presetIndex = index;
    presetController.updateDisplay();
  }

  /** @param {number} index @returns {boolean} */
  function choose(index) {
    const count = presets.count();
    if (count <= 0 || !presets.select(index)) {
      showPreset(count, presets.index());
      return false;
    }
    onPresetChange(count, index);
    return true;
  }

  /** @param {number} delta @returns {boolean} */
  function move(delta) {
    const count = presets.count();
    if (count <= 0) return false;
    return choose((presets.index() + delta + count) % count);
  }

  function cancel() {
    clearTimeout(flashTimer);
    flashTimer = undefined;
  }

  function detach() {
    // Controller.destroy() removes each domElement from the GUI's own children
    // container; one parented elsewhere throws NotFoundError mid-destroy.
    for (const controller of controllers) gui.appendElement(controller.domElement);
    controllers = [];
    actionRow?.remove();
    actionRow = null;
  }

  /**
   * @param {string} property @param {string} icon @param {string} label
   * @param {string} className @returns {GuiController}
   */
  const addAction = (property, icon, label, className) => {
    const controller = gui.add(state, property);
    controller.domElement.classList.add('effect-action', className);
    presentAction(controller, icon, label);
    /** @type {HTMLElement} */ (actionRow).appendChild(controller.domElement);
    controllers.push(controller);
    return controller;
  };

  try {
    const ownerDocument = gui.domElement.ownerDocument;
    const row = ownerDocument.createElement('div');
    actionRow = row;
    row.classList.add('effect-action-row');
    gui.appendElement(row);
    exportStatus = ownerDocument.createElement('span');
    exportStatus.className = 'visually-hidden';
    exportStatus.setAttribute('role', 'status');
    exportStatus.setAttribute('aria-live', 'polite');
    row.appendChild(exportStatus);
    addAction('reset', RESET_ICON, 'Reset', 'effect-action-reset');
    exportCtrl = addAction('export', EXPORT_ICON, 'Export', 'effect-action-export');
    const presetCount = presets.count();
    if (presetCount > 0) {
      state.presetIndex = presets.index();
      const presetOptions = enumChoices(
        Array.from({ length: presetCount }, (_, index) => String(index + 1)));
      const preset = gui.addSession(state, 'presetIndex', presetOptions).name('Preset');
      presetController = preset;
      preset.onChange(choose);
      state.previousPreset = () => move(-1);
      state.nextPreset = () => move(1);
      addAction('previousPreset', PREVIOUS_ICON, 'Previous Preset', 'preset-nav-previous');
      preset.domElement.classList.add('effect-action', 'preset-nav-selector');
      row.appendChild(preset.domElement);
      controllers.push(preset);
      addAction('nextPreset', NEXT_ICON, 'Next Preset', 'preset-nav-next');
    }
    row.style.gridTemplateColumns = `repeat(${controllers.length}, minmax(0, 1fr))`;
  } catch (error) {
    detach();
    throw error;
  }

  return {
    movePreset: (delta) => (presetController ? move(delta) : false),
    displayedPresetIndex: () => (presetController ? state.presetIndex ?? null : null),
    showPreset,
    hasPresets: () => presetController !== null,
    focusTargets: () => controllers.map((controller) => [controller.property, controller]),
    cancel,
    detach,
  };
}
