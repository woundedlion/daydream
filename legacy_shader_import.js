/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

export const LEGACY_SHADER_ALIAS = 'ShaderBall';

export const LEGACY_SHADER_PRESETS = Object.freeze([
  ['SignalWeave', 'signal-weave'],
  ['KaleidoWave', 'twin-wave'],
  ['AlienOcean', 'folded-grid'],
  ['GlitchGrid', 'folded-glitch'],
  ['Shader', 'peirce-facets'],
  ['FacetWave', 'wave-mirror'],
  ['ContourLattice', 'affine-contour'],
  ['CurlLattice', 'open-curl'],
  ['CurlLattice', 'dense-curl'],
  ['PrismLattice', 'polar-wave'],
  ['VectorFacets', 'vector-mirror'],
  ['FacetGrid', 'coupled-grid'],
  ['HexWave', 'hex-twin-wave'],
  ['FacetGrid', 'direct-grid'],
  ['FacetGrid', 'double-map'],
  ['EquatorGrid', 'double-map'],
  ['EquatorGrid', 'open-grid'],
  ['EquatorGrid', 'fine-grid'],
  ['CosmicEyeball', 'mirrored-grid'],
  ['MobiusGrid', 'mobius-grid'],
  ['MobiusGrid', 'mobius-grid-2'],
  ['SignalWeave', 'signal-weave-2'],
  ['SignalWeave', 'signal-weave-3'],
  ['SignalWeave', 'signal-weave-4'],
]);

export const PIPELINE_EFFECTS = Object.freeze({
  GLITCH_NOISE_GRID_WAVE_SHEAR: 'SignalWeave',
  KALEIDOSCOPE_TWIN_WAVE_INNER_MIRROR: 'KaleidoWave',
  GNOMONIC_KALEIDOSCOPE_GRID_MIRROR: 'AlienOcean',
  GNOMONIC_GLITCH_GRID_MIRROR: 'GlitchGrid',
  PEIRCE_DODECAHEDRAL_GRID: 'Shader',
  GNOMONIC_DODECAHEDRAL_GRID_WAVE_MIRROR: 'FacetWave',
  GNOMONIC_AFFINE_LATTICE_CONTOUR: 'ContourLattice',
  SINUSOIDAL_CURL_LATTICE: 'CurlLattice',
  STEREOGRAPHIC_PRISM_POLAR_WAVE_LATTICE: 'PrismLattice',
  GNOMONIC_DODECAHEDRAL_GRID_VECTOR_MIRROR: 'VectorFacets',
  STEREOGRAPHIC_DODECAHEDRAL_GRID_INNER_MIRROR: 'FacetGrid',
  STEREOGRAPHIC_HEXAGONAL_PRISM_TWIN_WAVE_INNER_MIRROR: 'HexWave',
  EQUIRECTANGULAR_DODECAHEDRAL_GRID_INNER_MIRROR: 'EquatorGrid',
  STEREOGRAPHIC_GLITCH_GRID_MIRROR: 'CosmicEyeball',
  STEREOGRAPHIC_MOBIUS_TWIN_WAVE_INNER_MIRROR: 'MobiusGrid',
});

/**
 * Classifies a supported ShaderBall save before current effect-name validation.
 * @param {string} effect - Persisted effect name.
 * @param {Object|null} snapshot - Versioned legacy snapshot, when available.
 * @returns {{effect: string, migrated: boolean, presetId?: string,
 *   snapshot?: Object|null, customParameters?: Object|null,
 *   handoff?: Object|null, notice?: string, diagnostic?: string}} The effect to
 *   open and whether it was migrated, always. A migration also carries a
 *   `notice` to show, and one of: `presetId` for a preset that maps to a
 *   concrete effect, `customParameters` for a recognized custom pipeline,
 *   `snapshot` for a document handed to Shader whole. A null `snapshot` carries
 *   nothing across: with a `diagnostic` code the save was unusable, without one
 *   no save was supplied at all. `handoff` carries the legacy runtime state
 *   whenever the save had any.
 */
export function importLegacyShaderSelection(effect, snapshot = null) {
  if (effect !== LEGACY_SHADER_ALIAS) return { effect, migrated: false };
  if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) {
    return {
      effect: 'Shader', migrated: true, snapshot: null,
      notice: 'The legacy ShaderBall state was invalid; Shader opened with defaults.',
      diagnostic: 'INVALID_LEGACY_SHADER_SNAPSHOT',
    };
  }
  const schemaVersion = snapshot?.schemaVersion ?? snapshot?.schema_version ?? 1;
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 2) {
    return {
      effect: 'Shader', migrated: true, snapshot: null,
      notice: 'This ShaderBall save version is unsupported; Shader opened with defaults.',
      diagnostic: 'UNSUPPORTED_LEGACY_SHADER_VERSION',
    };
  }
  if (Number.isInteger(snapshot?.presetIndex)
      && snapshot.presetIndex >= 0 && snapshot.presetIndex < LEGACY_SHADER_PRESETS.length) {
    const [destination, presetId] = LEGACY_SHADER_PRESETS[snapshot.presetIndex];
    return {
      effect: destination, presetId, migrated: true, handoff: snapshot.runtime ?? null,
      notice: `Migrated ShaderBall preset ${snapshot.presetIndex} to ${destination}.`,
    };
  }
  const pipeline = snapshot?.acceptedPipeline ?? snapshot?.pipeline;
  if (typeof pipeline === 'string' && Object.hasOwn(PIPELINE_EFFECTS, pipeline)
      && !snapshot?.pendingPipeline) {
    return {
      effect: PIPELINE_EFFECTS[pipeline], migrated: true,
      customParameters: snapshot.accepted ?? null,
      handoff: snapshot.runtime ?? null,
      notice: `Migrated a custom ShaderBall configuration to ${PIPELINE_EFFECTS[pipeline]}.`,
    };
  }
  // A bare ShaderBall identity carries no document, so the notice must not claim
  // state was brought across: both production call sites reach here that way.
  return {
    effect: 'Shader', migrated: true, snapshot,
    notice: snapshot === null
      ? 'ShaderBall is now Shader; opened with defaults.'
      : 'Opened the legacy ShaderBall document in Shader with its pending and runtime state.',
  };
}
