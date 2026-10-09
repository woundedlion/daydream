/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/*
 * The procedural tab's twelve coefficient sliders and the parameters they
 * edit, including the locked R/G/B group drags.
 */

import { createSlider } from '../../shared/slider.js';
import { lockedGroupMove } from './palette_controls.js';

/** @typedef {import('./palette_math.js').ProceduralParams} ProceduralParams */
/** @typedef {keyof ProceduralParams} ProceduralParam */

/**
 * @typedef {object} ProceduralSliderDefinition
 * @property {ProceduralParam} param - The coefficient, `<group>_<channel>`.
 * @property {string} container - Element the slider is built into.
 * @property {string} label - The visible channel label.
 * @property {string} color - Classes coloring the label.
 * @property {string} thumb - Classes styling the thumb.
 * @property {number} min - Lowest value, in coefficient units.
 * @property {number} max - Highest value.
 * @property {number} step - Step, in coefficient units.
 * @property {number} scale - Coefficient-to-raw-slider multiplier.
 * @property {'A'|'B'|'C'|'D'} group - The coefficient group a lock moves together.
 */

/** Accessible names combine the coefficient group and channel. */
const GROUP_NAMES = Object.freeze({
  A: 'Offset', B: 'Amplitude', C: 'Frequency', D: 'Phase',
});
const CHANNEL_NAMES = Object.freeze({ R: 'red', G: 'green', B: 'blue' });

