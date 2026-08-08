import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeshRenderer, meshStatsLine } from '../tools/solid_render.js';
import { uniqueEdges } from '../tools/solid_codegen.js';
import { fakeElement } from './fake_dom.js';

// Stand-in for the three.js surface the renderer constructs. The vector math is
// real, so the emitted positions are the ones a browser would get; the geometry
// and object classes only record what they were handed.

class Vector3 {
  /** @param {number} [x] @param {number} [y] @param {number} [z] */
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  /** @param {Vector3} v @returns {Vector3} */
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  /** @returns {Vector3} */
  clone() { return new Vector3(this.x, this.y, this.z); }
  /** @param {Vector3} v @returns {Vector3} */
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  /** @param {Vector3} a @param {Vector3} b @returns {Vector3} */
  subVectors(a, b) { this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this; }
  /** @param {Vector3} a @param {Vector3} b @returns {Vector3} */
  crossVectors(a, b) {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    this.x = x; this.y = y; this.z = z;
    return this;
  }
  /** @param {number} s @returns {Vector3} */
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  /** @param {number} s @returns {Vector3} */
  divideScalar(s) { return this.multiplyScalar(1 / s); }
  /** @returns {number} */
  length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
  /** @param {Vector3} v @returns {number} */
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
  /** @returns {Vector3} */
  normalize() {
    const l = this.length();
    return l === 0 ? this : this.multiplyScalar(1 / l);
  }
  /** @param {Vector3} v @param {number} t @returns {Vector3} */
  lerp(v, t) {
    this.x += (v.x - this.x) * t;
    this.y += (v.y - this.y) * t;
    this.z += (v.z - this.z) * t;
    return this;
  }
  /** @param {Vector3} v @returns {number} */
  angleTo(v) {
    const denom = this.length() * v.length();
    if (denom === 0) return Math.PI / 2;
    return Math.acos(Math.min(1, Math.max(-1, this.dot(v) / denom)));
  }
}

class Color {
  constructor() { this.r = 1; this.g = 1; this.b = 1; this.hsl = []; }
  /**
   * Records the request and keeps the three arguments distinguishable as r/g/b,
   * so the per-vertex color emission can be traced back to the face that set it.
   * @param {number} h @param {number} s @param {number} l @returns {Color}
   */
  setHSL(h, s, l) { this.hsl.push([h, s, l]); this.r = h; this.g = s; this.b = l; return this; }
}

class BufferGeometry {
  constructor() {
    this.attributes = {};
    this.points = null;
    this.normalPasses = 0;
    this.disposals = 0;
  }
  /** @param {string} name @param {Object} attribute @returns {BufferGeometry} */
  setAttribute(name, attribute) { this.attributes[name] = attribute; return this; }
  computeVertexNormals() { this.normalPasses += 1; }
  /** @param {Array<Vector3>} points @returns {BufferGeometry} */
  setFromPoints(points) { this.points = points; return this; }
  dispose() { this.disposals += 1; }
}

class Float32BufferAttribute {
  /** @param {Array<number>} array @param {number} itemSize */
  constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
}

/** @param {string} kind @returns {Function} A scene-object class tagged with `kind`. */
const sceneObject = (kind) => class {
  /** @param {BufferGeometry} geometry @param {Object} material */
  constructor(geometry, material) {
    this.kind = kind;
    this.geometry = geometry;
    this.material = material;
  }
};

const THREE = {
  Vector3,
  Color,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh: sceneObject('Mesh'),
  Points: sceneObject('Points'),
  LineSegments: sceneObject('LineSegments'),
};

/** @returns {{add: Function, remove: Function, children: Array<Object>}} Scene double. */
function fakeScene() {
  return {
    children: [],
    add(object) { this.children.push(object); },
    remove(object) {
      const at = this.children.indexOf(object);
      if (at >= 0) this.children.splice(at, 1);
    },
  };
}

/** @returns {Object} The five shared materials, each tagged by role. */
const fakeMaterials = () => ({
  face: { role: 'face', flatShading: true, needsUpdate: false },
  faceColorize: { role: 'faceColorize', flatShading: true, needsUpdate: false },
  vert: { role: 'vert' },
  edge: { role: 'edge' },
  normal: { role: 'normal' },
});

/**
 * A labels overlay that flattens an inserted fragment, as the DOM does.
 * @returns {Object} The container element.
 */
function fakeLabels() {
  const host = fakeElement('div');
  const appendChild = host.appendChild.bind(host);
  host.appendChild = (node) => {
    if (!node.isFragment) return appendChild(node);
    host.append(...node.children);
    return node;
  };
  return host;
}

/**
 * Document double: label divs plus the fragment they are staged in.
 * @returns {{createElement: Function, createDocumentFragment: Function}} The document.
 */
