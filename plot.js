/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween, fibSpiral, makeBasis, getAntipode } from "./geometry.js";
import { TWO_PI } from "./3dmath.js";
import { vectorPool, quaternionPool, fragmentPool } from "./memory.js";
import { deepTween } from "./animation.js";

const _scratchFrag = new fragmentPool.Type();
const _scratchVec = new THREE.Vector3();

// --- Interpolation Strategies (Factories) ---

/**
 * Creates a Geodesic (Great Circle) interpolator.
 * Returns: (p1, p2) => { dist, map(t, out) }
 */
const GeodesicStrategy = () => {
    const axis = new THREE.Vector3();

    return (p1, p2) => {
        let dist = angleBetween(p1, p2);

        if (dist < 1e-5) return { dist: 0, map: (t, out) => out.copy(p1) };

        axis.crossVectors(p1, p2).normalize();
        if (axis.lengthSq() < 0.001) {
            const ref = Math.abs(p1.dot(Daydream.X_AXIS)) > 0.9 ? Daydream.Y_AXIS : Daydream.X_AXIS;
            axis.crossVectors(p1, ref).normalize();
        }

        return {
            dist,
            map: (t, out) => {
                const q = quaternionPool.acquire().setFromAxisAngle(axis, dist * t);
                out.copy(p1).applyQuaternion(q);
            }
        };
    };
};

/**
 * Creates a Planar (Azimuthal Equidistant) interpolator relative to a basis.
 * The distortion of this projection is what creates 'Flower' shapes when
 * the points are located near the antipode (R ~ PI).
 */
const PlanarStrategy = (basis) => {
    const { u, v: center, w } = basis;
    const axis = new THREE.Vector3();

    const project = (p) => {
        const R = angleBetween(p, center);
        if (R < 1e-5) return { x: 0, y: 0 };
        // Note: When R ~ PI, dot products approach 0, but atan2 recovers the angle
        // because u/w are orthogonal to center.
        const x = p.dot(u);
        const y = p.dot(w);
        const theta = Math.atan2(y, x);
        return { x: R * Math.cos(theta), y: R * Math.sin(theta) };
    };

    return (p1, p2) => {
        const proj1 = project(p1);
        const proj2 = project(p2);
        const dx = proj2.x - proj1.x;
        const dy = proj2.y - proj1.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        return {
            dist,
            map: (t, out) => {
                // Lerp in 2D Plane (Chord)
                const Px = proj1.x + dx * t;
                const Py = proj1.y + dy * t;

                // Unproject 2D -> 3D Sphere
                const R = Math.sqrt(Px * Px + Py * Py);
                out.copy(center);

                if (R > 1e-5) {
                    const theta = Math.atan2(Py, Px);
                    axis.copy(u).multiplyScalar(Math.cos(theta)).addScaledVector(w, Math.sin(theta));
                    out.multiplyScalar(Math.cos(R)).addScaledVector(axis, Math.sin(R));
                }
            }
        };
    };
};

