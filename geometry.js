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
export const G = 1 / PHI;

const _tempSpherical = new THREE.Spherical();
const _tempVec = new THREE.Vector3();

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
 * Collection of standard geometric solids.
 */
export const Solids = {
  // Helper for normalization
  normalize(m) {
    m.vertices.forEach(v => v.normalize());
  },

  // 1. TETRAHEDRON (4 Verts, 4 Faces)
  // Source: Standard construction
  tetrahedron() {
    const s = 1.0;
    const c = 1.0 / Math.sqrt(3.0); // Normalize to sphere
    return {
      vertices: [
        new THREE.Vector3(c, c, c),   // 0: (+,+,+)
        new THREE.Vector3(c, -c, -c), // 1: (+,-,-)
        new THREE.Vector3(-c, c, -c), // 2: (-,+,-)
        new THREE.Vector3(-c, -c, c)  // 3: (-,-,+)
      ],
      faces: [
        // Reversed to CCW
        [0, 3, 1], [0, 2, 3], [0, 1, 2], [1, 3, 2]
      ]
    };
  },

  // 2. CUBE (8 Verts, 6 Faces)
  // Source: Geometric Tools (Ref 3.7)
  // Order: Bottom Ring (0-3), Top Ring (4-7)
  cube() {
    const a = 1.0 / Math.sqrt(3.0);
    return {
      vertices: [
        new THREE.Vector3(-a, -a, -a), // 0
        new THREE.Vector3(a, -a, -a), // 1
        new THREE.Vector3(a, a, -a), // 2
        new THREE.Vector3(-a, a, -a), // 3
        new THREE.Vector3(-a, -a, a), // 4
        new THREE.Vector3(a, -a, a), // 5
        new THREE.Vector3(a, a, a), // 6
        new THREE.Vector3(-a, a, a)  // 7
      ],
      faces: [
        [0, 3, 2, 1], // Bottom
        [0, 1, 5, 4], // Front
        [0, 4, 7, 3], // Left
        [6, 5, 1, 2], // Right
        [6, 2, 3, 7], // Back
        [6, 7, 4, 5]  // Top
      ]
    };
  },

  // 3. OCTAHEDRON (6 Verts, 8 Faces)
  // Source: Geometric Tools
  // Order: Equator (0-3), Top (4), Bottom (5)
  octahedron() {
    return {
      vertices: [
        new THREE.Vector3(1, 0, 0), // 0
        new THREE.Vector3(-1, 0, 0), // 1
        new THREE.Vector3(0, 1, 0), // 2
        new THREE.Vector3(0, -1, 0), // 3
        new THREE.Vector3(0, 0, 1), // 4 (Top)
        new THREE.Vector3(0, 0, -1)  // 5 (Bottom)
      ],
      faces: [
        [4, 0, 2], [4, 2, 1], [4, 1, 3], [4, 3, 0], // Top Fan
        [5, 2, 0], [5, 1, 2], [5, 3, 1], [5, 0, 3]  // Bottom Fan
      ]
    };
  },

  // 4. ICOSAHEDRON (12 Verts, 20 Faces)
  // Source: Schneide Blog (Verified standard strip construction)
  // Structure:
  //   0-3: XZ plane rectangle
  //   4-7: YZ plane rectangle
  //   8-11: XY plane rectangle
  icosahedron() {
    const X = 0.525731112119;
    const Z = 0.850650808352;

    return {
      vertices: [
        new THREE.Vector3(-X, 0.0, Z), new THREE.Vector3(X, 0.0, Z), new THREE.Vector3(-X, 0.0, -Z), new THREE.Vector3(X, 0.0, -Z),    // 0-3
        new THREE.Vector3(0.0, Z, X), new THREE.Vector3(0.0, Z, -X), new THREE.Vector3(0.0, -Z, X), new THREE.Vector3(0.0, -Z, -X),    // 4-7
        new THREE.Vector3(Z, X, 0.0), new THREE.Vector3(-Z, X, 0.0), new THREE.Vector3(Z, -X, 0.0), new THREE.Vector3(-Z, -X, 0.0)     // 8-11
      ],
      faces: [
        [0, 1, 4], [0, 4, 9], [9, 4, 5], [4, 8, 5], [4, 1, 8],
        [8, 1, 10], [8, 10, 3], [5, 8, 3], [5, 3, 2], [2, 3, 7],
        [7, 3, 10], [7, 10, 6], [7, 6, 11], [11, 6, 0], [0, 6, 1],
        [6, 10, 1], [9, 11, 0], [9, 2, 11], [9, 5, 2], [7, 11, 2]
      ]
    };
  },

  // 5. DODECAHEDRON (20 Verts, 12 Faces)
  // Source: Geometric Tools (Ref 3.7)
  // Order is CRITICAL here. 
  //   0-7:   Cube vertices (±1, ±1, ±1)
  //   8-11:  (±1/phi, ±phi, 0)   [XY plane]
  //   12-15: (±phi, 0, ±1/phi)   [XZ plane]
  //   16-19: (0, ±1/phi, ±phi)   [YZ plane]
  dodecahedron() {
    const a = 1.0 / Math.sqrt(3.0);     // Cube corners
    const phi = (1.0 + Math.sqrt(5.0)) / 2.0;
    const b = (1.0 / phi) / Math.sqrt(3.0); // scaled 1/phi
    const c = phi / Math.sqrt(3.0);          // scaled phi

    // Note: We re-normalize at the end to be perfectly spherical, 
    // but the constants above ensure correct relative geometry.
    const m = {
      vertices: [
        // Cube Vertices (0-7)
        new THREE.Vector3(a, a, a), new THREE.Vector3(a, a, -a), new THREE.Vector3(a, -a, a), new THREE.Vector3(a, -a, -a), // 0-3
        new THREE.Vector3(-a, a, a), new THREE.Vector3(-a, a, -a), new THREE.Vector3(-a, -a, a), new THREE.Vector3(-a, -a, -a), // 4-7

        // XY Plane Points (8-11) -> (±1/phi, ±phi, 0)
        new THREE.Vector3(b, c, 0.0), new THREE.Vector3(-b, c, 0.0), new THREE.Vector3(b, -c, 0.0), new THREE.Vector3(-b, -c, 0.0),

        // XZ Plane Points (12-15) -> (±phi, 0, ±1/phi)
        new THREE.Vector3(c, 0.0, b), new THREE.Vector3(c, 0.0, -b), new THREE.Vector3(-c, 0.0, b), new THREE.Vector3(-c, 0.0, -b),

        // YZ Plane Points (16-19) -> (0, ±1/phi, ±phi)
        new THREE.Vector3(0.0, b, c), new THREE.Vector3(0.0, -b, c), new THREE.Vector3(0.0, b, -c), new THREE.Vector3(0.0, -b, -c)
      ],
      faces: [
        // 12 Pentagonal Faces (Reversed to CCW winding)
        [0, 8, 9, 4, 16],
        [0, 12, 13, 1, 8],
        [0, 16, 17, 2, 12],
        [8, 1, 18, 5, 9],
        [12, 2, 10, 3, 13],
        [16, 4, 14, 6, 17],
        [9, 5, 15, 14, 4],
        [6, 11, 10, 2, 17],
        [3, 19, 18, 1, 13],
        [7, 15, 5, 18, 19],
        [7, 11, 6, 14, 15],
        [7, 19, 3, 10, 11]
      ]
    };
    this.normalize(m); // Ensure exact unit radius
    return m;
  }
};


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
}
