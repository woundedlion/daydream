/* TODO
- Lissajous interference
- wiggly color separation
- wiggly dots
- Accordion rings
*/

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { gui } from "gui"
import { MaxEquation } from "three";

class Dot {
  constructor(sphericalCoords, color) {
    this.position = sphericalCoords;
    this.color = color;
  }
}

const wrap = (x, m) => {
  return x >= 0 ? x % m : ((x % m) + m) % m;
}

class Daydream {
  static SCENE_ANTIALIAS = true;
  static SCENE_ALPHA = true;
  static SCENE_BACKGROUND_COLOR = 0x000000;

  static CAMERA_FOV = 20;
  static CAMERA_NEAR = 100;
  static CAMERA_FAR = 500;
  static CAMERA_X = 0;
  static CAMERA_Y = 0;
  static CAMERA_Z = 220;

  static SPHERE_RADIUS = 30;
  static H = 20;
  static W = 96;
  static FPS = 16;

  static DOT_SIZE = 2;
  static DOT_COLOR = 0x0000ff;

  static X_AXIS = new THREE.Vector3(1, 0, 0);
  static Y_AXIS = new THREE.Vector3(0, 1, 0);
  static Z_AXIS = new THREE.Vector3(0, 0, 1);

  constructor() {
    console.log("INIT");
    THREE.ColorManagement.enabled = true;
    this.canvas = document.querySelector("#canvas");

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: Daydream.SCENE_ANTIALIAS,
      alpha: Daydream.SCENE_ALPHA,
    });

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.className = "labelLayer";
    this.canvas.parentElement.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(
      Daydream.CAMERA_FOV,
      canvas.width / canvas.height,
      Daydream.CAMERA_NEAR,
      Daydream.CAMERA_FAR
    );
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.camera.position.set(
      Daydream.CAMERA_X,
      Daydream.CAMERA_Y,
      Daydream.CAMERA_Z
    );
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(Daydream.SCENE_BACKGROUND_COLOR);
    this.paused = false;
    this.stepFrames = 0;
    this.clock = new THREE.Clock(true);
    this.resources = [];

    this.dotGeometry = new THREE.SphereGeometry(
        Daydream.DOT_SIZE,
        32,
        16,
        0,
        Math.PI
    );

    this.dotMaterial = new THREE.MeshBasicMaterial({
      side: THREE.FrontSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      depthWrite: false
    });

    this.setCanvasSize();
  }

  keydown(e) {
    if (e.key == ' ') {
      this.paused = !this.paused;
    } else if (this.paused && e.key == "ArrowRight") {
      this.stepFrames++;
    }
  }

  makeLabel(position, content) {
    const div = document.createElement("div");
    div.className = "label";
    div.innerHTML = content;
    const label = new CSS2DObject(div);
    label.position.copy(position);
    label.center.set(0, 1);
    this.scene.add(label)
  }

  setCanvasSize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
  }

  render(effect) {
    if (this.clock.getElapsedTime() * 1000 > 62.5) {
      this.clock.start();
      if (!this.paused || this.stepFrames != 0) {
        if (this.stepFrames != 0) {
          this.stepFrames--;
        }

        for (const res of this.resources) {
          res.dispose();
        }
        this.resources = [];
        const labels = document.querySelectorAll(".label");
        for (const label of labels) {
          label.remove();
        }
        this.scene.clear();

        let out = effect.drawFrame();
        const dotMesh = new THREE.InstancedMesh(
          this.dotGeometry,
          this.dotMaterial,
          out.pixels.size
        );
        dotMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(dotMesh);

        const vector = new THREE.Vector3();
        const dummy = new THREE.Object3D();

        let i = 0;
        for (const [key, pixel] of out.pixels) {
          let p = keyPixel(key);
          vector.setFromSpherical(pixelToSpherical(p[0], p[1]));
          vector.multiplyScalar(Daydream.SPHERE_RADIUS);
          const dummy = new THREE.Object3D();
          dummy.lookAt(vector);
          dummy.position.copy(vector);
          dummy.updateMatrix();
          dotMesh.setMatrixAt(i, dummy.matrix);
          dotMesh.instanceMatrix.needsUpdate = true;
          dotMesh.setColorAt(i, pixel);
          dotMesh.instanceColor.needsUpdate = true;
          ++i;
        }

        for (const label of out.labels) {
          this.makeLabel(label.position, label.content);
        }
      }
    } 

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }
}

const prettify = (r) => {
  let precision = 3;

  if (Math.abs(r) <= 0.00001) {
    return "0";
  }

  if (Math.abs(r - 1) <= 0.00001) {
    return "1";
  }

  if (Math.abs(r + 1) <= 0.00001) {
    return "-1";
  }

  if (Math.abs(r - Math.PI) <= 0.00001) {
    return "&pi;";
  }
  if (Math.abs(r + Math.PI) <= 0.00001) {
    return "-&pi;";
  }

  if (Math.abs(r - Math.PI / 2) <= 0.00001) {
    return "&pi;/2";
  }
  if (Math.abs(r + Math.PI / 2) <= 0.00001) {
    return "-&pi;/2";
  }

  if (Math.abs(r - Math.PI / 4) <= 0.00001) {
    return "&pi;/4";
  }
  if (Math.abs(r + Math.PI / 4) <= 0.00001) {
    return "-&pi;/4";
  }

  if (Math.abs(r - 3 * Math.PI / 2) <= 0.00001) {
    return "3&pi;/2";
  }
  if (Math.abs(r + 3 * Math.PI / 2) <= 0.00001) {
    return "-3&pi;/2";
  }

  if (Math.abs(r - g) <= 0.00001) {
    return "&phi;";
  }
  if (Math.abs(r - 1 / g) <= 0.00001) {
    return "&phi;\u207b\u00b9";
  }
  if (Math.abs(r + g) <= 0.00001) {
    return "-&phi;";
  }
  if (Math.abs(r + 1 / g) <= 0.00001) {
    return "-&phi;\u207b\u00b9";
  }

  if (Math.abs(r - 1 / Math.sqrt(3)) <= 0.00001) {
    return "\u221a3\u207b\u00b9";
  }
  if (Math.abs(r + 1 / Math.sqrt(3)) <= 0.00001) {
    return "-\u221a3\u207b\u00b9";
  }

  return r.toFixed(precision);
}

const coordsLabel = (c) => {
  const p = 3;
  let s = new THREE.Spherical().setFromCartesianCoords(c[0], c[1], c[2]);
  let n = new THREE.Vector3(c[0], c[1], c[2]).normalize();
  return {
    position: new THREE.Vector3()
      .setFromSphericalCoords(Daydream.SPHERE_RADIUS, s.phi, s.theta),
    content:
      `\u03B8, \u03A6 :
        ${prettify(s.theta)},
        ${prettify(s.phi)}
       <br>

       x, y, z :
        ${prettify(c[0])},
        ${prettify(c[1])}, 
        ${prettify(c[2])}
       <br>

       x\u0302, y\u0302, z\u0302 :
        ${prettify(n.x)},
        ${prettify(n.y)},
        ${prettify(n.z)}
       `
  };
}

///////////////////////////////////////////////////////////////////////////////

const g = (1 + Math.sqrt(5)) / 2;

const sphericalToPixel = (s) => {
  return {
    x: wrap((s.theta * Daydream.W) / (2 * Math.PI), Daydream.W),
    y: (s.phi * Daydream.H) / Math.PI,
  };
};

const pixelToSpherical = (x, y) => {
  return new THREE.Spherical(
    1,
    (y * Math.PI) / Daydream.H,
    (x * 2 * Math.PI) / Daydream.W
  );
};

