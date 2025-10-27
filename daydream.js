/* TODO
- Lissajous interference
- wiggly color separation
- wiggly dots
- Accordion rings
*/

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { gui } from "gui";

import { BufferGeometry, MaxEquation } from "three";

class Dot {
  constructor(position, color) {
    this.position = position;
    this.color = color;
  }
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

    this.axisMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      linewidth: 5
    });

    let xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.X_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.X_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    this.xAxis = new THREE.Line(xAxisGeometry, this.axisMaterial);

    let yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.Y_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.Y_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    this.yAxis = new THREE.Line(yAxisGeometry, this.axisMaterial);

    let zAxisGeometry = new THREE.BufferGeometry().setFromPoints([
      Daydream.Z_AXIS.clone().negate().multiplyScalar(Daydream.SPHERE_RADIUS),
      Daydream.Z_AXIS.clone().multiplyScalar(Daydream.SPHERE_RADIUS)
    ]);
    this.zAxis = new THREE.Line(zAxisGeometry, this.axisMaterial);

    this.setCanvasSize();

    this.showAxes = false;
    this.gui = new gui.GUI();
    this.gui.add(this, 'showAxes');

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
    label.position.multiplyScalar(Daydream.SPHERE_RADIUS);
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

        const labels = document.querySelectorAll(".label");
        for (const label of labels) {
          label.remove();
        }
        this.scene.clear();

        // draw axes
        if (this.showAxes) {
          this.scene.add(this.xAxis);
          this.scene.add(this.yAxis);
          this.scene.add(this.zAxis);
        }
        // draw pixels
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
    y: (s.phi * (Daydream.H - 1)) / Math.PI,
  };
};

const pixelToSpherical = (x, y) => {
  return new THREE.Spherical(
    1,
    (y * Math.PI) / (Daydream.H - 1),
    (x * 2 * Math.PI) / Daydream.W
  );
};

const vectorToPixel = (v) => {
  let s = new THREE.Spherical().setFromVector3(v);
  return {
    x: wrap((s.theta * Daydream.W) / (2 * Math.PI), Daydream.W),
    y: (s.phi * (Daydream.H - 1)) / Math.PI,
  };
};

const pixelToVector = (x, y) => {
  let s = new THREE.Spherical(
    1,
    (y * Math.PI) / (Daydream.H - 1),
    (x * 2 * Math.PI) / Daydream.W
  );
  return new THREE.Vector3().setFromSpherical(s);
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

const blendAdd = (c1, c2) => {
  return new THREE.Color(
    Math.min(1, c1.r + c2.r),
    Math.min(1, c1.g + c2.g),
    Math.min(1, c1.b + c2.b)
  );
}

const blendAlpha = (a) => {
  return (c1, c2) => {
    return new THREE.Color(
      c1.r * a + c2.r * (1 - a),
      c1.g * a + c2.g * (1 - a),
      c1.b * a + c2.b * (1 - a)
    );
  }
}

const blendOverMax = (c1, c2) => {
  const m1 =
    Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 =
    Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
  if (m2 == 0) {
    return c1;
  }
  let s = Math.max(m1, m2) / m2;
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

const randomVector = () => {
  return new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1).normalize();
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
  let w = new THREE.Vector3().crossVectors(v, u).normalize();
  if (longWay) {
    a = 2 * Math.PI - a;
    w.negate();
  }
  a *= Math.abs((end - start));
  v.crossVectors(u, w).normalize();

  const step = 2 * Math.PI / Daydream.W;
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

const fnPoint = (f, normal, radius, angle) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
    radius = 2 - radius;
  }
  u.crossVectors(v, Daydream.X_AXIS).normalize();
  if (u.length() == 0) {
    u.crossVectors(v, Daydream.Z_AXIS).normalize();
  }
  w.crossVectors(v, u);
  let d = Math.sqrt(Math.pow(1 - radius, 2));

  let vi = calcRingPoint(angle, radius, u, v, w);
  let vp = calcRingPoint(angle, 1, u, v, w);
  let axis = new THREE.Vector3().crossVectors(v, vp).normalize();
  let shift = new THREE.Quaternion().setFromAxisAngle(axis, f(angle * Math.PI / 2));
  return vi.clone().applyQuaternion(shift);
};

const drawFn = (orientation, normal, radius, shiftFn, colorFn) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = orientation.orient(normal);
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
  }
  u.crossVectors(v, orientation.orient(Daydream.X_AXIS)).normalize();
  if (u.length() == 0) {
    u.crossVectors(v, orientation.orient(Daydream.Z_AXIS)).normalize();
  }
  w.crossVectors(v, u);
  if (radius > 1) {
    w.negate();
    radius = 2 - radius;
  }
  let d = Math.sqrt(Math.pow(1 - radius, 2));

  let start = undefined;
  let from = undefined;
  let step = 1 / Daydream.W;
  for (let t = 0; t < 1; t += step) {
    let vi = calcRingPoint(t * 2 * Math.PI, radius, u, v, w);
    let vp = calcRingPoint(t * 2 * Math.PI, 1, u, v, w);
    let axis = new THREE.Vector3().crossVectors(v, vp).normalize();
    let shift = new THREE.Quaternion().setFromAxisAngle(axis, shiftFn(t));
    let to = vi.clone().applyQuaternion(shift);
    if (start === undefined) {
      dots.push(new Dot(to, colorFn(to)));
      start = to;
    } else {
      dots.push(new Dot(to, colorFn(to)));
//      dots.push(...drawLine(from, to, colorFn));
    }
    from = to;
  }
  //dots.push(...drawLine(from, start, colorFn));

  return dots;
};

const calcRingPoint = (a, radius, u, v, w) => {
  let d = Math.sqrt(Math.pow(1 - radius, 2));
  return new THREE.Vector3(
    d * v.x + radius * u.x * Math.cos(a) + radius * w.x * Math.sin(a),
    d * v.y + radius * u.y * Math.cos(a) + radius * w.y * Math.sin(a),
    d * v.z + radius * u.z * Math.cos(a) + radius * w.z * Math.sin(a)
  ).normalize();
}

