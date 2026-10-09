/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/*
 * The generative tab's hue-key wheel: which key is selected and which is
 * being dragged, the markers last drawn, the off-screen slider handles, and
 * the CUSTOM handoff a key edit starts from another hue mode.
 */

import { createSliderProxy } from '../../shared/slider.js';
import { createPointerDrag, innerRect } from '../../shared/pointer_drag.js';
import {
  PaletteV4, customHueKeyState, customHueSweepRepresentable, hitTestHueKeyMarker,
  hueKeyState,
} from './palette_controls.js';
import {
  HUE_KEY_GRAB_RADIUS, HUE_KEY_NAMES, canvasPoint, hueKeyHandoff, hueKeyNudgeTurns,
  wheelTurnAt,
} from './palette_wheel.js';

/** @typedef {import('./palette_controls.js').PaletteRecipe} PaletteRecipe */
/** @typedef {import('./palette_recipe_model.js').PaletteRecipeModel} PaletteRecipeModel */
/** @typedef {import('./palette_recipe_model.js').DeepReadonly<PaletteRecipe>} RecipeView */
/** @typedef {ReturnType<typeof import('./palette_wheel.js').createHueKeyWheelPainter>} HueKeyWheelPainter */

const SWEEP_REFUSAL = 'This loop sweep cannot be preserved by three custom hue keys. '
  + 'Reduce the sweep before switching to CUSTOM.';
const KEY_REFUSAL = 'This hue key is omitted when these keys are resampled to three '
  + 'custom keys. Choose another key.';

/**
 * @typedef {object} HueKeyWheel
 * @property {(recipe: RecipeView) => void} draw - Paints the wheel for a
 *   recipe, as compiled; a CUSTOM recipe draws the model's own keys.
 * @property {(mode: string) => void} onHueModeChange - Applies a hue mode the
 *   distribution select chose; entering CUSTOM resamples the keys from the
 *   first one, and a refused handoff keeps the previous mode.
 * @property {(event: KeyboardEvent) => void} onBaseHueKeyDown - Steps the base
 *   hue from its slider's arrow keys.
 * @property {() => void} clearStatus - Clears a handoff refusal message.
 * @property {() => void} dispose - Removes the pointer drag and the key handles.
 */

/**
 * Wires the hue-key wheel to one recipe model.
 * @param {object} options - Wheel wiring.
 * @param {PaletteRecipeModel} options.model - The recipe the keys edit.
 * @param {() => void} options.scheduleUpdate - Requests a redraw.
 * @param {() => void} options.onRecipeChange - Called after the wheel changed
 *   the recipe, so the page can rewrite its controls.
 * @param {HTMLCanvasElement} options.canvas - The wheel canvas.
 * @param {HTMLElement} options.group - The wheel's role="group" wrapper the
 *   key handles join.
 * @param {HTMLElement} options.status - Element handoff refusals are reported in.
 * @param {Pick<HueKeyWheelPainter, 'draw'>} options.painter - Paints the wheel.
 * @returns {HueKeyWheel} The wheel.
 */
