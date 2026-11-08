/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import { EFFECT_IDENTITIES } from '../../generated/engine_contract.mjs';
import { SHADER_DOCUMENT_EFFECTS } from '../../generated/shader/composed_effect_roster.mjs';
export { SHADER_DOCUMENT_EFFECTS };

/**
 * The simulator's roster: the effects each resolution offers, the shader
 * documents the workbench carries, and the display metadata per resolution.
 */

/**
 * The effect list a resolution preset offers.
 * @param {Object<string, {favorites?: Array<string>}>} presets - Preset label to
 *   its definition.
 * @param {string} resolution - A preset label.
 * @returns {Array<string>|null} That preset's list, or null when the preset is
 *   unknown or carries none.
 */
export function resolutionEffects(presets, resolution) {
  const preset = Object.hasOwn(presets, resolution) ? presets[resolution] : null;
  return preset?.favorites ?? null;
}

// Workbench effects: ShaderChain (scratch authoring and dynamic document
// previews) plus the shipped documents.
export const WORKBENCH_EFFECTS = Object.freeze([
  'ShaderChain', ...SHADER_DOCUMENT_EFFECTS,
]);

const SharedFavorites = [
  "BZReactionDiffusion",
  "Fishbowl",
  "Comets",
  "AlienBrain",
  "AlienOcean",
  "AlienCore",
  "KaleidoscopeMandala",
  "GridSpace",
  "GridWorms",
  "GridWarp",
  "LiquidWindows",
  "Iridescence",
  "Millefiori",
  "Involution",
  "HyperLattice",
  "AshCloud",
  "KaleidoscopeMelt",
  "ChromaticLichen",
  "MermaidSkin",
  "JewelMelt",
  "KaleidoscopeHexOil",
  "KaleidoscopeStainedGlass",
  "KaleidoscopeSmooth",
  "KaleidoscopeHexBright",
  "KaleidoscopeFlowers",
  "CosmicEyeball",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "IslamicStars",
  "Galaxies",
  "MobiusGrid",
  "PetalFlow",
  "Raymarch",
  "RingSpin",
  "DisplacementField",
  "ShapeShifter",
];

const HiResFavorites = [
  ...SharedFavorites,
  "DreamBalls",
  "MeshFeedback",
  "HopfFibration",
  "MindSplatter",
  "SphericalHarmonics",
];

const LoResFavorites = [
  ...SharedFavorites,
  "Dynamo",
  "MobiusRings",
  "RingShower",
  "Thrusters",
];

/**
 * The registered effects no curated list names, in registry order.
 * @param {Array<{display_name: string}>} identities - The engine's effect registry.
 * @param {Array<Array<string>>} lists - The curated effect lists.
 * @returns {Array<string>} Display names of the simulator effects absent from
 *   every list; the workbench-only ShaderChain is never included.
 */
export function unlistedEffects(identities, lists) {
  const listed = new Set(lists.flat());
  return identities.map(({ display_name }) => display_name)
    .filter((name) => name !== 'ShaderChain' && !listed.has(name));
}

// Registered effects missing from every curated list are offered at every resolution.
const AllFallback = unlistedEffects(EFFECT_IDENTITIES, [HiResFavorites, LoResFavorites]);

// The effect the simulator seeds when the URL names none.
export const DEFAULT_EFFECT = 'Millefiori';

// Display metadata (dot size), geometry, and the effect list offered per
// resolution. Null prototype: a URL string indexes this table, and an inherited
// key ("constructor", "toString") would answer as a preset.
/** @type {Record<string, {h: number, w: number, dotSize: number, favorites: string[]}>} */
export const resolutionPresets = Object.assign(Object.create(null), {
  "Holosphere (96x20)": { h: 20, w: 96, dotSize: 2, favorites: [...LoResFavorites, ...AllFallback] },
  "Phantasm (288x144)": { h: 144, w: 288, dotSize: 0.25, favorites: [...HiResFavorites, ...AllFallback] },
});

/**
 * The effect list offered at a resolution.
 * @param {string} resolution - A resolutionPresets key.
 * @returns {string[]} That preset's favorites, or the high-res list when the
 *   preset is unknown or carries none.
 */
export function favoritesFor(resolution) {
  const favorites = resolutionEffects(resolutionPresets, resolution);
  if (!favorites) {
    console.error(`No effect list for resolution "${resolution}"; offering the high-res list.`);
    return resolutionPresets["Phantasm (288x144)"].favorites;
  }
  return favorites;
}

/**
 * Resolve which effect should be active for a resolution's offered list. The
 * requested effect (from app state, including a `?effect=` deep link) is kept
 * when the resolution offers it; otherwise it falls back to the list's first
 * entry.
 * @param {Array<string>} availableEffects - Effects offered at this resolution.
 * @param {string} currentEffect - The requested/active effect name.
 * @returns {string} The effect to activate: currentEffect if offered, else the
 *   first available effect (undefined only when the list is empty).
 */
export function resolveActiveEffect(availableEffects, currentEffect) {
  return availableEffects.includes(currentEffect)
    ? currentEffect
    : availableEffects[0];
}
