/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

/**
 * Solids mesh geometry: face normals, convexity, fan and geodesic face
 * tessellation, and unique edges.
 */

/**
 * Newell area normal for an ordered face; zero for a degenerate face.
 * @param {Array<{x:number, y:number, z:number}>} vertices - Mesh vertices.
 * @param {Array<number>} face - Ordered vertex indices.
 * @returns {{x:number, y:number, z:number}} The face normal.
 */
export function faceNormal(vertices, face) {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < face.length; i++) {
    const a = vertices[face[i]];
    const b = vertices[face[(i + 1) % face.length]];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }

  return { x: nx, y: ny, z: nz };
}

/**
 * Tests whether an ordered planar face has a consistent turn direction.
 *
 * @param {Array<{x:number, y:number, z:number}>} vertices - Mesh vertices.
 * @param {Array<number>} face - Ordered vertex indices for one face.
 * @returns {boolean} True when the face is convex or has fewer than four vertices.
 */
export function isConvexFace(vertices, face) {
  if (face.length < 4) return true;

  const { x: nx, y: ny, z: nz } = faceNormal(vertices, face);

  const normalLengthSquared = nx * nx + ny * ny + nz * nz;
  if (normalLengthSquared === 0) return true;
  const tolerance = normalLengthSquared * 1e-12;
  let turnSign = 0;

  for (let i = 0; i < face.length; i++) {
    const a = vertices[face[i]];
    const b = vertices[face[(i + 1) % face.length]];
    const c = vertices[face[(i + 2) % face.length]];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const bcx = c.x - b.x;
    const bcy = c.y - b.y;
    const bcz = c.z - b.z;
    const turn = (aby * bcz - abz * bcy) * nx
      + (abz * bcx - abx * bcz) * ny
      + (abx * bcy - aby * bcx) * nz;
    if (Math.abs(turn) <= tolerance) continue;
    const sign = Math.sign(turn);
    if (turnSign !== 0 && sign !== turnSign) return false;
    turnSign = sign;
  }

  return true;
}

/**
 * Fan-triangulates one polygon face, calling emit() once per triangle with its
 * three corners in the face's winding order. A convex face fans from its first
 * corner; anything else fans from the centroid.
 *
 * @param {Array<{x:number, y:number, z:number}>} vertices - Mesh vertices.
 * @param {Array<number>} face - Ordered vertex indices for one face.
 * @param {(a: {x:number, y:number, z:number}, b: {x:number, y:number, z:number}, c: {x:number, y:number, z:number}) => void} emit - Receives each triangle; the centroid corner is a plain {x, y, z}.
 * @param {boolean} [forceCentroid=false] - Always take the centroid fan, even on a convex face.
 * @details The centroid scales by the reciprocal count, matching
 * THREE.Vector3.divideScalar().
 */
export function fanTriangulateFace(vertices, face, emit, forceCentroid = false) {
  if (!forceCentroid && isConvexFace(vertices, face)) {
    for (let i = 1; i < face.length - 1; i++) {
      emit(vertices[face[0]], vertices[face[i]], vertices[face[i + 1]]);
    }
    return;
  }

  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const idx of face) {
    cx += vertices[idx].x;
    cy += vertices[idx].y;
    cz += vertices[idx].z;
  }
  const inv = 1 / face.length;
  const centroid = { x: cx * inv, y: cy * inv, z: cz * inv };
  for (let i = 0; i < face.length; i++) {
    emit(centroid, vertices[face[i]], vertices[face[(i + 1) % face.length]]);
  }
}

/**
 * Extracts the unique undirected edges of a polygon-face mesh as [lo, hi] vertex
 * index pairs.
 * @param {Array<Array<number>>} faces - Ordered vertex indices per face.
 * @param {number} vertexCount - Vertex count of the mesh, used as the key radix.
 * @returns {Array<[number, number]>} One [lo, hi] pair per undirected edge, in first-seen order.
 */