const blendMax = (c1, c2) => {
  return new THREE.Color(
    Math.max(c1.r, c2.r),
    Math.max(c1.g, c2.g),
    Math.max(c1.b, c2.b)
  );
}

const blendOver = (c1, c2) => {
  return c2;
}

const blendUnder = (c1, c2) => {
  return c1;
}

const blendOverMax = (c1, c2) => {
  const m1 =
    Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 =
    Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
  let s = 0;
  if (m2 > 0) {
    s = Math.max(m1, m2) / m2;
  } 
  return new THREE.Color(
    c2.r * s,
    c2.g * s,
    c2.b * s
  );
}

const blendOverMin = (c1, c2) => {
  const m1 =
    Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 =
    Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
  let s = 0;
  if (m2 > 0) {
    s = Math.min(m1, m2) / m2;
  }
  return new THREE.Color(
    c2.r * s,
    c2.g * s,
    c2.b * s
  );
}

const blendMean = (c1, c2) => {
  return new THREE.Color(
    (c1.r + c2.r) / 2,
    (c1.g + c2.g) / 2,
    (c1.b + c2.b) / 2
  );
}

const pixelKey = (x, y) => `${x},${y}`;
const keyPixel = (k) => k.split(',');

///////////////////////////////////////////////////////////////////////////////

class TestPoly {
  vertices = [
    [1, 1, 1], // 0
    [1, -1, 1]  // 1
  ];
  eulerPath = [
    [1],
    []
  ]
}

class Cube {
  vertices = [
    [1, 1, 1],       // 0
    [1, 1, -1],      // 1
    [1, -1, 1],      // 2
    [1, -1, -1],     // 3
    [-1, 1, 1],      // 4
    [-1, 1, -1],     // 5
    [-1, -1, 1],     // 6
    [-1, -1, -1],    // 7
  ];

  eulerPath = [
    [1, 2, 4],  // 0
    [3, 5],  // 1
    [3, 6], // 2
    [7], // 3
    [5, 6],  // 4
    [7],  // 5
    [7], // 6
    [], // 7
  ];
}

class Dodecahedron {
  vertices = [
    [1, 1, 1],       // 0
    [1, 1, -1],      // 1
    [1, -1, 1],      // 2
    [1, -1, -1],     // 3
    [-1, 1, 1],      // 4
    [-1, 1, -1],     // 5
    [-1, -1, 1],     // 6
    [-1, -1, -1],    // 7

    [0, 1 / g, g],   //8
    [0, 1 / g, -g],  // 9
    [0, -1 / g, g],  // 10
    [0, -1 / g, -g], // 11

    [1 / g, g, 0],   // 12
    [1 / g, -g, 0],  // 13
    [-1 / g, g, 0],  // 14
    [-1 / g, -g, 0], // 15

    [g, 0, 1 / g],   // 16
    [g, 0, -1 / g],  // 17
    [-g, 0, 1 / g],  // 18
    [-g, 0, -1 / g], // 19
  ];

  edges = [
    [8, 12, 16],  // 0
    [9, 12, 17],  // 1
    [10, 13, 16], // 2
    [11, 13, 17], // 3
    [8, 14, 18],  // 4
    [9, 14, 19],  // 5
    [10, 15, 18], // 6
    [11, 15, 19], // 7
    [0, 4, 10],   // 8
    [1, 5, 11],   // 9
    [2, 6, 8],    // 10
    [3, 7, 9],    // 11
    [0, 1, 14],   // 12
    [2, 3, 15],   // 13
    [4, 5, 12],   // 14
    [6, 7, 13],   // 15
    [0, 2, 17],   // 16
    [1, 3, 16],   // 17
    [4, 6, 19],   // 18
    [5, 7, 18],   // 19
  ];

  eulerPath = [
    [8, 12, 16],  // 0
    [9, 12, 17],  // 1
    [10, 13, 16], // 2
    [11, 13, 17], // 3
    [8, 14, 18],  // 4
    [9, 14, 19],  // 5
    [10, 15, 18], // 6
    [11, 15, 19], // 7
    [10],   // 8
    [11],   // 9
    [8],    // 10
    [9],    // 11
    [14],   // 12
    [15],   // 13
    [12],   // 14
    [13],   // 15
    [17],   // 16
    [16],   // 17
    [19],   // 18
    [18],   // 19
  ];
}

///////////////////////////////////////////////////////////////////////////////

const drawVector = (v, colorFn) => {
  return [new Dot(new THREE.Vector3(...v.toArray()).normalize(), colorFn(v))];
}

const drawPath = (path, colorFn) => {
  let r = [];
  for (let t = 0; t < path.length(); t++) {
    r.push(new Dot(path.getPoint(t / path.length()), colorFn(t)));
  }
  return r;
}

const drawLine = (v1, v2, colorFn, start = 0, end = 1, longWay = false) => {
  let dots = []
  let u = v1.clone();
  let v = v2.clone();
  let a = angleBetween(u, v);
  let w = new THREE.Vector3().crossVectors(v, u);
  if (longWay) {
    a = 2 * Math.PI - a;
    w.negate();
  }
  a *= (end - start);
  w.normalize();
  v.crossVectors(u, w);
  v.normalize();

  const step = Daydream.DOT_SIZE / Daydream.SPHERE_RADIUS;
  for (let t = start; t < a; t += step) {
    let vi = new THREE.Vector3(
      u.x * Math.cos(t) + v.x * Math.sin(t),
      u.y * Math.cos(t) + v.y * Math.sin(t),
      u.z * Math.cos(t) + v.z * Math.sin(t)
    );
    dots.push(new Dot(vi, colorFn(vi)));
  }
  return dots;
}

const drawVertices = (vertices, colorFn) => {
  let dots = [];
  let v = new THREE.Vector3();
  for (const vertex of vertices) {
    v.set(vertex[0], vertex[1], vertex[2]);
    dots.push(new Dot(v.normalize(), colorFn(v)));
  }
  return dots;
}

const drawPolyhedron = (vertices, edges, colorFn) => {
  let dots = [];
  edges.map((adj, i) => {
    adj.map((j) => {
      dots = dots.concat(
        drawLine(
          new THREE.Vector3(...vertices[i]).normalize(),
          new THREE.Vector3(...vertices[j]).normalize(),
          colorFn)
      );
    })
  });
  return dots;
}

const drawFn = (normal, orientation, radius, shiftFn, colorFn) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
    radius = 2 - radius;
  }
  if (v.x == 0 && v.y == 0) {
    u.crossVectors(v, orientation.orient(Daydream.X_AXIS)).normalize();
  } else {
    u.crossVectors(v, orientation.orient(Daydream.Z_AXIS)).normalize();
  }
  w.crossVectors(v, u);
  let d = Math.sqrt(Math.pow(1 - radius, 2));

  let start = undefined;
  let from = undefined;
  let step = 1 / Daydream.W;
  for (let t = 0; t < 1; t += step) {
    let vi = calcRingPoint(t * 2 * Math.PI, d, radius, u, v, w);
    let axis = new THREE.Vector3().crossVectors(normal, vi).normalize();
    let shift = new THREE.Quaternion().setFromAxisAngle(axis, shiftFn(t));
    let to = vi.clone().applyQuaternion(shift);
    if (start === undefined) {
      dots.push(new Dot(to, colorFn(vi)));
      start = to;
    } else {
      dots.push(...drawLine(from, to, colorFn));
    }
    from = to;
  }
  dots.push(...drawLine(from, start, colorFn));

  return dots;
};

