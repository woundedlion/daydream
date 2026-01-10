/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream, labels, XY } from "./driver.js";
import { Dot, angleBetween, fibSpiral, vectorPool, yToPhi } from "./geometry.js";
import { quinticKernel } from "./filters.js";
import { wrap } from "./util.js";
import { StaticPool } from "./StaticPool.js";

/** @type {StaticPool} Global pool for Dot objects. */
export const dotPool = new StaticPool(Dot, 500000);

// Reusable temporary objects to avoid allocation during render loops
const _tempVec = new THREE.Vector3();
const _tempCol = new THREE.Color();

/**
 * Implements pixel history and decay for persistent effects.
 * Manages a buffer of points that fade out over a specific lifespan.
 * Refactored to use Structure of Arrays (SoA) to prevent GC churn.
 */
export class DecayBuffer {
  /**
   * @param {number} lifespan - The number of frames a pixel lasts before disappearing.
   * @param {number} [capacity=4096] - The maximum number of trail segments to track.
   */
  constructor(lifespan, capacity = 4096) {
    this.lifespan = lifespan;
    this.capacity = capacity;
    this.count = 0;
    this.head = 0; // Points to the next write position

    // Structure of Arrays (SoA) - TypedArrays for zero-allocation storage
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.z = new Float32Array(capacity);

    this.r = new Float32Array(capacity);
    this.g = new Float32Array(capacity);
    this.b = new Float32Array(capacity);
    this.a = new Float32Array(capacity); // Alpha

    this.ttl = new Float32Array(capacity);

    this.sortIndices = new Uint32Array(capacity);
  }

  /**
   * Records a list of dots into the history buffer.
   * @param {Dot[]} dots - The list of dots (position/color) to record.
   * @param {number} age - The initial age of the dots (usually 0).
   * @param {number} alpha - The global opacity for these dots.
   */
  recordDots(dots, age, alpha) {
    for (let i = 0; i < dots.length; ++i) {
      let dot = dots[i];
      this.record(dot.position, dot.color, age, alpha * (dot.alpha !== undefined ? dot.alpha : 1.0));
    }
  }

  /**
   * Records a single dot into the history buffer.
   * @param {THREE.Vector3} v - The position vector.
   * @param {THREE.Color} color - The base color of the dot.
   * @param {number} age - The initial age of the dot (frame offset).
   * @param {number} alpha - The initial opacity.
   */
  record(v, color, age, alpha) {
    let ttl = this.lifespan - age;
    if (ttl > 0) {
      const i = this.head;

      this.x[i] = v.x;
      this.y[i] = v.y;
      this.z[i] = v.z;

      this.r[i] = color.r;
      this.g[i] = color.g;
      this.b[i] = color.b;
      this.a[i] = alpha;

      this.ttl[i] = ttl;

      this.head = (this.head + 1) % this.capacity;
      if (this.count < this.capacity) {
        this.count++;
      }
    }
  }

  /**
   * Renders the buffered dots to the pixel map, applying decay and sorting.
   * @param {Map} pixels - The pixel map to write to (output).
   * @param {Object} pipeline - The render pipeline or filter object to process points.
   * @param {Function} colorFn - Function to determine color based on decay. Signature: (vector, normalized_t) => Color.
   */
  render(pixels, pipeline, colorFn) {
    let tail = (this.head - this.count + this.capacity) % this.capacity;
    for (let i = 0; i < this.count; i++) {
      this.sortIndices[i] = (tail + i) % this.capacity;
    }
    const activeIndices = this.sortIndices.subarray(0, this.count);
    activeIndices.sort((a, b) => this.ttl[a] - this.ttl[b]);

    for (let i = 0; i < this.count; ++i) {
      const idx = activeIndices[i];
      this.ttl[idx] -= 1;
      const currentTTL = this.ttl[idx];
      if (currentTTL > 0) {
        _tempVec.set(this.x[idx], this.y[idx], this.z[idx]);
        let t = (this.lifespan - currentTTL) / this.lifespan;
        const res = colorFn(_tempVec, t);
        const c = res.isColor ? res : (res.color || res);
        const a = (res.alpha !== undefined ? res.alpha : 1.0) * this.a[idx];
        pipeline.plot(pixels, _tempVec, c, 0, a);
      }
    }

    // Cleanup
    while (this.count > 0) {
      const tailIdx = (this.head - this.count + this.capacity) % this.capacity;
      if (this.ttl[tailIdx] <= 0) {
        this.count--;
      } else {
        break;
      }
    }
  }
}
/**
 * Represents a path composed of connected points on the sphere.
 */
