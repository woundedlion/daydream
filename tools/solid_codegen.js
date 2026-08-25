/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Op dispatch plus the pure code-generation, geometry, and op-chain sequencing
 * helpers of the solids tool page (tools/solids.html), unit-testable without a
 * DOM or WASM runtime. The C++ source strings are pasted verbatim into the
 * engine (SolidBuilder recipes, FLASHMEM functions), so their output formatting
 * must stay byte-for-byte stable. computeInternalAngle uses plain {x, y, z}
 * vector math (a THREE.Vector3 satisfies that shape) to avoid a three.js
 * dependency; the chain validator takes the WASM module factory by injection.
 */

import {
  COLUMN_LIMIT, CPP_IDENTIFIER, fillColumns, formatFloatCpp,
} from './cpp_format.js';
import { engineHalted } from './engine_halt.js';

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
 * A live WASM MeshOps mesh wrapper. Its op methods are bound by the module, so
 * the surface is reached by name rather than declared here.
 * @typedef {Object<string, any>} MeshWrapper
 */

/**
 * A spawned WASM module instance, reached by binding name.
 * @typedef {Object<string, any>} WasmModule
 */

/**
 * A createChainValidator handle.
 * @typedef {object} ChainValidator
 * @property {() => Promise<?WasmModule>} acquire - The current validator instance, spawning one if needed.
 * @property {(e: any) => void} noteDeath - Drops a wedged instance.
 * @property {(task: (mod: ?WasmModule) => any) => Promise<any>} withValidator - Runs a task against the instance, serialized.
 * @property {(base: string, ops: ChainOp[]) => Promise<{ok: boolean, message: string}>} chainIsValid - Replays a chain on the validator.
 */

/**
 * What a gate pass concluded. `abandoned` is true on the pass that gives up,
 * and only that one.
 * @typedef {{blocked: Set<string>, complete: boolean, abandoned: boolean}} OpGateVerdict
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
 * Mirror of solid_generators.h `static constexpr float D2R = PI_F / 180.0f`
 * with PI_F = float(PI). The preview and the emitted C++ both convert a hankin
 * angle through it, so the preview must round the product to float32 the way
 * the engine's float multiply does — at 54 and 73 degrees a double PI/180
 * lands one ulp away.
 */
export const D2R_F32 = Math.fround(Math.fround(Math.PI) / 180);

/**
 * Per-op parameter table for the Conway/SolidBuilder operators, shared by the
 * live preview (applyOp) and the C++ generator (generateFuncAndRecipe) so the
 * two cannot drift. Each params entry names a parameter both paths consume, in
 * call-argument order, and carries the tool's slider default and range;
 * solid_codegen.test.js pins both paths against these key sequences. The op set
 * must match what the WASM MeshOps class binds, and every range must stay inside
 * the engine's domain for that operator — the bridge clamps an out-of-domain
 * argument and renders from the clamped value, so the preview would hide a bound
 * the generated C++ carries into an always-on engine assert. The clamp itself is
 * reported by MeshOps.getLastAdjusted(), which the chain validator reads, so
 * these ranges are the first gate rather than the only one.
 * engine_contract_wasm.test.js pins both.
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
  hankin: { params: { angle: { val: 54, min: 0, max: 90, step: 1 } } },
  relax: { params: { iter: { val: 100, min: 1, max: 500, step: 1 } } },
  meta: { params: {} },
  needle: { params: {} },
  zip: { params: {} },
  bevel: { params: { t: { val: 0.25, min: 0.01, max: 0.5, step: 0.01 } } },
};

/**
 * Which authored ops the engine's morph path can build on screen, mirrored from
 * Solids::is_morphable_step (core/mesh/recipe.h) and the sweep clamps it reads
 * (core/mesh/conway_graph.h); the engine-source parity test in
 * wasm_provenance.test.js covers every entry against those headers. An empty
 * object is an op that always sweeps,
 * `null` an op with no leg kind at all, and a parameter entry the band the leg
 * covers. The composite ops (bevel, gyro, meta, needle, zip) are absent because
 * they lower to primitives before the check, and over the ranges this tool
 * offers every primitive they lower to sweeps.
 * @type {Object<string, ?Object<string, {min: number, max: number}>>}
 */
export const MORPH_SWEEP = {
  kis: {},
  ambo: {},
  snub: {},
  dual: {},
  truncate: { t: { min: 0.002, max: 0.995 } },
  chamfer: { t: { min: 0.02, max: 0.63 } },
  expand: null,
  hankin: {},
  relax: {},
};

/**
 * Why the engine's morph path would decline a chain step. A declined step drops
 * the whole entry to IslamicStars' whole-generate fallback, so the shape appears
 * finished instead of being built op by op — a property of the authored chain
 * that no engine-domain check reports.
 * @param {ChainOp} o - The op as the chain holds it.
 * @returns {?string} A sentence naming the reason, or null when the step sweeps.
 */