const drawRing = (orientation, normal, radius, colorFn, phase = 0) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = orientation.orient(normal);
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
  }
  u.crossVectors(v, orientation.orient(Daydream.X_AXIS)).normalize();
  if (u.length() == 0) {
    u.crossVectors(v, orientation.orient(Daydream.Z_AXIS)).normalize();
  }
  w.crossVectors(v, u);
  if (radius > 1) {
    w.negate();
    radius = 2 - radius;
  }

  let step = 2 * Math.PI / Daydream.W;
  for (let a = 0; a < 2 * Math.PI; a += step) {
    let vi = calcRingPoint((a + phase) % (2 * Math.PI), radius, u, v, w);
    dots.push(new Dot(vi, colorFn(vi, a / (2 * Math.PI))));
  }

  return dots;
};

const ringPoint = (normal, radius, angle, phase = 0) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
  }
  u.crossVectors(v, Daydream.X_AXIS).normalize();
  if (u.length() == 0) {
    u.crossVectors(v, Daydream.Z_AXIS).normalize();
  }
  w.crossVectors(v, u);
  if (radius > 1) {
    w.negate();
    radius = 2 - radius;
  }
  return calcRingPoint(angle + phase, radius, u, v, w);
};

const fibSpiral = (n, eps, i) => {
  return new THREE.Vector3().setFromSpherical(new THREE.Spherical(
    1,
    Math.acos(1 - (2 * (i + eps)) / n),
    (2 * Math.PI * i * g) % (2 * Math.PI)
  ));
}

