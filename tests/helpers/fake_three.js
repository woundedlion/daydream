// Stand-in for three + three/addons/controls/OrbitControls.js, plus the
// buffer-attribute doubles. three_loader_hooks.js redirects both specifiers here.

// Ordered teardown sink: Scene.clear(), forceContextLoss() and every dispose()
// except BufferGeometry's, which counts disposals instead, append to it.
export const log = [];

export class Vector3 {
  /** @param {number} [x] @param {number} [y] @param {number} [z] */
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  /** @param {number} x @param {number} y @param {number} z @returns {Vector3} */
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  /** @param {Vector3} v @returns {Vector3} */
  copy(v) { return this.set(v.x, v.y, v.z); }
  /** @returns {Vector3} */
  clone() { return new Vector3(this.x, this.y, this.z); }
  /** @param {Vector3} v @returns {Vector3} */
  add(v) { return this.set(this.x + v.x, this.y + v.y, this.z + v.z); }
  /** @param {number} s @returns {Vector3} */
  multiplyScalar(s) { return this.set(this.x * s, this.y * s, this.z * s); }
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
    return this.set(this.x + (v.x - this.x) * t, this.y + (v.y - this.y) * t,
      this.z + (v.z - this.z) * t);
  }
  /** @param {Vector3} v @returns {number} */
  angleTo(v) {
    const denominator = this.length() * v.length();
    if (denominator === 0) return Math.PI / 2;
    return Math.acos(Math.min(1, Math.max(-1, this.dot(v) / denominator)));
  }
}

export class Object3D {
  constructor() { this.position = new Vector3(); }
}

export class Scene {
  constructor() { this.children = []; }
  /** @param {Object} obj */
  add(obj) { this.children.push(obj); }
  /** @param {Object} obj */
  remove(obj) {
    const at = this.children.indexOf(obj);
    if (at >= 0) this.children.splice(at, 1);
  }
  clear() { this.children.length = 0; log.push('scene.clear'); }
}

export class Color {
  /** @param {number} [hex] */
  constructor(hex) {
    this.hex = hex;
    this.r = 1;
    this.g = 1;
    this.b = 1;
    /** @type {Array<Array<number>>} */
    this.hsl = [];
  }

  /**
   * Records the request and keeps the three arguments distinguishable as r/g/b
   * instead of converting, so an emitted vertex color traces back to the face
   * that set it.
   * @param {number} h @param {number} s @param {number} l @returns {Color}
   */
  setHSL(h, s, l) {
    this.hsl.push([h, s, l]);
    this.r = h;
    this.g = s;
    this.b = l;
    return this;
  }
}

export class SphereGeometry {
  dispose() { log.push('geometry.dispose'); }
}

export class BufferGeometry {
  constructor() {
    /** @type {Object<string, Object>} */
    this.attributes = {};
    /** @type {?Array<Vector3>} */
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

export class Float32BufferAttribute {
  /** @param {Array<number>} array @param {number} itemSize */
  constructor(array, itemSize) { this.array = new Float32Array(array); this.itemSize = itemSize; }
}

export class MeshBasicMaterial {
  /** @param {Object} opts */
  constructor(opts) { this.opts = opts; }
  dispose() { log.push('material.dispose'); }
}

class GeometryObject extends Object3D {
  /** @param {Object} geometry @param {Object} material */
  constructor(geometry, material) {
    super();
    this.geometry = geometry;
    this.material = material;
  }
}

export class Mesh extends GeometryObject {}
export class Points extends GeometryObject {}
export class LineSegments extends GeometryObject {}

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
  /** @param {Object} params - The {canvas, antialias, alpha} bag. */
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
  forceContextLoss() { log.push('renderer.forceContextLoss'); }
}

/**
 * Length an array binds the GPU buffer to, or null for one that binds nothing:
 * a null array, or a view whose ArrayBuffer heap growth detached (length 0).
 * @param {?Uint16Array} array - Candidate backing array.
 * @returns {?number} The bound length, or null.
 */
function uploadLengthOf(array) {
  if (array == null || array.buffer?.byteLength === 0) return null;
  return array.length;
}

/**
 * Stand-in for an InstancedBufferAttribute with three.js's real upload
 * semantics:
 *
 * - needsUpdate is write-only and only ever bumps version, so once an upload is
 *   flagged nothing can unflag it. `version` is what WebGLAttributes compares.
 * - the GPU buffer is sized from the array at first upload and every later
 *   upload is a bufferSubData into it, so the array length is fixed for the
 *   attribute's lifetime. Three throws during upload if byteLength changes;
 *   this fake reports the mismatch earlier, when the array is assigned.
 *
 * @param {?Uint16Array} array - Backing color array.
 * @returns {Object} Attribute stub exposing array/version/needsUpdate.
 */
export function fakeColorAttribute(array) {
  let backing = array;
  let uploadLength = uploadLengthOf(array);
  return {
    version: 0,
    get array() { return backing; },
    set array(value) {
      const length = uploadLengthOf(value);
      if (length !== null) {
        if (uploadLength === null) uploadLength = length;
        else if (length !== uploadLength) {
          throw new Error(
            `instanceColor.array re-pointed at length ${length}, `
            + `but the GPU buffer is sized ${uploadLength}`);
        }
      }
      backing = value;
    },
    set needsUpdate(value) { if (value === true) this.version++; },
  };
}

/** Matrix attribute with three.js's write-only needsUpdate/version contract. */
export function fakeMatrixAttribute(array) {
  let backing = array;
  return {
    version: 0,
    get array() { return backing; },
    set array(value) { backing = value; },
    set needsUpdate(value) { if (value === true) this.version++; },
  };
}

export class AmbientLight extends Object3D {}
export class DirectionalLight extends Object3D {}
export class SpotLight extends Object3D {}

// `object` is three's own state name, so a test reading it reads what a browser
// would. `updates` is this double's counter.
export class OrbitControls {
  #keyTarget = null;
  #onKeyDown = () => {};
  /** @param {PerspectiveCamera} camera @param {Object} domElement */
  constructor(camera, domElement) {
    this.object = camera;
    this.domElement = domElement;
    this.updates = 0;
  }
  /** @param {Object} domElement */
  listenToKeyEvents(domElement) {
    domElement.addEventListener('keydown', this.#onKeyDown);
    this.#keyTarget = domElement;
  }
  update() { this.updates += 1; }
  dispose() {
    this.#keyTarget?.removeEventListener('keydown', this.#onKeyDown);
    this.#keyTarget = null;
    log.push('controls.dispose');
  }
}
