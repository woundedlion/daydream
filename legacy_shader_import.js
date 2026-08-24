/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

export const LEGACY_SHADER_ALIAS = 'ShaderBall';

export const LEGACY_SHADER_PRESETS = Object.freeze([
  ['AlienBrain', 'alien-brain'],
  ['KaleidoscopeHexSoft', 'twin-wave'],
  ['AlienOcean', 'folded-grid'],
  ['AlienCore', 'folded-glitch'],
  ['Shader', 'peirce-facets'],
  ['KaleidoscopeMandala', 'wave-mirror'],
  ['GridSpace', 'affine-contour'],
  ['LatticeMelt', 'open-curl'],
  ['LatticeMelt', 'dense-curl'],
  ['KaleidoscopePentBright', 'polar-wave'],
  ['KaleidoscopeStainedGlass', 'vector-mirror'],
  ['KaleidoscopeSmooth', 'coupled-grid'],
  ['KaleidoscopeHexBright', 'hex-twin-wave'],
  ['KaleidoscopeSmooth', 'direct-grid'],
  ['KaleidoscopeSmooth', 'double-map'],
  ['KaleidoscopeFlowers', 'double-map'],
  ['KaleidoscopeFlowers', 'open-grid'],
  ['KaleidoscopeFlowers', 'fine-grid'],
  ['CosmicEyeball', 'mirrored-grid'],
  ['MobiusGrid', 'mobius-grid'],
  ['MobiusGrid', 'mobius-grid-2'],
  ['AlienBrain', 'alien-brain-2'],
  ['AlienBrain', 'alien-brain-3'],
  ['AlienBrain', 'alien-brain-4'],
]);

/** @type {Readonly<Record<string, string>>} */
export const PIPELINE_EFFECTS = Object.freeze({
  GLITCH_NOISE_GRID_WAVE_SHEAR: 'AlienBrain',
  KALEIDOSCOPE_TWIN_WAVE_INNER_MIRROR: 'KaleidoscopeHexSoft',
  GNOMONIC_KALEIDOSCOPE_GRID_MIRROR: 'AlienOcean',
  GNOMONIC_ALIEN_CORE_MIRROR: 'AlienCore',
  PEIRCE_DODECAHEDRAL_GRID: 'Shader',
  GNOMONIC_DODECAHEDRAL_GRID_WAVE_MIRROR: 'KaleidoscopeMandala',
  GNOMONIC_AFFINE_LATTICE_CONTOUR: 'GridSpace',
  SINUSOIDAL_LATTICE_MELT: 'LatticeMelt',
  STEREOGRAPHIC_PRISM_POLAR_WAVE_LATTICE: 'KaleidoscopePentBright',
  GNOMONIC_DODECAHEDRAL_GRID_VECTOR_MIRROR: 'KaleidoscopeStainedGlass',
  STEREOGRAPHIC_DODECAHEDRAL_GRID_INNER_MIRROR: 'KaleidoscopeSmooth',
  STEREOGRAPHIC_HEXAGONAL_PRISM_TWIN_WAVE_INNER_MIRROR: 'KaleidoscopeHexBright',
  EQUIRECTANGULAR_DODECAHEDRAL_GRID_INNER_MIRROR: 'KaleidoscopeFlowers',
  STEREOGRAPHIC_ALIEN_CORE_MIRROR: 'CosmicEyeball',
  STEREOGRAPHIC_MOBIUS_TWIN_WAVE_INNER_MIRROR: 'MobiusGrid',
});

/**
 * A persisted ShaderBall save. Every field is optional: what a stored document
 * carried is whatever the ShaderBall of its day wrote, and classifying that is
 * this module's job.
 * @typedef {Object} LegacyShaderSnapshot
 * @property {number} [schemaVersion] - Save version, current spelling.
 * @property {number} [schema_version] - Save version, snake-case spelling.
 * @property {number} [presetIndex] - Selected legacy preset.
 * @property {string} [acceptedPipeline] - Pipeline the engine last accepted.
 * @property {string} [pipeline] - Pipeline, pre-accepted/requested split.
 * @property {boolean} [pendingPipeline] - A structural edit the engine had not taken.
 * @property {number[]} [accepted] - Accepted configuration field values.
 * @property {number[]} [runtime] - Legacy runtime state to hand across.
 */

/**
 * Classifies a supported ShaderBall save before current effect-name validation.
 * @param {string} effect - Persisted effect name.
 * @param {LegacyShaderSnapshot|null} snapshot - Versioned legacy snapshot, when available.
 * @returns {{effect: string, migrated: boolean, presetId?: string,
 *   snapshot?: LegacyShaderSnapshot|null, customParameters?: Object|null,
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
  const presetIndex = snapshot?.presetIndex;
  if (typeof presetIndex === 'number' && Number.isInteger(presetIndex)
      && presetIndex >= 0 && presetIndex < LEGACY_SHADER_PRESETS.length) {
    const [destination, presetId] = LEGACY_SHADER_PRESETS[presetIndex];
    return {
      effect: destination, presetId, migrated: true, handoff: snapshot?.runtime ?? null,
      notice: `Migrated ShaderBall preset ${presetIndex} to ${destination}.`,
    };
  }
  const pipeline = snapshot?.acceptedPipeline ?? snapshot?.pipeline;
  if (typeof pipeline === 'string' && Object.hasOwn(PIPELINE_EFFECTS, pipeline)
      && !snapshot?.pendingPipeline) {
    const destination = PIPELINE_EFFECTS[pipeline];
    return {
      effect: destination, migrated: true,
      customParameters: snapshot?.accepted ?? null,
      handoff: snapshot?.runtime ?? null,
      notice: `Migrated a custom ShaderBall configuration to ${destination}.`,
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