export function uniqueEdges(faces, vertexCount) {
  const seen = new Set();
  /** @type {Array<[number, number]>} */
  const edges = [];
  for (const f of faces) {
    for (let i = 0; i < f.length; i++) {
      const a = f[i];
      const b = f[(i + 1) % f.length];
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * vertexCount + hi;
      if (!seen.has(key)) { seen.add(key); edges.push([lo, hi]); }
    }
  }
  return edges;
}

/**
 * Chooses the barycentric subdivision level for the geodesic (sphere-curved)
 * face tessellation: ~3° of arc per segment on the largest face, capped by a
 * total-triangle budget so dense meshes don't explode, and clamped to [1, 24].
 * @param {number} maxArc - Largest edge arc in radians over all fan triangles.
 * @param {number} triCount - Total fan triangles the mesh would emit unsubdivided.
 * @returns {number} Segments per triangle side, uniform across the whole mesh.
 * @details The level must be uniform across the mesh or shared edges crack.
 */
export function geodesicSegments(maxArc, triCount) {
  const nArc = Math.ceil(maxArc / (Math.PI / 60));
  const nBudget = Math.floor(Math.sqrt(400000 / Math.max(1, triCount)));
  return Math.max(1, Math.min(24, nArc, nBudget));
}

/**
 * Normalizes a barycentric mix of three points onto the unit sphere.
 * @param {{x:number, y:number, z:number}} a - First corner.
 * @param {{x:number, y:number, z:number}} b - Second corner.
 * @param {{x:number, y:number, z:number}} c - Third corner.
 * @param {number} wa - Weight on a.
 * @param {number} wb - Weight on b.
 * @param {number} wc - Weight on c.
 * @returns {[number, number, number]} The normalized point's coordinates.
 * @details Scales by the reciprocal length, bit-matching THREE.Vector3.normalize().
 * A zero-length mix keeps its coordinates.
 */
function normalizedBarycentric(a, b, c, wa, wb, wc) {
  let x = a.x * wa;
  let y = a.y * wa;
  let z = a.z * wa;
  x += b.x * wb;
  y += b.y * wb;
  z += b.z * wb;
  x += c.x * wc;
  y += c.y * wc;
  z += c.z * wc;
  const inv = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
  return [x * inv, y * inv, z * inv];
}

/**
 * Tessellates one fan triangle into n² spherical sub-triangles on a barycentric
 * grid of n segments per side, each grid point projected onto the unit sphere.
 *
 * Grid point P(gi, gj) = normalize(a·(1 − (gi+gj)/n) + b·(gi/n) + c·(gj/n)), rows
 * shrinking toward the b corner (gi + gj <= n). n must be uniform across the
 * mesh or shared edges crack.
 *
 * @param {{x:number, y:number, z:number}} a - Fan apex (typically the face centroid).
 * @param {{x:number, y:number, z:number}} b - Second corner.
 * @param {{x:number, y:number, z:number}} c - Third corner.
 * @param {number} n - Segments per triangle side; n = 1 emits the single unsubdivided triangle.
 * @returns {number[]} Flat x/y/z triples in triangle-list order, 9n² entries long.
 */
export function geodesicTriangleVertices(a, b, c, n) {
  const grid = [];
  for (let gi = 0; gi <= n; gi++) {
    const row = [];
    for (let gj = 0; gj <= n - gi; gj++) {
      row.push(normalizedBarycentric(a, b, c, 1 - (gi + gj) / n, gi / n, gj / n));
    }
    grid.push(row);
  }

  /** @type {number[]} */
  const out = [];
  const emit = (/** @type {number[]} */ p) => out.push(p[0], p[1], p[2]);
  for (let gi = 0; gi < n; gi++) {
    for (let gj = 0; gj < n - gi; gj++) {
      emit(grid[gi][gj]);
      emit(grid[gi + 1][gj]);
      emit(grid[gi][gj + 1]);
      // The last cell of a row is a lone corner triangle with no upper partner.
      if (gj < n - gi - 1) {
        emit(grid[gi + 1][gj]);
        emit(grid[gi + 1][gj + 1]);
        emit(grid[gi][gj + 1]);
      }
    }
  }
  return out;
}
