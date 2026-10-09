/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/*
 * The generative tab's authoritative recipe state: the loaded template, the
 * control readings applied over it, and the custom hue keys. The page's
 * controls are written from it and edit it only through its operations.
 */

import {
  applyPaletteControls, clampRecipeWindow, customHueKeyState,
  customHueSweepRepresentable, defaultPaletteRecipe, loopSweepTurns,
  movedHueKeyOffset, paletteControlsFromRecipe, paletteEnumOrdinal, wrapTurns,
} from './palette_controls.js';

/** @typedef {import('./palette_controls.js').PaletteRecipe} PaletteRecipe */
/** @typedef {import('./palette_controls.js').PaletteControlReadings} PaletteControlReadings */

/**
 * A read-only view of a value, all the way down: objects become read-only
 * properties and arrays become ReadonlyArray.
 * @template T
 * @typedef {T extends (infer E)[] ? ReadonlyArray<DeepReadonly<E>>
 *   : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T} DeepReadonly
 */

/** @typedef {'lightness'|'chroma'} PaletteAxisName */

/**
 * Readings a select carries as a PaletteV4 member name, mapped to the enum
 * group that names their members.
 */
const CHOICE_GROUPS = Object.freeze({
  domain: 'domain', easing: 'easing', colorPath: 'colorPath',
  harmony: 'harmony', direction: 'direction',
});

/** @typedef {keyof typeof CHOICE_GROUPS} PaletteChoiceReading */

/** @typedef {'spreadTurns'|'sweepTurns'|'headroom'|'hueTorsion'|'falloffStart'} PaletteAmountReading */

/** @typedef {PaletteChoiceReading|PaletteAmountReading|'hueMode'|'lightnessCurve'|'chromaCurve'|'baseTurns'} PaletteScalarReading */

const AMOUNT_READINGS = new Set(['spreadTurns', 'sweepTurns', 'headroom', 'hueTorsion', 'falloffStart']);

/** @type {Readonly<Record<PaletteAxisName, 'lightnessCurve'|'chromaCurve'>>} */
const AXIS_CURVE_READINGS = Object.freeze({
  lightness: 'lightnessCurve', chroma: 'chromaCurve',
});

/**
 * Copies `source` into `target` field by field, recursing into nested
 * objects and arrays `target` already holds.
 * @param {Record<string, any>} target - Object of the same shape as `source`.
 * @param {Record<string, any>} source - Values to copy.
 * @returns {void}
 */
function copyInto(target, source) {
  for (const key in source) {
    const value = source[key];
    if (value !== null && typeof value === 'object') copyInto(target[key], value);
    else target[key] = value;
  }
}

/**
 * @param {PaletteAxisName} axis - An axis name.
 * @returns {PaletteAxisName} The same name.
 * @throws {RangeError} When it names no recipe axis.
 */
function checkedAxis(axis) {
  if (!Object.hasOwn(AXIS_CURVE_READINGS, axis))
    throw new RangeError(`Unknown palette axis: ${axis}`);
  return axis;
}

/**
 * One mutable recipe, edited through named operations. Views returned by its
 * getters are valid until the next operation and allocate nothing;
 * `snapshot()` copies the recipe for a caller that keeps it.
 */
export class PaletteRecipeModel {
  /** @type {PaletteRecipe} */
  #template = defaultPaletteRecipe();

  /** @type {PaletteRecipe} */
  #current = defaultPaletteRecipe();

  /** @type {PaletteControlReadings} */
  #readings;

  /**
   * @param {PaletteRecipe} [recipe] - The recipe to start from; copied.
   */
  constructor(recipe = defaultPaletteRecipe()) {
    this.#readings = paletteControlsFromRecipe(this.#template);
    this.loadRecipe(recipe);
  }

