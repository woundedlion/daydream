/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { wrap } from "./util.js";
import { Daydream } from "./driver.js";
import { Rotation, easeOutCirc } from "./animation.js";
import { g1, g2 } from "./color.js";
import { StaticPool } from "./StaticPool.js";
import { TWO_PI } from "./3dmath.js";

/** @type {StaticPool} Global pool for temporary Vector3 objects. */
export const vectorPool = new StaticPool(THREE.Vector3, 500000);
/** @type {StaticPool} Global pool for temporary Quaternion objects. */
export const quaternionPool = new StaticPool(THREE.Quaternion, 1000000);
/** @type {number} The golden ratio, (1 + sqrt(5)) / 2. */
export const PHI = (1 + Math.sqrt(5)) / 2;
/** @type {number} The inverse golden ratio, 1 / PHI. */
const _tempSpherical = new THREE.Spherical();
const _tempVec = new THREE.Vector3();
const _tempVec2 = new THREE.Vector3();
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

/**
 * Converts a 3D vector (normalized) to 2D pixel coordinates.
 * @param {THREE.Vector3} v - The vector (position on unit sphere).
 * @returns {{x: number, y: number}} The pixel coordinates (x is wrapped).
 */
export const vectorToPixel = (v) => {
  _tempSpherical.setFromVector3(v);
  return {
    x: wrap((_tempSpherical.theta * Daydream.W) / TWO_PI, Daydream.W),
    y: (_tempSpherical.phi * (Daydream.H - 1)) / Math.PI,
  };
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
  // 1. Log-Polar to Plane Radius (R)
  // rho = ln(R) -> R = e^rho
  const R = Math.exp(rho);

  // 2. Inverse Stereographic Projection (Plane Radius R -> Sphere Y)
  // y = (R^2 - 1) / (R^2 + 1)
  const y = (R * R - 1) / (R * R + 1);

  // 3. Calculate Euclidean radius at this height (r_xz)
  // x^2 + z^2 = 1 - y^2
  const r_xz = Math.sqrt(1 - y * y);

  const v = vectorPool.acquire();
  v.set(
    r_xz * Math.cos(theta),
    y,
    r_xz * Math.sin(theta)
  );
  return v;
};

/**
 * Converts a vector on the unit sphere to Log-Polar coordinates.
 * Maps: Sphere -> Stereographic -> Complex Plane -> Log-Polar
 * @param {THREE.Vector3} v - Normalized vector on the unit sphere.
 * @returns {{rho: number, theta: number}} Log-Polar coordinates.
 */