const drawFibSpiral = (n, eps, colorFn) => {
  let dots = [];
  for (let i = 0; i < n; ++i) {
    let v = fibSpiral(n, eps, i);
    dots.push(new Dot(v, colorFn(v)));
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
    return this;
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

class Timeline {
  constructor() {
    this.t = 0;
    this.animations = [];
  }

  add(inSecs, animation) {
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
      if (this.t >= this.animations[i].start) {
        if (this.animations[i].animation.done()) {
          this.animations[i].animation.post();
          this.animations.splice(i, 1);
          continue;
        }
        this.animations[i].animation.step();
      }
    }
  }
}

class Animation {
  constructor(duration, repeat) {
    this.duration = duration;
    this.repeat = repeat;
    this.t = 0;
    this.canceled = false;
    this.post = () => { };
  }

  cancel() { this.canceled = true; }
  done() { return this.canceled || (this.duration >= 0 && this.t > this.duration); }

  step() {
    this.t++;
    if (this.done()) {
      if (this.repeat) {
        this.post();
        this.t = 1;
      }
    }
  }

  then(post) {
    this.post = post;
    return this;
  }

  post() {
    this.post();
  }
}

class RandomTimer extends Animation {
  constructor(min, max, f, repeat = false) {
    super(-1, repeat);
    this.min = min;
    this.max = max;
    this.f = f;
    this.next = 0;
    this.reset();
  }

  reset(t) {
    this.next = this.t + Math.round(Math.random() * (this.max - this.min) + this.min);
  }

  step() {
    if (this.t >= this.next) {
      this.f();
      if (this.repeat) {
        this.reset();
      } else {
        this.canceled = true;
      }
    }
    super.step();
  }
}

class PeriodicTimer extends Animation {
  constructor(period, f, repeat = false) {
    super(-1, repeat);
    this.period = period;
    this.f = f;
    this.reset();
  }

  reset() {
    this.next = this.t + this.period;
  }

  step() {
    if (this.t >= this.next) {
      this.f();
      if (this.repeat) {
        this.reset(t);
      } else {
        this.cancel();
      }
    }
    super.step();
  }
}

class Sprite extends Animation {
  constructor(drawFn, duration,
    fadeInDuration = 0, fadeInEasingFn = easeMid,
    fadeOutDuration = 0, fadeOutEasingFn = easeMid)
  {
    super(duration, false);
    this.drawFn = drawFn;
    this.fader = new MutableNumber(fadeInDuration > 0 ? 0 : 1);
    this.fadeInDuration = fadeInDuration;
    this.fadeOutDuration = fadeOutDuration;
    this.fadeIn = new Transition(this.fader, 1, fadeInDuration, fadeInEasingFn);
    this.fadeOut = new Transition(this.fader, 0, fadeOutDuration, fadeOutEasingFn);
  }

  step() {
    if (!this.fadeIn.done()) {
      this.fadeIn.step();
    } else if (this.duration >= 0 && this.t >= (this.duration - this.fadeOutDuration)) {
      this.fadeOut.step();
    }
    this.drawFn(this.fader.get());
    super.step();
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
    super.step();
  }
}

class MutableNumber {
  constructor(n) {
    this.n = n;
  }
  get() { return this.n; }
  set(n) { this.n = n; }
}

class Transition extends Animation {
  constructor(mutable, to, duration, easingFn, quantized = false, repeat = false) {
    super(duration, repeat);
    this.mutable = mutable;
    this.to = to;
    this.duration = duration;
    this.easingFn = easingFn;
    this.quantized = quantized;
  }

  step() {
    if (this.t == 0) {
      this.from = this.mutable.get();
    }
    super.step();
    let t = Math.min(1, this.t / (this.duration));
    let n = this.easingFn(t) * (this.to - this.from) + this.from;
    if (this.quantized) {
      n = Math.floor(n);
    }
    this.mutable.set(n);
  }
}

class MutateFn extends Animation {
  constructor(mutable, fn, duration, easingFn, repeat = false) {
    super(duration, repeat);
    this.mutable = mutable;
    this.fn = fn;
    this.duration = duration;
    this.easingFn = easingFn;
  }

  step() {
    if (this.t == 0) {
      this.from = this.mutable.get();
    }
    let t = Math.min(1, this.t / (this.duration - 1));
    this.mutable.set(this.fn(this.easingFn(t), this.mutable.get()));
    super.step();
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
    this.from = this.to;
    this.to = this.easingFn((this.t) / this.duration) * this.totalAngle;
    let angle = distance(this.from, this.to, this.totalAngle);
    if (angle > 0.0001) {
      let origin = this.orientation.get();
      for (let a = Rotation.MAX_ANGLE; angle - a > 0.0001; a += Rotation.MAX_ANGLE) {
        let r = new THREE.Quaternion().setFromAxisAngle(this.axis, a);
        this.orientation.push(origin.clone().premultiply(r));
      }
      let r = new THREE.Quaternion().setFromAxisAngle(this.axis, angle);
      this.orientation.push(origin.clone().premultiply(r));
    }
    super.step();
  }
}

///////////////////////////////////////////////////////////////////////////////

function dir(v) { return v < 0 ? -1 : 1; }

function wrap(x, m) {
  return x >= 0 ? x % m : ((x % m) + m) % m;
}

function distanceWrap(x1, x2, m) {
  let d = Math.abs(x1 - x2) % m;
  return Math.min(d, m - d);
}

function distance(a, b, m) {
  const a_norm = ((a % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
  const b_norm = ((a % (2 * Math.PI)) + (2 * Math.PI)) % (2 * Math.PI);
  let diff = b - a;
  if (diff < 0) {
    diff += m;
  }
  return diff;
}

function sinWave(from, to, freq, phase) {
  return (t) => {
    let w = (Math.sin(freq * t * 2 * Math.PI - Math.PI / 2 + Math.PI - 2 * phase) + 1) / 2;
    return w * (to - from) + from;
  };
}

function lerp(from, to, t) {
  return (to - from) * t + from;
}

function triWave(from, to, freq, phase) {
  return (t) => {
    if (t < 0.5) {
      var w = 2 * t;
    } else {
      w = 2 - 2 * t;
    }
    return w * (to - from) + from;
  };
}

function squareWave(from, to, freq, dutyCycle, phase) {
  return (t) => {
    if ((t * freq + phase) % 1 < dutyCycle) {
      return to;
    }
    return from;
  };
}

function distanceGradient(v, normal) {
  let d = v.dot(normal);
  if (d > 0) {
    return g1.get(d).clone();
  } else {
    return g2.get(-d).clone();
  }
}

function lissajous(m1, m2, a, t) {
  return new THREE.Vector3(
    Math.sin(m2 * t) * Math.cos(m1 * t - a * Math.PI),
    Math.cos(m2 * t),
    Math.sin(m2 * t) * Math.sin(m1 * t - a * Math.PI),
  );
}

function rotateBetween(from, to) {
  let diff = from.get().clone().conjugate().premultiply(to.get());
  let angle = 2 * Math.acos(diff.w);
  if (angle == 0) {
    return
  } else {
    var axis = new THREE.Vector3(diff.x, diff.y, diff.z).normalize();
  }
  new Rotation(from, axis, angle, 1, easeOutCirc).step();
}

function plotDots(pixels, labels, filter, dots, age = 0, blendFn = blendOverMax) {
  for (const dot of dots) {
    let p = sphericalToPixel(new THREE.Spherical().setFromVector3(dot.position));
    filter.plot(pixels, p.x, p.y, dot.color, age, blendFn);
  }
}

function isOver(v, normal) {
  return normal.dot(v) >= 0;
}

function makeRandomVector() {
  return new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1).normalize();
}

function intersectsPlane(v1, v2, normal) {
  return (isOver(v1, normal) && !isOver(v2, normal))
    || (!isOver(v1, normal) && isOver(v2, normal));
}

function angleBetween(v1, v2) {
  return Math.acos(Math.max(-1, Math.min(1, v1.dot(v2))));
}

function intersection(u, v, normal) {
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

function splitPoint(c, normal) {
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

function bisect(poly, orientation, normal) {
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

const easeOutExpo = (t) => {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
}

const easeOutCirc = (t) => {
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
      let old = 0;
      if (pixels.has(key)) {
        old = pixels.get(key);
      } else {
        old = new THREE.Color(0, 0, 0);
      }
      pixels.set(pixelKey(x, y), blendFn(old, color));
    } else {
      this.next.plot(pixels, x, y, color, age, blendFn);
    }
  }
}

class FilterOrient extends Filter {
  constructor(orientation) {
    super();
    this.orientation = orientation;
  }

  plot(pixels, x, y, color, age, blendFn) {
    let v = new THREE.Vector3()
      .setFromSpherical(pixelToSpherical(x, y));
    let r = sphericalToPixel(new THREE.Spherical()
      .setFromVector3(this.orientation.orient(v)));
    this.orientation.collapse();
    this.pass(pixels, r.x, r.y, color, age, blendFn);
  }
}

class FilterRaw extends Filter {
  plot(pixels, x, y, color, age, blendFn) {
    this.pass(pixels, x, y, color, age, blendFn);
  }
}

class FilterFn extends Filter {
  constructor(fn) {
    super();
    thi.fn = fn();
  }

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

    let a = falloff((1 - xm) * (1 - ym));
    this.pass(pixels, xi, yi, color, age, blendAlpha(a));

    a = falloff(xm * (1 - ym));
    this.pass(pixels, wrap((xi + 1), Daydream.W), yi, color, age, blendAlpha(a));

    if (yi < Daydream.H - 1) {
      a = falloff((1 - xm) * ym);
      this.pass(pixels, xi, yi + 1, color, age, blendAlpha(a));

      a = falloff(xm * ym);
      this.pass(pixels, wrap((xi + 1), Daydream.W), yi + 1, color, age, blendAlpha(a));
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

class FilterColorShift extends Filter {
  constructor(colorShiftFn) {
    super();
    this.colorShiftFn = colorShiftFn;
    this.t = 0;
  }

  plot(pixels, x, y, color, age, blendFn) {
    this.pass(pixels, x, y, this.colorShiftFn(x, y, color), age, blendFn);
  }
}

function hashInt(n) {
  // Force to 32-bit integer for consistent behavior
  n = n | 0;

  // Mixing operations (variant of MurmurHash3 finalizer)
  n = ((n >> 16) ^ n) * 0x45d9f3b;
  n = ((n >> 16) ^ n) * 0x45d9f3b;
  n = ((n >> 16) ^ n);
  return n;
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

  randomPhase(x, y) {
    // 1. Combine the two integers into a single hash input (32-bit integer mix)
    // We start with x, and then mix in y using bitwise operations and a multiplier (like 31 or 17).
    let combined = (x | 0); // Start with x

    // A simple, effective combination is using multiplication and XOR.
    // 0x9e3779b9 is a standard magic number (the golden ratio base in 32-bit) used for mixing.
    combined = (combined ^ (y | 0) + 0x9e3779b9 + (combined << 6) + (combined >> 2));

    // 2. Hash the combined 32-bit integer
    const hashedInt = hashInt(combined);

    // 3. Convert to a number in the range [0, 1)
    // The >>> 0 converts the signed 32-bit integer to an unsigned 32-bit integer [0, 2^32 - 1].
    const unsignedInt = hashedInt >>> 0;

    // Divide by 2^32 (4294967296.0) to normalize to [0, 1)
    const normalizedValue = unsignedInt / 4294967296.0;

    // 4. Scale to the desired range [0, 2 * PI)
    return normalizedValue * 2 * Math.PI;
  }

  plot(pixels, x, y, color, age, blendFn) {
    let m = this.amplitude * Math.sin(
     this.randomPhase(x, y) + Math.sin((this.freq * this.t))
    ) + this.amplitude;
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

  trail(pixels, trailFn, blendFn = blendUnder) {
    for (const [key, ttl] of this.trails) {
      if (ttl > 0) {
        let p = keyPixel(key);
        let color = trailFn(p[0], p[1], 1 - (ttl / this.lifespan));
        this.pass(pixels, p[0], p[1], color, this.lifespan - ttl, blendFn);
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

function dottedBrush(color, freq, dutyCycle, phase, t) {
  let r = squareWave(0, 1, freq, dutyCycle, phase)(t);
  return color.multiplyScalar(r);
}

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
    return this.colors[Math.floor(a * (this.colors.length - 1))].clone().convertSRGBToLinear();
  }
};

function randomBetween(a, b) {
  return Math.random() * (b - a) + a;
}

class GenerativePalette {
  constructor() {
    this.reset();
  }

  reset() {
    let sat = randomBetween(0.4, 0.6);
    let dir = Math.random() < 0.5 ? 1 : -1;
    let hueA = Math.random();
    let hueB = (hueA + dir * randomBetween(0.1, 0.166)) % 1;
    let hueC = (hueB + dir * randomBetween(0.1, 0.166)) % 1;
    this.a = new THREE.Color().setHSL(hueA, sat, 0.1);
    this.b = new THREE.Color().setHSL(hueB, sat, 0.3);
    this.c = new THREE.Color().setHSL(hueC, sat, 0.6);
  }

  get(t) {
    let end = new THREE.Color(0, 0, 0);
    if (t < 0.1) {
      return new THREE.Color().lerpColors(
        end, this.a, t * 10).convertSRGBToLinear();
    } else if (t < 0.5) {
      return new THREE.Color().lerpColors(
        this.a, this.b, (t - 0.1) * 2.5).convertSRGBToLinear();
    } else if (t < 0.9) {
      return new THREE.Color().lerpColors(
        this.b, this.c, (t - 0.5) * 2.5).convertSRGBToLinear();
    } else {
      return new THREE.Color().lerpColors(
        this.c, end, (t - 0.9) * 10).convertSRGBToLinear();
    }
  }
}


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

let vintageSunset = new Gradient(16384, [
  [0.0, 0xe005e], // Dark Blue
  [0.4, 0xb00202], // Dark Red
  [0.8, 0xcf8100], // Golderod
  [1, 0x000000]  // Black
]);

let emeraldForest = new Gradient(16384, [
  [0.0, 0x004E64],
  [0.2, 0x0B6E4F],
  [0.4, 0x08A045],
  [0.6, 0x6BBF59],
  [0.8, 0x138086],
//  [0.8, 0xEB9C35],
  [1, 0x000000]  
]);

let southwest = new Gradient(16384, [
  [0.0, 0x000000],
  [0.1, 0x534666],
  [0.3, 0x138086],
  [0.5, 0xcd7672],
  [0.7, 0xdc866B],
  [0.9, 0xeeb462],
  [1, 0x000000]
]);

let winterBlues = new Gradient(16384, [
  [0, 0x1F2F98],
  [0.2, 0x787ff6],
  [0.4, 0x1ca7ec],
  [0.6, 0x7bd5f5],
  [0.8, 0x4adede],
  [1, 0x000000]
]);

///////////////////////////////////////////////////////////////////////////////

class PolyRot {
  constructor() {
    this.pixels = new Map();
    this.labels = [];

    this.ring = Daydream.Y_AXIS.clone();
    this.ringOrientation = new Orientation();

    this.spinAxis = Daydream.Y_AXIS.clone();
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
    Daydream.W = 96;

    // State
    this.pixels = new Map();
    this.labels = [];

    this.palettes = [
      new GenerativePalette(),
      new GenerativePalette()
    ];

    this.paletteIndex = 0;
    this.paletteIndexNext = 1;
    this.paletteNormal = Daydream.Y_AXIS.clone();
    this.paletteBoundary = new MutableNumber(0);
    this.wiping = false;

    this.nodes = [];
    for (let i = 0; i < Daydream.H; ++i) {
      this.nodes.push(new Ring(i));
    }
    this.speed = 2;
    this.gap = 4;
    this.trailLength = 10;
    this.orientation = new Orientation();
    this.trails = new FilterDecayTrails(this.trailLength);
    this.aa = new FilterAntiAlias();
    this.replicate = new FilterReplicate(4);
    this.orient = new FilterOrient(this.orientation);

    // Filters
    this.filters = new FilterRaw();
    this.filters
      .chain(this.replicate)
      .chain(this.trails)
      .chain(this.orient)
      .chain(this.aa)
     ;

    // Scene
    this.timeline = new Timeline();

    this.timeline.add(0,
      new RandomTimer(4, 40, () => {
        this.reverse();
        if (!this.wiping) {
          this.colorWipe();
        }
      }, true)
    );

    this.timeline.add(0,
      new RandomTimer(64, 88, () => {
        this.rotate();
      }, true)
    );
  }

  reverse() {
    this.speed *= -1;
  }

  rotate() {
    this.timeline.add(0,
      new Rotation(
        this.orientation,
        randomVector(),
        Math.PI,
        40,
        easeInOutSin,
        false
      )
    );
  }

  colorWipe() {
    this.wiping = true;
    this.timeline.add(0,
      new Transition(this.paletteBoundary, Math.PI, 40, easeMid)
        .then(() => {
          this.paletteIndex = this.paletteIndexNext;
          this.paletteIndexNext = (this.paletteIndexNext + 1) % 2;
          this.palettes[this.paletteIndexNext].reset();
          this.paletteBoundary.set(0);
          this.wiping = false;
        }
      )
    );
  }

  color(v, t) {
    let i = this.paletteIndex;
    if (angleBetween(this.paletteNormal, v) < this.paletteBoundary.get()) {
      i = this.paletteIndexNext;
    }
    return this.palettes[i].get(t);
  }

  drawFrame() {
    this.pixels.clear();
    this.trails.decay();
    this.timeline.step();
    for (let i = Math.abs(this.speed) - 1; i >= 0; --i) {
      this.pull(0);
      this.drawNodes(i * 1 / Math.abs(this.speed));
    }
    this.trails.trail(this.pixels,
      (x, y, t) => this.color(pixelToVector(x, y), t), blendOver);
    return { pixels: this.pixels, labels: this.labels };
  }

  nodeY(node) {
    return (node.y / (this.nodes.length - 1)) * (Daydream.H - 1);
  }

  drawNodes(age) {
    let dots = [];
    for (let i = 0; i < this.nodes.length; ++i) {
      if (i == 0) {
        let from = pixelToVector(this.nodes[i].x, this.nodeY(this.nodes[i]));
        dots.push(...drawVector(from, (v) => this.color(v, 0)));
      } else {
        let from = pixelToVector(this.nodes[i - 1].x, this.nodeY(this.nodes[i - 1]));
        let to = pixelToVector(this.nodes[i].x, this.nodeY(this.nodes[i]));
        dots.push(...drawLine(from, to, (v) => this.color(v, 0)));
      }
    }
    plotDots(this.pixels, this.labels, this.filters, dots, age, blendOverMax);
  }

  pull(y) {
    this.nodes[y].v = dir(this.speed);
    this.move(this.nodes[y]);
    for (let i = y - 1; i >= 0; --i) {
      this.drag(this.nodes[i + 1], this.nodes[i]);
    }
    for (let i = y + 1; i < this.nodes.length; ++i) {
      this.drag(this.nodes[i - 1], this.nodes[i]);
    }
  }

  drag(leader, follower) {
    let dest = wrap(follower.x + follower.v, Daydream.W);
    if (distanceWrap(dest, leader.x, Daydream.W) > this.gap) {
      follower.v = leader.v;
      while (distanceWrap(follower.x, leader.x, Daydream.W) > this.gap) {
        this.move(follower);
      }
    } else {
      this.move(follower);
    }
  }

  move(ring) {
    let dest = wrap(ring.x + ring.v, Daydream.W);
    let x = ring.x;
    while (x != dest) {
      x = wrap(x + dir(ring.v), Daydream.W);
    }
    ring.x = dest;
  }
}

///////////////////////////////////////////////////////////////////////////////

class Thruster {
  constructor(drawFn, orientation, thrustPoint) {
    this.exhaustRadius = new MutableNumber(0);
    this.exhaustMotion = new Transition(this.exhaustRadius, 0.3, 8, easeMid);
    this.exhaustSprite = new Sprite(
      drawFn.bind(null, orientation, thrustPoint, this.exhaustRadius),
      16, 0, easeMid, 16, easeOutExpo);
  }

  done() {
    return this.exhaustMotion.done()
    && this.exhaustSprite.done();
    ;
  }

  step() {
    this.exhaustSprite.step();
    this.exhaustMotion.step();
  }
}

class Thrusters {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.3, 0.3],
      [0.0, 0.2, 0.6]
    );

    // Output Filters
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
    ;

    // State
    this.t = 0;
    this.ring = new THREE.Vector3(0.5, 0.5, 0.5).normalize();
    this.orientation = new Orientation();
    this.to = new Orientation();
    this.thrusters = [];
    this.amplitude = new MutableNumber(0);
    this.warpPhase = 0;
    this.radius = new MutableNumber(1);

    // Animations
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(this.drawRing.bind(this), -1,
        16, easeInSin,
        16, easeOutSin)
    );
    this.timeline.add(0, new RandomTimer(8, 48,
      () => this.onFireThruster(), true)
    );
  }

  drawThruster(orientation, thrustPoint, radius, opacity) {
    let dots = drawRing(orientation, thrustPoint, radius.get(),
      (v) => new THREE.Color(0xffffff).multiplyScalar(opacity));
    plotDots(this.pixels, this.labels, this.ringOutput, dots, 0, blendOverMax);
  }

  onFireThruster() {
    let thrustDir = Math.random() < 0.5 ? -1 : -1;
    this.warpPhase = Math.random() * 2 * Math.PI;
    let thrustPoint = fnPoint(
      this.ringFn.bind(this), this.ring, 1, this.warpPhase);
    let thrustOrientation = new Orientation().set(this.orientation.get());
    let thrustOpp = fnPoint(
      this.ringFn.bind(this), this.ring, 1, (this.warpPhase + Math.PI));
    // warp ring
    if (!(this.warp === undefined || this.warp.done())) {
      this.warp.cancel();
    }
    this.warp = new MutateFn(
      this.amplitude, (t) => 0.7 * Math.exp(-2 * t), 32, easeMid);
    this.timeline.add(1/16,
      this.warp
    );
    
    // Spin ring
    let thrustAxis = new THREE.Vector3().crossVectors(
      this.orientation.orient(thrustPoint),
      this.orientation.orient(this.ring))
      .normalize();
    this.timeline.add(0,
      new Rotation(this.orientation, thrustAxis, 2 * Math.PI, 8 * 16, easeOutExpo)
    );
    
    // show thruster
    this.timeline.add(0,
      new Thruster(
        this.drawThruster.bind(this),
        thrustOrientation,
        thrustPoint)
    );
    this.timeline.add(0,
      new Thruster(
        this.drawThruster.bind(this),
        thrustOrientation,
        thrustOpp)
    );
  }

  ringFn(t) {
    return sinWave(-1, 1, 2, this.warpPhase)(t) // ring
      * sinWave(-1, 1, 3, 0)((this.t % 32) / 32) // oscillation
      * this.amplitude.get(); 
  }

  drawRing(opacity) {
    rotateBetween(this.orientation, this.to);
    this.orientation.collapse();
    this.to.collapse();
    let dots = drawFn(this.orientation, this.ring, this.radius.get(),
      this.ringFn.bind(this),
      (v) => {
        let z = this.orientation.orient(Daydream.X_AXIS);
        return this.palette.get(angleBetween(z, v) / Math.PI).multiplyScalar(opacity);
      }
    );
    plotDots(this.pixels, this.labels, this.ringOutput, dots, 0, blendOverMax);
  }

  drawFrame() {
    this.pixels.clear();
    this.labels = [];
    this.timeline.step();        
    this.t++;
     return { pixels: this.pixels, labels: this.labels };
  }
}

///////////////////////////////////////////////////////////////////////////////

class RingCircus {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.palette = new MutatingPalette(
      [0.5, 0.5, 0.5],
      [0.5, 0.5, 0.5],
      [0.5, 0.25, 0.25],
      [0.91, 0.205, 0.505],

      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    (this.ringOutput = new FilterRaw())
      //      .chain(new FilterChromaticShift())
      .chain(new FilterAntiAlias())
      ;

    // State
    this.normal = Daydream.Z_AXIS.clone();
    this.orientation = new Orientation();
    this.numRings = new MutableNumber(5);
    this.spreadFactor = new MutableNumber(0);
    this.homeRadius = new MutableNumber(0);
    this.dutyCycle = new MutableNumber(1);
    this.freq = new MutableNumber(6);
    this.twist = new MutableNumber(0);
    this.t = 0;

    // Animations
    this.timeline = new Timeline();

    this.timeline.add(0,
      new Sprite((opacity) => {
        this.orientation.collapse();
        this.drawRings(opacity);
      },
      -1, 8, easeMid, 0, easeMid)
    );

    // T0: sweep to center
    this.timeline.add(0,
      new Transition(this.homeRadius, 1, 16, easeMid)
    );

    // T1: Spin everything
    this.onSpinRings(1);

    // T5: start circus
    this.timeline.add(2,
      new RandomTimer(16, 48, this.onMultiplyRings.bind(this)));
    this.timeline.add(5,
      new RandomTimer(16, 48, this.onSplitRings.bind(this)));
    this.timeline.add(5,
      new RandomTimer(16, 48, this.onSpreadRings.bind(this)));
    this.timeline.add(5,
      new RandomTimer(16, 48, this.onTwistRings.bind(this)));
  }

  onSpinRings(inSecs = 0) {
    this.orientation.collapse();
    this.timeline.add(inSecs,
      new Rotation(this.orientation,
        ringPoint(this.normal, 1, Math.random() * 2 * Math.PI),
        4 * Math.PI,
        96, easeInOutSin, false)
    );
    this.timeline.add(inSecs,
      new RandomTimer(48, 80, () => {
        this.onSpinRings();
      })
    );
  }

  onSpreadRings(inSecs = 0) {
    // spread
    this.timeline.add(inSecs,
      new Transition(this.spreadFactor, 1, 80, easeInOutSin)
    );
    // collapse rings
    this.timeline.add(inSecs + 5,
      new RandomTimer(80, 160, this.onCollapseRings.bind(this)));
  }

  onCollapseRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Transition(this.spreadFactor, 0, 80, easeInOutSin)
    );
   //spread rings
   this.timeline.add(inSecs + 5,
     new RandomTimer(16, 48, this.onSpreadRings.bind(this)));
  }

  onSplitRings(inSecs = 0) {
    this.timeline.add(0,
      new Transition(this.dutyCycle, 2 * Math.PI / Daydream.W, 32, easeInOutSin)
    );
    // merge rings
    this.timeline.add(inSecs + 2,
      new RandomTimer(80, 160, this.onMergeRings.bind(this)));
  }

  onMergeRings(inSecs = 0) {
    this.timeline.add(0,
      new Transition(this.dutyCycle, 1, 32, easeInOutSin)
    );
    // split rings
    this.timeline.add(inSecs + 2,
      new RandomTimer(16, 48, this.onSplitRings.bind(this)));
  }

  onMultiplyRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Transition(this.numRings, Daydream.W,
        48, easeMid, true)
    );
    // reduce rings
    this.timeline.add(inSecs + 3,
      new RandomTimer(16, 48, this.onReduceRings.bind(this)));
  }

  onReduceRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Transition(this.numRings, 5,
        48, easeMid, true)
    );
    // multiply rings
    this.timeline.add(inSecs + 3,
      new RandomTimer(80, 160, this.onMultiplyRings.bind(this)));
  }

  onTwistRings(inSecs = 0) {
    this.timeline.add(0,
      new Transition(this.twist, Math.PI / Daydream.W,
        80, easeMid)
    );
    // align rings
    this.timeline.add(inSecs + 5,
      new RandomTimer(48, 80, this.onAlignRings.bind(this)));
  }

  onAlignRings(inSecs = 0) {
    this.timeline.add(0,
      new Transition(this.twist, 0,
        80, easeMid)
    );
    // twist rings
    this.timeline.add(inSecs + 5,
      new RandomTimer(16, 48, this.onTwistRings.bind(this)));
  }

  calcRingSpread() {
    this.radii = new Array(this.numRings.get());
    for (let i = 0; i < this.numRings.get(); ++i) {
      let x = ((i + 1) / (this.numRings.get() + 1)) * 2 - 1;
      let r = Math.sqrt(Math.pow(1 - x, 2));
      this.radii[i] = new MutableNumber(lerp(this.homeRadius.get(), r, this.spreadFactor.get()));
    }
  }

  drawRings(opacity) {
    this.calcRingSpread();
    for (let i = 0; i < this.radii.length; ++i) {
      let dots = drawRing(this.orientation, this.normal, this.radii[i].get(),
        (v, t) => {
          let idx = this.numRings.get() == 1 ? 0 : (1 - (i / (this.numRings.get() - 1)));
          let color = this.palette.get(idx);
          let r =  dottedBrush(color.multiplyScalar(opacity), this.freq.get(),
            this.dutyCycle.get(), this.twist.get(), t);
          return r;
        }, (0.1 +  this.twist.get()) * i);
      plotDots(this.pixels, this.labels, this.ringOutput, dots, 0, blendOverMax);
    }
  }

  drawFrame() {
    this.palette.mutate(Math.sin(0.01 * this.t++));
    this.pixels.clear();
    this.labels = [];
    this.timeline.step();
    return { pixels: this.pixels, labels: this.labels };
  }
}