export function unsweepableReason(o) {
  const opName = typeof o === 'string' ? o : o?.op;
  if (!(opName in MORPH_SWEEP)) return null;
  const band = MORPH_SWEEP[opName];
  if (!band) {
    return `${opName} has no morph leg: a shape using it is generated whole `
      + 'rather than built on screen.';
  }
  for (const [key, { min, max }] of Object.entries(band)) {
    const value = typeof o === 'string' ? NaN : Number(o?.params?.[key]);
    if (!Number.isFinite(value) || (value >= min && value <= max)) continue;
    return `${opName} sweeps ${key} only over ${min} to ${max}: at ${value} the `
      + 'shape is generated whole rather than built on screen.';
  }
  return null;
}

/** The operators this generator can emit, derived from the shared op table. */
export const KNOWN_OPS = new Set(Object.keys(OP_DEFS));

/**
 * Ops that read a params object, derived from the shared op table. The
 * string|object op contract permits a bare string, but for these that leaves
 * o.params undefined, so both applyOp and generateFuncAndRecipe reject it.
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
function requireParams(where, opName, o) {
  if (PARAMETERIZED_OPS.has(opName) && (typeof o === 'string' || !o.params)) {
    throw new Error(`${where}: op "${opName}" requires a params object`);
  }
}

/**
 * The params of an op that requireParams has already accepted.
 * @param {ChainOp} o - The op as supplied.
 * @returns {Object<string, number>} Its params; empty for a parameterless op.
 */
function opParams(o) {
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
 * Shape-checks a persisted base+chain against the op table, without the engine.
 * @param {*} base - The persisted seed-solid name.
 * @param {*} ops - The persisted op chain.
 * @returns {?string} A message naming the first defect, or null when the pair is restorable.
 * @details The chain validator resolves true when its sacrificial module cannot
 * spawn, so a restore path cannot lean on it to reject a hand-edited or
 * stale-format localStorage entry. An op name off the table leaves OP_DEFS[op]
 * undefined and the op-row builder throws reading its params; a declared param
 * that is missing, non-numeric, or outside its current range reaches the WASM
 * bridge as invalid state; and a value off the param's step grid — which no
 * control can produce — splits the generated funcName from the recipe it names,
 * since the name suffix rounds where the emitted call does not. All are caught
 * here, before any state is mutated.
 * The tool's live chain holds {op,
 * params} objects, so a bare-string op — which applyOp accepts — is not a
 * restorable entry.
 */
