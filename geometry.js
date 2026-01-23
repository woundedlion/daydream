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
  },

  // --- ARCHIMEDEAN SOLIDS ---

  // 1. Truncated Tetrahedron
  truncatedTetrahedron() {
const m = {
      vertices: [
        new THREE.Vector3(0.3333333, 1, 0.3333333), // 0
        new THREE.Vector3(-1, 0.3333333, -0.3333333), // 1
        new THREE.Vector3(-0.3333333, -0.3333333, 1), // 2
        new THREE.Vector3(0.3333333, 0.3333333, 1), // 3
        new THREE.Vector3(-0.3333333, -1, 0.3333333), // 4
        new THREE.Vector3(1, -0.3333333, -0.3333333), // 5
        new THREE.Vector3(1, 0.3333333, 0.3333333), // 6
        new THREE.Vector3(0.3333333, -0.3333333, -1), // 7
        new THREE.Vector3(-0.3333333, 1, -0.3333333), // 8
        new THREE.Vector3(-1, -0.3333333, 0.3333333), // 9
        new THREE.Vector3(-0.3333333, 0.3333333, -1), // 10
        new THREE.Vector3(0.3333333, -1, -0.3333333) // 11
      ],
      faces: [
        [0, 8, 1, 9, 2, 3],
        [3, 2, 4, 11, 5, 6],
        [6, 5, 7, 10, 8, 0],
        [9, 1, 10, 7, 11, 4],
        [3, 6, 0],
        [8, 10, 1],
        [9, 4, 2],
        [11, 7, 5]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 2. Cuboctahedron
  cuboctahedron() {
    const m = {
      vertices: [
        new THREE.Vector3(-0.7071068, 0, -0.7071068), // 0
        new THREE.Vector3(0, 0.7071068, -0.7071068), // 1
        new THREE.Vector3(0.7071068, 0, -0.7071068), // 2
        new THREE.Vector3(0, -0.7071068, -0.7071068), // 3
        new THREE.Vector3(0.7071068, -0.7071068, 0), // 4
        new THREE.Vector3(0, -0.7071068, 0.7071068), // 5
        new THREE.Vector3(-0.7071068, -0.7071068, 0), // 6
        new THREE.Vector3(-0.7071068, 0, 0.7071068), // 7
        new THREE.Vector3(-0.7071068, 0.7071068, 0), // 8
        new THREE.Vector3(0.7071068, 0, 0.7071068), // 9
        new THREE.Vector3(0.7071068, 0.7071068, 0), // 10
        new THREE.Vector3(0, 0.7071068, 0.7071068) // 11
      ],
      faces: [
        [0, 1, 2, 3],
        [3, 4, 5, 6],
        [6, 7, 8, 0],
        [9, 4, 2, 10],
        [10, 1, 8, 11],
        [11, 7, 5, 9],
        [3, 6, 0],
        [0, 8, 1],
        [1, 10, 2],
        [2, 4, 3],
        [4, 9, 5],
        [5, 7, 6],
        [7, 11, 8],
        [10, 11, 9]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 3. Truncated Cube
  truncatedCube() {
    const m = {
      vertices: [
        new THREE.Vector3(-0.6785983, -0.2810846, -0.6785983), // 0
        new THREE.Vector3(-0.2810846, 0.6785983, -0.6785983), // 1
        new THREE.Vector3(0.6785983, 0.2810846, -0.6785983), // 2
        new THREE.Vector3(0.2810846, -0.6785983, -0.6785983), // 3
        new THREE.Vector3(-0.2810846, -0.6785983, -0.6785983), // 4
        new THREE.Vector3(0.6785983, -0.6785983, -0.2810846), // 5
        new THREE.Vector3(0.2810846, -0.6785983, 0.6785983), // 6
        new THREE.Vector3(-0.6785983, -0.6785983, 0.2810846), // 7
        new THREE.Vector3(-0.6785983, -0.6785983, -0.2810846), // 8
        new THREE.Vector3(-0.6785983, -0.2810846, 0.6785983), // 9
        new THREE.Vector3(-0.6785983, 0.6785983, 0.2810846), // 10
        new THREE.Vector3(-0.6785983, 0.2810846, -0.6785983), // 11
        new THREE.Vector3(0.6785983, 0.2810846, 0.6785983), // 12
        new THREE.Vector3(0.6785983, -0.6785983, 0.2810846), // 13
        new THREE.Vector3(0.6785983, -0.2810846, -0.6785983), // 14
        new THREE.Vector3(0.6785983, 0.6785983, -0.2810846), // 15
        new THREE.Vector3(0.6785983, 0.6785983, 0.2810846), // 16
        new THREE.Vector3(0.2810846, 0.6785983, -0.6785983), // 17
        new THREE.Vector3(-0.6785983, 0.6785983, -0.2810846), // 18
        new THREE.Vector3(-0.2810846, 0.6785983, 0.6785983), // 19
        new THREE.Vector3(0.2810846, 0.6785983, 0.6785983), // 20
        new THREE.Vector3(-0.6785983, 0.2810846, 0.6785983), // 21
        new THREE.Vector3(-0.2810846, -0.6785983, 0.6785983), // 22
        new THREE.Vector3(0.6785983, -0.2810846, 0.6785983) // 23
      ],
      faces: [
        [0, 11, 1, 17, 2, 14, 3, 4],
        [4, 3, 5, 13, 6, 22, 7, 8],
        [8, 7, 9, 21, 10, 18, 11, 0],
        [12, 23, 13, 5, 14, 2, 15, 16],
        [16, 15, 17, 1, 18, 10, 19, 20],
        [20, 19, 21, 9, 22, 6, 23, 12],
        [4, 8, 0],
        [11, 18, 1],
        [17, 15, 2],
        [14, 5, 3],
        [13, 23, 6],
        [22, 9, 7],
        [21, 19, 10],
        [16, 20, 12]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 4. Truncated Octahedron
  truncatedOctahedron() {
    const m = {
      vertices: [
        new THREE.Vector3(0.4472136, 0, 0.8944272), // 0
        new THREE.Vector3(0.8944272, 0.4472136, 0), // 1
        new THREE.Vector3(0, 0.8944272, 0.4472136), // 2
        new THREE.Vector3(0, 0.4472136, 0.8944272), // 3
        new THREE.Vector3(-0.4472136, 0.8944272, 0), // 4
        new THREE.Vector3(-0.8944272, 0, 0.4472136), // 5
        new THREE.Vector3(-0.4472136, 0, 0.8944272), // 6
        new THREE.Vector3(-0.8944272, -0.4472136, 0), // 7
        new THREE.Vector3(0, -0.8944272, 0.4472136), // 8
        new THREE.Vector3(0, -0.4472136, 0.8944272), // 9
        new THREE.Vector3(0.4472136, -0.8944272, 0), // 10
        new THREE.Vector3(0.8944272, 0, 0.4472136), // 11
        new THREE.Vector3(0, 0.4472136, -0.8944272), // 12
        new THREE.Vector3(0.4472136, 0.8944272, 0), // 13
        new THREE.Vector3(0.8944272, 0, -0.4472136), // 14
        new THREE.Vector3(-0.4472136, 0, -0.8944272), // 15
        new THREE.Vector3(-0.8944272, 0.4472136, 0), // 16
        new THREE.Vector3(0, 0.8944272, -0.4472136), // 17
        new THREE.Vector3(0, -0.4472136, -0.8944272), // 18
        new THREE.Vector3(-0.4472136, -0.8944272, 0), // 19
        new THREE.Vector3(-0.8944272, 0, -0.4472136), // 20
        new THREE.Vector3(0.4472136, 0, -0.8944272), // 21
        new THREE.Vector3(0.8944272, -0.4472136, 0), // 22
        new THREE.Vector3(0, -0.8944272, -0.4472136) // 23
      ],
      faces: [
        [0, 11, 1, 13, 2, 3],
        [3, 2, 4, 16, 5, 6],
        [6, 5, 7, 19, 8, 9],
        [9, 8, 10, 22, 11, 0],
        [12, 17, 13, 1, 14, 21],
        [15, 20, 16, 4, 17, 12],
        [18, 23, 19, 7, 20, 15],
        [21, 14, 22, 10, 23, 18],
        [3, 6, 9, 0],
        [11, 22, 14, 1],
        [13, 17, 4, 2],
        [16, 20, 7, 5],
        [19, 23, 10, 8],
        [21, 18, 15, 12]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 5. Rhombicuboctahedron
  rhombicuboctahedron() {
    const m = {
      vertices: [
        new THREE.Vector3(-0.3574067, 0.3574067, -0.8628562), // 0
        new THREE.Vector3(0.3574067, 0.3574067, -0.8628562), // 1
        new THREE.Vector3(0.3574067, -0.3574067, -0.8628562), // 2
        new THREE.Vector3(-0.3574067, -0.3574067, -0.8628562), // 3
        new THREE.Vector3(0.3574067, -0.8628562, -0.3574067), // 4
        new THREE.Vector3(0.3574067, -0.8628562, 0.3574067), // 5
        new THREE.Vector3(-0.3574067, -0.8628562, 0.3574067), // 6
        new THREE.Vector3(-0.3574067, -0.8628562, -0.3574067), // 7
        new THREE.Vector3(-0.8628562, -0.3574067, 0.3574067), // 8
        new THREE.Vector3(-0.8628562, 0.3574067, 0.3574067), // 9
        new THREE.Vector3(-0.8628562, 0.3574067, -0.3574067), // 10
        new THREE.Vector3(-0.8628562, -0.3574067, -0.3574067), // 11
        new THREE.Vector3(0.8628562, -0.3574067, 0.3574067), // 12
        new THREE.Vector3(0.8628562, -0.3574067, -0.3574067), // 13
        new THREE.Vector3(0.8628562, 0.3574067, -0.3574067), // 14
        new THREE.Vector3(0.8628562, 0.3574067, 0.3574067), // 15
        new THREE.Vector3(0.3574067, 0.8628562, -0.3574067), // 16
        new THREE.Vector3(-0.3574067, 0.8628562, -0.3574067), // 17
        new THREE.Vector3(-0.3574067, 0.8628562, 0.3574067), // 18
        new THREE.Vector3(0.3574067, 0.8628562, 0.3574067), // 19
        new THREE.Vector3(-0.3574067, 0.3574067, 0.8628562), // 20
        new THREE.Vector3(-0.3574067, -0.3574067, 0.8628562), // 21
        new THREE.Vector3(0.3574067, -0.3574067, 0.8628562), // 22
        new THREE.Vector3(0.3574067, 0.3574067, 0.8628562) // 23
      ],
      faces: [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10, 11],
        [12, 13, 14, 15],
        [16, 17, 18, 19],
        [20, 21, 22, 23],
        [7, 11, 3],
        [10, 17, 0],
        [16, 14, 1],
        [13, 4, 2],
        [12, 22, 5],
        [21, 8, 6],
        [20, 18, 9],
        [19, 23, 15],
        [3, 11, 10, 0],
        [0, 17, 16, 1],
        [1, 14, 13, 2],
        [2, 4, 7, 3],
        [4, 13, 12, 5],
        [5, 22, 21, 6],
        [6, 8, 11, 7],
        [8, 21, 20, 9],
        [9, 18, 17, 10],
        [15, 23, 22, 12],
        [14, 16, 19, 15],
        [18, 20, 23, 19]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 6. Truncated Cuboctahedron (Great Rhombicuboctahedron)
  truncatedCuboctahedron() {
    const m = {
      vertices: [
        new THREE.Vector3(-0.520841, 0.2157394, -0.8259426), // 0
        new THREE.Vector3(0.2157394, 0.520841, -0.8259426), // 1
        new THREE.Vector3(0.520841, -0.2157394, -0.8259426), // 2
        new THREE.Vector3(-0.2157394, -0.520841, -0.8259426), // 3
        new THREE.Vector3(0.2157394, -0.8259426, -0.520841), // 4
        new THREE.Vector3(0.520841, -0.8259426, 0.2157394), // 5
        new THREE.Vector3(-0.2157394, -0.8259426, 0.520841), // 6
        new THREE.Vector3(-0.520841, -0.8259426, -0.2157394), // 7
        new THREE.Vector3(-0.8259426, -0.520841, 0.2157394), // 8
        new THREE.Vector3(-0.8259426, 0.2157394, 0.520841), // 9
        new THREE.Vector3(-0.8259426, 0.520841, -0.2157394), // 10
        new THREE.Vector3(-0.8259426, -0.2157394, -0.520841), // 11
        new THREE.Vector3(0.8259426, -0.2157394, 0.520841), // 12
        new THREE.Vector3(0.8259426, -0.520841, -0.2157394), // 13
        new THREE.Vector3(0.8259426, 0.2157394, -0.520841), // 14
        new THREE.Vector3(0.8259426, 0.520841, 0.2157394), // 15
        new THREE.Vector3(0.520841, 0.8259426, -0.2157394), // 16
        new THREE.Vector3(-0.2157394, 0.8259426, -0.520841), // 17
        new THREE.Vector3(-0.520841, 0.8259426, 0.2157394), // 18
        new THREE.Vector3(0.2157394, 0.8259426, 0.520841), // 19
        new THREE.Vector3(-0.2157394, 0.520841, 0.8259426), // 20
        new THREE.Vector3(-0.520841, -0.2157394, 0.8259426), // 21
        new THREE.Vector3(0.2157394, -0.520841, 0.8259426), // 22
        new THREE.Vector3(0.520841, 0.2157394, 0.8259426), // 23
        new THREE.Vector3(-0.2157394, -0.8259426, -0.520841), // 24
        new THREE.Vector3(-0.8259426, -0.520841, -0.2157394), // 25
        new THREE.Vector3(-0.520841, -0.2157394, -0.8259426), // 26
        new THREE.Vector3(-0.8259426, 0.2157394, -0.520841), // 27
        new THREE.Vector3(-0.520841, 0.8259426, -0.2157394), // 28
        new THREE.Vector3(-0.2157394, 0.520841, -0.8259426), // 29
        new THREE.Vector3(0.2157394, 0.8259426, -0.520841), // 30
        new THREE.Vector3(0.8259426, 0.520841, -0.2157394), // 31
        new THREE.Vector3(0.520841, 0.2157394, -0.8259426), // 32
        new THREE.Vector3(0.8259426, -0.2157394, -0.520841), // 33
        new THREE.Vector3(0.520841, -0.8259426, -0.2157394), // 34
        new THREE.Vector3(0.2157394, -0.520841, -0.8259426), // 35
        new THREE.Vector3(0.8259426, -0.520841, 0.2157394), // 36
        new THREE.Vector3(0.520841, -0.2157394, 0.8259426), // 37
        new THREE.Vector3(0.2157394, -0.8259426, 0.520841), // 38
        new THREE.Vector3(-0.2157394, -0.520841, 0.8259426), // 39
        new THREE.Vector3(-0.8259426, -0.2157394, 0.520841), // 40
        new THREE.Vector3(-0.520841, -0.8259426, 0.2157394), // 41
        new THREE.Vector3(-0.520841, 0.2157394, 0.8259426), // 42
        new THREE.Vector3(-0.2157394, 0.8259426, 0.520841), // 43
        new THREE.Vector3(-0.8259426, 0.520841, 0.2157394), // 44
        new THREE.Vector3(0.520841, 0.8259426, 0.2157394), // 45
        new THREE.Vector3(0.2157394, 0.520841, 0.8259426), // 46
        new THREE.Vector3(0.8259426, 0.2157394, 0.520841) // 47
      ],
      faces: [
        [0, 29, 1, 32, 2, 35, 3, 26],
        [4, 34, 5, 38, 6, 41, 7, 24],
        [8, 40, 9, 44, 10, 27, 11, 25],
        [12, 36, 13, 33, 14, 31, 15, 47],
        [16, 30, 17, 28, 18, 43, 19, 45],
        [20, 42, 21, 39, 22, 37, 23, 46],
        [24, 7, 25, 11, 26, 3],
        [27, 10, 28, 17, 29, 0],
        [30, 16, 31, 14, 32, 1],
        [33, 13, 34, 4, 35, 2],
        [36, 12, 37, 22, 38, 5],
        [39, 21, 40, 8, 41, 6],
        [42, 20, 43, 18, 44, 9],
        [45, 19, 46, 23, 47, 15],
        [26, 11, 27, 0],
        [29, 17, 30, 1],
        [32, 14, 33, 2],
        [35, 4, 24, 3],
        [34, 13, 36, 5],
        [38, 22, 39, 6],
        [41, 8, 25, 7],
        [40, 21, 42, 9],
        [44, 18, 28, 10],
        [47, 23, 37, 12],
        [31, 16, 45, 15],
        [43, 20, 46, 19]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 7. Snub Cube
  snubCube() {
    const m = {
      vertices: [
        new THREE.Vector3(-0.4623206, -0.2513586, -0.8503402), // 0
        new THREE.Vector3(-0.2513586, 0.4623206, -0.8503402), // 1
        new THREE.Vector3(0.4623206, 0.2513586, -0.8503402), // 2
        new THREE.Vector3(0.2513586, -0.4623206, -0.8503402), // 3
        new THREE.Vector3(-0.2513586, -0.8503402, -0.4623206), // 4
        new THREE.Vector3(0.4623206, -0.8503402, -0.2513586), // 5
        new THREE.Vector3(0.2513586, -0.8503402, 0.4623206), // 6
        new THREE.Vector3(-0.4623206, -0.8503402, 0.2513586), // 7
        new THREE.Vector3(-0.8503402, -0.4623206, -0.2513586), // 8
        new THREE.Vector3(-0.8503402, -0.2513586, 0.4623206), // 9
        new THREE.Vector3(-0.8503402, 0.4623206, 0.2513586), // 10
        new THREE.Vector3(-0.8503402, 0.2513586, -0.4623206), // 11
        new THREE.Vector3(0.8503402, 0.2513586, 0.4623206), // 12
        new THREE.Vector3(0.8503402, -0.4623206, 0.2513586), // 13
        new THREE.Vector3(0.8503402, -0.2513586, -0.4623206), // 14
        new THREE.Vector3(0.8503402, 0.4623206, -0.2513586), // 15
        new THREE.Vector3(0.4623206, 0.8503402, 0.2513586), // 16
        new THREE.Vector3(0.2513586, 0.8503402, -0.4623206), // 17
        new THREE.Vector3(-0.4623206, 0.8503402, -0.2513586), // 18
        new THREE.Vector3(-0.2513586, 0.8503402, 0.4623206), // 19
        new THREE.Vector3(0.2513586, 0.4623206, 0.8503402), // 20
        new THREE.Vector3(-0.4623206, 0.2513586, 0.8503402), // 21
        new THREE.Vector3(-0.2513586, -0.4623206, 0.8503402), // 22
        new THREE.Vector3(0.4623206, -0.2513586, 0.8503402) // 23
      ],
      faces: [
        [0, 1, 2, 3],
        [4, 5, 6, 7],
        [8, 9, 10, 11],
        [12, 13, 14, 15],
        [16, 17, 18, 19],
        [20, 21, 22, 23],
        [4, 8, 0],
        [11, 18, 1],
        [17, 15, 2],
        [14, 5, 3],
        [13, 23, 6],
        [22, 9, 7],
        [21, 19, 10],
        [16, 20, 12],
        [0, 8, 11],
        [0, 11, 1],
        [1, 18, 17],
        [1, 17, 2],
        [2, 15, 14],
        [2, 14, 3],
        [3, 5, 4],
        [3, 4, 0],
        [5, 14, 13],
        [5, 13, 6],
        [6, 23, 22],
        [6, 22, 7],
        [7, 9, 8],
        [7, 8, 4],
        [9, 22, 21],
        [9, 21, 10],
        [10, 19, 18],
        [10, 18, 11],
        [12, 20, 23],
        [12, 23, 13],
        [15, 17, 16],
        [15, 16, 12],
        [19, 21, 20],
        [19, 20, 16]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 8. Icosidodecahedron
  icosidodecahedron() {
    const m = {
      vertices: [
        new THREE.Vector3(0.5, 0.809017, 0.309017), // 0
        new THREE.Vector3(0, 1, 0), // 1
        new THREE.Vector3(-0.5, 0.809017, 0.309017), // 2
        new THREE.Vector3(-0.309017, 0.5, 0.809017), // 3
        new THREE.Vector3(0.309017, 0.5, 0.809017), // 4
        new THREE.Vector3(0.809017, 0.309017, 0.5), // 5
        new THREE.Vector3(1, 0, 0), // 6
        new THREE.Vector3(0.809017, 0.309017, -0.5), // 7
        new THREE.Vector3(0.5, 0.809017, -0.309017), // 8
        new THREE.Vector3(0, 0, 1), // 9
        new THREE.Vector3(0.309017, -0.5, 0.809017), // 10
        new THREE.Vector3(0.809017, -0.309017, 0.5), // 11
        new THREE.Vector3(0.309017, 0.5, -0.809017), // 12
        new THREE.Vector3(-0.309017, 0.5, -0.809017), // 13
        new THREE.Vector3(-0.5, 0.809017, -0.309017), // 14
        new THREE.Vector3(0.5, -0.809017, 0.309017), // 15
        new THREE.Vector3(0.5, -0.809017, -0.309017), // 16
        new THREE.Vector3(0.809017, -0.309017, -0.5), // 17
        new THREE.Vector3(-0.809017, 0.309017, 0.5), // 18
        new THREE.Vector3(-0.809017, -0.309017, 0.5), // 19
        new THREE.Vector3(-0.309017, -0.5, 0.809017), // 20
        new THREE.Vector3(-0.809017, 0.309017, -0.5), // 21
        new THREE.Vector3(-1, 0, 0), // 22
        new THREE.Vector3(-0.5, -0.809017, 0.309017), // 23
        new THREE.Vector3(0, -1, 0), // 24
        new THREE.Vector3(0.309017, -0.5, -0.809017), // 25
        new THREE.Vector3(0, 0, -1), // 26
        new THREE.Vector3(-0.809017, -0.309017, -0.5), // 27
        new THREE.Vector3(-0.309017, -0.5, -0.809017), // 28
        new THREE.Vector3(-0.5, -0.809017, -0.309017) // 29
      ],
      faces: [
        [0, 1, 2, 3, 4],
        [5, 6, 7, 8, 0],
        [4, 9, 10, 11, 5],
        [8, 12, 13, 14, 1],
        [11, 15, 16, 17, 6],
        [3, 18, 19, 20, 9],
        [14, 21, 22, 18, 2],
        [23, 24, 15, 10, 20],
        [25, 26, 12, 7, 17],
        [27, 21, 13, 26, 28],
        [29, 23, 19, 22, 27],
        [28, 25, 16, 24, 29],
        [4, 5, 0],
        [0, 8, 1],
        [1, 14, 2],
        [2, 18, 3],
        [3, 9, 4],
        [5, 11, 6],
        [6, 17, 7],
        [7, 12, 8],
        [9, 20, 10],
        [10, 15, 11],
        [12, 26, 13],
        [13, 21, 14],
        [15, 24, 16],
        [16, 25, 17],
        [18, 22, 19],
        [19, 23, 20],
        [21, 27, 22],
        [23, 29, 24],
        [25, 28, 26],
        [28, 29, 27]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 9. Truncated Dodecahedron
  truncatedDodecahedron() {
    const m = {
      vertices: [
        new THREE.Vector3(0.5448937, 0.7132751, 0.4408282), // 0
        new THREE.Vector3(0.1683814, 0.9857219, 0), // 1
        new THREE.Vector3(-0.4408282, 0.8816565, 0.1683814), // 2
        new THREE.Vector3(-0.4408282, 0.5448937, 0.7132751), // 3
        new THREE.Vector3(0.1683814, 0.4408282, 0.8816565), // 4
        new THREE.Vector3(0.7132751, 0.4408282, 0.5448937), // 5
        new THREE.Vector3(0.9857219, 0, 0.1683814), // 6
        new THREE.Vector3(0.8816565, 0.1683814, -0.4408282), // 7
        new THREE.Vector3(0.5448937, 0.7132751, -0.4408282), // 8
        new THREE.Vector3(0.4408282, 0.8816565, 0.1683814), // 9
        new THREE.Vector3(0.4408282, 0.5448937, 0.7132751), // 10
        new THREE.Vector3(0, 0.1683814, 0.9857219), // 11
        new THREE.Vector3(0.1683814, -0.4408282, 0.8816565), // 12
        new THREE.Vector3(0.7132751, -0.4408282, 0.5448937), // 13
        new THREE.Vector3(0.8816565, 0.1683814, 0.4408282), // 14
        new THREE.Vector3(0.4408282, 0.8816565, -0.1683814), // 15
        new THREE.Vector3(0.4408282, 0.5448937, -0.7132751), // 16
        new THREE.Vector3(-0.1683814, 0.4408282, -0.8816565), // 17
        new THREE.Vector3(-0.5448937, 0.7132751, -0.4408282), // 18
        new THREE.Vector3(-0.1683814, 0.9857219, 0), // 19
        new THREE.Vector3(0.8816565, -0.1683814, 0.4408282), // 20
        new THREE.Vector3(0.5448937, -0.7132751, 0.4408282), // 21
        new THREE.Vector3(0.4408282, -0.8816565, -0.1683814), // 22
        new THREE.Vector3(0.7132751, -0.4408282, -0.5448937), // 23
        new THREE.Vector3(0.9857219, 0, -0.1683814), // 24
        new THREE.Vector3(-0.1683814, 0.4408282, 0.8816565), // 25
        new THREE.Vector3(-0.7132751, 0.4408282, 0.5448937), // 26
        new THREE.Vector3(-0.8816565, -0.1683814, 0.4408282), // 27
        new THREE.Vector3(-0.4408282, -0.5448937, 0.7132751), // 28
        new THREE.Vector3(0, -0.1683814, 0.9857219), // 29
        new THREE.Vector3(-0.4408282, 0.8816565, -0.1683814), // 30
        new THREE.Vector3(-0.7132751, 0.4408282, -0.5448937), // 31
        new THREE.Vector3(-0.9857219, 0, -0.1683814), // 32
        new THREE.Vector3(-0.8816565, 0.1683814, 0.4408282), // 33
        new THREE.Vector3(-0.5448937, 0.7132751, 0.4408282), // 34
        new THREE.Vector3(-0.5448937, -0.7132751, 0.4408282), // 35
        new THREE.Vector3(-0.1683814, -0.9857219, 0), // 36
        new THREE.Vector3(0.4408282, -0.8816565, 0.1683814), // 37
        new THREE.Vector3(0.4408282, -0.5448937, 0.7132751), // 38
        new THREE.Vector3(-0.1683814, -0.4408282, 0.8816565), // 39
        new THREE.Vector3(0.4408282, -0.5448937, -0.7132751), // 40
        new THREE.Vector3(0, -0.1683814, -0.9857219), // 41
        new THREE.Vector3(0.1683814, 0.4408282, -0.8816565), // 42
        new THREE.Vector3(0.7132751, 0.4408282, -0.5448937), // 43
        new THREE.Vector3(0.8816565, -0.1683814, -0.4408282), // 44
        new THREE.Vector3(-0.7132751, -0.4408282, -0.5448937), // 45
        new THREE.Vector3(-0.8816565, 0.1683814, -0.4408282), // 46
        new THREE.Vector3(-0.4408282, 0.5448937, -0.7132751), // 47
        new THREE.Vector3(0, 0.1683814, -0.9857219), // 48
        new THREE.Vector3(-0.1683814, -0.4408282, -0.8816565), // 49
        new THREE.Vector3(-0.5448937, -0.7132751, -0.4408282), // 50
        new THREE.Vector3(-0.4408282, -0.8816565, 0.1683814), // 51
        new THREE.Vector3(-0.7132751, -0.4408282, 0.5448937), // 52
        new THREE.Vector3(-0.9857219, 0, 0.1683814), // 53
        new THREE.Vector3(-0.8816565, -0.1683814, -0.4408282), // 54
        new THREE.Vector3(-0.4408282, -0.5448937, -0.7132751), // 55
        new THREE.Vector3(0.1683814, -0.4408282, -0.8816565), // 56
        new THREE.Vector3(0.5448937, -0.7132751, -0.4408282), // 57
        new THREE.Vector3(0.1683814, -0.9857219, 0), // 58
        new THREE.Vector3(-0.4408282, -0.8816565, -0.1683814) // 59
      ],
      faces: [
        [0, 9, 1, 19, 2, 34, 3, 25, 4, 10],
        [5, 14, 6, 24, 7, 43, 8, 15, 9, 0],
        [10, 4, 11, 29, 12, 38, 13, 20, 14, 5],
        [15, 8, 16, 42, 17, 47, 18, 30, 19, 1],
        [20, 13, 21, 37, 22, 57, 23, 44, 24, 6],
        [25, 3, 26, 33, 27, 52, 28, 39, 29, 11],
        [30, 18, 31, 46, 32, 53, 33, 26, 34, 2],
        [35, 51, 36, 58, 37, 21, 38, 12, 39, 28],
        [40, 56, 41, 48, 42, 16, 43, 7, 44, 23],
        [45, 54, 46, 31, 47, 17, 48, 41, 49, 55],
        [50, 59, 51, 35, 52, 27, 53, 32, 54, 45],
        [55, 49, 56, 40, 57, 22, 58, 36, 59, 50],
        [10, 5, 0],
        [9, 15, 1],
        [19, 30, 2],
        [34, 26, 3],
        [25, 11, 4],
        [14, 20, 6],
        [24, 44, 7],
        [43, 16, 8],
        [29, 39, 12],
        [38, 21, 13],
        [42, 48, 17],
        [47, 31, 18],
        [37, 58, 22],
        [57, 40, 23],
        [33, 53, 27],
        [52, 35, 28],
        [46, 54, 32],
        [51, 59, 36],
        [56, 49, 41],
        [55, 50, 45]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 10. Truncated Icosahedron (Soccer Ball)
  truncatedIcosahedron() {
    const m = {
      vertices: [
        new THREE.Vector3(-0.2017741, 0, 0.9794321), // 0
        new THREE.Vector3(0.4035482, 0.3264774, 0.8547288), // 1
        new THREE.Vector3(-0.2017741, 0.6529547, 0.7300256), // 2
        new THREE.Vector3(-0.4035482, 0.3264774, 0.8547288), // 3
        new THREE.Vector3(-0.3264774, 0.8547288, 0.4035482), // 4
        new THREE.Vector3(-0.8547288, 0.4035482, 0.3264774), // 5
        new THREE.Vector3(-0.6529547, 0.7300256, 0.2017741), // 6
        new THREE.Vector3(0, 0.9794321, 0.2017741), // 7
        new THREE.Vector3(-0.3264774, 0.8547288, -0.4035482), // 8
        new THREE.Vector3(0.3264774, 0.8547288, 0.4035482), // 9
        new THREE.Vector3(0.6529547, 0.7300256, -0.2017741), // 10
        new THREE.Vector3(0, 0.9794321, -0.2017741), // 11
        new THREE.Vector3(0.2017741, 0.6529547, 0.7300256), // 12
        new THREE.Vector3(0.7300256, 0.2017741, 0.6529547), // 13
        new THREE.Vector3(0.6529547, 0.7300256, 0.2017741), // 14
        new THREE.Vector3(0.8547288, 0.4035482, 0.3264774), // 15
        new THREE.Vector3(0.7300256, -0.2017741, 0.6529547), // 16
        new THREE.Vector3(0.9794321, -0.2017741, 0), // 17
        new THREE.Vector3(0.9794321, 0.2017741, 0), // 18
        new THREE.Vector3(0.8547288, -0.4035482, -0.3264774), // 19
        new THREE.Vector3(0.7300256, 0.2017741, -0.6529547), // 20
        new THREE.Vector3(0.3264774, 0.8547288, -0.4035482), // 21
        new THREE.Vector3(0.8547288, 0.4035482, -0.3264774), // 22
        new THREE.Vector3(0.4035482, 0.3264774, -0.8547288), // 23
        new THREE.Vector3(0.2017741, 0.6529547, -0.7300256), // 24
        new THREE.Vector3(0.2017741, 0, -0.9794321), // 25
        new THREE.Vector3(-0.4035482, 0.3264774, -0.8547288), // 26
        new THREE.Vector3(-0.2017741, 0, -0.9794321), // 27
        new THREE.Vector3(0.4035482, -0.3264774, -0.8547288), // 28
        new THREE.Vector3(-0.2017741, -0.6529547, -0.7300256), // 29
        new THREE.Vector3(0.2017741, -0.6529547, -0.7300256), // 30
        new THREE.Vector3(0.7300256, -0.2017741, -0.6529547), // 31
        new THREE.Vector3(0.6529547, -0.7300256, -0.2017741), // 32
        new THREE.Vector3(0.3264774, -0.8547288, -0.4035482), // 33
        new THREE.Vector3(0.6529547, -0.7300256, 0.2017741), // 34
        new THREE.Vector3(0, -0.9794321, 0.2017741), // 35
        new THREE.Vector3(0, -0.9794321, -0.2017741), // 36
        new THREE.Vector3(-0.3264774, -0.8547288, 0.4035482), // 37
        new THREE.Vector3(-0.6529547, -0.7300256, -0.2017741), // 38
        new THREE.Vector3(-0.6529547, -0.7300256, 0.2017741), // 39
        new THREE.Vector3(-0.2017741, -0.6529547, 0.7300256), // 40
        new THREE.Vector3(-0.7300256, -0.2017741, 0.6529547), // 41
        new THREE.Vector3(-0.4035482, -0.3264774, 0.8547288), // 42
        new THREE.Vector3(0.2017741, -0.6529547, 0.7300256), // 43
        new THREE.Vector3(0.2017741, 0, 0.9794321), // 44
        new THREE.Vector3(0.3264774, -0.8547288, 0.4035482), // 45
        new THREE.Vector3(0.8547288, -0.4035482, 0.3264774), // 46
        new THREE.Vector3(0.4035482, -0.3264774, 0.8547288), // 47
        new THREE.Vector3(-0.9794321, 0.2017741, 0), // 48
        new THREE.Vector3(-0.8547288, -0.4035482, 0.3264774), // 49
        new THREE.Vector3(-0.7300256, 0.2017741, 0.6529547), // 50
        new THREE.Vector3(-0.8547288, 0.4035482, -0.3264774), // 51
        new THREE.Vector3(-0.7300256, -0.2017741, -0.6529547), // 52
        new THREE.Vector3(-0.9794321, -0.2017741, 0), // 53
        new THREE.Vector3(-0.6529547, 0.7300256, -0.2017741), // 54
        new THREE.Vector3(-0.2017741, 0.6529547, -0.7300256), // 55
        new THREE.Vector3(-0.7300256, 0.2017741, -0.6529547), // 56
        new THREE.Vector3(-0.3264774, -0.8547288, -0.4035482), // 57
        new THREE.Vector3(-0.8547288, -0.4035482, -0.3264774), // 58
        new THREE.Vector3(-0.4035482, -0.3264774, -0.8547288) // 59
      ],
      faces: [
        [0, 44, 1, 12, 2, 3],
        [3, 2, 4, 6, 5, 50],
        [6, 4, 7, 11, 8, 54],
        [9, 14, 10, 21, 11, 7],
        [12, 1, 13, 15, 14, 9],
        [15, 13, 16, 46, 17, 18],
        [18, 17, 19, 31, 20, 22],
        [21, 10, 22, 20, 23, 24],
        [24, 23, 25, 27, 26, 55],
        [27, 25, 28, 30, 29, 59],
        [30, 28, 31, 19, 32, 33],
        [33, 32, 34, 45, 35, 36],
        [36, 35, 37, 39, 38, 57],
        [39, 37, 40, 42, 41, 49],
        [42, 40, 43, 47, 44, 0],
        [45, 34, 46, 16, 47, 43],
        [48, 53, 49, 41, 50, 5],
        [51, 56, 52, 58, 53, 48],
        [54, 8, 55, 26, 56, 51],
        [57, 38, 58, 52, 59, 29],
        [3, 50, 41, 42, 0],
        [44, 47, 16, 13, 1],
        [12, 9, 7, 4, 2],
        [6, 54, 51, 48, 5],
        [11, 21, 24, 55, 8],
        [14, 15, 18, 22, 10],
        [46, 34, 32, 19, 17],
        [31, 28, 25, 23, 20],
        [27, 59, 52, 56, 26],
        [30, 33, 36, 57, 29],
        [45, 43, 40, 37, 35],
        [39, 49, 53, 58, 38]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 11. Rhombicosidodecahedron
  rhombicosidodecahedron() {
const m = {
          vertices: [
            new THREE.Vector3(0.223919, 0.948536, 0.223919), // 0
            new THREE.Vector3(-0.223919, 0.948536, 0.223919), // 1
            new THREE.Vector3(-0.3623085, 0.724617, 0.5862275), // 2
            new THREE.Vector3(0, 0.5862275, 0.8101465), // 3
            new THREE.Vector3(0.3623085, 0.724617, 0.5862275), // 4
            new THREE.Vector3(0.948536, 0.223919, 0.223919), // 5
            new THREE.Vector3(0.948536, 0.223919, -0.223919), // 6
            new THREE.Vector3(0.724617, 0.5862275, -0.3623085), // 7
            new THREE.Vector3(0.5862275, 0.8101465, 0), // 8
            new THREE.Vector3(0.724617, 0.5862275, 0.3623085), // 9
            new THREE.Vector3(0.223919, 0.223919, 0.948536), // 10
            new THREE.Vector3(0.223919, -0.223919, 0.948536), // 11
            new THREE.Vector3(0.5862275, -0.3623085, 0.724617), // 12
            new THREE.Vector3(0.8101465, 0, 0.5862275), // 13
            new THREE.Vector3(0.5862275, 0.3623085, 0.724617), // 14
            new THREE.Vector3(0.3623085, 0.724617, -0.5862275), // 15
            new THREE.Vector3(0, 0.5862275, -0.8101465), // 16
            new THREE.Vector3(-0.3623085, 0.724617, -0.5862275), // 17
            new THREE.Vector3(-0.223919, 0.948536, -0.223919), // 18
            new THREE.Vector3(0.223919, 0.948536, -0.223919), // 19
            new THREE.Vector3(0.724617, -0.5862275, 0.3623085), // 20
            new THREE.Vector3(0.5862275, -0.8101465, 0), // 21
            new THREE.Vector3(0.724617, -0.5862275, -0.3623085), // 22
            new THREE.Vector3(0.948536, -0.223919, -0.223919), // 23
            new THREE.Vector3(0.948536, -0.223919, 0.223919), // 24
            new THREE.Vector3(-0.5862275, 0.3623085, 0.724617), // 25
            new THREE.Vector3(-0.8101465, 0, 0.5862275), // 26
            new THREE.Vector3(-0.5862275, -0.3623085, 0.724617), // 27
            new THREE.Vector3(-0.223919, -0.223919, 0.948536), // 28
            new THREE.Vector3(-0.223919, 0.223919, 0.948536), // 29
            new THREE.Vector3(-0.724617, 0.5862275, -0.3623085), // 30
            new THREE.Vector3(-0.948536, 0.223919, -0.223919), // 31
            new THREE.Vector3(-0.948536, 0.223919, 0.223919), // 32
            new THREE.Vector3(-0.724617, 0.5862275, 0.3623085), // 33
            new THREE.Vector3(-0.5862275, 0.8101465, 0), // 34
            new THREE.Vector3(-0.223919, -0.948536, 0.223919), // 35
            new THREE.Vector3(0.223919, -0.948536, 0.223919), // 36
            new THREE.Vector3(0.3623085, -0.724617, 0.5862275), // 37
            new THREE.Vector3(0, -0.5862275, 0.8101465), // 38
            new THREE.Vector3(-0.3623085, -0.724617, 0.5862275), // 39
            new THREE.Vector3(0.223919, -0.223919, -0.948536), // 40
            new THREE.Vector3(0.223919, 0.223919, -0.948536), // 41
            new THREE.Vector3(0.5862275, 0.3623085, -0.724617), // 42
            new THREE.Vector3(0.8101465, 0, -0.5862275), // 43
            new THREE.Vector3(0.5862275, -0.3623085, -0.724617), // 44
            new THREE.Vector3(-0.8101465, 0, -0.5862275), // 45
            new THREE.Vector3(-0.5862275, 0.3623085, -0.724617), // 46
            new THREE.Vector3(-0.223919, 0.223919, -0.948536), // 47
            new THREE.Vector3(-0.223919, -0.223919, -0.948536), // 48
            new THREE.Vector3(-0.5862275, -0.3623085, -0.724617), // 49
            new THREE.Vector3(-0.5862275, -0.8101465, 0), // 50
            new THREE.Vector3(-0.724617, -0.5862275, 0.3623085), // 51
            new THREE.Vector3(-0.948536, -0.223919, 0.223919), // 52
            new THREE.Vector3(-0.948536, -0.223919, -0.223919), // 53
            new THREE.Vector3(-0.724617, -0.5862275, -0.3623085), // 54
            new THREE.Vector3(0, -0.5862275, -0.8101465), // 55
            new THREE.Vector3(0.3623085, -0.724617, -0.5862275), // 56
            new THREE.Vector3(0.223919, -0.948536, -0.223919), // 57
            new THREE.Vector3(-0.223919, -0.948536, -0.223919), // 58
            new THREE.Vector3(-0.3623085, -0.724617, -0.5862275) // 59
          ],
          faces: [
            [0, 1, 2, 3, 4],
            [5, 6, 7, 8, 9],
            [10, 11, 12, 13, 14],
            [15, 16, 17, 18, 19],
            [20, 21, 22, 23, 24],
            [25, 26, 27, 28, 29],
            [30, 31, 32, 33, 34],
            [35, 36, 37, 38, 39],
            [40, 41, 42, 43, 44],
            [45, 46, 47, 48, 49],
            [50, 51, 52, 53, 54],
            [55, 56, 57, 58, 59],
            [14, 9, 4],
            [8, 19, 0],
            [18, 34, 1],
            [33, 25, 2],
            [29, 10, 3],
            [13, 24, 5],
            [23, 43, 6],
            [42, 15, 7],
            [28, 38, 11],
            [37, 20, 12],
            [41, 47, 16],
            [46, 30, 17],
            [36, 57, 21],
            [56, 44, 22],
            [32, 52, 26],
            [51, 39, 27],
            [45, 53, 31],
            [50, 58, 35],
            [55, 48, 40],
            [59, 54, 49],
            [4, 9, 8, 0],
            [0, 19, 18, 1],
            [1, 34, 33, 2],
            [2, 25, 29, 3],
            [3, 10, 14, 4],
            [9, 14, 13, 5],
            [5, 24, 23, 6],
            [6, 43, 42, 7],
            [7, 15, 19, 8],
            [10, 29, 28, 11],
            [11, 38, 37, 12],
            [12, 20, 24, 13],
            [15, 42, 41, 16],
            [16, 47, 46, 17],
            [17, 30, 34, 18],
            [20, 37, 36, 21],
            [21, 57, 56, 22],
            [22, 44, 43, 23],
            [25, 33, 32, 26],
            [26, 52, 51, 27],
            [27, 39, 38, 28],
            [30, 46, 45, 31],
            [31, 53, 52, 32],
            [39, 51, 50, 35],
            [35, 58, 57, 36],
            [44, 56, 55, 40],
            [40, 48, 47, 41],
            [49, 54, 53, 45],
            [48, 55, 59, 49],
            [54, 59, 58, 50]
          ]
        }
    this.normalize(m);
    return m;
  },

  // 12. Truncated Icosidodecahedron (Great Rhombicosidodecahedron)
  truncatedIcosidodecahedron() {
const m = {
      vertices: [
        new THREE.Vector3(0.3442612, 0.9012876, 0.2629922), // 0
        new THREE.Vector3(-0.1314961, 0.9825566, 0.1314961), // 1
        new THREE.Vector3(-0.4255303, 0.7697915, 0.4757573), // 2
        new THREE.Vector3(-0.1314961, 0.5570264, 0.8200185), // 3
        new THREE.Vector3(0.3442612, 0.6382954, 0.6885225), // 4
        new THREE.Vector3(0.9012876, 0.2629922, 0.3442612), // 5
        new THREE.Vector3(0.9825566, 0.1314961, -0.1314961), // 6
        new THREE.Vector3(0.7697915, 0.4757573, -0.4255303), // 7
        new THREE.Vector3(0.5570264, 0.8200185, -0.1314961), // 8
        new THREE.Vector3(0.6382954, 0.6885225, 0.3442612), // 9
        new THREE.Vector3(0.2629922, 0.3442612, 0.9012876), // 10
        new THREE.Vector3(0.1314961, -0.1314961, 0.9825566), // 11
        new THREE.Vector3(0.4757573, -0.4255303, 0.7697915), // 12
        new THREE.Vector3(0.8200185, -0.1314961, 0.5570264), // 13
        new THREE.Vector3(0.6885225, 0.3442612, 0.6382954), // 14
        new THREE.Vector3(0.4255303, 0.7697915, -0.4757573), // 15
        new THREE.Vector3(0.1314961, 0.5570264, -0.8200185), // 16
        new THREE.Vector3(-0.3442612, 0.6382954, -0.6885225), // 17
        new THREE.Vector3(-0.3442612, 0.9012876, -0.2629922), // 18
        new THREE.Vector3(0.1314961, 0.9825566, -0.1314961), // 19
        new THREE.Vector3(0.7697915, -0.4757573, 0.4255303), // 20
        new THREE.Vector3(0.5570264, -0.8200185, 0.1314961), // 21
        new THREE.Vector3(0.6382954, -0.6885225, -0.3442612), // 22
        new THREE.Vector3(0.9012876, -0.2629922, -0.3442612), // 23
        new THREE.Vector3(0.9825566, -0.1314961, 0.1314961), // 24
        new THREE.Vector3(-0.4757573, 0.4255303, 0.7697915), // 25
        new THREE.Vector3(-0.8200185, 0.1314961, 0.5570264), // 26
        new THREE.Vector3(-0.6885225, -0.3442612, 0.6382954), // 27
        new THREE.Vector3(-0.2629922, -0.3442612, 0.9012876), // 28
        new THREE.Vector3(-0.1314961, 0.1314961, 0.9825566), // 29
        new THREE.Vector3(-0.6382954, 0.6885225, -0.3442612), // 30
        new THREE.Vector3(-0.9012876, 0.2629922, -0.3442612), // 31
        new THREE.Vector3(-0.9825566, 0.1314961, 0.1314961), // 32
        new THREE.Vector3(-0.7697915, 0.4757573, 0.4255303), // 33
        new THREE.Vector3(-0.5570264, 0.8200185, 0.1314961), // 34
        new THREE.Vector3(-0.3442612, -0.9012876, 0.2629922), // 35
        new THREE.Vector3(0.1314961, -0.9825566, 0.1314961), // 36
        new THREE.Vector3(0.4255303, -0.7697915, 0.4757573), // 37
        new THREE.Vector3(0.1314961, -0.5570264, 0.8200185), // 38
        new THREE.Vector3(-0.3442612, -0.6382954, 0.6885225), // 39
        new THREE.Vector3(0.2629922, -0.3442612, -0.9012876), // 40
        new THREE.Vector3(0.1314961, 0.1314961, -0.9825566), // 41
        new THREE.Vector3(0.4757573, 0.4255303, -0.7697915), // 42
        new THREE.Vector3(0.8200185, 0.1314961, -0.5570264), // 43
        new THREE.Vector3(0.6885225, -0.3442612, -0.6382954), // 44
        new THREE.Vector3(-0.8200185, -0.1314961, -0.5570264), // 45
        new THREE.Vector3(-0.6885225, 0.3442612, -0.6382954), // 46
        new THREE.Vector3(-0.2629922, 0.3442612, -0.9012876), // 47
        new THREE.Vector3(-0.1314961, -0.1314961, -0.9825566), // 48
        new THREE.Vector3(-0.4757573, -0.4255303, -0.7697915), // 49
        new THREE.Vector3(-0.5570264, -0.8200185, -0.1314961), // 50
        new THREE.Vector3(-0.6382954, -0.6885225, 0.3442612), // 51
        new THREE.Vector3(-0.9012876, -0.2629922, 0.3442612), // 52
        new THREE.Vector3(-0.9825566, -0.1314961, -0.1314961), // 53
        new THREE.Vector3(-0.7697915, -0.4757573, -0.4255303), // 54
        new THREE.Vector3(-0.1314961, -0.5570264, -0.8200185), // 55
        new THREE.Vector3(0.3442612, -0.6382954, -0.6885225), // 56
        new THREE.Vector3(0.3442612, -0.9012876, -0.2629922), // 57
        new THREE.Vector3(-0.1314961, -0.9825566, -0.1314961), // 58
        new THREE.Vector3(-0.4255303, -0.7697915, -0.4757573), // 59
        new THREE.Vector3(0.4757573, 0.4255303, 0.7697915), // 60
        new THREE.Vector3(0.7697915, 0.4757573, 0.4255303), // 61
        new THREE.Vector3(0.4255303, 0.7697915, 0.4757573), // 62
        new THREE.Vector3(0.5570264, 0.8200185, 0.1314961), // 63
        new THREE.Vector3(0.3442612, 0.9012876, -0.2629922), // 64
        new THREE.Vector3(0.1314961, 0.9825566, 0.1314961), // 65
        new THREE.Vector3(-0.1314961, 0.9825566, -0.1314961), // 66
        new THREE.Vector3(-0.5570264, 0.8200185, -0.1314961), // 67
        new THREE.Vector3(-0.3442612, 0.9012876, 0.2629922), // 68
        new THREE.Vector3(-0.6382954, 0.6885225, 0.3442612), // 69
        new THREE.Vector3(-0.6885225, 0.3442612, 0.6382954), // 70
        new THREE.Vector3(-0.3442612, 0.6382954, 0.6885225), // 71
        new THREE.Vector3(-0.2629922, 0.3442612, 0.9012876), // 72
        new THREE.Vector3(0.1314961, 0.1314961, 0.9825566), // 73
        new THREE.Vector3(0.1314961, 0.5570264, 0.8200185), // 74
        new THREE.Vector3(0.8200185, 0.1314961, 0.5570264), // 75
        new THREE.Vector3(0.9012876, -0.2629922, 0.3442612), // 76
        new THREE.Vector3(0.9825566, 0.1314961, 0.1314961), // 77
        new THREE.Vector3(0.9825566, -0.1314961, -0.1314961), // 78
        new THREE.Vector3(0.8200185, -0.1314961, -0.5570264), // 79
        new THREE.Vector3(0.9012876, 0.2629922, -0.3442612), // 80
        new THREE.Vector3(0.6885225, 0.3442612, -0.6382954), // 81
        new THREE.Vector3(0.3442612, 0.6382954, -0.6885225), // 82
        new THREE.Vector3(0.6382954, 0.6885225, -0.3442612), // 83
        new THREE.Vector3(-0.1314961, -0.1314961, 0.9825566), // 84
        new THREE.Vector3(-0.1314961, -0.5570264, 0.8200185), // 85
        new THREE.Vector3(0.2629922, -0.3442612, 0.9012876), // 86
        new THREE.Vector3(0.3442612, -0.6382954, 0.6885225), // 87
        new THREE.Vector3(0.6382954, -0.6885225, 0.3442612), // 88
        new THREE.Vector3(0.6885225, -0.3442612, 0.6382954), // 89
        new THREE.Vector3(0.2629922, 0.3442612, -0.9012876), // 90
        new THREE.Vector3(-0.1314961, 0.1314961, -0.9825566), // 91
        new THREE.Vector3(-0.1314961, 0.5570264, -0.8200185), // 92
        new THREE.Vector3(-0.4757573, 0.4255303, -0.7697915), // 93
        new THREE.Vector3(-0.7697915, 0.4757573, -0.4255303), // 94
        new THREE.Vector3(-0.4255303, 0.7697915, -0.4757573), // 95
        new THREE.Vector3(0.3442612, -0.9012876, 0.2629922), // 96
        new THREE.Vector3(0.1314961, -0.9825566, -0.1314961), // 97
        new THREE.Vector3(0.5570264, -0.8200185, -0.1314961), // 98
        new THREE.Vector3(0.4255303, -0.7697915, -0.4757573), // 99
        new THREE.Vector3(0.4757573, -0.4255303, -0.7697915), // 100
        new THREE.Vector3(0.7697915, -0.4757573, -0.4255303), // 101
        new THREE.Vector3(-0.9012876, 0.2629922, 0.3442612), // 102
        new THREE.Vector3(-0.9825566, -0.1314961, 0.1314961), // 103
        new THREE.Vector3(-0.8200185, -0.1314961, 0.5570264), // 104
        new THREE.Vector3(-0.7697915, -0.4757573, 0.4255303), // 105
        new THREE.Vector3(-0.4255303, -0.7697915, 0.4757573), // 106
        new THREE.Vector3(-0.4757573, -0.4255303, 0.7697915), // 107
        new THREE.Vector3(-0.8200185, 0.1314961, -0.5570264), // 108
        new THREE.Vector3(-0.9012876, -0.2629922, -0.3442612), // 109
        new THREE.Vector3(-0.9825566, 0.1314961, -0.1314961), // 110
        new THREE.Vector3(-0.5570264, -0.8200185, 0.1314961), // 111
        new THREE.Vector3(-0.3442612, -0.9012876, -0.2629922), // 112
        new THREE.Vector3(-0.1314961, -0.9825566, 0.1314961), // 113
        new THREE.Vector3(0.1314961, -0.5570264, -0.8200185), // 114
        new THREE.Vector3(-0.2629922, -0.3442612, -0.9012876), // 115
        new THREE.Vector3(0.1314961, -0.1314961, -0.9825566), // 116
        new THREE.Vector3(-0.3442612, -0.6382954, -0.6885225), // 117
        new THREE.Vector3(-0.6382954, -0.6885225, -0.3442612), // 118
        new THREE.Vector3(-0.6885225, -0.3442612, -0.6382954) // 119
      ],
      faces: [
        [0, 65, 1, 68, 2, 71, 3, 74, 4, 62],
        [5, 77, 6, 80, 7, 83, 8, 63, 9, 61],
        [10, 73, 11, 86, 12, 89, 13, 75, 14, 60],
        [15, 82, 16, 92, 17, 95, 18, 66, 19, 64],
        [20, 88, 21, 98, 22, 101, 23, 78, 24, 76],
        [25, 70, 26, 104, 27, 107, 28, 84, 29, 72],
        [30, 94, 31, 110, 32, 102, 33, 69, 34, 67],
        [35, 113, 36, 96, 37, 87, 38, 85, 39, 106],
        [40, 116, 41, 90, 42, 81, 43, 79, 44, 100],
        [45, 108, 46, 93, 47, 91, 48, 115, 49, 119],
        [50, 111, 51, 105, 52, 103, 53, 109, 54, 118],
        [55, 114, 56, 99, 57, 97, 58, 112, 59, 117],
        [60, 14, 61, 9, 62, 4],
        [63, 8, 64, 19, 65, 0],
        [66, 18, 67, 34, 68, 1],
        [69, 33, 70, 25, 71, 2],
        [72, 29, 73, 10, 74, 3],
        [75, 13, 76, 24, 77, 5],
        [78, 23, 79, 43, 80, 6],
        [81, 42, 82, 15, 83, 7],
        [84, 28, 85, 38, 86, 11],
        [87, 37, 88, 20, 89, 12],
        [90, 41, 91, 47, 92, 16],
        [93, 46, 94, 30, 95, 17],
        [96, 36, 97, 57, 98, 21],
        [99, 56, 100, 44, 101, 22],
        [102, 32, 103, 52, 104, 26],
        [105, 51, 106, 39, 107, 27],
        [108, 45, 109, 53, 110, 31],
        [111, 50, 112, 58, 113, 35],
        [114, 55, 115, 48, 116, 40],
        [117, 59, 118, 54, 119, 49],
        [62, 9, 63, 0],
        [65, 19, 66, 1],
        [68, 34, 69, 2],
        [71, 25, 72, 3],
        [74, 10, 60, 4],
        [61, 14, 75, 5],
        [77, 24, 78, 6],
        [80, 43, 81, 7],
        [83, 15, 64, 8],
        [73, 29, 84, 11],
        [86, 38, 87, 12],
        [89, 20, 76, 13],
        [82, 42, 90, 16],
        [92, 47, 93, 17],
        [95, 30, 67, 18],
        [88, 37, 96, 21],
        [98, 57, 99, 22],
        [101, 44, 79, 23],
        [70, 33, 102, 26],
        [104, 52, 105, 27],
        [107, 39, 85, 28],
        [94, 46, 108, 31],
        [110, 53, 103, 32],
        [106, 51, 111, 35],
        [113, 58, 97, 36],
        [100, 56, 114, 40],
        [116, 48, 91, 41],
        [119, 54, 109, 45],
        [115, 55, 117, 49],
        [118, 59, 112, 50]
      ]
    };
    this.normalize(m);
    return m;
  },

  // 13. Snub Dodecahedron
  snubDodecahedron() {
    const m = {
      vertices: [
        new THREE.Vector3(0.3931419, 0.7639342, 0.5117069), // 0
        new THREE.Vector3(0.1535, 0.9727329, 0.1738636), // 1
        new THREE.Vector3(-0.2982737, 0.9174342, 0.2633387), // 2
        new THREE.Vector3(-0.3378433, 0.6744591, 0.6564806), // 3
        new THREE.Vector3(0.0894751, 0.5795909, 0.8099806), // 4
        new THREE.Vector3(0.7639342, 0.5117069, 0.3931419), // 5
        new THREE.Vector3(0.9727329, 0.1738636, 0.1535), // 6
        new THREE.Vector3(0.9174342, 0.2633387, -0.2982737), // 7
        new THREE.Vector3(0.6744591, 0.6564806, -0.3378433), // 8
        new THREE.Vector3(0.5795909, 0.8099806, 0.0894751), // 9
        new THREE.Vector3(0.5117069, 0.3931419, 0.7639342), // 10
        new THREE.Vector3(0.1738636, 0.1535, 0.9727329), // 11
        new THREE.Vector3(0.2633387, -0.2982737, 0.9174342), // 12
        new THREE.Vector3(0.6564806, -0.3378433, 0.6744591), // 13
        new THREE.Vector3(0.8099806, 0.0894751, 0.5795909), // 14
        new THREE.Vector3(0.2982737, 0.9174342, -0.2633387), // 15
        new THREE.Vector3(0.3378433, 0.6744591, -0.6564806), // 16
        new THREE.Vector3(-0.0894751, 0.5795909, -0.8099806), // 17
        new THREE.Vector3(-0.3931419, 0.7639342, -0.5117069), // 18
        new THREE.Vector3(-0.1535, 0.9727329, -0.1738636), // 19
        new THREE.Vector3(0.9174342, -0.2633387, 0.2982737), // 20
        new THREE.Vector3(0.6744591, -0.6564806, 0.3378433), // 21
        new THREE.Vector3(0.5795909, -0.8099806, -0.0894751), // 22
        new THREE.Vector3(0.7639342, -0.5117069, -0.3931419), // 23
        new THREE.Vector3(0.9727329, -0.1738636, -0.1535), // 24
        new THREE.Vector3(-0.2633387, 0.2982737, 0.9174342), // 25
        new THREE.Vector3(-0.6564806, 0.3378433, 0.6744591), // 26
        new THREE.Vector3(-0.8099806, -0.0894751, 0.5795909), // 27
        new THREE.Vector3(-0.5117069, -0.3931419, 0.7639342), // 28
        new THREE.Vector3(-0.1738636, -0.1535, 0.9727329), // 29
        new THREE.Vector3(-0.5795909, 0.8099806, -0.0894751), // 30
        new THREE.Vector3(-0.7639342, 0.5117069, -0.3931419), // 31
        new THREE.Vector3(-0.9727329, 0.1738636, -0.1535), // 32
        new THREE.Vector3(-0.9174342, 0.2633387, 0.2982737), // 33
        new THREE.Vector3(-0.6744591, 0.6564806, 0.3378433), // 34
        new THREE.Vector3(-0.3931419, -0.7639342, 0.5117069), // 35
        new THREE.Vector3(-0.1535, -0.9727329, 0.1738636), // 36
        new THREE.Vector3(0.2982737, -0.9174342, 0.2633387), // 37
        new THREE.Vector3(0.3378433, -0.6744591, 0.6564806), // 38
        new THREE.Vector3(-0.0894751, -0.5795909, 0.8099806), // 39
        new THREE.Vector3(0.5117069, -0.3931419, -0.7639342), // 40
        new THREE.Vector3(0.1738636, -0.1535, -0.9727329), // 41
        new THREE.Vector3(0.2633387, 0.2982737, -0.9174342), // 42
        new THREE.Vector3(0.6564806, 0.3378433, -0.6744591), // 43
        new THREE.Vector3(0.8099806, -0.0894751, -0.5795909), // 44
        new THREE.Vector3(-0.6564806, -0.3378433, -0.6744591), // 45
        new THREE.Vector3(-0.8099806, 0.0894751, -0.5795909), // 46
        new THREE.Vector3(-0.5117069, 0.3931419, -0.7639342), // 47
        new THREE.Vector3(-0.1738636, 0.1535, -0.9727329), // 48
        new THREE.Vector3(-0.2633387, -0.2982737, -0.9174342), // 49
        new THREE.Vector3(-0.6744591, -0.6564806, -0.3378433), // 50
        new THREE.Vector3(-0.5795909, -0.8099806, 0.0894751), // 51
        new THREE.Vector3(-0.7639342, -0.5117069, 0.3931419), // 52
        new THREE.Vector3(-0.9727329, -0.1738636, 0.1535), // 53
        new THREE.Vector3(-0.9174342, -0.2633387, -0.2982737), // 54
        new THREE.Vector3(-0.3378433, -0.6744591, -0.6564806), // 55
        new THREE.Vector3(0.0894751, -0.5795909, -0.8099806), // 56
        new THREE.Vector3(0.3931419, -0.7639342, -0.5117069), // 57
        new THREE.Vector3(0.1535, -0.9727329, -0.1738636), // 58
        new THREE.Vector3(-0.2982737, -0.9174342, -0.2633387) // 59
      ],
      faces: [
        [0, 1, 2, 3, 4],
        [5, 6, 7, 8, 9],
        [10, 11, 12, 13, 14],
        [15, 16, 17, 18, 19],
        [20, 21, 22, 23, 24],
        [25, 26, 27, 28, 29],
        [30, 31, 32, 33, 34],
        [35, 36, 37, 38, 39],
        [40, 41, 42, 43, 44],
        [45, 46, 47, 48, 49],
        [50, 51, 52, 53, 54],
        [55, 56, 57, 58, 59],
        [10, 5, 0],
        [9, 15, 1],
        [19, 30, 2],
        [34, 26, 3],
        [25, 11, 4],
        [14, 20, 6],
        [24, 44, 7],
        [43, 16, 8],
        [29, 39, 12],
        [38, 21, 13],
        [42, 48, 17],
        [47, 31, 18],
        [37, 58, 22],
        [57, 40, 23],
        [33, 53, 27],
        [52, 35, 28],
        [46, 54, 32],
        [51, 59, 36],
        [56, 49, 41],
        [55, 50, 45],
        [0, 5, 9],
        [0, 9, 1],
        [1, 15, 19],
        [1, 19, 2],
        [2, 30, 34],
        [2, 34, 3],
        [3, 26, 25],
        [3, 25, 4],
        [4, 11, 10],
        [4, 10, 0],
        [5, 10, 14],
        [5, 14, 6],
        [6, 20, 24],
        [6, 24, 7],
        [7, 44, 43],
        [7, 43, 8],
        [8, 16, 15],
        [8, 15, 9],
        [11, 25, 29],
        [11, 29, 12],
        [12, 39, 38],
        [12, 38, 13],
        [13, 21, 20],
        [13, 20, 14],
        [16, 43, 42],
        [16, 42, 17],
        [17, 48, 47],
        [17, 47, 18],
        [18, 31, 30],
        [18, 30, 19],
        [21, 38, 37],
        [21, 37, 22],
        [22, 58, 57],
        [22, 57, 23],
        [23, 40, 44],
        [23, 44, 24],
        [26, 34, 33],
        [26, 33, 27],
        [27, 53, 52],
        [27, 52, 28],
        [28, 35, 39],
        [28, 39, 29],
        [31, 47, 46],
        [31, 46, 32],
        [32, 54, 53],
        [32, 53, 33],
        [35, 52, 51],
        [35, 51, 36],
        [36, 59, 58],
        [36, 58, 37],
        [40, 57, 56],
        [40, 56, 41],
        [41, 49, 48],
        [41, 48, 42],
        [45, 50, 54],
        [45, 54, 46],
        [49, 56, 55],
        [49, 55, 45],
        [50, 55, 59],
        [50, 59, 51]
      ]
    };
    this.normalize(m);
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
