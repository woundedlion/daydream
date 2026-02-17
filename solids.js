/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// Export lists of names supported by the WASM module
export const PlatonicSolids = [
  "tetrahedron",
  "cube",
  "octahedron",
  "dodecahedron",
  "icosahedron"
];

export const ArchimedeanSolids = [
  "truncatedTetrahedron",
  "cuboctahedron",
  "truncatedCube",
  "truncatedOctahedron",
  "rhombicuboctahedron",
  "truncatedCuboctahedron",
  "snubCube",
  "icosidodecahedron",
  "truncatedDodecahedron",
  "truncatedIcosahedron",
  "rhombicosidodecahedron",
  "truncatedIcosidodecahedron",
  "snubDodecahedron"
];

export const IslamicStarPatterns = [
  "icosahedron_hk59_bitruncate033",
  "octahedron_hk17_ambo_hk72",
  "icosahedron_kis_gyro",
  "truncatedIcosidodecahedron_truncate05_ambo_dual",
  "icosidodecahedron_truncate05_ambo_dual",
  "snubDodecahedron_truncate05_ambo_dual",
  "octahedron_hk34_ambo_hk72",
  "rhombicuboctahedron_hk63_ambo_hk63",
  "truncatedIcosahedron_hk54_ambo_hk72",
  "dodecahedron_hk54_ambo_hk72",
  "dodecahedron_hk72_ambo_dual_hk20",
  "truncatedIcosahedron_truncate05_ambo_dual"
];

export const AllSolids = [...PlatonicSolids, ...ArchimedeanSolids, ...IslamicStarPatterns];