export function savedChainShapeError(base, ops) {
  if (typeof base !== 'string' || !base) return 'it names no base solid';
  if (!Array.isArray(ops)) return 'its op chain is not a list';
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
 * engine_contract_wasm.test.js pins the order against the engine's registry.
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
 * The seeds solids.h already declares a `SEED_*` constant for. The rest of
 * SIMPLE_SEEDS have none, so a generated Recipe naming one has to carry the
 * constant's definition alongside it.
 */
export const DEFINED_SEED_CONSTANTS = new Set([
  'octahedron', 'dodecahedron', 'icosahedron', 'truncatedOctahedron',
  'rhombicuboctahedron', 'icosidodecahedron', 'truncatedIcosahedron',
  'truncatedIcosidodecahedron', 'snubDodecahedron',
]);

/**
 * The Platonic seeds, the leading run of simple_registry (solids.h pins the
 * count with PLATONIC_COUNT). The WASM registry reports only Simple/Complex, so
 * the page splits its Simple entries into Platonic and Archimedean against this
 * list.
 */
export const PLATONIC_SOLIDS = SIMPLE_SEEDS.slice(0, 5);

/**
 * The Catalan seeds, mirrored from `namespace Catalan` in solids.h. That
 * namespace sees Archimedean/Platonic via using-directives but is NOT itself
 * visible from them, so a generated registry entry on a Catalan base must
 * qualify with `Catalan::`; `Archimedean::<catalan base>` would not compile.
 * engine_contract_wasm.test.js pins both lists against the registry.
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
 * @details Single source of truth for op dispatch: the live-preview module and
 * the sacrificial validator module must run byte-identical chains or validation
 * proves the wrong thing. The bridge answers a soft reject — an out-of-bounds
 * result, or a non-finite/out-of-domain argument — with null rather than a mesh,
 * which throws before the caller swaps its live wrapper. The KNOWN_OPS gate runs
 * first: the wrapper also binds lifetime methods (delete, clone), so an op name
 * off the table would otherwise reach one of them.
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
 * The MeshOpResult keys the WASM bridge binds, in enum order.
 * @details engine_contract_wasm.test.js pins this list against the module enum.
 */
export const MESH_OP_RESULT_NAMES = [
  'OK',
  'UNKNOWN_NAME',
  'CONNECTIVITY_OVERFLOW',
  'FACE_DEGREE_OVERFLOW',
  'ARENA_EXHAUSTED',
  'NON_FINITE_ARG',
  'ANGLE_OUT_OF_DOMAIN',
  'STALE_WRAPPER',
  'ARENA_UNAVAILABLE',
];

// Reason-specific tail of the message a null MeshOps result earns.
/** @type {Object<string, string>} */
const MESH_FAILURE_REMEDY = {
  UNKNOWN_NAME: 'the engine registers no solid by that name',
  CONNECTIVITY_OVERFLOW: 'the result passes the engine 16-bit element ceiling — remove an op',
  FACE_DEGREE_OVERFLOW: 'the result needs a face with more sides than the engine allows — remove an op',
  ARENA_EXHAUSTED: 'the tooling arena is full; it has been flushed — try again',
  NON_FINITE_ARG: 'an op argument was not a finite number',
  ANGLE_OUT_OF_DOMAIN: 'an angle argument sat outside its op domain',
  STALE_WRAPPER: 'a tooling-memory flush reclaimed this mesh — rebuild it from the base solid',
  ARENA_UNAVAILABLE: 'the engine could not reserve its tooling memory, so no mesh op can run — reload the page',
};

/**
 * Reads back why a mesh-producing MeshOps call returned null.
 * @param {WasmModule} Mod - The WASM module instance that produced the null.
 * @param {string} what - What the caller was building, used in the message.
 * @returns {{reason: string, message: string, flush: boolean, fatal: boolean}} The MeshOpResult key, a message to show, whether clearToolingMemory() is the remedy that reason calls for, and whether the reason leaves no MeshOps call that can ever succeed.
 * @details Embind enum values are singletons, so the recorded result is matched
 * by identity against Module.MeshOpResult, never by truthiness. A module that
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
    // The tooling block itself is unavailable: no later call can succeed, and
    // no remedy the page can run brings it back.
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
 * @details MeshOps answers a recoverable failure with null and records the
 * reason (getLastResult); an unchecked null becomes a TypeError several calls
 * later. Only ARENA_EXHAUSTED is cleared by flushing the tooling arenas, so the
 * flush is applied by reason rather than on every failure. ARENA_UNAVAILABLE is
 * not recoverable at all — every later call fails the same way — so it stands
 * the tool down the way an engine halt does rather than reporting on a line the
 * next recompute overwrites.
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
// malformed token. requireFinite covers fractional params; requireCount also
// enforces a positive integer (e.g. a relax iteration count — the engine's
// apply_step refuses a bake-less RELAX below one iteration).
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

// Generated functions are pasted into `namespace IslamicStarPatterns`, which
// carries no using-directive, so the seed call must name its own namespace.
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
 * Builds a stable, unambiguous suffix for a fractional op parameter (0..1+).
 * Quantizes to hundredths and pads to two digits so 0.05 -> "05" and 0.5 -> "50"
 * stay distinct and self-describing in generated funcNames.
 *
 * DEDUP GRANULARITY: the suffix only distinguishes parameter values to the
 * nearest 0.01, so two solids whose params round to the same hundredth (i.e.
 * differ by < 0.005) collide on one funcName and the later paste silently
 * overwrites the earlier. (The hankin op uses a whole-degree suffix, `_hk{deg}`,
 * with the same caveat at 1° granularity.) Generated-source byte-stability is a
 * hard requirement (see module header), so widening precision is intentionally
 * avoided; author distinct params at least 0.01 apart to keep names unique.
 *
 * A negative value is rejected: its `-` prefix would taint the funcName into an
 * invalid C++ identifier, and the upstream tool clamps these params to min 0.01.
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
 * The funcName is the base plus one suffix per op (encoding parameters where two
 * solids could otherwise collide); the recipe is the chained
 * SolidBuilder(...).build() call, which is solids.h's own chaining form.
 *
 * Naming picks one of the several suffix dialects solids.h carries: hundredths
 * plus the short `_hk` for hankin (`_bevel20` for 0.2, `_hk58`). The tenths
 * (`_bevel2` for the same 0.2), thousandths (`_truncate033`), `d`-suffixed
 * (`_truncate50d`) and spelled-out (`_hankin62`) names also there are not
 * generated, so a generated name need not match a hand-written one for the
 * same chain.
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

  let nameParts = [item.base];
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
      // The twist suffix keeps two snubs that share a `t` but differ in twist
      // from colliding on one funcName.
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
      // Parameterless ops: dual, kis, ambo, gyro, meta, needle, zip.
      chain += `.${opName}()`;
      nameParts.push(`_${opName}`);
    }

    // Runs after the per-op emit so the finiteness, count and negative-suffix
    // checks each still name their own defect. A value the sliders cannot reach
    // — a stale or hand-edited store — would otherwise be pasted straight past
    // the engine's always-on operator asserts.
    const banded = outOfRangeParam(opName, params);
    if (banded) {
      throw new Error(`generateFuncAndRecipe: ${opName} param "${banded.key}" must be `
        + `within ${banded.def.min} to ${banded.def.max}, got ${banded.value}`);
    }
  });

  const funcName = nameParts.join('');
  const seed = baseNamespace === '' ? item.base : `${baseNamespace}::${item.base}`;
  const recipe = `SolidBuilder(${seed}(a, b), a, b)${chain}.build()`;

  return { funcName, recipe };
}

/**
 * Renders one stored mesh count for the doc comment. The counts come from
 * user-writable localStorage and land in text a human pastes into a C++ header,
 * so anything that is not a non-negative integer becomes 0 rather than reaching
 * the output; a count carrying a newline or a comment terminator would
 * otherwise splice arbitrary code around the generated function.
 * @param {*} value - The persisted count.
 * @returns {number} The count as a non-negative integer, or 0.
 */
function commentCount(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * A doxygen block filled at the column limit, the way the blocks already in
 * solid_generators.h are: a continuation carries the same ` * ` prefix at the
 * same indent.
 * @param {string[]} tags - One line of words per doxygen tag.
 * @returns {string} The block comment.
 */
function doxygenCpp(tags) {
  const lines = tags.flatMap((text) => fillColumns(text.split(' '), ' * '));
  return ['/**', ...lines, ' */'].join('\n');
}

/**
 * The function's signature, wrapped the way clang-format wraps the ones
 * already in solid_generators.h: both parameters on the declarator's line
 * where they fit, else the second aligned under the first; each shape tried
 * first with the return type leading the line and then with it on its own,
 * and last both parameters indented one level below a bare declarator.
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
 * The return statement, wrapped the way clang-format wraps the recipes already
 * in solid_generators.h: one line where it fits, else one builder call per
 * line at the continuation indent.
 * @param {string} recipe - The SolidBuilder call chain.
 * @returns {string} The statement, ending in ';'.
 */
function returnRecipeCpp(recipe) {
  if (`  return ${recipe};`.length <= COLUMN_LIMIT) return `  return ${recipe};`;
  const [seed, ...calls] = recipe.split(CHAIN_CALL);
  return [`  return ${seed}`, ...calls.map((call) => `      .${call}`)].join('\n') + ';';
}

/**
 * Emits the full FLASHMEM C++ function for a solid, led by the doxygen block
 * every solid_generators.h generator carries, whose brief records the solid's
 * vertex/face/index counts. Output is pasted verbatim into the engine and must
 * clear its clang-format gate, so the exact text and wrapping are
 * byte-for-byte significant.
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
    '@param a Output arena for the result and even pipeline stages.',
    '@param b Scratch arena for odd pipeline stages.',
    '@return The resulting star-pattern mesh.',
  ]);
  return `${doc}\n${signatureCpp(funcName)}\n${returnRecipeCpp(recipe)}\n}`;
}

/**
 * Snaps a computed value onto an op parameter's step grid and clamps it into
 * range, so it is exactly representable by the control that edits it.
 *
 * A parameter is single-valued only if every view of it agrees: an unsnapped
 * value leaves the range input on the nearest step, the number box on its own
 * rounding, and the generated funcName suffix on a third. Snapping at the source
 * — where a value is derived rather than typed — keeps all of them equal.
 *
 * @param {number} value - The unsnapped value.
 * @param {{min: number, max: number, step: number}} def - The parameter's OP_DEFS range.
 * @returns {number} The nearest step from `min`, clamped to [min, max].
 */
export function snapToStep(value, def) {
  const snapped = def.min + Math.round((value - def.min) / def.step) * def.step;
  return Math.min(def.max, Math.max(def.min, snapped));
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
 * @details The half-internal angle is snapped to the control's whole-degree
 * step so the slider, the number box, the _hk suffix and the emitted recipe
 * all carry one value. computeInternalAngle returns 0 for a null or
 * load-failed mesh, which keeps the OP_DEFS default rather than seeding a
 * degenerate 0deg angle.
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
 * Tests whether an ordered planar face has a consistent turn direction.
 *
 * @param {Array<{x:number, y:number, z:number}>} vertices - Mesh vertices.
 * @param {Array<number>} face - Ordered vertex indices for one face.
 * @returns {boolean} True when the face is convex or has fewer than four vertices.
 */
export function isConvexFace(vertices, face) {
  if (face.length < 4) return true;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = vertices[face[i]];
    const b = vertices[face[(i + 1) % face.length]];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }

  const normalLengthSquared = nx * nx + ny * ny + nz * nz;
  if (normalLengthSquared === 0) return true;
  const tolerance = normalLengthSquared * 1e-12;
  let turnSign = 0;

  for (let i = 0; i < face.length; i++) {
    const a = vertices[face[i]];
    const b = vertices[face[(i + 1) % face.length]];
    const c = vertices[face[(i + 2) % face.length]];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const bcx = c.x - b.x;
    const bcy = c.y - b.y;
    const bcz = c.z - b.z;
    const turn = (aby * bcz - abz * bcy) * nx
      + (abz * bcx - abx * bcz) * ny
      + (abx * bcy - aby * bcx) * nz;
    if (Math.abs(turn) <= tolerance) continue;
    const sign = Math.sign(turn);
    if (turnSign !== 0 && sign !== turnSign) return false;
    turnSign = sign;
  }

  return true;
}

/**
 * Fan-triangulates one polygon face, calling emit() once per triangle with its
 * three corners in the face's winding order.
 *
 * A convex face fans from its first corner (face.length - 2 triangles); anything
 * else fans from the centroid (face.length triangles), because a corner fan
 * spills outside a non-convex star face.
 *
 * @param {Array<{x:number, y:number, z:number}>} vertices - Mesh vertices.
 * @param {Array<number>} face - Ordered vertex indices for one face.
 * @param {(a: {x:number, y:number, z:number}, b: {x:number, y:number, z:number}, c: {x:number, y:number, z:number}) => void} emit - Receives each triangle; the centroid corner is a plain {x, y, z}.
 * @param {boolean} [forceCentroid=false] - Always take the centroid fan, even on a convex face.
 * @details forceCentroid exists for the geodesic tessellation, which needs one
 * fan triangle per face edge so shared edges subdivide identically from both
 * sides. The centroid scales by the reciprocal count, matching
 * THREE.Vector3.divideScalar().
 */
export function fanTriangulateFace(vertices, face, emit, forceCentroid = false) {
  if (!forceCentroid && isConvexFace(vertices, face)) {
    for (let i = 1; i < face.length - 1; i++) {
      emit(vertices[face[0]], vertices[face[i]], vertices[face[i + 1]]);
    }
    return;
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const idx of face) {
    cx += vertices[idx].x;
    cy += vertices[idx].y;
    cz += vertices[idx].z;
  }
  const inv = 1 / face.length;
  const centroid = { x: cx * inv, y: cy * inv, z: cz * inv };
  for (let i = 0; i < face.length; i++) {
    emit(centroid, vertices[face[i]], vertices[face[(i + 1) % face.length]]);
  }
}

/**
 * Extracts the unique undirected edges of a polygon-face mesh as [lo, hi] vertex
 * index pairs.
 * @param {Array<Array<number>>} faces - Ordered vertex indices per face.
 * @param {number} vertexCount - Vertex count of the mesh, used as the key radix.
 * @returns {Array<[number, number]>} One [lo, hi] pair per undirected edge, in first-seen order.
 * @details Keys are numeric (lo * vertexCount + hi) rather than `${a}_${b}`
 * template strings, so no per-half-edge string is allocated.
 */
export function uniqueEdges(faces, vertexCount) {
  const seen = new Set();
  /** @type {Array<[number, number]>} */
  const edges = [];
  for (const f of faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * vertexCount + hi;
      if (!seen.has(key)) { seen.add(key); edges.push([lo, hi]); }
    }
  }
  return edges;
}

/**
 * Chooses the barycentric subdivision level for the geodesic (sphere-curved)
 * face tessellation: ~3° of arc per segment on the largest face, capped by a
 * total-triangle budget so dense meshes don't explode, and clamped to [1, 24].
 * @param {number} maxArc - Largest edge arc in radians over all fan triangles.
 * @param {number} triCount - Total fan triangles the mesh would emit unsubdivided.
 * @returns {number} Segments per triangle side, uniform across the whole mesh.
 * @details The level must be UNIFORM across the mesh: any shared edge — polygon
 * boundaries and internal fan diagonals alike — is then split into identical
 * points from both sides, so the tessellation is watertight. A per-triangle
 * level cracks along every count mismatch.
 */
export function geodesicSegments(maxArc, triCount) {
  const nArc = Math.ceil(maxArc / (Math.PI / 60));
  const nBudget = Math.floor(Math.sqrt(400000 / Math.max(1, triCount)));
  return Math.max(1, Math.min(24, nArc, nBudget));
}

/**
 * Normalizes a barycentric mix of three points onto the unit sphere.
 * @param {{x:number, y:number, z:number}} a - First corner.
 * @param {{x:number, y:number, z:number}} b - Second corner.
 * @param {{x:number, y:number, z:number}} c - Third corner.
 * @param {number} wa - Weight on a.
 * @param {number} wb - Weight on b.
 * @param {number} wc - Weight on c.
 * @returns {[number, number, number]} The normalized point's coordinates.
 * @details Scales by the reciprocal length, matching THREE.Vector3.normalize()
 * (divideScalar -> multiplyScalar(1/s)), so the tessellation is bit-identical to
 * the same grid built out of Vector3s. A zero-length mix keeps its coordinates.
 */
function normalizedBarycentric(a, b, c, wa, wb, wc) {
  let x = a.x * wa;
  let y = a.y * wa;
  let z = a.z * wa;
  x += b.x * wb;
  y += b.y * wb;
  z += b.z * wb;
  x += c.x * wc;
  y += c.y * wc;
  z += c.z * wc;
  const inv = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
  return [x * inv, y * inv, z * inv];
}

/**
 * Tessellates one fan triangle into n² spherical sub-triangles: the triangle is
 * split on a barycentric grid of n segments per side and every grid point is
 * projected onto the unit sphere, so the rendered surface curves instead of
 * showing flat plateaus with ridges along the (curved) edge overlay.
 *
 * Grid point P(gi, gj) = normalize(a·(1 − (gi+gj)/n) + b·(gi/n) + c·(gj/n)), rows
 * shrinking toward the b corner (gi + gj <= n). Pick n with geodesicSegments():
 * it must be uniform across the mesh or shared edges crack.
 *
 * @param {{x:number, y:number, z:number}} a - Fan apex (typically the face centroid).
 * @param {{x:number, y:number, z:number}} b - Second corner.
 * @param {{x:number, y:number, z:number}} c - Third corner.
 * @param {number} n - Segments per triangle side; n = 1 emits the single unsubdivided triangle.
 * @returns {number[]} Flat x/y/z triples in triangle-list order, 9n² entries long.
 */
export function geodesicTriangleVertices(a, b, c, n) {
  const grid = [];
  for (let gi = 0; gi <= n; gi++) {
    const row = [];
    for (let gj = 0; gj <= n - gi; gj++) {
      row.push(normalizedBarycentric(a, b, c, 1 - (gi + gj) / n, gi / n, gj / n));
    }
    grid.push(row);
  }

  /** @type {number[]} */
  const out = [];
  const emit = (/** @type {number[]} */ p) => out.push(p[0], p[1], p[2]);
  for (let gi = 0; gi < n; gi++) {
    for (let gj = 0; gj < n - gi; gj++) {
      emit(grid[gi][gj]);
      emit(grid[gi + 1][gj]);
      emit(grid[gi][gj + 1]);
      // The last cell of a row is a lone corner triangle with no upper partner.
      if (gj < n - gi - 1) {
        emit(grid[gi + 1][gj]);
        emit(grid[gi + 1][gj + 1]);
        emit(grid[gi][gj + 1]);
      }
    }
  }
  return out;
}

/**
 * The drop slot a pointer is over: the number of list items whose midpoint it has
 * passed. Slots run 0..items.length, one more than the item count, since the
 * pointer can sit past the last item.
 * @param {number} pointerY - Pointer y in the list's own coordinate space (client y minus the list's top, plus its scrollTop).
 * @param {Array<{offsetTop: number, offsetHeight: number}>} items - The list's item elements, in document order.
 * @returns {number} The slot index.
 * @details Reads the STATIC layout (offsetTop/offsetHeight), so the drag
 * preview's translateY transforms do not feed back into the target it computes.
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

/**
 * Builds a serializer for validated state mutations: each commit sees the state
 * its predecessors left, so two rapid clicks can't validate against the same
 * snapshot and then both land.
 * @param {(reason: any) => void} [onError] - Handler for a rejected commit; defaults to console.error.
 * @returns {(commit: () => any) => Promise<void>} Enqueues a commit and resolves once it (or its error handler) has run.
 */
export function createCommitQueue(onError = console.error) {
  let tail = Promise.resolve();
  return function queueCommit(/** @type {() => any} */ fn) {
    tail = tail.then(fn).catch(onError);
    return tail;
  };
}

/**
 * Builds the sacrificial-module chain validator.
 *
 * The engine fail-fast contract means an op chain that outgrows an engine
 * ceiling — 16-bit vertex/index ranges, hankin's compile bound, classifyFaces'
 * range — traps and permanently wedges the module it ran on. Rather than mirror
 * every ceiling in JS (the op set's growth rules are engine-specific and would
 * drift), each candidate chain is proven on a SACRIFICIAL module instance before
 * the live module ever sees it: a trap kills only the validator, which is
 * respawned, and the mutation is rejected. The engine stays the single authority
 * on its own invariants.
 * @param {() => Promise<WasmModule>} createModule - Spawns a fresh WASM module instance.
 * @returns {ChainValidator} The validator handle.
 */
export function createChainValidator(createModule) {
  /** @type {?Promise<WasmModule>} */
  let modulePromise = null;
  // The instance behind modulePromise, so a task that never got the module
  // handed to it can still read the halt flag off it.
  /** @type {?WasmModule} */
  let moduleInstance = null;
  // Serializes all validator use: tasks hold the single instance (and sometimes
  // a live mesh wrapper) across awaits, and an interleaved clearToolingMemory
  // from another task would invalidate that wrapper.
  let queue = Promise.resolve();

  /**
   * Resolves the current validator instance, spawning one if needed.
   * @returns {Promise<?WasmModule>} The module, or null when it failed to spawn.
   * @details A failed spawn is not cached: the next acquire retries.
   */
  function acquire() {
    const pending = (modulePromise ||= createModule().then((mod) => {
      moduleInstance = mod;
      return mod;
    }));
    return pending.catch(() => {
      // Only drop our own failed attempt; a later acquire may have replaced it.
      if (modulePromise === pending) {
        modulePromise = null;
        moduleInstance = null;
      }
      return null;
    });
  }

  /**
   * Drops a wedged instance so the next task spawns a fresh one.
   * @param {*} e - The error a validator call threw.
   * @returns {void}
   */
  function noteDeath(e) {
    if (!engineHalted(e, moduleInstance)) return;
    modulePromise = null;
    moduleInstance = null;
  }

  /**
   * Runs a task against the validator instance, serialized behind prior tasks.
   * @param {(mod: ?WasmModule) => any} task - Receives the module, or null when it failed to spawn.
   * @returns {Promise<any>} The task's result.
   */
  function withValidator(task) {
    const run = queue.then(async () => task(await acquire()));
    // Keep the queue alive past a rejected task.
    queue = run.catch(() => { });
    return run;
  }

  /**
   * Replays base+ops (plus the classifyFaces pass the tool always runs) on the
   * validator.
   * @param {string} base - Registry name of the seed solid.
   * @param {ChainOp[]} ops - The candidate op chain.
   * @returns {Promise<{ok: boolean, message: string}>} Whether the whole chain is safe for the live module, and why it is not when it is not.
   * @details A missing validator (module failed to spawn) resolves ok: true;
   * prevention degrades to the old behavior rather than blocking the tool. The
   * result is an object, so callers must test `.ok` — an object is truthy, and
   * a call site left testing the result itself reads every chain as valid.
   * A chain is also refused when the engine saturated one of its arguments
   * (getLastAdjusted): the op succeeded, but on a value the tool did not pass,
   * so the generated C++ would carry the out-of-domain one into a firmware
   * assert.
   */
  function chainIsValid(base, ops) {
    return withValidator((Mod) => {
      if (!Mod) return { ok: true, message: '' };
      const Ops = Mod.MeshOps;
      /** @type {?MeshWrapper} */
      let mesh = null;
      // What the replay was building, named in whatever failure it hits.
      let what = `Base solid "${base}"`;
      // Reads the reason the module recorded before any further bridge call can
      // overwrite it, then frees the mesh and the arenas.
      const rejected = (/** @type {any} */ e = null) => {
        const failure = meshOpFailure(Mod, what);
        // A reason of OK means the bridge recorded no rejection and the throw
        // came from JS (an unbound op name, an Embind marshalling error).
        const message = failure.reason === 'OK' && e
          ? `${what} failed: ${e.message || e}`
          : failure.message;
        try { if (mesh) mesh.delete(); Ops.clearToolingMemory(); } catch { /* best effort */ }
        return { ok: false, message };
      };
      // A saturated argument is a success the tool cannot export: the engine
      // rendered from a value it moved into the operator's domain, not from the
      // one the chain holds. Frees the mesh and the arenas like a rejection.
      const saturated = () => {
        try { if (mesh) mesh.delete(); Ops.clearToolingMemory(); } catch { /* best effort */ }
        return {
          ok: false,
          message: `${what} failed: an argument sat outside its op domain and the `
            + 'engine clamped it — the exported value would not be the one it drew',
        };
      };
      try {
        // A null from any bridge call is a recoverable reject (getLastResult
        // names it), so the chain is not safe for the live module either.
        mesh = Ops.fromSolidName(base);
        if (!mesh) return rejected();
        for (const o of ops) {
          what = `Op "${typeof o === 'string' ? o : o.op}"`;
          const next = applyOp(mesh, o);
          // Read before any other bridge call — every MeshOps entry point clears
          // the flag on the way in, so even a getVertices first reads false.
          const adjusted = Ops.getLastAdjusted?.() === true;
          mesh.delete();
          mesh = next;
          if (adjusted) return saturated();
        }
        what = 'Face classification';
        const classes = mesh.classifyFaces();
        if (classes == null) return rejected();
        mesh.delete();
        mesh = null;
        Ops.clearToolingMemory();
        return { ok: true, message: '' };
      } catch (e) {
        const halted = engineHalted(e, Mod);
        noteDeath(e);
        // A trap tears the instance down: it records no reason and cannot be
        // called again, so neither the reason nor the cleanup is attempted.
        if (halted) {
          return { ok: false, message: `${what} exceeded an engine mesh limit` };
        }
        return rejected(e);
      }
    });
  }

  return { acquire, noteDeath, withValidator, chainIsValid };
}

// truncate short-circuits to ambo at exactly t == 0.5 (core/mesh/conway.h), and
// bevel forwards its own t to that truncate, so for these two the resulting
// element census turns on the parameter as well as the op name. 0.5 is each
// one's slider max, so the aliased census is one drag away.
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
  return opParams(o).t === AMBO_ALIAS_T ? `${opName}:ambo` : String(opName);
}

