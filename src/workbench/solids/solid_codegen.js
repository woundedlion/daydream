/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Solids op dispatch, C++ generation, drag-slot math, and saved-card capacity. */

import {
  COLUMN_LIMIT, CPP_IDENTIFIER, fillColumns, formatFloatCpp,
} from '../../shared/cpp_format.js';
import { NUMERIC_ENUMS } from '../../../generated/engine_contract.mjs';

/**
 * One op parameter's slider default and range.
 * @typedef {{val: number, min: number, max: number, step: number}} OpParamDef
 */

/**
 * @typedef {{op: string, params?: Object<string, number>}} ChainOpObject
 */

/**
 * An op as a chain holds it: a bare op name, or an {op, params} object.
 * @typedef {string|ChainOpObject} ChainOp
 */

/**
 * A mesh read back into plain JS. Vertices use plain {x, y, z} math, which a
 * THREE.Vector3 satisfies.
 * @typedef {{faces: Array<Array<number>>, vertices: Array<{x:number, y:number, z:number}>}} SolidMesh
 */

/**
 * A live WASM MeshOps mesh wrapper.
 * @typedef {Object<string, any>} MeshWrapper
 */

/**
 * A spawned WASM module instance, reached by binding name.
 * @typedef {Object<string, any>} WasmModule
 */

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
 * Mirror of procedural_solids.h `inline constexpr float D2R = PI_F / 180.0f`
 * with PI_F = float(PI). Round products through it to float32: at 54 and 73
 * degrees a double PI/180 lands one ulp away.
 */
export const D2R_F32 = Math.fround(Math.fround(Math.PI) / 180);

/**
 * Per-op parameter table for the Conway/SolidBuilder operators, shared by the
 * live preview (applyOp) and the C++ generator (generateFuncAndRecipe). Each
 * params entry is in call-argument order and carries the slider default and
 * range. The op set must match what the WASM MeshOps class binds, and every
 * range must stay inside the engine's domain for that operator.
 * @type {Object<string, {params: Object<string, OpParamDef>}>}
 */
export const OP_DEFS = {
  kis: { params: {} },
  ambo: { params: {} },
  gyro: { params: {} },
  snub: { params: { t: { val: 0.5, min: 0.01, max: 0.99, step: 0.01 }, twist: { val: 0.0, min: 0, max: 1.0, step: 0.01 } } },
  dual: { params: {} },
  truncate: { params: { t: { val: 0.33, min: 0.01, max: 0.5, step: 0.01 } } },
  chamfer: { params: { t: { val: 0.5, min: 0.01, max: 0.99, step: 0.01 } } },
  expand: { params: { t: { val: 0.5, min: 0.01, max: 0.99, step: 0.01 } } },
  hankin: { params: { angle: { val: 54, min: 1, max: 90, step: 1 } } },
  relax: { params: { iter: { val: 100, min: 1, max: 500, step: 1 } } },
  meta: { params: {} },
  needle: { params: {} },
  zip: { params: {} },
  bevel: { params: { t: { val: 0.25, min: 0.01, max: 0.5, step: 0.01 } } },
};

/**
 * Which authored ops the engine's morph path can build on screen, mirrored from
 * Solids::is_morphable_step (core/mesh/recipe.h) and the sweep clamps it reads
 * (core/mesh/conway_graph.h). An empty object is an op that always sweeps,
 * `null` an op that never sweeps, and a parameter entry the band the leg
 * covers, with any excluded topology transitions. Composite ops are absent:
 * they lower to primitives before the check.
 * @type {Object<string, ?Object<string, {min: number, max: number, excluded?: number[]}>>}
 */
export const MORPH_SWEEP = {
  kis: {},
  ambo: {},
  snub: {},
  dual: {},
  truncate: { t: { min: 0.002, max: 0.995, excluded: [0.5] } },
  chamfer: { t: { min: 0.02, max: 0.63 } },
  expand: null,
  hankin: {},
  relax: {},
};

/**
 * Why the engine's morph path would decline a chain step, which makes the entry
 * generate whole instead of op by op.
 * @param {ChainOp} o - The op as the chain holds it.
 * @returns {?string} A sentence naming the reason, or null when the step sweeps.
 */