export class Path {
  /**
   * @param {THREE.Vector3} initialPos - The starting position of the path.
   */
  constructor(initialPos) {
    this.points = [initialPos.clone()];
  }

  /**
   * Collapses the path to only the last point.
   */
  collapse() {
    this.points = [this.points[this.points.length - 1]];
  }

  /**
   * Gets the number of points in the path.
   * @returns {number} The length of the path.
   */
  length() {
    return this.points.length;
  }

  /**
   * Appends a line segment between two vectors to the path.
   * @param {THREE.Vector3} c1 - The start vector.
   * @param {THREE.Vector3} c2 - The end vector.
   * @param {boolean} [longWay=false] - If true, take the longer arc.
   * @param {Function} [easingFn=(t) => t] - An unused easing function (retained for signature).
   * @returns {Path} The path instance.
   */
  appendLine(c1, c2, longWay = false, easingFn = (t) => t) {
    if (this.points.length > 0) {
      this.points.pop();
    }
    this.points.push(c2.clone());
    return this;
  }

  /**
   * Appends a segment generated by a plotting function.
   * @param {Function} plotFn - Function that returns a vector based on a domain parameter t.
   * @param {number} domain - The range of the input parameter for plotFn.
   * @param {number} samples - The number of points to sample.
   * @param {Function} [easingFn=(t) => t] - The easing function to apply to the input parameter.
   * @returns {Path} The path instance.
   */
  appendSegment(plotFn, domain, samples, easingFn = (t) => t) {
    if (this.points.length > 0) {
      this.points.pop();
    }
    for (let t = 0; t <= samples; t++) {
      // Must clone() because plotFn might return a pooled vector
      this.points.push(plotFn(easingFn(t / samples) * domain).clone());
    }
    return this;
  }

  /**
   * Gets a point on the path based on a normalized parameter t.
   * @param {number} t - Normalized position along the path [0, 1].
   * @returns {THREE.Vector3} A clone of the point at the given position.
   */
  getPoint(t) {
    const rawIndex = t * (this.points.length - 1);
    const i = Math.floor(rawIndex);
    const f = rawIndex - i;

    // Handle end of path
    if (i >= this.points.length - 1) {
      return vectorPool.acquire().copy(this.points[this.points.length - 1]);
    }

    const p1 = this.points[i];
    const p2 = this.points[i + 1];
    return vectorPool.acquire().copy(p1).lerp(p2, f);
  }
}

/**
 * Represents a path defined by a single procedural function.
 */
export class ProceduralPath {
  /**
   * @param {Function} pathFn - Function that takes a parameter t [0, 1] and returns a THREE.Vector3.
   */
  constructor(pathFn) {
    this.f = pathFn;
  }

  /**
   * Gets a point on the path.
   * @param {number} t - Normalized position along the path [0, 1].
   * @returns {THREE.Vector3} The point on the path.
   */
  getPoint(t) {
    return this.f(t);
  }
}

/**
 * Draws a single dot at a given vector.
 * @param {THREE.Vector3} v - The vector position (normalized).
 * @param {Function} colorFn - Function to determine the color (takes vector and t=0).
 * @returns {Dot[]} An array containing a single Dot.
 */
export const drawVector = (v, colorFn) => {
  const dot = dotPool.acquire();
  dot.position.copy(v).normalize();
  const c = colorFn(v, 0);
  if (c.isColor) {
    dot.color = c;
    dot.alpha = 1.0;
  } else {
    dot.color = c.color;
    dot.alpha = c.alpha !== undefined ? c.alpha : 1.0;
  }
  return [dot];
}

/**
 * Draws a sequence of points along a Path object.
 * @param {Path|ProceduralPath} path - The path object.
 * @param {Function} colorFn - Function to determine the color (takes normalized time t).
 * @returns {Dot[]} An array of Dots along the path.
 */
export const drawPath = (path, colorFn) => {
  let r = [];
  for (let t = 0; t < path.length(); t++) {
    const dot = dotPool.acquire();
    dot.position.copy(path.getPoint(t / path.length()));
    const c = colorFn(t);
    if (c.isColor) {
      dot.color = c;
      dot.alpha = 1.0;
    } else {
      dot.color = c.color;
      dot.alpha = c.alpha !== undefined ? c.alpha : 1.0;
    }
    r.push(dot);
  }
  return r;
}

/**
 * Rasterizes a list of points into Dot objects by connecting them with geodesic lines.
 * @param {THREE.Vector3[]} points - The list of points.
 * @param {Function} colorFn - Function to determine color (takes vector and normalized progress t).
 * @param {boolean} [closeLoop=false] - If true, connects the last point to the first.
 * @returns {Dot[]} An array of Dots.
 */
