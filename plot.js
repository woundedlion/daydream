/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween, fibSpiral, makeBasis } from "./geometry.js";
import { TWO_PI } from "./3dmath.js";
import { dotPool, vectorPool, quaternionPool } from "./memory.js";
import { Dot } from "./geometry.js";
import { Path, ProceduralPath } from "./animation.js";



export const Plot = {
    Point: class {
        /**
         * Draws a single dot at a given vector.
         * @param {Object} pipeline - The render pipeline.
         * @param {THREE.Vector3} v - The vector position (normalized).
         * @param {Function} colorFn - Function to determine the color (takes vector and t=0).
         */
        static draw(pipeline, v, colorFn) {
            const c = colorFn(v, 0);
            const color = c.isColor ? c : (c.color || c);
            const alpha = c.alpha !== undefined ? c.alpha : 1.0;
            pipeline.plot(v, color, 0, alpha);
        }
    },

    Path: class {
        /**
         * Draws a sequence of points along a Path object.
         * @param {Object} pipeline - The render pipeline.
         * @param {Path|ProceduralPath} path - The path object.
         * @param {Function} colorFn - Function to determine the color (takes normalized time t).
         */
        static draw(pipeline, path, colorFn) {
            for (let t = 0; t < path.length(); t++) {
                const v = path.getPoint(t / path.length());
                const c = colorFn(t);
                const color = c.isColor ? c : (c.color || c);
                const alpha = c.alpha !== undefined ? c.alpha : 1.0;
                pipeline.plot(v, color, 0, alpha);
            }
        }
    },

    Line: class {
        static draw(pipeline, v1, v2, colorFn, start = 0, end = 1, longWay = false, omitLast = false) {
            let u = vectorPool.acquire().copy(v1);
            let v = vectorPool.acquire().copy(v2);
            let a = angleBetween(u, v);
            let w = vectorPool.acquire();
            if (Math.abs(a) < 0.0001) { return; }

            if (Math.abs(Math.PI - a) < 0.0001) {
                if (Math.abs(u.dot(Daydream.X_AXIS)) > 0.9999) w.crossVectors(u, Daydream.Y_AXIS).normalize();
                else w.crossVectors(u, Daydream.X_AXIS).normalize();
            } else {
                w.crossVectors(u, v).normalize();
            }

            if (longWay) {
                a = TWO_PI - a;
                w.negate();
            }

            // Start offset
            if (start !== 0) {
                const startAngle = start * a;
                const q = quaternionPool.acquire().setFromAxisAngle(w, startAngle);
                u.applyQuaternion(q).normalize();
            }
            a *= Math.abs(end - start);

            // Simulate seam
            // u(theta).y = uStart.y * cos(theta) + tangent.y * sin(theta)
            const uStart_y = u.y;
            const tangent_y = w.z * u.x - w.x * u.z;
            let simAngle = 0;
            const steps = [];
            const baseStep = TWO_PI / Daydream.W;
            while (simAngle < a) {
                // Height
                const cosT = Math.cos(simAngle);
                const sinT = Math.sin(simAngle);
                const currentY = uStart_y * cosT + tangent_y * sinT;

                // Adaptive Step
                const scaleFactor = Math.max(0.05, Math.sqrt(Math.max(0, 1.0 - currentY * currentY)));
                const step = baseStep * scaleFactor;

                steps.push(step);
                simAngle += step;
            }

            // Normalize
            let scale = a / simAngle;
            let currentAngle = 0;
            const startC = colorFn(u, 0);
            const startColor = startC.isColor ? startC : (startC.color || startC);
            const startAlpha = startC.alpha !== undefined ? startC.alpha : 1.0;
            pipeline.plot(u, startColor, 0, startAlpha);
            const loopLimit = omitLast ? steps.length - 1 : steps.length;
            for (let i = 0; i < loopLimit; i++) {
                const step = steps[i] * scale;
                const q = quaternionPool.acquire().setFromAxisAngle(w, step);
                u.applyQuaternion(q).normalize();
                currentAngle += step;
                const t = (a > 0) ? (currentAngle / a) : 1;
                const c = colorFn(u, t);
                const color = c.isColor ? c : (c.color || c);
                const alpha = c.alpha !== undefined ? c.alpha : 1.0;
                pipeline.plot(u, color, 0, alpha);
            }
        }
    },

    Vertices: class {
        /**
         * Draws a set of vertices as individual dots.
         * @param {Object} pipeline - The render pipeline.
         * @param {number[][]} vertices - An array of [x, y, z] arrays.
         * @param {Function} colorFn - Function to determine the color (takes vector).
         */
        static draw(pipeline, vertices, colorFn) {
            let v = vectorPool.acquire();
            for (const vertex of vertices) {
                v.set(vertex[0], vertex[1], vertex[2]);
                const c = colorFn(v);
                const color = c.isColor ? c : (c.color || c);
                const alpha = c.alpha !== undefined ? c.alpha : 1.0;
                pipeline.plot(v, color, 0, alpha);
            }
        }
    },

    Polyhedron: class {
        /**
         * Samples points for the edges of a polyhedron.
         * @param {number[][]} vertices - An array of [x, y, z] vertex arrays.
         * @param {number[][]} edges - An adjacency list of vertex indices.
         * @returns {THREE.Vector3[]} An array of points forming the edges.
         */
        static sample(vertices, edges) {
            let points = [];
            edges.map((adj, i) => {
                adj.map((j) => {
                    // Push vertices
                    points.push(vectorPool.acquire().set(...vertices[i]).normalize());
                    points.push(vectorPool.acquire().set(...vertices[j]).normalize());
                })
            });
            return points;
        }

        /**
         * Draws the edges of a polyhedron by drawing lines between connected vertices.
         * @param {Object} pipeline - The render pipeline.
         * @param {number[][]} vertices - An array of [x, y, z] vertex arrays.
         * @param {number[][]} edges - An adjacency list of vertex indices.
         * @param {Function} colorFn - Function to determine the color (takes vector and normalized progress t).
         */
        static draw(pipeline, vertices, edges, colorFn) {
            edges.map((adj, i) => {
                adj.map((j) => {
                    if (i < j) {
                        Plot.Line.draw(
                            pipeline,
                            vectorPool.acquire().set(...vertices[i]).normalize(),
                            vectorPool.acquire().set(...vertices[j]).normalize(),
                            colorFn);
                    }
                })
            });
        }
    },

    Mesh: class {
        /**
         * Draws a wireframe mesh.
         * @param {Object} pipeline - Render pipeline.
         * @param {Object} mesh - The mesh object {vertices: Vector3[], faces: number[][]}.
         * @param {Function} colorFn - Color function.
         */
        static draw(pipeline, mesh, colorFn) {
            const drawn = new Set();
            for (const face of mesh.faces) {
                for (let i = 0; i < face.length; i++) {
                    const idx1 = face[i];
                    const idx2 = face[(i + 1) % face.length];

                    // Deduplicate
                    const key = idx1 < idx2 ? `${idx1},${idx2}` : `${idx2},${idx1}`;
                    if (drawn.has(key)) continue;
                    drawn.add(key);

                    Plot.Line.draw(
                        pipeline,
                        mesh.vertices[idx1],
                        mesh.vertices[idx2],
                        colorFn
                    );
                }
            }
        }
    },

    Ring: class {
        /**
         * Calculates a point on a circle that lies on the surface of the unit sphere.
         * @param {number} a - Angle.
         * @param {number} radius - Radius.
         * @param {THREE.Vector3} u - Basis U.
         * @param {THREE.Vector3} v - Basis V (Normal).
         * @param {THREE.Vector3} w - Basis W.
         * @returns {THREE.Vector3} Point.
         */
        static calcPoint(a, radius, u, v, w) {
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
        static sample(basis, radius, numSamples, phase = 0) {
            const { u, v, w } = basis;
            // Backside
            let vDir = v.clone();
            if (radius > 1) {
                vDir.negate();
                radius = 2 - radius;
            }

            const thetaEq = radius * (Math.PI / 2);
            const r = Math.sin(thetaEq);
            const d = Math.cos(thetaEq);

            // Calculate Samples
            const step = TWO_PI / numSamples;
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
         * @param {Object} pipeline - Render pipeline.
         * @param {THREE.Quaternion} orientationQuaternion - The orientation of the ring.
         * @param {THREE.Vector3} normal - The normal vector defining the ring plane.
         * @param {number} radius - The radius of the ring.
         * @param {Function} colorFn - Function to determine color.
         * @param {number} [phase=0] - Starting phase.
         */
        static draw(pipeline, basis, radius, colorFn, phase = 0) {
            const points = Plot.Ring.sample(basis, radius, Daydream.W / 4, phase);
            Plot.rasterize(pipeline, points, colorFn, true);
        }
    },

    PlanarLine: class {
        /**
         * Draws a line that is straight in the Azimuthal Equidistant projection centered at 'center'.
         * @param {Object} pipeline - Render pipeline.
         * @param {THREE.Vector3} v1 - Start point (normalized).
         * @param {THREE.Vector3} v2 - End point (normalized).
         * @param {THREE.Vector3} center - Center of projection (normalized).
         * @param {Function} colorFn - (t) => {color, alpha}.
         */
        static draw(pipeline, v1, v2, center, colorFn) {
            // Basis
            let refAxis = Daydream.X_AXIS;
            if (Math.abs(center.dot(refAxis)) > 0.9999) {
                refAxis = Daydream.Y_AXIS;
            }
            const v = center.clone(); // The 'pole'
            const ref = Math.abs(v.dot(Daydream.X_AXIS)) > 0.9 ? Daydream.Y_AXIS : Daydream.X_AXIS;
            const u = vectorPool.acquire().crossVectors(v, ref).normalize();
            const w = vectorPool.acquire().crossVectors(v, u).normalize();

            const project = (p) => {
                const R = angleBetween(p, v);
                if (R < 0.0001) return new THREE.Vector2(0, 0);
                const x = p.dot(u);
                const y = p.dot(w);
                const theta = Math.atan2(y, x);
                return new THREE.Vector2(R * Math.cos(theta), R * Math.sin(theta));
            };

            const p1 = project(v1);
            const p2 = project(v2);

            const dist = p1.distanceTo(p2);
            const numSteps = Math.max(2, Math.ceil(dist * Daydream.W / (TWO_PI)));

            let pTemp = vectorPool.acquire();

            for (let i = 0; i < numSteps; i++) {
                const t = i / (numSteps - 1);
                const Px = p1.x + (p2.x - p1.x) * t;
                const Py = p1.y + (p2.y - p1.y) * t;

                const R = Math.sqrt(Px * Px + Py * Py);
                const theta = Math.atan2(Py, Px);

                let point = vectorPool.acquire().copy(v);
                if (R > 0.0001) {
                    const sinR = Math.sin(R);
                    const cosR = Math.cos(R);
                    const cosT = Math.cos(theta);
                    const sinT = Math.sin(theta);

                    // dir = u*cosT + w*sinT
                    const dir = vectorPool.acquire().copy(u).multiplyScalar(cosT).addScaledVector(w, sinT).normalize();
                    // p = v*cosR + dir*sinR
                    point.multiplyScalar(cosR).addScaledVector(dir, sinR).normalize();
                }

                const c = colorFn(t);
                const color = c.isColor ? c : (c.color || c);
                const alpha = c.alpha !== undefined ? c.alpha : 1.0;
                pipeline.plot(point, color, 0, alpha);
            }
        }
    },

    Polygon: class {
        /**
         * Draws a polygon on the sphere surface.
         * @param {Object} pipeline - Render pipeline.
         * @param {THREE.Quaternion} orientationQuaternion - The orientation of the polygon.
         * @param {THREE.Vector3} normal - The normal vector.
         * @param {number} radius - The radius.
         * @param {number} numSides - Number of sides.
         * @param {Function} colorFn - Function to determine color.
         * @param {number} [phase=0] - Starting phase.
         */
        static draw(pipeline, basis, radius, numSides, colorFn, phase = 0) {
            const points = Plot.Polygon.sample(basis, radius, numSides, phase);
            let center = basis.v;
            if (radius > 1.0) {
                center = vectorPool.acquire().copy(basis.v).negate();
            }

            for (let i = 0; i < points.length; i++) {
                const p1 = points[i];
                const p2 = points[(i + 1) % points.length];
                Plot.PlanarLine.draw(pipeline, p1, p2, center, (t) => colorFn(p1, t));
            }
        }

        static sample(basis, radius, numSides, phase = 0) {
            // Offset sectors
            const offset = Math.PI / numSides;
            return Plot.Ring.sample(basis, radius, numSides, phase + offset);
        }
    },

    Star: class {
        static sample(basis, radius, numSides, phase = 0) {
            // Basis
            let { v, u, w } = basis;

            if (radius > 1.0) {
                v = vectorPool.acquire().copy(v).negate();
                u = vectorPool.acquire().copy(u).negate();
                radius = 2.0 - radius;
            }

            const outerRadius = radius * (Math.PI / 2);
            const innerRadius = outerRadius * 0.382;

            const points = [];
            const angleStep = Math.PI / numSides;

            for (let i = 0; i < numSides * 2; i++) {
                const theta = phase + i * angleStep;
                const r = (i % 2 === 0) ? outerRadius : innerRadius;

                const sinR = Math.sin(r);
                const cosR = Math.cos(r);
                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);

                const p = vectorPool.acquire()
                    .copy(v).multiplyScalar(cosR)
                    .addScaledVector(u, cosT * sinR)
                    .addScaledVector(w, sinT * sinR)
                    .normalize();

                points.push(p);
            }
            return points;
        }

        static draw(pipeline, basis, radius, numSides, colorFn, phase = 0) {
            const points = Plot.Star.sample(basis, radius, numSides, phase);

            let center = basis.v;
            if (radius > 1.0) {
                center = vectorPool.acquire().copy(basis.v).negate();
            }

            for (let i = 0; i < points.length; i++) {
                const p1 = points[i];
                const p2 = points[(i + 1) % points.length];
                Plot.PlanarLine.draw(pipeline, p1, p2, center, (t) => colorFn(p1, t));
            }
        }
    },

    Flower: class {
        static sample(basis, radius, numSides, phase = 0) {
            let { v, u, w } = basis;

            if (radius > 1.0) {
                // Antipode basis
                v = vectorPool.acquire().copy(v).negate();
                u = vectorPool.acquire().copy(u).negate();

                radius = 2.0 - radius;
            }

            // Draw boundary relative to antipode
            const desiredOuterRadius = radius * (Math.PI / 2);
            const apothem = Math.PI - desiredOuterRadius;
            const angleStep = Math.PI / numSides;

            const points = [];
            const numSegments = Math.max(2, Math.floor(Daydream.W / numSides)); // Resolution per side

            // Sample boundary: R(phi) = apothem / cos(phi)
            for (let i = 0; i < numSides; i++) {
                const sectorCenter = phase + i * 2 * angleStep;

                for (let j = 0; j < numSegments; j++) {
                    const t = j / numSegments;
                    const localPhi = -angleStep + t * (2 * angleStep);
                    let R = apothem / Math.cos(localPhi);
                    if (R > Math.PI) R = Math.PI;

                    const theta = sectorCenter + localPhi;

                    // Convert Polar (R, theta)
                    const sinR = Math.sin(R);
                    const cosR = Math.cos(R);
                    const cosT = Math.cos(theta);
                    const sinT = Math.sin(theta);

                    const p = vectorPool.acquire()
                        .copy(v).multiplyScalar(cosR)
                        .addScaledVector(u, cosT * sinR)
                        .addScaledVector(w, sinT * sinR)
                        .normalize();

                    points.push(p);
                }
            }

            // Close loop
            if (points.length > 0) {
                points.push(vectorPool.acquire().copy(points[0]));
            }

            return points;
        }

        static draw(pipeline, basis, radius, numSides, colorFn, phase = 0) {
            const points = Plot.Flower.sample(basis, radius, numSides, phase);
            Plot.rasterize(pipeline, points, colorFn, false);
        }
    },

    DistortedRing: class {


        /**
         * Calculates a single point on a sphere distorted by a function.
         * @param {Function} f - The shift function.
         * @param {THREE.Vector3} normal - The normal.
         * @param {number} radius - The base radius.
         * @param {number} angle - The angle.
         */
        static point(f, basis, radius, angle) { // f, basis, radius, angle
            let { u, v, w } = basis;

            if (radius > 1) {
                // Flip basis
                v = vectorPool.acquire().copy(v).negate();
                u = vectorPool.acquire().copy(u).negate();
                radius = 2 - radius;
            }

            let vi = Plot.Ring.calcPoint(angle, radius, u, v, w);
            let vp = Plot.Ring.calcPoint(angle, 1, u, v, w);
            let axis = vectorPool.acquire().crossVectors(v, vp).normalize();
            let shift = new THREE.Quaternion().setFromAxisAngle(axis, f(angle * Math.PI / 2));
            return vi.applyQuaternion(shift);
        }

        /**
         * Samples points for a function-distorted ring.
         * @param {THREE.Quaternion} orientationQuaternion - Orientation.
         * @param {THREE.Vector3} normal - Normal.
         * @param {number} radius - Radius.
         * @param {Function} shiftFn - Shift function.
         * @param {number} [phase=0] - Phase.
         */
        static sample(basis, radius, shiftFn, phase = 0) {
            // Basis
            const { v, u, w } = basis;

            // Backside
            let vSign = 1.0;
            if (radius > 1) {
                vSign = -1.0;
                radius = 2 - radius;
            }

            // Projection
            const thetaEq = radius * (Math.PI / 2);
            const r = Math.sin(thetaEq);
            const d = Math.cos(thetaEq);

            // Calculate Samples
            const numSamples = Daydream.W;
            const step = TWO_PI / numSamples;
            let points = [];
            let uTemp = vectorPool.acquire();

            for (let i = 0; i < numSamples; i++) {
                let theta = i * step;
                let t = theta + phase;
                let cosRing = Math.cos(t);
                let sinRing = Math.sin(t);
                uTemp.copy(u).multiplyScalar(cosRing).addScaledVector(w, sinRing);

                // Shift
                let shift = shiftFn(theta / (TWO_PI));
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
         * Draws a function-distorted ring.
         * @param {Object} pipeline - Render pipeline.
         * @param {THREE.Quaternion} orientationQuaternion - Orientation.
         * @param {THREE.Vector3} normal - Normal.
         * @param {number} radius - Radius.
         * @param {Function} shiftFn - Shift function.
         * @param {Function} colorFn - Color function.
         * @param {number} [phase=0] - Phase.
         */
        static draw(pipeline, basis, radius, shiftFn, colorFn, phase = 0) {
            const points = Plot.DistortedRing.sample(basis, radius, shiftFn, phase);
            Plot.rasterize(pipeline, points, colorFn, true);
        }
    },

    Spiral: class {

        /**
         * Samples points forming a Fibonacci spiral pattern.
         * @param {number} n - Total number of points.
         * @param {number} eps - Epsilon value for spiral offset.
         * @returns {THREE.Vector3[]} An array of points.
         */
        static sample(n, eps) {
            const points = [];
            for (let i = 0; i < n; ++i) {
                points.push(fibSpiral(n, eps, i));
            }
            return points;
        }

        /**
         * Draws points forming a Fibonacci spiral pattern.
         * @param {Object} pipeline - Render pipeline.
         * @param {number} n - Total number of points.
         * @param {number} eps - Epsilon value for spiral offset.
         * @param {Function} colorFn - Function to determine the color (takes vector).
         */
        static draw(pipeline, n, eps, colorFn) {
            const points = Plot.Spiral.sample(n, eps);
            for (const v of points) {
                const c = colorFn(v);
                const color = c.isColor ? c : (c.color || c);
                const alpha = c.alpha !== undefined ? c.alpha : 1.0;
                pipeline.plot(v, color, 0, alpha);
            }
        }
    },

    /**
     * Rasterizes a list of points into Dot objects by connecting them with geodesic lines.
     * @param {Object} pipeline - The render pipeline.
     * @param {THREE.Vector3[]} points - The list of points.
     * @param {Function} colorFn - Function to determine color (takes vector and normalized progress t).
     * @param {boolean} [closeLoop=false] - If true, connects the last point to the first.
     */
    rasterize: (pipeline, points, colorFn, closeLoop = false) => {
        const len = points.length;
        if (len === 0) return;

        const count = closeLoop ? len : len - 1;
        for (let i = 0; i < count; i++) {
            const p1 = points[i];
            const p2 = points[(i + 1) % len];

            const segmentColorFn = (p, subT) => {
                const globalT = (i + subT) / count;
                return colorFn(p, globalT);
            };

            // Draw segment
            const omitLast = closeLoop || (i < count - 1);
            Plot.Line.draw(pipeline, p1, p2, segmentColorFn, 0, 1, false, omitLast);
        }
    }

};