export function unsweepableReason(o) {
  const opName = typeof o === 'string' ? o : o?.op;
  if (!(opName in MORPH_SWEEP)) return null;
  const band = MORPH_SWEEP[opName];
  if (!band) {
    return `${opName} is not swept by the morph path: a shape using it is generated whole `
      + 'rather than built on screen.';
  }
  for (const [key, { min, max, excluded }] of Object.entries(band)) {
    const value = typeof o === 'string' ? NaN : Number(o?.params?.[key]);
    if (!Number.isFinite(value)) continue;
    const engineValue = Math.fround(value);
    if (excluded?.includes(engineValue)) {
      return `${opName} cannot sweep ${key} at ${engineValue}: the shape is `
        + 'generated whole rather than built on screen.';
    }
    if (value >= min && value <= max) continue;
    return `${opName} sweeps ${key} only over ${min} to ${max}: at ${value} the `
      + 'shape is generated whole rather than built on screen.';
  }
  return null;
}

/** The operators this generator can emit, derived from the shared op table. */
export const KNOWN_OPS = new Set(Object.keys(OP_DEFS));

/**
 * Longest step table a Recipe can describe: its count field is a uint8_t.
 */
export const MAX_RECIPE_STEPS = 255;

/**
 * Ops that read a params object; a bare-string op among these is rejected.
 */
export const PARAMETERIZED_OPS = new Set(
  Object.keys(OP_DEFS).filter(op => Object.keys(OP_DEFS[op].params).length > 0));

/**
 * Rejects an op whose params object is missing on either dispatch path.
 * @param {string} where - Caller name used in the error message.
 * @param {string} opName - The op being dispatched.
 * @param {ChainOp} o - The op as supplied.
 * @returns {void}
 * @throws {Error} When a parameterized op arrives without a params object.
 */
export function requireParams(where, opName, o) {
  if (PARAMETERIZED_OPS.has(opName) && (typeof o === 'string' || !o.params)) {
    throw new Error(`${where}: op "${opName}" requires a params object`);
  }
}

/**
 * The params of an op that requireParams has already accepted.
 * @param {ChainOp} o - The op as supplied.
 * @returns {Object<string, number>} Its params; empty for a parameterless op.
 */
export function opParams(o) {
  return (typeof o === 'string' ? undefined : o.params) ?? {};
}

/**
 * The first declared param of an op that carries a finite value outside its
 * OP_DEFS band. Non-finite values are left to the caller's own finiteness check.
 * @param {string} opName - An op name OP_DEFS declares.
 * @param {Object<string, number>} params - The op's params.
 * @returns {?{key: string, def: OpParamDef, value: number}} The offending param,
 *   or null when every declared param is in band.
 */
function outOfRangeParam(opName, params) {
  for (const [key, def] of Object.entries(OP_DEFS[opName].params)) {
    const value = params[key];
    if (Number.isFinite(value) && (value < def.min || value > def.max)) {
      return { key, def, value };
    }
  }
  return null;
}

/**
 * Checks whether a saved card has an exportable recipe.
 * @param {string} base - Seed solid.
 * @param {ChainOp[]} ops - Authored operations.
 * @returns {?string} Refusal reason, or null for an exportable shape.
 */
export function savedSolidExportError(base, ops) {
  return savedChainShapeError(base, ops)
    ?? (ops.length === 0 ? 'its op chain is empty; a saved solid needs at least one op' : null);
}

/**
 * Shape-checks a persisted base+chain against the op table, without the engine.
 * @param {*} base - The persisted seed-solid name.
 * @param {*} ops - The persisted op chain.
 * @returns {?string} A message naming the first defect, or null when the pair is restorable.
 * @details Refuses unknown ops, missing, non-numeric, out-of-range or off-grid
 * params, chains past MAX_RECIPE_STEPS, and bare-string ops. An off-grid value
 * would split the generated funcName from its recipe: the name suffix rounds
 * where the emitted call does not.
 */