export const rasterize = (points, colorFn, closeLoop = false) => {
  let dots = [];
  const len = points.length;
  if (len === 0) return dots;

  const count = closeLoop ? len : len - 1;
  for (let i = 0; i < count; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % len];

    const segmentColorFn = (p, subT) => {
      const globalT = (i + subT) / count;
      return colorFn(p, globalT);
    };

    // Draw segment
    const segmentDots = drawLine(p1, p2, segmentColorFn, 0, 1, false, true);
    dots.push(...segmentDots);
  }
  return dots;
};

/**
 * Draws a geodesic line (arc) between two vectors on the sphere with adaptive sampling.
 * @param {THREE.Vector3} v1 - The start vector.
 * @param {THREE.Vector3} v2 - The end vector.
 * @param {Function} colorFn - Function to determine the color (takes vector and normalized progress t).
 * @param {number} [start=0] - Starting angle multiplier for drawing the line arc.
 * @param {number} [end=1] - Ending multiplier for the total arc angle.
 * @param {boolean} [longWay=false] - If true, draws the longer arc.
 * @returns {Dot[]} An array of Dots forming the line.
 */
export const drawLine = (v1, v2, colorFn, start = 0, end = 1, longWay = false, omitLast = false) => {
  let u = vectorPool.acquire().copy(v1);
  let v = vectorPool.acquire().copy(v2);
  let a = angleBetween(u, v);
  let w = vectorPool.acquire();

  if (Math.abs(a) < 0.0001) {
    if (omitLast) return [];

    const dot = dotPool.acquire();
    dot.position.copy(u);
    const c = colorFn(u, 0);
    if (c.isColor) {
      dot.color = c;
      dot.alpha = 1.0;
    } else {
      dot.color = c.color;
      dot.alpha = c.alpha !== undefined ? c.alpha : 1.0;
    }
    return [dot];
  } else if (Math.abs(Math.PI - a) < 0.0001) {
    if (Math.abs(v.dot(Daydream.X_AXIS)) > 0.9999) {
      w.crossVectors(u, Daydream.Y_AXIS).normalize();
    } else {
      w.crossVectors(u, Daydream.X_AXIS).normalize();
    }
  } else {
    w.crossVectors(u, v).normalize();
  }

  if (longWay) {
    a = 2 * Math.PI - a;
    w.negate();
  }

  if (start != 0) {
    let q = new THREE.Quaternion().setFromAxisAngle(w, start * a);
    u.applyQuaternion(q).normalize();
  }
  a *= Math.abs(end - start);

  let dots = [];

  // Simulation Phase
  let simU = vectorPool.acquire().copy(u);
  let simAngle = 0;
  let steps = [];
  const baseStep = 2 * Math.PI / Daydream.W;

  while (simAngle < a) {
    let scaleFactor = Math.max(0.05, Math.sqrt(Math.max(0, 1.0 - simU.y * simU.y)));
    let step = baseStep * scaleFactor;
    steps.push(step);
    simAngle += step;

    // Advance simU
    let q = new THREE.Quaternion().setFromAxisAngle(w, step);
    simU.applyQuaternion(q).normalize();
  }

  // Calculate Scale Factor
  let scale = a / simAngle;

  // Drawing Phase
  if (omitLast && steps.length === 0) {
    return [];
  }

  let currentAngle = 0;

  const startDot = dotPool.acquire();
  startDot.position.copy(u);
  const startC = colorFn(u, 0);
  if (startC.isColor) {
    startDot.color = startC;
    startDot.alpha = 1.0;
  } else {
    startDot.color = startC.color;
    startDot.alpha = startC.alpha !== undefined ? startC.alpha : 1.0;
  }
  dots.push(startDot);

  let loopLimit = omitLast ? steps.length - 1 : steps.length;
  for (let i = 0; i < loopLimit; i++) {
    let step = steps[i] * scale;

    // Advance u
    let q = new THREE.Quaternion().setFromAxisAngle(w, step);
    u.applyQuaternion(q).normalize();
    currentAngle += step;

    // Normalized t
    let t = (a > 0) ? (currentAngle / a) : 1;

    const dot = dotPool.acquire();
    dot.position.copy(u);
    const c = colorFn(u, t);
    if (c.isColor) {
      dot.color = c;
      dot.alpha = 1.0;
    } else {
      dot.color = c.color;
      dot.alpha = c.alpha !== undefined ? c.alpha : 1.0;
    }
    dots.push(dot);
  }

  return dots;
}

/**
 * Draws a set of vertices as individual dots.
 * @param {number[][]} vertices - An array of [x, y, z] arrays.
 * @param {Function} colorFn - Function to determine the color (takes vector).
 * @returns {Dot[]} An array of Dots at the vertex positions.
 */