const calcRingPoint = (a, d, radius, u, v, w) => {
  return new THREE.Vector3(
    d * v.x + radius * u.x * Math.cos(a) + radius * w.x * Math.sin(a),
    d * v.y + radius * u.y * Math.cos(a) + radius * w.y * Math.sin(a),
    d * v.z + radius * u.z * Math.cos(a) + radius * w.z * Math.sin(a)
  );
}

const drawRing = (normal, radius, colorFn) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
    radius = 2 - radius;
  }
  if (v.x == 0 && v.y == 0) {
    u.crossVectors(v, Daydream.X_AXIS).normalize();
  } else {
    u.crossVectors(v, Daydream.Z_AXIS).normalize();
  }
  w.crossVectors(v, u);
  let d = Math.sqrt(Math.pow(1 - radius, 2));

  let step = 2 * Math.PI / Daydream.W;
  for (let t = 0; t < 2 * Math.PI; t += step) {
    let vi = calcRingPoint(t, d, radius, u, v, w);
    dots.push(new Dot(vi, colorFn(vi, t)));
  }

  return dots;
};

const ringPoint = (normal, radius, angle) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
    radius = 2 - radius;
  }
  if (v.x == 0 && v.y == 0) {
    u.crossVectors(v, Daydream.X_AXIS).normalize();
  } else {
    u.crossVectors(v, Daydream.Z_AXIS).normalize();
  }
  w.crossVectors(v, u);
  let d = Math.sqrt(Math.pow(1 - radius, 2));
  return calcRingPoint(angle, d, radius, u, v, w);
};

const drawFibSpiral = (n, eps, colorFn) => {
  let dots = [];
  for (let i = 0; i < n; ++i) {
    let s = new THREE.Spherical(
      Daydream.SPHERE_RADIUS,
      Math.acos(1 - (2 * (i + eps)) / n),
      (2 * Math.PI * i * g) % (2 * Math.PI)
    );
    let vi = new THREE.Vector3().setFromSpherical(s);
    dots.push(
      new Dot(vi, colorFn(vi))
    );
  }
  return dots;
};

///////////////////////////////////////////////////////////////////////////////

class Orientation {
  constructor() {
    this.orientations = [new THREE.Quaternion(0, 0, 0, 1)];
  }

  length() {
    return this.orientations.length;
  }

  orient(v, i = this.length() - 1) {
    return v.clone().normalize().applyQuaternion(this.orientations[i]);
  }

  unorient(v, i = this.length() - 1) {
    return v.clone().normalize().applyQuaternion(this.orientations[i].clone().invert());
  }

  orientPoly(vertices, i = this.length() - 1) {
    return vertices.map((c) => {
      return this.orient(new THREE.Vector3().fromArray(c)).toArray();
    });
  }

  clear() {
    this.orientations = [];
  }

  get(i = this.length() - 1) {
    return this.orientations[i];
  }

  set(quaternion) {
    this.orientations = [quaternion];
  }

  push(quaternion) {
    this.orientations.push(quaternion);
  }

  collapse() {
    while (this.orientations.length > 1) { this.orientations.shift(); }
  }
}

class Path {
  constructor() {
    this.points = [];
  }

  length() {
    return this.points.length;
  }

  appendLine(c1, c2, longWay = false, easingFn = (t) => t) {
    if (this.points.length > 0) {
      this.points.pop();
    }
    this.points = this.points.concat(
      drawLine(c1, c2, (v) => undefined, 0, 1, longWay)
        .map((d) => d.position));
    return this;
  }

  appendSegment(plotFn, domain, samples, easingFn = (t) => t) {
    if (this.points.length > 0) {
      this.points.pop();
    }
    for (let t = 0; t < samples; t++) {
      this.points.push(plotFn(easingFn(t / samples) * domain));
    }
    return this;
  }

  getPoint(t) {
    let i = Math.floor(t * (this.points.length));
    return this.points[i].clone();
  }
}

class ProceduralPath {
  constructor(pathFn) {
    this.f = pathFn;
  }

  getPoint(t) {
    return this.f(t);
  }
}

///////////////////////////////////////////////////////////////////////////////

class RandomTimer {
  constructor(t, min, max, f) {
    this.min = min;
    this.max = max;
    this.f = f;
    this.reset(t);
  }

  reset(t) {
    this.t = t + Math.round(Math.random() * (this.max - this.min) + this.min);
  }

  poll(t) {
    if (t >= this.t) {
      this.f();
      this.reset(t);
    }
  }
}

class PeriodicTimer {
  constructor(t, period, f) {
    this.period = period;
    this.f = f;
    this.reset(t);
  }

  reset(t) {
    this.t = t + this.period;
  }

  poll(t) {
    if (t >= this.t) {
      this.f();
      this.reset(t);
    }
  }
}

class Timeline {
  constructor() {
    this.t = 0;
    this.animations = [];
  }

  animate(animation, inSecs) {
    let start = this.t + (inSecs * Daydream.FPS);
    for (let i = 0; i < this.animations.length; ++i) {
      if (this.animations[i].start > start) {
        this.animations.splice(i, 0, { start: start, animation: animation });
        return this;
      }
    }
    this.animations.push({ start: start, animation: animation });
    return this;
  }

  step() {
    ++this.t;
    let i = this.animations.length;
    while (i--) {
      if (this.t > this.animations[i].start) {
        this.animations[i].animation.step();
        if (this.animations[i].animation.done()) {
          this.animations.splice(i, 1);
          continue;
        }
      }
    }
  }
}

class Animation {
  constructor(duration, repeat) {
    this.duration = duration;
    this.repeat = repeat;
    this.t = 0;
  }

  cancel() { this.t = this.duration; }
  done() { return this.t >= this.duration }

  step() {
    this.t++;
    if (this.done()) {
      if (this.repeat) {
        this.t = 0;
      }
    }
  }
}

class Motion extends Animation {
  static MAX_ANGLE = 2 * Math.PI / Daydream.W;

  constructor(orientation, path, duration, repeat = false) {
    super(duration, repeat);
    this.orientation = orientation;
    this.path = path;
    this.to = this.path.getPoint(0);
  }

  step() {
    super.step();
    if (this.done()) {
      return;
    }
    this.from = this.to;
    this.to = this.path.getPoint(this.t / this.duration);
    if (!this.from.equals(this.to)) {
      let axis = new THREE.Vector3().crossVectors(this.from, this.to).normalize();
      let angle = angleBetween(this.from, this.to);
      let origin = this.orientation.get();
      this.orientation.clear();
      for (let a = Motion.MAX_ANGLE; angle - a > 0.0001; a += Motion.MAX_ANGLE) {
        let r = new THREE.Quaternion().setFromAxisAngle(axis, a);
        this.orientation.push(origin.clone().premultiply(r));
      }
      let r = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      this.orientation.push(origin.clone().premultiply(r));
    }
  }
}

class MutableNumber {
  constructor(n) {
    this.n = n;
  }
  get() { return this.n; }
  set(n) { this.n = n; }
}

class FadeInOut extends Animation {
  constructor(fader, inDuration, onDuration, outDuration,
    easeIn = easeMid, easeOut = easeMid, repeat = false)
  {
    super(inDuration + onDuration + outDuration, repeat);
    this.fader = fader;
    this.inDuration = inDuration;
    this.onDuration = onDuration;
    this.outDuration = outDuration;
    this.easeOut = easeOut;
  }