export function savedChainShapeError(base, ops) {
  if (typeof base !== 'string' || !base) return 'it names no base solid';
  if (!Array.isArray(ops)) return 'its op chain is not a list';
  if (ops.length > MAX_RECIPE_STEPS) {
    return `its op chain holds ${ops.length} ops; a chain carries at most ${MAX_RECIPE_STEPS}`;
  }
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i];
    const at = `op ${i + 1}`;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return `${at} is not an op entry`;
    if (!KNOWN_OPS.has(o.op)) return `${at} names an unknown operator "${o.op}"`;
    const banded = outOfRangeParam(o.op, o.params ?? {});
    if (banded) return `${at} ("${o.op}") carries out-of-range "${banded.key}"`;
    for (const [key, def] of Object.entries(OP_DEFS[o.op].params)) {
      const value = o.params?.[key];
      if (!Number.isFinite(value)) {
        return `${at} ("${o.op}") carries no numeric "${key}"`;
      }
      if (Math.abs(value - snapToStep(value, def)) > Math.abs(def.step) * 1e-6) {
        return `${at} ("${o.op}") carries off-grid "${key}"`;
      }
    }
  }
  return null;
}

/** Maximum number of thumbnail-bearing solids retained by the page. */
export const SAVED_SOLIDS_MAX = 40;

/**
 * Captures a saved-solid thumbnail only while the list has capacity.
 * @param {number} savedCount - Current saved-solid count.
 * @param {() => string} capture - Thumbnail capture callback.
 * @returns {{full: boolean, dataURL: ?string}} Capture result and capacity state.
 */
export function captureSavedSolidThumbnail(savedCount, capture) {
  if (savedCount >= SAVED_SOLIDS_MAX) return { full: true, dataURL: null };
  return { full: false, dataURL: capture() };
}

/**
 * Queues a restore only after its persisted chain passes the shape check.
 * @param {{base: *, ops: *}} item - Persisted saved-solid shape.
 * @param {() => void} queue - Callback that queues the state mutation.
 * @returns {?string} Shape error, or null after the restore is queued.
 */
export function queueSavedSolidRestore(item, queue) {
  const error = savedChainShapeError(item.base, item.ops);
  if (error) return error;
  queue();
  return null;
}

/**
 * simple_registry's entry order, mirrored from solids.h. Recipe::seed is an
 * index into that array, so a seed's position here is its SEED_* value.
 */
export const SIMPLE_SEEDS = [
  // Platonic
  'tetrahedron', 'cube', 'octahedron', 'dodecahedron', 'icosahedron',
  // Archimedean
  'truncatedTetrahedron', 'cuboctahedron', 'truncatedCube',
  'truncatedOctahedron', 'rhombicuboctahedron', 'truncatedCuboctahedron',
  'snubCube', 'icosidodecahedron', 'truncatedDodecahedron',
  'truncatedIcosahedron', 'rhombicosidodecahedron',
  'truncatedIcosidodecahedron', 'snubDodecahedron',
];

/**
 * The seeds solids.h declares a `SEED_*` constant for.
 */
export const DEFINED_SEED_CONSTANTS = new Set([
  'octahedron', 'dodecahedron', 'icosahedron', 'truncatedOctahedron',
  'rhombicuboctahedron', 'icosidodecahedron', 'truncatedIcosahedron',
  'truncatedIcosidodecahedron', 'snubDodecahedron', 'truncatedCube',
]);

/**
 * The Platonic seeds, the leading run of simple_registry.
 */
export const PLATONIC_SOLIDS = SIMPLE_SEEDS.slice(0, 5);

/**
 * The Catalan seeds, mirrored from `namespace Catalan` in procedural_solids.h.
 * A generated recipe function on a Catalan base qualifies its seed call with
 * `Catalan::`; registry generation refuses Catalan seeds.
 */
export const CATALAN_BASES = new Set([
  'triakisTetrahedron', 'rhombicDodecahedron', 'triakisOctahedron',
  'tetrakisHexahedron', 'deltoidalIcositetrahedron', 'disdyakisDodecahedron',
  'pentagonalIcositetrahedron', 'rhombicTriacontahedron', 'triakisIcosahedron',
  'pentakisDodecahedron', 'deltoidalHexecontahedron', 'disdyakisTriacontahedron',
  'pentagonalHexecontahedron',
]);

