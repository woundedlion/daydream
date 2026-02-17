/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { wrap } from "./util.js";
import { Daydream } from "./driver.js";
import { vectorPool, quaternionPool } from "./memory.js";
import { TWO_PI } from "./3dmath.js";

// Removed mobiusTransform and gnomonicMobiusTransform

import { KDTree } from "./spatial.js";

const _tempSpherical = new THREE.Spherical();
const _tempVec = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
const _tempN = new THREE.Vector3();
const _tempC = new THREE.Vector3();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();

// Removed Dot class

/**
 * Converts a pixel y-coordinate to a spherical phi angle.
 * @param {number} y - The pixel y-coordinate [0, Daydream.H - 1].
 * @returns {number} The spherical phi angle in radians.
 */
export const yToPhi = (y) => {
  return (y * Math.PI) / (Daydream.H - 1);
}

/**
 * Converts a spherical phi angle to a pixel y-coordinate.
 * @param {number} phi - The spherical phi angle in radians.
 * @returns {number} The pixel y-coordinate [0, Daydream.H - 1].
 */
export const phiToY = (phi) => {
  return (phi * (Daydream.H - 1)) / Math.PI;
}



/**
 * Converts 2D pixel coordinates to spherical coordinates on a unit sphere.
 * @param {number} x - The pixel x-coordinate [0, Daydream.W - 1].
 * @param {number} y - The pixel y-coordinate [0, Daydream.H - 1].
 * @returns {THREE.Spherical} The spherical coordinates (radius is 1).
 */
export const pixelToSpherical = (x, y) => {
  return new THREE.Spherical(
    1,
    yToPhi(y),
    (x * TWO_PI) / Daydream.W
  );
};

const _tempPixel = { x: 0, y: 0 };

/**
 * Converts a 3D vector (normalized) to 2D pixel coordinates.
 * @param {THREE.Vector3} v - The vector (position on unit sphere).
 * @returns {{x: number, y: number}} The pixel coordinates (x is wrapped).
 */
export const vectorToPixel = (v) => {
  _tempSpherical.setFromVector3(v);
  _tempPixel.x = wrap((_tempSpherical.theta * Daydream.W) / TWO_PI, Daydream.W);
  _tempPixel.y = (_tempSpherical.phi * (Daydream.H - 1)) / Math.PI;
  return _tempPixel;
};

/**
 * Converts 2D pixel coordinates to a 3D vector (position on unit sphere).
 * @param {number} x - The pixel x-coordinate.
 * @param {number} y - The pixel y-coordinate.
 * @returns {THREE.Vector3} The normalized 3D vector.
 */
export const pixelToVector = (x, y) => {
  const v = vectorPool.acquire();
  _tempSpherical.set(
    1,
    (y * Math.PI) / (Daydream.H - 1),
    (x * TWO_PI) / Daydream.W
  );
  v.setFromSpherical(_tempSpherical);
  return v;
};

// Removed large block of unused math functions (logPolarToVector, fibSpiral, waves, gradients, intersection)




/**
 * Vertex in a Half-Edge data structure.
 * Stores position and a reference to one outgoing half-edge.
 */
export class HEVertex {
  constructor(position) {
    this.position = position;
    this.halfEdge = null; // Reference to one outgoing HalfEdge
  }
}

/**
 * Simple 32-bit integer hash mixer.
 */
function hash32(n, seed = 0) {
  n = Math.imul(n ^ seed, 0x5bd1e995);
  n ^= n >>> 15;
  return Math.imul(n, 0x97455bcd);
}

/**
 * Face in a Half-Edge data structure.
 * Stores a reference to one of the half-edges bordering this face.
 */
export class HEFace {
  constructor() {
    this.halfEdge = null;
    this.vertexCount = 0;
    this.intrinsicHash = 0;
  }

  computeProperties() {
    let he = this.halfEdge;
    if (!he) return;
    const start = he;

    // Collect vertices
    const verts = [];
    let safety = 0;
    do {
      verts.push(he.vertex.position);
      he = he.next;
      safety++;
    } while (he !== start && he && safety < 100);

    this.vertexCount = verts.length;

    // Calculate Angles
    const angles = [];
    if (this.vertexCount < 3) {
      this.intrinsicHash = 0;
      return;
    }

    for (let i = 0; i < this.vertexCount; i++) {
      const prev = verts[(i - 1 + this.vertexCount) % this.vertexCount];
      const curr = verts[i];
      const next = verts[(i + 1) % this.vertexCount];

      const v1 = _tempVec.subVectors(prev, curr).normalize();
      const v2 = _tempVec2.subVectors(next, curr).normalize();

      let angle = v1.angleTo(v2);
      angles.push(Math.round(angle * (180 / Math.PI)));
    }

    // Compute Intrinsic Hash
    // 1. Hash Vertex Count
    let h = hash32(this.vertexCount, 0x12345678);

    // 2. Hash Angles (Sorted for rotation invariance)
    angles.sort((a, b) => a - b);

    for (const angle of angles) {
      h = hash32(angle, h);
    }
    this.intrinsicHash = h;
  }



  getVertexCount() {
    let count = 0;
    let he = this.halfEdge;
    if (!he) return 0;
    const start = he;
    let safety = 0;
    do {
      count++;
      he = he.next;
      safety++;
    } while (he !== start && he && safety < 100);
    return count;
  }

