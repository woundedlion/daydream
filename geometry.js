// geometry.js
import * as THREE from "three";
import { wrap } from "./util.js";
import { Daydream } from "./driver.js";
import { Rotation, easeOutCirc } from "./animation.js";
import { g1, g2 } from "./color.js";

export const PHI = (1 + Math.sqrt(5)) / 2;
export const G = 1 / PHI;

export class Dot {
  constructor(position, color) {
    this.position = position;
    this.color = color;
  }
}

export const sphericalToPixel = (s) => {
  return {
    x: wrap((s.theta * Daydream.W) / (2 * Math.PI), Daydream.W),
    y: (s.phi * (Daydream.H - 1)) / Math.PI,
  };
};

export const pixelToSpherical = (x, y) => {
  return new THREE.Spherical(
    1,
    (y * Math.PI) / (Daydream.H - 1),
    (x * 2 * Math.PI) / Daydream.W
  );
};

export const vectorToPixel = (v) => {
  let s = new THREE.Spherical().setFromVector3(v);
  return {
    x: wrap((s.theta * Daydream.W) / (2 * Math.PI), Daydream.W),
    y: (s.phi * (Daydream.H - 1)) / Math.PI,
  };
};

export const pixelToVector = (x, y) => {
  let s = new THREE.Spherical(
    1,
    (y * Math.PI) / (Daydream.H - 1),
    (x * 2 * Math.PI) / Daydream.W
  );
  return new THREE.Vector3().setFromSpherical(s);
};

export class TestPoly {
  vertices = [
    [1, 1, 1], // 0
    [1, -1, 1]  // 1
  ];
  eulerPath = [
    [1],
    []
  ]
}

export class Cube {
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

export class Dodecahedron {
  vertices = [
    [1, 1, 1],       // 0
    [1, 1, -1],      // 1
    [1, -1, 1],      // 2
    [1, -1, -1],     // 3
    [-1, 1, 1],      // 4
    [-1, 1, -1],     // 5
    [-1, -1, 1],     // 6
    [-1, -1, -1],    // 7

    [0, 1 / PHI, PHI],   //8
    [0, 1 / PHI, -PHI],  // 9
    [0, -1 / PHI, PHI],  // 10
    [0, -1 / PHI, -PHI], // 11

    [1 / PHI, PHI, 0],   // 12
    [1 / PHI, -PHI, 0],  // 13
    [-1 / PHI, PHI, 0],  // 14
    [-1 / PHI, -PHI, 0], // 15

    [PHI, 0, 1 / PHI],   // 16
    [PHI, 0, -1 / PHI],  // 17
    [-PHI, 0, 1 / PHI],  // 18
    [-PHI, 0, -1 / PHI], // 19
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

export const randomVector = () => {
  return new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1).normalize();
}

export class Orientation {
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

export const fibSpiral = (n, eps, i) => {
  return new THREE.Vector3().setFromSpherical(new THREE.Spherical(
    1,
    Math.acos(1 - (2 * (i + eps)) / n),
    (2 * Math.PI * i * g) % (2 * Math.PI)
  ));
}

export function sinWave(from, to, freq, phase) {
  return (t) => {
    let w = (Math.sin(freq * t * 2 * Math.PI - Math.PI / 2 + Math.PI - 2 * phase) + 1) / 2;
    return w * (to - from) + from;
  };
}

export function lerp(from, to, t) {
  return (to - from) * t + from;
}

export function triWave(from, to, freq, phase) {
  return (t) => {
    if (t < 0.5) {
      var w = 2 * t;
    } else {
      w = 2 - 2 * t;
    }
    return w * (to - from) + from;
  };
}

export function squareWave(from, to, freq, dutyCycle, phase) {
  return (t) => {
    if ((t * freq + phase) % 1 < dutyCycle) {
      return to;
    }
    return from;
  };
}

export function distanceGradient(v, normal) {
  let d = v.dot(normal);
  if (d > 0) {
    return g1.get(d).clone();
  } else {
    return g2.get(-d).clone();
  }
}

export function lissajous(m1, m2, a, t) {
  return new THREE.Vector3(
    Math.sin(m2 * t) * Math.cos(m1 * t - a * Math.PI),
    Math.cos(m2 * t),
    Math.sin(m2 * t) * Math.sin(m1 * t - a * Math.PI),
  );
}

export function rotateBetween(from, to) {
  let diff = from.get().clone().conjugate().premultiply(to.get());
  let angle = 2 * Math.acos(diff.w);
  if (angle == 0) {
    return
  } else {
    var axis = new THREE.Vector3(diff.x, diff.y, diff.z).normalize();
  }
  new Rotation(from, axis, angle, 1, easeOutCirc).step();
}

export function isOver(v, normal) {
  return normal.dot(v) >= 0;
}

export function makeRandomVector() {
  return new THREE.Vector3(
    Math.random() * 2 - 1,
    Math.random() * 2 - 1,
    Math.random() * 2 - 1).normalize();
}

export function intersectsPlane(v1, v2, normal) {
  return (isOver(v1, normal) && !isOver(v2, normal))
    || (!isOver(v1, normal) && isOver(v2, normal));
}

export function angleBetween(v1, v2) {
  let len_product = v1.length() * v2.length();
  let d = v1.dot(v2) / len_product;
  return Math.acos(Math.max(-1, Math.min(1, d)));
}

export function intersection(u, v, normal) {
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
  if (a2 + a3 - a1 < .0001) {
    return i2;
  }

  return NaN;
}

export function splitPoint(c, normal) {
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

export function bisect(poly, orientation, normal) {
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