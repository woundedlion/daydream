/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

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
 *   unknown or carries none — the caller substitutes a default list rather than
 *   leaving the sidebar and the effect switch with nothing to offer.
 */
export function resolutionEffects(presets, resolution) {
  const preset = Object.hasOwn(presets, resolution) ? presets[resolution] : null;
  return preset?.favorites ?? null;
}

// Workbench effects: ShaderChain hosts scratch authoring and dynamic document
// previews (src/workbench/shader/shader_documents.js), alongside shipped documents.
export const WORKBENCH_EFFECTS = Object.freeze([
  'ShaderChain', ...SHADER_DOCUMENT_EFFECTS,
]);

const HiResFavorites = [
  "BZReactionDiffusion",
  "Fishbowl",
  "Comets",
  "AlienBrain",
  "KaleidoscopeHexSoft",
  "AlienOcean",
  "AlienCore",
  "KaleidoscopeMandala",
  "GridSpace",
  "HyperLattice",
  "AshCloud",
  "LatticeMelt",
  "ChromaticLichen",
  "MermaidSkin",
  "KaleidoscopePentBright",
  "KaleidoscopeHexOil",
  "KaleidoscopeStainedGlass",
  "KaleidoscopeSmooth",
  "KaleidoscopeHexBright",
  "KaleidoscopeFlowers",
  "CosmicEyeball",
  "DreamBalls",
  "MeshFeedback",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "HopfFibration",
  "IslamicStars",
  "MindSplatter",
  "MobiusGrid",
  "PetalFlow",
  "Raymarch",
  "RingSpin",
  "SphericalHarmonics",
  "DisplacementField",
  "ShapeShifter",
  "Voronoi",
];

const LoResFavorites = [
  "BZReactionDiffusion",
  "Fishbowl",
  "Comets",
  "AlienBrain",
  "KaleidoscopeHexSoft",
  "AlienOcean",
  "AlienCore",
  "KaleidoscopeMandala",
  "GridSpace",
  "HyperLattice",
  "AshCloud",
  "LatticeMelt",
  "ChromaticLichen",
  "MermaidSkin",
  "KaleidoscopePentBright",
  "KaleidoscopeHexOil",
  "KaleidoscopeStainedGlass",
  "KaleidoscopeSmooth",
  "KaleidoscopeHexBright",
  "KaleidoscopeFlowers",
  "CosmicEyeball",
  "Dynamo",
  "GnomonicStars",
  "GSReactionDiffusion",
  "HankinSolids",
  "IslamicStars",
  "MobiusGrid",
  "MobiusRings",
  "PetalFlow",
  "Raymarch",
  "RingShower",
  "RingSpin",
  "DisplacementField",
  "ShapeShifter",
  "Thrusters",
  "Voronoi",
];

// The effect the simulator seeds when the URL names none.
export const DEFAULT_EFFECT = 'IslamicStars';

// Display metadata (dot size), geometry, and the effect list offered per
// resolution. The dropdown offers only the subset the engine reports through
// getSupportedResolutions(). Null prototype: a URL string indexes this table, and
// an inherited key ("constructor", "toString") would answer as a preset.
/** @type {Record<string, {h: number, w: number, dotSize: number, favorites: string[]}>} */
export const resolutionPresets = Object.assign(Object.create(null), {
  "Holosphere (96x20)": { h: 20, w: 96, dotSize: 2, favorites: LoResFavorites },
  "Phantasm (288x144)": { h: 144, w: 288, dotSize: 0.25, favorites: HiResFavorites },
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
    return HiResFavorites;
  }
  return favorites;
}

/**
 * Resolve which effect should be active for a resolution's offered list. The
 * requested effect (from app state, including a `?effect=` deep link) is kept
 * when the resolution offers it; otherwise it falls back to the list's first
 * entry. The fallback is what stops an off-list request — a different-resolution
 * effect or a stale/garbage deep link — from leaving the canvas black.
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
