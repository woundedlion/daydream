/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Which pipeline stage each engine parameter of a shader effect belongs to, and
 * what a stage folder and its controls are called. Three schemas are recognized:
 * ShaderBall's selector-driven one, the versioned Fixed Shader snapshot, and the
 * composed LatticeMelt and KaleidoscopeSmooth rosters. The named rosters list
 * membership only; every schema stages a parameter through the one
 * STAGE_BY_PARAMETER table, so no two can place the same name differently. Name
 * classification only, so the taxonomy is readable and testable apart from the
 * panel that renders it.
 */

export const STAGE_ORDER = [
  'Camera',
  'Lens',
  'Surface Noise',
  'Projection Frame',
  'Projection',
  'Planar Warp 1',
  'Planar Warp 2',
  'Function',
  'Signal Weight',
  'Value Transfer',
  'Coverage',
  'Colorize',
];
export const LATTICE_MELT_STAGE_ORDER = [
  'Camera',
  'Surface Noise',
  'Projection Frame',
  'Projection',
  'Function',
  'Colorize',
];
export const KALEIDOSCOPE_SMOOTH_STAGE_ORDER = [
  'Camera',
  'Projection Frame',
  'Projection',
  'Planar Warp 2',
  'Function',
  'Colorize',
];
export const LATTICE_MELT_STAGE_TITLES = new Map([
  ['Camera', 'Camera'],
  ['Surface Noise', 'Curl'],
  ['Projection Frame', 'Spin + Wander'],
  ['Projection', 'Folded Sinusoidal'],
  ['Function', 'Primitive Lattice'],
  ['Colorize', 'Generated Triadic'],
]);
export const KALEIDOSCOPE_SMOOTH_STAGE_TITLES = new Map([
  ['Camera', 'Camera'],
  ['Projection Frame', 'Spin + Wander'],
  ['Projection', 'Stereographic'],
  ['Planar Warp 2', 'Mirror Tile'],
  ['Function', 'Grid'],
  ['Colorize', 'Generated Analogous'],
]);
/** @type {Map<string, [string, string[]]>} */
export const FIXED_SHADER_MODE_FIELDS = new Map([
  ['Function', ['slots.function', [
    'Twin Wave', 'Rings', 'Spiral', 'Grid', 'Noise Contour (Projected)',
    'Primitive Lattice', 'Noise Contour (Sphere)', 'Spherical Rings',
    'Escape Fractal', 'Tessellation',
  ]]],
  ['Projection', ['slots.projection', [
    'Folded Sinusoidal', 'Stereographic', 'Gnomonic', 'Bonne',
    'Peirce Quincuncial', 'Dymaxion / Airocean', 'Equirectangular',
  ]]],
  ['Projection Frame', ['slots.projection_frame', [
    'Identity', 'Spin + Wander',
  ]]],
  ['Surface Noise', ['slots.surface_noise', ['None', 'Direct', 'Curl']]],
  ['Lens', ['slots.surface_lens', [
    'None',
    'Glitch',
    'Twist',
    'Kaleidoscope (Azimuthal 6-fold)',
    'Mobius',
    'Kaleidoscope (Tetrahedral)',
    'Kaleidoscope (Octahedral / Cubic)',
    'Kaleidoscope (Dodecahedral / Icosahedral)',
    'Kaleidoscope (Triangular Prism)',
    'Kaleidoscope (Square Prism)',
    'Kaleidoscope (Pentagonal Prism)',
    'Kaleidoscope (Hexagonal Prism)',
    'Kaleidoscope (Octagonal Prism)',
  ]]],
  ['Planar Warp 1', ['slots.warp_program.outer.kind', [
    'None', 'Affine Frame', 'Wave Shear', 'Vortex',
    'Projected Vector Noise', 'Projected Curl Flow', 'Mirror Tile',
    'Polar Chart',
  ]]],
  ['Planar Warp 2', ['slots.warp_program.inner.kind', [
    'None', 'Affine Frame', 'Wave Shear', 'Vortex',
    'Projected Vector Noise', 'Projected Curl Flow', 'Mirror Tile',
    'Polar Chart',
  ]]],
  ['Signal Weight', ['slots.signal_weight', ['None', 'Projection']]],
  ['Value Transfer', ['slots.value_transfer', [
    'None', 'Ridge', 'Iso Contour', 'Smooth Bands',
  ]]],
  ['Coverage', ['slots.coverage', [
    'Opaque', 'Projection Weight Squared', 'Value Cutout', 'Edge Fade',
    'Projection Weight',
  ]]],
  ['Colorize', ['slots.palette', [
    'Generated Triadic', 'Generated Complementary', 'Generated Analogous',
  ]]],
]);
export const STAGE_BOUNDARIES = new Map([
  ['Function', 'Function'],
  ['Projection', 'Projection'],
  ['Projection Frame', 'Projection Frame'],
  ['Camera Wander', 'Camera'],
  ['Surface Noise', 'Surface Noise'],
  ['Lens', 'Lens'],
  ['Planar Warp 1', 'Planar Warp 1'],
  ['Planar Warp 2', 'Planar Warp 2'],
  ['Signal Weight', 'Signal Weight'],
  ['Value Transfer', 'Value Transfer'],
  ['Coverage', 'Coverage'],
  ['Palette', 'Colorize'],
]);
const SHADERBALL_SIGNATURE = [
  'Function', 'Projection', 'Lens', 'Planar Warp 1', 'Planar Warp 2',
  'Signal Weight', 'Value Transfer', 'Coverage', 'Palette',
];
const LATTICE_MELT_ROSTER = new Set([
  'Camera Wander', 'Surface Noise Scale', 'Surface Noise Strength',
  'Surface Noise Speed', 'Projection Spin Speed', 'Projection Wander',
  'Singularity Fade', 'Central Meridian', 'Lattice Cell Scale', 'Lattice Shape',
  'Lattice Softness', 'Lattice Radius', 'Palette Chroma', 'Palette Mapping',
  'Mapping Frequency', 'Mapping Phase', 'Phase Oscillation Depth',
  'Phase Oscillation Speed', 'Brightness Bottom', 'Brightness Top',
  'Opacity at Value 0', 'Opacity at Value 1', 'Hue Shift Amount', 'Hue Noise Scale',
  'Hue Noise Speed',
]);
const KALEIDOSCOPE_SMOOTH_ROSTER = new Set([
  'Camera Wander', 'Projection Spin Speed', 'Projection Wander',
  'Singularity Fade', 'Planar Warp 2 Speed', 'Planar Warp 2 Rotation',
  'Planar Warp 2 Cell X', 'Planar Warp 2 Cell Y', 'Planar Warp 2 Offset X',
  'Planar Warp 2 Offset Y', 'Pattern Freq', 'Speed', 'Source Angle Speed',
  'Complexity', 'Pattern Mix', 'Drift', 'Palette Chroma', 'Palette Mapping',
  'Mapping Frequency', 'Mapping Phase', 'Phase Oscillation Depth',
  'Phase Oscillation Speed', 'Opacity at Value 0', 'Opacity at Value 1',
  'Hue Shift Amount', 'Hue Noise Scale', 'Hue Noise Speed',
]);
const STAGE_BY_PARAMETER = new Map([
  ['Pattern Freq', 'Function'],
  ['Speed', 'Function'],
  ['Source Angle Speed', 'Function'],
  ['Complexity', 'Function'],
  ['Pattern Mix', 'Function'],
  ['Drift', 'Function'],
  ['Lattice Cell Scale', 'Function'],
  ['Lattice Shape', 'Function'],
  ['Lattice Softness', 'Function'],
  ['Lattice Radius', 'Function'],
  ['Singularity Fade', 'Projection'],
  ['Central Meridian', 'Projection'],
  ['Gnomonic Hemisphere', 'Projection'],
  ['Peirce Layout', 'Projection'],
  ['Projection Scale', 'Projection'],
  ['Projection Spin Speed', 'Projection Frame'],
  ['Projection Wander', 'Projection Frame'],
  ['Camera Wander', 'Camera'],
  ['Surface Noise Scale', 'Surface Noise'],
  ['Surface Noise Strength', 'Surface Noise'],
  ['Surface Noise Speed', 'Surface Noise'],
  ['Surface Noise Direction', 'Surface Noise'],
  ['Surface Noise Basis', 'Surface Noise'],
  ['Surface Noise Integrator', 'Surface Noise'],
  ['Surface Noise Placement', 'Surface Noise'],
  ['Mobius A Re', 'Lens'],
  ['Mobius A Im', 'Lens'],
  ['Mobius B Re', 'Lens'],
  ['Mobius B Im', 'Lens'],
  ['Mobius C Re', 'Lens'],
  ['Mobius C Im', 'Lens'],
  ['Mobius D Re', 'Lens'],
  ['Mobius D Im', 'Lens'],
  ['Mobius A Real', 'Lens'],
  ['Mobius A Imag', 'Lens'],
  ['Mobius B Real', 'Lens'],
  ['Mobius B Imag', 'Lens'],
  ['Mobius C Real', 'Lens'],
  ['Mobius C Imag', 'Lens'],
  ['Mobius D Real', 'Lens'],
  ['Mobius D Imag', 'Lens'],
  ['Planar Warp 1 Angular Phase', 'Planar Warp 1'],
  ['Planar Warp 1 Cell X', 'Planar Warp 1'],
  ['Planar Warp 1 Cell Y', 'Planar Warp 1'],
  ['Planar Warp 1 Edge Width', 'Planar Warp 1'],
  ['Planar Warp 1 Envelope', 'Planar Warp 1'],
  ['Planar Warp 1 Field Angle', 'Planar Warp 1'],
  ['Planar Warp 1 Frequency', 'Planar Warp 1'],
  ['Planar Warp 1 Noise Basis', 'Planar Warp 1'],
  ['Planar Warp 1 Offset X', 'Planar Warp 1'],
  ['Planar Warp 1 Offset Y', 'Planar Warp 1'],
  ['Planar Warp 1 Polar Harmonic', 'Planar Warp 1'],
  ['Planar Warp 1 Polar Mode', 'Planar Warp 1'],
  ['Planar Warp 1 Radial Phase', 'Planar Warp 1'],
  ['Planar Warp 1 Radial Scale', 'Planar Warp 1'],
  ['Planar Warp 1 Rotation', 'Planar Warp 1'],
  ['Planar Warp 1 Scale', 'Planar Warp 1'],
  ['Planar Warp 1 Scale X', 'Planar Warp 1'],
  ['Planar Warp 1 Scale Y', 'Planar Warp 1'],
  ['Planar Warp 1 Shear', 'Planar Warp 1'],
  ['Planar Warp 1 Strength', 'Planar Warp 1'],
  ['Planar Warp 1 Translation X', 'Planar Warp 1'],
  ['Planar Warp 1 Translation Y', 'Planar Warp 1'],
  ['Planar Warp 1 Vector Angle', 'Planar Warp 1'],
  ['Planar Warp 2 Cell X', 'Planar Warp 2'],
  ['Planar Warp 2 Cell Y', 'Planar Warp 2'],
  ['Planar Warp 2 Field Angle', 'Planar Warp 2'],
  ['Planar Warp 2 Frequency', 'Planar Warp 2'],
  ['Planar Warp 2 Offset X', 'Planar Warp 2'],
  ['Planar Warp 2 Offset Y', 'Planar Warp 2'],
  ['Planar Warp 2 Rotation', 'Planar Warp 2'],
  ['Planar Warp 2 Strength', 'Planar Warp 2'],
  ['Iso Level', 'Value Transfer'],
  ['Iso Width', 'Value Transfer'],
  ['Cutout Threshold', 'Coverage'],
  ['Cutout Softness', 'Coverage'],
  ['Edge Width', 'Coverage'],
  ['Edge Fade Width', 'Coverage'],
  ['Palette Chroma', 'Colorize'],
  ['Palette Mapping', 'Colorize'],
  ['Mapping Frequency', 'Colorize'],
  ['Mapping Phase', 'Colorize'],
  ['Phase Oscillation Depth', 'Colorize'],
  ['Phase Oscillation Speed', 'Colorize'],
  ['Brightness Bottom', 'Colorize'],
  ['Brightness Top', 'Colorize'],
  ['Opacity at Value 0', 'Colorize'],
  ['Opacity at Value 1', 'Colorize'],
  ['Hue Shift Amount', 'Colorize'],
  ['Hue Noise Scale', 'Colorize'],
  ['Hue Noise Speed', 'Colorize'],
]);
const WARP_STAGE_BOUNDARIES = new Map([
  ['Planar Warp 1 Speed', 'Planar Warp 1'],
  ['Planar Warp 2 Speed', 'Planar Warp 2'],
]);
const WARP_SLOT_PARAMETERS = new Set([
  'Affine Rotation Rate',
  'Affine Translation X',
  'Affine Translation Y',
  'Affine Scale X',
  'Affine Scale Y',
  'Affine Shear',
  'Warp Strength',
  'Warp Frequency',
  'Warp Field Angle',
  'Warp Scale',
  'Warp Vector Angle',
  'Mirror Rotation',
  'Mirror Cell X',
  'Mirror Cell Y',
  'Mirror Offset X',
  'Mirror Offset Y',
  'Polar Radial Scale',
  'Polar Radial Phase',
  'Polar Angular Phase',
]);