/**
 * Applies one op of the {op, params} encoding to a WASM mesh wrapper, returning
 * the resulting mesh.
 * @param {MeshWrapper} mesh - A live WASM MeshOps mesh wrapper.
 * @param {ChainOp} o - The op to apply, as a bare op name or an {op, params} object.
 * @returns {MeshWrapper} The new mesh wrapper.
 * @throws {Error} When the op name is not a known operator, when the module binds no method for it, or when the op soft-rejects.
 * @details A soft reject (null from the bridge) throws before the caller swaps
 * its live wrapper. The KNOWN_OPS gate keeps op names off the wrapper's
 * lifetime methods (delete, clone).
 */
export function applyOp(mesh, o) {
  const opName = typeof o === 'string' ? o : o.op;
  if (!KNOWN_OPS.has(opName)) {
    throw new Error(`applyOp: unknown op "${opName}" — not a Conway/SolidBuilder operator`);
  }
  requireParams('applyOp', opName, o);
  const next = dispatchOp(mesh, o, opName);
  if (!next) {
    throw new Error(`applyOp: op "${opName}" was rejected by the WASM MeshOps module`);
  }
  return next;
}

/**
 * Calls the bound method for one op.
 * @param {MeshWrapper} mesh - A live WASM MeshOps mesh wrapper.
 * @param {ChainOp} o - The op to apply.
 * @param {string} opName - The op's name.
 * @returns {?MeshWrapper} The new mesh wrapper, or null when the module soft-rejects the op.
 * @throws {Error} When the module binds no method for the op name.
 */
function dispatchOp(mesh, o, opName) {
  const params = opParams(o);
  if (opName === 'truncate') return mesh.truncate(params.t);
  if (opName === 'chamfer') return mesh.chamfer(params.t);
  if (opName === 'expand') return mesh.expand(params.t);
  if (opName === 'bevel') return mesh.bevel(params.t);
  if (opName === 'snub') return mesh.snub(params.t, params.twist);
  if (opName === 'hankin') return mesh.hankin(Math.fround(params.angle * D2R_F32));
  if (opName === 'relax') return mesh.relax(params.iter);
  if (mesh[opName]) return mesh[opName]();
  throw new Error(`unknown op "${opName}" — not bound by the WASM MeshOps module`);
}

/**
 * The set of MeshOpResult keys the WASM bridge binds.
 */
export const MESH_OP_RESULT_NAMES = Object.keys(NUMERIC_ENUMS.MeshOpResult);

// Reason-specific tail of the message a null MeshOps result earns.
/** @type {Object<string, string>} */
const MESH_FAILURE_REMEDY = {
  UNKNOWN_NAME: 'the engine registers no solid by that name',
  CONNECTIVITY_OVERFLOW: 'the result passes the engine 16-bit element ceiling — remove an op',
  FACE_DEGREE_OVERFLOW: 'the result needs a face with more sides than the engine allows — remove an op',
  ARENA_EXHAUSTED: 'the chain needs more tooling memory than the engine reserves — remove an op',
  NON_FINITE_ARG: 'an op argument was not a finite number',
  ANGLE_OUT_OF_DOMAIN: 'an angle argument sat outside its op domain',
  STALE_WRAPPER: 'a tooling-memory flush reclaimed this mesh — rebuild it from the base solid',
  ARENA_UNAVAILABLE: 'the engine could not reserve its tooling memory, so no mesh op can run — reload the page',
};

/**
 * Reads back why a mesh-producing MeshOps call returned null.
 * @param {WasmModule} Mod - The WASM module instance that produced the null.
 * @param {string} what - What the caller was building, used in the message.
 * @returns {{reason: string, message: string, flush: boolean, fatal: boolean}} The MeshOpResult key, a message to show, whether clearToolingMemory() is the remedy that reason calls for, and whether arena-backed mesh operations are unavailable for the instance's lifetime.
 * @details Embind enum values are singletons matched by identity. A module that
 * binds neither the enum nor getLastResult reports reason 'UNKNOWN'.
 */
