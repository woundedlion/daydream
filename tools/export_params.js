/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Dependency-free formatter for the GUI's Export action, isolated from
// daydream.js so it imports without pulling Three.js into its unit test.

import { formatFloatCpp } from './cpp_format.js';

/**
 * Format the live parameter set as a C++ brace-init list of float literals for
 * pasting into a Presets<> array. Readonly params (engine-written, omitted from
 * hand-authored presets) are skipped so their live per-frame values never bake
 * into a preset. Valid only for effects whose Params is a flat all-float
 * aggregate; effects that interleave non-float members (a solid name, a Palette
 * pointer) produce a list that must be edited by hand to match the struct.
 * @param {Array<{readonly?: boolean}>} params - Parameter definitions, parallel to values.
 * @param {ArrayLike<number>} values - Live float value per param, same order as params.
 * @returns {string} A C++ brace-init list, e.g. "{ 0.85f, 1.0f }".
 */
export function formatExportParams(params, values) {
  const items = [];
  for (let i = 0; i < params.length; i++) {
    if (params[i].readonly) continue;
    items.push(formatFloatCpp(values[i]));
  }
  return '{ ' + items.join(', ') + ' }';
}
