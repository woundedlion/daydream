// draw.js
import * as THREE from "three";
import { Daydream } from "./driver.js";
import { Dot, angleBetween, sphericalToPixel } from "./geometry.js";
import { G as g } from "./geometry.js";

export function dottedBrush(color, freq, dutyCycle, phase, t) {
  let r = squareWave(0, 1, freq, dutyCycle, phase)(t);
  return color.multiplyScalar(r);
}
export class Path {
  constructor(initialPos) {
    this.points = [initialPos];
  }

  collapse() {
    this.points = [this.points[this.points.length - 1]];
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
    let i = Math.floor(t * (this.points.length - 1));
    return this.points[i].clone();
  }
}

export class ProceduralPath {
  constructor(pathFn) {
    this.f = pathFn;
  }

  getPoint(t) {
    return this.f(t);
  }
}

export const drawVector = (v, colorFn) => {
  return [new Dot(new THREE.Vector3(...v.toArray()).normalize(), colorFn(v, 0))];
}

export const drawPath = (path, colorFn) => {
  let r = [];
  for (let t = 0; t < path.length(); t++) {
    r.push(new Dot(path.getPoint(t / path.length()), colorFn(t)));
  }
  return r;
}

export const drawLine = (v1, v2, colorFn, start = 0, end = 1, longWay = false) => {
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

export const drawVertices = (vertices, colorFn) => {
  let dots = [];
  let v = new THREE.Vector3();
  for (const vertex of vertices) {
    v.set(vertex[0], vertex[1], vertex[2]);
    dots.push(new Dot(v.normalize(), colorFn(v)));
  }
  return dots;
}

export const drawPolyhedron = (vertices, edges, colorFn) => {
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

export const fnPoint = (f, normal, radius, angle) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
    radius = 2 - radius;
  }
  if (Math.abs(v.dot(Daydream.X_AXIS)) > 0.99995) {
    u.crossVectors(v, Daydream.Y_AXIS).normalize();
  } else {
    u.crossVectors(v, Daydream.X_AXIS).normalize();
  }
  w.crossVectors(v, u);
  let d = Math.sqrt(Math.pow(1 - radius, 2));

  let vi = calcRingPoint(angle, radius, u, v, w);
  let vp = calcRingPoint(angle, 1, u, v, w);
  let axis = new THREE.Vector3().crossVectors(v, vp).normalize();
  let shift = new THREE.Quaternion().setFromAxisAngle(axis, f(angle * Math.PI / 2));
  return vi.clone().applyQuaternion(shift);
};

export const drawFn = (orientation, normal, radius, shiftFn, colorFn) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = orientation.orient(normal);
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
  }
  if (Math.abs(v.dot(Daydream.X_AXIS)) > 0.99995) {
    u.crossVectors(v, Daydream.Y_AXIS).normalize();
  } else {
    u.crossVectors(v, Daydream.X_AXIS).normalize();
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
      dots.push(...drawLine(from, to, colorFn));
    }
    from = to;
  }
  dots.push(...drawLine(from, start, colorFn));

  return dots;
};

export const calcRingPoint = (a, radius, u, v, w) => {
  let d = Math.sqrt(Math.pow(1 - radius, 2));
  return new THREE.Vector3(
    d * v.x + radius * u.x * Math.cos(a) + radius * w.x * Math.sin(a),
    d * v.y + radius * u.y * Math.cos(a) + radius * w.y * Math.sin(a),
    d * v.z + radius * u.z * Math.cos(a) + radius * w.z * Math.sin(a)
  ).normalize();
}

export const drawRing = (normal, radius, colorFn, phase = 0) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
    phase = (phase + Math.PI) % (2 * Math.PI)
  }

  if (Math.abs(v.dot(Daydream.X_AXIS)) > 0.99995) {
    u.crossVectors(v, Daydream.Y_AXIS).normalize();
  } else {
    u.crossVectors(v, Daydream.X_AXIS).normalize();
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

export const ringPoint = (normal, radius, angle, phase = 0) => {
  let dots = [];
  let u = new THREE.Vector3();
  let v = normal.clone();
  let w = new THREE.Vector3();
  if (radius > 1) {
    v.negate();
  }
  if (Math.abs(v.dot(Daydream.X_AXIS)) > 0.99995) {
    u.crossVectors(v, Daydream.Y_AXIS).normalize();
  } else {
    u.crossVectors(v, Daydream.X_AXIS).normalize();
  }
  w.crossVectors(v, u);
  if (radius > 1) {
    w.negate();
    radius = 2 - radius;
  }
  return calcRingPoint(angle + phase, radius, u, v, w);
};

export const drawFibSpiral = (n, eps, colorFn) => {
  let dots = [];
  for (let i = 0; i < n; ++i) {
    let v = fibSpiral(n, eps, i);
    dots.push(new Dot(v, colorFn(v)));
  }
  return dots;
};

export function plotDots(pixels, filter, dots, age, alpha) {
  for (const dot of dots) {
    let p = sphericalToPixel(new THREE.Spherical().setFromVector3(dot.position));
    filter.plot(pixels, p.x, p.y, dot.color, age, alpha);
  }
}

export const tween = (orientation, drawFn) => {
  let s = orientation.length();
  for (let i = 0; i < s; ++i) {
    drawFn((v) => orientation.orient(v, i), (s - 1 - i) / s);
  }
}