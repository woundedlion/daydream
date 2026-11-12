/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Solids naming and C++ emission. */

import { COLUMN_LIMIT, CPP_IDENTIFIER, fillColumns, formatFloatCpp } from '../../shared/cpp_format.js';
import { KNOWN_OPS, OP_DEFS, chainOpName, opParams } from './solid_op_params.js';
import {
  outOfRangeParam, requireCount, requireFinite, requireNamespace, requireParams,
} from './solid_validation.js';

/** @typedef {import('./solid_op_params.js').ChainOp} ChainOp */

/**
 * A solid as the tool holds it: a seed name, the chain applied to it, and the
 * element counts the last preview reported.
 * @typedef {object} SolidSpec
 * @property {string} base - The base solid name.
 * @property {ChainOp[]} ops - Ops to apply, in order.
 * @property {number} [vCount] - Vertices the preview reported.
 * @property {number} [fCount] - Faces the preview reported.
 * @property {number} [iCount] - Indices the preview reported.
 */

/**
 * Formats a registry solid name for display: splits camelCase and underscore
 * segments into words and capitalizes each, so
 * "truncatedIcosahedron_hk58_chamfer63" -> "Truncated Icosahedron Hk58 Chamfer63".
 * @param {string} name - The registry solid name.
 * @returns {string} The human-readable title.
 */
export function formatSolidName(name) {
  return name
    .split('_')
    .map(part => part.replace(/([A-Z])/g, ' $1').trim())
    .join(' ')
    .replace(/(^|\s)[a-z]/g, c => c.toUpperCase());
}

/**
 * Builds a stable, unambiguous suffix for a fractional op parameter (0..1+),
 * quantized to hundredths and padded to two digits (0.05 -> "05", 0.5 -> "50").
 * A negative value is rejected: its `-` would make an invalid C++ identifier.
 * @param {number} val - The fractional parameter value (typically 0..1+).
 * @returns {string} A two-or-more digit percent suffix.
 */
export function pctSuffix(val) {
  if (val < 0) {
    throw new Error(`pctSuffix: value ${val} is negative; suffix must stay a valid C++ identifier`);
  }
  return String(Math.round(val * 100)).padStart(2, '0');
}

/**
 * @param {string} name - A C++ identifier.
 * @returns {string} Its lowercase snake_case spelling.
 */