export const Plot = {
    Point: class {
        /**
         * Draws a single point.
         * Registers: None (Points only)
         * @param {Object} pipeline - Render pipeline
         * @param {THREE.Vector3} v - Position
         * @param {Function} fragmentShaderFn - Shader function (v, t)
         * @param {number} age - Age of operation
         */
        static draw(pipeline, v, fragmentShaderFn, age = 0) {
            const res = fragmentShaderFn(v, 0);
            const color = res.isColor ? res : (res.color || res);
            const alpha = res.alpha !== undefined ? res.alpha : 1.0;
            const tag = res.tag;
            pipeline.plot(v, color, age, alpha, tag);
        }
    },

    Line: class {
        /**
         * Samples a geodesic line between two points.
         * Registers:
         *  v0: Interpolation factor t (0.0 -> 1.0)
         *  v1: Arc Length (radians) from v1
         * @param {THREE.Vector3} v1 - Start point
         * @param {THREE.Vector3} v2 - End point
         * @param {number} numSamples - Number of samples
         * @returns {Object[]} Array of fragments
         */
        static sample(v1, v2, numSamples = 10) {
            let u = vectorPool.acquire().copy(v1);
            let v = vectorPool.acquire().copy(v2);
            let angle = angleBetween(u, v);
            let axis = vectorPool.acquire().crossVectors(u, v).normalize();

            if (Math.abs(angle) < 0.0001) {
                const f = fragmentPool.acquire();
                f.pos.copy(u);
                f.v0 = 0;
                f.v1 = 0;
                return [f];
            }

            let points = [];
            for (let i = 0; i <= numSamples; i++) {
                let t = i / numSamples;
                let q = quaternionPool.acquire().setFromAxisAngle(axis, angle * t);

                let p = fragmentPool.acquire();
                p.pos.copy(u).applyQuaternion(q);
                p.v0 = t;
                p.v1 = angle * t; // Cumulative Arc Length

                points.push(p);
            }
            return points;
        }

        /**
         * Draws a geodesic line between two points.
         * Registers:
         *  v0: line progress (0..1)
         *  v1: Arc Length (0..2PI)
         * @param {Object} pipeline - Render pipeline
         * @param {THREE.Vector3} v1 - Start point
         * @param {THREE.Vector3} v2 - End point
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} start - Start t (0.0-1.0)
         * @param {number} end - End t (0.0-1.0)
         * @param {boolean} longWay - Whether to take the long path
         * @param {boolean} omitLast - Whether to skip the last point
         * @param {number} age - Age of the operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, v1, v2, fragmentShaderFn, start = 0, end = 1, longWay = false, omitLast = false, age = 0, vertexShaderFn = null) {
            let u = vectorPool.acquire().copy(v1);
            let v = vectorPool.acquire().copy(v2);
            let a = angleBetween(u, v);
            let w = vectorPool.acquire();

            if (Math.abs(a) < 0.0001) {
                return;
            }

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

            const angleStart = a * start;
            const angleEnd = a * end;

            if (start !== 0) {
                let q = quaternionPool.acquire().setFromAxisAngle(w, angleStart);
                u.applyQuaternion(q).normalize();
            }
            v.copy(u);
            let p2Vec = vectorPool.acquire().copy(v1);
            let qEnd = quaternionPool.acquire().setFromAxisAngle(w, angleEnd);
            p2Vec.applyQuaternion(qEnd).normalize();

            const p1 = fragmentPool.acquire();
            const p2 = fragmentPool.acquire();

            p1.pos.copy(u);
            p1.v0 = start;
            p1.v1 = angleStart;

            p2.pos.copy(p2Vec);
            p2.v0 = end;
            p2.v1 = angleEnd;

            if (vertexShaderFn) {
                vertexShaderFn(p1);
                vertexShaderFn(p2);
            }

            const arcLength = Math.abs(angleEnd - angleStart);
            const points = [p1];

            if (arcLength > Math.PI) {
                const midAngle = (angleStart + angleEnd) / 2;
                const pMid = fragmentPool.acquire();
                const tempVec = vectorPool.acquire().copy(v1);
                const qMid = quaternionPool.acquire().setFromAxisAngle(w, midAngle);
                pMid.pos.copy(tempVec.applyQuaternion(qMid).normalize());
                pMid.v0 = (start + end) / 2;
                pMid.v1 = midAngle;

                if (vertexShaderFn) {
                    vertexShaderFn(pMid);
                }

                points.push(pMid);
            }

            points.push(p2);

            Plot.rasterize(pipeline, points, fragmentShaderFn, false, age);
        }
    },

    Mesh: class {
        /**
         * Samples edges of a mesh.
         * Registers:
         *  v0: Interpolation factor t (0.0 -> 1.0) per edge
         *  v1: Cumulative Arc Length (radians) per edge
         * @param {Object} mesh - Mesh object with {vertices, faces}
         * @param {number} density - Sampling density
         * @returns {Object[]} Array of fragments (edges array)
         */
        static sample(mesh, density = 10) {
            const edges = [];
            const drawn = new Set();
            for (const face of mesh.faces) {
                for (let i = 0; i < face.length; i++) {
                    const idx1 = face[i];
                    const idx2 = face[(i + 1) % face.length];
                    const key = idx1 < idx2 ? `${idx1},${idx2}` : `${idx2},${idx1}`;
                    if (drawn.has(key)) continue;
                    drawn.add(key);
                    edges.push(Plot.Line.sample(mesh.vertices[idx1], mesh.vertices[idx2], density));
                }
            }
            return edges;
        }

        /**
         * Draws a mesh.
         * Registers:
         *  v0: Edge Progress t (0.0 -> 1.0) per edge
         *  v1: Cumulative Arc Length (radians) per edge
         *  v2: Edge Index
         * @param {Object} pipeline - Render pipeline
         * @param {Object} mesh - Mesh object
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} age - Age of operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, mesh, fragmentShaderFn, age = 0, vertexShaderFn = null) {
            const edges = Plot.Mesh.sample(mesh);
            for (let i = 0; i < edges.length; i++) {
                const edge = edges[i];
                if (vertexShaderFn) {
                    for (let j = 0; j < edge.length; j++) {
                        const frag = edge[j];
                        frag.v2 = i;
                        // Updated: Zero-Copy
                        vertexShaderFn(frag);
                    }
                }
                Plot.rasterize(pipeline, edge, fragmentShaderFn, false, age);
            }
        }
    },

    Ring: class {
        static calcPoint(a, radius, u, v, w) {
            let d = Math.sqrt(Math.pow(1 - radius, 2));
            return vectorPool.acquire().set(
                d * v.x + radius * u.x * Math.cos(a) + radius * w.x * Math.sin(a),
                d * v.y + radius * u.y * Math.cos(a) + radius * w.y * Math.sin(a),
                d * v.z + radius * u.z * Math.cos(a) + radius * w.z * Math.sin(a)
            ).normalize();
        }

        /**
         * Samples a ring/circle on the sphere.
         * Registers:
         *  v0: Angular progress (0.0 -> 1.0) around ring
         *  v1: Arc Length (radians)
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSamples - Number of points
         * @param {number} phase - Rotation offset
         * @returns {Object[]} Array of fragments
         */
        static sample(basis, radius, numSamples, phase = 0) {
            const res = getAntipode(basis, radius);
            const { u, v, w } = res.basis;
            radius = res.radius;

            const thetaEq = radius * (Math.PI / 2);
            const r = Math.sin(thetaEq);
            const d = Math.cos(thetaEq);

            const step = TWO_PI / numSamples;
            const arcLengthScale = Math.sin(radius);
            let points = [];
            let uTemp = vectorPool.acquire();

            for (let i = 0; i < numSamples; i++) {
                let theta = i * step;
                let t = theta + phase;
                let cosRing = Math.cos(t);
                let sinRing = Math.sin(t);
                uTemp.copy(u).multiplyScalar(cosRing).addScaledVector(w, sinRing);

                let p = fragmentPool.acquire();
                p.pos.copy(v).multiplyScalar(d).addScaledVector(uTemp, r).normalize();
                p.v0 = i / numSamples;
                p.v1 = theta * arcLengthScale;
                p.v2 = i;
                points.push(p);
            }

            // Manual Close (Overlap)
            // Ensures texture flows from 0.999 -> 1.0 continuously
            if (points.length > 0) {
                const first = points[0];
                const last = fragmentPool.acquire();
                last.pos.copy(first.pos);
                last.v0 = 1.0;
                last.v1 = TWO_PI * arcLengthScale;
                last.v2 = numSamples;
                points.push(last);
            }
            return points;
        }

        /**
         * Draws a ring/circle on the sphere.
         * Registers:
         *  v0: Angular progress (0.0 -> 1.0)
         *  v1: Arc Length (radians)
         *  v2: Index
         * @param {Object} pipeline - Render pipeline
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} phase - Rotation offset
         * @param {number} age - Age of the operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, basis, radius, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            const numSamples = Daydream.W / 4;
            let points = Plot.Ring.sample(basis, radius, numSamples, phase);

            if (vertexShaderFn) {
                for (const p of points) {
                    // Updated: Zero-Copy
                    vertexShaderFn(p);
                }
            }

            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age);
        }
    },

    PlanarLine: class {
        /**
         * Samples a straight line in the projection.
         * Registers:
         *  v0: Line progress t (0.0 -> 1.0)
         * @param {THREE.Vector3} v1 - Start
         * @param {THREE.Vector3} v2 - End
         * @returns {Object[]} Start and End fragments
         */
        static sample(v1, v2) {
            const dx = v1.x - v2.x;
            // Euclidean distance for Planar Line
            const dist = v1.distanceTo(v2);

            const p1 = fragmentPool.acquire();
            p1.pos.copy(v1); p1.v0 = 0; p1.v1 = 0;
            const p2 = fragmentPool.acquire();
            p2.pos.copy(v2); p2.v0 = 1; p2.v1 = dist;
            return [p1, p2];
        }

        /**
         * Draws a straight line in the projection.
         * Registers:
         *  v0: Line progress t (0.0 -> 1.0)
         *  v1: Length (Euclidean distance)
         * @param {Object} pipeline - Render pipeline
         * @param {THREE.Vector3} v1 - Start
         * @param {THREE.Vector3} v2 - End
         * @param {THREE.Vector3} center - Center of projection
         * @param {Function} fragmentShaderFn - Shader function (takes v0)
         * @param {number} age - Age of operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, v1, v2, center, fragmentShaderFn, age = 0, vertexShaderFn = null) {
            const points = Plot.PlanarLine.sample(v1, v2);
            if (vertexShaderFn) {
                for (const p of points) {
                    // Updated: Zero-Copy
                    vertexShaderFn(p);
                }
            }

            // Construct basis on the fly for PlanarLine
            const ref = Math.abs(center.dot(Daydream.X_AXIS)) > 0.9 ? Daydream.Y_AXIS : Daydream.X_AXIS;
            const u = vectorPool.acquire().crossVectors(center, ref).normalize();
            const w = vectorPool.acquire().crossVectors(center, u).normalize();

            Plot.rasterize(pipeline, points, (v, frag) => fragmentShaderFn(frag.v0), false, age, { u, v: center, w });
        }
    },

    SphericalPolygon: class {
        /**
         * Samples a regular polygon (Geodesic edges).
         * Registers:
         *  v0: Normalized parameter (0.0 -> 1.0) around perimeter
         *  v1: Cumulative Arc Length (radians)
         *  v2: Cumulative Integer Index (0, 1, 2...). Fract(v2) is local edge t.
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSides - Number of sides
         * @param {number} phase - Rotation offset
         * @returns {Object[]} Array of fragments
         */
        static sample(basis, radius, numSides, phase = 0) {
            const points = Plot.Ring.sample(basis, radius, numSides, phase + Math.PI / numSides);

            // Re-calculate v1 to be true geodesic chord length
            let cumulativeLength = 0;
            for (let i = 0; i < points.length; i++) {
                points[i].v2 = i; // Ensure index is strictly monotonic

                if (i > 0) {
                    cumulativeLength += angleBetween(points[i - 1].pos, points[i].pos);
                }
                points[i].v1 = cumulativeLength;
            }
            // Note: Since Ring now duplicates the first point at end (Manual Close),
            // points.length is numSides + 1. The loop above correctly calculates
            // the full perimeter length for the last point.

            return points;
        }


        /**
         * Draws a regular polygon (Geodesic edges).
         * Registers:
         *  v0: Perimeter progress (0.0 -> 1.0)
         *  v1: Arc Length (radians)
         *  v2: Vertex index (0, 1, 2...)
         * @param {Object} pipeline - Render pipeline
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSides - Number of sides
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} phase - Rotation offset
         * @param {number} age - Age of operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.SphericalPolygon.sample(basis, radius, numSides, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    // Updated: Zero-Copy
                    vertexShaderFn(p);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, null);
        }
    },

    PlanarPolygon: class {
        /**
         * Samples a regular polygon (Planar edges).
         * Registers:
         *  v0: Normalized parameter (0.0 -> 1.0) around perimeter
         *  v1: Cumulative Arc Length (radians, approximate along chords)
         *  v2: Cumulative Integer Index (0, 1, 2...). Fract(v2) is local edge t.
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSides - Number of sides
         * @param {number} phase - Rotation offset
         * @returns {Object[]} Array of fragments
         */
        static sample(basis, radius, numSides, phase = 0) {
            // Ring.sample now handles v0, v1, v2 and closing
            const points = Plot.Ring.sample(basis, radius, numSides, phase + Math.PI / numSides);
            return points;
        }

        /**
         * Draws a regular polygon (Planar edges).
         * Registers:
         *  v0: Perimeter progress (0.0 -> 1.0)
         *  v1: Arc Length (radians)
         *  v2: Vertex index (0, 1, 2...)
         * @param {Object} pipeline - Render pipeline
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSides - Number of sides
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} phase - Rotation offset
         * @param {number} age - Age of operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.PlanarPolygon.sample(basis, radius, numSides, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    // Updated: Zero-Copy
                    vertexShaderFn(p);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, basis);
        }
    },

    Star: class {
        /**
         * Samples a star shape.
         * Registers:
         *  v0: Normalized parameter (0.0 -> 1.0)
         *  v1: Cumulative Integer Index (0, 1, 2...). 0=Tip, 1=Valley, etc.
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSides - Number of sides
         * @param {number} phase - Rotation offset
         * @returns {Object[]} Array of fragments
         */
        static sample(basis, radius, numSides, phase = 0) {
            const res = getAntipode(basis, radius);
            const { u, v, w } = res.basis;
            radius = res.radius;

            const outerRadius = radius * (Math.PI / 2);
            const innerRadius = outerRadius * 0.382;

            const points = [];
            const angleStep = Math.PI / numSides;

            let cumulativeLength = 0;
            for (let i = 0; i < numSides * 2; i++) {
                const theta = phase + i * angleStep;
                const r = (i % 2 === 0) ? outerRadius : innerRadius;

                const sinR = Math.sin(r);
                const cosR = Math.cos(r);
                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);

                const p = fragmentPool.acquire();
                p.pos.copy(v).multiplyScalar(cosR)
                    .addScaledVector(u, cosT * sinR)
                    .addScaledVector(w, sinT * sinR)
                    .normalize();

                if (i > 0) {
                    cumulativeLength += angleBetween(points[i - 1].pos, p.pos);
                }

                p.v0 = i / (numSides * 2);
                p.v1 = cumulativeLength;
                p.v2 = i;
                points.push(p);
            }

            // Manual Close (Overlap)
            if (points.length > 0) {
                const first = points[0];
                const last = fragmentPool.acquire();
                last.pos.copy(first.pos);
                last.v0 = 1.0;

                // Add final chord
                cumulativeLength += angleBetween(points[points.length - 1].pos, first.pos);
                last.v1 = cumulativeLength;
                last.v2 = numSides * 2;
                points.push(last);
            }

            return points;
        }

        /**
         * Draws a star shape.
         * Registers:
         *  v0: Perimeter progress (0.0 -> 1.0)
         *  v1: Arc Length (radians)
         *  v2: Vertex index (0, 1, 2...)
         * @param {Object} pipeline - Render pipeline
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSides - Number of sides
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} phase - Rotation offset
         * @param {number} age - Age of operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.Star.sample(basis, radius, numSides, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    // Updated: Zero-Copy
                    vertexShaderFn(p);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, basis);
        }
    },

    Flower: class {
        /**
         * Samples a flower shape.
         * Registers:
         *  v0: Normalized parameter (0.0 -> 1.0)
         *  v1: Cumulative Integer Index (0, 1, 2...)
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSides - Number of sides
         * @param {number} phase - Rotation offset
         * @returns {Object[]} Array of fragments
         */
        static sample(basis, radius, numSides, phase = 0) {
            // Check for flip (needed for correct geometry generation)
            const res = getAntipode(basis, radius);
            const workBasis = res.basis;
            const workRadius = res.radius;

            const desiredOuterRadius = workRadius * (Math.PI / 2);
            const apothem = Math.PI - desiredOuterRadius;
            const safeApothem = Math.min(apothem, Math.PI - 1e-4);
            const angleStep = Math.PI / numSides;

            const points = [];

            let cumulativeLength = 0;

            for (let i = 0; i < numSides * 2; i++) {
                const theta = phase + i * angleStep;
                const R = safeApothem;

                const p = fragmentPool.acquire();

                // Unproject Polar -> Sphere
                const sinR = Math.sin(R);
                const cosR = Math.cos(R);
                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);

                p.pos.copy(workBasis.v).multiplyScalar(cosR)
                    .addScaledVector(workBasis.u, cosT * sinR)
                    .addScaledVector(workBasis.w, sinT * sinR)
                    .normalize();

                if (i > 0) {
                    cumulativeLength += angleBetween(points[i - 1].pos, p.pos);
                }

                p.v0 = i / (numSides * 2);
                p.v1 = cumulativeLength;
                p.v2 = i;
                points.push(p);
            }

            // Close loop
            if (points.length > 0) {
                const first = points[0];
                const last = fragmentPool.acquire();
                last.pos.copy(first.pos);
                last.v0 = 1.0;
                // Accumulate last segment length
                cumulativeLength += angleBetween(points[points.length - 1].pos, first.pos);
                last.v1 = cumulativeLength;
                last.v2 = numSides * 2;
                points.push(last);
            }
            return points;
        }

        /**
         * Draws a flower shape.
         * Registers:
         *  v0: Perimeter progress (0.0 -> 1.0)
         *  v1: Arc Length (radians)
         *  v2: Vertex index (0, 1, 2...)
         * @param {Object} pipeline - Render pipeline
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {number} numSides - Number of sides
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} phase - Rotation offset
         * @param {number} age - Age of operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            const res = getAntipode(basis, radius);
            const workBasis = res.basis;

            let points = Plot.Flower.sample(basis, radius, numSides, phase);

            if (vertexShaderFn) {
                for (const p of points) {
                    // Updated: Zero-Copy
                    vertexShaderFn(p);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, workBasis);
        }
    },

    DistortedRing: class {
        /**
         * Samples a distorted ring.
         * Registers:
         *  v0: Angular progress (0.0 -> 1.0)
         *  v1: Arc Length (radians)
         *  v2: Index (0, 1, 2...)
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {Function} shiftFn - Distortion function relative to theta
         * @param {number} phase - Rotation offset
         * @returns {Object[]} Array of fragments
         */
        static sample(basis, radius, shiftFn, phase = 0) {
            const res = getAntipode(basis, radius);
            const { u, v, w } = res.basis;
            radius = res.radius;

            const thetaEq = radius * (Math.PI / 2);
            const r = Math.sin(thetaEq);
            const d = Math.cos(thetaEq);

            const numSamples = Daydream.W;
            const step = TWO_PI / numSamples;
            let points = [];
            let uTemp = vectorPool.acquire();
            let cumulativeLength = 0;

            for (let i = 0; i < numSamples; i++) {
                let theta = i * step;
                let t = theta + phase;
                let cosRing = Math.cos(t);
                let sinRing = Math.sin(t);
                uTemp.copy(u).multiplyScalar(cosRing).addScaledVector(w, sinRing);

                let shift = shiftFn(theta / (TWO_PI));
                let cosShift = Math.cos(shift);
                let sinShift = Math.sin(shift);
                let vScale = d * cosShift - r * sinShift;
                let uScale = r * cosShift + d * sinShift;

                let p = fragmentPool.acquire();
                p.pos.copy(v).multiplyScalar(vScale).addScaledVector(uTemp, uScale).normalize();

                if (i > 0) {
                    cumulativeLength += angleBetween(points[i - 1].pos, p.pos);
                }

                p.v0 = i / numSamples;
                p.v1 = cumulativeLength;
                p.v2 = i;
                points.push(p);
            }

            // Manual Close (Overlap)
            if (points.length > 0) {
                const first = points[0];
                const last = fragmentPool.acquire();
                last.pos.copy(first.pos);
                last.v0 = 1.0;

                // Accumulate last segment
                cumulativeLength += angleBetween(points[points.length - 1].pos, first.pos);
                last.v1 = cumulativeLength;
                last.v2 = numSamples;
                points.push(last);
            }

            return points;
        }

        /**
         * Draws a distorted ring.
         * Registers:
         *  v0: Angular progress (0.0 -> 1.0)
         *  v1: Arc Length (radians)
         *  v2: Index
         * @param {Object} pipeline - Render pipeline
         * @param {Object} basis - Coordinate basis {u, v, w}
         * @param {number} radius - Radius in radians
         * @param {Function} shiftFn - Distortion function relative to theta
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} phase - Rotation offset
         * @param {number} age - Age of operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, basis, radius, shiftFn, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.DistortedRing.sample(basis, radius, shiftFn, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    // Updated: Zero-Copy
                    vertexShaderFn(p);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age);
        }
    },

    Spiral: class {
        /**
         * Samples a Fibonacci spiral.
         * Registers: None (Points only)
         * @param {number} n - Number of points
         * @param {number} eps - Epsilon/Parameter
         * @returns {THREE.Vector3[]} Array of points
         */
        static sample(n, eps) {
            const points = [];
            for (let i = 0; i < n; ++i) {
                points.push(fibSpiral(n, eps, i));
            }
            return points;
        }

        /**
         * Draws a Fibonacci spiral.
         * Registers: None
         * @param {Object} pipeline - Render pipeline
         * @param {number} n - Number of points
         * @param {number} eps - Epsilon/Parameter
         * @param {Function} fragmentShaderFn - Shader function
         * @param {number} age - Age of operation
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, n, eps, fragmentShaderFn, age = 0, vertexShaderFn = null) {
            const points = Plot.Spiral.sample(n, eps);
            for (const p of points) {
                // Standardization: Wrap Vector3 in Fragment
                const frag = fragmentPool.acquire();
                frag.pos.copy(p);
                // Default registers?

                if (vertexShaderFn) vertexShaderFn(frag);

                // ShaderFn now receives Fragment (standard)
                const res = fragmentShaderFn(frag);
                const color = res.isColor ? res : (res.color || res);
                const alpha = res.alpha !== undefined ? res.alpha : 1.0;
                const tag = res.tag;
                pipeline.plot(frag.pos, color, age, alpha, tag);
            }
        }
    },

    ParticleSystem: class {
        /**
         * Iterates over particle trails.
         * Registers: None (Points only)
         * @param {Object} system - Particle system
         * @param {Function} callback - (points, particle) => void
         */
        static forEachTrail(system, callback) {
            const buffer = Plot.ParticleSystem._sampleBuffer || (Plot.ParticleSystem._sampleBuffer = []);
            const particles = system.particles;
            const count = system.activeCount !== undefined ? system.activeCount : particles.length;

            for (let i = 0; i < count; i++) {
                const p = particles[i];
                if (p.history.length() < 2) continue;

                buffer.length = 0;
                deepTween(p.history, (q, t) => {
                    let v = vectorPool.acquire().copy(p.position).applyQuaternion(q);
                    buffer.push(v);
                });

                callback(buffer, p);
            }
        }

        /**
         * Samples particle trails.
         * Registers: None (Points only)
         * @param {Object} system - Particle system
         * @returns {Object[]} Array of {points, particle}
         */
        static sample(system) {
            const trails = [];
            Plot.ParticleSystem.forEachTrail(system, (points, particle) => {
                trails.push({ points: [...points], particle });
            });
            return trails;
        }

        /**
         * Draws particle trails.
         * Registers:
         *  v0: Interpolation factor t (0.0 -> 1.0) along each segment
         * @param {Object} pipeline - Render pipeline
         * @param {Object} particleSystem - Particle system
         * @param {Function} fragmentShaderFn - Shader function
         * @param {Function} vertexShaderFn - Vertex displacement function
         */
        static draw(pipeline, particleSystem, fragmentShaderFn, vertexShaderFn = null) {
            Plot.ParticleSystem.forEachTrail(particleSystem, (points, particle) => {
                const count = points.length;
                const fragments = [];
                for (let i = 0; i < count; i++) {
                    const f = fragmentPool.acquire();
                    f.pos.copy(points[i]);
                    // Standard registers for Line/Trail
                    f.v0 = (count > 1) ? i / (count - 1) : 0;
                    f.v1 = i;
                    if (vertexShaderFn) {
                        vertexShaderFn(f);
                    }
                    fragments.push(f);
                }

                Plot.rasterize(pipeline, fragments, (v, t) => fragmentShaderFn(v, t, particle), false, 0);
            });
        }
    },

    /**
     * Rasterizes a list of points connecting them with Geodesic or Planar lines.
     * Uses a "Simulate & Scale" approach to ensure adaptive steps land precisely on endpoints.
     * @param {Object} pipeline - Render pipeline.
     * @param {Object[]} points - List of points.
     * @param {Function} shaderFn - Color function.
     * @param {boolean} [closeLoop=false] - Connect last to first.
     * @param {number} [age=0] - Age.
     * @param {Object} [planarBasis=null] - {u, v, w} If provided, uses Planar interpolation.
     */
    rasterize: (pipeline, points, shaderFn, closeLoop = false, age = 0, planarBasis = null) => {
        const len = points.length;
        if (len < 2) return;

        const createInterpolator = planarBasis
            ? PlanarStrategy(planarBasis)
            : GeodesicStrategy();

        const count = closeLoop ? len : len - 1;
        const pTemp = vectorPool.acquire();
        const steps = [];

        for (let i = 0; i < count; i++) {
            const curr = points[i];
            const next = points[(i + 1) % len];
            const p1 = curr.pos || curr;
            const p2 = next.pos || next;

            const { dist: totalDist, map } = createInterpolator(p1, p2);

            // Handle Degenerate Segment
            if (totalDist < 1e-5) {
                const isLastSegment = (i === count - 1);
                const shouldOmit = closeLoop || !isLastSegment;

                if (!shouldOmit) {
                    lerpFragments(curr, next, 0, _scratchFrag);
                    const res = shaderFn(p1, _scratchFrag);
                    pipeline.plot(p1, res.color || res, age, res.alpha ?? 1.0, res.tag);
                }
                continue;
            }

            // Simulation Phase
            steps.length = 0;
            let simDist = 0;
            const baseStep = TWO_PI / Daydream.W;
            map(0, pTemp);
            while (simDist < totalDist) {
                const scaleFactor = Math.max(0.05, Math.sqrt(Math.max(0, 1.0 - pTemp.y * pTemp.y)));
                const step = baseStep * scaleFactor;
                steps.push(step);
                simDist += step;

                if (simDist < totalDist) {
                    map(simDist / totalDist, pTemp);
                }
            }

            const scale = (simDist > 0) ? (totalDist / simDist) : 0;
            const isLastSegment = (i === count - 1);
            const omitLast = closeLoop || !isLastSegment;
            if (omitLast && steps.length === 0) continue;

            // Draw Start Point
            map(0, pTemp);
            lerpFragments(curr, next, 0, _scratchFrag);
            let res = shaderFn(pTemp, _scratchFrag);
            pipeline.plot(pTemp, res.color, age, res.alpha, res.tag);

            // Draw Steps
            const loopLimit = omitLast ? steps.length - 1 : steps.length;
            let currentDist = 0;
            for (let j = 0; j < loopLimit; j++) {
                const step = steps[j] * scale;
                currentDist += step;

                const t = (totalDist > 0) ? (currentDist / totalDist) : 1;

                map(t, pTemp);

                lerpFragments(curr, next, t, _scratchFrag);
                res = shaderFn(pTemp, _scratchFrag);
                pipeline.plot(pTemp, res.color, age, res.alpha, res.tag);
            }
        }
    },
};

/**
 * Linearly interpolates fragment registers (v0-v3).
 * @param {Object} f1 - Start fragment.
 * @param {Object} f2 - End fragment.
 * @param {number} t - Interpolation factor (0-1).
 * @param {Object} out - Destination object to write values to.
 */
export const lerpFragments = (f1, f2, t, out) => {
    const ti = 1 - t;

    // Default v0 behavior: 0 -> 1 if undefined
    const v0_1 = f1.v0 !== undefined ? f1.v0 : 0;
    const v0_2 = f2.v0 !== undefined ? f2.v0 : 1;
    out.v0 = v0_1 * ti + v0_2 * t;

    if (f1.v1 !== undefined && f2.v1 !== undefined) out.v1 = f1.v1 * ti + f2.v1 * t;
    if (f1.v2 !== undefined && f2.v2 !== undefined) out.v2 = f1.v2 * ti + f2.v2 * t;
    if (f1.v3 !== undefined && f2.v3 !== undefined) out.v3 = f1.v3 * ti + f2.v3 * t;

    return out;
};