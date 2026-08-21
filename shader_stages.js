/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Which pipeline stage each engine parameter of a shader effect belongs to, and
 * what a stage folder and its controls are called. Three schemas are recognized:
 * ShaderBall's selector-driven one, the versioned Fixed Shader snapshot, and the
 * composed CurlLattice and FacetGrid rosters. Name classification only, so the
 * taxonomy is readable and testable apart from the panel that renders it.
 */

export const SHADERBALL_STAGE_ORDER = [
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
export const CURL_LATTICE_STAGE_ORDER = [
  'Camera',
  'Surface Noise',
  'Projection Frame',
  'Projection',
  'Function',
  'Colorize',
];
export const FACET_GRID_STAGE_ORDER = [
  'Camera',
  'Projection Frame',
  'Projection',
  'Planar Warp 2',
  'Function',
  'Colorize',
];
export const CURL_LATTICE_STAGE_TITLES = new Map([
  ['Camera', 'Camera'],
  ['Surface Noise', 'Curl'],
  ['Projection Frame', 'Spin + Wander'],
  ['Projection', 'Folded Sinusoidal'],
  ['Function', 'Primitive Lattice'],
  ['Colorize', 'Generated Triadic'],
]);
export const FACET_GRID_STAGE_TITLES = new Map([
  ['Camera', 'Camera'],
  ['Projection Frame', 'Spin + Wander'],
  ['Projection', 'Stereographic'],
  ['Planar Warp 2', 'Mirror Tile'],
  ['Function', 'Grid'],
  ['Colorize', 'Generated Analogous'],
]);
export const FIXED_SHADER_MODE_FIELDS = new Map([
  ['Function', ['slots.function', [
    'Twin Wave', 'Rings', 'Spiral', 'Grid', 'Noise Contour (Projected)',
    'Primitive Lattice', 'Noise Contour (Sphere)',
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
export const SHADERBALL_STAGE_BOUNDARIES = new Map([
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
const CURL_LATTICE_STAGE_BY_PARAMETER = new Map([
  ['Camera Wander', 'Camera'],
  ['Surface Noise Scale', 'Surface Noise'],
  ['Surface Noise Strength', 'Surface Noise'],
  ['Surface Noise Speed', 'Surface Noise'],
  ['Projection Spin Speed', 'Projection Frame'],
  ['Projection Wander', 'Projection Frame'],
  ['Pole Fade', 'Projection'],
  ['Central Meridian', 'Projection'],
  ['Lattice Cell Scale', 'Function'],
  ['Lattice Shape', 'Function'],
  ['Lattice Softness', 'Function'],
  ['Lattice Radius', 'Function'],
  ['Palette Chroma', 'Colorize'],
  ['Mapping Frequency', 'Colorize'],
  ['Mapping Phase', 'Colorize'],
  ['Phase Oscillation Depth', 'Colorize'],
  ['Phase Oscillation Speed', 'Colorize'],
  ['Brightness Depth', 'Colorize'],
  ['Value Opacity Low', 'Colorize'],
  ['Value Opacity High', 'Colorize'],
  ['Hue Shift Amount', 'Colorize'],
  ['Hue Noise Scale', 'Colorize'],
  ['Hue Noise Speed', 'Colorize'],
]);
const FACET_GRID_STAGE_BY_PARAMETER = new Map([
  ['Camera Wander', 'Camera'],
  ['Projection Spin Speed', 'Projection Frame'],
  ['Projection Wander', 'Projection Frame'],
  ['Pole Fade', 'Projection'],
  ['Planar Warp 2 Speed', 'Planar Warp 2'],
  ['Planar Warp 2 Rotation', 'Planar Warp 2'],
  ['Planar Warp 2 Cell X', 'Planar Warp 2'],
  ['Planar Warp 2 Cell Y', 'Planar Warp 2'],
  ['Planar Warp 2 Offset X', 'Planar Warp 2'],
  ['Planar Warp 2 Offset Y', 'Planar Warp 2'],
  ['Pattern Freq', 'Function'],
  ['Speed', 'Function'],
  ['Source Angle Speed', 'Function'],
  ['Complexity', 'Function'],
  ['Pattern Mix', 'Function'],
  ['Drift', 'Function'],
  ['Palette Chroma', 'Colorize'],
  ['Mapping Frequency', 'Colorize'],
  ['Mapping Phase', 'Colorize'],
  ['Phase Oscillation Depth', 'Colorize'],
  ['Phase Oscillation Speed', 'Colorize'],
  ['Value Opacity Low', 'Colorize'],
  ['Value Opacity High', 'Colorize'],
  ['Hue Shift Amount', 'Colorize'],
  ['Hue Noise Scale', 'Colorize'],
  ['Hue Noise Speed', 'Colorize'],
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
 * @param {Array<Object>} params - Engine parameter definitions.
 * @returns {boolean} True when every stage selector is registered.
 */
export function isShaderBallSchema(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  return SHADERBALL_SIGNATURE.every((name) => names.has(name));
}

/**
 * @param {Array<Object>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to pipeline-stage title.
 */
export function shaderBallStageAssignments(params) {
  if (!isShaderBallSchema(params)) return null;
  const assignments = new Map();
  let stage = 'Function';
  for (const parameter of params) {
    stage = SHADERBALL_STAGE_BOUNDARIES.get(parameter.name) ?? stage;
    assignments.set(parameter.name, stage);
  }
  return assignments;
}

/**
 * @param {Array<Object>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function curlLatticeStageAssignments(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  if ([...CURL_LATTICE_STAGE_BY_PARAMETER.keys()].some((name) => !names.has(name))) {
    return null;
  }
  return new Map(params.map((parameter) =>
    [parameter.name, CURL_LATTICE_STAGE_BY_PARAMETER.get(parameter.name)]));
}

/**
 * @param {Array<Object>} params - Engine parameter definitions in stream order.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function facetGridStageAssignments(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  if ([...FACET_GRID_STAGE_BY_PARAMETER.keys()].some((name) => !names.has(name))) {
    return null;
  }
  return new Map(params.map((parameter) =>
    [parameter.name, FACET_GRID_STAGE_BY_PARAMETER.get(parameter.name)]));
}

/**
 * @param {Array<Object>} params - Fixed Shader parameter definitions.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage; a
 *   name no rule claims is absent, and the panel reports it as unstaged.
 */
export function fixedShaderStageAssignments(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  if (!names.has('Camera Wander') || !names.has('Palette Chroma')
      || !names.has('Mapping Frequency') || isShaderBallSchema(params)) {
    return null;
  }
  const hasGenericWarp = [...names].some((name) => name.startsWith('Warp '));
  const mirrorStage = hasGenericWarp || names.has('Planar Warp 2 Speed')
    ? 'Planar Warp 2' : 'Planar Warp 1';
  const warpStage = [...names].some((name) => name.startsWith('Polar '))
    ? 'Planar Warp 2' : 'Planar Warp 1';
  const stageFor = (name) => {
    if (name === 'Camera Wander') return 'Camera';
    if (name.startsWith('Surface Noise ')) return 'Surface Noise';
    if (name === 'Projection Spin Speed' || name === 'Projection Wander') {
      return 'Projection Frame';
    }
    if (/^(Pole Fade|Central Meridian|Projection |Peirce |Bonne |Gnomonic )/.test(name)) {
      return 'Projection';
    }
    if (name.startsWith('Planar Warp 1 ')) return 'Planar Warp 1';
    if (name.startsWith('Planar Warp 2 ')) return 'Planar Warp 2';
    if (name.startsWith('Mirror ')) return mirrorStage;
    if (name.startsWith('Warp ')) return warpStage;
    if (name.startsWith('Affine ') || name.startsWith('Polar ')) {
      return 'Planar Warp 1';
    }
    if (name.startsWith('Mobius ')) return 'Lens';
    if (/^(Iso |Band )/.test(name)) return 'Value Transfer';
    if (/^(Edge(?: Fade)?|Cutout )/.test(name)) return 'Coverage';
    if (/^(Pattern|Speed$|Source |Complexity|Drift|Lattice )/.test(name)) {
      return 'Function';
    }
    if (/^(Palette|Mapping |Phase Oscillation |Brightness |Value Opacity |Hue )/.test(name)) {
      return 'Colorize';
    }
    return null;
  };
  const assignments = new Map();
  for (const parameter of params) {
    const stage = stageFor(parameter.name);
    if (stage) assignments.set(parameter.name, stage);
  }
  return assignments;
}

/**
 * @param {Object|null} snapshot - Versioned Shader configuration snapshot.
 * @param {Array<Object>|null} fields - Snapshot field definitions.
 * @returns {Map<string, string>|null} Fixed stage position to selected mode.
 */
export function fixedShaderStageTitles(snapshot, fields) {
  if (!snapshot || !Array.isArray(snapshot.accepted) || !Array.isArray(fields)) {
    return null;
  }
  const fieldIds = new Map(fields.map((field) => [field.name, field.id]));
  const titles = new Map([['Camera', 'Camera']]);
  for (const [stage, [fieldName, options]] of FIXED_SHADER_MODE_FIELDS) {
    const id = fieldIds.get(fieldName);
    const mode = id === undefined ? undefined : options[snapshot.accepted[id]];
    if (mode === undefined) return null;
    titles.set(stage, mode);
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
export function shaderBallControlLabel(stage, name) {
  if (SHADERBALL_STAGE_BOUNDARIES.has(name)) {
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
