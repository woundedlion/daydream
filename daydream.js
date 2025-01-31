/* TODO
- Gradients
- Cartesian interfaces
- Lissajous interference
- Smoothed matrix effect
- Color generation
- wiggly color separation
- wiggly dots
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

  static DOT_SIZE = 2;
  static DOT_COLOR = 0x0000ff;

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
          let p = key.split(",");
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

const g = (1 + Math.sqrt(5)) / 2;

const sphericalToPixel = (s) => {
  return {
    x: (s.theta * Daydream.W) / (2 * Math.PI),
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
  const m1 = Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 = Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
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

const blendMean = (c1, c2) => {
  return new THREE.Color(
    (c1.r + c2.r) / 2,
    (c1.g + c2.g) / 2,
    (c1.b + c2.b) / 2
  );
}

const plotPixel = (pixels, key, color, blendMode, maskFn, age) => {
  let p = { color: color, age: age };
  if (pixels.has(key)) {
    let old = pixels.get(key);
    p.color = blendMode(old.color, p.color);
  } else {
    p.color = color;
  }
  p.color.multiplyScalar(maskFn(key));
  pixels.set(key, p);
};

const falloff = (c) => {
  return c;
}

const pixelKey = (x, y) => new String(x) + "," + y;
const nullMask = (key) => 1;

const plotAA = (pixels, dots, maskFn = nullMask, age = 0, blendMode = blendOver) => {
  let buf = new Map();
  for (const dot of dots) {
    let p = sphericalToPixel(dot.position);
    let xi = Math.floor(p.x);
    let xm = p.x - xi;
    let yi = Math.floor(p.y);
    let ym = p.y - yi;
    let c = falloff((1 - xm) * (1 - ym));
    let color = new THREE.Color(dot.color);

    plotPixel(buf, pixelKey(xi, yi),
      color.clone().multiplyScalar(c), blendOverMax, maskFn, age);
    c = falloff(xm * (1 - ym));
    plotPixel(buf, pixelKey((xi + 1) % Daydream.W, yi),
      color.clone().multiplyScalar(c), blendOverMax, maskFn, age);
    if (yi < Daydream.H - 1) {
      c = falloff((1 - xm) * ym);
      plotPixel(buf, pixelKey(xi, yi + 1),
        color.clone().multiplyScalar(c), blendOverMax, maskFn, age);
      c = falloff(xm * ym);
      plotPixel(buf, pixelKey((xi + 1) % Daydream.W, yi + 1),
        color.clone().multiplyScalar(c), blendOverMax, maskFn, age);
    }
  }
  for (const [key, pixel] of buf.entries()) {
    plotPixel(pixels, key, pixel.color.clone(), blendMode, nullMask, pixel.age);
  }
};

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
    position: new THREE.Vector3().setFromSphericalCoords(Daydream.SPHERE_RADIUS, s.phi, s.theta),
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

const drawVector = (v, colorFn) => {
  return [new Dot(new THREE.Spherical().setFromVector3(v.normalize()), colorFn(v))];
}

const drawPath = (path, colorFn) => {
  let r = [];
  for (let t = 0; t < path.length(); t++) {
    r.push(new Dot(path.getPoint(t/path.length()), colorFn(t)));
  }
  return r;
}

const drawLine = (theta1, phi1, theta2, phi2, colorFn, longWay = false) => {
  let dots = []
  let u = new THREE.Vector3().setFromSphericalCoords(1, phi1, theta1);
  let v = new THREE.Vector3().setFromSphericalCoords(1, phi2, theta2);
  let a = angleBetween(u, v);
  let w = new THREE.Vector3().crossVectors(v, u);
  if (longWay) {
    a = 2 * Math.PI - a;
    w.negate();
  }
  w.normalize();
  v.crossVectors(u, w);
  v.normalize();

  const step = Daydream.DOT_SIZE / Daydream.SPHERE_RADIUS;
  for (let t = 0; t < a; t += step) {
    let vi = new THREE.Vector3(
      u.x * Math.cos(t) + v.x * Math.sin(t),
      u.y * Math.cos(t) + v.y * Math.sin(t),
      u.z * Math.cos(t) + v.z * Math.sin(t)
    );
    dots.push(new Dot(
      new THREE.Spherical().setFromVector3(vi),
      colorFn(vi)
    ));
  }
  return dots;
}

const drawVertices = (vertices, colorFn) => {
  let dots = [];
  let v = new THREE.Vector3();
  for (const vertex of vertices) {
    v.set(vertex[0], vertex[1], vertex[2]);
    dots.push(
      new Dot(
        new THREE.Spherical().setFromVector3(v.normalize()),
        colorFn(v)
      )
     );
  }
  return dots;
}

const drawPolyhedron = (vertices, edges, colorFn) => {
  let dots = [];
  edges.map((adj, i) => {
    let a = new THREE.Spherical().setFromCartesianCoords(
      vertices[i][0], vertices[i][1], vertices[i][2]);
    adj.map((j) => {
      let b = new THREE.Spherical().setFromCartesianCoords(
        vertices[j][0], vertices[j][1], vertices[j][2]);
      dots = dots.concat(
        drawLine(a.theta, a.phi, b.theta, b.phi, colorFn)
      );
    })
  });
  return dots;
}

const drawRing = (normal, radius, colorFn) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  let x_axis = new THREE.Vector3(1, 0, 0);
  let z_axis = new THREE.Vector3(0, 0, 1);
  if (radius > 1) {
    v.negate();
    radius = 2 - radius;
  }
  if (v.x == 0 && v.y == 0) {
    u.crossVectors(v, x_axis);
  } else {
    u.crossVectors(v, z_axis);
  }
  u.normalize();
  w.crossVectors(v, u);
  let d = Math.sqrt(Math.pow(1 - radius, 2));

  let step = Daydream.DOT_SIZE / Daydream.SPHERE_RADIUS;
  for (let t = 0; t < 2 * Math.PI; t += step) {
    let vi = new THREE.Vector3(
      d * v.x + radius * u.x * Math.cos(t) + radius * w.x * Math.sin(t),
      d * v.y + radius * u.y * Math.cos(t) + radius * w.y * Math.sin(t),
      d * v.z + radius * u.z * Math.cos(t) + radius * w.z * Math.sin(t)
    );
    dots.push(
      new Dot(
        new THREE.Spherical().setFromVector3(vi),
        colorFn(vi)
      )
    );
  }

  return dots;
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
      new Dot(s, colorFn(vi))
    );
  }
  return dots;
};

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
    let s1 = new THREE.Spherical().setFromCartesianCoords(c1[0], c1[1], c1[2]);
    let s2 = new THREE.Spherical().setFromCartesianCoords(c2[0], c2[1], c2[2]);
    if (this.points.length > 0) {
      this.points.pop();
    }
    this.points = this.points.concat(
      drawLine(s1.theta, s1.phi, s2.theta, s2.phi, (v) => 0x000000, longWay)
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
    return this.points[i];
  }
}

class Motion {
  static MAX_ANGLE = 2 * Math.PI / Daydream.W;

  constructor(path, duration) {
    this.path = path;
    this.duration = duration;
    this.t = 0;
    this.to = new THREE.Vector3().setFromSpherical(this.path.getPoint(0));
  }

  done() {
    return this.t >= this.duration;
  }

  move(orientation) {
    this.from = this.to;
    this.to = new THREE.Vector3().setFromSpherical(
      this.path.getPoint(this.t / this.duration));
    if (!this.from.equals(this.to)) {
      let axis = new THREE.Vector3().crossVectors(this.from, this.to).normalize();
      let angle = angleBetween(this.from, this.to);
      let origin = orientation.get();
      orientation.clear();
      for (let a = Motion.MAX_ANGLE; angle - a > 0.0001; a += Motion.MAX_ANGLE) {
        let r = new THREE.Quaternion().setFromAxisAngle(axis, a);
        orientation.push(origin.clone().premultiply(r));
      }
      let r = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      orientation.push(origin.clone().premultiply(r));
    }
    this.t++
  }
}

class FadeIn {
  constructor(duration) {
    this.duration = duration;
    this.t = 0;
  }

  done() {
    return this.t >= this.duration;
  }

  fade(pixels) {
    this.pixels.forEach((pixel, key) => {
      console.log(key);
    });
    this.t++;
  }

}

class Rotation {
  static MAX_ANGLE = 2 * Math.PI / Daydream.W;

  constructor(axis, angle, duration) {
    this.axis = axis;
    this.totalAngle = angle;
    this.duration = duration;
    this.t = 0;
  }

  done() {
    return this.t >= this.duration;
  }

  rotate(orientation, easingFn = easeInOutSin) {
    this.from = this.to;
    this.to = easingFn(this.t / this.duration) * this.totalAngle;
    if (Math.abs(this.to - this.from) > 0.0001) {
      let angle = Math.abs(this.to - this.from);
      let origin = orientation.get();
      orientation.clear();
      for (let a = Rotation.MAX_ANGLE; angle - a > 0.0001; a += Rotation.MAX_ANGLE) {
        let r = new THREE.Quaternion().setFromAxisAngle(this.axis, a);
        orientation.push(origin.clone().premultiply(r));
      }
      let r = new THREE.Quaternion().setFromAxisAngle(this.axis,angle);
      orientation.push(origin.clone().premultiply(r));
    }
    this.t++;
  }
}

const isOver = (v, normal) => {
  return normal.dot(v) >= 0;
}

const intersectsPlane = (v1, v2, normal) => {
  return (isOver(v1, normal) && !isOver(v2, normal))
    || (!isOver(v1, normal) && isOver(v2, normal));
}

const angleBetween = (v1, v2) => Math.acos(Math.min(1, v1.dot(v2)));

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

const easeInOutBicubic = (t) => {
  return t < 0.5 ? 4 * Math.pow(t, 3) : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

const easeInOutSin = (t) => {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

const easeInSin = (t) => {
  return 1 - Math.cos((t * Math.PI) / 2);
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



const distanceGradient = (v, normal) => {
  let d = v.dot(normal);
  if (d > 0) {
    return g1.get(d);
  } else {
    return g2.get(-d);
  }
}

const lissajous = (m1, m2, a, t) => {
  return new THREE.Vector3(
    Math.sin(m2 * t) * Math.cos(m1 * t - a * Math.PI),
    Math.cos(m2 * t),
    Math.sin(m2 * t) * Math.sin(m1 * t - a * Math.PI),
  );
}

const plotDots = (filter, dots, age = 0) => {
  let pixels = new Map();
  for (const dot of dots) {
    let p = sphericalToPixel(dot.position);
    filter.plot(pixels, p.x, p.y, dot.color, age, blendOverMax);
  }
  return pixels;
}
class Filter {
  chain(nextFilter) {
    this.next = nextFilter;
    return nextFilter;
  }

  pass(pixels, x, y, color, age, blendFn) {
    if (this.next === undefined) {
      let old = pixels[pixelKey(x, y)];
      pixels.set(pixelKey(x, y), old === undefined ? color : blendFn(old, color));
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

class FilterAntiAlias extends Filter {
  plot(pixels, x, y, color, age, blendFn) {
    let xi = Math.trunc(x);
    let xm = x - xi;
    let yi = Math.trunc(y);
    let ym = y - yi;

    let c = falloff((1 - xm) * (1 - ym));
    this.pass(pixels, xi, yi,
      color.clone().multiplyScalar(c), age, blendFn);
    if (xm > 0.0001) {
      c = falloff(xm * (1 - ym));
      this.pass(pixels, (xi + 1) % Daydream.W, yi,
        color.clone().multiplyScalar(c), age, blendFn);
    }
    if (yi < Daydream.H - 1) {
      if (ym > 0.0001) {
        c = falloff((1 - xm) * ym);
        this.pass(pixels, xi, yi + 1,
          color.clone().multiplyScalar(c), age, blendFn);
        if (xm > 0.0001) {
          c = falloff(xm * ym);
          this.pass(pixels, (xi + 1) % Daydream.W, yi + 1,
            color.clone().multiplyScalar(c), age, blendFn);
        }
      }
    }
  }
}

class FilterDecayMask extends Filter {

}

class FilterDecayTrails extends Filter {
  constructor(lifespan, gradient) {
    super();
    this.lifespan = lifespan;
    this.gradient = gradient;
    this.ttls = new Map();
    this.trailPixels = new Map();
  }

  plot(pixels, x, y, color, age, blendFn) {
    let key = pixelKey(x, y);
    this.ttls.set(key, Math.max(0, this.lifespan - age));
    if (age > 0) {
      color = this.gradient.get(1 - (this.lifespan - age) / this.lifespan);
    }
    this.trailPixels.set(key, color);
    for (const [key, color] of this.trailPixels) {
      pixels.set(key, color);
    }
    this.pass(pixels, x, y, color, age, blendFn);
  }

  decay() {
    this.ttls.forEach((ttl, key) => {
      ttl -= 1;
      if (ttl < 0.00001) {
        this.ttls.delete(key);
        this.trailPixels.delete(key);
      } else {
        this.ttls.set(key, ttl);
        this.trailPixels.set(key, this.gradient.get(1 - ttl / this.lifespan));
      }
    });
  }
}

class DecayTrails {
  constructor(ttl, pixels, gradient) {
    this.ttl = ttl;
    this.pixels = pixels;
    this.gradient = gradient;
    this.mask = new Map();
    this.label = false;
  }

  clear() {
    this.mask = new Map();
  }

  has(key) {
    return this.mask.has(key);  
  }

  get(key) {
    return this.pixels.get(key);
  }

  set(key, value) {
    this.mask.set(key, this.ttl - value.age);
    if (value.age > 0) {
      value.color = this.gradient.get(1 - ((this.ttl - value.age) / this.ttl));
    }
    this.pixels.set(key, value);
  }

  decay() {
    this.mask.forEach((ttl, key) => {
      ttl -= 1;
      if (ttl < 0.0001) {
        this.mask.delete(key);
        this.pixels.delete(key);
      } else {
        this.mask.set(key, ttl);
        this.pixels.get(key).color = this.gradient.get((this.ttl - ttl) / this.ttl);
        if (this.label) {
          let xy = key.split(',');
          let s = pixelToSpherical(xy[0], xy[1]);
          s.radius = Daydream.SPHERE_RADIUS;
          daydream.makeLabel(new THREE.Vector3().setFromSpherical(s),
            `${ttl.toFixed(1)}`);
        }
      }

      if (this.label) {
        let xy = key.split(',');
        let s = pixelToSpherical(xy[0], xy[1]);
        s.radius = Daydream.SPHERE_RADIUS;
        daydream.makeLabel(new THREE.Vector3().setFromSpherical(s),
          `${ttl}`);
      }

    });

  }
}

class DecayMask {
  constructor(ttl) {
    this.ttl = ttl;
    this.mask = new Map();
    this.label = false;
  }

  has(key) {
    return this.mask.has(key);
  }

  get(key) {
    return { color: 0x000000 };
  }

  getMask(key) {
    if (this.mask.has(key)) {
      return Math.pow(this.mask.get(key) / this.ttl, 1);
    }
    return 0;
  }

  set(key, value) {
    this.mask.set(key, this.ttl - value.age);
  }

  decay() {
    this.mask.forEach((ttl, key, map) => {
      ttl -= 1;
      if (ttl < 0.0001) {
        this.mask.delete(key);
      } else {
        this.mask.set(key, ttl);
        if (this.label) {
          let xy = key.split(',');
          let s = pixelToSpherical(xy[0], xy[1]);
          s.radius = Daydream.SPHERE_RADIUS;
          daydream.makeLabel(new THREE.Vector3().setFromSpherical(s),
            `${ttl.toFixed(2)}`);
        }
      }
    });
  }
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
    return this.colors[Math.floor(a * this.colors.length)];
  }
};

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


let amber = new Gradient(256, [
  [0, 0xff0000],
  [1, 0xff0000]
]);

let grayToBlack = new Gradient(256, [
  [0, 0x444444],
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

class PolyRot {
  constructor() {
    this.pixels = new Map();
    this.labels = [];
    this.polyMask = new DecayMask(4, this.pixels);
    this.ringTrail = new DecayTrails(3, this.pixels, g3);

    this.ring = new THREE.Vector3(0, 1, 0).normalize();
    this.ringOrientation = new Orientation();

    this.spinAxis = new THREE.Vector3(0, 1, 0);
    this.spinAxisOrientation = new Orientation();

    this.topOrientation = new Orientation();
    this.bottomOrientation = new Orientation;

    this.genPolyDuration = 160;
    this.trailRingDuration = 160;
    this.splitPolyDuration = 96;
    this.spinRingDuration = 16;
    this.spinPolyDuration = 192;

    this.states = {
      "genPoly": {
        enter: this.enterGenPoly,
        draw: this.drawGenPoly,
        animate: this.animateGenPoly,
        exit: () => { },
      },
      "trailRing": {
        enter: this.enterTrailRing,
        draw: this.drawTrailRing,
        animate: this.animateTrailRing,
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
    this.gui.add(this, 'trailRingDuration').min(8).max(320).step(1);
    this.gui.add(this, 'splitPolyDuration').min(8).max(256).step(1);
    this.gui.add(this, 'spinRingDuration').min(8).max(32).step(1);
    this.gui.add(this, 'spinPolyDuration').min(8).max(256).step(1);
    this.gui.add(this.polyMask, 'ttl').min(1).max(20).step(1);
    this.gui.add(this.polyMask, 'label');
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
      (t) => new THREE.Spherical().setFromVector3(
        this.ringOrientation.orient(lissajous(10, 0.5, 0, t))),
      2 * Math.PI,
      this.genPolyDuration,
      easeInOutSin
    );
    this.genPolyMotion = new Motion(this.genPolyPath, this.genPolyDuration);
  }

  drawGenPoly() {
    this.labels = [];
    this.pixels.clear();
    this.polyMask.decay();
    let vertices = this.topOrientation.orientPoly(this.poly.vertices);

    let n = this.ringOrientation.length();
    for (let i = 0; i < n; i++) {
      let normal = this.ringOrientation.orient(this.ring, i);
      plotAA(this.polyMask, drawRing(normal, 1, (v) => 0x000000),
        (k) => 1,
        n == 1 ? 0 : (n - 1 - i) * (1 / (n - 1))
      );
    }

    plotAA(this.pixels, drawPolyhedron(
      vertices,
      this.poly.eulerPath,
      (v) => distanceGradient(v, this.ringOrientation.orient(this.ring))),
      (key) => this.polyMask.getMask(key)
    );
    
    this.ringOrientation.collapse();
    let normal = this.ringOrientation.orient(this.ring);
    plotAA(this.pixels, drawRing(normal, 1, (v) => 0xaaaaaa));

    return { pixels: this.pixels, labels: this.labels };
  }

  animateGenPoly() {
    if (this.genPolyMotion.done()) {
      this.transition();
     } else {
      this.genPolyMotion.move(this.ringOrientation);
    }
  }

  enterTrailRing() {
    this.poly = new Dodecahedron();
    this.ringTrail.clear();
    this.trailRingPath = new Path().appendSegment(
      (t) => new THREE.Spherical().setFromVector3(
        this.ringOrientation.orient(lissajous(10, 0.5, 0, t))),
      2 * Math.PI,
      this.genPolyDuration,
      easeInOutSin
      )
      this.trailRingMotion = new Motion(this.trailRingPath, this.trailRingDuration);
  }

  drawTrailRing() {
    this.labels = [];
    this.ringTrail.decay();
    let n = this.ringOrientation.length();
    for (let i = 0; i < n; i++) {
      let normal = this.ringOrientation.orient(this.ring, i);
      plotAA(this.ringTrail, drawRing(normal, 1, (v) => 0xffffff), (k) => 1,
        n == 1 ? 0 : (n - 1 - i) * (1 / (n - 1)), blendOver);
    }
    this.ringOrientation.collapse();
    let normal = this.ringOrientation.orient(this.ring);

//    plotAA(this.ringTrail, drawVector(normal, (p) => 0xff0000));

    return { pixels: this.pixels, labels: this.labels };
  }

  animateTrailRing() {
    if (this.trailRingMotion.done()) {
      this.transition();
//      this.transitionTo("trailRing");
    } else {
      this.trailRingMotion.move(this.ringOrientation);
    }
  }


  enterSpinRing() {
    this.poly = new Dodecahedron();
    let from = this.ringOrientation.orient(this.ring).clone();
    let toNormal = this.poly.vertices[3/*Math.floor(Math.random() * this.poly.vertices.length)*/];
    this.ringPath = new Path().appendLine(from.toArray(), toNormal, true);
    this.ringMotion = new Motion(this.ringPath, this.spinRingDuration);
  }

  animateSpinRing() {
    if (this.ringMotion.done()) {
      this.transition();
    } else {
      this.ringMotion.move(this.ringOrientation);
//      this.poly = new Dodecahedron();
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
    plotAA(this.pixels, drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => distanceGradient(v, normal)));
    plotAA(this.pixels, drawRing(normal, 1, (v) => 0xaaaaaa));
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
      (t) => new THREE.Spherical().setFromVector3(
        lissajous(12.8, 2 * Math.PI, 0, t)),
      1,
      this.spinPolyDuration
    );
    this.spinAxisMotion = new Motion(this.spinAxisPath, this.spinPolyDuration);
  }

  drawPolyRing() {
    this.pixels.clear();
    let normal = this.ringOrientation.orient(this.ring);
    let vertices = this.topOrientation.orientPoly(this.poly.vertices);
    plotAA(this.pixels, drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => distanceGradient(v, normal)));
    plotAA(this.pixels, drawRing(normal, 1, (v) => 0xaaaaaa));
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