/**
 * @param {string} name - Canonical engine parameter name.
 * @returns {Array<string>} Former names accepted from saved deep links.
 */
export function legacyShaderBallParamNames(name) {
  if (name === 'Camera Wander') return ['Outer Wander'];
  if (name === 'Palette') return ['Colorizer'];
  if (name === 'Hue Shift Amount') return ['Hue Noise Amount', 'Hue Shift'];
  for (const [prefix, legacy] of [
    ['Planar Warp 1', 'Outer'],
    ['Planar Warp 2', 'Inner'],
  ]) {
    if (name === prefix) return [`${legacy} Warp`];
    if (!name.startsWith(`${prefix} `)) continue;
    const suffix = name.slice(prefix.length + 1);
    if (['Strength', 'Scale', 'Time', 'Envelope'].includes(suffix)) {
      return [`${legacy} Warp ${suffix}`];
    }
    return [`${legacy} ${suffix}`];
  }
  return [];
}

/**
 * Whether a parameter schema is ShaderBall's, recognized by its per-stage
 * selectors. The panel's stage grouping and the app's choice of persistence
 * strategy both key off this predicate, so the two cannot disagree about which
 * effect is loaded.
 * @param {Array<{name: string}>} params - Engine parameter definitions.
 * @returns {boolean} True when every stage selector is registered.
 */
