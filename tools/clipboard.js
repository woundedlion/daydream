/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Dependency-free clipboard helpers for the tool pages.
 *
 * Kept separate from shared.js (the Three.js scene setup) so non-3D pages —
 * e.g. palettes.html — can use the copy helpers without pulling Three.js into
 * their module graph. shared.js re-exports these for its scene-based callers.
 */

/**
 * Copy text to the clipboard using the async Clipboard API, falling back to
 * the legacy execCommand path for non-secure contexts / older browsers.
 *
 * Feedback (button labels, "Copied!" spans, etc.) is left to the caller so
 * each tool keeps its own UI; this only performs the copy.
 *
 * @param {string} text - Text to copy
 * @returns {Promise<boolean>} Whether the copy succeeded
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (err) {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

/**
 * Copy `text`, then briefly swap an element's label to a "copied" message
 * (optionally toggling CSS classes) and restore it after `revertMs`. Shared
 * transient-feedback wrapper around copyToClipboard so tools don't each
 * reimplement it.
 *
 * @param {string} text - Text to copy.
 * @param {Object} [opts] - Feedback options.
 * @param {HTMLElement} [opts.element] - Element whose label flips on success.
 * @param {string} [opts.copiedText='Copied!'] - Label shown while copied.
 * @param {string} [opts.revertText] - Label to restore (default: current text).
 * @param {number} [opts.revertMs=1500] - How long the copied label stays.
 * @param {string[]} [opts.copiedClasses=[]] - Classes added while copied, removed on revert.
 * @param {string[]} [opts.idleClasses=[]] - Classes removed while copied, restored on revert (only if there is text to restore).
 * @returns {Promise<boolean>} Whether the copy succeeded.
 */
export async function copyWithFeedback(text, opts = {}) {
  const {
    element,
    copiedText = 'Copied!',
    revertText,
    revertMs = 1500,
    copiedClasses = [],
    idleClasses = [],
  } = opts;

  const success = await copyToClipboard(text);
  if (success && element) {
    const pending = element._copyFeedback;
    if (pending) clearTimeout(pending.timer);
    const original = pending ? pending.original
      : (revertText !== undefined ? revertText : element.textContent);
    element.textContent = copiedText;
    if (copiedClasses.length) element.classList.add(...copiedClasses);
    if (idleClasses.length) element.classList.remove(...idleClasses);
    const timer = setTimeout(() => {
      element.textContent = original;
      if (copiedClasses.length) element.classList.remove(...copiedClasses);
      if (idleClasses.length && original) element.classList.add(...idleClasses);
      delete element._copyFeedback;
    }, revertMs);
    element._copyFeedback = { timer, original };
  }
  return success;
}

/**
 * Default copied/idle color classes for the tool pages' copy prompts, so each
 * page doesn't redeclare the same literal. Spread into a copyWithFeedback opts
 * object: `copyWithFeedback(text, { element, revertText: '', ...COPY_FEEDBACK })`.
 */
export const COPY_FEEDBACK = {
  copiedClasses: ['text-green-400'],
  idleClasses: ['text-gray-500'],
};