  step() {
    super.step();
    if (this.t < this.inDuration) {
      var m = this.easeIn(this.t / this.inDuration);
    } else if (this.t < this.inDuration + this.onDuration) {
      var m = 1;
    } else if (!this.done()) {
      var m = 1 - this.easeOut((this.t - (this.inDuration + this.onDuration)) / this.outDuration);
    } else {
      var m = 0;
    }
    this.fader.set(m);
  }
}

class Transition extends Animation {
  constructor(mutable, to, duration, easingFn, repeat = false) {
    super(duration, repeat);
    this.mutable = mutable;
    this.to = to;
    this.duration = duration;
    this.easingFn = easingFn;
  }

  step() {
    if (this.t == 0) {
      this.from = this.mutable.get();
    }
    super.step();
    if (this.done()) {
      return;
    }
    let t = (this.t / this.duration);
    this.mutable.set(this.easingFn(t) * (this.to - this.from) + this.from);
  }
}

class Rotation extends Animation {
  static MAX_ANGLE = 2 * Math.PI / Daydream.W;

  constructor(orientation, axis, angle, duration, easingFn, repeat = false) {
    super(duration, repeat);
    this.orientation = orientation;
    this.axis = axis;
    this.totalAngle = angle;
    this.easingFn = easingFn;
    this.from = 0;
    this.to = 0;
  }

  step() {
    super.step();
    if (this.done()) {
      return;
    }
    this.from = this.to;
    this.to = this.easingFn((this.t) / this.duration) * this.totalAngle;
    if (Math.abs(this.to - this.from) > 0.0001) {
      let angle = Math.abs(this.to - this.from);
      let origin = this.orientation.get();
      for (let a = Rotation.MAX_ANGLE; angle - a > 0.0001; a += Rotation.MAX_ANGLE) {
        let r = new THREE.Quaternion().setFromAxisAngle(this.axis, a);
        this.orientation.push(origin.clone().premultiply(r));
      }
      let r = new THREE.Quaternion().setFromAxisAngle(this.axis,angle);
      this.orientation.push(origin.clone().premultiply(r));
    }
  }
}

///////////////////////////////////////////////////////////////////////////////

function sinWave(from, to, freq, phase) {
  return (t) => {
    let w = Math.sin(freq * t * 2 * Math.PI + phase);
    return (w + 1) * (to - from) / 2 + from;
  };
}

const distanceGradient = (v, normal) => {
  let d = v.dot(normal);
  if (d > 0) {
    return g1.get(d).clone();
  } else {
    return g2.get(-d).clone();
  }
}

const lissajous = (m1, m2, a, t) => {
  return new THREE.Vector3(
    Math.sin(m2 * t) * Math.cos(m1 * t - a * Math.PI),
    Math.cos(m2 * t),
    Math.sin(m2 * t) * Math.sin(m1 * t - a * Math.PI),
  );
}

const rotateBetween = (from, to) => {
  let diff = from.get().clone().conjugate().premultiply(to.get());
  let angle = 2 * Math.acos(diff.w);
  if (angle == 0) {
    return
  } else {
    var axis = new THREE.Vector3(diff.x, diff.y, diff.z).normalize();
  }
  new Rotation(from, axis, angle, 1, easeOutCirc).step();
}

const plotDots = (pixels, labels, filter, dots, age = 0, blendFn = blendOverMax) => {
  for (const dot of dots) {
    let p = sphericalToPixel(new THREE.Spherical().setFromVector3(dot.position));
    filter.plot(pixels, p.x, p.y, dot.color, age, blendFn);
  }
}

const isOver = (v, normal) => {
  return normal.dot(v) >= 0;
}

const intersectsPlane = (v1, v2, normal) => {
  return (isOver(v1, normal) && !isOver(v2, normal))
    || (!isOver(v1, normal) && isOver(v2, normal));
}

const angleBetween = (v1, v2) => {
  return Math.acos(Math.min(1, v1.dot(v2)));
}

const intersection = (u, v, normal) => {
  let w = new THREE.Vector3().crossVectors(v, u).normalize();
  let i1 = new THREE.Vector3().crossVectors(w, normal).normalize();
  let i2 = new THREE.Vector3().crossVectors(normal, w).normalize();

  let a1 = angleBetween(u, v);
  let a2 = angleBetween(i1, u);
  let a3 = angleBetween(i1, v);
  if (a2 + a3 - a1 < .0001) {
    return i1;
  }

  a1 = angleBetween(u, v);
  a2 = angleBetween(i2, u);
  a3 = angleBetween(i2, v);
  if (a2 + a3 - a1 <.0001) {
    return i2;
  }

  return NaN;
}

const splitPoint = (c, normal) => {
  const shift = Math.sin(Math.PI / Daydream.W);
  return [
    new THREE.Vector3().copy(c)
      .addScaledVector(normal, shift)
      .normalize(),
    new THREE.Vector3().copy(c)
      .addScaledVector(new THREE.Vector3().copy(normal).negate(), shift)
      .normalize()
      ,
  ];
}

const bisect = (poly, orientation, normal) => {
  let v = poly.vertices;
  let e = poly.eulerPath;
  e.map((neighbors, ai) => {
    e[ai] = neighbors.reduce((result, bi) => {
      let a = orientation.orient(new THREE.Vector3().fromArray(v[ai]));
      let b = orientation.orient(new THREE.Vector3().fromArray(v[bi]));
      if (intersectsPlane(a, b, normal)) {
        let points = splitPoint(intersection(a, b, normal), normal);
        v.push(orientation.unorient(points[0]).toArray());
        v.push(orientation.unorient(points[1]).toArray());
        if (isOver(a, normal)) {
          e.push([ai]);
          e.push([bi]);
        } else {
          e.push([bi]);
          e.push([ai]);
        }
      } else {
        result.push(bi);
      }
      return result;
    }, []);
  });
  return poly;
}

///////////////////////////////////////////////////////////////////////////////

const easeOutElastic = (x) => {
  const c4 = (2 * Math.PI) / 3;
  return x === 0 ?
    0 : x === 1 ?
      1 : Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1;
}

