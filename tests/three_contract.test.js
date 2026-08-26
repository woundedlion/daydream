//
// Pins the three surface tests/fake_three.js stands in for, so the double the
// scene suites run over cannot drift from the library the tool pages load.
// Every other suite redirects `three` and its OrbitControls addon to the fake;
// this one imports the real modules and drives them over tests/fake_dom.js,
// which is enough DOM for OrbitControls to connect.
//
// A rename is what this catches. The double keeps answering the old name, so a
// browser-side `TypeError: … is not a function` — or, for a field, an
// assignment that lands nowhere and is not an error at all — reads here as a
// green run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import * as fake from './fake_three.js';
import { fakeElement } from './fake_dom.js';

// Classes tools/shared.js constructs, and so the double must carry.
const STOOD_IN = [
  'Object3D', 'Scene', 'Color', 'SphereGeometry', 'MeshBasicMaterial', 'Mesh',
  'PerspectiveCamera', 'WebGLRenderer', 'AmbientLight', 'DirectionalLight',
  'SpotLight', 'Vector3', 'BufferGeometry', 'Float32BufferAttribute', 'Points',
  'LineSegments',
];

/**
 * The vector arithmetic tools/solid_render.js emits its positions with, run
 * end to end.
 * @param {typeof THREE.Vector3} Vector3 - The class under test.
 * @returns {number[]} Every quantity the sequence produces, in order.
 */
function vectorRun(Vector3) {
  const a = new Vector3(1, 2, 3);
  const b = new Vector3(-4, 5, 6);
  const middle = new Vector3().copy(a).add(b).divideScalar(2);
  const normal = new Vector3().crossVectors(
    new Vector3().subVectors(b, a), new Vector3().subVectors(middle, a)).normalize();
  const arc = a.clone().lerp(b, 0.25).normalize().multiplyScalar(1.002);
  return [
    middle.x, middle.y, middle.z,
    normal.x, normal.y, normal.z,
    arc.x, arc.y, arc.z,
    a.length(), a.dot(b), a.angleTo(b),
    new Vector3().normalize().length(),
  ];
}

/**
 * A canvas stand-in OrbitControls can connect to: it reaches past the element
 * for the document that carries the pointer-move listeners and for the root
 * node that carries the capture-phase keydown, and its connect() disconnects
 * first, removing listeners that were never added.
 * @returns {Object} The canvas element.
 */
function controlsCanvas() {
  const canvas = fakeElement('canvas', { allowRedundantRemoval: true });
  canvas.ownerDocument = { addEventListener() {}, removeEventListener() {} };
  canvas.getRootNode = () => canvas.ownerDocument;
  return canvas;
}

/**
 * Builds a real OrbitControls over a real camera and a fake canvas.
 * @returns {OrbitControls} The controls, connected.
 */
function realControls() {
  return new OrbitControls(new THREE.PerspectiveCamera(45, 1, 0.1, 1000), controlsCanvas());
}

test('three still exports every class the double stands in for', () => {
  for (const name of STOOD_IN) {
    assert.equal(typeof THREE[name], 'function', `three.${name}`);
    assert.equal(typeof fake[name], 'function', `fake_three.${name}`);
  }
});

test('the scene graph disposes and clears through the methods initScene calls', () => {
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(1.0, 8, 4);
  const material = new THREE.MeshBasicMaterial({ wireframe: true });
  scene.add(new THREE.Mesh(geometry, material));
  assert.equal(scene.children.length, 1);

  scene.clear();
  assert.deepEqual(scene.children, [], 'clear() empties the scene');

  // dispose() releases the GPU resource by announcing it; a dispose that stopped
  // announcing would leak every scene the tool pages rebuild.
  const disposed = [];
  geometry.addEventListener('dispose', () => disposed.push('geometry'));
  material.addEventListener('dispose', () => disposed.push('material'));
  geometry.dispose();
  material.dispose();
  assert.deepEqual(disposed, ['geometry', 'material']);
});