export function isShaderBallSchema(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  return SHADERBALL_SIGNATURE.every((name) => names.has(name));
}

/**
 * @param {Array<{name: string}>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to pipeline-stage title.
 */
export function shaderBallStageAssignments(params) {
  if (!isShaderBallSchema(params)) return null;
  const assignments = new Map();
  let stage = 'Function';
  for (const parameter of params) {
    stage = STAGE_BOUNDARIES.get(parameter.name) ?? stage;
    assignments.set(parameter.name, stage);
  }
  return assignments;
}

/**
 * @param {string} name - Engine parameter name.
 * @returns {string|undefined} The pipeline stage the shader roster gives it.
 */
function stageOf(name) {
  return STAGE_BY_PARAMETER.get(name) ?? WARP_STAGE_BOUNDARIES.get(name);
}

/**
 * Stage every parameter of a named fixed pipeline, recognized by exact roster
 * match: a list carrying a name the roster does not claim, or missing one it
 * does, is some other effect's and is left to the generic recognizer.
 * @param {Array<{name: string}>} params - Engine parameter definitions in stream order.
 * @param {Set<string>} roster - The pipeline's complete parameter roster.
 * @returns {Map<string, string>|null} Parameter name to pipeline stage.
 */
function rosterStageAssignments(params, roster) {
  if (params.length !== roster.size) return null;
  const assignments = new Map();
  for (const parameter of params) {
    if (!roster.has(parameter.name)) return null;
    const stage = stageOf(parameter.name);
    if (!stage) return null;
    assignments.set(parameter.name, stage);
  }
  return assignments.size === roster.size ? assignments : null;
}