export function createHueKeyWheel({ model, scheduleUpdate, onRecipeChange, canvas, group, status, painter }) {
  /** @type {Array<{x: number, y: number}>} */
  let drawnPoints = [];
  let drawnScale = 1;
  /** @type {number|null} */
  let activeKey = null;
  let selectedKey = 0;
  /** @type {{baseTurns: number, offsets: ReadonlyArray<number>}} */
  const customState = { baseTurns: 0, offsets: [] };

  /**
   * Switches the recipe into CUSTOM hue mode, authoring the three keys the
   * handoff starts from.
   * @returns {boolean} False when resampling cannot preserve the selected key
   *   or the LOOP sweep's closing hue.
   */
  const activateCustomHue = () => {
    const source = /** @type {PaletteRecipe} */ (model.recipe());
    if (!customHueSweepRepresentable(source)) {
      status.textContent = SWEEP_REFUSAL;
      return false;
    }
    const handoff = hueKeyHandoff(hueKeyState(source), customHueKeyState(source),
      selectedKey, activeKey);
    selectedKey = handoff.selectedKey;
    if (!handoff.kept) {
      status.textContent = KEY_REFUSAL;
      return false;
    }
    status.textContent = '';
    model.activateCustomHues();
    activeKey = handoff.activeKey;
    onRecipeChange();
    return true;
  };

  /** @returns {boolean} Whether the recipe is, or now is, in CUSTOM hue mode. */
  const ensureCustomHue = () =>
    model.recipe().hue.mode === PaletteV4.hueMode.CUSTOM || activateCustomHue();

  /** @type {HTMLElement[]} */
  let handles = [];

  /**
   * @param {number[]} degrees - Every drawn key's hue, in whole degrees.
   * @returns {void}
   */
  const syncHandles = (degrees) => {
    handles.forEach((handle, index) => {
      if (index < degrees.length) {
        handle.hidden = false;
        handle.setAttribute('aria-valuenow', String(degrees[index]));
        handle.setAttribute('aria-valuetext', `${degrees[index]} degrees`);
        return;
      }
      if (handle === document.activeElement && degrees.length > 0)
        handles[degrees.length - 1].focus();
      handle.hidden = true;
    });
  };

  /**
   * @param {RecipeView} recipe - The recipe to paint.
   * @returns {void}
   */
  const draw = (recipe) => {
    let state;
    if (recipe.hue.mode === PaletteV4.hueMode.CUSTOM) {
      customState.baseTurns = model.baseHueTurns;
      customState.offsets = model.customHueOffsets();
      state = customState;
    } else {
      state = hueKeyState(/** @type {PaletteRecipe} */ (recipe));
    }
    let lightness = recipe.lightness.center;
    if (recipe.lightness.curve === PaletteV4.curve.CUSTOM) {
      const count = Math.min(state.offsets.length, recipe.lightness.custom.length);
      let sum = 0;
      for (let i = 0; i < count; i++) sum += recipe.lightness.custom[i];
      lightness = sum / count;
    }
    const drawn = painter.draw({
      lightness, state: /** @type {{baseTurns: number, offsets: number[]}} */ (state),
      activeKey, selectedKey,
    });
    drawnPoints = drawn.points;
    drawnScale = drawn.scale;
    selectedKey = Math.min(selectedKey, drawn.points.length - 1);
    syncHandles(drawn.degrees);
  };

  /**
   * Nudges one hue key from its own slider handle.
   * @param {KeyboardEvent} event - The handle's keydown.
   * @param {number} keyIndex - Which key the handle stands for.
   * @returns {void}
   */
  const nudgeKey = (event, keyIndex) => {
    const delta = hueKeyNudgeTurns(event.key, event.shiftKey);
    if (delta === null) return;
    event.preventDefault();
    selectedKey = keyIndex;
    if (!ensureCustomHue()) {
      scheduleUpdate();
      return;
    }
    if (selectedKey !== keyIndex) {
      draw(model.recipe());
      handles[selectedKey].focus();
    }
    model.nudgeHueKey(selectedKey, delta);
    scheduleUpdate();
  };

  handles = HUE_KEY_NAMES.map((name, index) => {
    const handle = createSliderProxy({ label: `Hue key ${name}`, min: 0, max: 360,
      keys: 'ArrowLeft ArrowRight ArrowUp ArrowDown '
        + 'Shift+ArrowLeft Shift+ArrowRight Shift+ArrowUp Shift+ArrowDown' });
    handle.hidden = true;
    handle.addEventListener('focus', () => {
      selectedKey = index;
      scheduleUpdate();
    });
    handle.addEventListener('keydown', (event) => nudgeKey(event, index));
    group.appendChild(handle);
    return handle;
  });

  /**
   * @param {PointerEvent} event - A pointer event over the wheel.
   * @returns {{x: number, y: number}} Its position in canvas pixels.
   */
  const pointerPosition = (event) => canvasPoint(event.clientX, event.clientY,
    innerRect(canvas), canvas.width, canvas.height);

  /**
   * @param {PointerEvent} event - A pointer event over the wheel.
   * @returns {number|null} The marker under it.
   */
  const markerAt = (event) => {
    const position = pointerPosition(event);
    return hitTestHueKeyMarker(position.x, position.y, drawnPoints,
      HUE_KEY_GRAB_RADIUS * drawnScale);
  };

  const drag = createPointerDrag({
    element: canvas,
    onStart: (event) => {
      activeKey = markerAt(event);
      if (activeKey === null) return false;
      selectedKey = activeKey;
      canvas.style.cursor = 'grabbing';
      scheduleUpdate();
      return true;
    },
    onMove: (event) => {
      if (!ensureCustomHue()) {
        drag.stop();
        return;
      }
      if (activeKey === null) return;
      const position = pointerPosition(event);
      model.moveHueKey(activeKey,
        wheelTurnAt(position.x, position.y, canvas.width, canvas.height));
      scheduleUpdate();
    },
    onHover: (event) => {
      canvas.style.cursor = markerAt(event) === null ? 'default' : 'grab';
    },
    onEnd: () => {
      activeKey = null;
      canvas.style.cursor = 'default';
      scheduleUpdate();
    },
  });

  return {
    draw,
    onHueModeChange(mode) {
      if (mode === 'CUSTOM' && model.reading('hueMode') !== 'CUSTOM') {
        selectedKey = 0;
        activeKey = null;
        activateCustomHue();
      } else {
        model.applyHueModeTransition(mode);
      }
    },
    onBaseHueKeyDown(event) {
      const delta = hueKeyNudgeTurns(event.key, event.shiftKey);
      if (delta === null) return;
      event.preventDefault();
      model.nudgeBaseHue(delta);
      onRecipeChange();
      scheduleUpdate();
    },
    clearStatus() {
      status.textContent = '';
    },
    dispose() {
      drag.remove();
      for (const handle of handles) handle.remove();
      handles = [];
    },
  };
}
