/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The solids tool page's registry-paste generator: the C++ text a saved solid
 * contributes to solids.h (a registry Entry, plus the OpStep table and Recipe
 * mirror a Complex entry must carry). Pure string code with no DOM and no WASM
 * dependency, so it is unit-testable. Output is pasted verbatim into the engine,
 * so the exact text and formatting are byte-for-byte significant.
 */

import {
  OP_DEFS,
  KNOWN_OPS,
  PARAMETERIZED_OPS,
  formatFloat,
  generateFuncAndRecipe,
} from './solid_codegen.js';

// A namespace is pasted as a C++ qualifier, so guard its shape.
const CPP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * solids.h names a recipe's tables after the generator, camelCase segments
 * split into UPPER_SNAKE: truncatedIcosahedron_hk58_chamfer63 ->
 * TRUNCATED_ICOSAHEDRON_HK58_CHAMFER63.
 * @param {string} name - The generator / registry name.
 * @returns {string} The UPPER_SNAKE form.
 */
export function upperSnake(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * One solids.h OpStep initializer. HANKIN carries radians (the tool's angle is
 * degrees, emitted as the house `deg * D2R` product), SNUB a (t, twist) pair,
 * RELAX a live iteration count (the engine's shipped chains swap that for a
 * `.bake =` designator once a bake exists).
 * @param {(string|{op:string, params:Object})} o - The op, as a bare name or an {op, params} object.
 * @returns {string} The OpStep initializer.
 * @throws {Error} When the op is unknown or a parameterized op arrives without params.
 */
export function opStepCpp(o) {
  const opName = typeof o === 'string' ? o : o.op;
  if (!KNOWN_OPS.has(opName)) {
    throw new Error(`opStepCpp: unknown op "${opName}" ` +
      `(expected one of ${[...KNOWN_OPS].join(', ')})`);
  }
  if (PARAMETERIZED_OPS.has(opName) && (typeof o === 'string' || !o.params)) {
    throw new Error(`opStepCpp: op "${opName}" requires a params object`);
  }
  const params = o.params || {};
  if (opName === 'hankin') {
    return `{Op::HANKIN, ${formatFloat(params.angle)} * IslamicStarPatterns::D2R}`;
  }
  if (opName === 'snub') {
    return `{Op::SNUB, ${formatFloat(params.t)}, ${formatFloat(params.twist)}}`;
  }
  if (opName === 'relax') return `{Op::RELAX, ${formatFloat(params.iter)}}`;
  if (OP_DEFS[opName].params.t) {
    return `{Op::${opName.toUpperCase()}, ${formatFloat(params.t)}}`;
  }
  return `{Op::${opName.toUpperCase()}}`;
}

/**
 * Emits the solids.h registry paste for a saved solid.
 *
 * A Simple result is one Entry line in its seed's namespace. A Complex result —
 * a chain containing a hankin, or one grown from a star pattern — lands in
 * islamic_registry, whose entries carry a Recipe mirror; Entry's fourth field
 * defaults to nullptr, which fails the engine's every-Complex-solid-has-a-chain
 * contract.
 * @param {Object} item - The solid spec (see generateFuncAndRecipe).
 * @param {string} seedNamespace - Namespace qualifying the seed (e.g. "Archimedean").
 * @param {boolean} baseIsStar - True when the base is an islamic_registry star pattern.
 * @returns {string} The C++ paste.
 * @throws {Error} When the spec or namespace is invalid.
 */
export function generateRegistryCpp(item, seedNamespace, baseIsStar) {
  if (typeof seedNamespace !== 'string' || !CPP_IDENTIFIER.test(seedNamespace)) {
    throw new Error(`generateRegistryCpp: seed namespace "${seedNamespace}" is not a valid C++ identifier`);
  }
  const { funcName } = generateFuncAndRecipe(item, seedNamespace);

  // Complexity is a property of the result, not the base: a hankin step lands
  // the solid in islamic_registry (uniformly Category::Complex), as does
  // starting from a star pattern.
  const isComplex = baseIsStar
    || item.ops.some(o => (typeof o === 'string' ? o : o.op) === 'hankin');

  if (!isComplex) {
    // A Simple result never leaves its seed's namespace.
    return `    {"${funcName}",\n     ${seedNamespace}::${funcName},\n     Category::Simple},`;
  }

  const stepsName = `${upperSnake(funcName)}_STEPS`;
  const recipeName = `${upperSnake(funcName)}_RECIPE`;
  const steps = item.ops.map(opStepCpp).join(',\n    ');
  // SEED_<base> indexes simple_registry, so a base with no such constant needs
  // one added alongside this paste.
  return `/** Step table for ${funcName}. */\n`
    + `inline constexpr OpStep ${stepsName}[] = {\n    ${steps}};\n`
    + `/** Recipe mirror of IslamicStarPatterns::${funcName}. */\n`
    + `inline constexpr Recipe ${recipeName} = {\n`
    + `    SEED_${upperSnake(item.base)}, ${stepsName},\n`
    + `    static_cast<uint8_t>(std::size(${stepsName}))};\n\n`
    + `    {"${funcName}",\n     IslamicStarPatterns::${funcName}, Category::Complex,\n`
    + `     &${recipeName}},`;
}
