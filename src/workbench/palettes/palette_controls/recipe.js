/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { wrapTurns, signedTurnDelta, equivalentTurnNear, axisEndpoints, axisFromEndpoints } from './math.js';
import { PaletteV4 } from './model.js';

/** @typedef {import('./model.js').PaletteAxis} PaletteAxis */
/** @typedef {import('./model.js').PaletteRecipe} PaletteRecipe */

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
 * @param {import('.././palette_recipe_model.js').DeepReadonly<PaletteRecipe>} recipe - A V4 palette recipe.
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
 * @param {import('.././palette_recipe_model.js').DeepReadonly<PaletteRecipe>} recipe - A V4 palette recipe.
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
 * @param {PaletteRecipe} recipe - Custom keys and the target harmony.
 * @returns {number} Harmony base placing its first anchor on the first custom key.
 */
export function harmonyBaseFromCustomKeys(recipe) {
  return wrapTurns(recipe.hue.customTurns[0] - harmonyRelationships(recipe)[0]);
}

/**
 * @param {ReadonlyArray<number>} keys - Evenly spaced key values.
 * @param {number} count - How many keys to resample to; at least two.
 * @returns {number[]} The same shape linearly resampled to `count` keys.
 */
function resampleKeys(keys, count) {
  if (keys.length === 1) return new Array(count).fill(keys[0]);
  return Array.from({ length: count }, (_, i) => {
    const scaled = i / (count - 1) * (keys.length - 1);
    const left = Math.floor(scaled);
    const right = Math.min(left + 1, keys.length - 1);
    return keys[left] + (keys[right] - keys[left]) * (scaled - left);
  });
}

/**
 * Mirror of core/color/generative_palette.h control_key_count.
 * @param {PaletteRecipe} recipe - A V4 palette recipe.
 * @returns {number} How many hue keys, and CUSTOM axis points, the recipe reads.
 */
function controlKeyCount(recipe) {
  if (recipe.hue.mode === PaletteV4.hueMode.SWEEP) return 2;
  if (recipe.hue.mode === PaletteV4.hueMode.CUSTOM) return 3;
  switch (recipe.hue.harmony) {
    case PaletteV4.harmony.ANALOGOUS:
    case PaletteV4.harmony.SPLIT_COMPLEMENTARY:
    case PaletteV4.harmony.TRIADIC:
      return 3;
    case PaletteV4.harmony.ACCENTED_ANALOGOUS:
    case PaletteV4.harmony.TETRADIC:
    case PaletteV4.harmony.SQUARE:
      return 4;
    default:
      return 2;
  }
}

/**
 * Resamples a CUSTOM axis' authored points onto a new key count and zeroes the
 * slots past it.
 * @param {PaletteAxis} axis - A recipe axis; rewritten in place.
 * @param {number} from - The key count its points were authored for.
 * @param {number} to - The key count the recipe now reads.
 * @returns {void}
 */
function resampleCustomAxis(axis, from, to) {
  if (axis.curve !== PaletteV4.curve.CUSTOM || from === to) return;
  const points = resampleKeys(axis.custom.slice(0, from), to);
  for (let i = 0; i < axis.custom.length; i++) axis.custom[i] = points[i] ?? 0;
}

/**
 * @param {import('.././palette_recipe_model.js').DeepReadonly<PaletteRecipe>} recipe - A V4 palette recipe.
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
 * @param {import('.././palette_recipe_model.js').DeepReadonly<PaletteRecipe>} recipe - A V4 palette recipe.
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
 * @param {import('.././palette_recipe_model.js').DeepReadonly<PaletteRecipe>} recipe - A V4 palette recipe.
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
    turns = resampleKeys(directedHarmonyTurns(recipe), 3);
  }

  return hueKeyStateFromTurns(turns);
}

/**
 * @param {import('.././palette_recipe_model.js').DeepReadonly<PaletteRecipe>} recipe - The recipe before switching to CUSTOM.
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
 * @param {ReadonlyArray<number>} offsets - The three keys' offsets from the base.
 * @param {ReadonlyArray<number>} [template] - Array the untouched fourth slot is carried over from.
 * @param {number[]} [out] - Array the turns are written into; it may be `template` itself.
 * @returns {number[]} `out`: the four turns a recipe's hue.customTurns holds.
 */
export function customHueTurns(baseTurns, offsets, template = [0, 0, 0, 0],
  out = [...template]) {
  for (let i = 0; i < 3; i++) out[i] = wrapTurns(baseTurns) + offsets[i];
  return out;
}