export const drawVertices = (vertices, colorFn) => {
  let dots = [];
  let v = vectorPool.acquire();
  for (const vertex of vertices) {
    v.set(vertex[0], vertex[1], vertex[2]);
    const dot = dotPool.acquire();
    dot.position.copy(v).normalize();
    const c = colorFn(v); // Note passed v not normalized here? Original code normalized in new Dot call: v.normalize()
    // Wait, original: new Dot(v.normalize(), colorFn(v))
    // v.normalize() modifies v in place! So colorFn(v) called with modified v? 
    // No, JS eval order: arguments evaluated left to right?
    // actually, v.set(...) modifies v.
    // v.normalize() modifies v and returns it.
    // So colorFn(v) receives the normalized vector.

    if (c.isColor) {
      dot.color = c;
      dot.alpha = 1.0;
    } else {
      dot.color = c.color;
      dot.alpha = c.alpha !== undefined ? c.alpha : 1.0;
    }
    dots.push(dot);
  }
  return dots;
}

/**
 * Samples points for the edges of a polyhedron.
 * @param {number[][]} vertices - An array of [x, y, z] vertex arrays.
 * @param {number[][]} edges - An adjacency list of vertex indices.
 * @returns {THREE.Vector3[]} An array of points forming the edges.
 */
export const samplePolyhedron = (vertices, edges) => {
  let points = [];
  edges.map((adj, i) => {
    adj.map((j) => {
      // Just push the vertices, let rasterize handle the lines
      points.push(vectorPool.acquire().set(...vertices[i]).normalize());
      points.push(vectorPool.acquire().set(...vertices[j]).normalize());
    })
  });
  return points;
}

/**
 * Draws the edges of a polyhedron by drawing lines between connected vertices.
 * @param {number[][]} vertices - An array of [x, y, z] vertex arrays.
 * @param {number[][]} edges - An adjacency list of vertex indices.
 * @param {Function} colorFn - Function to determine the color (takes vector and normalized progress t).
 * @returns {Dot[]} An array of Dots forming the edges.
 */
export const drawPolyhedron = (vertices, edges, colorFn) => {
  let dots = [];
  edges.map((adj, i) => {
    adj.map((j) => {
      if (i < j) {
        dots.push(
          ...drawLine(
            vectorPool.acquire().set(...vertices[i]).normalize(),
            vectorPool.acquire().set(...vertices[j]).normalize(),
            colorFn)
        );
      }
    })
  });
  return dots;
}

/**
 * Calculates a single point on a sphere distorted by a function, often for an oscillating ring.
 * @param {Function} f - The shift function (e.g., sinWave) based on angle.
 * @param {THREE.Vector3} normal - The normal vector defining the ring plane.
 * @param {number} radius - The base radius of the ring.
 * @param {number} angle - The angle along the ring to calculate the point.
 * @returns {THREE.Vector3} The shifted point on the sphere.
 */
export const fnPoint = (f, normal, radius, angle) => {
  let dots = [];
  let u = vectorPool.acquire();
  let v = vectorPool.acquire().copy(normal);
  let w = vectorPool.acquire();
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

  let vi = calcRingPoint(angle, radius, u, v, w);
  let vp = calcRingPoint(angle, 1, u, v, w);
  let axis = vectorPool.acquire().crossVectors(v, vp).normalize();
  let shift = new THREE.Quaternion().setFromAxisAngle(axis, f(angle * Math.PI / 2));
  return vi.applyQuaternion(shift);
};

/**
 * Samples points for a function-distorted ring with adaptive sampling.
 * @param {THREE.Quaternion} orientationQuaternion - Orientation of the base ring.
 * @param {THREE.Vector3} normal - Normal of the base ring.
 * @param {number} radius - Base radius (0-1).
 * @param {Function} shiftFn - Function(t) returning angle offset.
 * @param {number} [phase=0] - Starting phase offset.
 * @returns {THREE.Vector3[]} An array of points.
 */
