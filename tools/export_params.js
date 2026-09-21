/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Dependency-free formatter for the GUI's Export action, isolated from
// daydream.js so it imports without pulling Three.js into its unit test.

import { formatFloatCpp } from './cpp_format.js';

/**
 * Format the live parameter set as a C++ brace-init list for pasting into a
 * PRESETS table. Readonly and non-preset params are skipped.
 *
 * Each literal matches the member's declared type, since a brace-init narrowing
 * conversion is a compile error: an enum carrying exportOptions emits the
 * symbolic entry matching its live numeric index, a toggle emits `true`/`false`,
 * a whole-number param (`step` of 1) emits an integer literal, and everything
 * else a float literal. Effects that interleave unrepresented members still
 * produce a list that must be edited by hand.
 * @param {Array<{name?: string, readonly?: boolean, preset?: boolean,
 *   value?: number|boolean, step?: number,
 *   exportOptions?: Array<string>}>} params - Definitions parallel to values.
 * @param {ArrayLike<number>} values - Live value per param, same order as
 *   params; the engine streams a toggle as 0 or 1.
 * @returns {string} A C++ brace-init list, e.g. "{ 0.85f, 4, true }".
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
    } else if (typeof param.value === 'boolean') {
      items.push(values[i] > 0.5 ? 'true' : 'false');
    } else if (param.step === 1 && Number.isInteger(values[i])) {
      // Only a float-backed enum can carry a fraction under a step of 1; its
      // target is a float, so it falls through to the float literal.
      items.push(String(values[i]));
    } else {
      items.push(formatFloatCpp(values[i]));
    }
  }
  return '{ ' + items.join(', ') + ' }';
}
