/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { wrap } from "./util.js";
import { Daydream } from "./driver.js";
import { Rotation, Orientation } from "./animation.js";
import { easeOutCirc } from "./easing.js";
import { Palettes } from "./palettes.js";
import { vectorPool, quaternionPool, dotPool } from "./memory.js";
import { TWO_PI, mobius, stereo, invStereo } from "./3dmath.js";

/**
 * Transforms a 3D vector specific to this Mobius parameter set.
 * @param {THREE.Vector3} v - Input vector.
 * @param {MobiusParams} params - The Mobius parameters.
 * @param {THREE.Vector3} target - Output vector.
 * @returns {THREE.Vector3} Transformed vector (target).
 */
export function mobiusTransform(v, params, target) {
  const z = stereo(v);
  const w = mobius(z, params);
  return invStereo(w, target);
}

import { KDTree } from "./spatial.js";

/** @type {number} The golden ratio, (1 + Math.sqrt(5)) / 2. */
export const PHI = (1 + Math.sqrt(5)) / 2;
/** @type {number} The inverse golden ratio, 1 / PHI. */
const _tempSpherical = new THREE.Spherical();
const _tempVec = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
const _tempN = new THREE.Vector3();
const _tempC = new THREE.Vector3();
const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
export const G = 1 / PHI;

/**
 * Represents a single point to be rendered, storing its position and color.
 */
export class Dot {
  /**
   * @param {THREE.Vector3} position - The position of the dot (normalized).
   * @param {THREE.Color|{color: THREE.Color, alpha: number}} colorOrObj - The color of the dot or an object containing color and alpha.
   * @param {number} [alpha=1.0] - The alpha value (if not provided in colorOrObj).
   */
  constructor(position, colorOrObj, alpha = 1.0) {
    if (position === undefined) {
      // Pool initialization case
      this.position = new THREE.Vector3();
      this.color = new THREE.Color(1, 1, 1);
      this.alpha = 1.0;
      return;
    }

    this.position = position;
    if (colorOrObj && colorOrObj.isColor) {
      this.color = colorOrObj;
      this.alpha = alpha;
    } else if (colorOrObj) {
      this.color = colorOrObj.color || new THREE.Color(1, 1, 1);
      this.alpha = (colorOrObj.alpha !== undefined) ? colorOrObj.alpha : alpha;
    } else {
      this.color = new THREE.Color(1, 1, 1);
      this.alpha = alpha;
    }
  }
}

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
 * Converts spherical coordinates on a unit sphere to 2D pixel coordinates.
 * @param {THREE.Spherical} s - The spherical coordinates (radius assumed to be 1).
 * @returns {{x: number, y: number}} The pixel coordinates (x is wrapped).
 */
export const sphericalToPixel = (s) => {
  return {
    x: wrap((s.theta * Daydream.W) / TWO_PI, Daydream.W),
    y: phiToY(s.phi),
  };
};

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

/**
 * Converts Log-Polar coordinates (rho, theta) to a vector on the unit sphere.
 * Maps: Log-Polar -> Complex Plane -> Inverse Stereographic -> Sphere
 * @param {number} rho - The log-radius (natural logarithm of the radius on the complex plane).
 * @param {number} theta - The angle in radians.
 * @returns {THREE.Vector3} Normalized vector on the unit sphere.
 */
export const logPolarToVector = (rho, theta) => {
  const R = Math.exp(rho);
  const z = { re: R * Math.cos(theta), im: R * Math.sin(theta) };
  const v = vectorPool.acquire();
  invStereo(z, v);
  return v;
};

/**
 * Converts a vector on the unit sphere to Log-Polar coordinates.
 * Maps: Sphere -> Stereographic -> Complex Plane -> Log-Polar
 * @param {THREE.Vector3} v - Normalized vector on the unit sphere.
 * @returns {{rho: number, theta: number}} Log-Polar coordinates.
 */
export const vectorToLogPolar = (v) => {
  const z = stereo(v);
  const rho = 0.5 * Math.log(z.re * z.re + z.im * z.im);
  const theta = Math.atan2(z.im, z.re);
  return { rho, theta };
};

/**
 * Generates a truly random 3D unit vector using Marsaglia's method.
 * This ensures perfectly uniform distribution on the sphere surface.
 * @returns {THREE.Vector3} A normalized random vector.
 */
