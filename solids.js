/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

const PHI = (1 + Math.sqrt(5)) / 2;

export const Solids = {
  get(name) {
    // Legacy: Logic moved to C++
    return null;
  },

  PlatonicSolids: {
    tetrahedron: null,
    cube: null,
    octahedron: null,
    dodecahedron: null,
    icosahedron: null
  },

  Archimedean: {
    truncatedTetrahedron: null,
    cuboctahedron: null,
    truncatedCube: null,
    truncatedOctahedron: null,
    rhombicuboctahedron: null,
    truncatedCuboctahedron: null,
    snubCube: null,
    icosidodecahedron: null,
    truncatedDodecahedron: null,
    truncatedIcosahedron: null,
    rhombicosidodecahedron: null,
    truncatedIcosidodecahedron: null,
    snubDodecahedron: null
  },

  IslamicStarPatterns: {
    icosahedron_hk59_bitruncate033: null,
    octahedron_hk17_ambo_hk72: null,
    icosahedron_kis_gyro: null,
    truncatedIcosidodecahedron_truncate05_ambo_dual: null,
    icosidodecahedron_truncate05_ambo_dual: null,
    snubDodecahedron_truncate05_ambo_dual: null,
    octahedron_hk34_ambo_hk72: null,
    rhombicuboctahedron_hk63_ambo_hk63: null,
    truncatedIcosahedron_hk54_ambo_hk72: null,
    dodecahedron_hk54_ambo_hk72: null,
    dodecahedron_hk72_ambo_dual_hk20: null,
    truncatedIcosahedron_truncate05_ambo_dual: null
  }
};

export const PlatonicSolids = Object.keys(Solids.PlatonicSolids);
export const ArchimedeanSolids = Object.keys(Solids.Archimedean);
export const IslamicStarPatterns = Object.keys(Solids.IslamicStarPatterns);
export const AllSolids = [...PlatonicSolids, ...ArchimedeanSolids, ...IslamicStarPatterns];