  getNeighbors() {
    const neighbors = [];
    let he = this.halfEdge;
    if (!he) return neighbors;
    const start = he;
    let safety = 0;
    do {
      if (he.pair && he.pair.face) {
        neighbors.push(he.pair.face);
      } else {
        neighbors.push(null); // Boundary or incomplete mesh
      }
      he = he.next;
      safety++;
    } while (he !== start && he && safety < 100);
    return neighbors;
  }
}

/**
 * Half-Edge structure.
 * Directed edge comprising half of a full edge.
 */
export class HalfEdge {
  constructor() {
    this.vertex = null; // Vertex at the END of this half-edge (destination)
    this.pair = null;   // Oppositely oriented half-edge
    this.face = null;   // Face this half-edge borders
    this.next = null;   // Next half-edge around the face
    this.prev = null;   // Previous half-edge around the face
  }
}

/**
 * Half-Edge Mesh data structure.
 * Constructed from a standard PolyMesh (vertices + faces array).
 */
export class HalfEdgeMesh {
  constructor(polyMesh) {
    this.vertices = [];
    this.faces = [];
    this.halfEdges = [];

    // 1. Create Vertices
    for (const v of polyMesh.vertices) {
      this.vertices.push(new HEVertex(v));
    }

    const edgeMap = new Map(); // "start,end" -> HalfEdge

    // 2. Create Faces and HalfEdges
    for (const faceIndices of polyMesh.faces) {
      const face = new HEFace();
      this.faces.push(face);

      const faceEdges = [];

      for (let i = 0; i < faceIndices.length; i++) {
        const startIdx = faceIndices[i];
        const endIdx = faceIndices[(i + 1) % faceIndices.length];

        const he = new HalfEdge();
        this.halfEdges.push(he);
        faceEdges.push(he);

        he.vertex = this.vertices[endIdx];
        he.face = face;

        if (!this.vertices[startIdx].halfEdge) {
          this.vertices[startIdx].halfEdge = he;
        }

        edgeMap.set(`${startIdx},${endIdx}`, he);
      }

      // Link Next/Prev
      for (let i = 0; i < faceEdges.length; i++) {
        const he = faceEdges[i];
        he.next = faceEdges[(i + 1) % faceEdges.length];
        he.prev = faceEdges[(i - 1 + faceEdges.length) % faceEdges.length];
      }

      face.halfEdge = faceEdges[0];
    }

    // 3. Link Pairs
    for (const [key, he] of edgeMap) {
      const [start, end] = key.split(',').map(Number);
      const pairHe = edgeMap.get(`${end},${start}`);
      if (pairHe) he.pair = pairHe;
    }

    // 4. Compute Properties (Hashes, Counts)
    for (const face of this.faces) {
      face.computeProperties();
    }
  }

  /**
   * Converts the Half-Edge mesh back to a standard polygon mesh.
   * @returns {{vertices: THREE.Vector3[], faces: number[][]}}
   */
  toPolyMesh() {
    const vertices = this.vertices.map(v => v.position.clone());
    const vIndexMap = new Map(this.vertices.map((v, i) => [v, i]));

    const faces = [];
    for (const face of this.faces) {
      const faceIndices = [];
      let he = face.halfEdge;
      // Guard against broken meshes
      if (!he) continue;

      const startHe = he;
      do {
        faceIndices.push(vIndexMap.get(he.vertex));
        he = he.next;
      } while (he !== startHe && he !== null);
      faces.push(faceIndices);
    }

    return { vertices, faces };
  }
}

/**
 * Procedural mesh operations.
 */
