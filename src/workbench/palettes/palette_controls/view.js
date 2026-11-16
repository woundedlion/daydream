/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { clampUnit } from './math.js';


const PALETTE_TABS = new Set(['procedural', 'generative']);

/**
 * Reads the tool's selected tab out of a deep link.
 * @param {string} search - A location's query string, e.g. '?tab=generative'.
 * @returns {string} The named tab, or 'procedural' when the query names none of them.
 */
export function paletteTabFromSearch(search) {
  const tab = new URLSearchParams(search).get('tab') ?? '';
  return PALETTE_TABS.has(tab) ? tab : 'procedural';
}

/**
 * The tool's URL with its tab selected, leaving the rest of the query and the
 * hash as they were.
 * @param {string} href - Absolute URL to rewrite.
 * @param {string} tab - Tab to select.
 * @returns {string} The rewritten absolute URL.
 * @throws {RangeError} When `tab` is not one of the tool's tabs.
 */
export function paletteTabUrl(href, tab) {
  if (!PALETTE_TABS.has(tab)) throw new RangeError(`Unknown palette tab: ${tab}`);
  const url = new URL(href);
  url.searchParams.set('tab', tab);
  return url.href;
}

/**
 * Resolves the WAI-ARIA tablist keyboard contract for a horizontal tablist:
 * arrows step and wrap, Home and End jump to the ends.
 * @param {string} key - KeyboardEvent key.
 * @param {number} current - Index of the focused tab.
 * @param {number} count - Number of tabs in the tablist.
 * @returns {?number} Index to focus and activate, or null for unhandled keys.
 */