/**
 * @param {Array<{name: string}>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function latticeMeltStageAssignments(params) {
  return rosterStageAssignments(params, LATTICE_MELT_ROSTER);
}

/**
 * @param {Array<{name: string}>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function kaleidoscopeSmoothStageAssignments(params) {
  return rosterStageAssignments(params, KALEIDOSCOPE_SMOOTH_ROSTER);
}

/**
 * @param {Array<{name: string}>} params - Fixed Shader parameter definitions in
 *   engine registration order.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function fixedShaderStageAssignments(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  if (!names.has('Camera Wander') || !names.has('Palette Chroma')
      || !names.has('Mapping Frequency') || isShaderBallSchema(params)) {
    return null;
  }
  const assignments = new Map();
  let warpStage = null;
  for (const parameter of params) {
    warpStage = WARP_STAGE_BOUNDARIES.get(parameter.name) ?? warpStage;
    const stage = stageOf(parameter.name)
      ?? (WARP_SLOT_PARAMETERS.has(parameter.name) ? warpStage : null);
    if (stage) assignments.set(parameter.name, stage);
  }
  return assignments;
}

/**
 * The mode each fixed stage folder is titled after, read off the snapshot's
 * slot fields. A field the snapshot does not resolve — the engine renamed it,
 * or its accepted value falls outside the option table — is reported and left
 * out, so that stage falls back to its own name while the rest keep theirs.
 * @param {{accepted: number[]}|null} snapshot - Versioned Shader configuration snapshot.
 * @param {Array<{name: string, id: number}>|null} fields - Snapshot field definitions.
 * @param {(message: string) => void} [logWarn] - Sink for unresolved fields.
 * @returns {Map<string, string>|null} Fixed stage position to selected mode, or
 *   null when there is no snapshot to read.
 */
