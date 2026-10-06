/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Dependency-free formatter for the GUI's Export action.

import { formatFloatCpp } from './cpp_format.js';

/**
 * Format the live parameter set as a C++ brace-init list for pasting into a
 * PRESETS table. Readonly and non-preset params are skipped.
 *
 * Each literal matches the member's declared type (brace-init forbids
 * narrowing): an enum carrying exportOptions emits its symbolic entry, a toggle
 * `true`/`false`, a whole-number param (`step` of 1) an integer, everything
 * else a float. Effects that interleave unrepresented members need hand edits.
 * @param {Array<{name?: string, readonly?: boolean, preset?: boolean,
 *   value?: number|boolean, step?: number,
 *   exportOptions?: Array<string>, optionValues?: number[]}>} params - Definitions parallel to values.
 * @param {ArrayLike<number>} values - Live value per param, same order as
 *   params; the engine streams a toggle as 0 or 1.
 * @returns {string} A C++ brace-init list, e.g. "{ 0.85f, 4, true }".
 */
export function formatExportParams(params, values) {
  const items = [];
  for (let i = 0; i < params.length; i++) {
    const param = params[i];
    if (param.readonly || param.preset === false) continue;
    if (param.optionValues && !param.optionValues.includes(values[i]))
      throw new RangeError(`No enum option for ${param.name ?? i} value ${values[i]}`);
    if (param.exportOptions) {
      const index = param.optionValues ? param.optionValues.indexOf(values[i]) : values[i];
      const exportValue = param.exportOptions[index];
      if (exportValue === undefined) {
        throw new RangeError(`No export option for ${param.name ?? i} index ${values[i]}`);
      }
      items.push(exportValue);
    } else if (typeof param.value === 'boolean') {
      items.push(values[i] > 0.5 ? 'true' : 'false');
    } else if (param.step === 1 && Number.isInteger(values[i])) {
      // A fraction under a step of 1 (float-backed enum) takes the float path.
      items.push(String(values[i]));
    } else {
      items.push(formatFloatCpp(values[i]));
    }
  }
  return '{ ' + items.join(', ') + ' }';
}
