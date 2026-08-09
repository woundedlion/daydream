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

import { formatFloatCpp } from './cpp_format.js';

/**
 * Per-op parameter table for the Conway/SolidBuilder operators, shared by the
 * live preview (applyOp) and the C++ generator (generateFuncAndRecipe) so the
 * two cannot drift. Each params entry names a parameter both paths consume, in
 * call-argument order, and carries the tool's slider default and range;
 * solid_codegen.test.js pins both paths against these key sequences. The op set
 * must match what the WASM MeshOps class binds, and every range must stay inside
 * the engine's domain for that operator — the bridge clamps an out-of-domain
 * argument and only logs, so the preview would hide a bound the generated C++
 * carries into an always-on engine assert. engine_contract_wasm.test.js pins
 * both.
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
 * @param {(string|{op:string, params:Object})} o - The op as supplied.
 * @returns {void}
 * @throws {Error} When a parameterized op arrives without a params object.
 */
function requireParams(where, opName, o) {
  if (PARAMETERIZED_OPS.has(opName) && (typeof o === 'string' || !o.params)) {
    throw new Error(`${where}: op "${opName}" requires a params object`);
  }
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
 * that is missing or non-numeric reaches the WASM bridge as undefined. Both are
 * caught here, before any state is mutated. The tool's live chain holds {op,
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
    for (const key of Object.keys(OP_DEFS[o.op].params)) {
      if (!Number.isFinite(o.params?.[key])) {
        return `${at} ("${o.op}") carries no numeric "${key}"`;
      }
    }
  }
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
 * @param {Object} mesh - A live WASM MeshOps mesh wrapper.
 * @param {(string|{op:string, params:Object})} o - The op to apply, as a bare op name or an {op, params} object.
 * @returns {Object} The new mesh wrapper.
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
 * @param {Object} mesh - A live WASM MeshOps mesh wrapper.
 * @param {(string|{op:string, params:Object})} o - The op to apply.
 * @param {string} opName - The op's name.
 * @returns {?Object} The new mesh wrapper, or null when the module soft-rejects the op.
 * @throws {Error} When the module binds no method for the op name.
 */
function dispatchOp(mesh, o, opName) {
  if (opName === 'truncate') return mesh.truncate(o.params.t);
  if (opName === 'chamfer') return mesh.chamfer(o.params.t);
  if (opName === 'expand') return mesh.expand(o.params.t);
  if (opName === 'bevel') return mesh.bevel(o.params.t);
  if (opName === 'snub') return mesh.snub(o.params.t, o.params.twist);
  if (opName === 'hankin') return mesh.hankin(o.params.angle * (Math.PI / 180));
  if (opName === 'relax') return mesh.relax(o.params.iter);
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
];

// Reason-specific tail of the message a null MeshOps result earns.
const MESH_FAILURE_REMEDY = {
  UNKNOWN_NAME: 'the engine registers no solid by that name',
  CONNECTIVITY_OVERFLOW: 'the result passes the engine 16-bit element ceiling — remove an op',
  FACE_DEGREE_OVERFLOW: 'the result needs a face with more sides than the engine allows — remove an op',
  ARENA_EXHAUSTED: 'the tooling arena is full; it has been flushed — try again',
  NON_FINITE_ARG: 'an op argument was not a finite number',
  ANGLE_OUT_OF_DOMAIN: 'an angle argument sat outside its op domain',
  STALE_WRAPPER: 'a tooling-memory flush reclaimed this mesh — rebuild it from the base solid',
};

/**
 * Reads back why a mesh-producing MeshOps call returned null.
 * @param {Object} Mod - The WASM module instance that produced the null.
 * @param {string} what - What the caller was building, used in the message.
 * @returns {{reason: string, message: string, flush: boolean}} The MeshOpResult key, a message to show, and whether clearToolingMemory() is the remedy that reason calls for.
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
  };
}

/**
 * Passes a mesh-producing MeshOps result through, or reports and remedies the
 * failure a null stands for.
 * @param {Object|null} result - What the bridge returned.
 * @param {string} what - What the caller was building, used in the message.
 * @param {Object} ctx - The live wiring, read per call because an engine halt nulls it.
 * @param {Object} ctx.Mod - The WASM module instance that produced the result.
 * @param {{clearToolingMemory: Function}} ctx.meshOps - Its MeshOps binding.
 * @param {Function} ctx.onError - Surfaces the failure message to the user.
 * @returns {Object|null} The result, or null when it was a failure.
 * @details MeshOps answers a recoverable failure with null and records the
 * reason (getLastResult); an unchecked null becomes a TypeError several calls
 * later. Only ARENA_EXHAUSTED is cleared by flushing the tooling arenas, so the
 * flush is applied by reason rather than on every failure.
 */
export function requireMeshResult(result, what, { Mod, meshOps, onError }) {
  if (result) return result;
  const failure = meshOpFailure(Mod, what);
  if (failure.flush) meshOps.clearToolingMemory();
  onError(failure.message);
  return null;
}