export function fixedShaderStageTitles(snapshot, fields, logWarn = console.warn) {
  if (!snapshot || !Array.isArray(snapshot.accepted) || !Array.isArray(fields)) {
    return null;
  }
  const fieldIds = new Map(fields.map((field) => [field.name, field.id]));
  const titles = new Map([['Camera', 'Camera']]);
  const unresolved = [];
  for (const [stage, [fieldName, options]] of FIXED_SHADER_MODE_FIELDS) {
    const id = fieldIds.get(fieldName);
    const mode = id === undefined ? undefined : options[snapshot.accepted[id]];
    if (mode === undefined) unresolved.push(fieldName);
    else titles.set(stage, mode);
  }
  if (unresolved.length > 0) {
    logWarn(`Shader stages: the snapshot resolves no mode for ${unresolved.join(', ')}`);
  }
  return titles;
}

/**
 * The label one control carries inside its stage folder: the stage's own
 * selector reads as its role, and a parameter named after its stage drops the
 * prefix the folder title already carries.
 * @param {string} stage - The pipeline stage the control was grouped under.
 * @param {string} name - Engine parameter name.
 * @returns {string} The control's displayed name.
 */
export function stageControlLabel(stage, name) {
  if (STAGE_BOUNDARIES.has(name)) {
    if (stage === 'Colorize') return 'Palette';
    return stage === 'Camera' ? 'Wander' : 'Mode';
  }
  if (name.startsWith(`${stage} `)) return name.slice(stage.length + 1);
  if (stage === 'Projection Frame' && name.startsWith('Projection ')) {
    return name.slice('Projection '.length);
  }
  if (stage === 'Function' && name.startsWith('Lattice ')) {
    return name.slice('Lattice '.length);
  }
  return name;
}
