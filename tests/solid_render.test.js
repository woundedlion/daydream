import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeshRenderer, meshStatsLine, meshCanvasLabel } from '../tools/solid_render.js';
import { fakeElement } from './fake_dom.js';
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  LineSegments,
  Mesh,
  Points,
  Scene,
  Vector3,
} from './fake_three.js';

const THREE = {
  Vector3, Color, BufferGeometry, Float32BufferAttribute, Mesh, Points, LineSegments,
};

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
  const scene = new Scene();
  const materials = fakeMaterials();
  const labelsContainer = fakeLabels();
  const renderer = createMeshRenderer({
    THREE, scene, materials, labelsContainer, doc: fakeDoc(),
  });
  return { renderer, scene, materials, labelsContainer };
}

const kinds = (scene) => scene.children.map((o) => o.constructor.name);
const find = (scene, kind) => scene.children.find((o) => o.constructor.name === kind);

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
  assert.equal(result.edgeCount, 6,
    'the edge count is reported back, not written onto the mesh');
  assert.deepEqual(Object.keys(mesh).sort(), keysBefore);
});

test('the stats line reports vertices, edges, faces and indices', () => {
  assert.equal(meshStatsLine(tetrahedron(), 6), '4V / 6E / 4F / 12I');
  const quads = { vertices: new Array(8), faces: [[0, 1, 2, 3], [4, 5, 6, 7]] };
  assert.equal(meshStatsLine(quads, 12), '8V / 12E / 2F / 8I');
});

test('the canvas name says which solid is on screen', () => {
  assert.equal(meshCanvasLabel('Tetrahedron', [], tetrahedron(), 6),
    'Real-time 3D preview of Tetrahedron: 4 vertices, 6 edges, 4 faces.');
  assert.equal(meshCanvasLabel('Cube', ['kis', 'dual'], tetrahedron(), 6),
    'Real-time 3D preview of Cube after kis, dual: 4 vertices, 6 edges, 4 faces.');
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

  const normals = scene.children.filter((o) => o.constructor.name === 'LineSegments');
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

test('the geodesic budget counts the centroid-fan triangles the mesh emits', () => {
  const { renderer, scene } = setup();
  // Four vertices and 4000 repeated faces: the fan count grows, the edge and
  // vertex work does not.
  const dense = tetrahedron();
  dense.faces = Array.from({ length: 1000 }, () => TETRA_FACES.map((f) => [...f])).flat();

  renderer.render(dense, view({ showGeodesics: true }), null);
  const triangles = find(scene, 'Mesh').geometry.attributes.position.array.length / 9;

  // 4000 faces * 3 centroid-fan triangles, subdivided 5 x 5.
  assert.equal(triangles, 4000 * 3 * 25);
  assert.ok(triangles <= 400000, 'the tessellation must stay inside its triangle budget');
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
    assert.equal(object.geometry.disposals, 1, `${object.constructor.name} leaked its geometry`);
  }
  assert.deepEqual(kinds(scene), ['Mesh', 'LineSegments']);

  // The toggles that went off left nothing to dispose a second time.
  renderer.render(tetrahedron(), view(), null);
  for (const object of first) {
    assert.equal(object.geometry.disposals, 1, `${object.constructor.name} was disposed twice`);
  }
});

test('index labels are built under the limit, carry their index, and are cleared each render', () => {
  const { renderer, labelsContainer } = setup();
  const result = renderer.render(tetrahedron(), view({ showIndices: true }), null);

  assert.equal(result.labelsBuilt, true, 'the caller re-projects only labels it is told about');
  assert.equal(labelsContainer.children.length, 4);
  // The page re-projects the labels by parseInt-ing data-index, so the index has
  // to arrive as the string a browser stores, on an attribute a selector finds.
  assert.deepEqual(labelsContainer.children.map((el) => el.textContent),
    ['0', '1', '2', '3']);
  assert.deepEqual(labelsContainer.children.map((el) => el.dataset.index),
    ['0', '1', '2', '3']);
  assert.deepEqual(labelsContainer.querySelectorAll('[data-index]'),
    labelsContainer.children);

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

test('a renderer built without a labels overlay still renders with indices on', () => {
  const renderer = createMeshRenderer({
    THREE, scene: new Scene(), materials: fakeMaterials(), doc: fakeDoc(),
  });
  const result = renderer.render(tetrahedron(), view({ showIndices: true }), null);
  assert.equal(result.labelsBuilt, false);
});

test('teardown disposes whatever is currently built', () => {
  const { renderer, scene } = setup();
  renderer.render(tetrahedron(), view({ showVertices: true }), null);
  const built = [...scene.children];
  renderer.disposeGeometry();
  for (const object of built) {
    assert.equal(object.geometry.disposals, 1, `${object.constructor.name} survived teardown`);
  }
});