function fakeDoc() {
  return {
    createElement: (tag) => fakeElement(tag),
    createDocumentFragment: () => {
      const frag = fakeElement('div');
      frag.isFragment = true;
      return frag;
    },
  };
}

const VIEW = {
  showGeodesics: false,
  showFaces: true,
  colorizeFaces: false,
  showVertices: false,
  showNormals: false,
  showIndices: false,
};

/** @param {Object} [overrides] @returns {Object} The page's presentation flags. */
const view = (overrides = {}) => ({ ...VIEW, ...overrides });

// A unit tetrahedron: four triangles, six edges, twelve indices.
const TETRA_VERTICES = [
  [1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1],
];
const TETRA_FACES = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];

/** @returns {{vertices: Array<Vector3>, faces: Array<Array<number>>}} A fresh mesh readback. */
const tetrahedron = () => ({
  vertices: TETRA_VERTICES.map(([x, y, z]) => new Vector3(x, y, z).normalize()),
  faces: TETRA_FACES.map((f) => [...f]),
});

/**
 * A renderer over fresh doubles.
 * @returns {Object} The renderer plus the scene, materials and labels it draws into.
 */
function setup() {
  const scene = fakeScene();
  const materials = fakeMaterials();
  const labelsContainer = fakeLabels();
  const renderer = createMeshRenderer({
    THREE, scene, materials, labelsContainer, doc: fakeDoc(),
  });
  return { renderer, scene, materials, labelsContainer };
}

const kinds = (scene) => scene.children.map((o) => o.kind);
const find = (scene, kind) => scene.children.find((o) => o.kind === kind);

test('a faces-only render builds exactly the mesh and its edge lines', () => {
  const { renderer, scene, materials } = setup();
  const mesh = tetrahedron();
  const result = renderer.render(mesh, view(), null);

  assert.deepEqual(kinds(scene), ['Mesh', 'LineSegments']);
  assert.equal(find(scene, 'Mesh').material, materials.face);
  assert.equal(find(scene, 'LineSegments').material, materials.edge);
  assert.equal(result.edgeCount, 6);
  assert.equal(result.labelsBuilt, false);
  // Four triangles, three vertices each, three floats per vertex.
  assert.equal(find(scene, 'Mesh').geometry.attributes.position.array.length, 4 * 3 * 3);
  assert.equal(find(scene, 'Mesh').geometry.attributes.color, undefined);
});

test('the render leaves the caller\'s mesh untouched', () => {
  const { renderer } = setup();
  const mesh = tetrahedron();
  const keysBefore = Object.keys(mesh).sort();
  const result = renderer.render(mesh, view(), null);
  assert.equal(result.edgeCount, uniqueEdges(mesh.faces, mesh.vertices.length).length,
    'the edge count is reported back, not written onto the mesh');
  assert.deepEqual(Object.keys(mesh).sort(), keysBefore);
});

test('the stats line reports vertices, edges, faces and indices', () => {
  assert.equal(meshStatsLine(tetrahedron(), 6), '4V / 6E / 4F / 12I');
  const quads = { vertices: new Array(8), faces: [[0, 1, 2, 3], [4, 5, 6, 7]] };
  assert.equal(meshStatsLine(quads, 12), '8V / 12E / 2F / 8I');
});

test('hiding faces drops the mesh but keeps the edge cage', () => {
  const { renderer, scene } = setup();
  const result = renderer.render(tetrahedron(), view({ showFaces: false }), null);
  assert.deepEqual(kinds(scene), ['LineSegments']);
  assert.equal(result.edgeCount, 6, 'the stats line still needs the edge count');
});

test('the vertex and normal toggles add their own objects with their own materials', () => {
  const { renderer, scene, materials } = setup();
  renderer.render(tetrahedron(), view({ showVertices: true, showNormals: true }), null);

  assert.deepEqual(kinds(scene), ['Mesh', 'Points', 'LineSegments', 'LineSegments']);
  assert.equal(find(scene, 'Points').material, materials.vert);
  assert.equal(find(scene, 'Points').geometry.points.length, 4);

  const normals = scene.children.filter((o) => o.kind === 'LineSegments');
  assert.equal(normals[1].material, materials.normal);
  // One two-point segment per face, colored green at both ends.
  assert.equal(normals[1].geometry.points.length, 8);
  assert.equal(normals[1].geometry.attributes.color.array.length, 4 * 6);
});

test('geodesic mode tessellates the faces and supplies its own smooth normals', () => {
  const flat = setup();
  flat.renderer.render(tetrahedron(), view(), null);
  const flatPositions = find(flat.scene, 'Mesh').geometry.attributes.position.array;

  const curved = setup();
  curved.renderer.render(tetrahedron(), view({ showGeodesics: true }), null);
  const geometry = find(curved.scene, 'Mesh').geometry;

  assert.ok(geometry.attributes.position.array.length > flatPositions.length,
    'the geodesic pass must subdivide each fan triangle');
  assert.deepEqual(geometry.attributes.normal.array, geometry.attributes.position.array,
    'every emitted vertex is on the unit sphere, so its normal is its position');
  assert.notEqual(geometry.attributes.normal.array, geometry.attributes.position.array,
    'the normal attribute must own its copy');
  assert.equal(geometry.normalPasses, 0,
    'computeVertexNormals would facet the tessellation');
});