export const MeshOps = {
  /**
     * Colors faces based on their vertex count and the sorted vertex counts of their neighbors.
     * Useful for visualizing topological symmetry (e.g., distinguishing face types).
     * @param {Object} mesh - {vertices, faces}
     * @returns {Object} { faceColorIndices: Int32Array, uniqueCount: number }
     */
  classifyFacesByTopology(mesh) {
    const heMesh = new HalfEdgeMesh(mesh);

    const signatureToID = new Map();
    const faceColorIndices = new Int32Array(heMesh.faces.length);
    let nextID = 0;

    heMesh.faces.forEach((face, i) => {
      let neighborAcc = 0;
      const neighbors = face.getNeighbors();

      for (const n of neighbors) {
        if (n) {
          // Use simple addition for order-independence without XOR cancellation
          // We re-hash the intrinsic hash to scatter bits before adding
          neighborAcc = (neighborAcc + hash32(n.intrinsicHash)) | 0;
        }
      }

      // Combine Self + Neighbors
      const finalHash = hash32(neighborAcc, face.intrinsicHash);

      if (!signatureToID.has(finalHash)) {
        signatureToID.set(finalHash, nextID++);
      }
      faceColorIndices[i] = signatureToID.get(finalHash);
    });

    return { faceColorIndices, uniqueCount: nextID };
  },

  /**
   * Computes the KDTree and Adjacency Map for a mesh.
   * Stores the result in mesh.kdTree.
   * @param {Object} mesh - {vertices, faces}
   */
  computeKdTree(mesh) {
    if (mesh.kdTree) return;

    // Adjacency map
    const adjacency = new Array(mesh.vertices.length).fill(null).map(() => []);

    // Find edges
    for (const face of mesh.faces) {
      for (let i = 0; i < face.length; i++) {
        const idxA = face[i];
        const idxB = face[(i + 1) % face.length];

        // Add B to A's list
        if (!adjacency[idxA].includes(idxB)) adjacency[idxA].push(idxB);
        // Add A to B's list
        if (!adjacency[idxB].includes(idxA)) adjacency[idxB].push(idxA);
      }
    }

    // Format points
    const points = mesh.vertices.map((v, i) => ({ pos: v, index: i }));

    // Build Tree
    const tree = new KDTree(points);

    mesh.kdTree = {
      tree,
      adjacency
    };
  },

  /**
   * Finds the closest point on the mesh "wireframe" (vertices and edges) to a target point.
   * Assumes all points are on a unit sphere.
   * @param {THREE.Vector3} p - Target point (normalized)
   * @param {Object} mesh - {vertices, faces}
   * @returns {THREE.Vector3} Closest point on the edges/vertices of the mesh
   */
  closestPointOnMeshGraph(p, mesh) {
    // Ensure KDTree
    if (!mesh.kdTree) {
      this.computeKdTree(mesh);
    }

    const { tree, adjacency } = mesh.kdTree;

    // Closest vertex
    const nearestNodes = tree.nearest(p, 1);
    if (!nearestNodes.length) return mesh.vertices[0].clone();

    const closestVertexNode = nearestNodes[0]; // This is the object { pos, index }
    const closestVertexIndex = closestVertexNode.index;
    const closestVertexPos = closestVertexNode.pos;

    let bestPoint = closestVertexPos.clone();
    let maxDot = p.dot(bestPoint);

    // Check connected edges
    // adjacency[i] contains indices of neighbors.
    // Each neighbor forms an edge (closestVertexIndex, neighborIndex).

    const neighbors = adjacency[closestVertexIndex];
    if (!neighbors) return bestPoint; // Should not happen for valid mesh

    const tempN = new THREE.Vector3();
    const tempC = new THREE.Vector3();
    const vA = new THREE.Vector3();
    const vB = new THREE.Vector3();

    const A = closestVertexPos;

    for (const neighborIdx of neighbors) {
      const B = mesh.vertices[neighborIdx];

      // Great circle normal
      tempN.crossVectors(A, B);
      const lenSq = tempN.lengthSq();
      if (lenSq < 0.000001) continue; // Degenerate edge
      tempN.multiplyScalar(1.0 / Math.sqrt(lenSq)); // Normalize

      // Project P
      const pDotN = p.dot(tempN);
      tempC.copy(p).addScaledVector(tempN, -pDotN); // P_proj

      // Normalize
      tempC.normalize();

      // Arc check
      const crossAC = vA.crossVectors(A, tempC);
      const crossCB = vB.crossVectors(tempC, B);

      if (crossAC.dot(tempN) > 0 && crossCB.dot(tempN) > 0) {
        const d = p.dot(tempC);
        if (d > maxDot) {
          maxDot = d;
          bestPoint.copy(tempC);
        }
      }
    }

    return bestPoint; // already cloned or copied
  },

  /**
   * Computes the dual of a mesh.
   * New vertices are face centroids; new faces are vertex cycles.
   * @param {Object} mesh - input mesh {vertices, faces}
   * @return {Object} dual mesh
   */
  dual(mesh) {
    const heMesh = new HalfEdgeMesh(mesh);
    const newVertices = [];
    const faceToVertIdx = new Map();

    // New vertices
    for (const face of heMesh.faces) {
      const c = new THREE.Vector3();
      let count = 0;
      let he = face.halfEdge;
      const start = he;
      do {
        c.add(he.vertex.position);
        count++;
        he = he.next;
      } while (he !== start);
      c.multiplyScalar(1.0 / count);

      const idx = newVertices.push(c) - 1;
      faceToVertIdx.set(face, idx);
    }

    const newFaces = [];

    // New faces
    const visitedVerts = new Set();

    for (const heStart of heMesh.halfEdges) {
      // Use prev for robustness
      const origin = heStart.prev.vertex;
      if (visitedVerts.has(origin)) continue;
      visitedVerts.add(origin);

      const faceIndices = [];
      let curr = heStart;
      const startOrbit = curr;
      let safety = 0;
      do {
        // Face centroid index
        const faceIdx = faceToVertIdx.get(curr.face);
        faceIndices.push(faceIdx);

        // Next face
        if (!curr.pair) break;
        curr = curr.pair.next;
        safety++;
      } while (curr !== startOrbit && curr && safety < 100);

      if (faceIndices.length > 2) {
        // The traversal `curr = curr.pair.next` moves from an incoming half-edge to the next outgoing half-edge
        // on the same vertex. In a standard CCW face mesh, this circulates Clockwise (CW) around the vertex.
        // Therefore, we must reverse the indices to produce a Counter-Clockwise (CCW) face for the dual.
        newFaces.push(faceIndices.reverse());
      }
    }

    newVertices.forEach(v => v.normalize());
    return { vertices: newVertices, faces: newFaces };
  },

  /**
   * Compiles the topological structure of a Hankin pattern.
   * Returns a "CompiledHankin" object that can be updated rapidly.
   */
  compileHankin(mesh) {
    const heMesh = new HalfEdgeMesh(mesh);
    const staticVertices = []; // Midpoints (don't move)
    const dynamicVertices = []; // Intersections (move with angle)
    const faces = [];

    const heToMidpointIdx = new Map();
    const heToDynamicIdx = new Map(); // Maps he -> index in dynamicVertices array

    // Static vertices
    const getMidpointIdx = (he) => {
      if (heToMidpointIdx.has(he)) return heToMidpointIdx.get(he);
      if (he.pair && heToMidpointIdx.has(he.pair)) return heToMidpointIdx.get(he.pair);

      const pA = he.prev ? he.prev.vertex.position : he.pair.vertex.position;
      const pB = he.vertex.position;
      const mid = pA.clone().add(pB).multiplyScalar(0.5).normalize();

      const idx = staticVertices.push(mid) - 1;
      heToMidpointIdx.set(he, idx);
      if (he.pair) heToMidpointIdx.set(he.pair, idx);
      return idx;
    };

    // Ensure midpoints
    for (const he of heMesh.halfEdges) {
      getMidpointIdx(he);
    }

    // Lock the offset
    const staticOffset = staticVertices.length;

    // Dynamic instructions
    const dynamicInstructions = [];

    // Star faces
    for (const face of heMesh.faces) {
      const starFaceIndices = [];
      let he = face.halfEdge;
      const startHe = he;

      do {
        const prev = he.prev;
        const curr = he;

        // Static Indices
        const idxM1 = getMidpointIdx(prev);
        const idxM2 = getMidpointIdx(curr);

        // Define Dynamic Vertex
        const pCorner = prev.vertex.position.clone();
        const pPrev = (prev.prev ? prev.prev.vertex.position : prev.pair.vertex.position).clone();
        const pNext = curr.vertex.position.clone();

        dynamicInstructions.push({
          pCorner, pPrev, pNext,
          idxM1, idxM2 // Indices into staticVertices
        });

        // This dynamic vertex corresponds to the current edge
        const dynIdx = dynamicVertices.length; // Will be added
        heToDynamicIdx.set(curr, dynIdx);
        dynamicVertices.push(new THREE.Vector3()); // Placeholder

        starFaceIndices.push(idxM1);
        starFaceIndices.push(staticOffset + dynIdx);

        he = he.next;
      } while (he !== startHe);
      faces.push(starFaceIndices);
    }

    // Rosette faces
    const visitedVerts = new Set();
    for (const heStart of heMesh.halfEdges) {
      const origin = heStart.prev.vertex;
      if (visitedVerts.has(origin)) continue;
      visitedVerts.add(origin);

      const rosetteIndices = [];
      let curr = heStart;
      const startOrbit = curr;
      let safety = 0;
      do {
        rosetteIndices.push(heToMidpointIdx.get(curr)); // Static
        const nextEdge = curr.pair ? curr.pair.next : null;
        if (!nextEdge) break;
        rosetteIndices.push(staticOffset + heToDynamicIdx.get(nextEdge)); // Dynamic
        curr = nextEdge;
        safety++;
      } while (curr !== startOrbit && curr && safety < 100);

      if (rosetteIndices.length > 2) {
        rosetteIndices.reverse(); // Fix inward normals
        faces.push(rosetteIndices);
      }
    }

    return {
      staticVertices,
      dynamicVertices, // Placeholders
      dynamicInstructions,
      faces, // Topology
      staticOffset // Exported for debugging/completeness
    };
  },

  /**
   * Updates a compiled Hankin mesh based on the angle.
   * Zero allocation.
   */
  updateHankin(compiled, angle) {
    const { staticVertices, dynamicVertices, dynamicInstructions } = compiled;

    const q1 = quaternionPool.acquire();
    const q2 = quaternionPool.acquire();
    const nEdge1 = vectorPool.acquire();
    const nEdge2 = vectorPool.acquire();
    const nHankin1 = vectorPool.acquire();
    const nHankin2 = vectorPool.acquire();
    const intersect = vectorPool.acquire();
    const ref = vectorPool.acquire();

    for (let i = 0; i < dynamicInstructions.length; i++) {
      const instr = dynamicInstructions[i];
      const m1 = staticVertices[instr.idxM1];
      const m2 = staticVertices[instr.idxM2];

      // Normals
      nEdge1.crossVectors(instr.pPrev, instr.pCorner).normalize();
      q1.setFromAxisAngle(m1, angle);
      nHankin1.copy(nEdge1).applyQuaternion(q1);

      nEdge2.crossVectors(instr.pCorner, instr.pNext).normalize();
      q2.setFromAxisAngle(m2, -angle);
      nHankin2.copy(nEdge2).applyQuaternion(q2);

      // Intersection
      intersect.crossVectors(nHankin1, nHankin2);

      // Chirality
      // Use pCorner as the reference. The Hankin vertex starts at pCorner (angle 0)
      // and moves towards the face center. It should always remain in the same hemisphere as pCorner.
      if (intersect.dot(instr.pCorner) < 0) intersect.negate();

      dynamicVertices[i].copy(intersect).normalize();
    }

    // Return mesh
    return {
      vertices: [...staticVertices, ...dynamicVertices],
      faces: compiled.faces
    };
  },

  /**
  /**
   * Returns the topological structure of a Hankin pattern.
   */
  hankin(mesh, angle) {
    const compiled = this.compileHankin(mesh);
    return this.updateHankin(compiled, angle);
  },

  // --- CONWAY OPERATORS ---

  /**
   * Deep clones a mesh.
   * @param {Object} mesh - {vertices, faces}
   * @returns {Object} new mesh
   */
  clone(mesh) {
    return {
      vertices: mesh.vertices.map(v => v.clone()),
      faces: mesh.faces.map(f => [...f])
    };
  },

  /**
   * Normalizes all vertices in the mesh to the unit sphere.
   * @param {Object} mesh - {vertices, faces}
   */
  normalize(mesh) {
    mesh.vertices.forEach(v => v.normalize());
  },

  /**
   * Kis operator: Raises a pyramid on each face.
   * @param {Object} mesh - input mesh
   * @returns {Object} new mesh
   */
  kis(mesh) {
    const newVerts = [...mesh.vertices];
    const newFaces = [];

    mesh.faces.forEach(f => {
      // Add centroid
      const centroid = new THREE.Vector3();
      f.forEach(vi => centroid.add(mesh.vertices[vi]));
      centroid.divideScalar(f.length);
      newVerts.push(centroid);
      const centerIdx = newVerts.length - 1;

      // Create triangles
      for (let i = 0; i < f.length; i++) {
        const vi = f[i];
        const vj = f[(i + 1) % f.length];
        newFaces.push([vi, vj, centerIdx]);
      }
    });

    this.normalize({ vertices: newVerts, faces: newFaces });
    return { vertices: newVerts, faces: newFaces };
  },

  /**
   * Ambo operator: Truncates vertices to edge midpoints.
   * @param {Object} mesh - input mesh
   * @returns {Object} new mesh
   */
  ambo(mesh) {
    const newVerts = [];
    const newFaces = [];
    const edgeMap = new Map();

    // 1. Create vertices at edge midpoints
    mesh.faces.forEach(f => {
      for (let i = 0; i < f.length; i++) {
        const vi = f[i];
        const vj = f[(i + 1) % f.length];
        const key = vi < vj ? `${vi}_${vj}` : `${vj}_${vi}`;
        if (!edgeMap.has(key)) {
          const v1 = mesh.vertices[vi];
          const v2 = mesh.vertices[vj];
          const mid = new THREE.Vector3().addVectors(v1, v2).multiplyScalar(0.5);
          newVerts.push(mid);
          edgeMap.set(key, newVerts.length - 1);
        }
      }
    });

    // 2. Create faces
    // A. Shrink old faces
    mesh.faces.forEach(f => {
      const faceVerts = [];
      for (let i = 0; i < f.length; i++) {
        const vi = f[i];
        const vj = f[(i + 1) % f.length];
        const key = vi < vj ? `${vi}_${vj}` : `${vj}_${vi}`;
        faceVerts.push(edgeMap.get(key));
      }
      newFaces.push(faceVerts);
    });

    // B. Create new faces at old vertices
    const edgeToFaces = {};
    mesh.faces.forEach((f, fi) => {
      f.forEach((vi, i) => {
        const vj = f[(i + 1) % f.length];
        const key = [vi, vj].sort((a, b) => a - b).join('_');
        if (!edgeToFaces[key]) edgeToFaces[key] = [];
        edgeToFaces[key].push(fi);
      });
    });

    mesh.vertices.forEach((v, vi) => {
      const neighborMids = [];
      // Walk around vi
      const startFaceIdx = mesh.faces.findIndex(f => f.includes(vi));
      if (startFaceIdx === -1) return;

      let currFaceIdx = startFaceIdx;
      let safety = 0;
      do {
        const face = mesh.faces[currFaceIdx];
        const idxInFace = face.indexOf(vi);
        const nextVi = face[(idxInFace + 1) % face.length]; // edge vi -> nextVi

        // Get midpoint index for this edge
        const key = vi < nextVi ? `${vi}_${nextVi}` : `${nextVi}_${vi}`;
        neighborMids.push(edgeMap.get(key));

        const prevFaceKey = [vi, nextVi].sort((a, b) => a - b).join('_');
        const adjFaces = edgeToFaces[prevFaceKey];
        if (!adjFaces) break;

        const nextFaceIdx = adjFaces.find(id => id !== currFaceIdx);
        if (nextFaceIdx === undefined) break;

        currFaceIdx = nextFaceIdx;
        safety++;
      } while (currFaceIdx !== startFaceIdx && safety < 20);

      if (neighborMids.length >= 3) {
        // Reversing is required because the traversal around the vertex follows the
        // half-edge "next" pointers, which typically wind Clockwise around the vertex
        // for a CCW mesh.
        newFaces.push(neighborMids.reverse());
      }
    });

    this.normalize({ vertices: newVerts, faces: newFaces });
    return { vertices: newVerts, faces: newFaces };
  },

  /**
   * Expand operator: Separates faces (e = aa).
   * @param {Object} mesh 
   * @param {number} t - Expansion factor. Default 2-sqrt(2) ~= 0.5857.
   * @returns {Object}
   */
  expand(mesh, t = 2.0 - Math.sqrt(2.0)) {
    const newVerts = [];
    const insetFaces = [];
    const edgeFaces = [];
    const vertexFaces = [];

    // Helper: Map (faceIdx, vertIdxInFace) -> newVertexIdx
    const faceVertsMap = [];

    // 1. Inset Faces
    mesh.faces.forEach((f, fi) => {
      const centroid = new THREE.Vector3();
      f.forEach(vi => centroid.add(mesh.vertices[vi]));
      centroid.divideScalar(f.length);

      const fIndices = [];
      f.forEach((vi, i) => {
        const v = mesh.vertices[vi];
        // Move vertex towards centroid
        const newV = new THREE.Vector3().copy(v).lerp(centroid, t);
        newVerts.push(newV);
        fIndices.push(newVerts.length - 1);
      });
      faceVertsMap[fi] = fIndices;
      insetFaces.push(fIndices);
    });

    // 2. Edge Faces (Quads)
    // Find edges
    const edgeMap = new Map(); // key -> [faceIdx, index_of_edge_start_in_face]

    mesh.faces.forEach((f, fi) => {
      f.forEach((u, i) => {
        const v = f[(i + 1) % f.length];
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, []);
        }
        edgeMap.get(key).push({ fi, i, u, v });
      });
    });

    for (const [key, entries] of edgeMap) {
      if (entries.length !== 2) continue; // Boundary or non-manifold
      // Entry 1: Face A, edge u->v
      const e1 = entries[0];
      // Entry 2: Face B, edge v->u (if consistent winding)
      const e2 = entries[1];

      // Vertices in Face A corresponding to u, v
      // faceVertsMap[fi] matches order of mesh.faces[fi]
      const A_u_idx = faceVertsMap[e1.fi][e1.i];
      const A_v_idx = faceVertsMap[e1.fi][(e1.i + 1) % mesh.faces[e1.fi].length];

      // Vertices in Face B corresponding to u, v
      // We need indices of u and v in Face B
      const idx_v_in_B = mesh.faces[e2.fi].indexOf(e1.v);
      const idx_u_in_B = mesh.faces[e2.fi].indexOf(e1.u); // Usually next one

      const B_v_idx = faceVertsMap[e2.fi][idx_v_in_B];
      const B_u_idx = faceVertsMap[e2.fi][idx_u_in_B];

      // Create Quad: A_v -> A_u -> B_u -> B_v
      // Reversing winding order to ensuring outward normals
      edgeFaces.push([A_v_idx, A_u_idx, B_u_idx, B_v_idx]);
    }

    // 3. Vertex Faces
    const vertToFaces = new Array(mesh.vertices.length).fill(null).map(() => []);
    mesh.faces.forEach((f, fi) => {
      f.forEach(vi => vertToFaces[vi].push(fi));
    });

    // Sort faces around vertex for proper winding
    // We can rely on Edge Map or reconstruct cycle.
    // Simpler: Use existing edgeToFaces logic or just "walk"

    const edgeToFacesLookup = {};
    mesh.faces.forEach((f, fi) => {
      f.forEach((u, i) => {
        const v = f[(i + 1) % f.length];
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        if (!edgeToFacesLookup[key]) edgeToFacesLookup[key] = [];
        edgeToFacesLookup[key].push(fi);
      });
    });

    mesh.vertices.forEach((v, vi) => {
      const adjacentFaces = vertToFaces[vi];
      if (adjacentFaces.length < 3) return;

      // Walk around the vertex
      const orderedIndices = [];
      let startFace = adjacentFaces[0];
      let currFace = startFace;
      let safety = 0;

      do {
        // Find the vertex in this face corresponding to 'vi'
        const idxInFace = mesh.faces[currFace].indexOf(vi);
        // The vertex created for 'vi' in this face
        orderedIndices.push(faceVertsMap[currFace][idxInFace]);

        // Find previous edge entering vi: prev -> vi
        const fLen = mesh.faces[currFace].length;
        const prevVi = mesh.faces[currFace][(idxInFace - 1 + fLen) % fLen];

        // Find the face across this edge
        const key = prevVi < vi ? `${prevVi}_${vi}` : `${vi}_${prevVi}`;
        const neighbors = edgeToFacesLookup[key];
        const nextFace = neighbors.find(fid => fid !== currFace);

        if (nextFace === undefined) break;
        currFace = nextFace;
        safety++;
      } while (currFace !== startFace && safety < 20);

      vertexFaces.push(orderedIndices);
    });

    // Collect faces in order: Inset (Originals), Vertex (Corners), Edge (Connectors)
    const newFaces = [...insetFaces, ...vertexFaces, ...edgeFaces];

    this.normalize({ vertices: newVerts, faces: newFaces });
    return { vertices: newVerts, faces: newFaces };
  },

  /**
   * Snub operator: Creates a chiral semi-regular polyhedron.
   * Expands faces, twists them, and inserts triangles.
   * @param {Object} mesh 
   * @param {number} t - Expansion factor. Default 0.5.
   * @param {number} twist - Twist angle in radians. Default 0.
   * @returns {Object}
   */
  snub(mesh, t = 0.5, twist = 0) {
    const newVerts = [];
    const newFaces = [];

    // 1. Create new vertices (n per face)
    // Structure: newVertsMap[faceIndex][vertIndexInFace] = globalIndex
    const newVertsMap = new Array(mesh.faces.length).fill(null).map(() => []);

    mesh.faces.forEach((f, fi) => {
      // Calculate face centroid
      const centroid = new THREE.Vector3();
      f.forEach(vi => centroid.add(mesh.vertices[vi]));
      centroid.divideScalar(f.length);

      // Calculate Face Normal (assuming planar/semi-planar)
      // Use average normal or just tri
      const v0 = mesh.vertices[f[0]];
      const v1 = mesh.vertices[f[1]];
      const v2 = mesh.vertices[f[2]];
      const ab = new THREE.Vector3().subVectors(v1, v0);
      const ac = new THREE.Vector3().subVectors(v2, v0);
      const normal = new THREE.Vector3().crossVectors(ab, ac).normalize();

      // Robust normal? If f > 3, this is approx. But for canonical it's fine.
      // Better: Newell's method? Or just normalized centroid (for spherical solids center=0)
      // If solid is centered at 0, centroid is the normal direction!
      // This is much robust for convex solids.
      if (centroid.lengthSq() > 1e-6) {
        normal.copy(centroid).normalize();
      }

      f.forEach((vi, i) => {
        // Create new vertex towards centroid
        const v = mesh.vertices[vi];
        const newV = new THREE.Vector3().copy(v).lerp(centroid, t);

        if (twist !== 0) {
          newV.sub(centroid).applyAxisAngle(normal, twist).add(centroid);
        }

        newVerts.push(newV);
        newVertsMap[fi][i] = newVerts.length - 1;
      });
    });

    // 2. Create "Face Faces" (shrunk originals)
    mesh.faces.forEach((f, fi) => {
      const faceIndices = newVertsMap[fi];
      newFaces.push([...faceIndices]); // Copy to ensure new array
    });

    // Helper: Build edge map to find adjacent faces
    const edgeToFaces = {};
    mesh.faces.forEach((f, fi) => {
      f.forEach((vi, i) => {
        const vj = f[(i + 1) % f.length];
        const key = [vi, vj].sort((a, b) => a - b).join('_');
        if (!edgeToFaces[key]) edgeToFaces[key] = [];
        edgeToFaces[key].push(fi);
      });
    });

    // 3. Create "Vertex Faces" (at original vertices)
    // For each ORIGINAL vertex, find the cycle of faces around it.
    // Connect the new vertices corresponding to this original vertex.
    mesh.vertices.forEach((v, vi) => {
      // Find ordered faces around vi

      // Start with any face touching vi
      const startFaceIdx = mesh.faces.findIndex(f => f.includes(vi));
      if (startFaceIdx === -1) return;

      const orderedFaces = [];
      let currFaceIdx = startFaceIdx;
      let safety = 0;

      do {
        orderedFaces.push(currFaceIdx);
        // Find "previous" edge in this face entering vi
        // Face: ... -> prev -> vi -> next -> ...
        // We want the face sharing (prev, vi).
        const face = mesh.faces[currFaceIdx];
        const idxInFace = face.indexOf(vi);
        const prevVi = face[(idxInFace - 1 + face.length) % face.length];

        const key = [prevVi, vi].sort((a, b) => a - b).join('_');
        const adjFaces = edgeToFaces[key];
        const nextFaceIdx = adjFaces.find(id => id !== currFaceIdx);
        if (nextFaceIdx === undefined) break;

        currFaceIdx = nextFaceIdx;
        safety++;
      } while (currFaceIdx !== startFaceIdx && safety < 20);

      // Collect the specific new vertices
      const faceVerts = orderedFaces.map(fi => {
        const face = mesh.faces[fi];
        const idx = face.indexOf(vi);
        return newVertsMap[fi][idx];
      });

      // The traversal above follows the neighbor's "previous" edge, which effectively walks
      // CCW around the vertex (if faces are viewed from outside).
      // Thus, faceVerts is already CCW. No reverse needed.
      newFaces.push(faceVerts);
    });

    // 4. Create "Edge Triangles"
    // For each edge (u, v) shared by Face A and Face B
    // Vertices involved: A_u, A_v, B_u, B_v
    // Faces A and B are adjacent.

    // To avoid duplicates, iterate edges via edgeMap/Keys
    const processedEdges = new Set();
    mesh.faces.forEach((f, fi) => {
      f.forEach((vi, i) => {
        const vj = f[(i + 1) % f.length]; // Edge vi -> vj
        const key = vi < vj ? `${vi}_${vj}` : `${vj}_${vi}`;
        if (processedEdges.has(key)) return;
        processedEdges.add(key);

        const adj = edgeToFaces[key];
        if (!adj || adj.length < 2) return;

        const faceA = fi;
        const faceB = adj.find(id => id !== fi);

        // Find indices
        const idxA_u = mesh.faces[faceA].indexOf(vi);
        const idxA_v = mesh.faces[faceA].indexOf(vj);

        const u = vi;
        const v = vj;

        const idxB_u = mesh.faces[faceB].indexOf(u);
        const idxB_v = mesh.faces[faceB].indexOf(v);

        const A_u = newVertsMap[faceA][idxA_u];
        const A_v = newVertsMap[faceA][idxA_v];
        const B_u = newVertsMap[faceB][idxB_u];
        const B_v = newVertsMap[faceB][idxB_v];

        // Tri 1: A_v, A_u, B_v
        newFaces.push([A_v, A_u, B_v]);

        // Tri 2: B_u, B_v, A_u
        newFaces.push([B_u, B_v, A_u]);
      });
    });

    this.normalize({ vertices: newVerts, faces: newFaces });
    return { vertices: newVerts, faces: newFaces };
  },

  /**
   * Bitruncate operator: Truncate the rectified mesh.
   * @param {Object} mesh 
   * @param {number} t - Truncation depth. Default 1/3 (if regular).
   * @returns {Object}
   */
  bitruncate(mesh, t = 1 / 3) {
    return this.truncate(this.ambo(mesh), t);
  },

  /**
   * Canonicalize operator: Iteratively relaxes the mesh to equalize edge lengths.
   * @param {Object} mesh 
   * @param {number} iterations - Number of relaxation steps. Default 100.
   * @returns {Object}
   */
  canonicalize(mesh, iterations = 100) {
    const positions = mesh.vertices.map(v => v.clone());
    const faces = mesh.faces;

    // Build adjacency
    const neighbors = new Array(positions.length).fill(null).map(() => []);
    faces.forEach(f => {
      for (let i = 0; i < f.length; i++) {
        const u = f[i];
        const v = f[(i + 1) % f.length];
        neighbors[u].push(v);
        neighbors[v].push(u);
      }
    });
    // Deduplicate neighbors
    neighbors.forEach((n, i) => {
      neighbors[i] = [...new Set(n)];
    });

    for (let iter = 0; iter < iterations; iter++) {
      // 1. Calculate target edge length (average)
      let totalLen = 0;
      let edgeCount = 0;
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        neighbors[i].forEach(ni => {
          if (i < ni) {
            totalLen += p.distanceTo(positions[ni]);
            edgeCount++;
          }
        });
      }
      const targetLen = totalLen / edgeCount;

      // 2. Apply forces
      const movements = new Array(positions.length).fill(null).map(() => new THREE.Vector3());

      for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        const nList = neighbors[i];
        const force = new THREE.Vector3();

        nList.forEach(ni => {
          const neighbor = positions[ni];
          const vec = new THREE.Vector3().subVectors(neighbor, p);
          const dist = vec.length();
          const diff = dist - targetLen;

          // Hooke's Law: Pull if too long, Push if too short
          force.addScaledVector(vec.normalize(), diff * 0.1);
        });

        movements[i].add(force);
      }

      // 3. Move and Normalize
      for (let i = 0; i < positions.length; i++) {
        positions[i].add(movements[i]);
        positions[i].normalize(); // Constraint to Sphere
      }
    }

    return { vertices: positions, faces: faces };
  },

  /**
   * Truncate operator: Cuts corners off the polyhedron.
   * @param {Object} mesh 
   * @param {number} t - Truncation depth [0..0.5]. 0 = no change, 0.5 = ambo. Default 1/3.
   * @returns {Object}
   */
  truncate(mesh, t = 1 / 3) {
    const newVerts = [];
    const newFaces = [];
    const edgeMap = new Map(); // key -> [idxNearU, idxNearV]

    // 1. Create new vertices along edges
    mesh.faces.forEach(f => {
      for (let i = 0; i < f.length; i++) {
        const u = f[i];
        const v = f[(i + 1) % f.length];
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;

        if (!edgeMap.has(key)) {
          const vU = mesh.vertices[u];
          const vV = mesh.vertices[v];

          // Vertex near U
          const p1 = vU.clone().lerp(vV, t);
          newVerts.push(p1);
          const idx1 = newVerts.length - 1;

          // Vertex near V
          const p2 = vU.clone().lerp(vV, 1 - t);
          newVerts.push(p2);
          const idx2 = newVerts.length - 1;

          edgeMap.set(key, u < v ? [idx1, idx2] : [idx2, idx1]);
          // stored as [index_near_keystart, index_near_keyend]
          // if key is u_v, [0] is near u, [1] is near v.
        }
      }
    });

    // 2. Modified Faces (internal polygons)
    mesh.faces.forEach(f => {
      const faceVerts = [];
      for (let i = 0; i < f.length; i++) {
        const u = f[i];
        const v = f[(i + 1) % f.length];
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const indices = edgeMap.get(key);

        // Edge u->v. We want vertex near u then vertex near v.
        // If u < v, key is u_v, indices are [near_u, near_v].
        // If u > v, key is v_u, indices are [near_v, near_u].

        if (u < v) {
          faceVerts.push(indices[0]);
          faceVerts.push(indices[1]);
        } else {
          faceVerts.push(indices[1]);
          faceVerts.push(indices[0]);
        }
      }
      newFaces.push(faceVerts);
    });

    // 3. Corner Faces (at original vertices)
    // Needs adjacency to know order of edges around vertex.
    const edgeToFaces = {};
    mesh.faces.forEach((f, fi) => {
      f.forEach((u, i) => {
        const v = f[(i + 1) % f.length];
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        if (!edgeToFaces[key]) edgeToFaces[key] = [];
        edgeToFaces[key].push(fi);
      });
    });

    mesh.vertices.forEach((v, vi) => {
      // Find one face starting
      const startFaceIdx = mesh.faces.findIndex(f => f.includes(vi));
      if (startFaceIdx === -1) return;

      const polyVerts = [];
      let currFaceIdx = startFaceIdx;
      let safety = 0;
      do {
        // In currFace, find edge outgoing from vi
        const face = mesh.faces[currFaceIdx];
        const idxInFace = face.indexOf(vi);
        const nextVi = face[(idxInFace + 1) % face.length];

        // We want the vertex on this edge that is closest to vi.
        const key = vi < nextVi ? `${vi}_${nextVi}` : `${nextVi}_${vi}`;
        const indices = edgeMap.get(key);
        // indices: [near_key_start, near_key_end]
        const idxNearVi = (vi < nextVi) ? indices[0] : indices[1];
        polyVerts.push(idxNearVi);

        const nextVert = face[(idxInFace + 1) % face.length];
        const edgeKey = vi < nextVert ? `${vi}_${nextVert}` : `${nextVert}_${vi}`;

        // Find neighbor face
        const adj = edgeToFaces[edgeKey];
        const nextFaceId = adj.find(id => id !== currFaceIdx);
        if (nextFaceId === undefined) break; // Open mesh?

        currFaceIdx = nextFaceId;
        safety++;
      } while (currFaceIdx !== startFaceIdx && safety < 20);

      if (polyVerts.length > 2) {
        newFaces.push(polyVerts.reverse()); // Keep CCW? 
      }
    });

    this.normalize({ vertices: newVerts, faces: newFaces });
    return { vertices: newVerts, faces: newFaces };
  },

  /**
   * Gyro operator: dual(snub(mesh)).
   * Creates pentagonal faces (for standard inputs).
   * @param {Object} mesh 
   * @returns {Object}
   */
  gyro(mesh) {
    return this.dual(this.snub(mesh));
  }
};



// Inject Type into pool to handle circular dependency
// Removed unused pools and functions
