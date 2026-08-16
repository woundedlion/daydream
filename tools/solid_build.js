/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * The solids tool's WASM MeshOps orchestration (tools/solids.html): building a
 * mesh from a base solid and an op chain, classifying its faces, reading it back
 * into JS, and freeing the tooling arenas.
 *
 * MeshOps answers a recoverable failure with null and records the reason in
 * getLastResult(); an unchecked null becomes a TypeError several calls later, or
 * a mesh built from the wrong wrapper. Every call in these sequences is routed
 * through requireMeshResult so the reason is read before the next call
 * overwrites it. The module instance, the vertex constructor and the error line
 * are injected, so the sequences run against a stand-in without a DOM.
 */

import { applyOp, meshOpFailure, requireMeshResult } from './solid_codegen.js';

/** @typedef {import('./solid_codegen.js').ChainOp} ChainOp */
/** @typedef {import('./solid_codegen.js').MeshWrapper} MeshWrapper */
/** @typedef {import('./solid_codegen.js').WasmModule} WasmModule */

/**
 * A mesh vertex, as much of THREE.Vector3's shape as the page's readers need.
 * @typedef {Object<string, any>} Vertex
 */

/**
 * @typedef {{vertices: Vertex[], faces: Array<Array<number>>}} SolidMeshData
 */

/**
 * The live wiring one build runs against. Read per call: an engine trap nulls
 * the page's module handles, so a context outlives at most one build.
 * @typedef {object} MeshBuildContext
 * @property {WasmModule} Mod - The WASM module instance.
 * @property {{fromSolidName: (name: string) => MeshWrapper?, clearToolingMemory: () => void}} meshOps - Its MeshOps binding.
 * @property {(x: number, y: number, z: number) => Vertex} vector - Builds one vertex.
 * @property {(message: string) => void} onError - Surfaces a failure to the user.
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
 * @details A wrapper held across a clearToolingMemory() aliases reclaimed arena
 * storage, so the bridge refuses it (STALE_WRAPPER). A NaN component is a
 * rejected readback the bridge reports as a success, so it is refused here
 * rather than passed on to save and export.
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
 * Builds one registered solid and reads it back, freeing the wrapper and the
 * tooling arenas either way.
 * @param {string} name - Registry name of the solid.
 * @param {string} what - What the caller was building, used in a failure message.
 * @param {MeshBuildContext} ctx - The live wiring.
 * @returns {SolidMeshData?} The copy, or null when the build or the readback was refused.
 */
export function buildBaseMesh(name, what, ctx) {
  const wasmMesh = requireMeshResult(ctx.meshOps.fromSolidName(name), what, ctx);
  if (!wasmMesh) return null;
  const meshData = readbackMesh(wasmMesh, ctx);
  wasmMesh.delete();
  ctx.meshOps.clearToolingMemory();
  return meshData;
}

/**
 * Builds a base solid, applies an op chain to it, classifies its faces and reads
 * the result back, freeing the wrapper and the 16 MB tooling arenas on the way
 * out of every path.
 * @param {string} base - Registry name of the base solid.
 * @param {ChainOp[]} ops - Ops to apply, in order.
 * @param {MeshBuildContext} ctx - The live wiring.
 * @returns {SolidBuildResult?} What to draw, or null when there is nothing to draw.
 * @details Every failure the bridge foresees — unknown solid name, tooling arena
 * exhaustion, 16-bit connectivity or face-degree overflow, a non-finite or
 * out-of-domain argument — is a null with the reason in getLastResult(), which
 * requireMeshResult reports. An engine invariant trap is not recoverable: the
 * module is built with exceptions disabled, so it aborts and reaches the catches
 * as a WebAssembly.RuntimeError over a torn-down module, which onTrap turns
 * fatal. What is left for the catches is Embind marshalling errors.
 */
export function buildChainMesh(base, ops, ctx) {
  let mesh;
  try {
    mesh = requireMeshResult(ctx.meshOps.fromSolidName(base), `Base solid "${base}"`, ctx);
    if (!mesh) return null;
  } catch (e) {
    console.error('Error creating base solid:', e);
    ctx.onTrap(e);
    return null;
  }

  try {
    for (const o of ops) {
      const nextMesh = applyOp(mesh, o);
      mesh.delete();
      mesh = nextMesh;
    }
  } catch (e) {
    console.error('WASM Op Error:', e);
    if (ctx.onTrap(e)) return null;
    // A mid-chain op failed: the partial mesh is meaningless, so report and draw
    // nothing rather than a half-applied solid with wrong stats. `mesh` still
    // points at the last valid op result (the failing op threw before the swap),
    // so it is safe to free.
    if (mesh) mesh.delete();
    ctx.meshOps.clearToolingMemory();
    ctx.onError(`Op error: ${e instanceof Error && e.message ? e.message : String(e)}`);
    return null;
  }

  // Per-face topology class ids for the Colorize Faces toggle. Runs engine-side
  // (it reuses the tooling scratch arenas, which are free between ops); the
  // returned Int32Array is a fresh JS copy, so it stays valid after the wrapper
  // is deleted and the arenas are flushed below. Colorize-only data: a null
  // leaves the render intact, and the arena remedy is the flush below, once the
  // mesh is read out — so the reason is carried out to be reported after the
  // draw, which rewrites the line it shares.
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
  }

  const meshData = readbackMesh(mesh, ctx);
  mesh.delete();
  ctx.meshOps.clearToolingMemory();
  // A rejected readback leaves no geometry to draw; readbackMesh already
  // reported it, so draw nothing rather than clearing the last good mesh.
  if (!meshData) return null;

  return { meshData, faceClasses, classifyFailure };
}
