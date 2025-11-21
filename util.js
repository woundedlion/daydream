// util.js
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
  return x >= 0 ? x % m : ((x % m) + m) % m;
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