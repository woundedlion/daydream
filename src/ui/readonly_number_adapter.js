/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * lil-gui 0.21.0 suppresses focused number-input updates through `_inputFocused`.
 * @param {import('./effect_param_controls.js').GuiController} controller
 */
export function updateReadonlyNumber(controller) {
  const updateDisplay = controller.updateDisplay.bind(controller);
  controller.updateDisplay = () => {
    const inputFocused = controller._inputFocused;
    controller._inputFocused = false;
    try { return updateDisplay(); }
    finally { controller._inputFocused = inputFocused; }
  };
}