/** @type {ReadonlyArray<ProceduralSliderDefinition>} */
export const PROCEDURAL_SLIDER_DEFINITIONS = Object.freeze([
  // A (Base): Range [0, 1]
  { param: 'A_R', container: 'A_R_container', label: 'R', color: 'text-red-300', thumb: 'r-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'A' },
  { param: 'A_G', container: 'A_G_container', label: 'G', color: 'text-green-500', thumb: 'g-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'A' },
  { param: 'A_B', container: 'A_B_container', label: 'B', color: 'text-blue-300', thumb: '', min: 0, max: 1, step: 0.001, scale: 1000, group: 'A' },
  // B (Amplitude): Range [0, 1]
  { param: 'B_R', container: 'B_R_container', label: 'R', color: 'text-red-300', thumb: 'r-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'B' },
  { param: 'B_G', container: 'B_G_container', label: 'G', color: 'text-green-500', thumb: 'g-thumb', min: 0, max: 1, step: 0.001, scale: 1000, group: 'B' },
  { param: 'B_B', container: 'B_B_container', label: 'B', color: 'text-blue-300', thumb: '', min: 0, max: 1, step: 0.001, scale: 1000, group: 'B' },
  // C (Frequency): Range [-5, 5]
  { param: 'C_R', container: 'C_R_container', label: 'R', color: 'text-red-300', thumb: 'r-thumb', min: -5, max: 5, step: 0.001, scale: 1000, group: 'C' },
  { param: 'C_G', container: 'C_G_container', label: 'G', color: 'text-green-500', thumb: 'g-thumb', min: -5, max: 5, step: 0.001, scale: 1000, group: 'C' },
  { param: 'C_B', container: 'C_B_container', label: 'B', color: 'text-blue-300', thumb: '', min: -5, max: 5, step: 0.001, scale: 1000, group: 'C' },
  // D (Phase): Range [-1, 2]
  { param: 'D_R', container: 'D_R_container', label: 'R', color: 'text-red-300', thumb: 'r-thumb', min: -1, max: 2, step: 0.001, scale: 1000, group: 'D' },
  { param: 'D_G', container: 'D_G_container', label: 'G', color: 'text-green-500', thumb: 'g-thumb', min: -1, max: 2, step: 0.001, scale: 1000, group: 'D' },
  { param: 'D_B', container: 'D_B_container', label: 'B', color: 'text-blue-300', thumb: '', min: -1, max: 2, step: 0.001, scale: 1000, group: 'D' },
].map((definition) => Object.freeze(/** @type {ProceduralSliderDefinition} */ (definition))));

/** @type {Readonly<Record<string, ReadonlyArray<ProceduralSliderDefinition>>>} */
const GROUP_DEFINITIONS = Object.freeze(Object.fromEntries(['A', 'B', 'C', 'D'].map((group) =>
  [group, PROCEDURAL_SLIDER_DEFINITIONS.filter((definition) => definition.group === group)])));

/**
 * The accessible name for one procedural slider.
 * @param {ProceduralSliderDefinition} definition - The slider.
 * @returns {string} The group and channel name, e.g. "Offset red".
 */
function sliderAriaLabel(definition) {
  const channel = /** @type {'R'|'G'|'B'} */ (definition.param.split('_')[1]);
  return `${GROUP_NAMES[definition.group]} ${CHANNEL_NAMES[channel]}`;
}

/**
 * @param {string} group - A coefficient group.
 * @returns {boolean} Whether its lock checkbox is checked.
 */
function groupLocked(group) {
  const lock = /** @type {HTMLInputElement|null} */ (document.getElementById(`lock_${group}`));
  return lock ? lock.checked : false;
}

/**
 * @typedef {object} ProceduralSliders
 * @property {() => Readonly<ProceduralParams>} values - The current
 *   coefficients; a view valid until the next slider input or setAll.
 * @property {(params: Readonly<ProceduralParams>) => void} setAll - Replaces
 *   every coefficient and moves its slider to it.
 * @property {() => void} dispose - Removes the drag seed and release listeners.
 */

/**
 * Builds the procedural sliders into their containers. Each input updates
 * the coefficients and asks for a redraw; moving a slider of a locked group
 * moves the whole group by the same delta, capped so no channel leaves its
 * range (lockedGroupMove).
 * @param {object} options - Mount options.
 * @param {Readonly<ProceduralParams>} options.defaults - The starting coefficients; copied.
 * @param {() => void} options.scheduleUpdate - Requests a redraw.
 * @returns {ProceduralSliders} The sliders' state and controls.
 */
export function mountProceduralSliders({ defaults, scheduleUpdate }) {
  /** @type {ProceduralParams} */
  const parameters = { ...defaults };
  const handles = /** @type {Record<ProceduralParam, ReturnType<typeof createSlider>>} */ ({});
  /** @type {Record<string, number>} */
  let lockedDragStartValues = {};
  /** @type {ProceduralParam|null} */
  let lockedDragOwner = null;
  /** @type {Array<() => void>} */
  const removers = [];

  /**
   * The committed raw slider values of one coefficient group.
   * @param {string} group - A coefficient group.
   * @returns {Record<string, number>} Raw value keyed by param.
   */
  const groupRawValues = (group) => {
    /** @type {Record<string, number>} */
    const values = {};
    for (const definition of GROUP_DEFINITIONS[group])
      values[definition.param] = parameters[definition.param] * definition.scale;
    return values;
  };

  /**
   * @param {ProceduralSliderDefinition} definition - The slider that moved.
   * @param {number} rawValue - Its raw value.
   * @returns {void}
   */
  const moveLockedGroup = (definition, rawValue) => {
    // An input with no seeding event (assistive tech, programmatic) moves
    // the group from its pre-change state.
    const startValues = definition.param in lockedDragStartValues
      ? lockedDragStartValues
      : groupRawValues(definition.group);
    const group = GROUP_DEFINITIONS[definition.group];
    const members = [];
    for (const member of group) {
      const slider = /** @type {HTMLInputElement|null} */ (
        document.getElementById(`${member.param}_slider`));
      if (!slider) continue;
      members.push({
        param: member.param,
        start: startValues[member.param],
        min: parseFloat(slider.min),
        max: parseFloat(slider.max),
      });
    }
    const { values } = lockedGroupMove(rawValue - startValues[definition.param], members);
    for (const member of group) {
      const raw = values[member.param];
      if (raw === undefined) continue;
      parameters[member.param] = raw / member.scale;
      handles[member.param].setValue(parameters[member.param]);
    }
  };

  /**
   * @param {ProceduralSliderDefinition} definition - The slider to build.
   * @returns {void}
   */
  const mount = (definition) => {
    const handle = createSlider(definition.container, {
      id: definition.param,
      label: definition.label,
      min: definition.min,
      max: definition.max,
      step: definition.step,
      value: parameters[definition.param],
      scale: definition.scale,
      decimals: 3,
      ariaLabel: sliderAriaLabel(definition),
      labelSuffix: '',
      labelClass: `w-4 h-4 text-center font-bold ${definition.color}`,
      sliderClass: definition.thumb,
      valueClass: 'slider-label w-16 text-right',
    }, (/** @type {number} */ rawValue) => {
      if (groupLocked(definition.group)) moveLockedGroup(definition, rawValue);
      else parameters[definition.param] = rawValue / definition.scale;
      scheduleUpdate();
    });
    handles[definition.param] = handle;
    const { slider } = handle;

    const seedLockedDrag = () => {
      if (!groupLocked(definition.group)) return;
      lockedDragOwner = definition.param;
      lockedDragStartValues = {};
      for (const member of GROUP_DEFINITIONS[definition.group]) {
        const memberSlider = /** @type {HTMLInputElement|null} */ (
          document.getElementById(`${member.param}_slider`));
        if (memberSlider) lockedDragStartValues[member.param] = parseFloat(memberSlider.value);
      }
    };
    const releaseLockedDrag = () => {
      if (lockedDragOwner !== definition.param) return;
      lockedDragStartValues = {};
      lockedDragOwner = null;
    };
    /** @type {Array<[string, () => void, AddEventListenerOptions|undefined]>} */
    const listeners = [
      ['mousedown', seedLockedDrag, undefined],
      ['touchstart', seedLockedDrag, { passive: true }],
      ['keydown', seedLockedDrag, undefined],
      ['wheel', seedLockedDrag, { passive: true }],
      ['mouseup', releaseLockedDrag, undefined],
      ['touchend', releaseLockedDrag, undefined],
      ['keyup', releaseLockedDrag, undefined],
      ['blur', releaseLockedDrag, undefined],
    ];
    for (const [type, listener, options] of listeners) {
      slider.addEventListener(type, listener, options);
      removers.push(() => slider.removeEventListener(type, listener, options));
    }
  };

  PROCEDURAL_SLIDER_DEFINITIONS.forEach(mount);

  return {
    values: () => parameters,
    setAll(params) {
      for (const definition of PROCEDURAL_SLIDER_DEFINITIONS) {
        parameters[definition.param] = params[definition.param];
        handles[definition.param].setValue(params[definition.param]);
      }
    },
    dispose() {
      for (const remove of removers.splice(0)) remove();
    },
  };
}