class TestEffect {
  constructor() {
    this.pixels = new Map();
  }
  drawFrame() {
    this.pixels.clear();
    plotAA(this.pixels,
      drawLine(-Math.PI / 4, 3 * Math.PI / 4, Math.PI / 4, Math.PI / 4, (v) => 0xff0000));
    return { pixels: this.pixels, labels: [] };
  }
}


class Ring {
  constructor(y) {
    this.x = 0;
    this.y = y;
    this.v = 0;
  }
}
class LicentiousZensius {
  constructor() {
    Daydream.W = 95;
    this.pixels = new Map();
    this.labels = [];
    this.rings = [];
    for (let i = 0; i < Daydream.H; ++i) {
      this.rings.push(new Ring(i));
    }
    this.palette = amber;
    this.speed = 2;
    this.gap = 3;
    this.wipe = 0;
    this.sparseness = 96 / 6;
    this.filters = new FilterDecayTrails(5, grayToBlack);
//    this.filters = new FilterRaw();

    // Random interavals
    (function randomTimer(min, max) {
      setTimeout(
        () => {
//         this.changeGap();
          this.changeSpeed();
          this.reverse();
          randomTimer.bind(this)(min, max);
        },
        Math.round(Math.random() * (max - min) + min )
      );
    }.bind(this)(250, 16 * 125));
  }

