/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The solids tool's WASM MeshOps orchestration: building a mesh from a base
 * solid and an op chain, classifying its faces, reading it back into JS, and
 * freeing the tooling arenas.
 *
 * MeshOps answers a recoverable failure with null and records the reason in
 * getLastResult(), which the next call overwrites.
 */

import { applyOp, meshOpFailure, requireMeshResult } from './solid_codegen.js';

/** @typedef {import('./solid_codegen.js').ChainOp} ChainOp */
/** @typedef {import('./solid_codegen.js').MeshWrapper} MeshWrapper */
/** @typedef {import('./solid_codegen.js').WasmModule} WasmModule */

/** @typedef {import('./solid_render.js').Vertex} Vertex */
/** @typedef {import('./solid_render.js').SolidMeshData} SolidMeshData */

/**
 * The live wiring one build runs against. Read per call: an engine trap nulls
 * the page's module handles, so a context outlives at most one build.
 * @typedef {object} MeshBuildContext
 * @property {WasmModule} Mod - The WASM module instance.
 * @property {{fromSolidName: (name: string) => MeshWrapper?, clearToolingMemory: () => void}} meshOps - Its MeshOps binding.
 * @property {(x: number, y: number, z: number) => Vertex} vector - Builds one vertex.
 * @property {(message: string) => void} onError - Surfaces a failure to the user.
 * @property {(message: string) => void} onFatal - Stands the tool down for a failure nothing can recover from.
 * @property {(e: unknown) => boolean} onTrap - Handles a thrown value, reporting whether it was an unrecoverable engine trap.
 */

/**
 * What a chain build produced.
 * @typedef {object} SolidBuildResult
 * @property {SolidMeshData} meshData - The JS-side copy of the built mesh.
 * @property {Int32Array?} faceClasses - Per-face topology class ids, or null when the classify pass was refused.
 * @property {?string} classifyFailure - Why the classify pass was refused, to report after the mesh is drawn.
 */

/**
 * Copies a live WASM mesh wrapper into plain JS vertices and faces.
 * @param {MeshWrapper} wasmMesh - The wrapper to read back.
 * @param {MeshBuildContext} ctx - The live wiring.
 * @returns {SolidMeshData?} The copy, or null when either readback was refused.
 * @details The bridge refuses a wrapper held across clearToolingMemory()
 * (STALE_WRAPPER). A NaN component is refused as degenerate geometry.
 */
export function readbackMesh(wasmMesh, ctx) {
  const vArray = requireMeshResult(wasmMesh.getVertices(), 'Mesh vertex readback', ctx);
  if (!vArray) return null;

  for (let i = 0; i < vArray.length; i++) {
    if (Number.isNaN(vArray[i])) {
      ctx.onError(`Mesh vertex readback failed: component ${i} is NaN`);
      return null;
    }
  }

  const vertices = [];
  for (let i = 0; i < vArray.length; i += 3) {
    vertices.push(ctx.vector(vArray[i], vArray[i + 1], vArray[i + 2]));
  }

  // { indices: Uint16Array, counts: Uint8Array }
  const flat = requireMeshResult(wasmMesh.getFaces(), 'Mesh face readback', ctx);
  if (!flat) return null;
  const faces = [];
  let k = 0;
  for (let i = 0; i < flat.counts.length; i++) {
    const n = flat.counts[i];
    const face = new Array(n);
    for (let c = 0; c < n; c++) face[c] = flat.indices[k++];
    faces.push(face);
  }

  return { vertices, faces };
}

/**
 * Builds one registered solid and reads it back. Frees the wrapper and tooling
 * arenas after success or a recoverable readback failure; leaves a halted module alone.
 * @param {string} name - Registry name of the solid.
 * @param {string} what - What the caller was building, used in a failure message.
 * @param {MeshBuildContext} ctx - The live wiring.
 * @returns {SolidMeshData?} The copy, or null when the build or the readback was refused.
 */
