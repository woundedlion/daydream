/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
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
 * @property {number} falloffStart - Where a FALLOFF domain's fade (begun at t = 2/3)
 *   reaches zero visibility.
 */

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