///////////////////////////////////////////////////////////////////////////////

class Wormhole {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      ;

    // State
    this.normal = Daydream.Z_AXIS.clone();
    this.numRings = new MutableNumber(Daydream.W);
    this.orientation = new Orientation();
    this.spreadFactor = new MutableNumber(1);
    this.homeRadius = new MutableNumber(1);
    this.dutyCycle = new MutableNumber((2 * Math.PI) / Daydream.W);
    this.freq = new MutableNumber(2);
    this.twist = new MutableNumber(7 / Daydream.W);
    this.phase = new MutableNumber(0);
    this.t = 0;

    // Animations
    this.timeline = new Timeline();

    this.timeline.add(0,
      new Sprite((opacity) => {
        this.drawRings(opacity);
      },
        -1, 8, easeMid, 0, easeMid)
    );

    // T1: Spin everything
    this.onThrustRings(1);
    this.onSpinRings(1);
    this.onMutateDutyCyle(1);
    this.onMutateTwist(1);

  }

  onMutateDutyCyle(inSecs = 0) {
    this.timeline.add(inSecs,
      new MutateFn(this.dutyCycle, sinWave((2 * Math.PI) / Daydream.W, (8 * 2 * Math.PI) / Daydream.W, 1, Math.PI / 2),
        160, easeMid, true)
    );
  }

  onMutateTwist(inSecs = 0) {
    this.timeline.add(inSecs,
      new MutateFn(this.twist, sinWave(3 / Daydream.W, 10 / Daydream.W, 1, Math.PI / 2),
        64, easeMid, true)
    );
  }

  onThrustRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Rotation(this.orientation,
        ringPoint(this.normal, 1, Math.random() * 2 * Math.PI),
        2 * Math.PI,
        96, easeInOutSin, false)
    );

    this.timeline.add(inSecs,
      new RandomTimer(48, 70, () => {
        this.onThrustRings();
      })
    );
  }

  onSpinRings(inSecs = 0) {
    this.timeline.add(inSecs,
      new Transition(this.phase, 2 * Math.PI, 32, easeMid, false, true)
    );
  }

  calcRingSpread() {
    this.radii = new Array(this.numRings.get());
    for (let i = 0; i < this.numRings.get(); ++i) {
      let x = ((i + 1) / (this.numRings.get() + 1)) * 2 - 1;
      let r = Math.sqrt(Math.pow(1 - x, 2));
      this.radii[i] = new MutableNumber(lerp(this.homeRadius.get(), r, this.spreadFactor.get()));
    }
  }

  drawRings(opacity) {
    this.calcRingSpread();
    this.orientation.collapse();
    for (let i = 0; i < this.radii.length; ++i) {
      let dots = drawRing(this.orientation, this.normal, this.radii[i].get(),
        (v, t) => {
          let idx = this.numRings.get() == 1 ? 0 : (1 - (i / (this.numRings.get() - 1)));
          let darken = Math.pow(1 - Math.abs(this.radii[i].get() - 1), 3);
          let color = this.palette.get(idx).multiplyScalar(darken);
          let r = dottedBrush(color.multiplyScalar(opacity), this.freq.get(),
            this.dutyCycle.get(), this.twist.get(), t);
          return r;
        }, (this.twist.get()) * i + this.phase.get());
      plotDots(this.pixels, this.labels, this.ringOutput, dots, 0, blendOverMax);
    }
  }

  drawFrame() {
//    this.palette.mutate(Math.sin(0.01 * this.t++));
    this.pixels.clear();
    this.labels = [];
    this.timeline.step();
    return { pixels: this.pixels, labels: this.labels };
  }
}

