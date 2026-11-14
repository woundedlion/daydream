/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { parseUrlBoolean, parseUrlNumber } from '../app/state.js';

/**
 * Extracts the set of values lil-gui will accept for an enumerated control
 * (`add(obj, prop, $1)`): an array of choices, or an object whose values are the
 * choices. Anything else ($1 a number meaning a slider's min, or absent) is not
 * enumerated.
 * @param {unknown} options - The third argument passed to lil-gui's add().
 * @returns {(unknown[]|null)} The list of allowed choices, or null when not enumerated.
 */
export const optionValues = (options) => {
  if (Array.isArray(options)) return options;
  if (options && typeof options === 'object') return Object.values(options);
  return null;
};

/**
 * Clamps and snaps a numeric URL value to a controller's range.
 * @param {number} raw - Parsed URL number.
 * @param {unknown[]} args - Controller min, max and step arguments.
 * @returns {{value: number, rewrite: boolean}} Corrected value and rewrite flag.
 */
export function clampSnap(raw, args) {
  let numeric = raw;
  const min = args[0], max = args[1], step = args[2];
  if (typeof min === 'number' && numeric < min) numeric = min;
  if (typeof max === 'number' && numeric > max) numeric = max;
  if (typeof step === 'number' && Number.isFinite(step) && step > 0) {
    const anchor = typeof min === 'number' ? min : 0;
    numeric = anchor + Math.round((numeric - anchor) / step) * step;
    if (typeof min === 'number' && numeric < min) numeric = min;
    if (typeof max === 'number' && numeric > max) numeric = max;
  }
  const snapTol = typeof step === 'number' && Number.isFinite(step) && step > 0 ? Math.abs(step) * 1e-6 : 0;
  return { value: numeric, rewrite: Math.abs(numeric - raw) > snapTol };
}

/**
 * Resolves exact enum values before their string representations.
 * @param {unknown} value - Proposed value.
 * @param {unknown[]} allowed - Allowed enum values.
 * @returns {{index: number, duplicate: boolean}} Match index and duplicate warning flag.
 */
export function resolveEnum(value, allowed) {
  const duplicate = new Set(allowed.map(String)).size !== allowed.length;
  let index = allowed.indexOf(value);
  if (index < 0) index = allowed.findIndex(opt => String(opt) === String(value));
  return { index, duplicate };
}

/** @typedef {'non-numeric'|'boolean'|'duplicate'|'range'} HydrationWarning */
/** @typedef {{kind: 'absent'|'applied'|'fallback'|'ignored', value: unknown, rewrite: boolean, warning?: {raw: string, reasons: HydrationWarning[]}}} Hydration */

/**
 * Resolves a URL value against the bound value and controller arguments.
 * @param {{raw: string|null, current: unknown, args: unknown[]}} input - Hydration inputs.
 * @returns {Hydration} Bound value, replay state and URL correction.
 */
export function hydrate({ raw, current, args }) {
  if (raw === null || typeof current === 'function') return { kind: 'absent', value: current, rewrite: false };
  /** @type {Hydration} */
  const result = { kind: 'applied', value: raw, rewrite: false };
  /** @type {HydrationWarning[]} */
  const reasons = [];
  if (typeof current === 'number') {
    const num = parseUrlNumber(raw);
    if (num === null) {
      reasons.push('non-numeric');
      result.value = current;
      result.kind = 'fallback';
      result.rewrite = true;
    } else {
      Object.assign(result, clampSnap(num, args));
    }
  } else if (typeof current === 'boolean') {
    const flag = parseUrlBoolean(raw);
    if (flag === null) {
      reasons.push('boolean');
      result.value = current;
      result.kind = 'fallback';
      result.rewrite = true;
    } else {
      result.value = flag;
    }
  }
  const allowed = optionValues(args[0]);
  if (allowed) {
    const resolved = resolveEnum(result.value, allowed);
    if (resolved.duplicate) reasons.push('duplicate');
    if (resolved.index < 0) {
      reasons.push('range');
      result.value = current;
      result.kind = 'ignored';
      result.rewrite = true;
    } else {
      result.value = allowed[resolved.index];
    }
  }
  if (reasons.length) result.warning = { raw, reasons };
  return result;
}

/**
 * Formats hydration diagnostics for a control key.
 * @param {Hydration} result - Hydration result.
 * @param {string} key - Deep-link key.
 * @returns {string[]} Console diagnostics in evaluation order.
 */
export function hydrationWarnings(result, key) {
  if (!result.warning) return [];
  const { raw, reasons } = result.warning;
  return reasons.map(reason => reason === 'duplicate'
    ? `DeepLinkGUI: enum "${key}" has options sharing a value; the deep link may restore a different label.`
    : `DeepLinkGUI: ignoring ${reason === 'boolean' ? 'unrecognized boolean' : reason === 'range' ? 'out-of-range' : 'non-numeric'} URL value "${raw}" for "${key}"`);
}