  /**
   * Replaces the template and every reading with a recipe's own.
   * @param {DeepReadonly<PaletteRecipe>|PaletteRecipe} recipe - The recipe to load; copied.
   * @returns {void}
   * @throws {RangeError} When a field holds an ordinal PaletteV4 has no member for.
   */
  loadRecipe(recipe) {
    const template = /** @type {PaletteRecipe} */ (structuredClone(recipe));
    const readings = paletteControlsFromRecipe(template);
    this.#template = template;
    this.#current = structuredClone(template);
    copyInto(this.#readings, readings);
    this.#rebuild();
  }

  /** @returns {DeepReadonly<PaletteRecipe>} The recipe the readings describe. */
  recipe() {
    return this.#current;
  }

  /** @returns {PaletteRecipe} A detached copy of the recipe. */
  snapshot() {
    return structuredClone(this.#current);
  }

  /** @returns {ReadonlyArray<number>} The three custom hue keys' offsets from the base hue. */
  customHueOffsets() {
    return this.#readings.customHueOffsets;
  }

  /** @returns {number} The base hue, in turns. */
  get baseHueTurns() {
    return this.#readings.baseTurns;
  }

  /** @returns {DeepReadonly<{offset: number, span: number}>} The phase window. */
  get window() {
    return this.#readings.window;
  }

  /**
   * @param {PaletteAxisName} axis - Which axis.
   * @returns {DeepReadonly<{minimum: number, maximum: number}>} Its endpoint readings.
   */
  axisEndpoints(axis) {
    return this.#readings[checkedAxis(axis)];
  }

  /**
   * @param {PaletteScalarReading} name - A scalar PaletteControlReadings field.
   * @returns {string|number} Its value: a PaletteV4 member name for a select,
   *   a number for a slider.
   */
  reading(name) {
    return this.#readings[name];
  }

  /**
   * Sets a reading a select holds.
   * @param {PaletteChoiceReading} name - Which reading.
   * @param {string} member - A PaletteV4 member name of its group.
   * @returns {void}
   * @throws {RangeError} When `name` is not a choice reading or `member` names no member.
   */
  setChoice(name, member) {
    if (!Object.hasOwn(CHOICE_GROUPS, name))
      throw new RangeError(`Not a palette choice reading: ${name}`);
    paletteEnumOrdinal(CHOICE_GROUPS[name], member);
    this.#readings[name] = member;
    this.#rebuild();
  }

  /**
   * Sets a reading a slider holds, in the recipe's own units.
   * @param {PaletteAmountReading} name - Which reading.
   * @param {number} value - Its new value.
   * @returns {void}
   * @throws {RangeError} When `name` is not an amount reading.
   */
  setAmount(name, value) {
    if (!AMOUNT_READINGS.has(name))
      throw new RangeError(`Not a palette amount reading: ${name}`);
    this.#readings[name] = value;
    this.#rebuild();
  }

  /**
   * @param {number} turns - The base hue, in turns; wrapped into [0, 1).
   * @returns {void}
   */
  setBaseHue(turns) {
    this.#readings.baseTurns = wrapTurns(turns);
    this.#rebuild();
  }

  /**
   * @param {number} delta - Turns to move the base hue by.
   * @returns {void}
   */
  nudgeBaseHue(delta) {
    this.setBaseHue(this.#readings.baseTurns + delta);
  }

  /**
   * Sets the phase window. The span is held to [0.01, 1] and limits the
   * offset, so the window never runs past the end.
   * @param {number} offset - Where the window starts.
   * @param {number} span - How much of the palette it covers.
   * @returns {void}
   */
  setWindow(offset, span) {
    const clamped = clampRecipeWindow(offset, span);
    this.#readings.window.offset = clamped.offset;
    this.#readings.window.span = clamped.span;
    this.#rebuild();
  }

  /**
   * Sets an axis curve. A CONSTANT curve has one value, so its endpoints
   * collapse onto their midpoint.
   * @param {PaletteAxisName} axis - Which axis.
   * @param {string} curve - A PaletteV4.curve member name.
   * @returns {void}
   * @throws {RangeError} When `curve` names no member.
   */
  setAxisCurve(axis, curve) {
    paletteEnumOrdinal('curve', curve);
    this.#readings[AXIS_CURVE_READINGS[checkedAxis(axis)]] = curve;
    if (curve === 'CONSTANT') {
      const endpoints = this.#readings[axis];
      const center = (endpoints.minimum + endpoints.maximum) * 0.5;
      endpoints.minimum = center;
      endpoints.maximum = center;
    }
    this.#rebuild();
  }

  /**
   * Sets an axis' endpoints. Under a CONSTANT curve the minimum is the axis'
   * one value and both endpoints take it.
   * @param {PaletteAxisName} axis - Which axis.
   * @param {number} minimum - The minimum endpoint.
   * @param {number} maximum - The maximum endpoint.
   * @returns {void}
   */
  setAxisEndpoints(axis, minimum, maximum) {
    const endpoints = this.#readings[checkedAxis(axis)];
    endpoints.minimum = minimum;
    endpoints.maximum = this.#readings[AXIS_CURVE_READINGS[axis]] === 'CONSTANT'
      ? minimum : maximum;
    this.#rebuild();
  }

  /**
   * Switches the hue mode. Entering CUSTOM from another mode is the CUSTOM
   * handoff (activateCustomHues).
   * @param {string} mode - A PaletteV4.hueMode member name.
   * @returns {boolean} False when the handoff was refused and the mode kept.
   * @throws {RangeError} When `mode` names no member.
   */
  applyHueModeTransition(mode) {
    paletteEnumOrdinal('hueMode', mode);
    if (mode === this.#readings.hueMode) return true;
    if (mode === 'CUSTOM') return this.activateCustomHues();
    this.#readings.hueMode = mode;
    this.#rebuild();
    return true;
  }

  /**
   * Switches into CUSTOM hue mode, authoring three keys resampled from the
   * recipe in its current hue mode (customHueKeyState).
   * @returns {boolean} False, changing nothing, when three keys cannot
   *   preserve a LOOP sweep's closing hue (customHueSweepRepresentable).
   */
  activateCustomHues() {
    if (!customHueSweepRepresentable(this.#current)) return false;
    const state = customHueKeyState(this.#current);
    copyInto(this.#readings.customHueOffsets, state.offsets);
    this.#readings.baseTurns = state.baseTurns;
    this.#readings.hueMode = 'CUSTOM';
    this.#rebuild();
    return true;
  }

  /**
   * Moves one custom hue key onto a turn (movedHueKeyOffset).
   * @param {number} keyIndex - Which key.
   * @param {number} wrappedTurn - The hue it moves onto, in [0, 1).
   * @returns {void}
   */
  moveHueKey(keyIndex, wrappedTurn) {
    const offsets = this.#readings.customHueOffsets;
    offsets[keyIndex] = movedHueKeyOffset(this.#readings.baseTurns, offsets[keyIndex], wrappedTurn);
    this.#rebuild();
  }

  /**
   * @param {number} keyIndex - Which custom hue key.
   * @param {number} delta - Turns to move it by.
   * @returns {void}
   */
  nudgeHueKey(keyIndex, delta) {
    const base = this.#readings.baseTurns;
    this.moveHueKey(keyIndex,
      wrapTurns(base + this.#readings.customHueOffsets[keyIndex] + delta));
  }

  /**
   * Re-derives the recipe from the template and readings in place. A LOOP
   * domain under SWEEP closes on a whole turn, so its sweep reading is rounded.
   * @returns {void}
   */
  #rebuild() {
    const readings = this.#readings;
    if (readings.domain === 'LOOP' && readings.hueMode === 'SWEEP')
      readings.sweepTurns = loopSweepTurns(readings.sweepTurns);
    copyInto(this.#current, this.#template);
    applyPaletteControls(this.#current, readings);
  }
}
