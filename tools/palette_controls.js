/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/*
 * Pure state and geometry behind the palette tool's controls (palettes.html):
 * hue-wheel math, the strip's zoom window, and the V4 recipe values the engine's
 * palette compiler consumes. No DOM, so every export is testable headless.
 */

const clampUnit = (value) => Math.max(0, Math.min(1, value));

/**
 * Wraps a hue onto the [0, 1) fundamental domain.
 * @param {number} turns - A hue in turns (one turn is 360°).
 * @returns {number} The equivalent hue in [0, 1).
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
 * Converts an OKLCH color to linear sRGB, unclamped so the caller can see which
 * side of the gamut a channel fell off.
 * @param {number} lightness - OKLCH L, nominally in [0, 1].
 * @param {number} chroma - OKLCH C.
 * @param {number} turns - OKLCH hue, in turns.
 * @returns {number[]} Linear [R, G, B]; a channel outside [0, 1] is out of gamut.
 */
export function oklchLinearRgb(lightness, chroma, turns) {
  const angle = turns * Math.PI * 2;
  const a = chroma * Math.cos(angle);
  const b = chroma * Math.sin(angle);
  const lRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lRoot * lRoot * lRoot;
  const m = mRoot * mRoot * mRoot;
  const s = sRoot * sRoot * sRoot;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * The widest chroma any hue reaches inside the sRGB gamut at one lightness,
 * bisected per hue over a 360-step sweep. Scales the hue wheel's chroma axis so
 * its outer edge is the gamut's widest slice at that lightness.
 * @param {number} lightness - OKLCH L to search at.
 * @returns {number} The maximum in-gamut chroma over all hues.
 */
export function maxSrgbGamutChroma(lightness) {
  const hueSamples = 360;
  const searchIterations = 12;
  const chromaLimit = 0.5;
  let maximum = 0;

  for (let hue = 0; hue < hueSamples; hue++) {
    let low = 0;
    let high = chromaLimit;
    for (let iteration = 0; iteration < searchIterations; iteration++) {
      const chroma = (low + high) * 0.5;
      const rgb = oklchLinearRgb(lightness, chroma, hue / hueSamples);
      if (rgb.every((channel) => channel >= 0 && channel <= 1)) low = chroma;
      else high = chroma;
    }
    maximum = Math.max(maximum, low);
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
  const tab = new URLSearchParams(search).get('tab');
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
 * Owns the phase window shown by the palette strip.
 *
 * Pointer positions stay local to the visible strip while palette phases stay
 * in the original 0..1 domain. Keeping that mapping here gives Procedural and
 * Generative palettes identical copy and nested-zoom behavior.
 *
 * @returns {{value: {start:number, end:number}, zoomed: boolean, map: function(number): number, zoom: function(number, number): {start:number, end:number}, reset: function(): void}}
 *   The viewport. `value` is the visible phase window and `zoomed` reports
 *   whether it is narrower than the whole palette; `map` takes a 0..1 strip
 *   position to its palette phase; `zoom` narrows the window to the span
 *   between two strip positions, in either drag direction, and returns it (an
 *   empty drag leaves the window alone); `reset` restores the full 0..1 range.
 */
export function createPaletteViewport() {
  let start = 0;
  let end = 1;

  const map = (position) => start + clampUnit(position) * (end - start);

  return {
    get value() {
      return { start, end };
    },

    get zoomed() {
      return start !== 0 || end !== 1;
    },

    map,

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
 * A copy of a recipe whose input window is narrowed onto the viewport, so a
 * zoomed strip compiles the phases it shows at full LUT resolution.
 * @param {Object} recipe - A V4 palette recipe.
 * @param {{start:number, end:number}} viewport - The visible window, in fractions of the recipe's own span.
 * @returns {Object} A detached recipe with the window composed onto input.offset/input.span.
 */
export function recipeForViewport(recipe, viewport) {
  const result = structuredClone(recipe);
  result.input.offset = recipe.input.offset + viewport.start * recipe.input.span;
  result.input.span = (viewport.end - viewport.start) * recipe.input.span;
  return result;
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
 * Caps the shared delta a locked R/G/B group moves by so no member leaves its
 * own range, and reports each member's resulting value.
 *
 * All three channels move rigidly, so the group can only travel as far as its
 * most constrained member: the first channel to hit a bound stops the whole
 * group instead of clipping alone and breaking the lock.
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

  const values = {};
  for (const m of moving) values[m.param] = m.start + delta;
  return { delta, values };
}

/**
 * The V4 recipe enumerants. The ordinals are what a recipe carries across the
 * WASM boundary, so they mirror the `enum class` rosters in core/color/color.h
 * in declaration order. palette_math.js's ENUM_NAMES is the inverse;
 * engine_source_parity.test.js pins both to the engine header.
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

function directedTurnDelta(delta, direction) {
  if (direction === PaletteV4.direction.SHORTEST) return signedTurnDelta(delta);
  const wrapped = wrapTurns(delta);
  if (direction === PaletteV4.direction.CLOCKWISE)
    return wrapped === 0 ? 0 : wrapped - 1;
  return wrapped;
}

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

function resampleThreeTurns(turns) {
  if (turns.length === 1) return [turns[0], turns[0], turns[0]];
  return [0, 0.5, 1].map((position) => {
    const scaled = position * (turns.length - 1);
    const left = Math.floor(scaled);
    const right = Math.min(left + 1, turns.length - 1);
    return turns[left] + (turns[right] - turns[left]) * (scaled - left);
  });
}

function directedHarmonyTurns(recipe) {
  const turns = harmonyRelationships(recipe);
  for (let i = 1; i < turns.length; i++) {
    turns[i] = turns[i - 1] + directedTurnDelta(
      turns[i] - turns[i - 1], recipe.hue.direction);
  }
  return turns.map((turn) => turn + recipe.hue.baseTurns);
}

function hueKeyStateFromTurns(turns) {
  const anchor = turns[0];
  return {
    baseTurns: wrapTurns(anchor),
    offsets: turns.map((turn) => turn - anchor),
  };
}

/**
 * The hue keys the wheel draws for a recipe, read in its own hue mode: the
 * authored keys for CUSTOM, the two ends for SWEEP (halved under a LOOP domain,
 * which travels out and back), and the harmony's anchors otherwise —
 * MONOCHROMATIC repeats its single anchor so the wheel still draws a pair.
 * @param {Object} recipe - A V4 palette recipe.
 * @returns {{baseTurns:number, offsets:number[]}} The first key's wrapped turn
 *   and every key's signed offset from it, so keys that walked past the seam
 *   keep the continuous positions the harmony gave them.
 */
export function hueKeyState(recipe) {
  if (recipe.hue.mode === PaletteV4.hueMode.CUSTOM)
    return hueKeyStateFromTurns(recipe.hue.customTurns.slice(0, 3));
  if (recipe.hue.mode === PaletteV4.hueMode.SWEEP) {
    let sweep = recipe.hue.sweepTurns;
    if (recipe.hue.direction === PaletteV4.direction.CLOCKWISE)
      sweep = -Math.abs(sweep);
    else if (recipe.hue.direction === PaletteV4.direction.COUNTERCLOCKWISE)
      sweep = Math.abs(sweep);
    const end = recipe.domain === PaletteV4.domain.LOOP ? sweep * 0.5 : sweep;
    return hueKeyStateFromTurns([recipe.hue.baseTurns, recipe.hue.baseTurns + end]);
  }

  const turns = directedHarmonyTurns(recipe);
  if (recipe.hue.harmony === PaletteV4.harmony.MONOCHROMATIC)
    turns.push(turns[0]);
  return hueKeyStateFromTurns(turns);
}

/**
 * The three keys a switch into CUSTOM hue mode should author, so the handoff
 * starts on the shape the wheel already showed: a harmony's anchors resampled
 * to three, a sweep's start/middle/end, or the existing custom keys untouched.
 * @param {Object} recipe - A V4 palette recipe.
 * @returns {{baseTurns:number, offsets:number[]}} The base turn and the three keys' offsets from it.
 */
export function customHueKeyState(recipe) {
  let turns;
  if (recipe.hue.mode === PaletteV4.hueMode.CUSTOM) {
    turns = recipe.hue.customTurns.slice(0, 3);
  } else if (recipe.hue.mode === PaletteV4.hueMode.SWEEP) {
    const sweep = recipe.hue.direction === PaletteV4.direction.CLOCKWISE
      ? -Math.abs(recipe.hue.sweepTurns)
      : recipe.hue.direction === PaletteV4.direction.COUNTERCLOCKWISE
        ? Math.abs(recipe.hue.sweepTurns)
        : recipe.hue.sweepTurns;
    turns = [recipe.hue.baseTurns, recipe.hue.baseTurns + sweep * 0.5,
      recipe.hue.baseTurns + sweep];
  } else {
    turns = resampleThreeTurns(directedHarmonyTurns(recipe));
  }

  return hueKeyStateFromTurns(turns);
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

/**
 * The complete V4 recipe the tool opens on: a balanced analogous palette.
 * @returns {Object} A fresh, detached recipe, safe to mutate.
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
    falloffStart: 0.9,
  };
}

/**
 * Which control groups can still change the palette a recipe describes, so the
 * page disables the rest instead of offering sliders with no effect: a palette
 * with no chroma has no hue to steer, a monochromatic harmony has no direction
 * or color path, and a custom curve authors its own endpoints.
 * @param {Object} recipe - A V4 palette recipe.
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
    colorPath: hasColor && !monochromatic,
    hueDirection: hasColor && !monochromatic && !customHue,
    chromaEndpoints: !customChroma,
    chromaMaximum: variedChroma && !customChroma,
    lightnessEndpoints: !customLightness,
    lightnessMaximum: recipe.lightness.curve !== PaletteV4.curve.CONSTANT &&
      !customLightness,
  };
}

function cloneRecipe(recipe) {
  return structuredClone(recipe);
}

/**
 * The tool's starting points, each a factory so a preset hands out a fresh
 * recipe rather than a shared one the page would edit in place.
 * @type {Object<string, function(): Object>}
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

/**
 * Owns the recipe being edited and the compiler's last word on it.
 *
 * Compilation is asynchronous, so each edit bumps a revision and a result
 * carrying a stale one is dropped: a slow compile cannot overwrite the state a
 * later edit produced. Every value in and out is cloned, so nothing the page
 * holds aliases the store.
 *
 * @param {Object} [initial] - Recipe to start from; copied, not adopted.
 * @returns {{value: Object, edit: function(function(Object): void): number, applyCompileResult: function(number, Object): boolean, replace: function(Object): number}}
 *   The store. `value` is a detached {revision, draft, canonical, status}
 *   snapshot; `edit` runs the mutator against a copy of the draft and returns
 *   the new revision; `applyCompileResult` records a result against the
 *   revision it compiled and reports whether that revision was still current;
 *   `replace` swaps the whole draft and returns the new revision.
 */
export function createPaletteRecipeState(initial = defaultPaletteRecipe()) {
  let state = {
    revision: 0,
    draft: cloneRecipe(initial),
    canonical: null,
    status: null,
  };
  return {
    get value() {
      return cloneRecipe(state);
    },
    edit(mutator) {
      const draft = cloneRecipe(state.draft);
      mutator(draft);
      state = { ...state, revision: state.revision + 1, draft, status: null };
      return state.revision;
    },
    applyCompileResult(revision, result) {
      if (revision !== state.revision) return false;
      state = {
        ...state,
        canonical: result.canonicalRecipe ? cloneRecipe(result.canonicalRecipe) : null,
        status: { ...result.status },
      };
      return true;
    },
    replace(recipe) {
      state = {
        revision: state.revision + 1,
        draft: cloneRecipe(recipe),
        canonical: null,
        status: null,
      };
      return state.revision;
    },
  };
}