export const sampleFn = (orientationQuaternion, normal, radius, shiftFn, phase = 0) => {
  // Basis
  let refAxis = Daydream.X_AXIS;
  if (Math.abs(normal.dot(refAxis)) > 0.9999) {
    refAxis = Daydream.Y_AXIS;
  }
  let v = vectorPool.acquire().copy(normal).applyQuaternion(orientationQuaternion).normalize();
  let ref = vectorPool.acquire().copy(refAxis).applyQuaternion(orientationQuaternion).normalize();
  let u = vectorPool.acquire().crossVectors(v, ref).normalize();
  let w = vectorPool.acquire().crossVectors(v, u).normalize();

  // Backside rings
  let vSign = 1.0;
  if (radius > 1) {
    vSign = -1.0;
    radius = 2 - radius;
  }

  // Equidistant projection
  const thetaEq = radius * (Math.PI / 2);
  const r = Math.sin(thetaEq);
  const d = Math.cos(thetaEq);

  // Calculate Samples
  const numSamples = Daydream.W;
  const step = 2 * Math.PI / numSamples;
  let points = [];
  let uTemp = vectorPool.acquire();

  for (let i = 0; i < numSamples; i++) {
    let theta = i * step;
    let t = theta + phase;
    let cosRing = Math.cos(t);
    let sinRing = Math.sin(t);
    uTemp.copy(u).multiplyScalar(cosRing).addScaledVector(w, sinRing);

    // Apply Shift
    let shift = shiftFn(theta / (2 * Math.PI));
    let cosShift = Math.cos(shift);
    let sinShift = Math.sin(shift);
    let vScale = (vSign * d) * cosShift - r * sinShift;
    let uScale = r * cosShift + (vSign * d) * sinShift;
    let p = vectorPool.acquire().copy(v).multiplyScalar(vScale).addScaledVector(uTemp, uScale).normalize();

    points.push(p);
  }

  return points;
}

/**
 * Draws a function-distorted ring with adaptive sampling.
 * @param {THREE.Quaternion} orientationQuaternion - Orientation of the base ring.
 * @param {THREE.Vector3} normal - Normal of the base ring.
 * @param {number} radius - Base radius (0-1).
 * @param {Function} shiftFn - Function(t) returning angle offset.
 * @param {Function} colorFn - Function(v, t) returning color.
 * @param {number} [phase=0] - Starting phase offset.
 */
export const drawFn = (orientationQuaternion, normal, radius, shiftFn, colorFn, phase = 0) => {
  const points = sampleFn(orientationQuaternion, normal, radius, shiftFn, phase);
  return rasterize(points, colorFn, true);
}

/**
 * Calculates a point on a circle that lies on the surface of the unit sphere.
 * Used internally by drawing functions.
 * @param {number} a - The angle in radians around the ring.
 * @param {number} radius - The ring radius in the plane.
 * @param {THREE.Vector3} u - A vector on the plane (ortho to normal).
 * @param {THREE.Vector3} v - The ring's normal (center point).
 * @param {THREE.Vector3} w - A second vector on the plane (ortho to u and normal).
 * @returns {THREE.Vector3} The normalized point on the sphere's surface.
 */
export const calcRingPoint = (a, radius, u, v, w) => {
  let d = Math.sqrt(Math.pow(1 - radius, 2));
  return vectorPool.acquire().set(
    d * v.x + radius * u.x * Math.cos(a) + radius * w.x * Math.sin(a),
    d * v.y + radius * u.y * Math.cos(a) + radius * w.y * Math.sin(a),
    d * v.z + radius * u.z * Math.cos(a) + radius * w.z * Math.sin(a)
  ).normalize();
}

/**
 * Samples points for a polygon or ring on the sphere surface.
 * @param {THREE.Quaternion} orientationQuaternion - The orientation of the ring.
 * @param {THREE.Vector3} normal - The normal vector defining the ring plane.
 * @param {number} radius - The radius of the ring.
 * @param {number} numSamples - The number of points to sample.
 * @param {number} [phase=0] - Starting phase.
 * @returns {THREE.Vector3[]} An array of points.
 */
export const samplePolygon = (orientationQuaternion, normal, radius, numSamples, phase = 0) => {
  // Basis
  let refAxis = Daydream.X_AXIS;
  if (Math.abs(normal.dot(refAxis)) > 0.9999) {
    refAxis = Daydream.Y_AXIS;
  }
  let v = vectorPool.acquire().copy(normal).applyQuaternion(orientationQuaternion).normalize();
  let ref = vectorPool.acquire().copy(refAxis).applyQuaternion(orientationQuaternion).normalize();
  let u = vectorPool.acquire().crossVectors(v, ref).normalize();
  let w = vectorPool.acquire().crossVectors(v, u).normalize();

  // Backside rings
  let vDir = v.clone();
  if (radius > 1) {
    vDir.negate();
    radius = 2 - radius;
  }

  const thetaEq = radius * (Math.PI / 2);
  const r = Math.sin(thetaEq);
  const d = Math.cos(thetaEq);

  // Calculate Samples
  const step = 2 * Math.PI / numSamples;
  let points = [];
  let uTemp = vectorPool.acquire();

  for (let i = 0; i < numSamples; i++) {
    let theta = i * step;
    let t = theta + phase;
    let cosRing = Math.cos(t);
    let sinRing = Math.sin(t);
    uTemp.copy(u).multiplyScalar(cosRing).addScaledVector(w, sinRing);
    let p = vectorPool.acquire().copy(vDir).multiplyScalar(d).addScaledVector(uTemp, r).normalize();
    points.push(p);
  }
  return points;
}

