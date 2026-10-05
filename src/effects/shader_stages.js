/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Pipeline-stage names and parameter assignments for composed effect rosters.
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
const LATTICE_MELT_ROSTER = new Set([
  'Camera Wander', 'Surface Noise Scale', 'Surface Noise Strength',
  'Surface Noise Speed', 'Projection Spin Speed', 'Projection Wander',
  'Central Meridian', 'Lattice Cell Scale', 'Lattice Shape',
  'Lattice Softness', 'Lattice Radius', 'Palette Chroma', 'Palette Mapping',
  'Mapping Frequency', 'Mapping Phase', 'Phase Oscillation Depth',
  'Phase Oscillation Speed', 'Brightness Bottom', 'Brightness Top',
  'Opacity at Value 0', 'Opacity at Value 1', 'Hue Shift Amount', 'Hue Noise Scale',
  'Hue Noise Speed',
]);
const KALEIDOSCOPE_SMOOTH_ROSTER = new Set([
  'Camera Wander', 'Projection Spin Speed', 'Projection Wander',
  'Singularity Fade', 'Planar Warp 2 Speed', 'Mirror Rotation',
  'Mirror Cell X', 'Mirror Cell Y', 'Mirror Offset X',
  'Mirror Offset Y', 'Pattern Freq', 'Speed', 'Source Angle Speed',
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
  ['Peirce Layout', 'Projection'],
  ['Projection Spin Speed', 'Projection Frame'],
  ['Projection Wander', 'Projection Frame'],
  ['Camera Wander', 'Camera'],
  ['Surface Noise Scale', 'Surface Noise'],
  ['Surface Noise Strength', 'Surface Noise'],
  ['Surface Noise Speed', 'Surface Noise'],
  ['Surface Noise Direction', 'Surface Noise'],
  ['Mobius A Re', 'Lens'],
  ['Mobius A Im', 'Lens'],
  ['Mobius B Re', 'Lens'],
  ['Mobius B Im', 'Lens'],
  ['Mobius C Re', 'Lens'],
  ['Mobius C Im', 'Lens'],
  ['Mobius D Re', 'Lens'],
  ['Mobius D Im', 'Lens'],
  ['Iso Level', 'Value Transfer'],
  ['Iso Width', 'Value Transfer'],
  ['Cutout Threshold', 'Coverage'],
  ['Cutout Softness', 'Coverage'],
  ['Edge Width', 'Coverage'],
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
  let warpStage = null;
  for (const parameter of params) {
    if (!roster.has(parameter.name)) return null;
    warpStage = WARP_STAGE_BOUNDARIES.get(parameter.name) ?? warpStage;
    const stage = stageOf(parameter.name) ?? (WARP_SLOT_PARAMETERS.has(parameter.name) ? warpStage : null);
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
 * @param {Array<{name: string}>} params - Composed-effect parameter definitions in
 *   engine registration order.
 * @returns {Map<string, string>|null} Parameter name to fixed pipeline stage.
 */
export function composedStageAssignments(params) {
  const names = new Set(params.map((parameter) => parameter.name));
  if (!names.has('Camera Wander') || !names.has('Palette Chroma')
      || !names.has('Mapping Frequency')) {
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
 * Drops the stage-name prefix from a control label, or Projection under
 * Projection Frame, Mirror under Planar Warp, and Lattice under Function.
 * @param {string} stage - The pipeline stage the control was grouped under.
 * @param {string} name - Engine parameter name.
 * @returns {string} The control's displayed name.
 */
export function stageControlLabel(stage, name) {
  if (name.startsWith(`${stage} `)) return name.slice(stage.length + 1);
  if (stage === 'Projection Frame' && name.startsWith('Projection ')) {
    return name.slice('Projection '.length);
  }
  if (stage.startsWith('Planar Warp ') && name.startsWith('Mirror ')) return name.slice('Mirror '.length);
  if (stage === 'Function' && name.startsWith('Lattice ')) {
    return name.slice('Lattice '.length);
  }
  return name;
}
