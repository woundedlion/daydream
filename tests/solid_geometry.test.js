import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  faceNormal,
  isConvexFace,
  fanTriangulateFace,
  uniqueEdges,
  geodesicSegments,
  geodesicTriangleVertices,
} from '../src/workbench/solids/solid_geometry.js';

/** Verifies the Newell normal of a triangle off every coordinate plane is its edge cross product. */
test('faceNormal of a tilted triangle is its edge cross product', () => {
  const vertices = [{ x: 1, y: 2, z: 3 }, { x: 4, y: 0, z: 5 }, { x: 2, y: 6, z: 1 }];
  const [a, b, c] = vertices;
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  assert.deepEqual(faceNormal(vertices, [0, 1, 2]), {
    x: u.y * v.z - u.z * v.y,
    y: u.z * v.x - u.x * v.z,
    z: u.x * v.y - u.y * v.x,
  });
});

test('isConvexFace accepts a convex face', () => {
  const vertices = [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
    { x: 2, y: 2, z: 0 },
    { x: 0, y: 2, z: 0 },
  ];
  assert.equal(isConvexFace(vertices, [0, 1, 2, 3]), true);
});

test('isConvexFace rejects a concave star face', () => {
  const vertices = Array.from({ length: 10 }, (_, i) => {
    const angle = i * Math.PI / 5;
    const radius = i % 2 === 0 ? 2 : 0.8;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), z: 0 };
  });
  assert.equal(isConvexFace(vertices, vertices.map((_, i) => i)), false);
});

const SQUARE = [
  { x: 0, y: 0, z: 0 },
  { x: 2, y: 0, z: 0 },
  { x: 2, y: 2, z: 0 },
  { x: 0, y: 2, z: 0 },
];

/** Collects fanTriangulateFace's emitted corners as flat x/y/z triples. */
const fanCorners = (vertices, face, forceCentroid) => {
  const out = [];
  fanTriangulateFace(vertices, face, (a, b, c) => {
    out.push([a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z]);
  }, forceCentroid);
  return out;
};

test('fanTriangulateFace fans a convex face from its first corner', () => {
  assert.deepEqual(fanCorners(SQUARE, [0, 1, 2, 3]), [
    [0, 0, 0], [2, 0, 0], [2, 2, 0],
    [0, 0, 0], [2, 2, 0], [0, 2, 0],
  ]);
});

test('fanTriangulateFace fans a non-convex face from its centroid', () => {
  const star = Array.from({ length: 10 }, (_, i) => {
    const angle = i * Math.PI / 5;
    const radius = i % 2 === 0 ? 2 : 0.8;
    return { x: radius * Math.cos(angle), y: radius * Math.sin(angle), z: 0 };
  });
  const face = star.map((_, i) => i);
  const corners = fanCorners(star, face);
  // One triangle per edge, apex first, and no apex is a face vertex.
  assert.equal(corners.length, face.length * 3);
  for (let i = 0; i < corners.length; i += 3) {
    assert.deepEqual(corners[i], corners[0]);
    assert.deepEqual(corners[i + 1], [star[i / 3].x, star[i / 3].y, star[i / 3].z]);
    assert.deepEqual(corners[i + 2],
      [star[(i / 3 + 1) % face.length].x, star[(i / 3 + 1) % face.length].y, 0]);
  }
  assert.ok(Math.hypot(corners[0][0], corners[0][1]) < 1e-9);
});

test('fanTriangulateFace forceCentroid takes the centroid fan on a convex face', () => {
  const corners = fanCorners(SQUARE, [0, 1, 2, 3], true);
  assert.equal(corners.length, 12);
  assert.deepEqual(corners[0], [1, 1, 0]);
});

/** Verifies uniqueEdges returns each undirected edge once, in first-seen order. */
test('uniqueEdges deduplicates shared edges across faces', () => {
  // Two triangles sharing edge 1-2: 5 distinct undirected edges.
  const edges = uniqueEdges([[0, 1, 2], [2, 1, 3]], 4);
  assert.deepEqual(edges, [[0, 1], [1, 2], [0, 2], [1, 3], [2, 3]]);
});

