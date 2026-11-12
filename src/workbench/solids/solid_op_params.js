/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/** Solid operation definitions, parameter grids, and recipe conversion. */

import { float32Decimal } from '../../shared/cpp_format.js';

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

/** The operators this generator can emit, derived from the shared op table. */
export const KNOWN_OPS = new Set(Object.keys(OP_DEFS));

/**
 * Ops that read a params object; a bare-string op among these is rejected.
 */
export const PARAMETERIZED_OPS = new Set(
  Object.keys(OP_DEFS).filter(op => Object.keys(OP_DEFS[op].params).length > 0));

/**
 * The params of an op that requireParams has already accepted.
 * @param {ChainOp} o - The op as supplied.
 * @returns {Object<string, number>} Its params; empty for a parameterless op.
 */
export function opParams(o) {
  return (typeof o === 'string' ? undefined : o.params) ?? {};
}

/** @param {ChainOp} op @returns {string} The operation name. */
export function chainOpName(op) {
  return typeof op === 'string' ? op : op?.op;
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
 * Tests whether a value lies off the parameter's step grid or outside its range.
 * @param {number} value - Authored value.
 * @param {{min: number, max: number, step: number}} def - Parameter range.
 * @returns {boolean} Whether snapping moves the value beyond the step tolerance.
 */
export function offStepGrid(value, def) {
  return Math.abs(value - snapToStep(value, def)) > Math.abs(def.step) * 1e-6;
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
  const opName = chainOpName(o);
  if (!AMBO_ALIASING_OPS.has(opName)) return String(opName);
  return Math.fround(opParams(o).t) === AMBO_ALIAS_T ? `${opName}:ambo` : String(opName);
}
