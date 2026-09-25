/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Wires a button-controlled flyout with outside-click and Escape dismissal.
 * CSS may additionally expose the panel on hover.
 * @param {object} options - Flyout elements and event target.
 * @param {HTMLElement} options.root - Element receiving the open-state class.
 * @param {HTMLButtonElement} options.trigger - Button controlling the flyout.
 * @param {Document|EventTarget} [options.documentTarget=document] - Outside-click target.
 * @returns {() => void} Removes listeners and closes the flyout.
 */
export function wireFlyout({ root, trigger, documentTarget = document }) {
  /**
   * @param {boolean} open - Whether the panel is exposed.
   * @returns {void}
   */
  const setOpen = (open) => {
    root.classList.toggle('is-open', open);
    trigger.setAttribute('aria-expanded', String(open));
  };

  const toggle = () => {
    setOpen(trigger.getAttribute('aria-expanded') !== 'true');
  };

  /**
   * @param {Event} event - The pointerdown that may fall outside the flyout.
   * @returns {void}
   */
  const dismissOutside = (event) => {
    if (!root.contains(/** @type {Node} */ (event.target))) setOpen(false);
  };

  /**
   * @param {KeyboardEvent} event - The keydown that may be Escape.
   * @returns {void}
   */
  const dismissWithEscape = (event) => {
    if (event.key !== 'Escape') return;
    setOpen(false);
    trigger.focus();
  };

  setOpen(false);
  trigger.addEventListener('click', toggle);
  root.addEventListener('keydown', dismissWithEscape);
  documentTarget.addEventListener('pointerdown', dismissOutside);

  return () => {
    trigger.removeEventListener('click', toggle);
    root.removeEventListener('keydown', dismissWithEscape);
    documentTarget.removeEventListener('pointerdown', dismissOutside);
    setOpen(false);
  };
}