const easeInOutBicubic = (t) => {
  return t < 0.5 ? 4 * Math.pow(t, 3) : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const easeInOutSin = (t) => {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

const easeInSin = (t) => {
  return 1 - Math.cos((t * Math.PI) / 2);
}

const easeOutSin = (t) => {
  return Math.sin((t * Math.PI) / 2);
}

function easeOutExpo(t) {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}
function easeOutCirc(t) {
  return Math.sqrt(1 - Math.pow(t - 1, 2));
}

const easeInCubic = (t) => {
  return Math.pow(t, 3);
}

const easeInCirc = (t) => {
  return 1 - Math.sqrt(1 - Math.pow(t, 2));
}

const easeMid = (t) => {
  return t;
}

const easeOutCubic = (t) => {
  return 1 - Math.pow(1 - t, 3);
}


///////////////////////////////////////////////////////////////////////////////

class Filter {
  chain(nextFilter) {
    this.next = nextFilter;
    return nextFilter;
  }

  pass(pixels, x, y, color, age, blendFn) {
    if (this.next === undefined) {
      x = Math.round(x);
      y = Math.round(y);
      let key = pixelKey(x, y);
      if (pixels.has(key)) {
        let old = pixels.get(key);
        pixels.set(pixelKey(x, y), blendFn(old, color));
      } else {
        pixels.set(pixelKey(x, y), color);
      }
    } else {
      this.next.plot(pixels, x, y, color, age, blendFn);
    }
  }
}

class FilterRaw extends Filter {
  plot(pixels, x, y, color, age, blendFn) {
    this.pass(pixels, x, y, color, age, blendFn);
  }
}

class FilterReplicate extends Filter {
  constructor(count) {
    super();
    this.count = count;
  }

  plot(pixels, x, y, color, age, blendFn) {
    for (let i = 0; i < Daydream.W; i +=  Daydream.W / this.count) {
      this.pass(pixels, wrap(x + Math.floor(i), Daydream.W), y, color, age, blendFn);
    }
  }
}

class FilterMirror extends Filter {
  constructor() {
    super();
  }

  plot(pixels, x, y, color, age, blendFn) {
    this.pass(pixels, x, y, color, age, blendFn);
    this.pass(pixels, Daydream.W - x - 1, Daydream.H - y - 1, color, age, blendFn);
  }
}


const falloff = (c) => {
  return c;
}

class FilterAntiAlias extends Filter {
  plot(pixels, x, y, color, age, blendFn = blendOverMax) {
    let xi = Math.trunc(x);
    let xm = x - xi;
    let yi = Math.trunc(y);
    let ym = y - yi;

    let c = falloff((1 - xm) * (1 - ym));
    this.pass(pixels, xi, yi, color.clone().multiplyScalar(c), age, blendFn);

    c = falloff(xm * (1 - ym));
    this.pass(pixels, wrap((xi + 1), Daydream.W), yi, color.clone().multiplyScalar(c), age, blendFn);

    if (yi < Daydream.H - 1) {
      c = falloff((1 - xm) * ym);
      this.pass(pixels, xi, yi + 1,color.clone().multiplyScalar(c), age, blendFn);

      c = falloff(xm * ym);
      this.pass(pixels, wrap((xi + 1), Daydream.W), yi + 1, color.clone().multiplyScalar(c), age, blendFn);
    }
  }
}

class FilterSinDisplace extends Filter {
  constructor(phase, amplitudeFn, freqFn, phaseSpeedFn) {
    super();
    this.amplitudeFn = amplitudeFn;
    this.freqFn = freqFn;
    this.phaseSpeedFn = phaseSpeedFn;
    this.phase = phase;
    this.t = 0;
  }

  shift() {
   ++this.t;
    this.phase += this.phaseSpeedFn(this.t);
  }

  plot(pixels, x, y, color, age, blendFn) {
    let dx = wrap(
      x + this.amplitudeFn(this.t) * Math.sin(
        this.freqFn(this.t) * (((y / (Daydream.H - 1)) * 2 * Math.PI) + this.phase)
      ), Daydream.W);
    this.pass(pixels, dx, y, color, age, blendFn);
  }
}

class FilterChromaticShift extends Filter {
  constructor(magnitudeFn) {
    super();
    this.magnitudeFn = magnitudeFn;
    this.t = 0;
  }

  shift() {
    ++this.t;
  }

  plot(pixels, x, y, color, age, blendFn) {
    let r = new THREE.Color(color.r, 0, 0);
    let g = new THREE.Color(0, color.g, 0);
    let b = new THREE.Color(0, 0, color.b);
    this.pass(pixels, x, y, color, age, blendFn);
    this.pass(pixels, wrap(x + 1, Daydream.W), y, r, age, blendFn);
    this.pass(pixels, wrap(x + 2, Daydream.W), y, g, age, blendFn);
    this.pass(pixels, wrap(x + 3, Daydream.W), y, b, age, blendFn);

  }
}


class FilterTwinkle extends Filter {
  constructor(amplitude, freq) {
    super();
    this.amplitude = amplitude;
    this.freq = freq;
    this.t = 0;
  }

  twinkle() {
    ++this.t;
  }

  plot(pixels, x, y, color, age, blendFn) {
    let m = Math.sin(this.amplitude * Math.sin(this.freq * this.t));
    let c = color;
    c.multiplyScalar(m);
    this.pass(pixels, x, y, c, age, blendFn);
  }
}



class FilterDecayTrails extends Filter {
  constructor(lifespan) {
    super();
    this.lifespan = lifespan;
    this.trails = new Map();
  }

  plot(pixels, x, y, color, age, blendFn) {
    if (age >= 0) {
      let key = pixelKey(x, y);
      this.trails.set(key, Math.max(0, this.lifespan - age));
    }
    if (age <= 0) {
      this.pass(pixels, x, y, color, age, blendFn);
    } 
  }

  decay() {
    this.trails.forEach((ttl, key) => {
      ttl -= 1;
      if (ttl <= 0) {
        this.trails.delete(key);
      } else {
        this.trails.set(key, ttl);
      }
    });
  }

  trail(pixels, filters, trailFn, blendFn = blendUnder) {
    for (const [key, ttl] of this.trails) {
      if (ttl > 0) {
        let p = keyPixel(key);
        let color = trailFn(p[0], p[1], 1 - (ttl / this.lifespan));
        filters.plot(pixels, p[0], p[1], color, this.lifespan - ttl, blendFn);
      }
    }
  }
}

class FilterDecayMask extends Filter {
  constructor(lifespan) {
    super();
    this.lifespan = lifespan;
    this.trails = new Map();
  }

  plot(pixels, x, y, color, age, blendFn) {
    if (age >= 0) {
      let key = pixelKey(x, y);
      this.trails.set(key, Math.max(0, this.lifespan - age));
    }
    if (age <= 0) {
      this.pass(pixels, x, y, color, age, blendFn);
    }
  }

  decay() {
    this.trails.forEach((ttl, key) => {
      ttl -= 1;
      if (ttl <= 0) {
        this.trails.delete(key);
      } else {
        this.trails.set(key, ttl);
      }
    });
  }

  mask(key) {
    if (this.trails.has(key)) {
      return this.trails.get(key) / this.lifespan;
    }
    return 0;
  }
}

///////////////////////////////////////////////////////////////////////////////

class Gradient {
  constructor(size, points) {
    let lastPoint = [0, 0x000000];
    this.colors = points.reduce((r, nextPoint) => {
      let s = Math.floor(nextPoint[0] * size) - Math.floor(lastPoint[0] * size);
      for (let i = 0; i < s; i++) {
        r.push(new THREE.Color(lastPoint[1]).lerp(
          new THREE.Color(nextPoint[1]),
          i / s));
      }
      lastPoint = nextPoint;
      return r;
    }, []);
  }

  get(a) {
    return this.colors[Math.floor(a * this.colors.length)].clone();
  }
};

class ProceduralPalette {
  constructor(a, b, c, d) {
    this.a = a;
    this.b = b;
    this.c = c;
    this.d = d;
  }

  get(t) {
    return new THREE.Color(
      this.a[0] + this.b[0] * Math.cos(2 * Math.PI * (this.c[0] * t + this.d[0])),
      this.a[1] + this.b[1] * Math.cos(2 * Math.PI * (this.c[1] * t + this.d[1])),
      this.a[2] + this.b[2] * Math.cos(2 * Math.PI * (this.c[2] * t + this.d[2]))
    ).convertSRGBToLinear();
  }
};

class MutatingPalette {
  constructor(a1, b1, c1, d1, a2, b2, c2, d2) {
    this.a1 = new THREE.Vector3(a1[0], a1[1], a1[2]);
    this.b1 = new THREE.Vector3(b1[0], b1[1], b1[2]);
    this.c1 = new THREE.Vector3(c1[0], c1[1], c1[2]);
    this.d1 = new THREE.Vector3(d1[0], d1[1], d1[2]);
    this.a2 = new THREE.Vector3(a2[0], a2[1], a2[2]);
    this.b2 = new THREE.Vector3(b2[0], b2[1], b2[2]);
    this.c2 = new THREE.Vector3(c2[0], c2[1], c2[2]);
    this.d2 = new THREE.Vector3(d2[0], d2[1], d2[2]);
    this.mutate(0);
  }

  mutate(t) {
    this.a = new THREE.Vector3().lerpVectors(this.a1, this.a2, t);
    this.b = new THREE.Vector3().lerpVectors(this.b1, this.b2, t);
    this.c = new THREE.Vector3().lerpVectors(this.c1, this.c2, t);
    this.d = new THREE.Vector3().lerpVectors(this.d1, this.d2, t);
  }

  get(p) {
    // a + b * cos(2 * PI * (c * t + d));
    return new THREE.Color(
      this.a.x + this.b.x * Math.cos(2 * Math.PI * (this.c.x * p + this.d.x)),
      this.a.y + this.b.y * Math.cos(2 * Math.PI * (this.c.y * p + this.d.y)),
      this.a.z + this.b.z * Math.cos(2 * Math.PI * (this.c.z * p + this.d.z))
    ).convertSRGBToLinear();
  }
}

let rainbow = new Gradient(256, [
  [0, 0xFF0000],
  [1/16, 0xD52A00],
  [2/16, 0xAB5500],
  [3/16, 0xAB7F00],
  [4/16, 0xABAB00],
  [5/16, 0x56D500],
  [6/16, 0x00FF00],
  [7/16, 0x00D52A],
  [8/16, 0x00AB55],
  [9/16, 0x0056AA],
  [10/16, 0x0000FF],
  [11/16, 0x2A00D5],
  [12/16, 0x5500AB],
  [13/16, 0x7F0081],
  [14/16, 0xAB0055],
  [15/16, 0xD5002B],
  [16 / 16, 0xD5002B]
]);

let rainbowStripes = new Gradient(256, [
  [0, 0xFF0000],
  [1 / 16, 0x000000],
  [2 / 16, 0xAB5500],
  [3 / 16, 0x000000],
  [4 / 16, 0xABAB00],
  [5 / 16, 0x000000],
  [6 / 16, 0x00FF00],
  [7 / 16, 0x000000],
  [8 / 16, 0x00AB55],
  [9 / 16, 0x000000],
  [10 / 16, 0x0000FF],
  [11 / 16, 0x000000],
  [12 / 16, 0x5500AB],
  [13 / 16, 0x000000],
  [14 / 16, 0xAB0055],
  [15 / 16, 0x000000],
  [16 / 16, 0xFF0000]
]);

let rainbowThinStripes = new Gradient(256, [
  [0, 0xFF0000], //
  [1 / 32, 0x000000],
  [3 / 32, 0x000000],
  [4 / 32, 0xAB5500], //
  [5 / 32, 0x000000],
  [7 / 32, 0x000000],
  [8 / 32, 0xABAB00], //
  [9 / 32, 0x000000],
  [11 / 32, 0x000000],
  [12 / 32, 0x00FF00], //
  [13 / 32, 0x000000],
  [15 / 32, 0x000000],
  [16 / 32, 0x00AB55], //
  [17 / 32, 0x000000],
  [19 / 32, 0x000000],
  [20 / 32, 0x0000FF], //
  [21 / 32, 0x000000],
  [23 / 32, 0x000000],
  [24 / 32, 0x5500AB], //
  [25 / 32, 0x000000],
  [27 / 32, 0x000000],
  [28 / 32, 0xAB0055], //
  [29 / 32, 0x000000], 
  [32 / 32, 0x000000] //
]);

let grayToBlack = new Gradient(16384, [
  [0, 0x002200],
  [1, 0x000000]
]);

let blueToBlack = new Gradient(256, [
  [0, 0xee00ee],
  [1, 0x000000]
]);

let g1 = new Gradient(256, [
  [0, 0xffaa00],
  [1, 0xff0000],
]);

let g2 = new Gradient(256, [
  [0, 0x0000ff],
  [1, 0x660099],
]);

let g3 = new Gradient(256, [
//  [0, 0xaaaaaa],
  [0, 0xffff00],
  [0.3, 0xfc7200],
  [0.8, 0x06042f],
  [1, 0x000000]
]);

let g4 = new Gradient(256, [
  //  [0, 0xaaaaaa],
  [0, 0x0000ff],
  [1, 0x000000]
]);

///////////////////////////////////////////////////////////////////////////////

class PolyRot {
  constructor() {
    this.pixels = new Map();
    this.labels = [];

    this.ring = Daydream.Y_AXIS.clone();
    this.ringOrientation = new Orientation();

    this.spinAxis = new Daydream.Y_AXIS.clone();
    this.spinAxisOrientation = new Orientation();

    this.topOrientation = new Orientation();
    this.bottomOrientation = new Orientation;

    this.genPolyDuration = 160;
    this.splitPolyDuration = 96;
    this.spinRingDuration = 16;
    this.spinPolyDuration = 192;

    // Output Filters
    this.out = new FilterAntiAlias();
    this.polyMaskMask = new FilterDecayMask(4);
    (this.polyMask = new FilterAntiAlias())
      .chain(this.polyMaskMask);

    this.states = {
      "genPoly": {
        enter: this.enterGenPoly,
        draw: this.drawGenPoly,
        animate: this.animateGenPoly,
        exit: () => { },
      },
      "spinRing": {
        enter: this.enterSpinRing,
        draw: this.drawPolyRing,
        animate: this.animateSpinRing,
        exit: () => { },
      },
      "splitPoly": {
        enter: this.enterSplitPoly,
        draw: this.drawSplitPoly,
        animate: this.animateSplitPoly,
        exit: () => { },
      },
      "spinPoly": {
        enter: this.enterSpinPoly,
        draw: this.drawPolyRing,
        animate: this.animateSpinPoly,
        exit: () => { },
      },
    };

    this.stateIndex = -1;
    this.sequence = [
      "genPoly",
      "spinRing",
      "spinPoly",
      "spinRing",
      "splitPoly",
      "spinRing",
    ];

    this.transition();

    this.gui = new gui.GUI();
    this.gui.add(this, 'genPolyDuration').min(8).max(320).step(1);
    this.gui.add(this, 'splitPolyDuration').min(8).max(256).step(1);
    this.gui.add(this, 'spinRingDuration').min(8).max(32).step(1);
    this.gui.add(this, 'spinPolyDuration').min(8).max(256).step(1);
    this.gui.add(this.polyMaskMask, 'lifespan').min(1).max(20).step(1);
  }

  transition() {
    this.stateIndex = (this.stateIndex + 1) % this.sequence.length;
    this.transitionTo(this.sequence[this.stateIndex]);
  }

  transitionTo(state) {
    if (this.state != undefined) {
      this.states[this.state].exit.call(this);
    }
    this.t = 0;
    this.state = state;
    console.log(this.state);
    this.states[this.state].enter.call(this);
  }

  enterGenPoly() {
    this.poly = new Dodecahedron();
    this.genPolyPath = new Path().appendSegment(
      (t) => this.ringOrientation.orient(lissajous(10, 0.5, 0, t)),
      2 * Math.PI,
      this.genPolyDuration,
      easeInOutSin
    );
    this.genPolyMotion = new Motion(this.genPolyPath, this.genPolyDuration);
  }

  drawGenPoly() {
    this.labels = [];
    this.pixels.clear();
    this.polyMaskMask.decay();
    let vertices = this.topOrientation.orientPoly(this.poly.vertices);

    // Draw ring into polygon mask
    let n = this.ringOrientation.length();
    for (let i = 0; i < n; i++) {
      let normal = this.ringOrientation.orient(this.ring, i);
      let dots = drawRing(normal, 1, (v, t) => new THREE.Color(0x000000));
      plotDots(new Map(), this.labels, this.polyMask, dots,
        (n - 1 - i) / n, blendOverMax);
    }
    this.ringOrientation.collapse();

    // Draw polyhedron
    let dots = drawPolyhedron(
      vertices,
      this.poly.eulerPath,
      (v) => distanceGradient(v, this.ringOrientation.orient(this.ring)));
    plotDots(this.pixels, this.labels, this.out, dots, 0, blendOverMax);
    this.pixels.forEach((p, key) => {
      p.multiplyScalar(this.polyMaskMask.mask(key));
    });

    // Draw ring
    plotDots(this.pixels, this.labels, this.out,
      drawRing(this.ringOrientation.orient(this.ring), 1,
        (v, t) => new THREE.Color(0xaaaaaa)),
      0, blendOverMax);

    return { pixels: this.pixels, labels: this.labels };
  }

  animateGenPoly() {
    if (this.genPolyMotion.done()) {
      this.transition();
     } else {
      this.genPolyMotion.move(this.ringOrientation);
    }
  }

  enterSpinRing() {
    this.poly = new Dodecahedron();
    let from = this.ringOrientation.orient(this.ring).clone();
    let toNormal = new THREE.Vector3(...this.poly.vertices[3]).normalize();
    this.ringPath = new Path().appendLine(from, toNormal, true);
    this.ringMotion = new Motion(this.ringPath, this.spinRingDuration);
  }

  animateSpinRing() {
    if (this.ringMotion.done()) {
      this.transition();
    } else {
      this.ringMotion.move(this.ringOrientation);
    }
  }

  enterSplitPoly() {
    this.poly = new Dodecahedron();
    let normal = this.ringOrientation.orient(this.ring);
    bisect(this.poly, this.topOrientation, normal);
    this.bottomOrientation.set(this.topOrientation.get());
    this.polyRotationFwd = new Rotation(
     normal, 4 * Math.PI, this.splitPolyDuration);
    this.polyRotationRev = new Rotation(
      normal.clone().negate(), 4 * Math.PI, this.splitPolyDuration);
  }

  drawSplitPoly() {
    this.pixels.clear();
    this.labels = [];
    let normal = this.ringOrientation.orient(this.ring);
    let vertices = this.poly.vertices.map((c) => {
      let v = this.topOrientation.orient(new THREE.Vector3().fromArray(c));
      if (isOver(v, normal)) {
        return v.toArray();
      } else {
        return this.bottomOrientation.orient(new THREE.Vector3().fromArray(c)).toArray();
      }
    });

    plotDots(this.pixels, this.labels, this.out,
      drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => distanceGradient(v, normal)));
    plotDots(this.pixels, this.labels, this.out,
      drawRing(normal, 1, (v, t) => new THREE.Color(0xaaaaaa)));
    return { pixels: this.pixels, labels: this.labels };
  }

  animateSplitPoly() {
    if (this.polyRotationFwd.done()) {
      this.transition();
    } else {
      this.polyRotationFwd.rotate(this.topOrientation);
      this.polyRotationRev.rotate(this.bottomOrientation);
    }
  }

  enterSpinPoly() {
    this.poly = new Dodecahedron();
    let axis = this.spinAxisOrientation.orient(this.spinAxis);
    this.spinPolyRotation = new Rotation(axis, 4 * Math.PI,
      this.spinPolyDuration);
    this.spinAxisPath = new Path().appendSegment(
      (t) => lissajous(12.8, 2 * Math.PI, 0, t),
      1,
      this.spinPolyDuration
    );
    this.spinAxisMotion = new Motion(this.spinAxisPath, this.spinPolyDuration);
  }

  drawPolyRing() {
    this.pixels.clear();
    this.labels = [];
    let normal = this.ringOrientation.orient(this.ring);
    let vertices = this.topOrientation.orientPoly(this.poly.vertices);
    plotDots(this.pixels, this.labels, this.out,
      drawPolyhedron(vertices, this.poly.eulerPath,
        (v) => distanceGradient(v, normal)));
    plotDots(this.pixels, this.labels, this.out,
      drawRing(normal, 1, (v, t) => new THREE.Color(0xaaaaaa)));
    return { pixels: this.pixels, labels: this.labels };
  }

  animateSpinPoly() {
    if (this.spinPolyRotation.done()) {
      this.transition();
    } else {
      this.spinAxisMotion.move(this.spinAxisOrientation);
      this.spinPolyRotation.axis =
        this.spinAxisOrientation.orient(this.spinAxis);
      this.spinPolyRotation.rotate(this.topOrientation);
    }
  }

  drawFrame() {
    let out = this.states[this.state].draw.call(this);
    this.states[this.state].animate.call(this);
    return out;
  }
}

///////////////////////////////////////////////////////////////////////////////


class Ring {
  constructor(y) {
    this.x = 0;
    this.y = y;
    this.v = 0;
  }
}
class RainbowWiggles {
  constructor() {
    Daydream.W = 95;
    this.pixels = new Map();
    this.labels = [];
    this.rings = [];
    for (let i = 0; i < Daydream.H; ++i) {
      this.rings.push(new Ring(i));
    }

    this.palette = new MutatingPalette(
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.65, 0.39, 0.91],
      [0.88, 1.21, 1.55],

      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [.4, .4, .4],
      [.5, .3, .2]
    );

    this.speed = 2;
    this.gap = 3;
    this.t = 0;
    this.filters = new FilterReplicate(4);
    this.trails = new FilterDecayTrails(10);
    this.filters.chain(this.trails);

    // Random interavals
    (function randomTimer(min, max) {
      setTimeout(
        () => {
          this.changeSpeed();
          this.reverse();
          randomTimer.bind(this)(min, max);
        },
        Math.round(Math.random() * (max - min) + min )
      );
    }.bind(this)(125, 16 * 125 ));
  }

  changeSpeed() {
    this.speed = this.dir(this.speed) * Math.round(Math.random() * 1 + 1);
  }

  reverse() {
    this.speed *= -1;
  }

  difference(a, b, dir) {
    if (dir < 0) {
      return -wrap(a - b, Daydream.W)
    }
    return wrap(b - a, Daydream.W);
  }

  distance(a, b) {
    return Math.abs(this.shortest_move(a, b));
  }

  shortest_move(a, b) {
    let fwd = this.difference(a, b, 1);
    let rev = this.difference(a, b, -1);
    if (Math.abs(rev) < Math.abs(fwd)) {
      return rev;
    }
    return fwd;
  }

  dir(v) { return v < 0 ? -1 : 1; }

  drawFrame() {
    this.pixels.clear();
    this.trails.decay();
    this.t++;
    this.palette.mutate(Math.sin(0.001 * this.t++));
    this.pull(0, this.speed);
    this.trails.trail(this.pixels, new FilterRaw(), (x, y, t) => this.palette.get(t));
    this.drawRings();
    return { pixels: this.pixels, labels: this.labels };
  }

  drawRings() {
    for (let ring of this.rings) {
      this.drawRing(ring, 0);
    }
  }

  drawRing(ring, age) {
    let p = wrap(ring.x, Daydream.W);
    let color = this.palette.get(0);
    this.filters.plot(this.pixels,
      wrap(ring.x, Daydream.W),
      ring.y,
      color,
      age,
      blendOver);
  }
  
  pull(y, speed) {
    this.rings[y].v = speed;
    this.move(this.rings[y]);
    for (let i = y - 1; i >= 0; --i) {
      this.drag(this.rings[i + 1], this.rings[i]);
    }
    for (let i = y + 1; i < Daydream.H; ++i) {
      this.drag(this.rings[i - 1], this.rings[i]);
    }
  }

  drag(leader, follower) {
    let dest = wrap(follower.x + follower.v, Daydream.W);
    if (this.distance(dest, leader.x) > this.gap) {
      // Move to gap's length from leader
      let shift = this.shortest_move(follower.x, leader.x);
      dest = wrap(follower.x + shift - this.dir(shift) * this.gap, Daydream.W);
      follower.v = this.shortest_move(follower.x, dest);
      this.move(follower);
      follower.v = leader.v;
    } else {
      this.move(follower);
    }
  }

  move(ring) {
    let dest = wrap(ring.x + ring.v, Daydream.W);
    let i = ring.x;
    while (i != dest) {
      this.drawRing(ring, 0);
      i = wrap(i + this.dir(ring.v), Daydream.W);
      ring.x = i;
    }
    ring.x = dest;
  }
}