  changeSpeed() {
    this.speed = this.dir(this.speed) * Math.round(Math.random() * 1 + 1);
  }

  reverse() {
    this.speed *= -1;
  }

  changeGap() {
    this.gap = Math.round(Math.random() * 1 + 1);
  }

  distance(a, b) {
    let fwd = wrap((b - a), Daydream.W);
    let rev = wrap((a - b), Daydream.W);
    if (fwd <= rev) {
      return fwd;
    }
    return -rev;
  }

  dir(v) { return v < 0 ? -1 : 1; }

  drawFrame() {
    this.filters.decay();
    this.pixels.clear();
//    this.wipe = wrap(this.wipe + 1, Daydream.W);
    this.pull(0, this.speed);
    this.drawRings();
    return { pixels: this.pixels, labels: this.labels };
  }

  drawRing(ring, age) {
    for (let x = 0; x < Daydream.W; x++) {
      let p = wrap(x + this.wipe, Daydream.W);
      let color = this.palette.get(p / Daydream.W);
      if (p % this.sparseness == 0) {
        this.filters.plot(this.pixels,
          wrap(x + ring.x, Daydream.W),
          ring.y,
          color,
          age,
          blendOverMax);
      }
    }
  }

  drawRings() {
    for (let ring of this.rings) {
      this.drawRing(ring, 0);
    }
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
/*    if (leader.v * follower.v < 0) {
      // reverse direction
      follower.v = leader.v;
    }
    this.move(follower);
    */
    let dest = wrap(follower.x + follower.v, Daydream.W);
    if (Math.abs(this.distance(dest, leader.x, Daydream.W)) > this.gap) {
      // Move to furthest extent based on leader's prior path
      dest = wrap(leader.x - this.dir(leader.v) * (Math.abs(leader.v) - 1 + this.gap), Daydream.W);
      follower.v = this.distance(follower.x, dest, Daydream.W);
      this.move(follower);
      // Move to gap's length behind leader
      dest = wrap((leader.x - this.dir(leader.v) * this.gap), Daydream.W);
      follower.v = this.distance(follower.x, dest, Daydream.W);
      this.move(follower);
      // Adjust speed to match leader
      follower.v = leader.v;
    } else {
      this.move(follower);
    }
  }

