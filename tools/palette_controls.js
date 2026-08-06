/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * DOM-free control state for the palette tool page (tools/palettes.html): the
 * drag-to-zoom history the Reset Zoom button reflects, and the delta capping a
 * locked R/G/B slider group moves under. The page keeps the DOM reads and
 * writes around these.
 */

/**
 * The procedural coefficients a zoom rewrites, and therefore the ones the
 * history snapshots. The A (base) and B (amplitude) triples are untouched by a
 * zoom, so restoring them would discard unrelated edits.
 */
export const ZOOMED_PARAMS = ['C_R', 'C_G', 'C_B', 'D_R', 'D_G', 'D_B'];

/**
 * Builds the zoom history: at most one pre-zoom snapshot of the frequency/phase
 * coefficients, held from the first zoom until it is restored or invalidated.
 *
 * Successive zooms compose, so only the FIRST pre-zoom state is kept — a reset
 * always returns to where the user started rather than one zoom back. Any edit
 * that redefines the frequency/phase baseline (a manual C/D slider move, loading
 * a named palette) invalidates the snapshot instead.
 *
 * @returns {{zoomed: boolean, capture: function(Object): void, restore: function(): ?Object, clear: function(): void}} The history handle; `zoomed` reports whether a snapshot is held.
 */
export function createZoomHistory() {
  /** @type {?Object} */
  let saved = null;

  return {
    get zoomed() {
      return saved !== null;
    },

    /**
     * Snapshots the frequency/phase coefficients, unless one is already held.
     * @param {Object} parameters - The current 12-coefficient parameter set.
     * @returns {void}
     */
    capture(parameters) {
      if (saved !== null) return;
      saved = {};
      for (const key of ZOOMED_PARAMS) saved[key] = parameters[key];
    },

    /**
     * Takes the snapshot back and drops it.
     * @returns {?Object} The pre-zoom frequency/phase coefficients, or null when none is held.
     */
    restore() {
      const snapshot = saved;
      saved = null;
      return snapshot;
    },

    /**
     * Drops the snapshot without restoring it.
     * @returns {void}
     */
    clear() {
      saved = null;
    },
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

export const PaletteV2 = Object.freeze({
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
    schemaVersion: 2,
    domain: PaletteV2.domain.STRAIGHT,
    easing: PaletteV2.easing.COSINE,
    colorPath: PaletteV2.colorPath.OKLCH_ARC,
    hue: {
      mode: PaletteV2.hueMode.HARMONY,
      harmony: PaletteV2.harmony.ANALOGOUS,
      direction: PaletteV2.direction.SHORTEST,
      baseTurns: 0,
      spreadTurns: 0.07,
      sweepTurns: 1,
      customTurns: [0, 0, 0],
    },
    lightness: {
      curve: PaletteV2.curve.CONSTANT,
      center: 0.62,
      range: 0,
      custom: [0, 0, 0],
    },
    chroma: {
      curve: PaletteV2.curve.CONSTANT,
      basis: PaletteV2.chromaBasis.LOCAL_GAMUT,
      center: 0.62,
      range: 0,
      headroom: 0.94,
      custom: [0, 0, 0],
    },
    hueTorsion: 0,
    falloffStart: 0.9,
  };
}

export function paletteRecipeAvailability(recipe) {
  const variedChroma = recipe.chroma.curve !== PaletteV2.curve.CONSTANT;
  const hasColor = recipe.chroma.center > 0 || (variedChroma && recipe.chroma.range > 0);
  const monochromatic = recipe.hue.mode === PaletteV2.hueMode.HARMONY &&
    recipe.hue.harmony === PaletteV2.harmony.MONOCHROMATIC;

  return {
    baseHue: hasColor,
    hueMode: hasColor,
    harmony: hasColor && recipe.hue.mode === PaletteV2.hueMode.HARMONY,
    colorPath: hasColor && !monochromatic,
    chromaRange: variedChroma,
    lightnessRange: recipe.lightness.curve !== PaletteV2.curve.CONSTANT,
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
    recipe.domain = PaletteV2.domain.LOOP;
    recipe.hue.mode = PaletteV2.hueMode.SWEEP;
    recipe.hue.sweepTurns = 1;
    recipe.chroma.center = 0.72;
    return recipe;
  },
  tonalMonochrome() {
    const recipe = defaultPaletteRecipe();
    recipe.hue.harmony = PaletteV2.harmony.MONOCHROMATIC;
    recipe.lightness.curve = PaletteV2.curve.ASCENDING;
    recipe.lightness.center = 0.52;
    recipe.lightness.range = 0.72;
    recipe.chroma.curve = PaletteV2.curve.BELL;
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
