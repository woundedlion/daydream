//
// Stand-in for three + three/addons/controls/OrbitControls.js, covering the
// surface tools/shared.js constructs plus the buffer-attribute double the
// suites that drive the dot mesh share. three_loader_hooks.js redirects both
// specifiers here, so shared.js gets these classes and the test importing this
// module shares their `log`.

// Ordered teardown sink. Only the dispose paths append to it.
export const log = [];

class Vector3 {
  /** @param {number} x @param {number} y @param {number} z @returns {Vector3} */
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}

export class Object3D {
  constructor() { this.position = new Vector3(); }
}

export class Scene {
  constructor() { this.children = []; }
  /** @param {Object} obj */
  add(obj) { this.children.push(obj); }
  clear() { this.children.length = 0; log.push('scene.clear'); }
}

export class Color {
  /** @param {number} hex */
  constructor(hex) { this.hex = hex; }
}

export class SphereGeometry {
  dispose() { log.push('geometry.dispose'); }
}

export class MeshBasicMaterial {
  /** @param {Object} opts */
  constructor(opts) { this.opts = opts; }
  dispose() { log.push('material.dispose'); }
}

export class Mesh extends Object3D {
  /** @param {SphereGeometry} geometry @param {MeshBasicMaterial} material */
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}

export class PerspectiveCamera extends Object3D {
  /** @param {number} fov @param {number} aspect @param {number} near @param {number} far */
  constructor(fov, aspect, near, far) {
    super();
    Object.assign(this, { fov, aspect, near, far });
    this.projectionUpdates = 0;
  }
  updateProjectionMatrix() { this.projectionUpdates += 1; }
}

export class WebGLRenderer {
  /** @param {Object} params - The {canvas, antialias, alpha} bag shared.js passes. */
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

/**
 * Stand-in for an InstancedBufferAttribute with three.js's real upload
 * semantics: needsUpdate is write-only and only ever bumps version, so once an
 * upload is flagged nothing can unflag it. `version` is what WebGLAttributes
 * compares, so tests assert on it rather than on a readable flag.
 * @param {?Uint16Array} array - Backing color array.
 * @returns {Object} Attribute stub exposing array/version/needsUpdate.
 */
export function fakeColorAttribute(array) {
  return {
    array,
    version: 0,
    set needsUpdate(value) { if (value === true) this.version++; },
  };
}

export class AmbientLight extends Object3D {}
export class DirectionalLight extends Object3D {}
export class SpotLight extends Object3D {}

export class OrbitControls {
  /** @param {PerspectiveCamera} camera @param {Object} domElement */
  constructor(camera, domElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.updates = 0;
  }
  update() { this.updates += 1; }
  dispose() { log.push('controls.dispose'); }
}