///////////////////////////////////////////////////////////////////////////////

class Thruster {
  constructor(orientation, thrustPoint, thrustVector, thrustAxis) {
    this.orientation = orientation;
    this.thrustPoint = thrustPoint;
    this.exhaustVector = thrustVector.clone().negate();
    this.thrustRotation = new Rotation(orientation, thrustAxis, Math.PI, 8 * 16, easeOutExpo);
    this.exhaustFader = new MutableNumber(1);
    this.exhaustFade = new FadeInOut(
      this.exhaustFader, 0, 4, 12, easeMid, easeOutCubic);
  }

  done() {
    return this.thrustRotation.done() && this.exhaustFade.done();
  }

  step() {
    this.thrustRotation.step();
    this.exhaustFade.step();
  }
}

class Thrusters {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.thrusterPalette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.45, 0.45, 0.45],
      [1.0, 0.9, 1.3]
    );
    /*
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.3, 0.3],
      [0.0, 0.2, 0.6]
    );
    */

    this.palette = new MutatingPalette(
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.3, 0.3],
      [0.0, 0.2, 0.6],

      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.45, 0.45, 0.45],
      [1.0, 0.9, 1.3]
    );

    // Output Filters
    this.trails = new FilterDecayTrails(5);
    this.wiggle = new FilterSinDisplace(
      0,
      (t) => 4,
      (t) => 2,
      (t) => 0.2
    );
    this.chromaShift = new FilterChromaticShift(1);
    (this.ringOutput = new FilterRaw())
      //    .chain(this.chromaShift)
      .chain(new FilterAntiAlias())
      //      .chain(this.wiggle)
    //        .chain(this.trails)
      .chain(new FilterReplicate(1))