// The resize path: a container that changed shape sets aspect and rebuilds the
// projection, and a rebuild that read the old aspect would letterbox every page.
test('updateProjectionMatrix rebuilds the projection from the new aspect', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  const square = camera.projectionMatrix.elements[0];
  assert.ok(square > 0, `a square viewport has a positive x scale, got ${square}`);

  camera.aspect = 2;
  camera.updateProjectionMatrix();

  assert.ok(Math.abs(camera.projectionMatrix.elements[0] - square / 2) < 1e-12,
    `doubling the aspect halves the x scale, got ${camera.projectionMatrix.elements[0]}`);
  assert.equal(camera.projectionMatrix.elements[5], square,
    'the vertical field of view is what stays fixed');
});

// WebGLRenderer assigns its methods in the constructor and needs a live WebGL
// context to construct, so its source is the only headless view of the surface.
// Both spellings count: a constructor assignment, and the class field or method
// an upstream conversion would write instead. A rename reads as neither.
const declares = (method) => new RegExp(
  `^\\s*this\\.${method}\\s*=\\s*(?:async\\s+)?function`
    + `|^\\s*${method}\\s*`
    + `(?:=\\s*(?:async\\s+)?(?:function|\\()|\\()`,
  'm');

test('WebGLRenderer still assigns the methods initScene calls', () => {
  const source = THREE.WebGLRenderer.toString();
  for (const method of ['setSize', 'setPixelRatio', 'render', 'dispose', 'forceContextLoss']) {
    assert.match(source, declares(method), `renderer.${method}`);
  }
  assert.doesNotMatch(source, declares('setSizeAndPixelRatio'),
    'a method the renderer never had must not read as declared');
});

test('a fresh object sits at the origin and position.set chains, on both', () => {
  for (const [label, Class] of [['three', THREE.Object3D], ['fake_three', fake.Object3D]]) {
    const object = new Class();
    const { position } = object;
    assert.deepEqual([position.x, position.y, position.z], [0, 0, 0], `${label} origin`);
    assert.equal(position.set(1, 2, 3), position, `${label} set() returns the vector`);
    assert.deepEqual([position.x, position.y, position.z], [1, 2, 3], `${label} set()`);
  }
});

// The upload semantics fakeColorAttribute models. `version` is what
// WebGLAttributes compares, and a readable needsUpdate would let a test assert
// on a flag the renderer never looks at.
test('needsUpdate is write-only and only ever raises version, on both', () => {
  const real = new THREE.InstancedBufferAttribute(new Uint16Array(12), 3);
  const double = fake.fakeColorAttribute(new Uint16Array(12));

  for (const [label, attribute] of [['three', real], ['fake_three', double]]) {
    assert.equal(attribute.version, 0, `${label} starts unflagged`);

    attribute.needsUpdate = true;
    attribute.needsUpdate = true;
    assert.equal(attribute.version, 2, `${label} counts each flagged upload`);

    attribute.needsUpdate = false;
    assert.equal(attribute.version, 2, `${label} unflagged an upload`);
    assert.equal(attribute.needsUpdate, undefined, `${label} needsUpdate reads back`);
  }
});

test('the double runs the vector arithmetic solid_render emits positions with', () => {
  const real = vectorRun(THREE.Vector3);
  const double = vectorRun(fake.Vector3);

  assert.equal(double.length, real.length);
  for (const [index, value] of double.entries()) {
    assert.ok(Math.abs(value - real[index]) <= 1e-12,
      `term ${index}: the double answers ${value} for ${real[index]}`);
  }
});

// three converts to RGB; the double stores the request so an emitted vertex
// color names the class that set it. Only the chaining is common ground.
test('setHSL is a chainable write on both', () => {
  const real = new THREE.Color();
  const double = new fake.Color();

  assert.equal(real.setHSL(0.25, 0.65, 0.55), real, 'three chains');
  assert.equal(double.setHSL(0.25, 0.65, 0.55), double, 'fake_three chains');
  assert.deepEqual([double.r, double.g, double.b], [0.25, 0.65, 0.55],
    'the double keeps h/s/l readable back off r/g/b');
});