export function meshOpFailure(Mod, what) {
  const codes = Mod?.MeshOpResult;
  const recorded = Mod?.MeshOps?.getLastResult?.();
  let reason = 'UNKNOWN';
  if (codes && recorded !== undefined) {
    reason = MESH_OP_RESULT_NAMES.find((name) => codes[name] === recorded) ?? 'UNKNOWN';
  }
  return {
    reason,
    message: `${what} failed: ${MESH_FAILURE_REMEDY[reason] ?? 'the engine rejected it'}`,
    flush: reason === 'ARENA_EXHAUSTED',
    fatal: reason === 'ARENA_UNAVAILABLE',
  };
}

/**
 * Passes a mesh-producing MeshOps result through, or reports and remedies the
 * failure a null stands for.
 * @param {MeshWrapper?} result - What the bridge returned.
 * @param {string} what - What the caller was building, used in the message.
 * @param {Object} ctx - The live wiring, read per call because an engine halt nulls it.
 * @param {WasmModule} ctx.Mod - The WASM module instance that produced the result.
 * @param {{clearToolingMemory: () => void}} ctx.meshOps - Its MeshOps binding.
 * @param {(message: string) => void} ctx.onError - Surfaces the failure message to the user.
 * @param {(message: string) => void} [ctx.onFatal] - Stands the tool down for a failure nothing can recover from.
 * @returns {MeshWrapper?} The result, or null when it was a failure.
 * @details Flushes the tooling arenas only for ARENA_EXHAUSTED. ARENA_UNAVAILABLE
 * is unrecoverable and goes to onFatal.
 */
export function requireMeshResult(result, what, { Mod, meshOps, onError, onFatal }) {
  if (result) return result;
  const failure = meshOpFailure(Mod, what);
  if (failure.flush) meshOps.clearToolingMemory();
  if (failure.fatal && onFatal) onFatal(failure.message);
  else onError(failure.message);
  return null;
}

// Op params become C++ literals, so reject anything that would emit NaN/Inf or a
// malformed token.
/**
 * @param {string} opName - The op the param belongs to.
 * @param {string} param - The param's name.
 * @param {number} val - The value to check.
 * @returns {void}
 * @throws {Error} When the value is not finite.
 */
function requireFinite(opName, param, val) {
  if (!Number.isFinite(val)) {
    throw new Error(`generateFuncAndRecipe: ${opName} param "${param}" must be a finite number, got ${val}`);
  }
}

/**
 * @param {string} opName - The op the param belongs to.
 * @param {string} param - The param's name.
 * @param {number} val - The value to check.
 * @returns {void}
 * @throws {Error} When the value is not a positive integer.
 */
function requireCount(opName, param, val) {
  if (!Number.isInteger(val) || val < 1) {
    throw new Error(`generateFuncAndRecipe: ${opName} param "${param}" must be a positive integer, got ${val}`);
  }
}

// The seed call must name its namespace: IslamicStarPatterns has no using-directive.
/**
 * @param {string} where - Caller name used in the error message.
 * @param {string} ns - The namespace to check.
 * @returns {void}
 * @throws {Error} When the namespace is not a valid C++ identifier.
 */
function requireNamespace(where, ns) {
  if (typeof ns !== 'string' || !CPP_IDENTIFIER.test(ns)) {
    throw new Error(`${where}: base namespace "${ns}" is not a valid C++ identifier`);
  }
}

