// geometry.js
import * as THREE from "three";
import { wrap } from "./util.js";
import { Daydream } from "./driver.js";
import { Rotation, easeOutCirc } from "./animation.js";
import { g1, g2 } from "./color.js";

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
   * @param {THREE.Color} color - The color of the dot.
   */
  constructor(position, color) {
    this.position = position;
    this.color = color;
  }
}

/**
 * Converts spherical coordinates on a unit sphere to 2D pixel coordinates.
 * @param {THREE.Spherical} s - The spherical coordinates (radius assumed to be 1).
 * @returns {{x: number, y: number}} The pixel coordinates (x is wrapped).
 */
export const sphericalToPixel = (s) => {
  return {
    x: wrap((s.theta * Daydream.W) / (2 * Math.PI), Daydream.W),
    y: (s.phi * (Daydream.H - 1)) / Math.PI,
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
    (y * Math.PI) / (Daydream.H - 1),
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
  return new THREE.Vector3().setFromSpherical(s);
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
 * Generates a random normalized 3D vector.
 * @returns {THREE.Vector3} A random vector on the unit sphere.
 */
export const randomVector = () => {
  return new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1).normalize();
}

/**
 * Manages the rotation and orientation of a 3D object over time.
 * Stores a history of quaternions for motion trails.
 */
export class Orientation {
  constructor() {
    /** @type {THREE.Quaternion[]} */
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
    return v.clone().normalize().applyQuaternion(this.orientations[i]);
  }

  /**
   * Applies the inverse orientation from the history to a given vector.
   * @param {THREE.Vector3} v - The vector to be unoriented.
   * @param {number} [i=this.length() - 1] - The index in the history to use.
   * @returns {THREE.Vector3} The unoriented and normalized vector.
   */
  unorient(v, i = this.length() - 1) {
    return v.clone().normalize().applyQuaternion(this.orientations[i].clone().invert());
  }

  /**
   * Applies the orientation to an array of coordinate arrays.
   * @param {number[][]} vertices - Array of [x, y, z] coordinates.
   * @param {number} [i=this.length() - 1] - The index in the history to use.
   * @returns {number[][]} Array of oriented [x, y, z] coordinates.
   */
  orientPoly(vertices, i = this.length() - 1) {
    return vertices.map((c) => {
      return this.orient(new THREE.Vector3().fromArray(c)).toArray();
    });
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
   * Removes all but the most recent orientation, collapsing the history.
   */
  collapse() {
    while (this.orientations.length > 1) { this.orientations.shift(); }
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
  return new THREE.Vector3().setFromSpherical(new THREE.Spherical(
    1,
    Math.acos(1 - (2 * (i + eps)) / n),
    (2 * Math.PI * i * G) % (2 * Math.PI)
  ));
}

/**
 * Returns a function that generates a sine wave value.
 * @param {number} from - The minimum output value.
 * @param {number} to - The maximum output value.
 * @param {number} freq - The frequency of the wave.
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
 * @param {number} freq - The frequency of the wave (unused, kept for signature).
 * @param {number} phase - The phase shift of the wave (unused, kept for signature).
 * @returns {function(number): number} A function that takes time t and returns the wave value.
 */
export function triWave(from, to, freq, phase) {
  return (t) => {
    if (t < 0.5) {
      var w = 2 * t;
    } else {
      w = 2 - 2 * t;
    }
    return w * (to - from) + from;
  };
}

/**
 * Returns a function that generates a square wave value.
 * @param {number} from - The 'off' value.
 * @param {number} to - The 'on' value.
 * @param {number} freq - The frequency.
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
  return new THREE.Vector3(
    Math.sin(m2 * t) * Math.cos(m1 * t - a * Math.PI),
    Math.cos(m2 * t),
    Math.sin(m2 * t) * Math.sin(m1 * t - a * Math.PI),
  );
}

/**
 * Animates a rotation between two orientations.
 * @param {Orientation} from - The starting orientation (mutable).
 * @param {Orientation} to - The target orientation.
 */
export function rotateBetween(from, to) {
  let diff = from.get().clone().conjugate().premultiply(to.get());
  let angle = 2 * Math.acos(diff.w);
  if (angle == 0) {
    return
  } else {
    var axis = new THREE.Vector3(diff.x, diff.y, diff.z).normalize();
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
 * Generates a random normalized 3D vector.
 * @returns {THREE.Vector3} A random vector on the unit sphere.
 */
export function makeRandomVector() {
  return new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1).normalize();
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
  let w = new THREE.Vector3().crossVectors(v, u).normalize();
  let i1 = new THREE.Vector3().crossVectors(w, normal).normalize();
  let i2 = new THREE.Vector3().crossVectors(normal, w).normalize();

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
 * Creates two points slightly offset from a center point along the plane normal, 
 * simulating a tiny gap to prevent Z-fighting or plane boundary issues.
 * @param {THREE.Vector3} c - The center point.
 * @param {THREE.Vector3} normal - The plane normal.
 * @returns {THREE.Vector3[]} An array of two normalized vectors (positive and negative offset).
 */
export function splitPoint(c, normal) {
  const shift = Math.sin(Math.PI / Daydream.W);
  return [
    new THREE.Vector3().copy(c)
      .addScaledVector(normal, shift)
      .normalize(),
    new THREE.Vector3().copy(c)
      .addScaledVector(new THREE.Vector3().copy(normal).negate(), shift)
      .normalize()
    ,
  ];
}

/**
 * Recursively splits a polyhedron's edges that intersect a plane, 
 * adding new vertices to divide the faces.
 * @param {Object} poly - The polyhedron object (mutable vertices and eulerPath).
 * @param {Orientation} orientation - The current orientation.
 * @param {THREE.Vector3} normal - The plane normal.
 * @returns {Object} The mutated polyhedron.
 */
export function bisect(poly, orientation, normal) {
  let v = poly.vertices;
  let e = poly.eulerPath;
  e.map((neighbors, ai) => {
    e[ai] = neighbors.reduce((result, bi) => {
      let a = orientation.orient(new THREE.Vector3().fromArray(v[ai]));
      let b = orientation.orient(new THREE.Vector3().fromArray(v[bi]));
      if (intersectsPlane(a, b, normal)) {
        let points = splitPoint(intersection(a, b, normal), normal);
        v.push(orientation.unorient(points[0]).toArray());
        v.push(orientation.unorient(points[1]).toArray());
        if (isOver(a, normal)) {
          e.push([ai]);
          e.push([bi]);
        } else {
          e.push([bi]);
          e.push([ai]);
        }
      } else {
        result.push(bi);
      }
      return result;
    }, []);
  });
  return poly;
}