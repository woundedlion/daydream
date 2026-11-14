/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** lil-gui state read and written through its public DOM rather than its private fields. */

/**
 * Whether a lil-gui panel or folder is collapsed.
 * @param {{$title: HTMLElement}} gui - A lil-gui GUI or folder.
 * @returns {boolean} True once open(false) or close() collapsed it, including
 *   mid-animation.
 */
export function isClosed(gui) {
  return gui.$title.getAttribute('aria-expanded') === 'false';
}

/**
 * Make a read-only number control repaint its text box even while focused;
 * lil-gui otherwise leaves a focused input alone so typing is not overwritten.
 * @param {import('./effect_param_controls.js').GuiController} controller - A lil-gui
 *   NumberController; one without a text box is left unchanged.
 * @param {number} decimals - Digits after the point, as passed to decimals().
 * @returns {void}
 */
export function forceNumberDisplay(controller, decimals) {
  const input = controller.$input;
  if (!input) return;
  input.readOnly = true;
  const updateDisplay = controller.updateDisplay.bind(controller);
  controller.updateDisplay = () => {
    const result = updateDisplay();
    input.value = controller.getValue().toFixed(decimals);
    return result;
  };
}