///////////////////////////////////////////////////////////////////////////////

class Pulses {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      ;

    // State
//    this.poly = new Dodecahedron();
    this.orientation = new Orientation();
    this.numRings = 6;
    this.normals = Array.from({ length: this.numRings }, (v, i) => {
      return new THREE.Vector3().setFromSpherical(
        new THREE.Spherical(1, Math.PI / 2, (2 * Math.PI) * i / this.numRings));
    });
    this.radii = Array.from({ length: this.normals.length }, (v, i) => {
      return new MutableNumber(0);
    });

    // Animations
    this.timeline = new Timeline();

    this.timeline.add(0,
      new Sprite(
        (opacity) => this.drawRings(opacity),
        -1, 8, easeMid, 0, easeMid)
    );

    // T1: Start ring pulses
    this.onPulseRings(1);

  }


  onPulseRings(inSecs = 0) {
    for (let i = 0; i < this.radii.length; ++i) {
      this.timeline.add(inSecs,
        new Transition(this.radii[i], 2, 32, easeInOutSin, false, true)
      );
    }
  }

  drawRings(opacity) {
    for (let i = 0; i < this.radii.length; ++i) {
      let dots = drawRing(this.orientation, this.normals[i], this.radii[i].get(),
        (v, t) => {
          return this.palette.get(i / (this.radii.length - 1));
        },
        0
      );
      plotDots(this.pixels, this.labels, this.ringOutput, dots, 0, blendOverMax);
    }
  }

  drawFrame() {
    this.pixels.clear();
    this.labels = [];
    this.timeline.step();
    return { pixels: this.pixels, labels: this.labels };
  }
}

