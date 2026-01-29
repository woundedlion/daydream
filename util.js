/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Recursively generates all unique pairwise permutations from a list.
 * @param {Array<any>} list - The input array.
 * @returns {Array<Array<any>>} An array of all unique pairs.
 */
export const permute_pairwise = (list) => {
  if (list.length < 2) {
    return [];
  }
  let a = list[0];
  let rest = list.slice(1);
  let pairs = rest.map((i) => [a, i]);
  return pairs.concat(permute_pairwise(rest));
}

/**
 * Calculates the Euclidean distance between two 3D points (represented as arrays [x, y, z]).
 * @param {number[]} a - The first point [x, y, z].
 * @param {number[]} b - The second point [x, y, z].
 * @returns {number} The distance between the points.
 */
export const distance_between = (a, b) => {
  return Math.sqrt(
    Math.pow(b[0] - a[0], 2)
    + Math.pow(b[1] - a[1], 2)
    + Math.pow(b[2] - a[2], 2)
  );
}

/**
 * Returns the sign of a number, returning -1 for negative, and 1 for zero or positive.
 * @param {number} v - The input value.
 * @returns {number} -1 or 1.
 */
export function dir(v) { return v < 0 ? -1 : 1; }

/**
 * Wraps a value `x` around a modulus `m`. Handles negative numbers correctly.
 * For example, wrap(-1, 10) returns 9.
 * @param {number} x - The value to wrap.
 * @param {number} m - The modulus.
 * @returns {number} The wrapped value [0, m - 1].
 */
export function wrap(x, m) {
  if (x < 0) return x + m;
  if (x >= m) return x - m;
  return x;
}

/**
 * Calculates the shortest distance between two points on a circular domain (like a cylinder's circumference).
 * @param {number} x1 - The position of the first point.
 * @param {number} x2 - The position of the second point.
 * @param {number} m - The modulus/circumference size.
 * @returns {number} The shortest distance.
 */
export function shortest_distance(x1, x2, m) {
  let d = Math.abs(x1 - x2) % m;
  return Math.min(d, m - d);
}

/**
 * Calculates the forward distance from point `a` to point `b` in a circular domain.
 * @param {number} a - The starting position.
 * @param {number} b - The ending position.
 * @param {number} m - The modulus/circumference size.
 * @returns {number} The distance travelling in the forward direction.
 */
export function fwd_distance(a, b, m) {
  let diff = b - a;
  if (diff < 0) {
    diff += m;
  }
  return diff;
}

/**
 * Selects a random element from an array.
 * @param {Array<any>} choices - The array of choices.
 * @returns {any|undefined} A randomly selected element, or undefined if the array is empty.
 */
export const randomChoice = (choices) => {
  if (choices.length == 0) {
    return undefined;
  }
  return choices[Math.floor(Math.random() * choices.length)];
}

/**
 * Generates a random floating-point number between two bounds.
 * @param {number} a - The first bound (inclusive).
 * @param {number} b - The second bound (exclusive).
 * @returns {number} A random number between a and b.
 */
export function randomBetween(a, b) {
  return Math.random() * (b - a) + a;
}

/**
 * Perform Hermite interpolation between two values.
 * @param {number} min - Lower bound.
 * @param {number} max - Upper bound.
 * @param {number} x - Value to interpolate.
 * @returns {number} Interpolated value [0, 1].
 */
export function smoothstep(min, max, x) {
  x = Math.max(0, Math.min(1, (x - min) / (max - min)));
  return x * x * (3 - 2 * x);
}

/**
 * Fast approximation of atan2.
 * Max error ~0.005 radians.
 * @param {number} y 
 * @param {number} x 
 * @returns {number} Angle in radians
 */
export function fastAtan2(y, x) {
  const abs_y = Math.abs(y) + 1e-10; // prevent 0/0
  let r, angle;
  if (x >= 0) {
    r = (x - abs_y) / (x + abs_y);
    angle = 0.785398 - 0.785398 * r;
  } else {
    r = (x + abs_y) / (abs_y - x);
    angle = 2.356194 - 0.785398 * r;
  }
  return y < 0 ? -angle : angle;
}