test('BufferGeometry takes the attributes and points solid_render builds, on both', () => {
  const points = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)];
  for (const [label, module] of [['three', THREE], ['fake_three', fake]]) {
    const geometry = new module.BufferGeometry();
    const attribute = new module.Float32BufferAttribute([1, 0, 0], 3);

    assert.equal(geometry.setAttribute('position', attribute), geometry,
      `${label} setAttribute chains`);
    assert.equal(geometry.attributes.position.itemSize, 3,
      `${label} holds the attribute by name`);
    assert.equal(typeof geometry.computeVertexNormals, 'function',
      `${label} computeVertexNormals`);

    const fromPoints = new module.BufferGeometry();
    assert.equal(fromPoints.setFromPoints(points), fromPoints,
      `${label} setFromPoints chains`);
    geometry.dispose();
  }
});

test('Float32BufferAttribute carries the array and item size, on both', () => {
  const values = [0, 1, 2, 3, 4, 5];
  for (const [label, module] of [['three', THREE], ['fake_three', fake]]) {
    const attribute = new module.Float32BufferAttribute(values, 3);
    assert.equal(attribute.itemSize, 3, `${label} itemSize`);
    assert.deepEqual([...attribute.array], values, `${label} array`);
  }
});

// The suites read the built objects back by constructor name, so a renamed
// class would read as a missing object rather than as a rename.
test('the geometry objects hold what they were constructed with, on both', () => {
  for (const [label, module] of [['three', THREE], ['fake_three', fake]]) {
    for (const name of ['Mesh', 'Points', 'LineSegments']) {
      const geometry = new module.BufferGeometry();
      const material = new module.MeshBasicMaterial({});
      const object = new module[name](geometry, material);

      assert.equal(object.geometry, geometry, `${label} ${name}.geometry`);
      assert.equal(object.material, material, `${label} ${name}.material`);
      assert.equal(object.constructor.name, name, `${label} ${name} names itself`);
    }
  }
});

test('the scene adds and removes the objects a re-render swaps, on both', () => {
  for (const [label, module] of [['three', THREE], ['fake_three', fake]]) {
    const scene = new module.Scene();
    const first = new module.Mesh(new module.BufferGeometry(),
      new module.MeshBasicMaterial({}));
    const second = new module.Mesh(new module.BufferGeometry(),
      new module.MeshBasicMaterial({}));

    scene.add(first);
    scene.add(second);
    assert.deepEqual(scene.children, [first, second], `${label} add() appends`);
    scene.remove(first);
    assert.deepEqual(scene.children, [second], `${label} remove() drops one object`);
  }
});

test('OrbitControls carries the methods initScene drives it through', () => {
  for (const method of ['listenToKeyEvents', 'update', 'dispose']) {
    assert.equal(typeof OrbitControls.prototype[method], 'function', `three ${method}`);
    assert.equal(typeof fake.OrbitControls.prototype[method], 'function', `fake_three ${method}`);
  }
});

// initScene writes these by plain assignment, so a rename leaves the write
// landing on a field nothing reads rather than throwing.
test('OrbitControls carries the tuning fields initScene assigns', () => {
  const controls = realControls();

  for (const field of ['minDistance', 'maxDistance', 'enableDamping', 'dampingFactor',
                       'autoRotate', 'autoRotateSpeed']) {
    assert.equal(Object.hasOwn(controls, field), true, `controls.${field}`);
  }
  assert.equal(controls.object instanceof THREE.PerspectiveCamera, true,
    'the camera is held as `object`');
});

test('listenToKeyEvents records the target under the same name on both', () => {
  const real = realControls();
  const double = new fake.OrbitControls(new THREE.PerspectiveCamera(45, 1, 0.1, 1000),
    controlsCanvas());
  const target = fakeElement('canvas', { allowRedundantRemoval: true });

  real.listenToKeyEvents(target);
  double.listenToKeyEvents(target);
  assert.equal(real._domElementKeyEvents, target);
  assert.equal(double._domElementKeyEvents, target, 'the double records it elsewhere');
  assert.deepEqual(target.listeners.map((l) => l.type), ['keydown'],
    'the real controls take the keyboard route the canvas focuses into');

  real.dispose();
  double.dispose();
  assert.equal(real._domElementKeyEvents, null);
  assert.equal(double._domElementKeyEvents, null, 'the double kept the key-events target');
  assert.deepEqual(target.listeners, [], 'dispose() gives the keyboard route back');
});
