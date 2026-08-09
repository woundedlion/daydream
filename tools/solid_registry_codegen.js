/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The solids tool page's registry-paste generator: the C++ text a saved solid
 * contributes to solids.h (a registry Entry, plus the OpStep table and Recipe
 * mirror a Complex entry must carry). Pure string code with no DOM and no WASM
 * dependency, so it is unit-testable; the page passes a star-pattern base's
 * authored chain in, read from MeshOps.getRecipe(). Output is pasted verbatim
 * into the engine, so the exact text and formatting are byte-for-byte
 * significant.
 */

import {
  CATALAN_BASES,
  DEFINED_SEED_CONSTANTS,
  OP_DEFS,
  KNOWN_OPS,
  PARAMETERIZED_OPS,
  SIMPLE_SEEDS,
  formatFloat,
  generateFuncAndRecipe,
} from './solid_codegen.js';

// A namespace is pasted as a C++ qualifier, so guard its shape.
const CPP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Longest step table a Recipe can describe: its count field is a uint8_t, so a
 * 256-step table would emit a count of 0.
 */
export const MAX_RECIPE_STEPS = 255;

// Mirrors solids.h `static constexpr float D2R = PI_F / 180.0f` with
// PI_F = float(PI), so a degree literal's product can be compared in float32
// against the radian angle the engine reports.
const D2R_F32 = Math.fround(Math.fround(Math.PI) / 180);

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
  if (opName === 'relax') {
    // The engine's apply_step refuses a bake-less RELAX below one iteration.
    if (!(params.iter >= 1)) {
      throw new Error(`opStepCpp: relax param "iter" must be at least 1, got ${params.iter}`);
    }
    return `{Op::RELAX, ${formatFloat(params.iter)}}`;
  }
  if (OP_DEFS[opName].params.t) {
    return `{Op::${opName.toUpperCase()}, ${formatFloat(params.t)}}`;
  }
  return `{Op::${opName.toUpperCase()}}`;
}

/**
 * A C++ float literal for an authored param, naming the param on failure.
 *
 * A base's authored params cross the WASM boundary as values, not as source
 * text, so a re-emitted literal must land on the identical float or the pasted
 * Recipe stops mirroring its generator (solids.h proves the two bitwise equal);
 * formatFloat guarantees that round-trip.
 * @param {string} where - Param name used in the error message.
 * @param {number} value - The float32 value the engine reported.
 * @returns {string} A C++ float literal.
 * @throws {Error} When the value has no plain-decimal float literal.
 */
function exactFloatLiteral(where, value) {
  try {
    return formatFloat(value);
  } catch (e) {
    throw new Error(`generateRegistryCpp: ${where} ${e.message.replace(/^formatFloatCpp: /, '')}`);
  }
}

/**
 * One solids.h OpStep initializer for a step of a base solid's authored chain,
 * in the engine-native units MeshOps.getRecipe() reports: radians for hankin,
 * raw t, relax iteration count.
 * @param {{op: string, param: number, twist: number}} step - The authored step.
 * @returns {string} The OpStep initializer.
 * @throws {Error} When the op is unknown, or the step is a bake-backed relax.
 */
function recipeStepCpp(step) {
  const opName = step.op;
  if (!KNOWN_OPS.has(opName)) {
    throw new Error(`generateRegistryCpp: base chain has unknown op "${opName}"`);
  }
  if (opName === 'hankin') {
    // Prefer the house `deg * D2R` product, but only where it reproduces the
    // engine's float exactly; otherwise emit the radian value itself.
    const deg = Math.round(step.param * (180 / Math.PI));
    const angle = Math.fround(deg * D2R_F32) === Math.fround(step.param)
      ? `${formatFloat(deg)} * IslamicStarPatterns::D2R`
      : exactFloatLiteral('base chain hankin angle', step.param);
    return `{Op::HANKIN, ${angle}}`;
  }
  if (opName === 'snub') {
    return `{Op::SNUB, ${exactFloatLiteral('base chain snub t', step.param)}, `
      + `${exactFloatLiteral('base chain snub twist', step.twist)}}`;
  }
  if (opName === 'relax') {
    // A shipped RELAX step carries a RelaxBake pointer instead of a count and
    // reports param 0. The bake's symbol does not cross the WASM boundary, so
    // the step cannot be re-emitted; refuse rather than paste a Recipe that
    // silently relaxes zero times.
    if (!(step.param > 0)) {
      throw new Error('generateRegistryCpp: the base solid\'s chain has a '
        + 'bake-backed relax step, whose RelaxBakes symbol does not cross the '
        + 'WASM boundary — author this Recipe by hand');
    }
    return `{Op::RELAX, ${exactFloatLiteral('base chain relax iterations', step.param)}}`;
  }
  if (OP_DEFS[opName].params.t) {
    return `{Op::${opName.toUpperCase()}, `
      + `${exactFloatLiteral(`base chain ${opName} t`, step.param)}}`;
  }
  return `{Op::${opName.toUpperCase()}}`;
}

// solids.h is clang-formatted at 80 columns, and the paste goes in verbatim.
const COLUMN_LIMIT = 80;

/**
 * The registry-order static_assert that pins a SEED_* constant to the
 * simple_registry entry it names, wrapped the way clang-format wraps the ones
 * already in solids.h: one line where it fits, then the argument on its own
 * continuation line, then the whole call broken after `static_assert(`.
 * @param {string} constName - The SEED_* constant.
 * @param {string} seedName - The simple_registry entry name it must index.
 * @returns {string} The static_assert statement.
 */