export const formatFloat = formatFloatCpp;

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

  const baseIdentifier = item.base.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  let nameParts = [baseIdentifier];
  let chain = '';

  item.ops.forEach(o => {
    const opName = typeof o === 'string' ? o : o.op;
    if (!KNOWN_OPS.has(opName)) {
      throw new Error(`generateFuncAndRecipe: unknown op "${opName}" ` +
        `(expected one of ${[...KNOWN_OPS].join(', ')})`);
    }
    requireParams('generateFuncAndRecipe', opName, o);
    const params = opParams(o);

    if (opName === 'truncate') {
      requireFinite(opName, 't', params.t);
      chain += `.truncate(${formatFloat(params.t)})`;
      nameParts.push(`_truncate${pctSuffix(params.t)}`);
    } else if (opName === 'expand') {
      requireFinite(opName, 't', params.t);
      chain += `.expand(${formatFloat(params.t)})`;
      nameParts.push(`_expand${pctSuffix(params.t)}`);
    } else if (opName === 'chamfer') {
      requireFinite(opName, 't', params.t);
      chain += `.chamfer(${formatFloat(params.t)})`;
      nameParts.push(`_chamfer${pctSuffix(params.t)}`);
    } else if (opName === 'hankin') {
      requireFinite(opName, 'angle', params.angle);
      if (params.angle < 0) {
        throw new Error(`generateFuncAndRecipe: hankin angle ${params.angle} is negative; suffix must stay a valid C++ identifier`);
      }
      chain += `.hankin(${formatFloat(params.angle)} * D2R)`;
      nameParts.push(`_hk${Math.round(params.angle)}`);
    } else if (opName === 'snub') {
      requireFinite(opName, 't', params.t);
      requireFinite(opName, 'twist', params.twist);
      chain += `.snub(${formatFloat(params.t)}, ${formatFloat(params.twist)})`;
      nameParts.push(`_snub${pctSuffix(params.t)}_tw${pctSuffix(params.twist)}`);
    } else if (opName === 'relax') {
      requireCount(opName, 'iter', params.iter);
      chain += `.relax(${params.iter})`;
      nameParts.push(`_relax${params.iter}`);
    } else if (opName === 'bevel') {
      requireFinite(opName, 't', params.t);
      chain += `.bevel(${formatFloat(params.t)})`;
      nameParts.push(`_bevel${pctSuffix(params.t)}`);
    } else {
      // Parameterless ops.
      chain += `.${opName}()`;
      nameParts.push(`_${opName}`);
    }

    // After the per-op emit, so the finiteness, count and negative-suffix
    // checks name their own defect.
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
 * Converts a persisted mesh count to a truncated non-negative integer for the
 * generated doc comment. Nonfinite or negative results become 0.
 * @param {*} value - The persisted count.
 * @returns {number} The count as a non-negative integer, or 0.
 */
function commentCount(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
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
    ['', `FLASHMEM static PolyMesh ${funcName}`],
    ['FLASHMEM static PolyMesh\n', funcName],
  ]) {
    const open = `${head}(Arena &a,`;
    if (`${open} ${tail}`.length <= COLUMN_LIMIT) return `${lead}${open} ${tail}`;
    const align = ' '.repeat(head.length + 1);
    if (open.length <= COLUMN_LIMIT && align.length + tail.length <= COLUMN_LIMIT) {
      return `${lead}${open}\n${align}${tail}`;
    }
  }
  return `FLASHMEM static PolyMesh\n${funcName}(\n    Arena &a, ${tail}`;
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
 * Emits the full FLASHMEM C++ function for a solid, led by a doxygen block whose
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
  const doc = doxygenCpp([
    `@brief Builds the ${funcName} star pattern (V=${commentCount(item.vCount)}, `
      + `F=${commentCount(item.fCount)}, I=${commentCount(item.iCount)}).`,
    '@param a First arena in the alternating construction pair.',
    '@param b Second arena; the result may borrow storage from either arena.',
    '@return The resulting star-pattern mesh.',
  ]);
  return `${doc}\n${signatureCpp(funcName)}\n${returnRecipeCpp(recipe)}\n}`;
}

/**
 * @param {OpParamDef} def - Editor range.
 * @param {number} value - Authored value.
 * @returns {OpParamDef} Range covering the authored value.
 */
export function authoredParamRange(def, value) {
  return Number.isFinite(value)
    ? { ...def, min: Math.min(def.min, value), max: Math.max(def.max, value) }
    : def;
}

/**
 * Snaps a computed value onto an op parameter's step grid and clamps it into
 * range, so it is exactly representable by the control that edits it.
 * @param {number} value - The unsnapped value.
 * @param {{min: number, max: number, step: number}} def - The parameter's OP_DEFS range.
 * @returns {number} The nearest step from `min`, clamped to [min, max].
 */
