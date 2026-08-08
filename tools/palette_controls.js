/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

const clampUnit = (value) => Math.max(0, Math.min(1, value));

export const wrapTurns = (turns) => turns - Math.floor(turns);

export function signedTurnDelta(delta) {
  const wrapped = wrapTurns(delta);
  if (wrapped < 0.5) return wrapped;
  if (wrapped > 0.5) return wrapped - 1;
  return delta < 0 ? -0.5 : 0.5;
}

export function equivalentTurnNear(wrappedTurn, referenceTurn) {
  return referenceTurn + signedTurnDelta(wrappedTurn - referenceTurn);
}

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

export function paletteTabFromSearch(search) {
  const tab = new URLSearchParams(search).get('tab');
  return PALETTE_TABS.has(tab) ? tab : 'procedural';
}

export function paletteTabUrl(href, tab) {
  if (!PALETTE_TABS.has(tab)) throw new RangeError(`Unknown palette tab: ${tab}`);
  const url = new URL(href);
  url.searchParams.set('tab', tab);
  return url.href;
}

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

function harmonyRelationships(recipe) {
  const { baseTurns: base, spreadTurns: spread, harmony, direction } = recipe.hue;
  const orientation = direction === PaletteV4.direction.CLOCKWISE ? -1 : 1;
  switch (harmony) {
    case PaletteV4.harmony.MONOCHROMATIC:
      return [base];
    case PaletteV4.harmony.ANALOGOUS:
      return [base - orientation * spread, base, base + orientation * spread];
    case PaletteV4.harmony.ACCENTED_ANALOGOUS:
      return [base - orientation * spread, base, base + orientation * spread,
        base + orientation * 0.5];
    case PaletteV4.harmony.COMPLEMENTARY:
      return [base, base + orientation * 0.5];
    case PaletteV4.harmony.SPLIT_COMPLEMENTARY:
      return [base, base + orientation * (0.5 - spread),
        base + orientation * (0.5 + spread)];
    case PaletteV4.harmony.TRIADIC:
      return [base, base + orientation / 3, base + orientation * 2 / 3];
    case PaletteV4.harmony.TETRADIC:
      return [base, base + orientation * spread, base + orientation * 0.5,
        base + orientation * (0.5 + spread)];
    case PaletteV4.harmony.SQUARE:
      return [base, base + orientation * 0.25, base + orientation * 0.5,
        base + orientation * 0.75];
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
  return turns;
}

function hueKeyStateFromTurns(turns) {
  const anchor = turns[0];
  return {
    baseTurns: wrapTurns(anchor),
    offsets: turns.map((turn) => turn - anchor),
  };
}

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

export function customHueTurns(baseTurns, offsets, template = [0, 0, 0, 0]) {
  const turns = [...template];
  for (let i = 0; i < 3; i++) turns[i] = wrapTurns(baseTurns) + offsets[i];
  return turns;
}

export function moveCustomHueKey(baseTurns, offsets, keyIndex, wrappedTurn) {
  const nextOffsets = [...offsets];
  const currentTurn = baseTurns + nextOffsets[keyIndex];
  const nextTurn = equivalentTurnNear(wrappedTurn, currentTurn);
  nextOffsets[keyIndex] = Math.max(-2, Math.min(2, nextTurn - baseTurns));
  return nextOffsets;
}

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
