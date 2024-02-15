/* TODO
- Sprite encapsulation
- Motion encapsulation
- Cartesian interfaces
- Decaying trail, mask
- State transition logic
- Lissajous interference
- Smooth matrix
- Color generation
*/

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { gui } from "gui"

class Dot {
  constructor(spherical_coords, color) {
    this.position = spherical_coords;
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

const plot_pixel = (pixels, px, py, color, blendMode = blendOverMax) => {
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
    plot_pixel(pixels, xi, yi,
      color.clone().multiplyScalar(c), blendMode);
    c = falloff(xm * (1 - ym));
    plot_pixel(pixels, (xi + 1) % Daydream.W, yi,
      color.clone().multiplyScalar(c), blendMode);
    if (yi < Daydream.H - 1) {
      c = falloff((1 - xm) * ym);
      plot_pixel(pixels, xi, yi + 1,
        color.clone().multiplyScalar(c), blendMode);
      c = falloff(xm * ym);
      plot_pixel(pixels, (xi + 1) % Daydream.W, yi + 1,
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

const drawRing = (theta, phi, radius, colorFn) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = new THREE.Vector3();
  let w = new THREE.Vector3();
  let x_axis = new THREE.Vector3(1, 0, 0);
  let z_axis = new THREE.Vector3(0, 0, 1);
  v.setFromSphericalCoords(1, phi, theta);
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
    return this.points.length();
  }

  appendLineCartesian(c1, c2, longWay = false) {
    let s1 = new THREE.Spherical().setFromCartesianCoords(c1[0], c1[1], c1[2]);
    let s2 = new THREE.Spherical().setFromCartesianCoords(c2[0], c2[1], c2[2]);
    return this.appendLine(s1.theta, s1.phi, s2.theta, s2.phi, longWay);
  }

  appendLine(theta1, phi1, theta2, phi2, longWay = false) {
    if (this.points.length > 0) {
      this.points.pop();
    }
    this.points = this.points.concat(
      drawLine(theta1, phi1, theta2, phi2, (v) => 0x000000, longWay)
        .map((d) => d.position));
    return this;
  }

  getPoint(pos) {
    let i = Math.round(pos * (this.points.length - 1));
    return this.points[i];
  }

  getPoints(pos1, pos2) {
    let i1 = Math.round(pos1 * (this.points.length - 1));
    let i2 = Math.round(pos2 * (this.points.length - 1));
    if (pos1 <= pos2) {
      return this.points.slice(i1, i2 + 1);
    }
    return this.points.slice(i1).concat(this.points.slice(0, i2));
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

const distanceGreen = (v, normal) => {
  let d = 1 - 2 * Math.pow(Math.abs(v.dot(normal)),2);
  let c1 = new THREE.Color(0x000000);
  let c2 = new THREE.Color(0x00ff00);
  return c1.clone().lerp(c2, d);
}

const lissajousCurve = (m1, m2, a, t) => {
  return new THREE.Vector3(
    Math.sin(m2 * t) * Math.cos(m1 * t - a * Math.PI),
    Math.cos(m2 * t),
    Math.sin(m2 * t) * Math.sin(m1 * t - a * Math.PI),
  );
}

class PolyRot {
  constructor() {
    this.pixels = new Map();
    this.labels = [];

    this.spinDuration = 96;
    this.axisMoveDuration = 16;
    this.genPolyDuration = 160;

    this.t = 0;
    this.axis = new THREE.Vector3(0, 1, 0).normalize();
    this.spinAxis = new THREE.Vector3(0, 1, 0);
    this.spinStart = Math.random() * Math.PI;
    this.topRotation = new THREE.Quaternion(0, 0, 0, 1);
    this.bottomRotation = new THREE.Quaternion(0, 0, 0, 1);
    this.resetPoly();
    this.resetAxis();

    this.states = {
      "genPoly": { draw: this.drawGenPoly, animate: this.animateGenPoly },
      "spinAxis": { draw: this.drawPolyRing, animate: this.animateSpinAxis },
      "spinSplitPoly": { draw: this.drawPolyRing, animate: this.animateSplitPoly },
      "spinPoly": { draw: this.drawSpinPoly, animate: this.animateSpinPoly },
    };
    this.state = "spinPoly";

    this.gui = new gui.GUI();
    this.gui.add(this, 'spinDuration').min(2).max(256).step(1);
    this.gui.add(this, 'axisMoveDuration').min(8).max(32).step(1);
    this.gui.add(this, 'genPolyDuration').min(8).max(320).step(1);
  }

  resetPoly() {
    this.poly = new Dodecahedron();
    this.angle = 0;
    this.lastAngle = 0;
  }

  resetAxis() {
    let nextAxis = this.poly.vertices[Math.floor(Math.random() * this.poly.vertices.length)];
    this.axisPath = new Path().appendLineCartesian(this.axis.toArray(), nextAxis, true);
  }

  animateGenPoly() {
    if (this.t == this.genPolyDuration + 1) {
      this.resetAxis();
      this.state = "spinAxis";
      this.t = 0;
    } else {
      let tNorm = easeInOutSin(this.t / this.genPolyDuration) * 2 * Math.PI;
      this.axis = lissajousCurve(6.55, 2.8, 0, tNorm);
    }
    this.t++;
  }

  animateSpinAxis() {
    if (this.t == this.axisMoveDuration + 1) {
      this.resetPoly();
      bisect(this.poly, this.topRotation, this.axis);
      this.state = "spinSplitPoly";
      this.t = 0;
    } else {
      let a = easeInOutSin(this.t / this.axisMoveDuration);
      this.axis.setFromSpherical(this.axisPath.getPoint(a));
      this.resetPoly();
    }
    this.t++;
  }

  animateSplitPoly() {
    if (this.t == this.spinDuration + 1) {
      this.resetPoly();
      this.spinStart = Math.random() * Math.PI;
      this.state = "spinPoly";
      this.t = 0;
    } else {
      this.lastAngle = this.angle;
      this.angle = easeInOutSin(this.t / this.spinDuration) * 4 * Math.PI;
      let r = new THREE.Quaternion()
        .setFromAxisAngle(this.axis, this.angle - this.lastAngle);
      this.topRotation.premultiply(r)
      this.bottomRotation.premultiply(r.invert());
    }
    this.t++;
  }

  animateSpinPoly() {
    if (this.t == this.spinDuration * 2 + 1) {
      this.resetAxis();
      this.resetPoly();
      this.state = "spinAxis";
      this.t = 0;
    } else {
      let tNorm = easeInOutSin(this.t / (this.spinDuration * 2));
      this.spinAxis = lissajousCurve(12.8, 2 * Math.PI, this.spinStart, tNorm);
      this.lastAngle = this.angle;
      this.angle = easeInOutSin(this.t / (this.spinDuration * 2)) * 4 * Math.PI;
      let r = new THREE.Quaternion()
        .setFromAxisAngle(this.spinAxis, this.angle - this.lastAngle);
      this.topRotation.premultiply(r)
      this.bottomRotation = this.topRotation.clone();
    }
    this.t++;
  }

  drawGenPoly() {
    this.pixels.clear();
    let vertices = this.poly.vertices;
    plotAA(this.pixels, drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => distanceGreen(v, this.axis)));
    let s = new THREE.Spherical().setFromVector3(this.axis);
    plotAA(this.pixels, drawRing(s.theta, s.phi, 1, (v) => 0xaaaaaa), blendOverMax);

    return { pixels: this.pixels, labels: this.labels };
  }

  drawPolyRing() {
    this.pixels.clear();
    this.labels = [];

    let vertices = this.poly.vertices.map((a) => {
      if (isOver(rotateCoords(a, this.topRotation), this.axis)) {
        return rotateCoords(a, this.topRotation);
      } else {
        return rotateCoords(a, this.bottomRotation);
      }
    });

    plotAA(this.pixels, drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => distanceGradient(v, this.axis)));
    let s = new THREE.Spherical().setFromVector3(this.axis);
    plotAA(this.pixels, drawRing(s.theta, s.phi, 1, (v) => 0xaaaaaa), blendOverMax);
    return { pixels: this.pixels, labels: this.labels };
  }

  drawSpinPoly() {
    this.pixels.clear();
    this.labels = [];

    let vertices = this.poly.vertices.map((a) => rotateCoords(a, this.topRotation));
    plotAA(this.pixels, drawPolyhedron(vertices, this.poly.eulerPath,
      (v) => distanceGradient(v, this.axis)));
    let s = new THREE.Spherical().setFromVector3(this.axis);
    plotAA(this.pixels, drawRing(s.theta, s.phi, 1, (v) => 0xaaaaaa), blendOverMax);
    return { pixels: this.pixels, labels: this.labels };
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