export function snapToStep(value, def) {
  const snapped = def.min + Math.round((value - def.min) / def.step) * def.step;
  const decimals = Math.max(0, ...[def.min, def.step].map((value) => {
    const [fraction, exponent = '0'] = String(value).toLowerCase().split('e');
    return (fraction.split('.')[1]?.length ?? 0) - Number(exponent);
  }));
  return Math.min(def.max, Math.max(def.min, Number(snapped.toFixed(Math.min(100, decimals)))));
}

/**
 * Computes the interior angle (in radians) at the second vertex of the mesh's
 * first face, used to characterize a solid's face shape. Returns 0 for
 * degenerate input (no faces, a face with fewer than 3 vertices, or a
 * zero-length edge).
 * @param {?SolidMesh} mesh - The mesh whose first face is measured, or null.
 * @returns {number} The internal angle in radians, or 0 for degenerate input.
 */
export function computeInternalAngle(mesh) {
  if (!mesh || !mesh.faces || mesh.faces.length === 0) return 0;
  const face = mesh.faces[0];
  if (face.length < 3) return 0;

  const v1 = mesh.vertices[face[0]];
  const v2 = mesh.vertices[face[1]];
  const v3 = mesh.vertices[face[2]];

  const dir1 = { x: v1.x - v2.x, y: v1.y - v2.y, z: v1.z - v2.z };
  const dir2 = { x: v3.x - v2.x, y: v3.y - v2.y, z: v3.z - v2.z };

  const dot = dir1.x * dir2.x + dir1.y * dir2.y + dir1.z * dir2.z;
  const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y + dir1.z * dir1.z);
  const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y + dir2.z * dir2.z);
  if (len1 === 0 || len2 === 0) return 0;

  // Clamp to [-1, 1] to guard against floating-point drift before acos.
  const cos = Math.min(1, Math.max(-1, dot / (len1 * len2)));
  return Math.acos(cos);
}

/**
 * Seeds one op's parameters for a candidate chain.
 * @param {string} opName - The op's OP_DEFS key.
 * @param {?SolidMesh} mesh - The mesh the op would run on, or null.
 * @returns {Object<string, number>} The OP_DEFS defaults, except hankin's
 *   angle, which follows the half-internal angle of `mesh`.
 * @details The derived angle is snapped to the control's step; a 0 angle (null
 * or degenerate mesh) keeps the OP_DEFS default.
 */
export function seedOpParams(opName, mesh) {
  /** @type {Object<string, number>} */
  const params = {};
  for (const [key, def] of Object.entries(OP_DEFS[opName]?.params ?? {})) {
    let val = def.val;
    if (opName === 'hankin' && key === 'angle') {
      const derived = (computeInternalAngle(mesh) / 2) * (180 / Math.PI);
      if (derived > 0) val = snapToStep(derived, def);
    }
    params[key] = val;
  }
  return params;
}

/**
 * The shortest decimal that rounds to the same float32 as `value`.
 * @param {number} value - A float32 value read across the WASM boundary.
 * @returns {number} That decimal.
 */
function float32Decimal(value) {
  for (let digits = 1; digits < 17; digits++) {
    const decimal = Number(value.toPrecision(digits));
    if (Math.fround(decimal) === Math.fround(value)) return decimal;
  }
  return value;
}

/**
 * The whole-degree hankin angle whose `deg * D2R` float32 equals an engine angle.
 * @param {number} radians - The hankin angle in the engine's float32 radians.
 * @returns {?number} The whole degree count, or null when no whole degree
 *   reproduces the float exactly.
 */
export function exactHankinDegrees(radians) {
  const deg = Math.round(radians * (180 / Math.PI));
  return Math.fround(deg * D2R_F32) === Math.fround(radians) ? deg : null;
}

/**
 * Editor ops for a registry solid's authored chain.
 * @param {Array<{op: string, param: number, twist: number}>} steps - The chain
 *   in the engine-native units MeshOps.getRecipe() reports.
 * @returns {ChainOp[]} The chain in editor units: hankin in degrees, every
 *   other param at the shortest decimal of its float32.
 * @throws {Error} When a step names an op the editor does not know.
 * @details Values off the editor's slider grid are kept as authored, so the
 * chain rebuilds the registry mesh. A bake-backed relax step (param 0) takes
 * the editor's maximum iteration count.
 */
