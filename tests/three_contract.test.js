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
  'SpotLight',
];

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
  geometry.dispose();
  material.dispose();

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  camera.aspect = 2;
  camera.updateProjectionMatrix();
});

// WebGLRenderer assigns its methods in the constructor and needs a live WebGL
// context to construct, so its source is the only headless view of the surface.
test('WebGLRenderer still assigns the methods initScene calls', () => {
  const source = THREE.WebGLRenderer.toString();
  for (const method of ['setSize', 'setPixelRatio', 'render', 'dispose', 'forceContextLoss']) {
    assert.match(source, new RegExp(`this\\.${method}\\s*=\\s*function`), `renderer.${method}`);
  }
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