function seedAssertCpp(constName, seedName) {
  const head = `static_assert(std::string_view(simple_registry[${constName}].name) ==`;
  const value = `"${seedName}");`;
  if (head.length + 1 + value.length <= COLUMN_LIMIT) return `${head} ${value}`;
  if (head.length <= COLUMN_LIMIT) return `${head}\n              ${value}`;
  return `static_assert(\n    ${head.slice('static_assert('.length)}\n    ${value}`;
}

/**
 * The definition a paste carries for a seed solids.h declares no SEED_*
 * constant for: the constant plus its registry-order static_assert, so a wrong
 * index fails to compile instead of replaying the recipe on another solid.
 * @param {string} seedName - The simple_registry entry name.
 * @param {number} seedIndex - Its simple_registry index.
 * @returns {string} The constant block, ending in a blank line.
 */
function seedConstantCpp(seedName, seedIndex) {
  const constName = `SEED_${upperSnake(seedName)}`;
  return `// solids.h defines no ${constName}. Paste the constant and its\n`
    + '// static_assert beside the other SEED_* constants.\n'
    + `inline constexpr uint8_t ${constName} = ${seedIndex};\n`
    + `${seedAssertCpp(constName, seedName)}\n\n`;
}

/**
 * Emits the solids.h registry paste for a saved solid.
 *
 * A saved solid is always a derived chain, and islamic_registry is the only
 * registry that takes one: simple_registry is the fixed [Platonic |
 * Archimedean] roster whose length and slice offsets are pinned by
 * static_assert, and catalan_registry is the 13 Archimedean duals. So the paste
 * is uniformly Category::Complex — a generator in namespace IslamicStarPatterns
 * plus the OpStep table and Recipe mirror every islamic_registry entry must
 * carry.
 *
 * Recipe::seed indexes simple_registry, which holds no star pattern, so a star
 * base is flattened: the seed becomes the base's own seed and the base's
 * authored chain is prepended to the tool's ops, which is what the generated
 * function builds.
 *
 * solids.h declares a SEED_* constant for only some of the simple_registry
 * entries, so a paste on any other seed leads with that constant's definition
 * rather than an identifier the engine does not have.
 * @param {Object} item - The solid spec (see generateFuncAndRecipe).
 * @param {?{seed: string, ops: Array<{op: string, param: number, twist: number}>}} [baseRecipe] - The base's authored chain from MeshOps.getRecipe(); null when the base is itself a simple_registry seed.
 * @returns {string} The C++ paste.
 * @throws {Error} When the spec or base chain is invalid, the seed is not a simple_registry solid, a base chain step cannot be re-emitted, or the flattened chain exceeds MAX_RECIPE_STEPS.
 */
export function generateRegistryCpp(item, baseRecipe = null) {
  const { funcName } = generateFuncAndRecipe(item);

  if (baseRecipe != null) {
    if (typeof baseRecipe.seed !== 'string' || !CPP_IDENTIFIER.test(baseRecipe.seed)) {
      throw new Error(`generateRegistryCpp: base chain seed "${baseRecipe.seed}" is not a valid C++ identifier`);
    }
    if (!Array.isArray(baseRecipe.ops)) {
      throw new Error('generateRegistryCpp: base chain ops must be an array');
    }
  }

  // SEED_<name> indexes simple_registry, so only a simple_registry entry can be
  // a seed, and a seed with no such constant has its definition pasted with it.
  const seedName = baseRecipe != null ? baseRecipe.seed : item.base;
  if (CATALAN_BASES.has(seedName)) {
    throw new Error(`generateRegistryCpp: seed "${seedName}" is a Catalan solid, `
      + 'which Recipe::seed cannot index — no registry takes this solid; '
      + 'rebuild the chain from a Platonic or Archimedean seed');
  }
  const seedIndex = SIMPLE_SEEDS.indexOf(seedName);
  if (seedIndex < 0) {
    throw new Error(`generateRegistryCpp: seed "${seedName}" names no Platonic or `
      + 'Archimedean solid, and Recipe::seed indexes only those — a star-pattern '
      + 'base must be flattened onto the seed its own chain starts from');
  }
  const seedConstant = DEFINED_SEED_CONSTANTS.has(seedName)
    ? '' : seedConstantCpp(seedName, seedIndex);

  const stepsName = `${upperSnake(funcName)}_STEPS`;
  const recipeName = `${upperSnake(funcName)}_RECIPE`;
  const baseSteps = baseRecipe != null ? baseRecipe.ops.map(recipeStepCpp) : [];
  const stepList = baseSteps.concat(item.ops.map(opStepCpp));
  if (stepList.length > MAX_RECIPE_STEPS) {
    throw new Error(`generateRegistryCpp: the flattened chain has ${stepList.length} `
      + `steps; a Recipe carries at most ${MAX_RECIPE_STEPS}, above which its `
      + 'uint8_t count wraps and the pasted Recipe would replay a different chain');
  }
  const steps = stepList.join(',\n    ');
  return seedConstant
    + `/** Step table for ${funcName}. */\n`
    + `inline constexpr OpStep ${stepsName}[] = {\n    ${steps}};\n`
    + `/** Recipe mirror of IslamicStarPatterns::${funcName}. */\n`
    + `inline constexpr Recipe ${recipeName} = {\n`
    + `    SEED_${upperSnake(seedName)}, ${stepsName},\n`
    + `    static_cast<uint8_t>(std::size(${stepsName}))};\n\n`
    + `    {"${funcName}",\n     IslamicStarPatterns::${funcName}, Category::Complex,\n`
    + `     &${recipeName}},`;
}