/**
 * Draws a circular ring on the sphere surface with adaptive sampling.
 * @param {THREE.Quaternion} orientationQuaternion - The orientation of the ring.
 * @param {THREE.Vector3} normal - The normal vector defining the ring plane.
 * @param {number} radius - The radius of the ring.
 * @param {Function} colorFn - Function to determine color.
 * @param {number} [phase=0] - Starting phase.
 * @returns {Dot[]} An array of Dots.
 */
export const drawRing = (orientationQuaternion, normal, radius, colorFn, phase = 0) => {
  const points = samplePolygon(orientationQuaternion, normal, radius, Daydream.W / 4, phase);
  return rasterize(points, colorFn, true);
}

/**
 * Draws a polygon on the sphere surface.
 * @param {THREE.Quaternion} orientationQuaternion - The orientation of the polygon.
 * @param {THREE.Vector3} normal - The normal vector.
 * @param {number} radius - The radius.
 * @param {number} numSides - Number of sides.
 * @param {Function} colorFn - Function to determine color.
 * @param {number} [phase=0] - Starting phase.
 * @returns {Dot[]} An array of Dots.
 */
export const drawPolygon = (orientationQuaternion, normal, radius, numSides, colorFn, phase = 0) => {
  const points = samplePolygon(orientationQuaternion, normal, radius, numSides, phase);
  return rasterize(points, colorFn, true);
}

export const ringPoint = (normal, radius, angle, phase = 0) => {
  let dots = [];
  let u = vectorPool.acquire();
  let v = vectorPool.acquire().copy(normal);
  let w = vectorPool.acquire();
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
  return vectorPool.acquire().set(
    d * v.x + radius * u.x * Math.cos(angle + phase) + radius * w.x * Math.sin(angle + phase),
    d * v.y + radius * u.y * Math.cos(angle + phase) + radius * w.y * Math.sin(angle + phase),
    d * v.z + radius * u.z * Math.cos(angle + phase) + radius * w.z * Math.sin(angle + phase)
  ).normalize();
};

/**
 * Draws points forming a Fibonacci spiral pattern.
 * @param {number} n - Total number of points.
 * @param {number} eps - Epsilon value for spiral offset.
 * @param {Function} colorFn - Function to determine the color (takes vector).
 * @returns {Dot[]} An array of Dots forming the spiral.
 */
export const drawFibSpiral = (n, eps, colorFn) => {
  let dots = [];
  for (let i = 0; i < n; ++i) {
    let v = fibSpiral(n, eps, i);
    const dot = dotPool.acquire();
    dot.position.copy(v);
    const c = colorFn(v);
    if (c.isColor) {
      dot.color = c;
      dot.alpha = 1.0;
    } else {
      dot.color = c.color;
      dot.alpha = c.alpha !== undefined ? c.alpha : 1.0;
    }
    dots.push(dot);
  }
  return dots;
};

/**
 * Plots a list of dots onto the pixel map using the provided filters.
 * @param {Map} pixels - The pixel map.
 * @param {Object} filters - The render pipeline or filter object.
 * @param {Dot[]} dots - The array of dots to plot.
 * @param {number} age - The initial age of the dot.
 * @param {number} alpha - The global opacity for these dots.
 */
export function plotDots(pixels, filters, dots, age, alpha) {
  for (let i = 0; i < dots.length; ++i) {
    let dot = dots[i];
    filters.plot(pixels, dot.position, dot.color, age, alpha * (dot.alpha !== undefined ? dot.alpha : 1.0));
  }
}

/**
 * Draws a motion trail by tweening between orientations in the queue.
 * @param {Orientation} orientation - The orientation object containing the motion history.
 * @param {Function} drawFn - Function to draw a segment (takes orientation quaternion and normalized progress).
 */
export const tween = (orientation, drawFn) => {
  let s = orientation.length();
  let start = (s > 1) ? 1 : 0;
  for (let i = start; i < s; ++i) {
    drawFn(orientation.get(i), (s - 1 - i) / s);
  }
}

