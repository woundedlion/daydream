/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Dependency-free formatter for the GUI's Export action, isolated from
// daydream.js so it imports without pulling Three.js into its unit test.

import { formatFloatCpp } from './cpp_format.js';

/**
 * Format the live parameter set as a C++ brace-init list for pasting into a
 * Presets<> array. Readonly and non-preset params are skipped. An enum carrying
 * exportOptions emits the symbolic entry matching its live numeric index; all
 * other values render as float literals. Effects that interleave unrepresented
 * non-float members still produce a list that must be edited by hand.
 * @param {Array<{name?: string, readonly?: boolean, preset?: boolean,
 *   exportOptions?: Array<string>}>} params - Definitions parallel to values.
 * @param {ArrayLike<number>} values - Live float value per param, same order as params.
 * @returns {string} A C++ brace-init list, e.g. "{ 0.85f, 1.0f }".
 */
export function formatExportParams(params, values) {
  const items = [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (param.readonly || param.preset === false) continue;
    if (param.exportOptions) {
      const exportValue = param.exportOptions[values[i]];
      if (exportValue === undefined) {
        throw new RangeError(`No export option for ${param.name ?? i} index ${values[i]}`);
      }
      items.push(exportValue);
    } else {
      items.push(formatFloatCpp(values[i]));
    }
  }
  return '{ ' + items.join(', ') + ' }';
}