export const randomVector = () => {
  let v1, v2, s;
  do {
    v1 = 2.0 * Math.random() - 1.0;
    v2 = 2.0 * Math.random() - 1.0;
    s = v1 * v1 + v2 * v2;
  } while (s >= 1.0 || s === 0.0);

  const sqrtS = Math.sqrt(1.0 - s);
  const v = vectorPool.acquire();
  v.set(
    2.0 * v1 * sqrtS,
    2.0 * v2 * sqrtS,
    1.0 - 2.0 * s
  );
  return v;
};

/**
 * Calculates a point on the Fibonacci spiral on the unit sphere.
 * @param {number} n - The total number of points in the spiral.
 * @param {number} eps - The epsilon offset for the spiral.
 * @param {number} i - The index of the point to calculate.
 * @returns {THREE.Vector3} The point on the unit sphere.
 */
export const fibSpiral = (n, eps, i) => {
  const v = vectorPool.acquire();
  v.setFromSpherical(new THREE.Spherical(
    1,
    Math.acos(1 - (2 * (i + eps)) / n),
    (TWO_PI * i * G) % TWO_PI
  ));
  return v;
}

/**
 * Returns a function that generates a sine wave value.
 * @param {number} from - The minimum output value.
 * @param {number} to - The maximum output value.
 * @param {number} freq - The frequency multiplier of the wave.
 * @param {number} phase - The phase shift of the wave.
 * @returns {function(number): number} A function that takes time t and returns the wave value.
 */
export function sinWave(from, to, freq, phase) {
  return (t) => {
    let w = (Math.sin(freq * t * TWO_PI - Math.PI / 2 + Math.PI - 2 * phase) + 1) / 2;
    return w * (to - from) + from;
  };
}

/**
 * Performs linear interpolation between two values.
 * @param {number} from - The starting value.
 * @param {number} to - The ending value.
 * @param {number} t - The interpolation factor [0, 1].
 * @returns {number} The interpolated value.
 */
export function lerp(from, to, t) {
  return (to - from) * t + from;
}

/**
 * Returns a function that generates a triangle wave value.
 * @param {number} from - The minimum output value.
 * @param {number} to - The maximum output value.
 * @param {number} freq - The frequency multiplier .
 * @param {number} phase - The phase shift
 * @returns {function(number): number} A function that takes time t and returns the wave value.
 */
export function triWave(from, to, freq, phase) {
  return (t) => {
    let p = (t * freq + phase) % 1;
    if (p < 0) p += 1;
    let w = (p < 0.5) ? (2 * p) : (2 - 2 * p);
    return from + w * (to - from);
  };
}

/**
 * Returns a function that generates a square wave value.
 * @param {number} from - The 'off' value.
 * @param {number} to - The 'on' value.
 * @param {number} freq - The frequency multiplier.
 * @param {number} dutyCycle - The duty cycle (proportion of 'on' time) [0, 1].
 * @param {number} phase - The phase shift.
 * @returns {function(number): number} A function that takes time t and returns the square wave value.
 */
export function squareWave(from, to, freq, dutyCycle, phase) {
  return (t) => {
    if ((t * freq + phase) % 1 < dutyCycle) {
      return to;
    }
    return from;
  };
}

/**
 * Generates a color based on the distance (dot product) from a point on the sphere to a plane normal.
 * Uses two predefined gradients (g1 and g2) for positive and negative distances.
 * @param {THREE.Vector3} v - The vector (point on sphere).
 * @param {THREE.Vector3} normal - The plane normal vector.
 * @returns {THREE.Color} The distance-based gradient color.
 */
export function distanceGradient(v, normal) {
  let d = v.dot(normal);
  if (d > 0) {
    return Palettes.g1.get(d).clone();
  } else {
    return Palettes.g2.get(-d).clone();
  }
}

/**
 * Generates a Lissajous curve point on the sphere.
 * @param {number} m1 - Axial frequency.
 * @param {number} m2 - Orbital frequency.
 * @param {number} a - Phase shift multiplier (in multiples of PI).
 * @param {number} t - Time parameter.
 * @returns {THREE.Vector3} The point on the sphere's surface.
 */
