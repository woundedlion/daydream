/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/*
 * Pure state and geometry behind the palette tool's controls: hue-wheel math,
 * the strip's zoom window, and the V4 recipe values the engine's palette
 * compiler consumes.
 */

/**
 * One axis of a V4 recipe: a curve over [0, 1] given by its center and width,
 * or the authored points (one per hue key, two to four) a CUSTOM curve reads instead.
 * @typedef {object} PaletteAxis
 * @property {number} curve - A PaletteV4.curve ordinal.
 * @property {number} center - Midpoint of the axis' range.
 * @property {number} range - Full width the curve spans about the center.
 * @property {number[]} custom - The CUSTOM curve's authored points.
 */

/**
 * @typedef {PaletteAxis & {basis: number, headroom: number}} PaletteChromaAxis
 *   The chroma axis, which also names the gamut its values are measured against
 *   (a PaletteV4.chromaBasis ordinal) and its relative-chroma ceiling as a gamut fraction.
 */

/**
 * The hue block of a V4 recipe. Which fields matter depends on `mode`: a
 * harmony reads `harmony`/`spreadTurns`, a sweep reads `sweepTurns`, and CUSTOM
 * reads `customTurns`.
 * @typedef {object} PaletteHue
 * @property {number} mode - A PaletteV4.hueMode ordinal.
 * @property {number} harmony - A PaletteV4.harmony ordinal.
 * @property {number} direction - A PaletteV4.direction ordinal.
 * @property {number} baseTurns - The anchor hue, in turns.
 * @property {number} spreadTurns - Angular spread between a harmony's anchors.
 * @property {number} sweepTurns - Total travel of a SWEEP, in turns.
 * @property {number[]} customTurns - Four key hues, in turns; CUSTOM reads the
 *   first three and the engine zeroes the fourth.
 */

/**
 * A V4 palette recipe, as the engine's palette compiler consumes it. The enum
 * fields carry PaletteV4 ordinals.
 * @typedef {object} PaletteRecipe
 * @property {number} schemaVersion - Recipe schema the fields follow.
 * @property {{offset: number, span: number}} input - The phase window sampled.
 * @property {number} domain - A PaletteV4.domain ordinal.
 * @property {number} easing - A PaletteV4.easing ordinal.
 * @property {number} colorPath - A PaletteV4.colorPath ordinal.
 * @property {PaletteHue} hue - The hue keys and how they are derived.
 * @property {PaletteAxis} lightness - The OKLCH lightness axis.
 * @property {PaletteChromaAxis} chroma - The OKLCH chroma axis.
 * @property {number} hueTorsion - Hue torsion in radians per unit lightness.
 * @property {number} falloffStart - Where a FALLOFF domain begins to fade.
 */

/**
 * @param {number} value - Value to clamp.
 * @returns {number} `value` clamped to [0, 1].
 */
const clampUnit = (value) => Math.max(0, Math.min(1, value));

/**
 * Subtracts whole turns from a hue.
 * @param {number} turns - A hue in turns (one turn is 360°).
 * @returns {number} The equivalent hue in [0, 1); rounding near the seam may yield 1.
 */
export const wrapTurns = (turns) => turns - Math.floor(turns);

/**
 * The shortest signed rotation a hue difference stands for.
 * @param {number} delta - Difference between two hues, in turns.
 * @returns {number} The equivalent difference in [-0.5, 0.5]. Exactly half a
 *   turn is equally far either way, so it keeps the sign of `delta` — a key
 *   dragged the long way round travels on instead of snapping back.
 */
export function signedTurnDelta(delta) {
  const wrapped = wrapTurns(delta);
  if (wrapped < 0.5) return wrapped;
  if (wrapped > 0.5) return wrapped - 1;
  return delta < 0 ? -0.5 : 0.5;
}

/**
 * Lifts a wrapped hue to the representative nearest a reference hue, so a hue
 * that crossed the 0/1 seam stays continuous with where it came from.
 * @param {number} wrappedTurn - A hue in turns, typically in [0, 1).
 * @param {number} referenceTurn - The unwrapped hue the result should sit beside.
 * @returns {number} The representative of `wrappedTurn` within half a turn of `referenceTurn`.
 */
export function equivalentTurnNear(wrappedTurn, referenceTurn) {
  return referenceTurn + signedTurnDelta(wrappedTurn - referenceTurn);
}

/**
 * Finds the hue-wheel key marker a pointer is over.
 * @param {number} x - Pointer x, in the space the marker points are given in.
 * @param {number} y - Pointer y, in the same space.
 * @param {Array<{x:number, y:number}>} points - Marker centers, in key order.
 * @param {number} radius - Grab radius around a marker.
 * @returns {?number} Index of the closest marker within `radius`, the later of
 *   two equally close ones, or null over blank wheel space.
 */
