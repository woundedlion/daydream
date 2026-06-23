/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Pure code-generation and geometry helpers extracted from the solids tool page
 * (tools/solids.html) so they can be unit-tested without a DOM or WASM runtime.
 * These produce the C++ source strings that get pasted verbatim into the engine
 * (SolidBuilder recipes, FLASHMEM functions), so their output formatting must
 * stay byte-for-byte stable. computeInternalAngle uses plain {x, y, z} vector
 * math (a THREE.Vector3 satisfies that shape) so the module stays free of any
 * three.js dependency.
 */

import { formatFloatCpp } from './cpp_format.js';

// The Conway/SolidBuilder operators this generator knows how to emit. An op
// outside this set would be pasted verbatim (`.op()`) into non-compiling C++
// that only fails at engine compile time, so generateFuncAndRecipe rejects it.
const KNOWN_OPS = new Set([
  'truncate', 'expand', 'chamfer', 'hankin', 'snub', 'relax', 'bevel',
  'dual', 'kis', 'ambo', 'gyro', 'meta', 'needle', 'zip',
]);

// A base seed-solid name is pasted as a C++ function call (`base(a, b)`). The
// valid set is the WASM solid registry (dynamic, invisible to this pure
// module), so guard the shape: every registry name is a valid C++ identifier,
// and the check also stops an unexpected caller from injecting arbitrary text.
const CPP_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// C++ float-literal formatter — the shared formatFloatCpp (cpp_format.js).
// Re-exported under the historical `formatFloat` name so solids.html and the
// recipe builders below keep their call sites; output is identical (6-digit
// toFixed + trailing-zero trim + `f` suffix, scientific-notation-safe).
export const formatFloat = formatFloatCpp;

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
 * @param {number} val - The fractional parameter value (typically 0..1+).
 * @returns {string} A two-or-more digit percent suffix.
 */
export function pctSuffix(val) {
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
 * @param {Array<(string|{op:string, params:Object})>} item.ops - Ops to apply, each a bare op name or an {op, params} object.
 * @returns {{funcName: string, recipe: string}} The generated C++ function name and SolidBuilder recipe expression.
 */
export function generateFuncAndRecipe(item) {
  if (typeof item.base !== 'string' || !CPP_IDENTIFIER.test(item.base)) {
    throw new Error(`generateFuncAndRecipe: base "${item.base}" is not a valid C++ identifier`);
  }

  let nameParts = [item.base];
  let chain = '';

  item.ops.forEach(o => {
    const opName = typeof o === 'string' ? o : o.op;
    if (!KNOWN_OPS.has(opName)) {
      throw new Error(`generateFuncAndRecipe: unknown op "${opName}" ` +
        `(expected one of ${[...KNOWN_OPS].join(', ')})`);
    }

    if (opName === 'truncate') {
      chain += `.truncate(${formatFloat(o.params.t)})`;
      nameParts.push(`_truncate${pctSuffix(o.params.t)}`);
    } else if (opName === 'expand') {
      chain += `.expand(${formatFloat(o.params.t)})`;
      nameParts.push(`_expand${pctSuffix(o.params.t)}`);
    } else if (opName === 'chamfer') {
      chain += `.chamfer(${formatFloat(o.params.t)})`;
      nameParts.push(`_chamfer${pctSuffix(o.params.t)}`);
    } else if (opName === 'hankin') {
      chain += `.hankin(${formatFloat(o.params.angle)} * D2R)`;
      nameParts.push(`_hk${Math.round(o.params.angle)}`);
    } else if (opName === 'snub') {
      // snub may have t and twist params in OP_DEFS but SolidBuilder defaults work
      chain += `.snub()`;
      nameParts.push(`_snub`);
    } else if (opName === 'relax') {
      // `??` not `||`: an explicit iter:0 is a valid (no-op relax) count and
      // must not be silently coerced to the 100 default — only an
      // absent/undefined iter falls back.
      const iter = o.params.iter ?? 100;
      chain += `.relax(${iter})`;
      // Encode the iteration count so two solids differing only in relax
      // depth export distinct funcNames instead of colliding on `_relax`.
      nameParts.push(`_relax${iter}`);
    } else if (opName === 'bevel') {
      chain += `.bevel(${formatFloat(o.params.t)})`;
      nameParts.push(`_bevel${pctSuffix(o.params.t)}`);
    } else {
      // Simple parameterless ops: dual, kis, ambo, gyro, meta, needle, zip
      chain += `.${opName}()`;
      nameParts.push(`_${opName}`);
    }
  });

  const funcName = nameParts.join('');
  const recipe = `SolidBuilder(${item.base}(a, b), a, b)${chain}.build()`;

  return { funcName, recipe };
}

/**
 * Emits the full FLASHMEM C++ function for a solid, prefixed with a comment
 * recording its vertex/face/index counts. Output is pasted verbatim into the
 * engine, so the exact text and formatting are byte-for-byte significant.
 * @param {Object} item - The solid spec (see generateFuncAndRecipe), optionally with vCount, fCount, and iCount counts.
 * @returns {string} The complete C++ function source including its leading count comment.
 */
export function generateRecipeCpp(item) {
  const { funcName, recipe } = generateFuncAndRecipe(item);
  const comment = `// V=${item.vCount || 0}, F=${item.fCount || 0}, I=${item.iCount || 0}`;
  return `${comment}\nFLASHMEM inline PolyMesh ${funcName}(Arena &a, Arena &b) {\n  return ${recipe};\n}`;
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

  // Planar internal angle at v2 is the angle between the vectors v2->v1 and v2->v3.
  // Use plain {x, y, z} math (THREE.Vector3 satisfies this shape) so the module
  // carries no three.js dependency.
  const dir1 = { x: v1.x - v2.x, y: v1.y - v2.y, z: v1.z - v2.z };
  const dir2 = { x: v3.x - v2.x, y: v3.y - v2.y, z: v3.z - v2.z };

  const dot = dir1.x * dir2.x + dir1.y * dir2.y + dir1.z * dir2.z;
  const len1 = Math.sqrt(dir1.x * dir1.x + dir1.y * dir1.y + dir1.z * dir1.z);
  const len2 = Math.sqrt(dir2.x * dir2.x + dir2.y * dir2.y + dir2.z * dir2.z);
  if (len1 === 0 || len2 === 0) return 0;

  // Clamp to [-1, 1] to guard against floating-point drift before acos, matching
  // THREE.Vector3.angleTo.
  const cos = Math.min(1, Math.max(-1, dot / (len1 * len2)));
  return Math.acos(cos);
}