///////////////////////////////////////////////////////////////////////////////

class Fib {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    this.trails = new FilterDecayTrails(4);
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
//      .chain(new FilterChromaticShift())
      ;

    // State
    this.orientation = new Orientation();
    this.n = 20;
    this.heads = [];
    for (let i = 0; i < this.n; ++i) {
      this.heads.push(fibSpiral(this.n, 0, i));
    }
    this.tails = Array.from({ length: this.heads.length }, (v, i) => new MutableNumber(0));

    // Scene
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(
        (opacity) => this.draw(opacity),
        -1, 8, easeMid, 0, easeMid)
    );

    // T1: Start tails spinning
    this.onSpinTails(0);
  }

  onSpinTails(inSecs = 0) {
    for (let i = 0; i < this.heads.length; ++i) {
      this.timeline.add(inSecs,
        new Transition(this.tails[i], 2 * Math.PI, 16, easeMid, false, true)
      );
    }
  }

  draw(opacity) {
    this.trails.decay();
    let dots = [];
    for (let i = 0; i < this.heads.length; ++i) {
      let head = ringPoint(this.heads[i], 0.4, (this.tails[i].get() + Math.PI) % (2 * Math.PI), 2 * Math.PI / i)
      let tail = ringPoint(this.heads[i], 0.4, this.tails[i].get(), 2 * Math.PI / i);
      dots.push(...drawLine(head, tail, () => new THREE.Color(0x888888)));
    }
    this.trails.trail(this.pixels, new FilterRaw(), (x, y, t) => blueToBlack.get(t));
    plotDots(this.pixels, this.labels, this.ringOutput, dots, 0, blendOverMax);
  }

  drawFrame() {
    this.pixels.clear();
    this.labels = [];
    this.timeline.step();
    return { pixels: this.pixels, labels: this.labels };
  }
}