export function lissajous(m1, m2, a, t) {
  const v = _tempVec;
  v.set(
    Math.sin(m2 * t) * Math.cos(m1 * t - a * Math.PI),
    Math.cos(m2 * t),
    Math.sin(m2 * t) * Math.sin(m1 * t - a * Math.PI),
  );
  return v;
}

/**
 * Animates a rotation between two orientations using an easing function.
 * @param {Orientation} from - The starting orientation (mutable).
 * @param {Orientation} to - The target orientation.
 */
export function rotateBetween(from, to) {
  let diff = quaternionPool.acquire().copy(from.get()).conjugate().premultiply(to.get());
  let angle = 2 * Math.acos(diff.w);
  if (angle == 0) {
    return
  } else {
    var axis = vectorPool.acquire().set(diff.x, diff.y, diff.z).normalize();
  }
  new Rotation(from, axis, angle, 1, easeOutCirc).step();
}

/**
 * Checks if a vector is on the 'over' side of a plane defined by its normal.
 * @param {THREE.Vector3} v - The vector to check.
 * @param {THREE.Vector3} normal - The plane normal.
 * @returns {boolean} True if the dot product is non-negative.
 */
export function isOver(v, normal) {
  return normal.dot(v) >= 0;
}

/**
 * Checks if the line segment between two vectors intersects a plane.
 * @param {THREE.Vector3} v1 - Start vector.
 * @param {THREE.Vector3} v2 - End vector.
 * @param {THREE.Vector3} normal - Plane normal.
 * @returns {boolean} True if the vectors are on opposite sides of the plane.
 */
export function intersectsPlane(v1, v2, normal) {
  return (isOver(v1, normal) && !isOver(v2, normal))
    || (!isOver(v1, normal) && isOver(v2, normal));
}

/**
 * Calculates the angle between two vectors.
 * @param {THREE.Vector3} v1 - First vector.
 * @param {THREE.Vector3} v2 - Second vector.
 * @returns {number} The angle in radians [0, PI].
 */
export function angleBetween(v1, v2) {
  const d = v1.dot(v2);
  const l2 = v1.lengthSq() * v2.lengthSq();
  return Math.acos(Math.max(-1, Math.min(1, d / Math.sqrt(l2))));
}

/**
 * Finds the point of intersection of the geodesic line between u and v with the plane defined by normal.
 * @param {THREE.Vector3} u - First vector.
 * @param {THREE.Vector3} v - Second vector.
 * @param {THREE.Vector3} normal - Plane normal.
 * @returns {THREE.Vector3|number} The intersection point (normalized) or NaN if intersection is not valid for geodesic.
 */
export function intersection(u, v, normal) {
  let w = vectorPool.acquire().crossVectors(v, u).normalize();
  let i1 = vectorPool.acquire().crossVectors(w, normal).normalize();
  let i2 = vectorPool.acquire().crossVectors(normal, w).normalize();

  let a1 = angleBetween(u, v);
  let a2 = angleBetween(i1, u);
  let a3 = angleBetween(i1, v);
  if (a2 + a3 - a1 < .0001) {
    return i1;
  }

  a1 = angleBetween(u, v);
  a2 = angleBetween(i2, u);
  a3 = angleBetween(i2, v);
  if (a2 + a3 - a1 < .0001) {
    return i2;
  }

  return NaN;
}




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
 * Face in a Half-Edge data structure.
 * Stores a reference to one of the half-edges bordering this face.
 */