test('flat shading is switched with the geodesic toggle, and only when it changes', () => {
  const { renderer, materials } = setup();
  renderer.render(tetrahedron(), view(), null);
  assert.equal(materials.face.flatShading, true);
  assert.equal(materials.face.needsUpdate, false, 'an unchanged material must not be recompiled');

  renderer.render(tetrahedron(), view({ showGeodesics: true }), null);
  for (const m of [materials.face, materials.faceColorize]) {
    assert.equal(m.flatShading, false, 'flat shading would facet the sphere');
    assert.equal(m.needsUpdate, true);
  }

  materials.face.needsUpdate = false;
  materials.faceColorize.needsUpdate = false;
  renderer.render(tetrahedron(), view({ showGeodesics: true }), null);
  assert.equal(materials.face.needsUpdate, false, 'a repeat render must not recompile');
});

test('colorizing emits one class color per emitted vertex and swaps the material', () => {
  const { renderer, scene, materials } = setup();
  const classes = Int32Array.from([0, 1, 1, 2]);
  renderer.render(tetrahedron(), view({ colorizeFaces: true }), classes);

  const geometry = find(scene, 'Mesh').geometry;
  assert.equal(find(scene, 'Mesh').material, materials.faceColorize);
  assert.equal(geometry.attributes.color.array.length, geometry.attributes.position.array.length);

  // Golden-ratio hue stride: the two faces sharing class 1 share a hue, and the
  // three distinct classes take three distinct hues.
  const hues = geometry.attributes.color.array.filter((_, i) => i % 3 === 0);
  const perFace = [hues[0], hues[3], hues[6], hues[9]];
  assert.deepEqual(perFace, [0, 0.618034, 0.618034, (2 * 0.618034) % 1]);
});

test('colorize is ignored while faces are hidden', () => {
  const { renderer, scene } = setup();
  renderer.render(tetrahedron(), view({ colorizeFaces: true, showFaces: false }),
    Int32Array.from([0, 1, 2, 3]));
  assert.deepEqual(kinds(scene), ['LineSegments'],
    'a color attribute for hidden geometry is wasted work');
});

test('a re-render disposes the previous objects and leaves one set in the scene', () => {
  const { renderer, scene } = setup();
  renderer.render(tetrahedron(), view({ showVertices: true, showNormals: true }), null);
  const first = [...scene.children];

  renderer.render(tetrahedron(), view(), null);
  for (const object of first) {
    assert.equal(object.geometry.disposals, 1, `${object.kind} leaked its geometry`);
  }
  assert.deepEqual(kinds(scene), ['Mesh', 'LineSegments']);

  // The toggles that went off left nothing to dispose a second time.
  renderer.render(tetrahedron(), view(), null);
  for (const object of first) {
    assert.equal(object.geometry.disposals, 1, `${object.kind} was disposed twice`);
  }
});

test('index labels are built under the limit, carry their index, and are cleared each render', () => {
  const { renderer, labelsContainer } = setup();
  const result = renderer.render(tetrahedron(), view({ showIndices: true }), null);

  assert.equal(result.labelsBuilt, true, 'the caller re-projects only labels it is told about');
  assert.equal(labelsContainer.children.length, 4);
  assert.deepEqual(labelsContainer.children.map((el) => el.textContent), [0, 1, 2, 3]);
  assert.deepEqual(labelsContainer.children.map((el) => el.dataset.index), [0, 1, 2, 3]);

  const again = renderer.render(tetrahedron(), view(), null);
  assert.equal(again.labelsBuilt, false);
  assert.equal(labelsContainer.children.length, 0, 'stale labels would float over the new mesh');
});

test('a mesh at the label ceiling gets no labels at all', () => {
  const { renderer, labelsContainer } = setup();
  const big = {
    vertices: Array.from({ length: 1000 }, (_, i) => new Vector3(i + 1, 0, 0)),
    faces: [[0, 1, 2]],
  };
  const result = renderer.render(big, view({ showIndices: true }), null);
  assert.equal(result.labelsBuilt, false);
  assert.equal(labelsContainer.children.length, 0, '1000 labels is past the projection budget');
});

test('teardown disposes whatever is currently built', () => {
  const { renderer, scene } = setup();
  renderer.render(tetrahedron(), view({ showVertices: true }), null);
  const built = [...scene.children];
  renderer.disposeGeometry();
  for (const object of built) {
    assert.equal(object.geometry.disposals, 1, `${object.kind} survived teardown`);
  }
});