export function tablistKeyTarget(key, current, count) {
  if (count < 1) return null;
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/**
 * @typedef {object} PaletteViewport
 * @property {{start: number, end: number}} value - The visible phase window.
 * @property {boolean} zoomed - Whether the window is narrower than the whole palette.
 * @property {(position: number) => number} map - Takes a 0..1 strip position to its palette phase.
 * @property {(firstPosition: number, secondPosition: number) => {start: number, end: number}} zoom
 *   Narrows the window to the span between two strip positions, in either drag
 *   direction, and returns it; a span below 0.01 leaves the window alone.
 * @property {() => void} reset - Restores the full 0..1 range.
 */

/**
 * Owns the phase window shown by the palette strip.
 *
 * Pointer positions stay local to the visible strip while palette phases stay
 * in the original 0..1 domain.
 *
 * @returns {PaletteViewport} The viewport.
 */
export function createPaletteViewport() {
  let start = 0;
  let end = 1;

  /**
   * @param {number} position - A 0..1 position along the visible strip.
   * @returns {number} The palette phase it names.
   */
  const map = (position) => start + clampUnit(position) * (end - start);

  return {
    get value() {
      return { start, end };
    },

    get zoomed() {
      return isZoomed(start, end);
    },

    map,

    /**
     * @param {number} firstPosition - One end of the drag, as a 0..1 strip position.
     * @param {number} secondPosition - The other end.
     * @returns {{start: number, end: number}} The window now shown.
     */
    zoom(firstPosition, secondPosition) {
      const window = zoomRecipeWindow({ offset: start, span: end - start },
        firstPosition, secondPosition);
      start = window.offset;
      end = window.offset + window.span;
      return { start, end };
    },

    reset() {
      start = 0;
      end = 1;
    },
  };
}

/**
 * The phase window the generative tab samples, with its controls' own limits
 * applied: a span narrower than a hundredth of the palette is not editable, and
 * the offset cannot push the window past the end.
 * @param {number} offset - Where the window starts, in palette phase.
 * @param {number} span - How much of the palette it covers.
 * @returns {{offset: number, span: number}} The window the controls hold.
 */
export function clampRecipeWindow(offset, span) {
  const clampedSpan = Math.max(0.01, Math.min(1, span));
  const clampedOffset = Math.max(0, Math.min(1 - clampedSpan, offset));
  return {
    offset: clampedOffset,
    span: Math.min(clampedSpan, 1 - Math.fround(clampedOffset)),
  };
}

/**
 * Narrows a recipe's phase window to the span between two strip positions, in
 * either drag direction; a span below 0.01 leaves the window alone.
 * @param {{offset: number, span: number}} window - The window now shown.
 * @param {number} firstPosition - One end of the drag, as a 0..1 strip position.
 * @param {number} secondPosition - The other end.
 * @returns {{offset: number, span: number}} The window to show next.
 */
export function zoomRecipeWindow(window, firstPosition, secondPosition) {
  const low = Math.min(clampUnit(firstPosition), clampUnit(secondPosition));
  const high = Math.max(clampUnit(firstPosition), clampUnit(secondPosition));
  const span = (high - low) * window.span;
  if (span < 0.01) return { ...window };
  return clampRecipeWindow(
    window.offset + low * window.span, span);
}

/** Shortest drag the strip reads as a zoom rather than as a click. */
export const STRIP_DRAG_THRESHOLD = 0.01;

/**
 * What a completed strip drag asks for.
 * @param {number} startPosition - Where the drag began, as a 0..1 strip position.
 * @param {number} endPosition - Where it ended; the two may arrive in either order.
 * @param {number} [threshold] - Shortest drag that counts as a zoom.
 * @returns {{intent: string, start: number, end: number}} Either a 'copy' of the
 *   color at `start`, or a 'zoom' onto [start, end].
 */
export function stripDragIntent(startPosition, endPosition,
  threshold = STRIP_DRAG_THRESHOLD) {
  const start = Math.min(startPosition, endPosition);
  const end = Math.max(startPosition, endPosition);
  return { intent: end - start < threshold ? 'copy' : 'zoom', start, end };
}

/**
 * How the strip presents the phase window it is showing.
 * @param {{start: number, end: number}} range - The visible phase window.
 * @returns {{zoomed: boolean, heading: string, ariaLabel: string}} Whether the
 *   window is narrower than the whole palette, and the heading and accessible
 *   name that say so.
 */
export function paletteStripView({ start, end }) {
  const zoomed = isZoomed(start, end);
  return {
    zoomed,
    heading: zoomed
      ? `sRGB Palette (t ∈ [${start.toFixed(3)}, ${end.toFixed(3)}])`
      : 'sRGB Palette (t ∈ [0, 1])',
    ariaLabel: `Palette strip, t ${start.toFixed(3)} to ${end.toFixed(3)}. `
      + 'Press Enter to copy the center color. Drag to zoom.',
  };
}

/**
 * @param {number} start - First visible palette phase.
 * @param {number} end - Last visible palette phase.
 * @returns {boolean} Whether the full palette is outside the window.
 */
function isZoomed(start, end) {
  return start !== 0 || end !== 1;
}

/**
 * The accessible name for the channel-curve plot, which redraws over whichever
 * phase window the strip shows.
 * @param {{start: number, end: number}} range - The plotted phase window.
 * @returns {string} The accessible name.
 */
export function waveGraphLabel({ start, end }) {
  return 'Plot of the sRGB red, green and blue channel curves against '
    + `normalized palette coordinate t, t ${start.toFixed(3)} to ${end.toFixed(3)}.`;
}

/**
 * The endpoints a lightness or chroma axis spans, for controls that edit its
 * ends rather than its center and width.
 * @param {{center:number, range:number}} axis - The recipe's axis values.
 * @returns {{minimum:number, maximum:number}} The endpoints, each clamped to [0, 1].
 */
export function axisEndpoints({ center, range }) {
  return {
    minimum: clampUnit(center - range * 0.5),
    maximum: clampUnit(center + range * 0.5),
  };
}

/**
 * The center-and-range form of an axis the user edited by its endpoints.
 * @param {number} minimum - One endpoint.
 * @param {number} maximum - The other; the two may arrive in either order.
 * @param {{center:number, range:number}} [out] - Object the center and range are written into.
 * @returns {{center:number, range:number}} `out`, or a new axis value, with a non-negative range.
 */
export function axisFromEndpoints(minimum, maximum, out = { center: 0, range: 0 }) {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  out.center = (low + high) * 0.5;
  out.range = high - low;
  return out;
}

/**
 * The generative tab's control element ids, by the reading each one carries.
 * @type {Object<string, string>}
 */
export const PALETTE_CONTROL_IDS = Object.freeze({
  offset: 'gen_offset',
  span: 'gen_span',
  easing: 'gen_easing',
  spreadDegrees: 'gen_spread',
  sweepTurns: 'gen_sweep',
  headroom: 'gen_headroom',
  hueTorsion: 'gen_torsion',
  falloffStart: 'gen_falloff',
  domain: 'gen_domain',
  colorPath: 'gen_path',
  hueMode: 'gen_hue_mode',
  harmony: 'gen_harmony',
  direction: 'gen_direction',
  baseHueDegrees: 'gen_base_hue',
  lightnessCurve: 'gen_lightness_curve',
  chromaCurve: 'gen_chroma_curve',
  lightnessMinimum: 'gen_lightness_minimum',
  lightnessMaximum: 'gen_lightness_maximum',
  chromaMinimum: 'gen_chroma_minimum',
  chromaMaximum: 'gen_chroma_maximum',
});

/**
 * The two OKLCH axes the generative tab edits by their endpoints: the ids
 * their sliders use, the curve select that governs them, the control reading
 * that select carries, and how each is named in the labels and accessible
 * names built from it.
 * @type {Object<string, {minimum: string, maximum: string, curve: string, reading: 'lightnessCurve'|'chromaCurve', label: string, shortLabel: string}>}
 */
export const PALETTE_AXIS_CONTROLS = Object.freeze({
  lightness: Object.freeze({
    minimum: PALETTE_CONTROL_IDS.lightnessMinimum, maximum: PALETTE_CONTROL_IDS.lightnessMaximum,
    curve: PALETTE_CONTROL_IDS.lightnessCurve, reading: 'lightnessCurve',
    label: 'Lightness', shortLabel: 'Lightness',
  }),
  chroma: Object.freeze({
    minimum: PALETTE_CONTROL_IDS.chromaMinimum, maximum: PALETTE_CONTROL_IDS.chromaMaximum,
    curve: PALETTE_CONTROL_IDS.chromaCurve, reading: 'chromaCurve',
    label: 'Relative Chroma', shortLabel: 'Chroma',
  }),
});

/** Decimals an axis endpoint's readout shows; its slider takes step="any". */
const AXIS_READOUT_DIGITS = 3;

/**
 * How an axis' endpoint sliders present themselves under the curve selected for
 * it. A CONSTANT curve has one value rather than two ends, so its minimum reads
 * as the axis itself and spans the whole unit interval; every other curve pins
 * each end against the other so the pair cannot cross.
 * @param {object} axis - The axis' current control readings.
 * @param {string} axis.curve - PaletteV4.curve member name the curve select holds.
 * @param {string|number} axis.minimum - The minimum slider's value.
 * @param {string|number} axis.maximum - The maximum slider's value.
 * @param {string} axis.label - The axis' full name, for accessible names.
 * @param {string} axis.shortLabel - Its name as the visible label shows it.
 * @returns {{constant:boolean, minimumLabel:string, maximumLabel:string,
 *   minimumName:string, maximumName:string, minimumMin:string, minimumMax:string,
 *   maximumMin:string, maximumMax:string, minimumText:string, maximumText:string}} The bounds, labels, accessible names
 *   and readouts to apply to the pair.
 */
export function axisControlState({ curve, minimum, maximum, label, shortLabel }) {
  const constant = curve === 'CONSTANT';
  return {
    constant,
    minimumLabel: constant ? shortLabel : 'Minimum',
    maximumLabel: 'Maximum',
    minimumName: constant ? label : `Minimum ${label}`,
    maximumName: `Maximum ${label}`,
    minimumMin: '0',
    minimumMax: constant ? '1' : String(maximum),
    maximumMin: constant ? '0' : String(minimum),
    maximumMax: '1',
    minimumText: Number(minimum).toFixed(AXIS_READOUT_DIGITS),
    maximumText: Number(maximum).toFixed(AXIS_READOUT_DIGITS),
  };
}

/**
 * Caps the shared delta a locked R/G/B group moves by so no member leaves its
 * own range, and reports each member's resulting value. The first channel to
 * hit a bound stops the whole group.
 *
 * @param {number} rawDelta - Delta the dragged slider asks for, in raw (scaled integer) units.
 * @param {Array<{param: string, start: number, min: number, max: number}>} members - The group's sliders, with their drag-start values and raw bounds. A member whose start value is not finite is ignored (the page could not read it).
 * @returns {{delta: number, values: Object<string, number>}} The capped delta and the raw value each member lands on.
 */
export function lockedGroupMove(rawDelta, members) {
  const moving = members.filter((m) => Number.isFinite(m.start));

  let delta = rawDelta;
  for (const m of moving) {
    // Bounds are tested against the REQUESTED delta, so an earlier member's cap
    // cannot mask a later member's violation.
    if (m.start + rawDelta < m.min) delta = Math.max(delta, m.min - m.start);
    if (m.start + rawDelta > m.max) delta = Math.min(delta, m.max - m.start);
  }

  /** @type {Object<string, number>} */
  const values = {};
  for (const m of moving) values[m.param] = m.start + delta;
  return { delta, values };
}