//      .chain(new FilterMirror(1))
    ;

    // Animations
    this.timeline = new Timeline();

    // State
    this.t = 0;
    this.ring = new THREE.Vector3(0.5, 0.5, 0.5).normalize(); //Daydream.Y_AXIS.clone();
    this.orientation = new Orientation();
    this.to = new Orientation();
    this.thrusters = [];
    this.amplitude = new MutableNumber(0);

    // Timers
    this.thrustTimer = new RandomTimer(this.t, 16, 64,
      () => this.onThrustTimer(Math.random() * (Daydream.W - 1)));
    this.warpTimer = new PeriodicTimer(this.t, 48, () => this.onWarpTimer());
  }

  onWarpTimer() {
//    this.timeline.animate(new Transition(this.amplitude, Math.random() * 9, 16, easeInOutBicubic), 0);
  }

  onThrustTimer(x) {
    let thrustPoint = ringPoint(this.ring, 1, x / (Daydream.W - 1) * (2 * Math.PI));
    let dir = Math.random() < 0.5 ? -1 : -1;
    this.fireThruster(thrustPoint, dir)
    if (Math.random() < 1) {
      let xp = wrap(x + Daydream.W / 2, Daydream.W);
      let thrustPoint = ringPoint(this.ring, 1, xp / (Daydream.W - 1) * (2 * Math.PI));
      this.fireThruster(thrustPoint.clone(), -dir);
    }
  }

  fireThruster(thrustPoint, thrustDir) {
    let thrustVector = this.ring.clone().multiplyScalar(thrustDir);
    let thrustAxis = new THREE.Vector3().crossVectors(
      this.orientation.orient(thrustPoint),
      this.orientation.orient(thrustVector))
      .normalize();
    this.amplitude.set(0.5);
    this.timeline
      .animate(new Thruster(this.orientation, thrustPoint, thrustVector, thrustAxis), 0);
    if (!(this.warpOut === undefined || this.warpOut.done())) {
      this.warpIn.cancel();
      this.warpOut.cancel();
    }
    this.warpIn = new Transition(this.amplitude, 0.5, 8, easeInSin);
    this.warpOut = new Transition(this.amplitude, 0, 32, easeOutSin);
    this.timeline
      .animate(this.warpIn, 0)
      .animate(this.warpOut, 1);
  }

  drawThruster(thruster) {
    let lines = [
      thruster.thrustPoint.clone().applyQuaternion(
        new THREE.Quaternion().setFromAxisAngle(this.ring, Math.PI / Daydream.H / 2.2)),
      thruster.thrustPoint.clone().applyQuaternion(
        new THREE.Quaternion().setFromAxisAngle(this.ring, -Math.PI / Daydream.H / 2.2))
    ];
    
    let dots = [];
    lines.forEach((line) => {
      let emitter = this.orientation.orient(line);
      dots.push(...drawLine(
        emitter,
        this.orientation.orient(thruster.exhaustVector),
        (v, t) => {
          let z = this.orientation.orient(Daydream.X_AXIS);
          return this.palette.get(angleBetween(z, emitter) / Math.PI);
        },
        Daydream.DOT_SIZE * 3 / Daydream.SPHERE_RADIUS,
        1
      ));
    });
    plotDots(this.pixels, this.labels, this.ringOutput, dots, -1);
  }

  drawFrame() {
    this.pixels.clear();
    this.labels = [];
    this.thrustTimer.poll(this.t);
    this.warpTimer.poll(this.t);
    this.timeline.step();

    this.trails.decay();
    this.trails.trail(this.pixels, new FilterRaw(),
      (x, y, t) => {
        let v = new THREE.Vector3().setFromSpherical(pixelToSpherical(x, y));
        let z = this.orientation.orient(Daydream.X_AXIS);
        let s = angleBetween(z, v) / Math.PI;
        return this.palette.get((s + t) % 1);
      });
    this.wiggle.shift();

    // Draw ring
    rotateBetween(this.orientation, this.to);
    this.orientation.collapse();
    this.to.collapse();
    let dots = drawFn(this.orientation.orient(this.ring), this.orientation, 1,
      (t) => {
        return sinWave(-1, 1, 2, 0)(t)
        * sinWave(-1, 1, 1, 0)((this.t % 16) / 16)
        * this.amplitude.get()
      },
      (v) => {
        let z = this.orientation.orient(Daydream.X_AXIS);
        return this.palette.get(angleBetween(z, v) / Math.PI);
      }
    );
    plotDots(this.pixels, this.labels, this.ringOutput, dots, 0, blendOverMax);
        
    // Draw thrusters
    //this.thrusters.forEach((t) => this.drawThruster(t));

    this.t++;
//    this.palette.mutate(Math.sin(0.001 * this.t));
     return { pixels: this.pixels, labels: this.labels };
  }
}

///////////////////////////////////////////////////////////////////////////////

const daydream = new Daydream();
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));
// var effect = new PolyRot();
// var effect = new RainbowWiggles();
var effect = new Thrusters();
daydream.renderer.setAnimationLoop(() => daydream.render(effect));
