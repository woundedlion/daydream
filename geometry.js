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

/** @type {StaticPool} Global pool for temporary Vector3 objects. */
export const vectorPool = new StaticPool(THREE.Vector3, 500000);
/** @type {number} The golden ratio, (1 + sqrt(5)) / 2. */
export const PHI = (1 + Math.sqrt(5)) / 2;
/** @type {number} The inverse golden ratio, 1 / PHI. */
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
    x: wrap((s.theta * Daydream.W) / (2 * Math.PI), Daydream.W),
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
    (x * 2 * Math.PI) / Daydream.W
  );
};

/**
 * Converts a 3D vector (normalized) to 2D pixel coordinates.
 * @param {THREE.Vector3} v - The vector (position on unit sphere).
 * @returns {{x: number, y: number}} The pixel coordinates (x is wrapped).
 */
export const vectorToPixel = (v) => {
  let s = new THREE.Spherical().setFromVector3(v);
  return {
    x: wrap((s.theta * Daydream.W) / (2 * Math.PI), Daydream.W),
    y: (s.phi * (Daydream.H - 1)) / Math.PI,
  };
};

/**
 * Converts 2D pixel coordinates to a 3D vector (position on unit sphere).
 * @param {number} x - The pixel x-coordinate.
 * @param {number} y - The pixel y-coordinate.
 * @returns {THREE.Vector3} The normalized 3D vector.
 */
export const pixelToVector = (x, y) => {
  let s = new THREE.Spherical(
    1,
    (y * Math.PI) / (Daydream.H - 1),
    (x * 2 * Math.PI) / Daydream.W
  );
  const v = vectorPool.acquire();
  v.setFromSpherical(s);
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
 * Placeholder class for defining a small test polyhedron geometry.
 * @property {number[][]} vertices - Array of [x, y, z] coordinates.
 * @property {number[][]} eulerPath - Adjacency list for edges (intended for Euler path).
 */
export class TestPoly {
  vertices = [
    [1, 1, 1], // 0
    [1, -1, 1] // 1
  ];
  eulerPath = [
    [1],
    []
  ]
}

/**
 * Defines the geometry for a Cube (vertices and edges).
 * @property {number[][]} vertices - Array of [x, y, z] coordinates for a unit cube.
 * @property {number[][]} eulerPath - Adjacency list for edges (intended for Euler path).
 */
export class Cube {
  vertices = [
    [1, 1, 1], // 0
    [1, 1, -1], // 1
    [1, -1, 1], // 2
    [1, -1, -1], // 3
    [-1, 1, 1], // 4
    [-1, 1, -1], // 5
    [-1, -1, 1], // 6
    [-1, -1, -1], // 7
  ];

  eulerPath = [
    [1, 2, 4], // 0
    [3, 5], // 1
    [3, 6], // 2
    [7], // 3
    [5, 6], // 4
    [7], // 5
    [7], // 6
    [], // 7
  ];
}

/**
 * Defines the geometry for a Dodecahedron (vertices and edges).
 * Uses the golden ratio (PHI) for coordinate generation.
 * @property {number[][]} vertices - Array of [x, y, z] coordinates for a Dodecahedron.
 * @property {number[][]} edges - Adjacency list defining edges by vertex index.
 * @property {number[][]} eulerPath - Adjacency list for edges (intended for Euler path).
 */
export class Dodecahedron {
  vertices = [
    [1, 1, 1], // 0
    [1, 1, -1], // 1
    [1, -1, 1], // 2
    [1, -1, -1], // 3
    [-1, 1, 1], // 4
    [-1, 1, -1], // 5
    [-1, -1, 1], // 6
    [-1, -1, -1], // 7

    [0, 1 / PHI, PHI], //8
    [0, 1 / PHI, -PHI], // 9
    [0, -1 / PHI, PHI], // 10
    [0, -1 / PHI, -PHI], // 11

    [1 / PHI, PHI, 0], // 12
    [1 / PHI, -PHI, 0], // 13
    [-1 / PHI, PHI, 0], // 14
    [-1 / PHI, -PHI, 0], // 15

    [PHI, 0, 1 / PHI], // 16
    [PHI, 0, -1 / PHI], // 17
    [-PHI, 0, 1 / PHI], // 18
    [-PHI, 0, -1 / PHI], // 19
  ];

  edges = [
    [8, 12, 16], // 0
    [9, 12, 17], // 1
    [10, 13, 16], // 2
    [11, 13, 17], // 3
    [8, 14, 18], // 4
    [9, 14, 19], // 5
    [10, 15, 18], // 6
    [11, 15, 19], // 7
    [0, 4, 10], // 8
    [1, 5, 11], // 9
    [2, 6, 8], // 10
    [3, 7, 9], // 11
    [0, 1, 14], // 12
    [2, 3, 15], // 13
    [4, 5, 12], // 14
    [6, 7, 13], // 15
    [0, 2, 17], // 16
    [1, 3, 16], // 17
    [4, 6, 19], // 18
    [5, 7, 18], // 19
  ];

  eulerPath = [
    [8, 12, 16], // 0
    [9, 12, 17], // 1
    [10, 13, 16], // 2
    [11, 13, 17], // 3
    [8, 14, 18], // 4
    [9, 14, 19], // 5
    [10, 15, 18], // 6
    [11, 15, 19], // 7
    [10], // 8
    [11], // 9
    [8], // 10
    [9], // 11
    [14], // 12
    [15], // 13
    [12], // 14
    [13], // 15
    [17], // 16
    [16], // 17
    [19], // 18
    [18], // 19
  ];
}

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
    return vectorPool.acquire().copy(v).normalize().applyQuaternion(this.orientations[i].clone().invert());
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

    // Always keep start and end exact
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

      // Slerp between the two nearest existing points
      newHistory[i] = oldHistory[idxA].clone().slerp(oldHistory[idxB], alpha);
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
    if (this.orientations.length > 0) {
      this.orientations = [this.orientations[this.orientations.length - 1]];
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
    (2 * Math.PI * i * G) % (2 * Math.PI)
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
    let w = (Math.sin(freq * t * 2 * Math.PI - Math.PI / 2 + Math.PI - 2 * phase) + 1) / 2;
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
  const v = vectorPool.acquire();
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
  let diff = from.get().clone().conjugate().premultiply(to.get());
  let angle = 2 * Math.acos(diff.w);
  if (angle == 0) {
    return
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
  let len_product = v1.length() * v2.length();
  let d = v1.dot(v2) / len_product;
  return Math.acos(Math.max(-1, Math.min(1, d)));
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