// A base seed-solid name is pasted as a C++ function call (`base(a, b)`), so
// guard its shape against the valid-identifier pattern.
const CPP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Op params become C++ literals, so reject anything that would emit NaN/Inf or a
// malformed token. requireFinite covers fractional params; requireCount also
// enforces a positive integer (e.g. a relax iteration count — the engine's
// apply_step refuses a bake-less RELAX below one iteration).
function requireFinite(opName, param, val) {
  if (!Number.isFinite(val)) {
    throw new Error(`generateFuncAndRecipe: ${opName} param "${param}" must be a finite number, got ${val}`);
  }
}

function requireCount(opName, param, val) {
  if (!Number.isInteger(val) || val < 1) {
    throw new Error(`generateFuncAndRecipe: ${opName} param "${param}" must be a positive integer, got ${val}`);
  }
}

// Generated functions are pasted into `namespace IslamicStarPatterns`, which
// carries no using-directive, so the seed call must name its own namespace.
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
 * @param {Object} item - The solid spec.
 * @param {string} item.base - The base solid name.
 * @param {Array<(string|{op:string, params:Object})>} item.ops - Ops to apply, each a bare op name or an {op, params} object; must be non-empty.
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

    if (opName === 'truncate') {
      requireFinite(opName, 't', o.params.t);
      chain += `.truncate(${formatFloat(o.params.t)})`;
      nameParts.push(`_truncate${pctSuffix(o.params.t)}`);
    } else if (opName === 'expand') {
      requireFinite(opName, 't', o.params.t);
      chain += `.expand(${formatFloat(o.params.t)})`;
      nameParts.push(`_expand${pctSuffix(o.params.t)}`);
    } else if (opName === 'chamfer') {
      requireFinite(opName, 't', o.params.t);
      chain += `.chamfer(${formatFloat(o.params.t)})`;
      nameParts.push(`_chamfer${pctSuffix(o.params.t)}`);
    } else if (opName === 'hankin') {
      requireFinite(opName, 'angle', o.params.angle);
      if (o.params.angle < 0) {
        throw new Error(`generateFuncAndRecipe: hankin angle ${o.params.angle} is negative; suffix must stay a valid C++ identifier`);
      }
      chain += `.hankin(${formatFloat(o.params.angle)} * D2R)`;
      nameParts.push(`_hk${Math.round(o.params.angle)}`);
    } else if (opName === 'snub') {
      // The twist suffix keeps two snubs that share a `t` but differ in twist
      // from colliding on one funcName.
      requireFinite(opName, 't', o.params.t);
      requireFinite(opName, 'twist', o.params.twist);
      chain += `.snub(${formatFloat(o.params.t)}, ${formatFloat(o.params.twist)})`;
      nameParts.push(`_snub${pctSuffix(o.params.t)}_tw${pctSuffix(o.params.twist)}`);
    } else if (opName === 'relax') {
      requireCount(opName, 'iter', o.params.iter);
      chain += `.relax(${o.params.iter})`;
      nameParts.push(`_relax${o.params.iter}`);
    } else if (opName === 'bevel') {
      requireFinite(opName, 't', o.params.t);
      chain += `.bevel(${formatFloat(o.params.t)})`;
      nameParts.push(`_bevel${pctSuffix(o.params.t)}`);
    } else {
      // Parameterless ops: dual, kis, ambo, gyro, meta, needle, zip.
      chain += `.${opName}()`;
      nameParts.push(`_${opName}`);
    }
  });

  const funcName = nameParts.join('');
  const seed = baseNamespace === '' ? item.base : `${baseNamespace}::${item.base}`;
  const recipe = `SolidBuilder(${seed}(a, b), a, b)${chain}.build()`;

  return { funcName, recipe };
}

/**
 * Renders one stored mesh count for the leading comment. The counts come from
 * user-writable localStorage and land in text a human pastes into a C++ header,
 * so anything that is not a non-negative integer becomes 0 rather than reaching
 * the output; a count carrying a newline would otherwise splice arbitrary code
 * above the generated function.
 * @param {*} value - The persisted count.
 * @returns {number} The count as a non-negative integer, or 0.
 */
function commentCount(value) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Emits the full FLASHMEM C++ function for a solid, prefixed with a comment
 * recording its vertex/face/index counts. Output is pasted verbatim into the
 * engine, so the exact text and formatting are byte-for-byte significant.
 * @param {Object} item - The solid spec (see generateFuncAndRecipe), optionally with vCount, fCount, and iCount counts.
 * @param {string} baseNamespace - Namespace qualifying the seed call (e.g. "Archimedean"); required, since the emitted function is pasted where the seed is not visible unqualified.
 * @returns {string} The complete C++ function source including its leading count comment.
 * @throws {Error} When the namespace is not a valid C++ identifier, or generateFuncAndRecipe rejects the spec.
 */
