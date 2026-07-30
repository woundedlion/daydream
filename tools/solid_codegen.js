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
 * must match what the WASM MeshOps class binds; engine_contract_wasm.test.js
 * pins that agreement.
 */
export const OP_DEFS = {
  kis: { params: {} },
  ambo: { params: {} },
  gyro: { params: {} },
  snub: { params: { t: { val: 0.5, min: 0.01, max: 0.99, step: 0.01 }, twist: { val: 0.0, min: 0, max: 1.0, step: 0.01 } } },
  dual: { params: {} },
  truncate: { params: { t: { val: 0.33, min: 0.01, max: 0.5, step: 0.01 } } },
  chamfer: { params: { t: { val: 0.5, min: 0.01, max: 1.0, step: 0.01 } } },
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
 * The Platonic seeds, mirrored from solids.h. The WASM registry reports only
 * Simple/Complex, so the page splits its Simple entries into Platonic and
 * Archimedean against this list.
 */
export const PLATONIC_SOLIDS = [
  'tetrahedron', 'cube', 'octahedron', 'dodecahedron', 'icosahedron',
];

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
 * @throws {Error} When the module binds no method for the op name.
 * @details Single source of truth for op dispatch: the live-preview module and
 * the sacrificial validator module must run byte-identical chains or validation
 * proves the wrong thing.
 */
export function applyOp(mesh, o) {
  const opName = typeof o === 'string' ? o : o.op;
  requireParams('applyOp', opName, o);
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

// A base seed-solid name is pasted as a C++ function call (`base(a, b)`), so
// guard its shape against the valid-identifier pattern.
const CPP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Op params become C++ literals, so reject anything that would emit NaN/Inf or a
// malformed token. requireFinite covers fractional params; requireCount also
// enforces a non-negative integer (e.g. a relax iteration count).
function requireFinite(opName, param, val) {
  if (!Number.isFinite(val)) {
    throw new Error(`generateFuncAndRecipe: ${opName} param "${param}" must be a finite number, got ${val}`);
  }
}

function requireCount(opName, param, val) {
  if (!Number.isInteger(val) || val < 0) {
    throw new Error(`generateFuncAndRecipe: ${opName} param "${param}" must be a non-negative integer, got ${val}`);
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
 * SolidBuilder(...).build() call. Both naming and chaining follow solids.h
 * conventions.
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
  const comment = `// V=${item.vCount || 0}, F=${item.fCount || 0}, I=${item.iCount || 0}`;
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
 * @returns {{acquire: function(): Promise<?Object>, noteDeath: function(*): void, withValidator: function(Function): Promise<*>, chainIsValid: function(string, Array<Object>): Promise<boolean>}} The validator handle.
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
   */
  function acquire() {
    modulePromise ||= createModule();
    return modulePromise.catch(() => null);
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
   * @returns {Promise<boolean>} True when the whole chain is safe for the live module.
   * @details A missing validator (module failed to spawn) resolves true:
   * prevention degrades to the old behavior rather than blocking the tool.
   */
  function chainIsValid(base, ops) {
    return withValidator((Mod) => {
      if (!Mod) return true;
      const Ops = Mod.MeshOps;
      let mesh = null;
      try {
        mesh = Ops.fromSolidName(base);
        for (const o of ops) {
          const next = applyOp(mesh, o);
          mesh.delete();
          mesh = next;
        }
        mesh.classifyFaces();
        mesh.delete();
        Ops.clearToolingMemory();
        return true;
      } catch (e) {
        noteDeath(e);
        if (!(e instanceof WebAssembly.RuntimeError)) {
          try { if (mesh) mesh.delete(); Ops.clearToolingMemory(); } catch (_) { }
        }
        return false;
      }
    });
  }

  return { acquire, noteDeath, withValidator, chainIsValid };
}
