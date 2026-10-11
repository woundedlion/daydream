/**
 * Analytic Lissajous samples: `[m1, m2, a, t]` arguments paired with the
 * expected unit-sphere point `{x, y, z}`.
 * @type {ReadonlyArray<readonly [readonly [number, number, number, number], Readonly<{x: number, y: number, z: number}>]>}
 */
export const LISSAJOUS_GOLDENS = Object.freeze([
  [[3, 2, 0, 0.7], { x: -0.4975, y: 0.169967, z: 0.850649 }],
  [[5, 4, 0.5, 1.2], { x: -0.705952, y: 0.087499, z: 0.702834 }],
]);
