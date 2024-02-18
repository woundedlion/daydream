/* TODO
- Sprite encapsulation
- Cartesian interfaces
- Decaying trail, mask
- Lissajous interference
- Smoothed matrix effect
- Color generation
*/

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { gui } from "gui"

class Dot {
  constructor(sphericalCoords, color) {
    this.position = sphericalCoords;
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

  static DOT_SIZE = 2;
  static DOT_COLOR = 0x0000ff;

  constructor() {
    console.log("INIT");
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
          dotMesh.setColorAt(i, pixel.color);
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

const blendOverMax = (c1, c2) => {
  const m1 = Math.sqrt(Math.pow(c1.r, 2) + Math.pow(c1.g, 2) + Math.pow(c1.b, 2));
  const m2 = Math.sqrt(Math.pow(c2.r, 2) + Math.pow(c2.g, 2) + Math.pow(c2.b, 2));
  const s = Math.max(m1, m2) / m2;
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

const plotPixel = (pixels, px, py, color, blendMode = blendOverMax) => {
  if (color.r == 0 && color.g == 0 && color.b == 0) { return; }
  const key = new String(px) + "," + py;
  let p = { color: color };
  if (pixels.has(key)) {
    let old = pixels.get(key);
    old.color = blendMode(old.color, p.color);
  } else {
    pixels.set(key, p);
  }
};

const falloff = (c) => {
  return c;
}

const plotAA = (pixels, dots, blendMode = blendOverMax) => {
  for (const dot of dots) {
    let p = sphericalToPixel(dot.position);
    let xi = Math.floor(p.x);
    let xm = p.x - xi;
    let yi = Math.floor(p.y);
    let ym = p.y - yi;

    let c = falloff((1 - xm) * (1 - ym));
    let color = new THREE.Color(dot.color);
    plotPixel(pixels, xi, yi,
      color.clone().multiplyScalar(c), blendMode);
    c = falloff(xm * (1 - ym));
    plotPixel(pixels, (xi + 1) % Daydream.W, yi,
      color.clone().multiplyScalar(c), blendMode);
    if (yi < Daydream.H - 1) {
      c = falloff((1 - xm) * ym);
      plotPixel(pixels, xi, yi + 1,
        color.clone().multiplyScalar(c), blendMode);
      c = falloff(xm * ym);
      plotPixel(pixels, (xi + 1) % Daydream.W, yi + 1,
        color.clone().multiplyScalar(c), blendMode);
    }
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

class Path {
  constructor() {
    this.points = [];
  }

  length() {
    return this.points.length;
  }

  appendLine(c1, c2, longWay = false) {
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

  appendSegment(plotFn, domain, samples) {
    if (this.points.length > 0) {
      this.points.pop();
    }
    for (let t = 0; t < samples; t++) {
      this.points.push(plotFn(easeInOutSin(t / samples) * domain));
    }
    return this;
  }

  getPoint(t) {
    let i = Math.floor(t * (this.points.length));
    return this.points[i];
  }
}

class Motion {
  constructor(path, duration) {
    this.path = path;
    this.duration = duration;
    this.t = 0;
    this.to = new THREE.Vector3().setFromSpherical(this.path.getPoint(0));
  }

  done() {
    return this.t >= this.duration;
  }

  move(q) {
    this.from = this.to;
    this.to = new THREE.Vector3().setFromSpherical(
      this.path.getPoint(this.t / this.duration));
    if (!this.from.equals(this.to)) {
      let axis = new THREE.Vector3().crossVectors(this.from, this.to).normalize();
      let angle = angleBetween(this.from, this.to);
      let r = new THREE.Quaternion().setFromAxisAngle(axis, angle);
      q.premultiply(r);
    }
    this.t++
  }
}

class Rotation {
  constructor(axis, angle, duration) {
    this.axis = axis;
    this.angle = 0;
    this.lastAngle = 0;
    this.totalAngle = angle;
    this.duration = duration;
    this.t = 0;
  }

  done() {
    return this.t >= this.duration;
  }

  rotate(q) {
    this.lastAngle = this.angle;
    this.angle = easeInOutSin(this.t / this.duration) * this.totalAngle;
    let r = new THREE.Quaternion()
      .setFromAxisAngle(this.axis, this.angle - this.lastAngle);
    q.premultiply(r);
    this.t++;
  }
}

const rotateCoords = (c, rotation) => {
return new THREE.Vector3()
    .fromArray(c)
    .applyQuaternion(rotation)
    .toArray();
}

const isOver = (c, normal) => {
  return normal.dot(new THREE.Vector3().fromArray(c)) >= 0;
}

const intersectsPlane = (c1, c2, normal) => {
  return (isOver(c1, normal) && !isOver(c2, normal))
    || (!isOver(c1, normal) && isOver(c2, normal));
}

const angleBetween = (v1, v2) => Math.acos(Math.min(1, v1.dot(v2)));

const intersection = (c1, c2, normal) => {
  let u = new THREE.Vector3().fromArray(c1).normalize();
  let v = new THREE.Vector3().fromArray(c2).normalize();
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
      .normalize()
      .toArray(),
    new THREE.Vector3().copy(c)
      .addScaledVector(new THREE.Vector3().copy(normal).negate(), shift)
      .normalize()
      .toArray(),
  ];
}

const bisect = (poly, rotation, normal) => {
  let v = poly.vertices;
  let e = poly.eulerPath;
  e.map((neighbors, ai) => {
    e[ai] = neighbors.reduce((result, bi) => {
      let a = rotateCoords(v[ai], rotation);
      let b = rotateCoords(v[bi], rotation);
      if (intersectsPlane(a, b, normal)) {
        let points = splitPoint(intersection(a, b, normal), normal);
        let unrotation = rotation.clone().invert();
        v.push(rotateCoords(points[0], unrotation));
        v.push(rotateCoords(points[1], unrotation));
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

const distanceGradient = (v, normal) => {
  let d = v.dot(normal);
  if (d > 0) {
    let c1 = new THREE.Color(0xffaa00);
    let c2 = new THREE.Color(0xff0000);
    return c1.clone().lerpHSL(c2, d);
  } else {
    let c1 = new THREE.Color(0x0000ff);
    let c2 = new THREE.Color(0x660099);
    return c1.clone().lerpHSL(c2, -d);
  }
}

const applyMask = (mask, v) => {
  let d = mask.getValue(v);
  let c1 = new THREE.Color(0x000000);
  let c2 = new THREE.Color(0x00ff00);
  return c1.clone().lerp(c2, d);
}

const lissajous = (m1, m2, a, t) => {
  return new THREE.Vector3(
    Math.sin(m2 * t) * Math.cos(m1 * t - a * Math.PI),
    Math.cos(m2 * t),
    Math.sin(m2 * t) * Math.sin(m1 * t - a * Math.PI),
  );
}

class DecayMask {
  constructor(ttl) {
    this.ttl = ttl;
    this.mask = new Map();
  }

  getValue(v) {
//    const key = new String(px) + "," + py;
    return 0;
  }
  b
}

class PolyRot {
  constructor() {
    this.pixels = new Map();
    this.labels = [];

    this.splitPolyDuration = 96;
    this.spinRingDuration = 16;
    this.genPolyDuration = 160;
    this.spinPolyDuration = 192;

    this.ring = new THREE.Vector3(0, 1, 0).normalize();
    this.ringPosition = new THREE.Quaternion(0, 0, 0, 1);

    this.spinAxis = new THREE.Vector3(0, 1, 0);
    this.spinAxisPosition = new THREE.Quaternion(0, 0, 0, 1);

    this.topPosition = new THREE.Quaternion(0, 0, 0, 1);
    this.bottomPosition = new THREE.Quaternion(0, 0, 0, 1);

    this.states = {
      "genPoly": {
        enter: this.enterGenPoly,
        draw: this.drawGenPoly,
        animate: this.animateGenPoly,
        exit: () => { },
      },
      "spinRing": {
        enter: this.enterSpinRing,
        draw: this.drawSpinPoly,
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
        draw: this.drawSpinPoly,
        animate: this.animateSpinPoly,
        exit: () => { },
      },
    };
    this.transitionTo("genPoly");

    this.gui = new gui.GUI();
    this.gui.add(this, 'genPolyDuration').min(8).max(320).step(1);
    this.gui.add(this, 'splitPolyDuration').min(8).max(256).step(1);
    this.gui.add(this, 'spinRingDuration').min(8).max(32).step(1);
    this.gui.add(this, 'spinPolyDuration').min(8).max(256).step(1);
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
    this.polyMask = new DecayMask(4);
    this.genPolyPath = new Path().appendSegment(
      (t) => new THREE.Spherical().setFromVector3(
        lissajous(6.55, 2.8, 1, t)),
      Math.PI,
      this.genPolyDuration);
    this.genPolyMotion = new Motion(this.genPolyPath, this.genPolyDuration);
  }

  drawGenPoly() {
    this.pixels.clear();
    let vertices = this.poly.vertices.map((a) => rotateCoords(a, this.topPosition));
    plotAA(this.pixels, drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => applyMask(this.polyMask, v)));
    let normal = this.ring.clone().applyQuaternion(this.ringPosition);
    plotAA(this.pixels, drawRing(normal, 1, (v) => 0xaaaaaa), blendOverMax);
    plotAA(this.pixels, drawVector(normal, (v) => 0xff0000), blendOverMax);
    return { pixels: this.pixels, labels: this.labels };
  }

  animateGenPoly() {
    if (this.genPolyMotion.done()) {
      this.transitionTo("spinRing");
    } else {
      this.genPolyMotion.move(this.ringPosition);
    }
    this.t++;
  }

  enterSpinRing() {
    this.poly = new Dodecahedron();
    let from = this.ring.clone().applyQuaternion(this.ringPosition);
    let toNormal = this.poly.vertices[Math.floor(Math.random() * this.poly.vertices.length)];
    this.ringPath = new Path().appendLine(from.toArray(), toNormal, true);
    this.ringMotion = new Motion(this.ringPath, this.spinRingDuration);
  }

  animateSpinRing() {
    if (this.ringMotion.done()) {
      this.transitionTo("splitPoly");
    } else {
      this.ringMotion.move(this.ringPosition);
      this.poly = new Dodecahedron();
    }
  }

  enterSplitPoly() {
    this.poly = new Dodecahedron();
    let normal = this.ring.clone().applyQuaternion(this.ringPosition);
    bisect(this.poly, this.topPosition, normal);
    this.bottomPosition = this.topPosition.clone();
    this.polyRotationFwd = new Rotation(
     normal, 4 * Math.PI, this.splitPolyDuration);
    this.polyRotationRev = new Rotation(
      normal.clone().negate(), 4 * Math.PI, this.splitPolyDuration);
  }

  drawSplitPoly() {
    this.pixels.clear();
    this.labels = [];
    let normal = this.ring.clone().applyQuaternion(this.ringPosition);

    let vertices = this.poly.vertices.map((a) => {
      if (isOver(rotateCoords(a, this.topPosition), normal)) {
        return rotateCoords(a, this.topPosition);
      } else {
        return rotateCoords(a, this.bottomPosition);
      }
    });

    plotAA(this.pixels, drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => distanceGradient(v, normal)));
    plotAA(this.pixels, drawRing(normal, 1, (v) => 0xaaaaaa), blendOverMax);
    return { pixels: this.pixels, labels: this.labels };
  }

  animateSplitPoly() {
    if (this.polyRotationFwd.done()) {
      this.transitionTo("spinPoly");
    } else {
      this.polyRotationFwd.rotate(this.topPosition);
      this.polyRotationRev.rotate(this.bottomPosition);
    }
    this.t++;
  }

  enterSpinPoly() {
    this.poly = new Dodecahedron();
    let axis = this.spinAxis.clone().applyQuaternion(this.spinAxisPosition);
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

  drawSpinPoly() {
    this.pixels.clear();
    this.labels = [];
    let normal = this.ring.clone().applyQuaternion(this.ringPosition);
    let vertices = this.poly.vertices.map((a) => rotateCoords(a, this.topPosition));
    plotAA(this.pixels, drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => distanceGradient(v, normal)));
    plotAA(this.pixels, drawRing(normal, 1, (v) => 0xaaaaaa), blendOverMax);
//    let axis = this.spinAxis.clone().applyQuaternion(this.spinAxisPosition);
//    plotAA(this.pixels, drawVector(axis, (v) => 0x00ff00), blendOverMax);
    return { pixels: this.pixels, labels: this.labels };
  }

  animateSpinPoly() {
    if (this.spinPolyRotation.done()) {
      this.transitionTo("genPoly");
    } else {
      this.spinAxisMotion.move(this.spinAxisPosition);
      this.spinPolyRotation.axis =
        this.spinAxis.clone().applyQuaternion(this.spinAxisPosition);
      this.spinPolyRotation.rotate(this.topPosition);
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
class TheMatrix {
  constructor() {
    this.drops = [];
    this.pixels = [];
  }
  drawFrame() {
    return { pixels: this.pixels, labels: labels };
  }
}

const daydream = new Daydream();
window.addEventListener("resize", () => daydream.setCanvasSize());
window.addEventListener("keydown", (e) => daydream.keydown(e));
var effect = new PolyRot();
//var effect = new TestEffect();
daydream.renderer.setAnimationLoop(() => daydream.render(effect));
