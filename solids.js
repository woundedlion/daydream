/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { MeshOps } from "./geometry.js";

const PHI = (1 + Math.sqrt(5)) / 2;

// Constants for procedural generation
const SQRT2 = Math.sqrt(2);
const TRIBONACCI = (1 + Math.cbrt(19 - 3 * Math.sqrt(33)) + Math.cbrt(19 + 3 * Math.sqrt(33))) / 3;
const T_SNUB_CUBE = 1 / (1 + TRIBONACCI);
const T_TRUNC_ICOS = 1 / (2 + PHI);



function normalize(m) {
  m.vertices.forEach(v => v.normalize());
}

/**
 * Collection of standard geometric solids.
 */
export const Solids = {

  normalize: normalize,

  get(name) {
    if (this.PlatonicSolids[name]) return this.PlatonicSolids[name]();
    if (this.Archimedean[name]) return this.Archimedean[name]();
    if (this.IslamicStarPatterns && this.IslamicStarPatterns[name]) return this.IslamicStarPatterns[name]();
    console.warn(`Solid '${name}' not found, returning tetrahedron.`);
    return this.PlatonicSolids['tetrahedron']();
  },

  PlatonicSolids: {

    // 1. TETRAHEDRON (4 Verts, 4 Faces)
    // Source: Standard construction
    // 1. TETRAHEDRON (4 Verts, 4 Faces)
    // Source: Standard construction
    tetrahedron() {
      const s = 1.0;
      const c = 1.0 / Math.sqrt(3.0); // Normalize to sphere
      const m = {
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
      normalize(m);
      return m;
    },

    // 2. CUBE (8 Verts, 6 Faces)
    // Source: Geometric Tools (Ref 3.7)
    // Order: Bottom Ring (0-3), Top Ring (4-7)
    cube() {
      const a = 1.0 / Math.sqrt(3.0);
      const m = {
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
      normalize(m);
      return m;
    },

    // 3. OCTAHEDRON (6 Verts, 8 Faces)
    // Source: Geometric Tools
    // Order: Equator (0-3), Top (4), Bottom (5)
    octahedron() {
      const m = {
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
      normalize(m);
      return m;
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

      const m = {
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
      normalize(m);
      return m;
    },

    // 5. DODECAHEDRON (20 Verts, 12 Faces)
    // Source: Geometric Tools (Ref 3.7)
    // Order is CRITICAL here. 
    //   0-7:   Cube vertices (Â±1, Â±1, Â±1)
    //   8-11:  (Â±1/phi, Â±phi, 0)   [XY plane]
    //   12-15: (Â±phi, 0, Â±1/phi)   [XZ plane]
    //   16-19: (0, Â±1/phi, Â±phi)   [YZ plane]
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

          // XY Plane Points (8-11) -> (Â±1/phi, Â±phi, 0)
          new THREE.Vector3(b, c, 0.0), new THREE.Vector3(-b, c, 0.0), new THREE.Vector3(b, -c, 0.0), new THREE.Vector3(-b, -c, 0.0),

          // XZ Plane Points (12-15) -> (Â±phi, 0, Â±1/phi)
          new THREE.Vector3(c, 0.0, b), new THREE.Vector3(c, 0.0, -b), new THREE.Vector3(-c, 0.0, b), new THREE.Vector3(-c, 0.0, -b),

          // YZ Plane Points (16-19) -> (0, Â±1/phi, Â±phi)
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
      normalize(m); // Ensure exact unit radius
      return m;
    },
  },

  Archimedean: {
    truncatedTetrahedron: () => MeshOps.truncate(Solids.PlatonicSolids.tetrahedron(), 1 / 3),
    cuboctahedron: () => MeshOps.ambo(Solids.PlatonicSolids.cube()),
    truncatedCube: () => MeshOps.truncate(Solids.PlatonicSolids.cube(), 1 / (2 + SQRT2)),
    truncatedOctahedron: () => MeshOps.truncate(Solids.PlatonicSolids.octahedron(), 1 / 3),
    rhombicuboctahedron: () => MeshOps.expand(Solids.PlatonicSolids.cube()),
    truncatedCuboctahedron: () => MeshOps.canonicalize(MeshOps.bitruncate(Solids.PlatonicSolids.cube(), 1 / (2 + SQRT2)), 50),
    snubCube: () => MeshOps.canonicalize(MeshOps.snub(Solids.PlatonicSolids.cube(), T_SNUB_CUBE, 0.28), 50),
    icosidodecahedron: () => MeshOps.ambo(Solids.PlatonicSolids.dodecahedron()),
    truncatedDodecahedron: () => MeshOps.truncate(Solids.PlatonicSolids.dodecahedron(), T_TRUNC_ICOS),
    truncatedIcosahedron: () => MeshOps.truncate(Solids.PlatonicSolids.icosahedron(), 1 / 3),
    rhombicosidodecahedron: () => MeshOps.canonicalize(MeshOps.expand(Solids.PlatonicSolids.dodecahedron()), 50),
    truncatedIcosidodecahedron: () => MeshOps.canonicalize(MeshOps.bitruncate(Solids.PlatonicSolids.dodecahedron(), 1 / (2 + PHI)), 50),
    snubDodecahedron: () => MeshOps.canonicalize(MeshOps.snub(Solids.PlatonicSolids.dodecahedron(), 0.5), 50)
  },

  IslamicStarPatterns: {
    icosahedron_hk59_bitruncate033: () => MeshOps.hankin(MeshOps.bitruncate(Solids.PlatonicSolids.icosahedron(), 0.33), 59 * (Math.PI / 180)),
    octahedron_hk17_ambo_hk72: () => MeshOps.hankin(MeshOps.ambo(MeshOps.hankin(Solids.PlatonicSolids.octahedron(), 17 * Math.PI / 180)), 73 * Math.PI / 180),
    icosahedron_kis_gyro: () => MeshOps.gyro(MeshOps.kis(Solids.PlatonicSolids.icosahedron())),
    truncatedIcosidodecahedron_truncate05_ambo_dual: () => MeshOps.dual(MeshOps.ambo(MeshOps.truncate(Solids.Archimedean.truncatedIcosidodecahedron(), 50 * Math.PI / 180))),
    icosidodecahedron_truncate05_ambo_dual: () => MeshOps.dual(MeshOps.ambo(MeshOps.truncate(Solids.Archimedean.icosidodecahedron(), 5 * Math.PI / 180))),
    snubDodecahedron_truncate05_ambo_dual: () => MeshOps.dual(MeshOps.ambo(MeshOps.truncate(Solids.Archimedean.snubDodecahedron(), 5 * Math.PI / 180))),
    octahedron_hk34_ambo_hk72: () => MeshOps.hankin(MeshOps.ambo(MeshOps.hankin(Solids.PlatonicSolids.octahedron(), 34 * Math.PI / 180)), 72 * Math.PI / 180),
    rhombicuboctahedron_hk63_ambo_hk63: () => MeshOps.hankin(MeshOps.ambo(MeshOps.hankin(Solids.Archimedean.rhombicuboctahedron(), 63 * Math.PI / 180)), 63 * Math.PI / 180),
    truncatedIcosahedron_hk54_ambo_hk72: () => MeshOps.hankin(MeshOps.ambo(MeshOps.hankin(Solids.Archimedean.truncatedIcosahedron(), 54 * Math.PI / 180)), 72 * Math.PI / 180),
    dodecahedron_hk54_ambo_hk72: () => MeshOps.hankin(MeshOps.ambo(MeshOps.hankin(Solids.PlatonicSolids.dodecahedron(), 54 * Math.PI / 180)), 72 * Math.PI / 180),
    dodecahedron_hk72_ambo_dual_hk20: () => MeshOps.hankin(MeshOps.dual(MeshOps.ambo(MeshOps.hankin(Solids.PlatonicSolids.dodecahedron(), 72 * Math.PI / 180))), 20 * Math.PI / 180),
    truncatedIcosahedron_truncate05_ambo_dual: () => MeshOps.dual(MeshOps.ambo(MeshOps.truncate(Solids.Archimedean.truncatedIcosahedron(), 50 * Math.PI / 180)))
  }
};

export const PlatonicSolids = Object.keys(Solids.PlatonicSolids);
export const ArchimedeanSolids = Object.keys(Solids.Archimedean);
export const IslamicStarPatterns = Object.keys(Solids.IslamicStarPatterns);
export const AllSolids = [...PlatonicSolids, ...ArchimedeanSolids, ...IslamicStarPatterns];
