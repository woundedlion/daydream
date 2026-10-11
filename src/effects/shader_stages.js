/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Group engine parameter definitions by their registered pipeline metadata.
 * @param {Array<{name: string, group?: {name: string, title: string, order: number}}>} params - Engine definitions.
 * @returns {{assignments: Map<string, string>, titles: Map<string, string>, order: string[]}|null} Registered groups, or null when none are present.
 */
export function stageGrouping(params) {
  const assignments = new Map();
  const groups = new Map();
  for (const parameter of params) {
    if (!parameter.group) continue;
    assignments.set(parameter.name, parameter.group.name);
    groups.set(parameter.group.name, parameter.group);
  }
  if (groups.size === 0) return null;
  const ordered = [...groups.values()].sort((a, b) => a.order - b.order);
  return {
    assignments,
    titles: new Map(ordered.map(group => [group.name, group.title])),
    order: ordered.map(group => group.name),
  };
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