export function generateRecipeCpp(item, baseNamespace) {
  requireNamespace('generateRecipeCpp', baseNamespace);
  const { funcName, recipe } = generateFuncAndRecipe(item, baseNamespace);
  const comment = `// V=${commentCount(item.vCount)}, F=${commentCount(item.fCount)}, `
    + `I=${commentCount(item.iCount)}`;
  return `${comment}\nFLASHMEM static PolyMesh ${funcName}(Arena &a, Arena &b) {\n  return ${recipe};\n}`;
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
 * @param {{faces: Array<Array<number>>, vertices: Array<{x:number, y:number, z:number}>}} mesh - The mesh whose first face is measured; vertices use plain {x, y, z} math (a THREE.Vector3 satisfies this shape).
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

  const out = [];
  const emit = (p) => out.push(p[0], p[1], p[2]);
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
 * @param {Function} [onError] - Handler for a rejected commit; defaults to console.error.
 * @returns {function(Function): Promise<void>} Enqueues a commit and resolves once it (or its error handler) has run.
 */
export function createCommitQueue(onError = console.error) {
  let tail = Promise.resolve();
  return function queueCommit(fn) {
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
 * @param {function(): Promise<Object>} createModule - Spawns a fresh WASM module instance.
 * @returns {{acquire: function(): Promise<?Object>, noteDeath: function(*): void, withValidator: function(Function): Promise<*>, chainIsValid: function(string, Array<Object>): Promise<{ok: boolean, message: string}>}} The validator handle.
 */
export function createChainValidator(createModule) {
  let modulePromise = null;
  // Serializes all validator use: tasks hold the single instance (and sometimes
  // a live mesh wrapper) across awaits, and an interleaved clearToolingMemory
  // from another task would invalidate that wrapper.
  let queue = Promise.resolve();

  /**
   * Resolves the current validator instance, spawning one if needed.
   * @returns {Promise<?Object>} The module, or null when it failed to spawn.
   * @details A failed spawn is not cached: the next acquire retries.
   */
  function acquire() {
    const pending = (modulePromise ||= createModule());
    return pending.catch(() => {
      // Only drop our own failed attempt; a later acquire may have replaced it.
      if (modulePromise === pending) modulePromise = null;
      return null;
    });
  }

  /**
   * Drops a wedged instance so the next task spawns a fresh one.
   * @param {*} e - The error a validator call threw.
   * @returns {void}
   */
  function noteDeath(e) {
    if (e instanceof WebAssembly.RuntimeError) modulePromise = null;
  }

  /**
   * Runs a task against the validator instance, serialized behind prior tasks.
   * @param {function(?Object): *} task - Receives the module, or null when it failed to spawn.
   * @returns {Promise<*>} The task's result.
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
   * @param {Array<(string|{op:string, params:Object})>} ops - The candidate op chain.
   * @returns {Promise<{ok: boolean, message: string}>} Whether the whole chain is safe for the live module, and why it is not when it is not.
   * @details A missing validator (module failed to spawn) resolves ok: true;
   * prevention degrades to the old behavior rather than blocking the tool. The
   * result is an object, so callers must test `.ok` — an object is truthy, and
   * a call site left testing the result itself reads every chain as valid.
   */
  function chainIsValid(base, ops) {
    return withValidator((Mod) => {
      if (!Mod) return { ok: true, message: '' };
      const Ops = Mod.MeshOps;
      let mesh = null;
      // What the replay was building, named in whatever failure it hits.
      let what = `Base solid "${base}"`;
      // Reads the reason the module recorded before any further bridge call can
      // overwrite it, then frees the mesh and the arenas.
      const rejected = (e = null) => {
        const failure = meshOpFailure(Mod, what);
        // A reason of OK means the bridge recorded no rejection and the throw
        // came from JS (an unbound op name, an Embind marshalling error).
        const message = failure.reason === 'OK' && e
          ? `${what} failed: ${e.message || e}`
          : failure.message;
        try { if (mesh) mesh.delete(); Ops.clearToolingMemory(); } catch { }
        return { ok: false, message };
      };
      try {
        // A null from any bridge call is a recoverable reject (getLastResult
        // names it), so the chain is not safe for the live module either.
        mesh = Ops.fromSolidName(base);
        if (!mesh) return rejected();
        for (const o of ops) {
          what = `Op "${typeof o === 'string' ? o : o.op}"`;
          const next = applyOp(mesh, o);
          mesh.delete();
          mesh = next;
        }
        what = 'Face classification';
        const classes = mesh.classifyFaces();
        if (classes == null) return rejected();
        mesh.delete();
        mesh = null;
        Ops.clearToolingMemory();
        return { ok: true, message: '' };
      } catch (e) {
        noteDeath(e);
        // A trap tears the instance down: it records no reason and cannot be
        // called again, so neither the reason nor the cleanup is attempted.
        if (e instanceof WebAssembly.RuntimeError) {
          return { ok: false, message: `${what} exceeded an engine mesh limit` };
        }
        return rejected(e);
      }
    });
  }

  return { acquire, noteDeath, withValidator, chainIsValid };
}