/////////////////////////////////////////////////////////////////////////////////

class Angles {
  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    this.trails = new FilterDecayTrails(10);
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
//      .chain(new FilterAntiAlias())
      //            .chain(new FilterChromaticShift())
//      .chain(new FilterReplicate(2))
//          .chain(new FilterMirror())
     // .chain(this.trails)
      ;

    // State
    this.orientation = new Orientation();
    this.ring = new THREE.Vector3(1, 0, 0).normalize();
    this.n = Daydream.W ;
    this.dots = new Array(this.n);
    for (let i = 0; i < this.n; ++i) {
      this.dots[i] = ((v) => {
        return v;
      })(ringPoint(this.ring, 1, 2 * Math.PI * i / this.n, 0));
    }
    this.axisRing = new THREE.Vector3(0, 1, 0).normalize();
    this.axes = new Array(this.n);
    for (let i = 0; i < this.n; ++i) {
      this.axes[i] = ringPoint(this.axisRing, 0.2 , 2 * Math.PI * i / this.n, 0);
    }
    this.orientations = new Array(this.n);
    for (let i = 0; i < this.n; ++i) {
      this.orientations[i] = new Orientation();
    }

    // Scene
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(
        (opacity) => this.draw(opacity),
        -1, 8, easeMid, 0, easeMid)
    );
    for (let i = 0; i < this.n; ++i) {
      let a = 2 * Math.PI / Daydream.W;
      this.timeline.add(0,
        new Rotation(this.orientations[i], this.axes[i], a * 16, 16, easeMid, true)
      );
    }
  }


  draw(opacity) {
    this.trails.decay();
    for (let i = 0; i < this.n; ++i) {
      for (let j = 1; j < this.orientations[i].length(); ++j) {
        plotDots(this.pixels, this.labels, this.ringOutput,
          drawVector(this.orientations[i].orient(this.dots[i], j),
            () => new THREE.Color(1, 0, 0))
        );
      }
      this.orientations[i].collapse();
      
/*
 plotDots(this.pixels, this.labels, this.ringOutput,
        drawVector(this.axes[i],
          () => new THREE.Color(0, 1, 0))
      );
 */     
    }
    this.trails.trail(this.pixels, new FilterRaw(), (x, y, t) => rainbow.get(t));
  }

  drawFrame() {
    this.pixels.clear();
    this.labels = [];
    this.timeline.step();
    return { pixels: this.pixels, labels: this.labels };
  }
}