export class HEFace {
  constructor() {
    this.halfEdge = null;
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
   * Snub operator: Creates a chiral semi-regular polyhedron.
   * Expands faces, twists them, and inserts triangles.
   * @param {Object} mesh 
   * @returns {Object}
   */
  snub(mesh) {
    const newVerts = [];
    const newFaces = [];

    // 1. Create new vertices (n per face)
    // Structure: newVertsMap[faceIndex][vertIndexInFace] = globalIndex
    const newVertsMap = new Array(mesh.faces.length).fill(null).map(() => []);
    const SHRINK_FACTOR = 0.5; // Adjustable

    mesh.faces.forEach((f, fi) => {
      // Calculate face centroid
      const centroid = new THREE.Vector3();
      f.forEach(vi => centroid.add(mesh.vertices[vi]));
      centroid.divideScalar(f.length);

      f.forEach((vi, i) => {
        // Create new vertex towards centroid
        const v = mesh.vertices[vi];
        const newV = new THREE.Vector3().copy(v).lerp(centroid, SHRINK_FACTOR);
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
   * Truncate operator: Cuts corners off the polyhedron.
   * @param {Object} mesh 
   * @param {number} t - Truncation depth [0..0.5]. 0 = no change, 0.5 = ambo.
   * @returns {Object}
   */
  truncate(mesh, t = 0.25) {
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

        // Move to neighbor face sharing the *previous* edge (incoming to vi) to walk CCW?
        // Wait, standard order:
        // Polygon is vi -> outgoing_edge_pt -> incoming_next_edge_pt ...
        // No, standard cutoff face connects the points on edges incident to vi.

        // Let's walk the faces around vi.
        // Current Face F1. Edge outgoing is (vi, next). Edge incoming is (prev, vi).
        // The truncation face connects point on (vi, next) to point on (vi, prev)?
        // No, usually it's the cycle of points on the edges connected to vi.

        // Let's traverse faces around vi.
        // F1 -> F2 -> ...
        // In F1, we have point on edge (vi, next).
        // We also have point on edge (prev, vi). -> Wait, that's in F1 too.
        // A Truncate face replaces the vertex. It connects all the new points that surround the old vertex.
        // Sequence: Point on Edge 1, Point on Edge 2, ...

        // Let's find neighbors of vi.
        // If we walk edges around vi: e1, e2, e3...
        // We pick the point on e1 (near vi), point on e2 (near vi)...

        // To ensure winding order, we walk faces.
        // Start Face F. Edge (vi, next) is part of F.
        // The point on (vi, next) is P1.
        // Next face shares edge (vi, next).
        // That face has edge (vi, next2). Point P2.

        // So:
        // 1. Start Face F.
        // 2. Identify edge (vi, next).
        // 3. Get point on (vi, next) closest to vi. Push params.
        // 4. Move to neighbor face sharing (vi, next).

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
        // Walked faces: F1 -> F2 (across edge 1).
        // Point 1 is on edge 1. Point 2 is on edge 2.
        // P1 -> P2 -> ... ensures logical loop around vi.
        // Verify winding: center is vi. P1, P2...
        // Original faces are CCW seen from outside.
        // Vertices around vi are CW or CCW? 
        // Usually, neighbors of a vertex in CCW face are ordered CW? No.
        // Let's stick with reverse() if it looks inside-out.
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

/**
 * Creates a basis object { u, v, w } from an orientation and normal.
 * @param {THREE.Quaternion} orientation - The orientation quaternion.
 * @param {THREE.Vector3} normal - The local normal vector.
 * @returns {{u: THREE.Vector3, v: THREE.Vector3, w: THREE.Vector3}} The basis vectors.
 */
export const makeBasis = (orientation, normal) => {
  let refAxis = Daydream.X_AXIS;
  if (Math.abs(normal.dot(refAxis)) > 0.9999) {
    refAxis = Daydream.Y_AXIS;
  }
  let v = vectorPool.acquire().copy(normal).applyQuaternion(orientation).normalize();
  let ref = _tempVec.copy(refAxis).applyQuaternion(orientation).normalize();
  let u = vectorPool.acquire().crossVectors(v, ref).normalize();
  let w = vectorPool.acquire().crossVectors(v, u).normalize();
  return { u, v, w };
};

/**
 * Adjusted basis and radius for drawing on the opposite side of the sphere.
 * @param {Object} basis - {u, v, w}
 * @param {number} radius - angular radius (0-2)
 * @returns {{basis: Object, radius: number}}
 */
export const getAntipode = (basis, radius) => {
  if (radius > 1.0) {
    const u = vectorPool.acquire().copy(basis.u).negate(); // Flip U to maintain chirality
    const v = vectorPool.acquire().copy(basis.v).negate(); // Flip V (Antipode)
    const w = vectorPool.acquire().copy(basis.w);          // W stays (Rotation axis)
    return {
      basis: { u, v, w },
      radius: 2.0 - radius
    };
  }
  return { basis, radius };
};

// Inject Type into pool to handle circular dependency
dotPool.Type = Dot;