export function snakeIdentifier(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * Derives the C++ funcName and SolidBuilder recipe expression for a solid spec.
 * The funcName is the base plus one suffix per op: `t`-valued params in
 * hundredths (`_bevel20`, `_snub50_tw00`), hankin in whole degrees (`_hk58`),
 * relax in iterations (`_relax100`), parameterless ops by name (`_kis`). The
 * recipe is the chained SolidBuilder(...).build() call.
 * @param {SolidSpec} item - The solid spec; its op chain must be non-empty.
 * @param {string} [baseNamespace] - Namespace qualifying the seed call (e.g. "Archimedean"). Omit only when the caller wants the funcName alone; a recipe pasted into the engine must carry it.
 * @returns {{funcName: string, recipe: string}} The generated C++ function name and SolidBuilder recipe expression.
 * @throws {Error} When the base or namespace is not a valid C++ identifier, the op chain is empty, or an op or its params are invalid.
 */
export function generateFuncAndRecipe(item, baseNamespace = '') {
  if (typeof item.base !== 'string' || !CPP_IDENTIFIER.test(item.base)) {
    throw new Error(`generateFuncAndRecipe: base "${item.base}" is not a valid C++ identifier`);
  }

  if (baseNamespace !== '') requireNamespace('generateFuncAndRecipe', baseNamespace);

  if (!Array.isArray(item.ops)) {
    throw new Error('generateFuncAndRecipe: item.ops must be an array');
  }

  // An empty chain leaves funcName === base, so the emitted function redefines
  // the seed and its body calls itself.
  if (item.ops.length === 0) {
    throw new Error(`generateFuncAndRecipe: op chain is empty; the emitted function would redefine the seed "${item.base}" and recurse into itself`);
  }

  const baseIdentifier = snakeIdentifier(item.base);
  let nameParts = [baseIdentifier];
  let chain = '';

  item.ops.forEach(o => {
    const opName = chainOpName(o);
    if (!KNOWN_OPS.has(opName)) {
      throw new Error(`generateFuncAndRecipe: unknown op "${opName}" ` +
        `(expected one of ${[...KNOWN_OPS].join(', ')})`);
    }
    requireParams('generateFuncAndRecipe', opName, o);
    const params = opParams(o);

    if (opName === 'hankin') {
      requireFinite(opName, 'angle', params.angle);
      if (params.angle < 0) {
        throw new Error(`generateFuncAndRecipe: hankin angle ${params.angle} is negative; suffix must stay a valid C++ identifier`);
      }
      chain += `.hankin(${formatFloatCpp(params.angle)} * D2R)`;
      nameParts.push(`_hk${Math.round(params.angle)}`);
    } else if (opName === 'snub') {
      requireFinite(opName, 't', params.t);
      requireFinite(opName, 'twist', params.twist);
      chain += `.snub(${formatFloatCpp(params.t)}, ${formatFloatCpp(params.twist)})`;
      nameParts.push(`_snub${pctSuffix(params.t)}_tw${pctSuffix(params.twist)}`);
    } else if (opName === 'relax') {
      requireCount(opName, 'iter', params.iter);
      chain += `.relax(${params.iter})`;
      nameParts.push(`_relax${params.iter}`);
    } else if (OP_DEFS[opName].params.t) {
      requireFinite(opName, 't', params.t);
      chain += `.${opName}(${formatFloatCpp(params.t)})`;
      nameParts.push(`_${opName}${pctSuffix(params.t)}`);
    } else {
      chain += `.${opName}()`;
      nameParts.push(`_${opName}`);
    }

    const banded = outOfRangeParam(opName, params);
    if (banded) {
      throw new Error(`generateFuncAndRecipe: ${opName} param "${banded.key}" must be `
        + `within ${banded.def.min} to ${banded.def.max}, got ${banded.value}`);
    }
  });

  const funcName = nameParts.join('');
  const seed = baseNamespace === '' ? baseIdentifier : `${baseNamespace}::${baseIdentifier}`;
  const recipe = `SolidBuilder(${seed}(a, b), a, b)${chain}.build()`;

  return { funcName, recipe };
}

/**
 * Converts a persisted mesh count to a non-negative integer.
 * @param {*} value - The persisted count.
 * @returns {?number} The truncated count, or null if unavailable.
 */
function commentCount(value) {
  if (value == null || (typeof value !== 'number' && typeof value !== 'string')
      || (typeof value === 'string' && value.trim() === '')) return null;
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/**
 * A doxygen block filled at the column limit with a ` * ` continuation prefix.
 * @param {string[]} tags - One line of words per doxygen tag.
 * @returns {string} The block comment.
 */
function doxygenCpp(tags) {
  const lines = tags.flatMap((text) => fillColumns(text.split(' '), ' * '));
  return ['/**', ...lines, ' */'].join('\n');
}

/**
 * The function's signature, wrapped as clang-format does: both parameters on
 * the declarator's line where they fit, else the second aligned under the
 * first; each shape tried first with the return type leading the line and then
 * with it on its own, and last both parameters indented one level below a bare
 * declarator.
 * @param {string} funcName - The generated function's name.
 * @returns {string} The signature through its opening brace.
 */
function signatureCpp(funcName) {
  const tail = 'Arena &b) {';
  for (const [lead, head] of [
    ['', `HS_FLASH_INLINE inline PolyMesh ${funcName}`],
    ['HS_FLASH_INLINE inline PolyMesh\n', funcName],
  ]) {
    const open = `${head}(Arena &a,`;
    if (`${open} ${tail}`.length <= COLUMN_LIMIT) return `${lead}${open} ${tail}`;
    const align = ' '.repeat(head.length + 1);
    if (open.length <= COLUMN_LIMIT && align.length + tail.length <= COLUMN_LIMIT) {
      return `${lead}${open}\n${align}${tail}`;
    }
  }
  return `HS_FLASH_INLINE inline PolyMesh\n${funcName}(\n    Arena &a, ${tail}`;
}

// A builder call to break the chain before. A float literal's '.' is followed
// by a digit and a namespace qualifier carries no '.', so only a call matches.
const CHAIN_CALL = /\.(?=[A-Za-z_]\w*\()/;

/**
 * The return statement, wrapped as clang-format does: one line where it fits,
 * else one builder call per line at the continuation indent.
 * @param {string} recipe - The SolidBuilder call chain.
 * @returns {string} The statement, ending in ';'.
 */
function returnRecipeCpp(recipe) {
  if (`  return ${recipe};`.length <= COLUMN_LIMIT) return `  return ${recipe};`;
  const [seed, ...calls] = recipe.split(CHAIN_CALL);
  let seedLine = `  return ${seed}`;
  if (seedLine.length > COLUMN_LIMIT) {
    const inner = seed.slice('SolidBuilder('.length, -', a, b)'.length);
    const prefix = '  return SolidBuilder(';
    if (prefix.length + inner.length + 1 <= COLUMN_LIMIT) {
      seedLine = fillColumns([`${inner},`, 'a,', 'b)'], prefix,
        ' '.repeat(prefix.length)).join('\n');
    } else if (13 + inner.length + 1 <= COLUMN_LIMIT) {
      seedLine = '  return SolidBuilder(\n'
        + fillColumns([`${inner},`, 'a,', 'b)'], ' '.repeat(13)).join('\n');
    } else {
      const innerHead = `             ${inner.slice(0, -'a, b)'.length)}`;
      if (innerHead.length + 3 <= COLUMN_LIMIT) {
        const innerCall = fillColumns(['a,', 'b),'], innerHead,
          ' '.repeat(innerHead.length)).join('\n');
        seedLine = `  return SolidBuilder(\n${innerCall}\n             a, b)`;
      } else if (innerHead.length <= COLUMN_LIMIT) {
        seedLine = `  return SolidBuilder(\n${innerHead}\n                 a, b),\n             a, b)`;
      } else {
        const separator = inner.lastIndexOf('::') + 2;
        const namespace = inner.slice(0, separator);
        const call = inner.slice(separator);
        seedLine = call.length + 27 <= COLUMN_LIMIT
          ? `  return SolidBuilder(${namespace}\n${' '.repeat(26)}${call},\n${' '.repeat(22)}a, b)`
          : `  return SolidBuilder(\n             ${namespace}\n                 ${call},\n             a, b)`;
      }
    }
  }
  return [seedLine, ...calls.map((call) => `      .${call}`)].join('\n') + ';';
}

/**
 * Emits the full HS_FLASH_INLINE C++ function for a solid, led by a doxygen block whose
 * brief records the solid's vertex/face/index counts. Output is pasted verbatim
 * into the engine and must clear its clang-format gate.
 * @param {SolidSpec} item - The solid spec (see generateFuncAndRecipe), optionally with vCount, fCount, and iCount counts.
 * @param {string} baseNamespace - Namespace qualifying the seed call (e.g. "Archimedean"); required, since the emitted function is pasted where the seed is not visible unqualified.
 * @returns {string} The complete C++ function source including its doc comment.
 * @throws {Error} When the namespace is not a valid C++ identifier, or generateFuncAndRecipe rejects the spec.
 */
export function generateRecipeCpp(item, baseNamespace) {
  requireNamespace('generateRecipeCpp', baseNamespace);
  const { funcName, recipe } = generateFuncAndRecipe(item, baseNamespace);
  const vCount = commentCount(item.vCount);
  const fCount = commentCount(item.fCount);
  const iCount = commentCount(item.iCount);
  const counts = vCount !== null && fCount !== null && iCount !== null
    ? ` (V=${vCount}, F=${fCount}, I=${iCount})`
    : '';
  const doc = doxygenCpp([
    `@brief Builds the ${funcName} star pattern${counts}.`,
    '@param a First arena in the alternating construction pair.',
    '@param b Second arena; the result may borrow storage from either arena.',
    '@return The resulting star-pattern mesh.',
  ]);
  return `${doc}\n${signatureCpp(funcName)}\n${returnRecipeCpp(recipe)}\n}`;
}