///////////////////////////////////////////////////////////////////////////////
/*
class Grid {
  constructor() {
    Daydream.W = 96
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    this.trails = new FilterDecayTrails(4);
    (this.ringOutput = new FilterRaw())
      .chain(new FilterAntiAlias())
      //      .chain(new FilterChromaticShift())
      ;

    // State
    this.orientation = new Orientation();
    this.n = 20;
    this.heads =
    for (let i = 0; i < this.n; ++i) {
      this.heads.push(fibSpiral(this.n, 0, i));
    }
    this.tails = Array.from({ length: this.heads.length }, (v, i) => new MutableNumber(0));

    // Scene
    this.timeline = new Timeline();
    this.timeline.add(0,
      new Sprite(
        (opacity) => this.draw(opacity),
        -1, 8, easeMid, 0, easeMid)
    );

    // T1: Start tails spinning
    this.onSpinTails(0);
  }

  onSpinTails(inSecs = 0) {
    for (let i = 0; i < this.heads.length; ++i) {
      this.timeline.add(inSecs,
        new Transition(this.tails[i], 2 * Math.PI, 16, easeMid, false, true)
      );
    }
  }

  draw(opacity) {
    this.trails.decay();
    let dots = [];
    for (let i = 0; i < this.heads.length; ++i) {
      let head = ringPoint(this.heads[i], 0.4, (this.tails[i].get() + Math.PI) % (2 * Math.PI), 2 * Math.PI / i)
      let tail = ringPoint(this.heads[i], 0.4, this.tails[i].get(), 2 * Math.PI / i);
      dots.push(...drawLine(head, tail, () => new THREE.Color(0x888888)));
    }
    this.trails this.pixels, new FilterRaw(), (x, y, t) => blueToBlack.get(t));
    plotDots(this.pixels, this.labels, this.ringOutput, dots, 0, blendOverMax);
  }

  drawFrame() {
    this.pixels.clear();
    this.labels = [];
    this.timeline.step();
    return { pixels: this.pixels, labels: this.labels };
  }
}
*/
///////////////////////////////////////////////////////////////////////////////

class Test {
  constructor() {
    Daydream.W = 96;
    this.pixels = new Map();
    this.labels = [];

    // Palettes
    this.palette = new ProceduralPalette(
      [0.5, 0.5, 0.5],
      [1.0, 0.2, 0.5],
      [0.5, 0.5, 0.5],
      [0.3, 0.5, 0.0]
    );

    // Output Filters
    this.trails = new FilterDecayTrails(32);
    (this.filters = new FilterRaw())
      .chain(this.trails)
      .chain(new FilterAntiAlias())
    ;

    // State
    this.orientation = new Orientation();
    this.ring = new THREE.Vector3(1,0, 0).normalize();
    this.w = new MutableNumber(0);

    // Scene
    this.timeline = new Timeline();

    this.timeline.add(0,
      new Sprite(
        (opacity) => this.drawRing(opacity),
        -1, 8, easeMid, 0, easeMid)
    );

    this.timeline.add(0,
      new Transition(
        this.w,
        2 * Math.PI,
        320,
        easeMid,
        false,
        true
      )
    );
  }

  drawRing(opacity) {
    plotDots(this.pixels, this.labels, this.filters,
      drawFn(this.orientation, this.ring, 1,
        (t) => Math.abs(1 - t) * Math.sin(29 *t - this.w.get()),
        () => new THREE.Color(1, 1, 1))
    );
    this.orientation.collapse();
  }

  drawFrame() {
    this.pixels.clear();
    this.labels = [];

    this.trails.trail(this.pixels, new FilterRaw(),
      (x, y, t) => rainbow.get(1 - t)
    );
    this.trails.decay();
    this.timeline.step();

    return { pixels: this.pixels, labels: this.labels };
  }
}

///////////////////////////////////////////////////////////////////////////////

const daydream = new Daydream();
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));
// var effect = new PolyRot();
 var effect = new RainbowWiggles();
// var effect = new Thrusters();
// var effect = new RingCircus();
// var effect = new Wormhole();
//var effect = new Pulses();
//var effect = new Fib();
//var effect = new Angles();
//var effect = new Test();
daydream.renderer.setAnimationLoop(() => daydream.render(effect));
