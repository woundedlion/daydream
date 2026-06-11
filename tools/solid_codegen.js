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

// Format float with f suffix and .0 if integer, to satisfy C++ strictness and convention
export function formatFloat(val) {
  const s = val.toString();
  return (s.indexOf('.') === -1 ? s + ".0" : s) + "f";
}

// Stable, unambiguous suffix for a fractional op parameter (0..1+).
// toString().replace('0.','') was injective for clean 0.01-step values but
// produced junk for float-error inputs (0.30000000000000004 -> "3000...")
// and read ambiguously (0.5 -> "5"). Quantize to hundredths and pad to two
// digits so 0.05 -> "05" and 0.5 -> "50" stay distinct and self-describing.
export function pctSuffix(val) {
  return String(Math.round(val * 100)).padStart(2, '0');
}

export function generateFuncAndRecipe(item) {
  // Build the function name from base + ops, matching solids.h conventions
  let nameParts = [item.base];

  // Build the SolidBuilder chain
  let chain = '';

  item.ops.forEach(o => {
    const opName = typeof o === 'string' ? o : o.op;

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
      const iter = o.params.iter || 100;
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

export function generateRecipeCpp(item) {
  const { funcName, recipe } = generateFuncAndRecipe(item);
  const comment = `// V=${item.vCount || 0}, F=${item.fCount || 0}, I=${item.iCount || 0}`;
  return `${comment}\nFLASHMEM inline PolyMesh ${funcName}(Arena &a, Arena &b) {\n  return ${recipe};\n}`;
}

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