export const Scan = {
  Ring: class {
    /**
     * Scans a thick ring and feeds pixels into the pipeline.
     * @param {Object} pipeline - The render pipeline (must support plot2D).
     * @param {Array} pixels - The pixel buffer (Daydream.pixels).
     * @param {THREE.Vector3} normal - Ring orientation.
     * @param {number} radius - Angular radius (0-2).
     * @param {number} thickness - Angular thickness.
     * @param {Function} materialFn - (pos, t, dist) => {color, alpha}.
     * @param {number} [startAngle=0] - Start of the arc in radians.
     * @param {number} [endAngle=6.28318] - End of the arc in radians.
     */
    static draw(pipeline, pixels, normal, radius, thickness, materialFn, startAngle = 0, endAngle = 2 * Math.PI, options = {}) {
      // Pre-calculate properties
      const nx = normal.x;
      const ny = normal.y;
      const nz = normal.z;

      // --- 1. Construct Basis for Azimuth/Angle checks ---
      let ref = new THREE.Vector3(1, 0, 0); // X_AXIS
      if (Math.abs(normal.dot(ref)) > 0.9999) {
        ref.set(0, 1, 0); // Y_AXIS
      }
      const u = new THREE.Vector3().crossVectors(normal, ref).normalize();
      const w = new THREE.Vector3().crossVectors(normal, u).normalize();

      const targetAngle = radius * (Math.PI / 2);
      const R = Math.sqrt(nx * nx + nz * nz);
      const alpha = Math.atan2(nx, nz);
      const centerPhi = Math.acos(ny);
      const isFullCircle = Math.abs(endAngle - startAngle) >= 2 * Math.PI - 0.001;

      const ctx = {
        normal, radius, thickness, materialFn,
        nx, ny, nz, targetAngle, R, alpha, centerPhi,
        u, w, startAngle, endAngle,
        checkSector: !isFullCircle,
        pipeline, pixels,
        clipPlanes: options.clipPlanes, // Injected options
        limits: options.limits, // Injected options
        debugBB: options.debugBB // Injected options
      };

      // --- 2. CALCULATE VERTICAL BOUNDS ---
      const a1 = centerPhi - targetAngle;
      const a2 = centerPhi + targetAngle;
      const p1 = Math.acos(Math.cos(a1));
      const p2 = Math.acos(Math.cos(a2));
      const minP = Math.min(p1, p2);
      const maxP = Math.max(p1, p2);

      let phiMin = Math.max(0, minP - thickness);
      let phiMax = Math.min(Math.PI, maxP + thickness);

      // Optional limits could be passed in ctx if needed, but keeping it simple for now
      if (ctx.limits) {
        phiMin = Math.max(phiMin, ctx.limits.minPhi);
        phiMax = Math.min(phiMax, ctx.limits.maxPhi);
      }

      if (phiMin > phiMax) return;

      const yMin = Math.max(0, Math.floor((phiMin * (Daydream.H - 1)) / Math.PI));
      const yMax = Math.min(Daydream.H - 1, Math.ceil((phiMax * (Daydream.H - 1)) / Math.PI));

      for (let y = yMin; y <= yMax; y++) {
        Scan.Ring.scanRow(y, ctx);
      }
    }

    static scanRow(y, ctx) {
      const phi = yToPhi(y);
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);

      if (ctx.R < 0.01) {
        Scan.Ring.scanFullRow(y, ctx);
        return;
      }

      const ang_low = Math.max(0, ctx.targetAngle - ctx.thickness);
      const ang_high = Math.min(Math.PI, ctx.targetAngle + ctx.thickness);
      const D_max = Math.cos(ang_low);
      const D_min = Math.cos(ang_high);
      const denom = ctx.R * sinPhi;

      if (Math.abs(denom) < 0.000001) {
        Scan.Ring.scanFullRow(y, ctx);
        return;
      }

      const C_min = (D_min - ctx.ny * cosPhi) / denom;
      const C_max = (D_max - ctx.ny * cosPhi) / denom;
      const minCos = Math.max(-1, C_min);
      const maxCos = Math.min(1, C_max);

      if (minCos > maxCos) return;

      const angleMin = Math.acos(maxCos);
      const angleMax = Math.acos(minCos);

      if (angleMin <= 0.0001) {
        Scan.Ring.scanWindow(y, ctx.alpha - angleMax, ctx.alpha + angleMax, ctx);
      } else if (angleMax >= Math.PI - 0.0001) {
        Scan.Ring.scanWindow(y, ctx.alpha + angleMin, ctx.alpha + 2 * Math.PI - angleMin, ctx);
      } else {
        Scan.Ring.scanWindow(y, ctx.alpha - angleMax, ctx.alpha - angleMin, ctx);
        Scan.Ring.scanWindow(y, ctx.alpha + angleMin, ctx.alpha + angleMax, ctx);
      }
    }

    static scanFullRow(y, ctx) {
      for (let x = 0; x < Daydream.W; x++) {
        Scan.Ring.processPixel(XY(x, y), x, y, ctx);
      }
    }

    static scanWindow(y, t1, t2, ctx) {
      const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
      const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));
      for (let x = x1; x <= x2; x++) {
        const wx = wrap(x, Daydream.W);
        Scan.Ring.processPixel(XY(wx, y), wx, y, ctx);
      }
    }

    static processPixel(i, x, y, ctx) {
      if (ctx.debugBB) {
        const outColor = Daydream.pixels[i];
        outColor.r += 0.02; outColor.g += 0.02; outColor.b += 0.02;
      }

      const p = Daydream.pixelPositions[i];

      // Clipping Planes Logic from original FSRing (passed via ctx if needed)
      if (ctx.clipPlanes) {
        for (const cp of ctx.clipPlanes) {
          if (p.dot(cp) < 0) return;
        }
      }

      const polarAngle = angleBetween(p, ctx.normal);
      const dist = Math.abs(polarAngle - ctx.targetAngle);

      if (dist < ctx.thickness) {
        if (ctx.checkSector) {
          const dotU = p.dot(ctx.u);
          const dotW = p.dot(ctx.w);
          let azimuth = Math.atan2(dotW, dotU);
          if (azimuth < 0) azimuth += 2 * Math.PI;

          let inside = false;
          if (ctx.startAngle <= ctx.endAngle) {
            inside = (azimuth >= ctx.startAngle && azimuth <= ctx.endAngle);
          } else {
            inside = (azimuth >= ctx.startAngle || azimuth <= ctx.endAngle);
          }
          if (!inside) return;
        }

        const t = dist / ctx.thickness;
        const aaAlpha = quinticKernel(1.0 - t);

        // Evaluate Material
        const mat = ctx.materialFn(p, t, dist);
        const color = mat.isColor ? mat : (mat.color || mat);
        const baseAlpha = (mat.alpha !== undefined ? mat.alpha : 1.0);

        ctx.pipeline.plot2D(ctx.pixels, x, y, color, 0, baseAlpha * aaAlpha);
      }
    }
  },

  Line: class {
    static draw(pipeline, pixels, v1, v2, thickness, materialFn, options = {}) {
      const normal = new THREE.Vector3().crossVectors(v1, v2).normalize();
      if (normal.lengthSq() < 0.000001) return;

      const c1 = new THREE.Vector3().crossVectors(normal, v1);
      const c2 = new THREE.Vector3().crossVectors(v2, normal);

      let maxY = Math.max(v1.y, v2.y);
      let minY = Math.min(v1.y, v2.y);
      const apexPlaneNormal = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0));
      if (apexPlaneNormal.lengthSq() > 0.0001) {
        const d1 = v1.dot(apexPlaneNormal);
        const d2 = v2.dot(apexPlaneNormal);
        if (d1 * d2 <= 0) {
          const globalMaxY = Math.sqrt(1 - normal.y * normal.y);
          if (v1.y + v2.y > 0) maxY = globalMaxY;
          else minY = -globalMaxY;
        }
      }

      const minPhi = Math.acos(Math.min(1, Math.max(-1, maxY))) - thickness;
      const maxPhi = Math.acos(Math.min(1, Math.max(-1, minY))) + thickness;

      Scan.Ring.draw(pipeline, pixels, normal, 1.0, thickness, materialFn, 0, 2 * Math.PI, {
        ...options,
        clipPlanes: [c1, c2], // Merge clipPlanes? Scan.Ring currently just takes options.clipPlanes.
        // If options has clipPlanes, we should probably append or replace. 
        // But Line relies on these clipPlanes for segment definition.
        // Assuming options might contain debugBB but not clipPlanes for lines.
        limits: { minPhi, maxPhi }
      });
    }
  },

  Point: class {
    static draw(pipeline, pixels, pos, thickness, materialFn, options) {
      Scan.Ring.draw(pipeline, pixels, pos, 0, thickness, materialFn, 0, 2 * Math.PI, options);
    }
  },

  Field: class {
    static draw(pipeline, pixels, materialFn) {
      // Iterate all pixels
      for (let i = 0; i < Daydream.pixelPositions.length; i++) {
        // We need x, y for plot2D. 
        // Daydream.pixelPositions is linear 0..W*H.
        // x = i % W, y = i / W
        const x = i % Daydream.W;
        const y = (i / Daydream.W) | 0;

        const p = Daydream.pixelPositions[i];
        const mat = materialFn(p);

        const color = mat.isColor ? mat : (mat.color || mat);
        const alpha = (mat.alpha !== undefined ? mat.alpha : 1.0);

        // No AA logic here, just direct field evaluation
        pipeline.plot2D(pixels, x, y, color, 0, alpha);
      }
    }
  }
};