/** Verifies the lo*vertexCount+hi edge key never aliases two distinct edges. */
test('uniqueEdges keys stay unique at the vertex-count radix', () => {
  for (const vertexCount of [6, 1004]) {
    const faces = [[0, vertexCount - 1], [1, 3]];
    assert.deepEqual(uniqueEdges(faces, vertexCount), faces);
  }
});

/** Verifies a degenerate 2-gon face yields one edge rather than a self-pair. */
test('uniqueEdges collapses the two half-edges of a 2-gon', () => {
  assert.deepEqual(uniqueEdges([[0, 1]], 2), [[0, 1]]);
});

/** Verifies the geodesic level rounds the arc up to whole ~3-degree segments when the budget is slack. */
test('geodesicSegments targets three degrees of arc per segment', () => {
  const seg = Math.PI / 60;
  assert.equal(geodesicSegments(3.2 * seg, 4), 4);
  assert.equal(geodesicSegments(4.5 * seg, 4), 5);
});

/** Verifies the total-triangle budget caps the level on dense meshes. */
test('geodesicSegments caps dense meshes on the triangle budget', () => {
  // sqrt(400000 / 40000) = 3.16 -> 3, below the arc target for a 90-degree face.
  assert.equal(geodesicSegments(Math.PI / 2, 40000), 3);
  // 400000 triangles leave no subdivision headroom at all.
  assert.equal(geodesicSegments(Math.PI / 2, 400000), 1);
});

/** Verifies the level stays within [1, 24] for degenerate and huge arcs. */
test('geodesicSegments clamps to the [1, 24] range', () => {
  assert.equal(geodesicSegments(0, 1), 1);
  assert.equal(geodesicSegments(Math.PI, 1), 24);
});

/** Corners of a spherical octant, the fan triangle the tessellation tests subdivide. */
const OCTANT = [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }];

/** Reads the flat tessellation output back as {x, y, z} points. */
function points(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 3) out.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2] });
  return out;
}

/** Verifies n = 1 emits one triangle with its corners projected onto the unit sphere. */
test('geodesicTriangleVertices at n=1 projects the single triangle onto the unit sphere', () => {
  const corners = [{ x: 2, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 4 }];
  const flat = geodesicTriangleVertices(...corners, 1);
  assert.equal(flat.length, 9);
  assert.deepEqual(points(flat), OCTANT);
});

/** Verifies the emitted triangle count is n squared, the watertight subdivision of one fan triangle. */
test('geodesicTriangleVertices emits n^2 triangles', () => {
  for (const n of [1, 2, 3, 7]) {
    assert.equal(geodesicTriangleVertices(...OCTANT, n).length, 9 * n * n);
  }
});

/** Verifies every emitted vertex is projected onto the unit sphere, which is what curves the face. */
test('geodesicTriangleVertices projects every vertex onto the unit sphere', () => {
  for (const p of points(geodesicTriangleVertices(...OCTANT, 4))) {
    assert.ok(Math.abs(Math.hypot(p.x, p.y, p.z) - 1) < 1e-12);
  }
});

/**
 * Verifies the subdivision is watertight: the points along a triangle side are
 * shared by the sub-triangles either side of them, so no crack opens. Each
 * interior grid point must therefore appear in more than one emitted triangle,
 * and the three corners must each appear exactly once.
 */
test('geodesicTriangleVertices reuses grid points across sub-triangles', () => {
  const counts = new Map();
  for (const p of points(geodesicTriangleVertices(...OCTANT, 3))) {
    const key = `${p.x},${p.y},${p.z}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  // A grid of n=3 has 10 distinct points; the 3 corners belong to one triangle each.
  assert.equal(counts.size, 10);
  const once = [...counts.values()].filter(c => c === 1);
  assert.equal(once.length, 3);
});

/** Verifies a degenerate (zero-length) mix keeps its coordinates instead of dividing by zero. */
test('geodesicTriangleVertices survives a triangle collapsed on the origin', () => {
  const origin = { x: 0, y: 0, z: 0 };
  const flat = geodesicTriangleVertices(origin, origin, origin, 2);
  assert.equal(flat.length, 9 * 2 * 2, 'every cell of the n=2 subdivision is still emitted');
  assert.ok(flat.every((v) => v === 0), 'the collapsed vertices keep the origin');
});
