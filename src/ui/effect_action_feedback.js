/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// How long a transient button label (Export status) stays before reverting.
export const FLASH_MS = 1500;
// Transient Export button labels.
export const EXPORT_COPIED = '\u2713 Copied!';
export const EXPORT_FAILED = '\u2717 Copy failed';
export const EXPORT_REFUSED = '\u2717 Export failed';
const EXPORT_ICON = '\u29c9';

/** @typedef {import('./effect_param_controls.js').GuiController} GuiController */
/** @typedef {import('./effect_param_controls.js').Gui} Gui */

/**
 * @param {{gui: Gui}} fx
 * @param {import('./effect_actions.js').EffectActionDeps} deps
 * @param {() => GuiController} getController
 * @param {() => HTMLElement} getStatus
 */
export function createActionFeedback(fx, deps, getController, getStatus) {
  const {buildExport, copyText, isActive, logWarn, showNotice} = deps;
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let flashTimer;
  /**
   * Flash a transient status label on the Export button and announce it in the
   * action row's live region, restoring the default label after the flash
   * window. Supersedes any flash still pending for this row.
   * @param {string} label - The transient button label to show.
   * @returns {void}
   */
  function flashExport(label) {
    const exportCtrl = getController();
    const exportStatus = getStatus();
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
 * Copy text and report the outcome through Export feedback and notices. A
 * copy that lands after the record was replaced reports nothing.
 * @param {string} text - The text to copy.
 * @returns {Promise<void>} Clipboard completion.
 */
  function copyAndFlash(text) {
    return copyText(text).then((copied) => {
      if (!isActive(fx)) return;
      if (copied) {
        showNotice(null);
        flashExport(EXPORT_COPIED);
      } else {
        logWarn('Export: clipboard copy failed');
        showNotice('Export: clipboard copy failed');
        flashExport(EXPORT_FAILED);
      }
    }).catch((err) => {
      logWarn('Export: clipboard copy failed', err);
      if (isActive(fx)) {
        showNotice('Export: clipboard copy failed');
        flashExport(EXPORT_FAILED);
      }
    });
  }

/** @returns {Promise<void>|void} Clipboard completion, or nothing when blocked. */
  function exportAndFlash() {
    const result = buildExport();
    if ('error' in result) {
      if (result.cause === undefined) logWarn(result.error);
      else logWarn(result.error, result.cause);
      showNotice(result.error);
      flashExport(EXPORT_REFUSED);
      return;
    }
    return copyAndFlash(result.text);
  }
  return {exportAndFlash, cancel() {clearTimeout(flashTimer); flashTimer = undefined;}};
}

/** @param {GuiController} controller @param {string} icon @param {string} label */
export function presentAction(controller, icon, label) {
  controller.name(icon);
  const button = controller.$button ?? controller.domElement;
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);
}
