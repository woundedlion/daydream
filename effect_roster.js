/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The simulator's roster: the effects each resolution offers, the shader
 * documents the workbench carries, and the display metadata per resolution.
 */

import { resolutionEffects } from "./effect_sequencing.js";

export const SHADER_DOCUMENT_EFFECTS = Object.freeze([
  'alien-brain', 'kaleidoscope-hex-soft', 'alien-ocean', 'alien-core',
  'kaleidoscope-mandala', 'grid-space', 'ash-cloud', 'lattice-melt',
  'chromatic-lichen', 'mermaid-skin',
  'kaleidoscope-pent-bright', 'kaleidoscope-hex-oil',
  'kaleidoscope-stained-glass', 'kaleidoscope-smooth',
  'kaleidoscope-hex-bright', 'kaleidoscope-flowers',
  'cosmic-eyeball', 'mobius-grid',
]);

// Every effect the workbench page may hold: the scratch shader, the chain
// interpreter each dynamically previewed document is programmed onto
// (tools/shader_documents.js), and the shipped documents.
export const WORKBENCH_EFFECTS = Object.freeze([
  'Shader', 'ShaderChain', ...SHADER_DOCUMENT_EFFECTS,
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
export const resolutionPresets = {
  __proto__: null,
  "Holosphere (96x20)": { h: 20, w: 96, dotSize: 2, favorites: LoResFavorites },
  "Phantasm (288x144)": { h: 144, w: 288, dotSize: 0.25, favorites: HiResFavorites },
};

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