export function opsFromRecipe(steps) {
  return Array.from(steps, (step) => {
    const opName = step.op;
    if (!KNOWN_OPS.has(opName)) throw new Error(`opsFromRecipe: unknown op "${opName}"`);
    if (opName === 'hankin') {
      const deg = exactHankinDegrees(step.param);
      return { op: opName, params: { angle: deg ?? float32Decimal(step.param * (180 / Math.PI)) } };
    }
    if (opName === 'relax') {
      const iter = step.param > 0 ? step.param : OP_DEFS.relax.params.iter.max;
      return { op: opName, params: { iter } };
    }
    if (opName === 'snub') {
      return { op: opName, params: { t: float32Decimal(step.param), twist: float32Decimal(step.twist) } };
    }
    if (OP_DEFS[opName].params.t) return { op: opName, params: { t: float32Decimal(step.param) } };
    return { op: opName, params: {} };
  });
}

/**
 * The drop slot a pointer is over: the number of list items whose midpoint it has
 * passed. Slots run 0..items.length, one more than the item count, since the
 * pointer can sit past the last item.
 * @param {number} pointerY - Pointer y in the list's own coordinate space (client y minus the list's top, plus its scrollTop).
 * @param {Array<{offsetTop: number, offsetHeight: number}>} items - The list's item elements, in document order.
 * @returns {number} The slot index.
 * @details Reads the static layout (offsetTop/offsetHeight), which ignores the
 * drag preview's translateY transforms.
 */
export function dropSlotIndex(pointerY, items) {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (pointerY < item.offsetTop + item.offsetHeight / 2) return i;
  }
  return items.length;
}

/**
 * Converts a drop slot into the destination index movedOps() takes: removing the
 * dragged op first shifts every later index down by one.
 * @param {number} slot - A dropSlotIndex() value.
 * @param {number} fromIndex - Index the dragged op currently occupies.
 * @returns {number} The destination index in post-removal coordinates; equals fromIndex when the drop is a no-op.
 */
export function dropTargetIndex(slot, fromIndex) {
  return fromIndex < slot ? slot - 1 : slot;
}

/**
 * How far an item shifts in the drag preview, in whole item slots: the items
 * between the dragged op and the drop slot move to open the gap.
 * @param {number} fromIndex - Index the dragged op currently occupies.
 * @param {number} slot - A dropSlotIndex() value.
 * @param {number} index - Index of the item being positioned.
 * @returns {number} -1 (up one slot), 1 (down one slot), or 0 (unmoved, including the dragged item itself).
 */
export function reorderPreviewShift(fromIndex, slot, index) {
  if (index === fromIndex) return 0;
  if (fromIndex < slot) return index > fromIndex && index < slot ? -1 : 0;
  return index >= slot && index < fromIndex ? 1 : 0;
}

/**
 * Returns a copy of an op chain with the op at `from` moved to index `to`.
 * @param {Array<Object>} ops - The op chain.
 * @param {number} from - Index of the op to move.
 * @param {number} to - Destination index, in post-removal coordinates.
 * @returns {Array<Object>} A deep copy of the chain in the new order.
 */
export function movedOps(ops, from, to) {
  const next = structuredClone(ops);
  const [m] = next.splice(from, 1);
  next.splice(to, 0, m);
  return next;
}

// truncate short-circuits to ambo at exactly t == 0.5, and bevel forwards its t
// to that truncate.
const AMBO_ALIASING_OPS = new Set(['truncate', 'bevel']);
const AMBO_ALIAS_T = 0.5;

/**
 * What a chain entry contributes to the resulting mesh's topology.
 * @param {ChainOp} o - The op as the chain holds it.
 * @returns {string} The op name, plus a marker where its params pick a different
 *   lowering.
 */
export function opTopologyKey(o) {
  const opName = typeof o === 'string' ? o : o?.op;
  if (!AMBO_ALIASING_OPS.has(opName)) return String(opName);
  return Math.fround(opParams(o).t) === AMBO_ALIAS_T ? `${opName}:ambo` : String(opName);
}