export function hitTestHueKeyMarker(x, y, points, radius) {
  let nearest = null;
  let nearestDistance = radius;
  for (let index = 0; index < points.length; index++) {
    const distance = Math.hypot(x - points[index].x, y - points[index].y);
    if (distance <= nearestDistance) {
      nearest = index;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Fills a three-element array in place.
 * @param {number[]} out - Destination array.
 * @param {number} r - First component.
 * @param {number} g - Second component.
 * @param {number} b - Third component.
 * @returns {number[]} out
 */
function writeTriple(out, r, g, b) {
  out[0] = r;
  out[1] = g;
  out[2] = b;
  return out;
}

/**
 * Converts an OKLCH color to linear sRGB, unclamped so the caller can see which
 * side of the gamut a channel fell off.
 * @param {number} lightness - OKLCH L, nominally in [0, 1].
 * @param {number} chroma - OKLCH C.
 * @param {number} turns - OKLCH hue, in turns.
 * @param {number[]} [out] - Filled in place and returned.
 * @returns {number[]} Linear [R, G, B]; a channel outside [0, 1] is out of gamut.
 */
export function oklchLinearRgb(lightness, chroma, turns, out = [0, 0, 0]) {
  const angle = turns * Math.PI * 2;
  const a = chroma * Math.cos(angle);
  const b = chroma * Math.sin(angle);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;
  return writeTriple(out,
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}

/**
 * @param {number[]} rgb - Linear RGB channels.
 * @returns {boolean} Whether the channels meet the engine's gamut slack.
 */
export function linearRgbInGamut(rgb) {
  return rgb[0] >= -1e-4 && rgb[0] <= 1.0001
    && rgb[1] >= -1e-4 && rgb[1] <= 1.0001
    && rgb[2] >= -1e-4 && rgb[2] <= 1.0001;
}

/**
 * Estimates the widest sRGB-gamut chroma at one lightness by bisecting 360
 * sampled hues. Uses the engine's 1e-4 channel slack and 2e-5 chroma margin.
 * @param {number} lightness - OKLCH L to search at.
 * @returns {number} The largest sampled chroma, minus the margin.
 */
export function maxSrgbGamutChroma(lightness) {
  lightness = Math.max(0, Math.min(1, lightness));
  if (lightness === 0 || lightness === 1) return 0;
  const hueSamples = 360;
  const searchIterations = 12;
  const chromaLimit = 0.5;
  let maximum = 0;
  const rgb = [0, 0, 0];

  for (let hue = 0; hue < hueSamples; hue++) {
    let low = 0;
    let high = chromaLimit;
    for (let iteration = 0; iteration < searchIterations; iteration++) {
      const chroma = (low + high) * 0.5;
      oklchLinearRgb(lightness, chroma, hue / hueSamples, rgb);
      const inGamut = linearRgbInGamut(rgb);
      if (inGamut) low = chroma;
      else high = chroma;
    }
    maximum = Math.max(maximum, low - 2e-5);
  }
  return maximum;
}

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
 *   direction, and returns it; an empty drag leaves the window alone.
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
      return start !== 0 || end !== 1;
    },

    map,

    /**
     * @param {number} firstPosition - One end of the drag, as a 0..1 strip position.
     * @param {number} secondPosition - The other end.
     * @returns {{start: number, end: number}} The window now shown.
     */
    zoom(firstPosition, secondPosition) {
      const low = Math.min(clampUnit(firstPosition), clampUnit(secondPosition));
      const high = Math.max(clampUnit(firstPosition), clampUnit(secondPosition));
      if (low === high) return { start, end };
      const nextStart = map(low);
      const nextEnd = map(high);
      start = nextStart;
      end = nextEnd;
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
  return {
    offset: Math.max(0, Math.min(1 - clampedSpan, offset)),
    span: clampedSpan,
  };
}

/**
 * Narrows a recipe's phase window to the span between two strip positions, in
 * either drag direction.
 * @param {{offset: number, span: number}} window - The window now shown.
 * @param {number} firstPosition - One end of the drag, as a 0..1 strip position.
 * @param {number} secondPosition - The other end.
 * @returns {{offset: number, span: number}} The window to show next.
 */
export function zoomRecipeWindow(window, firstPosition, secondPosition) {
  const low = Math.min(clampUnit(firstPosition), clampUnit(secondPosition));
  const high = Math.max(clampUnit(firstPosition), clampUnit(secondPosition));
  return clampRecipeWindow(
    window.offset + low * window.span, (high - low) * window.span);
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
  const zoomed = start !== 0 || end !== 1;
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
 * @returns {{center:number, range:number}} The axis values, with a non-negative range.
 */
export function axisFromEndpoints(minimum, maximum) {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  return {
    center: (low + high) * 0.5,
    range: high - low,
  };
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
 * their sliders use, the curve select that governs them, and how each is
 * named in the labels and accessible names built from it.
 * @type {Object<string, {minimum: string, maximum: string, curve: string, label: string, shortLabel: string}>}
 */
export const PALETTE_AXIS_CONTROLS = Object.freeze({
  lightness: Object.freeze({
    minimum: PALETTE_CONTROL_IDS.lightnessMinimum, maximum: PALETTE_CONTROL_IDS.lightnessMaximum,
    curve: PALETTE_CONTROL_IDS.lightnessCurve,
    label: 'Lightness', shortLabel: 'Lightness',
  }),
  chroma: Object.freeze({
    minimum: PALETTE_CONTROL_IDS.chromaMinimum, maximum: PALETTE_CONTROL_IDS.chromaMaximum,
    curve: PALETTE_CONTROL_IDS.chromaCurve,
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
 * @returns {Object<string, string|boolean>} The bounds, labels, accessible names
 *   and readouts to apply to the pair.
 */
export function axisControlState({ curve, minimum, maximum, label, shortLabel }) {
  const constant = curve === 'CONSTANT';
  return {
    constant,
    minimumLabel: shortLabel,
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

/**
 * The V4 recipe enumerants. The ordinals mirror the `enum class` rosters in
 * core/color/palette_recipe.h in declaration order.
 * @type {Object<string, Object<string, number>>}
 */
export const PaletteV4 = Object.freeze({
  hueMode: Object.freeze({ HARMONY: 0, SWEEP: 1, CUSTOM: 2 }),
  harmony: Object.freeze({
    MONOCHROMATIC: 0,
    ANALOGOUS: 1,
    ACCENTED_ANALOGOUS: 2,
    COMPLEMENTARY: 3,
    SPLIT_COMPLEMENTARY: 4,
    TRIADIC: 5,
    TETRADIC: 6,
    SQUARE: 7,
  }),
  direction: Object.freeze({ SHORTEST: 0, CLOCKWISE: 1, COUNTERCLOCKWISE: 2 }),
  curve: Object.freeze({
    CONSTANT: 0,
    ASCENDING: 1,
    DESCENDING: 2,
    BELL: 3,
    CUP: 4,
    CUSTOM: 5,
  }),
  chromaBasis: Object.freeze({ LOCAL_GAMUT: 0, PATH_MINIMUM: 1, ABSOLUTE: 2 }),
  colorPath: Object.freeze({ OKLCH_ARC: 0, OKLAB_CARTESIAN: 1 }),
  domain: Object.freeze({ STRAIGHT: 0, MIRROR: 1, VIGNETTE: 2, FALLOFF: 3, LOOP: 4 }),
  easing: Object.freeze({ LINEAR: 0, COSINE: 1, SMOOTHSTEP: 2 }),
});

/**
 * @param {number} delta - Difference between two hues, in turns.
 * @param {number} direction - A PaletteV4.direction ordinal.
 * @returns {number} The signed travel that direction asks for.
 */
function directedTurnDelta(delta, direction) {
  if (direction === PaletteV4.direction.SHORTEST) return signedTurnDelta(delta);
  const wrapped = wrapTurns(delta);
  if (direction === PaletteV4.direction.CLOCKWISE)
    return wrapped === 0 ? 0 : wrapped - 1;
  return wrapped;
}

/**
 * @param {PaletteRecipe} recipe - A V4 palette recipe.
 * @returns {number} The sweep with the recipe's direction.
 */
function directedSweepTurns(recipe) {
  if (recipe.hue.direction === PaletteV4.direction.CLOCKWISE)
    return -Math.abs(recipe.hue.sweepTurns);
  if (recipe.hue.direction === PaletteV4.direction.COUNTERCLOCKWISE)
    return Math.abs(recipe.hue.sweepTurns);
  return recipe.hue.sweepTurns;
}

/**
 * @param {PaletteRecipe} recipe - A V4 palette recipe.
 * @returns {number[]} The harmony's anchor offsets, in turns.
 */
// Offsets, not absolute hues: differencing base-shifted hues rounds a
// half-turn step to either side of the SHORTEST tie.
function harmonyRelationships(recipe) {
  const { spreadTurns: spread, harmony, direction } = recipe.hue;
  const orientation = direction === PaletteV4.direction.CLOCKWISE ? -1 : 1;
  switch (harmony) {
    case PaletteV4.harmony.MONOCHROMATIC:
      return [0];
    case PaletteV4.harmony.ANALOGOUS:
      return [-orientation * spread, 0, orientation * spread];
    case PaletteV4.harmony.ACCENTED_ANALOGOUS:
      return [-orientation * spread, 0, orientation * spread,
        orientation * 0.5];
    case PaletteV4.harmony.COMPLEMENTARY:
      return [0, orientation * 0.5];
    case PaletteV4.harmony.SPLIT_COMPLEMENTARY:
      return [0, orientation * (0.5 - spread),
        orientation * (0.5 + spread)];
    case PaletteV4.harmony.TRIADIC:
      return [0, orientation / 3, orientation * 2 / 3];
    case PaletteV4.harmony.TETRADIC:
      return [0, orientation * spread, orientation * 0.5,
        orientation * (0.5 + spread)];
    case PaletteV4.harmony.SQUARE:
      return [0, orientation * 0.25, orientation * 0.5,
        orientation * 0.75];
    default:
      throw new RangeError(`Unknown palette harmony: ${harmony}`);
  }
}

/**
 * @param {number[]} turns - Hue keys, in turns.
 * @returns {number[]} The same shape resampled to exactly three keys.
 */
function resampleThreeTurns(turns) {
  if (turns.length === 1) return [turns[0], turns[0], turns[0]];
  return [0, 0.5, 1].map((position) => {
    const scaled = position * (turns.length - 1);
    const left = Math.floor(scaled);
    const right = Math.min(left + 1, turns.length - 1);
    return turns[left] + (turns[right] - turns[left]) * (scaled - left);
  });
}

/**
 * @param {PaletteRecipe} recipe - A V4 palette recipe.
 * @returns {number[]} The harmony's anchors as absolute hues, in turns, walked
 *   in the recipe's direction so they stay continuous across the 0/1 seam.
 */
function directedHarmonyTurns(recipe) {
  const turns = harmonyRelationships(recipe);
  for (let i = 1; i < turns.length; i++) {
    turns[i] = turns[i - 1] + directedTurnDelta(
      turns[i] - turns[i - 1], recipe.hue.direction);
  }
  return turns.map((turn) => turn + recipe.hue.baseTurns);
}

/**
 * @param {number[]} turns - Hue keys, in turns.
 * @returns {{baseTurns: number, offsets: number[]}} The first key wrapped, and
 *   every key's signed offset from it.
 */
function hueKeyStateFromTurns(turns) {
  const anchor = turns[0];
  return {
    baseTurns: wrapTurns(anchor),
    offsets: turns.map((turn) => turn - anchor),
  };
}

/**
 * The hue keys the wheel draws for a recipe, read in its own hue mode: the
 * authored keys for CUSTOM, the two keys a SWEEP resolves to, and the harmony's
 * anchors otherwise — MONOCHROMATIC repeats its single anchor so the wheel still
 * draws a pair. A SWEEP holds two keys (core/color/generative_palette.h
 * control_key_count), so its second lands on half the sweep under a LOOP, which
 * spaces at sweep*i/key_count, and on the whole sweep under every other domain,
 * which spaces at sweep*i/(key_count-1).
 * @param {PaletteRecipe} recipe - A V4 palette recipe.
 * @returns {{baseTurns:number, offsets:number[]}} The first key's wrapped turn
 *   and every key's signed offset from it, so keys that walked past the seam
 *   keep the continuous positions the harmony gave them.
 */
export function hueKeyState(recipe) {
  if (recipe.hue.mode === PaletteV4.hueMode.CUSTOM)
    return hueKeyStateFromTurns(recipe.hue.customTurns.slice(0, 3));
  if (recipe.hue.mode === PaletteV4.hueMode.SWEEP) {
    const sweep = directedSweepTurns(recipe);
    const end = recipe.domain === PaletteV4.domain.LOOP ? sweep * 0.5 : sweep;
    return hueKeyStateFromTurns([recipe.hue.baseTurns, recipe.hue.baseTurns + end]);
  }

  const turns = directedHarmonyTurns(recipe);
  if (recipe.hue.harmony === PaletteV4.harmony.MONOCHROMATIC)
    turns.push(turns[0]);
  return hueKeyStateFromTurns(turns);
}

/**
 * The three keys a switch into CUSTOM hue mode authors: a harmony's anchors
 * resampled to three, a sweep resampled to three keys, or the existing custom
 * keys untouched.
 * @param {PaletteRecipe} recipe - A V4 palette recipe.
 * @returns {{baseTurns:number, offsets:number[]}} The base turn and the three keys' offsets from it.
 */
export function customHueKeyState(recipe) {
  let turns;
  if (recipe.hue.mode === PaletteV4.hueMode.CUSTOM) {
    turns = recipe.hue.customTurns.slice(0, 3);
  } else if (recipe.hue.mode === PaletteV4.hueMode.SWEEP) {
    const sweep = directedSweepTurns(recipe);
    // Three-key spacing mirrors core/color/generative_palette.h resolve_hues.
    const step = sweep / (recipe.domain === PaletteV4.domain.LOOP ? 3 : 2);
    turns = [recipe.hue.baseTurns, recipe.hue.baseTurns + step,
      recipe.hue.baseTurns + 2 * step];
  } else {
    turns = resampleThreeTurns(directedHarmonyTurns(recipe));
  }

  return hueKeyStateFromTurns(turns);
}

/**
 * @param {PaletteRecipe} recipe - The recipe before switching to CUSTOM.
 * @returns {boolean} Whether CUSTOM preserves a LOOP sweep's closing hue.
 */
export function customHueSweepRepresentable(recipe) {
  if (recipe.hue.mode !== PaletteV4.hueMode.SWEEP
      || recipe.domain !== PaletteV4.domain.LOOP) return true;
  const { offsets } = customHueKeyState(recipe);
  const closing = offsets[2] + directedTurnDelta(-offsets[2], recipe.hue.direction);
  const sweep = hueKeyState(recipe).offsets[1] * 2;
  return Math.abs(closing - sweep) < 1e-12;
}

/**
 * Rebuilds a recipe's customTurns array from the wheel's base-plus-offsets form.
 * @param {number} baseTurns - The base hue, wrapped into [0, 1) before the offsets are added.
 * @param {number[]} offsets - The three keys' offsets from the base.
 * @param {number[]} [template] - Array the untouched fourth slot is carried over from.
 * @returns {number[]} The four turns a recipe's hue.customTurns holds.
 */
export function customHueTurns(baseTurns, offsets, template = [0, 0, 0, 0]) {
  const turns = [...template];
  for (let i = 0; i < 3; i++) turns[i] = wrapTurns(baseTurns) + offsets[i];
  return turns;
}

/**
 * Moves one custom hue key onto the turn a drag landed on.
 * @param {number} baseTurns - The keys' base hue.
 * @param {number[]} offsets - The keys' current offsets from the base.
 * @param {number} keyIndex - Which key moved.
 * @param {number} wrappedTurn - The pointed-at hue, as read off the wheel.
 * @returns {number[]} A new offsets array; the other keys are unchanged. The
 *   moved key takes the representative of `wrappedTurn` nearest where it
 *   already was, so a drag across the seam does not spin it the long way round,
 *   and its offset is clamped to ±2 turns so it cannot wind up unboundedly.
 */
export function moveCustomHueKey(baseTurns, offsets, keyIndex, wrappedTurn) {
  const nextOffsets = [...offsets];
  const currentTurn = baseTurns + nextOffsets[keyIndex];
  const nextTurn = equivalentTurnNear(wrappedTurn, currentTurn);
  nextOffsets[keyIndex] = Math.max(-2, Math.min(2, nextTurn - baseTurns));
  return nextOffsets;
}

/** Where a FALLOFF domain begins to fade, as core/color/palette_recipe.h defaults it. */
const DEFAULT_FALLOFF_START = 0.9;

/**
 * The complete V4 recipe the tool opens on: a balanced analogous palette.
 * @returns {PaletteRecipe} A fresh, detached recipe, safe to mutate.
 */
export function defaultPaletteRecipe() {
  return {
    schemaVersion: 4,
    input: { offset: 0, span: 1 },
    domain: PaletteV4.domain.STRAIGHT,
    easing: PaletteV4.easing.COSINE,
    colorPath: PaletteV4.colorPath.OKLCH_ARC,
    hue: {
      mode: PaletteV4.hueMode.HARMONY,
      harmony: PaletteV4.harmony.ANALOGOUS,
      direction: PaletteV4.direction.SHORTEST,
      baseTurns: 0,
      spreadTurns: 0.07,
      sweepTurns: 1,
      customTurns: [0, 0, 0, 0],
    },
    lightness: {
      curve: PaletteV4.curve.CONSTANT,
      center: 0.62,
      range: 0,
      custom: [0, 0, 0, 0],
    },
    chroma: {
      curve: PaletteV4.curve.CONSTANT,
      basis: PaletteV4.chromaBasis.LOCAL_GAMUT,
      center: 0.62,
      range: 0,
      headroom: 0.94,
      custom: [0, 0, 0, 0],
    },
    hueTorsion: 0,
    falloffStart: DEFAULT_FALLOFF_START,
  };
}

const DEFAULT_HUE = defaultPaletteRecipe().hue;

/**
 * The ordinal a PaletteV4 member name stands for — the inverse of
 * paletteEnumName.
 * @param {string} group - A PaletteV4 enum name.
 * @param {string} name - The member name a <select> option carries.
 * @returns {number} The member's ordinal.
 * @throws {RangeError} When the group has no such own member; an inherited
 *   name ("constructor", "toString") does not resolve.
 */
export function paletteEnumOrdinal(group, name) {
  const members = PaletteV4[group];
  if (!members) throw new RangeError(`Unknown palette enum: ${group}`);
  if (!Object.hasOwn(members, name))
    throw new RangeError(`Unknown ${group} member: ${name}`);
  return members[name];
}

/**
 * The whole-turn sweep a LOOP domain closes on. The engine rejects a fractional
 * loop sweep (core/color/generative_palette.h canonicalize); this rounds as
 * roundf does, half away from zero.
 * @param {number} turns - The authored sweep, in turns.
 * @returns {number} The nearest whole turn, ties away from zero.
 */
export function loopSweepTurns(turns) {
  return Math.sign(turns) * Math.round(Math.abs(turns));
}

/**
 * @typedef {Object} PaletteControlReadings
 * @property {{offset: number, span: number}} window - Input window (offset, span).
 * @property {string} domain - PaletteV4.domain member name.
 * @property {string} colorPath - PaletteV4.colorPath member name.
 * @property {string} hueMode - PaletteV4.hueMode member name.
 * @property {string} harmony - PaletteV4.harmony member name.
 * @property {string} direction - PaletteV4.direction member name.
 * @property {number} baseTurns - Base hue, in turns.
 * @property {number[]} customHueOffsets - Per-key hue offsets, used only in CUSTOM hue mode.
 * @property {string} lightnessCurve - PaletteV4.curve member name.
 * @property {string} chromaCurve - PaletteV4.curve member name.
 * @property {{minimum: number, maximum: number}} lightness - Lightness endpoints.
 * @property {{minimum: number, maximum: number}} chroma - Chroma endpoints.
 * @property {string} easing - PaletteV4.easing member name.
 * @property {number} spreadTurns - Angular spread between a harmony's anchors, in turns.
 * @property {number} sweepTurns - Total travel of a SWEEP, in turns.
 * @property {number} headroom - Fraction of the local gamut the chroma may reach.
 * @property {number} hueTorsion - Hue drift per unit lightness, in radians.
 * @property {number} falloffStart - Where a FALLOFF domain begins to fade.
 */

/**
 * Marshals the generative tab's control readings into a V4 recipe.
 * A CUSTOM-curve axis retains the template's custom points and ignores endpoint readings.
 * @param {PaletteRecipe} template - Recipe the reading is applied over; deep-cloned, never mutated.
 * @param {PaletteControlReadings} controls - The control readings.
 * @returns {PaletteRecipe} The recipe.
 * @throws {RangeError} When a reading names no PaletteV4 member of its group.
 */
export function paletteRecipeFromControls(template, controls) {
  const recipe = structuredClone(template);
  recipe.input = { ...controls.window };
  recipe.domain = paletteEnumOrdinal('domain', controls.domain);
  recipe.easing = paletteEnumOrdinal('easing', controls.easing);
  recipe.colorPath = paletteEnumOrdinal('colorPath', controls.colorPath);
  recipe.hue.mode = paletteEnumOrdinal('hueMode', controls.hueMode);
  recipe.hue.harmony = paletteEnumOrdinal('harmony', controls.harmony);
  recipe.hue.direction = paletteEnumOrdinal('direction', controls.direction);
  recipe.hue.baseTurns = controls.baseTurns;
  recipe.hue.spreadTurns = controls.spreadTurns;
  recipe.hue.sweepTurns = controls.sweepTurns;
  if (recipe.hue.mode !== PaletteV4.hueMode.HARMONY) {
    recipe.hue.harmony = DEFAULT_HUE.harmony;
    recipe.hue.spreadTurns = DEFAULT_HUE.spreadTurns;
  } else if (!SPREAD_HARMONIES.has(recipe.hue.harmony)) {
    recipe.hue.spreadTurns = DEFAULT_HUE.spreadTurns;
  }
  if (recipe.hue.mode !== PaletteV4.hueMode.SWEEP)
    recipe.hue.sweepTurns = DEFAULT_HUE.sweepTurns;
  recipe.chroma.headroom = controls.headroom;
  recipe.hueTorsion = controls.hueTorsion;
  recipe.falloffStart = controls.falloffStart;
  if (recipe.hue.mode === PaletteV4.hueMode.CUSTOM) {
    recipe.hue.customTurns = customHueTurns(
      recipe.hue.baseTurns, controls.customHueOffsets, recipe.hue.customTurns);
    // The keys carry the base hue; the engine canonicalizes the field away.
    recipe.hue.baseTurns = 0;
  }
  recipe.lightness.curve = paletteEnumOrdinal('curve', controls.lightnessCurve);
  recipe.chroma.curve = paletteEnumOrdinal('curve', controls.chromaCurve);
  for (const axis of /** @type {Array<'lightness'|'chroma'>} */ (['lightness', 'chroma'])) {
    if (recipe[axis].curve === PaletteV4.curve.CUSTOM) continue;
    const { minimum, maximum } = controls[axis];
    Object.assign(recipe[axis], axisFromEndpoints(minimum, maximum));
  }
  // The engine canonicalizes a falloff start outside a FALLOFF domain and the
  // headroom of an ABSOLUTE chroma basis.
  if (recipe.domain !== PaletteV4.domain.FALLOFF)
    recipe.falloffStart = DEFAULT_FALLOFF_START;
  if (recipe.chroma.basis === PaletteV4.chromaBasis.ABSOLUTE)
    recipe.chroma.headroom = 1;
  if (recipe.domain === PaletteV4.domain.LOOP &&
      recipe.hue.mode === PaletteV4.hueMode.SWEEP) {
    recipe.hue.sweepTurns = loopSweepTurns(recipe.hue.sweepTurns);
  }
  return recipe;
}



/**
 * Assembles the readings paletteRecipeFromControls consumes, converting the
 * units the controls are labelled in (degrees) to the recipe's own (turns).
 * @param {(id: string) => (string|undefined)} readControl - Reads one control's value by element id.
 * @param {number[]} customHueOffsets - The wheel's per-key hue offsets, which no control holds.
 * @returns {PaletteControlReadings} The readings.
 * @throws {RangeError} When a control the recipe needs is not on the page.
 */
export function paletteControlReadings(readControl, customHueOffsets) {
  /**
   * @param {string} name - A PALETTE_CONTROL_IDS key.
   * @returns {string} The control's value.
   */
  const read = (name) => {
    const id = PALETTE_CONTROL_IDS[name];
    const value = readControl(id);
    if (value === undefined || value === null)
      throw new RangeError(`Palette control ${id} is missing`);
    return value;
  };
  /**
   * @param {string} name - A PALETTE_CONTROL_IDS key.
   * @returns {number} The control's value as a number.
   */
  const number = (name) => Number(read(name));

  return {
    window: { offset: number('offset'), span: number('span') },
    easing: read('easing'),
    spreadTurns: number('spreadDegrees') / 360,
    sweepTurns: number('sweepTurns'),
    headroom: number('headroom'),
    hueTorsion: number('hueTorsion'),
    falloffStart: number('falloffStart'),
    domain: read('domain'),
    colorPath: read('colorPath'),
    hueMode: read('hueMode'),
    harmony: read('harmony'),
    direction: read('direction'),
    baseTurns: number('baseHueDegrees') / 360,
    customHueOffsets,
    lightnessCurve: read('lightnessCurve'),
    chromaCurve: read('chromaCurve'),
    lightness: {
      minimum: number('lightnessMinimum'),
      maximum: number('lightnessMaximum'),
    },
    chroma: {
      minimum: number('chromaMinimum'),
      maximum: number('chromaMaximum'),
    },
  };
}

/**
 * The PaletteV4 member name an ordinal stands for — the value the matching
 * <option> carries.
 * @param {string} group - A PaletteV4 enum name.
 * @param {number} value - The ordinal a recipe carries.
 * @returns {string} The member's name.
 * @throws {RangeError} When the group has no member with that ordinal.
 */
export function paletteEnumName(group, value) {
  const members = PaletteV4[group];
  if (!members) throw new RangeError(`Unknown palette enum: ${group}`);
  const name = Object.keys(members).find((key) => members[key] === value);
  if (name === undefined)
    throw new RangeError(`Unknown ${group} value: ${value}`);
  return name;
}

/**
 * The inverse of paletteRecipeFromControls: the readings that reproduce a
 * recipe.
 *
 * customHueOffsets is meaningful only in CUSTOM mode. Other modes preserve
 * their authored baseTurns; a handoff into CUSTOM uses customHueKeyState().
 * @param {PaletteRecipe} recipe - The recipe to load.
 * @returns {PaletteControlReadings} The readings, in paletteRecipeFromControls' own shape.
 * @throws {RangeError} When a field holds an ordinal PaletteV4 has no member for.
 */
export function paletteControlsFromRecipe(recipe) {
  const hueState = customHueKeyState(recipe);
  return {
    window: { ...recipe.input },
    easing: paletteEnumName('easing', recipe.easing),
    spreadTurns: recipe.hue.spreadTurns,
    sweepTurns: recipe.hue.sweepTurns,
    headroom: recipe.chroma.headroom,
    hueTorsion: recipe.hueTorsion,
    falloffStart: recipe.falloffStart,
    domain: paletteEnumName('domain', recipe.domain),
    colorPath: paletteEnumName('colorPath', recipe.colorPath),
    hueMode: paletteEnumName('hueMode', recipe.hue.mode),
    harmony: paletteEnumName('harmony', recipe.hue.harmony),
    direction: paletteEnumName('direction', recipe.hue.direction),
    baseTurns: recipe.hue.mode === PaletteV4.hueMode.CUSTOM
      ? hueState.baseTurns : recipe.hue.baseTurns,
    customHueOffsets: hueState.offsets,
    lightnessCurve: paletteEnumName('curve', recipe.lightness.curve),
    chromaCurve: paletteEnumName('curve', recipe.chroma.curve),
    lightness: axisEndpoints(recipe.lightness),
    chroma: axisEndpoints(recipe.chroma),
  };
}

// The harmonies whose anchors are placed by spreadTurns; the rest are fixed
// fractions of the wheel.
const SPREAD_HARMONIES = new Set([
  PaletteV4.harmony.ANALOGOUS,
  PaletteV4.harmony.ACCENTED_ANALOGOUS,
  PaletteV4.harmony.SPLIT_COMPLEMENTARY,
  PaletteV4.harmony.TETRADIC,
]);

/**
 * Which control groups can still change the palette a recipe describes: a
 * palette with no chroma has no hue to steer, a monochromatic harmony has no
 * direction or color path, and a custom curve authors its own endpoints.
 * @param {PaletteRecipe} recipe - A V4 palette recipe.
 * @returns {Object<string, boolean>} One enabled flag per control group.
 */
export function paletteRecipeAvailability(recipe) {
  const variedChroma = recipe.chroma.curve !== PaletteV4.curve.CONSTANT;
  const hasColor = recipe.chroma.center > 0 || (variedChroma && recipe.chroma.range > 0);
  const customHue = recipe.hue.mode === PaletteV4.hueMode.CUSTOM;
  const monochromatic = recipe.hue.mode === PaletteV4.hueMode.HARMONY &&
    recipe.hue.harmony === PaletteV4.harmony.MONOCHROMATIC;
  const customLightness = recipe.lightness.curve === PaletteV4.curve.CUSTOM;
  const customChroma = recipe.chroma.curve === PaletteV4.curve.CUSTOM;

  return {
    baseHue: hasColor,
    hueMode: hasColor,
    harmony: hasColor && recipe.hue.mode === PaletteV4.hueMode.HARMONY,
    hueSpread: hasColor && recipe.hue.mode === PaletteV4.hueMode.HARMONY &&
      SPREAD_HARMONIES.has(recipe.hue.harmony),
    hueSweep: hasColor && recipe.hue.mode === PaletteV4.hueMode.SWEEP,
    hueTorsion: hasColor,
    colorPath: hasColor && !monochromatic,
    hueDirection: hasColor && !monochromatic &&
      (!customHue || recipe.domain === PaletteV4.domain.LOOP),
    chromaHeadroom: hasColor && recipe.chroma.basis !== PaletteV4.chromaBasis.ABSOLUTE,
    falloffStart: recipe.domain === PaletteV4.domain.FALLOFF,
    chromaEndpoints: !customChroma,
    chromaMaximum: variedChroma && !customChroma,
    lightnessEndpoints: !customLightness,
    lightnessMaximum: recipe.lightness.curve !== PaletteV4.curve.CONSTANT &&
      !customLightness,
  };
}

/**
 * The tool's starting points, each a factory returning a fresh recipe.
 * @type {Object<string, () => PaletteRecipe>}
 */
export const PALETTE_RECIPE_PRESETS = Object.freeze({
  balancedAnalogous() {
    return defaultPaletteRecipe();
  },
  isolightSpectralLoop() {
    const recipe = defaultPaletteRecipe();
    recipe.domain = PaletteV4.domain.LOOP;
    recipe.hue.mode = PaletteV4.hueMode.SWEEP;
    recipe.hue.sweepTurns = 1;
    recipe.chroma.center = 0.72;
    return recipe;
  },
  tonalMonochrome() {
    const recipe = defaultPaletteRecipe();
    recipe.hue.harmony = PaletteV4.harmony.MONOCHROMATIC;
    recipe.lightness.curve = PaletteV4.curve.ASCENDING;
    recipe.lightness.center = 0.52;
    recipe.lightness.range = 0.72;
    recipe.chroma.curve = PaletteV4.curve.BELL;
    recipe.chroma.center = 0.52;
    recipe.chroma.range = 0.42;
    return recipe;
  },
});
