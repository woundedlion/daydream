/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

const clampUnit = (value) => Math.max(0, Math.min(1, value));

/**
 * Owns the phase window shown by the palette strip.
 *
 * Pointer positions stay local to the visible strip while palette phases stay
 * in the original 0..1 domain. Keeping that mapping here gives Procedural and
 * Generative palettes identical copy and nested-zoom behavior.
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

export function recipeForViewport(recipe, viewport) {
  const result = structuredClone(recipe);
  result.input.offset = recipe.input.offset + viewport.start * recipe.input.span;
  result.input.span = (viewport.end - viewport.start) * recipe.input.span;
  return result;
}

export function axisEndpoints({ center, range }) {
  return {
    minimum: clampUnit(center - range * 0.5),
    maximum: clampUnit(center + range * 0.5),
  };
}

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

export const PaletteV3 = Object.freeze({
  hueMode: Object.freeze({ HARMONY: 0, SWEEP: 1, CUSTOM: 2 }),
  harmony: Object.freeze({
    MONOCHROMATIC: 0,
    ANALOGOUS: 1,
    ACCENTED_ANALOGOUS: 2,
    COMPLEMENTARY: 3,
    SPLIT_COMPLEMENTARY: 4,
    TRIADIC: 5,
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

export function defaultPaletteRecipe() {
  return {
    schemaVersion: 3,
    keyCount: 6,
    input: { offset: 0, span: 1 },
    domain: PaletteV3.domain.STRAIGHT,
    easing: PaletteV3.easing.COSINE,
    colorPath: PaletteV3.colorPath.OKLCH_ARC,
    hue: {
      mode: PaletteV3.hueMode.HARMONY,
      harmony: PaletteV3.harmony.ANALOGOUS,
      direction: PaletteV3.direction.SHORTEST,
      baseTurns: 0,
      spreadTurns: 0.07,
      sweepTurns: 1,
      customTurns: [0, 0, 0, 0, 0, 0],
    },
    lightness: {
      curve: PaletteV3.curve.CONSTANT,
      center: 0.62,
      range: 0,
      custom: [0, 0, 0, 0, 0, 0],
    },
    chroma: {
      curve: PaletteV3.curve.CONSTANT,
      basis: PaletteV3.chromaBasis.LOCAL_GAMUT,
      center: 0.62,
      range: 0,
      headroom: 0.94,
      custom: [0, 0, 0, 0, 0, 0],
    },
    hueTorsion: 0,
    falloffStart: 0.9,
  };
}

export function paletteRecipeAvailability(recipe) {
  const variedChroma = recipe.chroma.curve !== PaletteV3.curve.CONSTANT;
  const hasColor = recipe.chroma.center > 0 || (variedChroma && recipe.chroma.range > 0);
  const monochromatic = recipe.hue.mode === PaletteV3.hueMode.HARMONY &&
    recipe.hue.harmony === PaletteV3.harmony.MONOCHROMATIC;

  return {
    baseHue: hasColor,
    hueMode: hasColor,
    harmony: hasColor && recipe.hue.mode === PaletteV3.hueMode.HARMONY,
    colorPath: hasColor && !monochromatic,
    hueDirection: hasColor && !monochromatic,
    chromaMaximum: variedChroma,
    lightnessMaximum: recipe.lightness.curve !== PaletteV3.curve.CONSTANT,
  };
}

function cloneRecipe(recipe) {
  return structuredClone(recipe);
}

export const PALETTE_RECIPE_PRESETS = Object.freeze({
  balancedAnalogous() {
    return defaultPaletteRecipe();
  },
  isolightSpectralLoop() {
    const recipe = defaultPaletteRecipe();
    recipe.domain = PaletteV3.domain.LOOP;
    recipe.hue.mode = PaletteV3.hueMode.SWEEP;
    recipe.hue.sweepTurns = 1;
    recipe.chroma.center = 0.72;
    return recipe;
  },
  tonalMonochrome() {
    const recipe = defaultPaletteRecipe();
    recipe.hue.harmony = PaletteV3.harmony.MONOCHROMATIC;
    recipe.lightness.curve = PaletteV3.curve.ASCENDING;
    recipe.lightness.center = 0.52;
    recipe.lightness.range = 0.72;
    recipe.chroma.curve = PaletteV3.curve.BELL;
    recipe.chroma.center = 0.52;
    recipe.chroma.range = 0.42;
    return recipe;
  },
});

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
