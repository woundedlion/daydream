/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM-free parameter-stream logic for the effect panel: the per-frame
 * "fight-the-slider" poll decision, the parameter-definition to lil-gui control
 * mapping, the coercion setParameter expects, and the guards that decide whether
 * the engine's live value stream may be paired with the GUI's cached param-name
 * list at all. Extracted so every rule can be unit-tested without lil-gui, a
 * WASM module, or a browser, and so the panel reads them from one place.
 */

/**
 * Decide whether a single GUI controller should adopt the engine's latest value
 * for its parameter, and what value to write.
 *
 * The engine streams animation-driven parameter values back every frame; the
 * GUI should track them, but must never clobber a controller the user is
 * actively editing (a focused input or an in-progress drag), and should avoid a
 * redundant write when the value is unchanged.
 *
 * @param {number|boolean} current - The controller's current value
 *   (c.getValue()); a boolean for a toggle, a number for a slider.
 * @param {number} incoming - The engine's raw numeric value for this parameter.
 * @param {boolean} isBoolean - Whether the controller is a boolean toggle (the
 *   engine streams bools as 0/1 floats, thresholded at 0.5).
 * @param {boolean} isEditing - Whether the user is actively editing this
 *   controller (focused or dragging) — such a controller must not be overwritten.
 * @returns {{update: boolean, value: number|boolean}} Whether to write, and the
 *   coerced value to write (a boolean when isBoolean). `value` is always the
 *   coerced incoming value even when `update` is false, so callers never need to
 *   re-coerce.
 */
export function resolveParamSync(current, incoming, isBoolean, isEditing) {
  const value = isBoolean ? incoming > 0.5 : incoming;
  if (isEditing) return { update: false, value };
  // A NaN engine value would churn every frame (NaN !== current) and a boolean
  // coerces it to a spurious false; never write it.
  if (Number.isNaN(incoming)) return { update: false, value };
  return { update: current !== value, value };
}

/**
 * Which lil-gui control an engine parameter definition maps to. A boolean value
 * outranks an options list, so a flag that also carries labels stays a toggle,
 * and labels outrank a step, so an enum stays a dropdown, not a stepped slider.
 *
 * @param {{value: any, options?: any, step?: number}} param - An engine
 *   parameter definition.
 * @returns {'boolean'|'enum'|'integer'|'number'} The control kind to build.
 */
export function paramControlKind(param) {
  if (typeof param.value === 'boolean') return 'boolean';
  if (Array.isArray(param.options) && param.options.length > 0) return 'enum';
  if (param.step === 1) return 'integer';
  return 'number';
}

/**
 * Coerce a GUI value to the float setParameter expects. The engine takes every
 * parameter as a float, so a toggle's boolean becomes 1.0/0.0.
 *
 * @param {number|boolean} value - A controller value, or a URL-hydrated one.
 * @returns {number} The float to write.
 */
export function engineParamValue(value) {
  return (typeof value === 'boolean') ? (value ? 1.0 : 0.0) : value;
}

/**
 * @param {{value: *, requestedValue?: *}} parameter - Engine parameter definition.
 * @returns {*} The state an interactive selector must display.
 */
export function selectorControlValue(parameter) {
  return parameter.requestedValue ?? parameter.value;
}

/**
 * Build the lil-gui choices object for an enumerated engine parameter: option
 * label -> option index, the float value the engine expects from setParameter.
 *
 * @param {string[]} options - Option labels from the parameter definition,
 *   indexed by the engine-side option value.
 * @returns {Object<string, number>} Choices object for lil-gui's add().
 */
export function enumChoices(options) {
  /** @type {Object<string, number>} */
  const choices = {};
  options.forEach((label, i) => {
    // Duplicate labels would collapse to one object key, making the earlier
    // index unselectable; disambiguate rather than drop it.
    let key = label;
    // `in` would also see Object.prototype, renaming a label like `toString`
    // that collides with nothing.
    while (Object.hasOwn(choices, key)) key = `${key} (${i})`;
    choices[key] = i;
  });
  return choices;
}

/**
 * Whether the cached param-name list has drifted out of length with the engine's
 * per-frame value stream. A skew means the two can no longer be paired by index,
 * so syncGUI() and export() must skip rather than mis-bind sliders.
 * @param {number} namesLength - Length of the effect's cached paramNames list.
 * @param {number} valuesLength - Length of the engine's live value stream.
 * @returns {boolean} True when the lengths differ (do not pair them).
 */
export function paramValueSkew(namesLength, valuesLength) {
  return namesLength !== valuesLength;
}

/**
 * Why the Export action cannot copy the live parameter values, if it cannot. A
 * heap-growth detach leaves the value view zero-length, the segmented source is
 * null before the first frame, as is a read that no longer matches the GUI's
 * snapshot, and the copy operation can be absent in a non-browser host. Any of
 * those would copy an all-zero, foreign, or unwritable preset.
 * @param {ArrayLike<number>|null|undefined} values - The live value stream.
 * @param {number} expectedLength - Length of the effect's cached paramNames list.
 * @param {boolean} canCopy - Whether a clipboard copy operation is available.
 * @returns {string|null} The warning to log, or null when the copy may proceed.
 */
export function paramExportBlocker(values, expectedLength, canCopy) {
  if (!values || values.length === 0) {
    return 'Export: no parameter values matching the current effect; skipping copy';
  }
  if (paramValueSkew(expectedLength, values.length)) {
    return `Export: param/value length skew (${expectedLength} vs ${values.length}); skipping copy`;
  }
  if (!canCopy) return 'Export: clipboard copy unavailable';
  return null;
}

/**
 * Whether the engine's live value stream still describes the effect the GUI's
 * parameter-definition snapshot was taken from. The engine bumps a generation
 * counter on every effect load, so an unequal pair means a load landed between
 * the snapshot and this read and the values must not be bound by index. Length
 * alone cannot decide it: equal parameter counts are common across the roster,
 * so a switch between two same-sized effects passes paramValueSkew() while
 * describing different parameters.
 * @param {number|undefined} snapshotGeneration - Generation recorded when the
 *   parameter definitions were read.
 * @param {number|undefined} streamGeneration - Generation read alongside the values.
 * @returns {boolean} True when the two describe different effect loads.
 */
export function paramGenerationStale(snapshotGeneration, streamGeneration) {
  return snapshotGeneration !== streamGeneration;
}

/**
 * Name an engine enum value for a log message.
 * @param {Record<string, unknown>} values - A Module enum object, constant name
 *   to value.
 * @param {unknown} result - One of that enum's values.
 * @returns {string} The enum constant's name, e.g. "READONLY".
 */
export function enumConstantName(values, result) {
  return Object.keys(values).find((name) => values[name] === result)
    ?? 'unrecognized result';
}