export const vectorToLogPolar = (v) => {
  // 1. Stereographic Projection (Sphere -> Plane Radius R)
  // R^2 = (1 + y) / (1 - y)
  const denom = 1 - v.y;
  if (Math.abs(denom) < 0.00001) {
    return { rho: 10, theta: 0 }; // Handle North Pole singularity
  }

  // 2. Calculate rho (log radius)
  // R = sqrt((1+y)/(1-y))
  // rho = ln(R) = 0.5 * ln((1+y)/(1-y))
  const rho = 0.5 * Math.log((1 + v.y) / (1 - v.y));

  // 3. Calculate theta (angle)
  // Standard polar angle in XZ plane
  const theta = Math.atan2(v.z, v.x);

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
 * Manages the rotation and orientation of a 3D object over time.
 * Stores a history of quaternions for motion trails.
 */
export class Orientation {
  constructor() {
    this.orientations = [new THREE.Quaternion(0, 0, 0, 1)];
  }

  /**
   * Gets the number of recorded orientations (history length).
   * @returns {number} The length of the orientation history.
   */
  length() {
    return this.orientations.length;
  }

  /**
   * Applies an orientation from the history to a given vector.
   * @param {THREE.Vector3} v - The vector to be oriented.
   * @param {number} [i=this.length() - 1] - The index in the history to use.
   * @returns {THREE.Vector3} The oriented and normalized vector.
   */
  orient(v, i = this.length() - 1) {
    return vectorPool.acquire().copy(v).normalize().applyQuaternion(this.orientations[i]);
  }

  /**
   * Applies the inverse orientation from the history to a given vector.
   * @param {THREE.Vector3} v - The vector to be unoriented.
   * @param {number} [i=this.length() - 1] - The index in the history to use.
   * @returns {THREE.Vector3} The unoriented and normalized vector.
   */
  unorient(v, i = this.length() - 1) {
    const q = quaternionPool.acquire().copy(this.orientations[i]).invert();
    return vectorPool.acquire().copy(v).normalize().applyQuaternion(q);
  }

  /**
   * Applies the orientation to an array of coordinate arrays.
   * @param {number[][]} vertices - Array of [x, y, z] coordinates.
   * @param {number} [i=this.length() - 1] - The index in the history to use.
   * @returns {number[][]} Array of oriented [x, y, z] coordinates.
   */
  orientPoly(vertices, i = this.length() - 1) {
    return vertices.map((c) => {
      return this.orient(vectorPool.acquire().fromArray(c)).toArray();
    });
  }

  /**
   * Increases the resolution of the history to 'count' steps, preserving shape via Slerp.
   * @param {number} count - The target number of steps in the history.
   * Does nothing if count is less than current length.
   */
  upsample(count) {
    if (this.orientations.length >= count) return;

    const oldHistory = this.orientations;
    const newHistory = new Array(count);

    // Always keep start and end exact. 
    // Note: oldHistory[0] and oldHistory[end] are persistent (non-pooled) if they were the result of a collapse() or set().
    newHistory[0] = oldHistory[0];
    newHistory[count - 1] = oldHistory[oldHistory.length - 1];

    for (let i = 1; i < count - 1; i++) {
      // Normalized position in new array (0..1)
      const t = i / (count - 1);

      // Corresponding float index in old array
      const oldVal = t * (oldHistory.length - 1);
      const idxA = Math.floor(oldVal);
      const idxB = Math.ceil(oldVal);
      const alpha = oldVal - idxA;

      // Slerp between the two nearest existing points using pooled objects
      newHistory[i] = quaternionPool.acquire().copy(oldHistory[idxA]).slerp(oldHistory[idxB], alpha);
    }

    this.orientations = newHistory;
  }

  /**
   * Clears all recorded orientations.
   */
  clear() {
    this.orientations = [];
  }

  /**
   * Gets a specific quaternion from the history.
   * @param {number} [i=this.length() - 1] - The index in the history to get.
   * @returns {THREE.Quaternion} The requested quaternion.
   */
  get(i = this.length() - 1) {
    return this.orientations[i];
  }

  /**
   * Replaces the entire history with a single quaternion.
   * @param {THREE.Quaternion} quaternion - The new orientation.
   * @returns {Orientation} The orientation instance.
   */
  set(quaternion) {
    this.orientations = [quaternion];
    return this;
  }

  /**
   * Adds a new quaternion to the end of the history.
   * @param {THREE.Quaternion} quaternion - The quaternion to push.
   */
  push(quaternion) {
    this.orientations.push(quaternion);
  }

  /**
   * Collapses the history to just the most recent orientation.
   */
  collapse() {
    if (this.orientations.length > 1) {
      // Copy last value into the first slot. 
      // This ensures this.orientations[0] is always a persistent object (not from a pool that gets reset).
      this.orientations[0].copy(this.orientations[this.orientations.length - 1]);
      this.orientations.length = 1;
    }
  }
}

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
    return g1.get(d).clone();
  } else {
    return g2.get(-d).clone();
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
 * Procedural mesh operations for generating Archimedean solids.
 */
export const MeshOps = {
  /**
   * Truncates the vertices of a mesh.
   * @param {Object} mesh - {vertices, faces}
   * @param {number} [factor=1/3] - Cut depth [0..0.5]. 
   */
  truncate(mesh, factor = 1 / 3) {
    const heMesh = new HalfEdgeMesh(mesh);
    const newVertices = [];
    // Map from HalfEdge to new Vertex index
    // We place a new vertex on every half-edge (near the start vertex).
    // Actually, "Truncation" places vertices on edges.
    // For every directed half-edge HE (from A to B), we create a vertex P on AB near A.
    // P = Lerp(A, B, factor).
    const heToVertIdx = new Map();

    for (const he of heMesh.halfEdges) {
      // he.vertex is B (destination).
      // he.pair.vertex is A (origin).
      // But he.pair might not exist if open mesh? Archimedean solids are closed.
      if (!he.pair) continue;

      const A = he.pair.vertex.position;
      const B = he.vertex.position;

      const P = _tempVec.copy(A).lerp(B, factor).clone();
      const idx = newVertices.push(P) - 1;
      heToVertIdx.set(he, idx);
    }

    const newFaces = [];

    // 1. Faces from original faces (trimmed)
    for (const face of heMesh.faces) {
      const faceIndices = [];
      let he = face.halfEdge;
      const startHe = he;
      do {
        faceIndices.push(heToVertIdx.get(he));
        faceIndices.push(heToVertIdx.get(he.pair));

        he = he.next;
      } while (he !== startHe);
      newFaces.push(faceIndices);
    }

    // 2. Faces from original vertices
    const visitedVerts = new Set();

    for (const heStart of heMesh.halfEdges) {
      // heStart.pair.vertex is the ORIGIN A.
      // We want to process A once.
      // Use prev.vertex which is safer than pair.vertex for open meshes
      const origin = heStart.prev.vertex;
      if (visitedVerts.has(origin)) continue;
      visitedVerts.add(origin);

      const vertFaceIndices = [];
      // Walk around A
      let curr = heStart; // Starts at A
      // We want the vertices generated "near A".

      let safety = 0;
      const startOrbit = curr;
      do {
        vertFaceIndices.push(heToVertIdx.get(curr));
        // Guard against boundary/unmatched edges
        if (!curr.pair) break;
        curr = curr.pair.next;
        safety++;
      } while (curr !== startOrbit && curr && safety < 100);

      if (vertFaceIndices.length > 2) {
        newFaces.push(vertFaceIndices.reverse());
      }
    }

    return { vertices: newVertices, faces: newFaces };
  },

  rectify(mesh) {
    // Rectify is truncate with factor 0.5.
    const heMesh = new HalfEdgeMesh(mesh);
    const newVertices = [];
    const edgeToVertIdx = new Map(); // Key: "min,max" vertex index? or just verify uniqueness.

    // Map each edge (unordered pair) to a new vertex
    // We can use the half-edge loop.
    // Map each edge (distinct undirected) to a new vertex
    for (const he of heMesh.halfEdges) {
      if (edgeToVertIdx.has(he)) continue;

      // Identify the undirected edge by sorting vertex usage or exploiting pair
      // If pair exists, we check if pair is processed.
      if (he.pair && edgeToVertIdx.has(he.pair)) {
        edgeToVertIdx.set(he, edgeToVertIdx.get(he.pair));
        continue;
      }

      const vA = he.prev.vertex;
      const vB = he.vertex;

      const P = _tempVec.copy(vA.position).add(vB.position).multiplyScalar(0.5).clone();
      const idx = newVertices.push(P) - 1;
      edgeToVertIdx.set(he, idx);
      if (he.pair) edgeToVertIdx.set(he.pair, idx);
    }

    const newFaces = [];

    // 1. Faces from original faces
    for (const face of heMesh.faces) {
      const faceIndices = [];
      let he = face.halfEdge;
      const start = he;
      do {
        faceIndices.push(edgeToVertIdx.get(he));
        he = he.next;
      } while (he !== start);
      newFaces.push(faceIndices);
    }

    // 2. Faces from original vertices
    const visitedVerts = new Set();
    for (const heStart of heMesh.halfEdges) {
      const origin = heStart.prev.vertex;
      if (visitedVerts.has(origin)) continue;
      visitedVerts.add(origin);

      const vertFaceIndices = [];
      let curr = heStart;
      const startOrbit = curr;
      let safety = 0;
      do {
        const idx = edgeToVertIdx.get(curr);
        if (idx !== undefined) vertFaceIndices.push(idx);

        if (!curr.pair) break;
        curr = curr.pair.next;
        safety++;
      } while (curr !== startOrbit && curr && safety < 100);

      if (vertFaceIndices.length > 2) newFaces.push(vertFaceIndices.reverse());
    }

    return { vertices: newVertices, faces: newFaces };
  },

  expand(mesh) {
    return this.rectify(this.rectify(mesh));
  },

  snub(mesh) {
    const heMesh = new HalfEdgeMesh(mesh);
    const newVertices = [];
    const heToVertIdx = new Map();

    // 1. Create new vertices (shrunk/twisted faces)
    // Lerp(Start, Centroid, 0.5)

    // Precompute face centroids
    const faceCentroids = new Map();
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
      c.multiplyScalar(1 / count);
      faceCentroids.set(face, c);
    }

    for (const face of heMesh.faces) {
      const centroid = faceCentroids.get(face);
      let he = face.halfEdge;
      const start = he;
      do {
        if (!he.pair) { he = he.next; continue; }
        const startPos = he.pair.vertex.position;

        const P = _tempVec.copy(startPos).lerp(centroid, 0.5).clone();
        const idx = newVertices.push(P) - 1;
        heToVertIdx.set(he, idx);

        he = he.next;
      } while (he !== start);
    }

    const newFaces = [];

    // 2. Original Faces (Shrunk)
    for (const face of heMesh.faces) {
      const faceIndices = [];
      let he = face.halfEdge;
      const start = he;
      do {
        faceIndices.push(heToVertIdx.get(he));
        he = he.next;
      } while (he !== start);
      newFaces.push(faceIndices);
    }

    // 3. Vertex Faces (Polygons at original vertices)
    const visitedVerts = new Set();
    for (const heStart of heMesh.halfEdges) {
      const origin = heStart.prev.vertex;
      if (visitedVerts.has(origin)) continue;
      visitedVerts.add(origin);

      const vertLoop = [];
      let curr = heStart;
      const startOrbit = curr;
      let safety = 0;
      do {
        vertLoop.push(heToVertIdx.get(curr));
        if (!curr.pair) break;
        curr = curr.pair.next;
        safety++;
      } while (curr !== startOrbit && curr && safety < 100);
      newFaces.push(vertLoop.reverse());
    }

    // 4. Edge Faces (Triangles)
    const visitedEdges = new Set();
    for (const he of heMesh.halfEdges) {
      if (!he.pair) continue;
      if (visitedEdges.has(he) || visitedEdges.has(he.pair)) continue;
      visitedEdges.add(he);
      visitedEdges.add(he.pair);

      const pAS = heToVertIdx.get(he);
      const pAE = heToVertIdx.get(he.next);
      const pBE = heToVertIdx.get(he.pair);
      const pBS = heToVertIdx.get(he.pair.next);

      newFaces.push([pAS, pBS, pBE]);
      newFaces.push([pAS, pBE, pAE]);
    }

    return { vertices: newVertices, faces: newFaces };
  },

  dual(mesh) {
    const heMesh = new HalfEdgeMesh(mesh);
    const newVertices = [];
    const faceToVertIdx = new Map();

    // 1. New vertices = Centroids of original faces
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

    // 2. New faces = Cycles around original vertices
    // A vertex V in original mesh becomes a face F in dual mesh.
    // The vertices of F are the centroids of faces surrounding V.
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
        // Current HE belongs to a face. We want that face's centroid index.
        const faceIdx = faceToVertIdx.get(curr.face);
        faceIndices.push(faceIdx);

        // Move to next face around origin.
        // curr is outgoing A->B. Face is to left. 
        // pair is incoming B->A.
        // pair.next is Outgoing A->C.
        if (!curr.pair) break;
        curr = curr.pair.next;
        safety++;
      } while (curr !== startOrbit && curr && safety < 100);

      if (faceIndices.length > 2) {
        // Dual faces should remain CCW
        newFaces.push(faceIndices.reverse());
      }
    }

    return { vertices: newVertices, faces: newFaces };
  },

  /**
    * Generates a Hankin Pattern (Star and Rosette tiling).
    * Replaces original edges with pattern lines.
    * @param {HalfEdgeMesh} mesh - The source mesh.
    * @param {number} angle - The contact angle in radians.
    * @returns {{vertices: THREE.Vector3[], faces: number[][]}}
    */
  hankin(mesh, angle) {
    const heMesh = new HalfEdgeMesh(mesh);
    const newVertices = [];
    const newFaces = [];

    // Maps to ensure topology is shared between faces
    const heToMidpointIdx = new Map();
    const heToIntersectIdx = new Map();

    // Helper: Get/Create Midpoint Index for an edge (shared with its pair)
    const getMidpointIdx = (he) => {
      if (heToMidpointIdx.has(he)) return heToMidpointIdx.get(he);
      if (he.pair && heToMidpointIdx.has(he.pair)) return heToMidpointIdx.get(he.pair);

      const pA = he.prev ? he.prev.vertex.position : he.pair.vertex.position;
      const pB = he.vertex.position;
      // Calculate Midpoint
      const mid = vectorPool.acquire().copy(pA).add(pB).multiplyScalar(0.5).normalize();

      const idx = newVertices.push(mid.clone()) - 1;
      heToMidpointIdx.set(he, idx);
      if (he.pair) heToMidpointIdx.set(he.pair, idx);
      return idx;
    };

    // --- PASS 1: Generate Points & Star Faces ---
    for (const face of heMesh.faces) {
      const starFaceIndices = [];
      let he = face.halfEdge;
      const startHe = he;

      do {
        const prev = he.prev;
        const curr = he;

        // 1. Get Midpoints
        const idxM1 = getMidpointIdx(prev);
        const idxM2 = getMidpointIdx(curr);

        // 2. Compute Intersection (X) for this corner
        const pCorner = prev.vertex.position;
        const pPrev = prev.prev ? prev.prev.vertex.position : prev.pair.vertex.position;
        const pNext = curr.vertex.position;

        const m1 = newVertices[idxM1];
        const m2 = newVertices[idxM2];

        // Rotate normal of Edge 1
        const nEdge1 = vectorPool.acquire().crossVectors(pPrev, pCorner).normalize();
        const q1 = quaternionPool.acquire().setFromAxisAngle(m1, angle);
        const nHankin1 = vectorPool.acquire().copy(nEdge1).applyQuaternion(q1);

        // Rotate normal of Edge 2
        const nEdge2 = vectorPool.acquire().crossVectors(pCorner, pNext).normalize();
        const q2 = quaternionPool.acquire().setFromAxisAngle(m2, -angle);
        const nHankin2 = vectorPool.acquire().copy(nEdge2).applyQuaternion(q2);

        // Intersection
        let intersect = vectorPool.acquire().crossVectors(nHankin1, nHankin2);
        const lenSq = intersect.lengthSq();

        // 2. The Safe Reference (Gravity Well)
        // The average of midpoints is the "ground truth" for the pattern center.
        const ref = vectorPool.acquire().addVectors(m1, m2);

        // 3. Chirality (The Flip)
        // Ensure we are on the correct hemisphere relative to the edge gap.
        if (intersect.dot(ref) < 0) {
          intersect.negate();
        }

        // 4. "Gravity" Regularization
        // This is the key fix. We pull the intersection towards 'ref' based on instability.
        // - We use a Power Curve: weight = 1 / (1 + (lenSq / epsilon)^2)
        // - epsilon = 0.005 defines the "danger zone".
        //   * At lenSq = 0.295 (Truncated Singularity), weight -> 1.0 (Forces flat line).
        //   * At lenSq = 0.75 (Snub Horizon), weight -> ~0.5 (Pulls it back from the edge).
        //   * At lenSq = 1.0 (Normal), weight -> ~0.0 (Pure intersection).

        //      const epsilon = 0.005;
        //     const weight = 1.0 / (1.0 + (lenSq / (epsilon * epsilon)));

        //   intersect.addScaledVector(ref, weight).normalize();

        const idxI = newVertices.push(intersect.clone()) - 1;

        // Key the intersection to the edge STARING at this corner
        heToIntersectIdx.set(curr, idxI);

        // Build Star Face (Midpoint -> Intersection -> Next Midpoint)
        starFaceIndices.push(idxM1);
        starFaceIndices.push(idxI);

        he = he.next;
      } while (he !== startHe);

      newFaces.push(starFaceIndices);
    }

    // --- PASS 2: Generate Rosette Faces (The Fix) ---
    const visitedVerts = new Set();

    for (const heStart of heMesh.halfEdges) {
      const origin = heStart.prev.vertex;
      if (visitedVerts.has(origin)) continue;
      visitedVerts.add(origin);

      const rosetteIndices = [];
      let curr = heStart; // Outgoing edge
      const startOrbit = curr;
      let safety = 0;

      // Walk around the vertex CCW
      do {
        // 1. Add Midpoint of current outgoing edge
        rosetteIndices.push(heToMidpointIdx.get(curr));

        // 2. Find the next outgoing edge
        // (If mesh is closed, this is pair.next)
        const nextEdge = curr.pair ? curr.pair.next : null;
        if (!nextEdge) break;

        // 3. Add Intersection located between current and next edge
        // The intersection in the face between 'curr' and 'nextEdge' 
        // is associated with 'nextEdge' (as it's the edge starting at the corner in that face)
        const idxI = heToIntersectIdx.get(nextEdge);
        rosetteIndices.push(idxI);

        curr = nextEdge;
        safety++;
      } while (curr !== startOrbit && curr && safety < 100);

      if (rosetteIndices.length > 2) {
        // Rosettes are already CCW
        newFaces.push(rosetteIndices);
      }
    }

    return { vertices: newVertices, faces: newFaces };
  },
};