/**
 * Builds the add-op availability gate: which of the offered ops would trap if
 * appended to the current chain.
 *
 * Every candidate is applied (and classified, which committing would do too) on
 * the sacrificial validator, so the answer comes from the engine rather than
 * from a JS mirror of its ceilings. A trap kills only the validator, which is
 * respawned mid-sweep and the chain rebuilt on it.
 *
 * Gating depends only on the mesh's topology, so a pass whose base and chain
 * topology repeat the last complete one is skipped; opTopologyKey names what a
 * chain entry contributes to that.
 * @param {ChainValidator} validator - A createChainValidator handle.
 * @param {number} [retries=3] - Incomplete passes tolerated before probing stops. A validator that never spawns would otherwise be retried on every recompute.
 * @returns {{refresh: (base: string, ops: ChainOp[], candidates: string[]) => Promise<?OpGateVerdict>}} The gate.
 */
export function createOpGate(validator, retries = 3) {
  let generation = 0;
  /** @type {?string} */
  let lastSignature = null;
  let failures = 0;
  let abandoned = false;

  /**
   * Sweeps the candidates against a live validator instance.
   * @param {string} base - Registry name of the seed solid.
   * @param {ChainOp[]} ops - The current chain.
   * @param {string[]} candidates - Op names to probe.
   * @param {?SolidMesh} seedMesh - The current chain's readback mesh, used to
   *   seed each candidate the way the page would seed it; null falls back to
   *   the OP_DEFS defaults.
   * @returns {Promise<{bad: Set<string>, complete: boolean}>} The ops that would
   *   trap, and whether the sweep ever got a full pass against a live module.
   *   Where it did not, `bad` is only a lower bound on what would trap.
   */
  function probe(base, ops, candidates, seedMesh) {
    return validator.withValidator(async (Mod) => {
      /** @type {Set<string>} */
      const bad = new Set();
      if (!Mod) return { bad, complete: false };
      const build = (/** @type {WasmModule} */ M) => {
        let mesh = M.MeshOps.fromSolidName(base);
        if (!mesh) {
          const failure = meshOpFailure(M, `Base solid "${base}"`);
          if (failure.flush) M.MeshOps.clearToolingMemory();
          throw new Error(failure.message);
        }
        for (const o of ops) {
          const next = applyOp(mesh, o);
          mesh.delete();
          mesh = next;
        }
        return mesh;
      };
      /** @type {MeshWrapper} */
      let mesh;
      try {
        mesh = build(Mod); // current chain: valid by construction
      } catch (e) {
        validator.noteDeath(e);
        return { bad, complete: false };
      }
      /**
       * Applies one candidate to the standing chain and classifies the result.
       * @param {WasmModule} mod - The live validator instance.
       * @param {{op: string, params: Object<string, number>}} candidate - The op to probe.
       * @returns {string} 'ok', 'bad', 'exhausted' when the tooling arena filled, or 'trapped' when the instance died.
       * @details The recorded reason is read back before any further bridge
       * call can overwrite it, so the mesh is freed after the verdict.
       */
      const attempt = (mod, candidate) => {
        let out = null;
        try {
          out = applyOp(mesh, candidate);
          const classes = out.classifyFaces();
          const verdict = classes ? 'ok'
            : (meshOpFailure(mod, 'Face classification').flush ? 'exhausted' : 'bad');
          out.delete();
          return verdict;
        } catch (e) {
          const halted = engineHalted(e, mod);
          validator.noteDeath(e);
          if (halted) return 'trapped';
          out?.delete();
          // applyOp raises a soft reject as a throw; of the reasons behind one,
          // only a full arena is cleared by flushing it.
          return meshOpFailure(mod, `Op "${candidate.op}"`).flush ? 'exhausted' : 'bad';
        }
      };

      for (const op of candidates) {
        /** @type {{op: string, params: Object<string, number>}} */
        const candidate = { op, params: seedOpParams(op, seedMesh) };
        let verdict = attempt(Mod, candidate);
        if (verdict === 'exhausted') {
          // A full arena rejects every later candidate too, so reclaim it and
          // judge this one on an arena it does not share with its predecessors.
          try { mesh.delete(); Mod.MeshOps.clearToolingMemory(); mesh = build(Mod); }
          catch (e) { validator.noteDeath(e); return { bad, complete: false }; }
          verdict = attempt(Mod, candidate);
        }
        if (verdict === 'trapped') {
          bad.add(op);
          // Instance is wedged; respawn and rebuild for the remaining probes.
          Mod = await validator.acquire();
          if (!Mod) return { bad, complete: false };
          try { mesh = build(Mod); }
          catch (e) { validator.noteDeath(e); return { bad, complete: false }; }
        } else if (verdict !== 'ok') {
          bad.add(op);
        }
      }
      try { mesh.delete(); Mod.MeshOps.clearToolingMemory(); }
      catch (e) { validator.noteDeath(e); }
      return { bad, complete: true };
    });
  }

  /**
   * Re-derives which candidates are blocked on the current chain.
   * @param {string} base - Registry name of the seed solid.
   * @param {ChainOp[]} ops - The current chain.
   * @param {string[]} candidates - Op names to probe.
   * @param {?SolidMesh} [mesh] - The current chain's readback mesh, used to seed
   *   each candidate; omitted falls back to the OP_DEFS defaults.
   * @returns {Promise<?OpGateVerdict>} The verdict, or null when the pass was
   *   skipped or the chain changed under it.
   */
  async function refresh(base, ops, candidates, mesh = null) {
    const signature = `${base}|${ops.map(opTopologyKey).join(',')}`;
    if (abandoned || signature === lastSignature) return null;

    const started = ++generation;
    const { bad, complete } = await probe(base, structuredClone(ops), candidates, mesh);
    if (started !== generation) return null;

    if (complete) {
      lastSignature = signature;
      failures = 0;
    } else if (++failures >= retries) {
      abandoned = true;
    }
    return { blocked: bad, complete, abandoned };
  }

  return { refresh };
}