/**
 * The offset a custom hue key takes when moved onto the turn a drag landed on:
 * the representative of `wrappedTurn` nearest where the key already was, so a
 * drag across the seam does not spin it the long way round. Offsets beyond
 * ±2 turns can move inward but cannot wind further out.
 * @param {number} baseTurns - The keys' base hue.
 * @param {number} offset - The moved key's current offset from the base.
 * @param {number} wrappedTurn - The pointed-at hue, as read off the wheel.
 * @returns {number} The key's new offset.
 */
export function movedHueKeyOffset(baseTurns, offset, wrappedTurn) {
  const nextTurn = equivalentTurnNear(wrappedTurn, baseTurns + offset);
  const limit = Math.max(2, Math.abs(offset));
  return Math.max(-limit, Math.min(limit, nextTurn - baseTurns));
}

/**
 * Where a FALLOFF domain's fade (begun at t = 2/3) reaches zero visibility, as
 * core/color/palette_recipe.h defaults it.
 */
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
 * @property {number} falloffStart - Where a FALLOFF domain's fade (begun at t = 2/3)
 *   reaches zero visibility.
 */

/**
 * Marshals the generative tab's control readings into a V4 recipe.
 * A CUSTOM-curve axis keeps the template's custom points, resampled when the
 * hue readings change the key count, and ignores endpoint readings.
 * @param {PaletteRecipe} template - Recipe the reading is applied over; deep-cloned, never mutated.
 * @param {PaletteControlReadings} controls - The control readings.
 * @returns {PaletteRecipe} The recipe.
 * @throws {RangeError} When a reading names no PaletteV4 member of its group.
 */
export function paletteRecipeFromControls(template, controls) {
  return applyPaletteControls(structuredClone(template), controls);
}

/**
 * @param {PaletteAxis} axis - A recipe axis.
 * @param {{readonly minimum: number, readonly maximum: number}} endpoints - Its endpoint readings.
 * @returns {void}
 */
function applyAxisEndpoints(axis, endpoints) {
  if (axis.curve !== PaletteV4.curve.CUSTOM)
    axisFromEndpoints(endpoints.minimum, endpoints.maximum, axis);
}

/**
 * paletteRecipeFromControls in place: overwrites the reading-driven fields of
 * a recipe that already holds the template.
 * @param {PaletteRecipe} recipe - A copy of the template; rewritten in place.
 * @param {Readonly<PaletteControlReadings>} controls - The control readings.
 * @returns {PaletteRecipe} `recipe`.
 * @throws {RangeError} When a reading names no PaletteV4 member of its group.
 */
export function applyPaletteControls(recipe, controls) {
  const templateKeyCount = controlKeyCount(recipe);
  recipe.input.offset = controls.window.offset;
  recipe.input.span = controls.window.span;
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
    customHueTurns(recipe.hue.baseTurns, controls.customHueOffsets,
      recipe.hue.customTurns, recipe.hue.customTurns);
    const offset = Math.floor(recipe.hue.customTurns[0]);
    for (let key = 0; key < 3; key++) recipe.hue.customTurns[key] -= offset;
    // The keys carry the base hue; the engine canonicalizes the field away.
    recipe.hue.baseTurns = 0;
  }
  if (recipe.hue.mode !== PaletteV4.hueMode.CUSTOM)
    recipe.hue.customTurns = [...DEFAULT_HUE.customTurns];
  recipe.lightness.curve = paletteEnumOrdinal('curve', controls.lightnessCurve);
  recipe.chroma.curve = paletteEnumOrdinal('curve', controls.chromaCurve);
  applyAxisEndpoints(recipe.lightness, controls.lightness);
  applyAxisEndpoints(recipe.chroma, controls.chroma);
  const defaults = defaultPaletteRecipe();
  if (recipe.lightness.curve !== PaletteV4.curve.CUSTOM)
    recipe.lightness.custom = [...defaults.lightness.custom];
  if (recipe.chroma.curve !== PaletteV4.curve.CUSTOM)
    recipe.chroma.custom = [...defaults.chroma.custom];
  const keyCount = controlKeyCount(recipe);
  resampleCustomAxis(recipe.lightness, templateKeyCount, keyCount);
  resampleCustomAxis(recipe.chroma, templateKeyCount, keyCount);
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
  paletteEnumName('chromaBasis', recipe.chroma.basis);
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
 * @param {import('.././palette_recipe_model.js').DeepReadonly<PaletteRecipe>} recipe - A V4 palette recipe.
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
    hueKeys: hasColor,
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