export function buildBaseMesh(name, what, ctx) {
  const wasmMesh = requireMeshResult(ctx.meshOps.fromSolidName(name), what, ctx);
  if (!wasmMesh) return null;
  let meshData;
  try {
    meshData = readbackMesh(wasmMesh, ctx);
  } catch (e) {
    console.error('WASM readback error:', e);
    if (ctx.onTrap(e)) return null;
    wasmMesh.delete();
    ctx.meshOps.clearToolingMemory();
    ctx.onError(`Mesh readback failed: ${
      e instanceof Error && e.message ? e.message : String(e)}`);
    return null;
  }
  wasmMesh.delete();
  ctx.meshOps.clearToolingMemory();
  return meshData;
}

/**
 * Builds a base solid, applies an op chain to it, classifies its faces and reads
 * the result back. Frees wrappers and tooling arenas after success or recoverable
 * post-build failure; leaves a halted module alone.
 * @param {string} base - Registry name of the base solid.
 * @param {ChainOp[]} ops - Ops to apply, in order.
 * @param {MeshBuildContext} ctx - The live wiring.
 * @returns {SolidBuildResult?} What to draw, or null when there is nothing to draw.
 * @details Every failure the bridge foresees returns null with a MeshOpResult
 * reason in getLastResult(); ARENA_UNAVAILABLE is fatal, the rest recoverable.
 * An engine invariant trap reaches the catches as a WebAssembly.RuntimeError
 * over a torn-down module, which onTrap turns fatal.
 */
export function buildChainMesh(base, ops, ctx) {
  let mesh;
  try {
    mesh = requireMeshResult(ctx.meshOps.fromSolidName(base), `Base solid "${base}"`, ctx);
    if (!mesh) return null;
  } catch (e) {
    console.error('Error creating base solid:', e);
    if (!ctx.onTrap(e)) ctx.onError(`Base solid "${base}" failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  let failing = null;
  try {
    for (const o of ops) {
      failing = typeof o === 'string' ? o : o.op;
      const nextMesh = applyOp(mesh, o);
      mesh.delete();
      mesh = nextMesh;
    }
  } catch (e) {
    console.error('WASM Op Error:', e);
    if (ctx.onTrap(e)) return null;
    // Read before the flush overwrites the recorded reason. `mesh` is the last
    // valid op result: the failing op threw before the swap.
    const failure = meshOpFailure(ctx.Mod, `Op "${failing}"`);
    if (mesh) mesh.delete();
    ctx.meshOps.clearToolingMemory();
    if (failure.reason === 'OK' || failure.reason === 'UNKNOWN') {
      ctx.onError(`Op error: ${e instanceof Error && e.message ? e.message : String(e)}`);
    } else if (failure.fatal) {
      ctx.onFatal(failure.message);
    } else {
      ctx.onError(failure.message);
    }
    return null;
  }

  // Face classes are a JS-owned copy valid after mesh deletion and arena flushing.
  let faceClasses = null;
  let classifyFailure = null;
  try {
    faceClasses = mesh.classifyFaces();
    if (!faceClasses) {
      classifyFailure = meshOpFailure(ctx.Mod, 'Face classification').message;
    }
  } catch (e) {
    console.error('WASM classifyFaces error:', e);
    if (ctx.onTrap(e)) return null;
    classifyFailure = `Face classification failed: ${
      e instanceof Error && e.message ? e.message : String(e)}`;
  }

  let meshData;
  try {
    meshData = readbackMesh(mesh, ctx);
  } catch (e) {
    console.error('WASM readback error:', e);
    if (ctx.onTrap(e)) return null;
    mesh.delete();
    ctx.meshOps.clearToolingMemory();
    ctx.onError(`Mesh readback failed: ${
      e instanceof Error && e.message ? e.message : String(e)}`);
    return null;
  }
  mesh.delete();
  ctx.meshOps.clearToolingMemory();
  // readbackMesh already reported a rejected readback.
  if (!meshData) return null;

  return { meshData, faceClasses, classifyFailure };
}
