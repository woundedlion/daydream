// @ts-nocheck
//
// shared.js's own export is initScene; showFatalError et al. are re-exports
// covered by their source modules' tests (banner.test.js, clipboard.test.js,
// cpp_format.test.js). three + three/addons are mocked, so initScene builds a
// whole scene here without a WebGL context and dispose() can be checked step by
// step. dispose() carries an ordering invariant: the frame loop and the resize
// listener must both be stopped before any GPU object is released, or a queued
// frame renders against disposed resources.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Ordered teardown sink. Only dispose() writes to it.
let log = [];

class FakeVector3 {
  /** @param {number} x @param {number} y @param {number} z @returns {FakeVector3} */
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}

class FakeObject3D {
  constructor() { this.position = new FakeVector3(); }
}

class FakeScene {
  constructor() { this.children = []; }
  /** @param {Object} obj */
  add(obj) { this.children.push(obj); }
  clear() { this.children.length = 0; log.push('scene.clear'); }
}

class FakeGeometry {
  dispose() { log.push('geometry.dispose'); }
}

class FakeMaterial {
  /** @param {Object} opts */
  constructor(opts) { this.opts = opts; }
  dispose() { log.push('material.dispose'); }
}

class FakeMesh extends FakeObject3D {
  /** @param {FakeGeometry} geometry @param {FakeMaterial} material */
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}

class FakeCamera extends FakeObject3D {
  /** @param {number} fov @param {number} aspect @param {number} near @param {number} far */
  constructor(fov, aspect, near, far) {
    super();
    Object.assign(this, { fov, aspect, near, far });
    this.projectionUpdates = 0;
  }
  updateProjectionMatrix() { this.projectionUpdates += 1; }
}

class FakeRenderer {
  /** @param {Object} params - The {canvas, antialias, alpha} bag initScene passes. */
  constructor(params) {
    this.params = params;
    this.domElement = params.canvas;
    this.size = null;
    this.pixelRatio = 0;
    this.renders = 0;
  }
  /** @param {number} w @param {number} h */
  setSize(w, h) { this.size = [w, h]; }
  /** @param {number} ratio */
  setPixelRatio(ratio) { this.pixelRatio = ratio; }
  render() { this.renders += 1; }
  dispose() { log.push('renderer.dispose'); }
}

class FakeControls {
  /** @param {FakeCamera} camera @param {Object} domElement */
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.updates = 0;
  }
  update() { this.updates += 1; }
  dispose() { log.push('controls.dispose'); }
}

mock.module('three', {
  namedExports: {
    Scene: FakeScene,
    Color: class { constructor(hex) { this.hex = hex; } },
    PerspectiveCamera: FakeCamera,
    WebGLRenderer: FakeRenderer,
    SphereGeometry: FakeGeometry,
    MeshBasicMaterial: FakeMaterial,
    Mesh: FakeMesh,
    AmbientLight: class extends FakeObject3D {},
    DirectionalLight: class extends FakeObject3D {},
    SpotLight: class extends FakeObject3D {},
  },
});
mock.module('three/addons/controls/OrbitControls.js', {
  namedExports: { OrbitControls: FakeControls },
});

const { capPixelRatio, initScene } = await import('../tools/shared.js');

const RAF_ID = 7;

const saved = {
  document: globalThis.document,
  window: globalThis.window,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
};
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
  log = [];
});

/** Stub document.getElementById against a fixed id->element map. */
function stubDocument(byId) {
  globalThis.document = { getElementById: (id) => byId[id] || null };
}

/**
 * Install the DOM and animation globals initScene needs, then build a scene.
 * requestAnimationFrame hands back a fixed id without ever running the callback,
 * so the loop advances exactly one frame.
 * @param {Object} [opts] - Options forwarded to initScene.
 * @returns {Object} initScene's handles plus the canvas, the listener record and
 *          the id passed to cancelAnimationFrame.
 */
function mountScene(opts = {}) {
  const canvas = {};
  const listeners = { added: [], removed: [] };
  const cancelled = [];
  stubDocument({ viewport: { clientWidth: 640, clientHeight: 480 }, gl: canvas });
  globalThis.window = {
    devicePixelRatio: 2,
    addEventListener(type, fn) { listeners.added.push([type, fn]); },
    removeEventListener(type, fn) {
      listeners.removed.push([type, fn]);
      log.push('removeEventListener');
    },
  };
  globalThis.requestAnimationFrame = () => RAF_ID;
  globalThis.cancelAnimationFrame = (id) => {
    cancelled.push(id);
    log.push('cancelAnimationFrame');
  };
  return { canvas, listeners, cancelled, ...initScene('viewport', 'gl', opts) };
}

test('capPixelRatio preserves low-density displays and caps high-density displays', () => {
  assert.equal(capPixelRatio(0.75), 0.75);
  assert.equal(capPixelRatio(1), 1);
  assert.equal(capPixelRatio(3), 1);
});

test('initScene throws when the container element is absent', () => {
  stubDocument({});
  assert.throws(() => initScene('viewport', 'gl'),
    /container element #viewport not found/);
});

test('initScene throws when the canvas element is absent', () => {
  stubDocument({ viewport: { clientWidth: 640, clientHeight: 480 } });
  assert.throws(() => initScene('viewport', 'gl'),
    /canvas element #gl not found/);
});

test('initScene returns the handles the tool pages destructure', () => {
  const s = mountScene();

  assert.ok(s.scene instanceof FakeScene);
  assert.ok(s.camera instanceof FakeCamera);
  assert.ok(s.renderer instanceof FakeRenderer);
  assert.ok(s.controls instanceof FakeControls);
  assert.ok(s.sphere instanceof FakeMesh);
  assert.deepEqual(s.lights, []);
  assert.equal(typeof s.resize, 'function');
  assert.equal(typeof s.dispose, 'function');

  assert.equal(s.renderer.domElement, s.canvas);
  assert.deepEqual(s.renderer.size, [640, 480]);
  assert.equal(s.renderer.pixelRatio, 1, 'the renderer must take the capped ratio');
  assert.equal(s.controls.camera, s.camera);
  assert.equal(s.controls.domElement, s.canvas);
  assert.deepEqual(s.scene.children, [s.sphere]);
  assert.equal(s.renderer.renders, 1, 'the loop must paint one frame on start');
  assert.deepEqual(s.listeners.added, [['resize', s.resize]]);
});

test('initScene returns the light rig it added when lights are requested', () => {
  const s = mountScene({ lights: true, showSphere: false });

  assert.equal(s.lights.length, 3);
  assert.deepEqual(s.scene.children, s.lights);
});

test('dispose stops the frame loop and the resize listener before releasing GPU objects', () => {
  const s = mountScene();
  s.dispose();

  assert.deepEqual(log, [
    'cancelAnimationFrame',
    'removeEventListener',
    'controls.dispose',
    'renderer.dispose',
    'geometry.dispose',
    'material.dispose',
    'scene.clear',
  ]);
  assert.deepEqual(s.cancelled, [RAF_ID], 'the pending frame handle must be cancelled');
  assert.deepEqual(s.listeners.removed, [['resize', s.resize]],
    'dispose must remove the listener initScene added');
  assert.deepEqual(s.scene.children, []);
});

test('dispose skips the sphere teardown when no reference sphere was built', () => {
  const s = mountScene({ showSphere: false });
  assert.equal(s.sphere, null);

  s.dispose();
  assert.deepEqual(log, [
    'cancelAnimationFrame',
    'removeEventListener',
    'controls.dispose',
    'renderer.dispose',
    'scene.clear',
  ]);
});