  move(ring) {
    let dest = wrap(ring.x + ring.v, Daydream.W);
    let i = ring.x;
    while (i != dest) {
      this.drawRing(ring, 1);
      i = wrap(i + this.dir(ring.v), Daydream.W);
      ring.x = i;
    }
    ring.x = dest;
  }
}

class Drop {
  constructor() {
    this.v = new THREE.Vector3(0, 1, 0);
    this.orientation = new Orientation();
    let axis = new THREE.Vector3().setFromSphericalCoords(1, Math.PI / 2, Math.floor(Daydream.W * Math.random()) * 2 * Math.PI / Daydream.W);
    
    let minDur = 8;
    let maxDur = 64;
    let duration = Math.floor(Math.random() * (maxDur - minDur) + minDur);
    this.rotation = new Rotation(axis, Math.PI, duration);
  }
};

class TheMatrix {
  constructor() {
    this.pixels = new Map();
    this.labels = [];
    this.drops = [];
    this.filters = new FilterAntiAlias();
    this.trails = new FilterDecayTrails(5, blueToBlack);
    this.filters.chain(this.trails);
    Daydream.W = 40;
  }

  drawFrame() {
    this.pixels.clear();
    this.trails.decay();
    this.spawnDrops();
    this.paintDrops();
    this.moveDrops();
    return { pixels: this.pixels, labels: this.labels };
  }

  spawnDrops() {
    let p = 1 / 16;
    if (Math.random() * 1 < p) { 
      this.drops.push(new Drop());
    }
  }

  moveDrops() {
    this.drops = this.drops.filter((d) => {
      d.rotation.rotate(d.orientation, easeInSin);
      return !d.rotation.done();
    });
  }

  paintDrops() {  
    let dots = [];
    this.drops.forEach((d) => {
      dots.push(...drawVector(d.orientation.orient(d.v),
        (v) => { return new THREE.Color(0x0000ff) }));
    });
    this.pixels = plotDots(this.filters, dots);
  }

}

const daydream = new Daydream();
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));
// var effect = new PolyRot();
// var effect = new TheMatrix();
var effect = new LicentiousZensius();
daydream.renderer.setAnimationLoop(() => daydream.render(effect));
