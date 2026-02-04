/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";
import { angleBetween, fibSpiral, makeBasis } from "./geometry.js";
import { TWO_PI } from "./3dmath.js";
import { dotPool, vectorPool, quaternionPool, fragmentPool } from "./memory.js";
import { Dot } from "./geometry.js";
import { Path, ProceduralPath, deepTween } from "./animation.js";

const _scratchFrag = new fragmentPool.Type(); // Reused Fragment for interpolation
const _scratchVec = new THREE.Vector3();



export const Plot = {
    Shader: {
        lerp: (a, b, t) => {
            if (typeof a === 'number') return a * (1 - t) + b * t;
            const res = {};
            for (const k in a) res[k] = a[k] * (1 - t) + b[k] * t;
            return res;
        },
    },

    Point: class {
        /**
         * Draws a single dot at a given vector.
         * @param {Object} pipeline - The render pipeline.
         * @param {THREE.Vector3} v - The vector position (normalized).
         * @param {Function} fragmentShaderFn - Function to determine the color (takes vector and t=0).
         * @param {number} [age=0] - The age of the dot (for trails).
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
         * Samples points along a geodesic line between two vectors.
         * @param {THREE.Vector3} v1 - The start vector.
         * @param {THREE.Vector3} v2 - The end vector.
         * @param {number} [numSamples=10] - Number of samples.
         * @returns {Object[]} Array of fragments {pos, v0}.
         */
        static sample(v1, v2, numSamples = 10) {
            let u = vectorPool.acquire().copy(v1);
            let v = vectorPool.acquire().copy(v2);
            let angle = angleBetween(u, v);
            let axis = vectorPool.acquire().crossVectors(u, v).normalize();

            // Handle collinear/coincident points
            if (Math.abs(angle) < 0.0001) {
                const f = fragmentPool.acquire();
                f.pos.copy(u);
                f.v0 = 0;
                return [f];
            }

            let points = [];
            for (let i = 0; i <= numSamples; i++) {
                let t = i / numSamples;
                let q = quaternionPool.acquire().setFromAxisAngle(axis, angle * t);

                let p = fragmentPool.acquire();
                p.pos.copy(u).applyQuaternion(q);
                p.v0 = t;

                points.push(p);
            }
            return points;
        }

        /**
         * Draws a geodesic line between two vectors.
         * @param {Object} pipeline - The render pipeline.
         * @param {THREE.Vector3} v1 - Start vector.
         * @param {THREE.Vector3} v2 - End vector.
         * @param {Function} fragmentShaderFn - Function to determine color.
         * @param {number} [start=0] - Start fraction (0-1).
         * @param {number} [end=1] - End fraction (0-1).
         * @param {boolean} [longWay=false] - Whether to take the long path around the sphere.
         * @param {boolean} [omitLast=false] - Whether to omit the last point.
         * @param {number} [age=0] - Age of the line.
         * @param {Function} [vertexShaderFn=null] - Optional transformation function.
         */
        static draw(pipeline, v1, v2, fragmentShaderFn, start = 0, end = 1, longWay = false, omitLast = false, age = 0, vertexShaderFn = null) {

            // 1. Calculate Basis for Line (u, v, w) to determine geometry
            let u = vectorPool.acquire().copy(v1);
            let v = vectorPool.acquire().copy(v2);
            let a = angleBetween(u, v);
            let w = vectorPool.acquire();

            // Collinear check
            if (Math.abs(a) < 0.0001) {
                // Just draw a dot if we have to? Or nothing?
                // Minimal fragment creation
                return;
            }

            // Normal calculation
            if (Math.abs(Math.PI - a) < 0.0001) {
                if (Math.abs(u.dot(Daydream.X_AXIS)) > 0.9999) w.crossVectors(u, Daydream.Y_AXIS).normalize();
                else w.crossVectors(u, Daydream.X_AXIS).normalize();
            } else {
                w.crossVectors(u, v).normalize();
            }

            // 2. LongWay Logic
            // If longWay, we seek the complement arc.
            // We flip the rotation axis and use 2PI - a
            if (longWay) {
                a = TWO_PI - a;
                w.negate();
            }

            // 3. Start/End Trimming
            // Calculate effective start/end angular offsets
            const angleStart = a * start;
            const angleEnd = a * end;

            // Adjust u (Start Point)
            if (start !== 0) {
                let q = quaternionPool.acquire().setFromAxisAngle(w, angleStart);
                u.applyQuaternion(q).normalize();
            }
            // Adjust v (End Point)
            // v is technically u rotated by angleEnd
            // We need to establish the 'v' position for the p2 fragment
            // Reuse vector 'v' for p2 pos
            v.copy(u); // Start with adjusted start position? No, start with original u?
            // Let's just calculate p2 from original u + rotation
            let p2Vec = vectorPool.acquire().copy(v1); // Original start
            // If longWay was processed, w is flipped, so rotating by +angleEnd moves along the path correctly.
            let qEnd = quaternionPool.acquire().setFromAxisAngle(w, angleEnd);
            p2Vec.applyQuaternion(qEnd).normalize();

            // 4. Create Fragments
            const p1 = fragmentPool.acquire();
            const p2 = fragmentPool.acquire();

            p1.pos.copy(u);
            p1.v0 = start;

            p2.pos.copy(p2Vec);
            p2.v0 = end;

            if (vertexShaderFn) {
                p1.pos.copy(vertexShaderFn(p1.pos));
                p2.pos.copy(vertexShaderFn(p2.pos));
            }

            // 5. To support LongWay in Rasterize:
            // Rasterize naturally takes shortest path.
            // If the segment p1->p2 is > PI, Rasterize will go the "short" way (wrong way).
            // We must detect if the requested arc is > PI.
            // Current 'a' is the arc length *after* longWay logic but *before* start/end trim.
            // The actual arc length drawn is 'a * (end - start)'.
            const arcLength = Math.abs(angleEnd - angleStart);

            const points = [p1];

            // If arc > PI, split it.
            if (arcLength > Math.PI) {
                // Insert Midpoint
                const midAngle = (angleStart + angleEnd) / 2;
                const pMid = fragmentPool.acquire();

                // Calculate Pos
                const tempVec = vectorPool.acquire().copy(v1); // Original start
                const qMid = quaternionPool.acquire().setFromAxisAngle(w, midAngle);
                pMid.pos.copy(tempVec.applyQuaternion(qMid).normalize());
                pMid.v0 = (start + end) / 2;

                if (vertexShaderFn) pMid.pos.copy(vertexShaderFn(pMid.pos));

                points.push(pMid);
            }

            points.push(p2);

            Plot.rasterize(pipeline, points, fragmentShaderFn, false, age);
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
         * @param {Function} fragmentShaderFn - Function to determine the color (takes vector and normalized progress t).
         * @param {number} [age=0] - The age of the dots.
         */
        static draw(pipeline, vertices, edges, fragmentShaderFn, age = 0, vertexShaderFn = null) {
            edges.map((adj, i) => {
                adj.map((j) => {
                    if (i < j) {
                        Plot.Line.draw(
                            pipeline,
                            vectorPool.acquire().set(...vertices[i]).normalize(),
                            vectorPool.acquire().set(...vertices[j]).normalize(),
                            fragmentShaderFn,
                            0, 1, false, false, age, vertexShaderFn);
                    }
                })
            });
        }
    },

    Mesh: class {
        /**
         * Samples points along the edges of the mesh.
         * @param {Object} mesh - The mesh object {vertices: Vector3[], faces: number[][]}.
         * @param {number} [density=10] - Number of samples per edge.
         * @returns {THREE.Vector3[][]} Array of edge samples.
         */
        static sample(mesh, density = 10) {
            const edges = [];
            const drawn = new Set();
            for (const face of mesh.faces) {
                for (let i = 0; i < face.length; i++) {
                    const idx1 = face[i];
                    const idx2 = face[(i + 1) % face.length];

                    // Deduplicate
                    const key = idx1 < idx2 ? `${idx1},${idx2}` : `${idx2},${idx1}`;
                    if (drawn.has(key)) continue;
                    drawn.add(key);

                    edges.push(Plot.Line.sample(mesh.vertices[idx1], mesh.vertices[idx2], density));
                }
            }
            return edges;
        }

        /**
         * Draws a wireframe mesh.
         * @param {Object} pipeline - Render pipeline.
         * @param {Object} mesh - The mesh object {vertices: Vector3[], faces: number[][]}.
         * @param {Function} fragmentShaderFn - Color function.
         */
        static draw(pipeline, mesh, fragmentShaderFn, age = 0, vertexShaderFn = null) {
            const edges = Plot.Mesh.sample(mesh);
            for (const edge of edges) {
                if (vertexShaderFn) {
                    for (let i = 0; i < edge.length; i++) {
                        const frag = edge[i];
                        const transformed = vertexShaderFn(frag.pos);
                        frag.pos.copy(transformed);
                    }
                }
                Plot.rasterize(pipeline, edge, fragmentShaderFn, false, age);
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

                // Platinum Standard: Acquire Fragment
                let p = fragmentPool.acquire();
                p.pos.copy(vDir).multiplyScalar(d).addScaledVector(uTemp, r).normalize();

                // Write data
                p.v0 = i / numSamples;
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
         * @param {Function} fragmentShaderFn - Function to determine color.
         * @param {number} [phase=0] - Starting phase.
         */
        static draw(pipeline, basis, radius, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            const { u, v, w } = basis;
            // Backside
            let vDir = v.clone();
            let rVal = radius;
            if (rVal > 1) {
                vDir.negate();
                rVal = 2 - rVal;
            }

            const thetaEq = rVal * (Math.PI / 2);
            const r = Math.sin(thetaEq);
            const d = Math.cos(thetaEq);

            const numSamples = Daydream.W / 4;
            const step = TWO_PI / numSamples;
            const points = [];
            let uTemp = vectorPool.acquire();

            for (let i = 0; i < numSamples; i++) {
                let theta = i * step;
                let t = theta + phase;
                let cosRing = Math.cos(t);
                let sinRing = Math.sin(t);
                uTemp.copy(u).multiplyScalar(cosRing).addScaledVector(w, sinRing);

                // Platinum Standard: Acquire Fragment
                let p = fragmentPool.acquire();
                p.pos.copy(vDir).multiplyScalar(d).addScaledVector(uTemp, r).normalize();

                if (vertexShaderFn) p.pos.copy(vertexShaderFn(p.pos));

                // Write data
                p.v0 = i / numSamples;
                points.push(p);
            }

            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age);
        }
    },

    PlanarLine: class {
        /**
         * Samples the endpoints of a planar line.
         * @param {THREE.Vector3} v1 - Start point.
         * @param {THREE.Vector3} v2 - End point.
         * @returns {Object[]} Array of fragments.
         */
        static sample(v1, v2) {
            const p1 = fragmentPool.acquire();
            p1.pos.copy(v1);
            p1.v0 = 0;

            const p2 = fragmentPool.acquire();
            p2.pos.copy(v2);
            p2.v0 = 1;

            return [p1, p2];
        }

        /**
         * Draws a line using Azimuthal Equidistant projection.
         * @param {Object} pipeline - Render pipeline.
         * @param {THREE.Vector3} v1 - Start point.
         * @param {THREE.Vector3} v2 - End point.
         * @param {THREE.Vector3} center - Center of projection.
         * @param {Function} fragmentShaderFn - Function to determine color.
         * @param {number} [age=0] - Age of the line.
         * @param {Function} [vertexShaderFn=null] - Optional transformation function.
         */
        static draw(pipeline, v1, v2, center, fragmentShaderFn, age = 0, vertexShaderFn = null) {
            const points = Plot.PlanarLine.sample(v1, v2);
            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }
            Plot.rasterize(pipeline, points, (v, frag) => fragmentShaderFn(frag.v0), false, age, center);
        }
    },

    Polygon: class {
        /**
         * Samples points for a regular polygon on the sphere.
         * @param {Object} basis - The coordinate basis {u, v, w}.
         * @param {number} radius - The radius of the polygon.
         * @param {number} numSides - Number of sides.
         * @param {number} [phase=0] - Starting phase.
         * @returns {THREE.Vector3[]} Array of points.
         */
        static sample(basis, radius, numSides, phase = 0) {
            const offset = Math.PI / numSides;
            return Plot.Ring.sample(basis, radius, numSides, phase + offset);
        }

        /**
         * Draws a regular polygon on the sphere surface.
         * @param {Object} pipeline - The render pipeline.
         * @param {Object} basis - The coordinate basis {u, v, w}.
         * @param {number} radius - The radius.
         * @param {number} numSides - Number of sides.
         * @param {Function} fragmentShaderFn - Function to determine color.
         * @param {number} [phase=0] - Starting phase.
         * @param {number} [age=0] - Age of the polygon.
         * @param {Function} [vertexShaderFn=null] - Optional transformation function.
         */
        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.Polygon.sample(basis, radius, numSides, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, basis.v);
        }

    },

    Star: class {
        /**
         * Samples points for a star shape on the sphere.
         * @param {Object} basis - The coordinate basis {u, v, w}.
         * @param {number} radius - The outer radius.
         * @param {number} numSides - Number of points on the star.
         * @param {number} [phase=0] - Starting phase.
         * @returns {THREE.Vector3[]} Array of points.
         */
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

                // Platinum Standard: Acquire Fragment
                const p = fragmentPool.acquire();
                p.pos.copy(v).multiplyScalar(cosR)
                    .addScaledVector(u, cosT * sinR)
                    .addScaledVector(w, sinT * sinR)
                    .normalize();

                p.v0 = i / (numSides * 2);
                points.push(p);
            }
            return points;
        }

        /**
         * Draws a star shape on the sphere surface.
         * @param {Object} pipeline - Render pipeline.
         * @param {Object} basis - The coordinate basis {u, v, w}.
         * @param {number} radius - The outer radius.
         * @param {number} numSides - Number of points.
         * @param {Function} fragmentShaderFn - Function to determine color.
         * @param {number} [phase=0] - Starting phase.
         * @param {number} [age=0] - Age of the star.
         * @param {Function} [vertexShaderFn=null] - Optional transformation function.
         */
        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.Star.sample(basis, radius, numSides, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, basis.v);
        }
    },

    Flower: class {
        /**
         * Samples points for a flower shape on the sphere.
         * @param {Object} basis - The coordinate basis {u, v, w}.
         * @param {number} radius - The radius.
         * @param {number} numSides - Number of petals.
         * @param {number} [phase=0] - Starting phase.
         * @returns {Object[]} Array of fragments.
         */
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

                    // Platinum Standard: Acquire Fragment
                    const p = fragmentPool.acquire();
                    p.pos.copy(v).multiplyScalar(cosR)
                        .addScaledVector(u, cosT * sinR)
                        .addScaledVector(w, sinT * sinR)
                        .normalize();

                    p.v0 = (i * numSegments + j) / (numSides * numSegments);
                    points.push(p);
                }
            }

            // Close loop
            if (points.length > 0) {
                const first = points[0];
                const last = fragmentPool.acquire();
                last.pos.copy(first.pos);
                last.v0 = 1.0;
                points.push(last);
            }

            return points;
        }

        /**
         * Draws a flower shape on the sphere surface.
         * @param {Object} pipeline - Render pipeline.
         * @param {Object} basis - The coordinate basis {u, v, w}.
         * @param {number} radius - The radius.
         * @param {number} numSides - Number of petals.
         * @param {Function} fragmentShaderFn - Function to determine color.
         * @param {number} [phase=0] - Starting phase.
         * @param {number} [age=0] - Age of the flower.
         * @param {Function} [vertexShaderFn=null] - Optional transformation function.
         */
        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.Flower.sample(basis, radius, numSides, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, false, age, basis.v);
        }
    },

    DistortedRing: class {
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
                // Platinum Standard: Acquire Fragment
                let p = fragmentPool.acquire();
                p.pos.copy(v).multiplyScalar(vScale).addScaledVector(uTemp, uScale).normalize();

                p.v0 = i / numSamples;
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
         * @param {Function} fragmentShaderFn - Color function.
         * @param {number} [phase=0] - Phase.
         */
        static draw(pipeline, basis, radius, shiftFn, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.DistortedRing.sample(basis, radius, shiftFn, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age);
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
         * @param {Function} fragmentShaderFn - Function to determine the color (takes vector).
         * @param {number} [age=0] - The age of the dots.
         */
        static draw(pipeline, n, eps, fragmentShaderFn, age = 0, vertexShaderFn = null) {
            const points = Plot.Spiral.sample(n, eps);
            for (const p of points) {
                let v = p;
                if (vertexShaderFn) v = vertexShaderFn(v);
                const res = fragmentShaderFn(v);
                const color = res.isColor ? res : (res.color || res);
                const alpha = res.alpha !== undefined ? res.alpha : 1.0;
                const tag = res.tag;
                pipeline.plot(v, color, age, alpha, tag);
            }
        }
    },

    ParticleSystem: class {
        /**
         * Iterates over particle trails without allocating intermediate arrays.
         * @param {ParticleSystem} system - The particle system.
         * @param {Function} callback - Callback (points: Vector3[], particle: Particle) => void.
         *                              Note: 'points' is a valid reference ONLY during the callback.
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
         * Samples all trails from the particle system.
         * @param {ParticleSystem} system - The particle system.
         * @returns {Object[]} Array of {points, particle} objects.
         */
        static sample(system) {
            const trails = [];
            Plot.ParticleSystem.forEachTrail(system, (points, particle) => {
                trails.push({ points: [...points], particle });
            });
            return trails;
        }

        /**
         * Draws the trails of a particle system.
         * @param {Object} pipeline - Render pipeline.
         * @param {ParticleSystem} particleSystem - The particle system.
         * @param {Function} fragmentShaderFn - Function to determine color.
         * @param {Function} [vertexShaderFn=null] - Optional transformation function.
         */
        static draw(pipeline, particleSystem, fragmentShaderFn, vertexShaderFn = null) {
            Plot.ParticleSystem.forEachTrail(particleSystem, (points, particle) => {
                if (vertexShaderFn) {
                    for (let i = 0; i < points.length; i++) {
                        points[i] = vertexShaderFn(points[i], particle, i, points.length);
                    }
                }
                Plot.rasterize(pipeline, points, (v, t) => fragmentShaderFn(v, t, particle), false, 0);
            });
        }
    },

    /**
     * Rasterizes a list of points into Dot objects by connecting them with geodesic lines.
     * @param {Object} pipeline - The render pipeline.
     * @param {THREE.Vector3[]|Object[]} points - The list of points (Vectors or Objects with {pos, v}).
     * @param {Function} fragmentShaderFn - Function to determine color.
     * @param {boolean} [closeLoop=false] - If true, connects the last point to the first.
     * @param {number} [age=0] - The age of the dots.
     */
    /**
     * Rasterizes a list of points into Dot objects by connecting them with geodesic lines.
     * @param {Object} pipeline - The render pipeline.
     * @param {THREE.Vector3[]|Object[]} points - The list of points (Vectors or Objects with {pos, v}).
     * @param {Function} fragmentShaderFn - Function to determine color.
     * @param {boolean} [closeLoop=false] - If true, connects the last point to the first.
     * @param {number} [age=0] - The age of the dots.
     * @param {THREE.Vector3} [projectionCenter=null] - If provided, uses Planar (Azimuthal Equidistant) interpolation relative to this center.
     */
    rasterize: (pipeline, points, fragmentShaderFn, closeLoop = false, age = 0, projectionCenter = null) => {
        const len = points.length;
        if (len < 2) return;

        // Planar Basis Setup
        let uPlanar, wPlanar, vPlanar;
        if (projectionCenter) {
            vPlanar = projectionCenter; // Assume normalized
            const ref = Math.abs(vPlanar.dot(Daydream.X_AXIS)) > 0.9 ? Daydream.Y_AXIS : Daydream.X_AXIS;
            uPlanar = vectorPool.acquire().crossVectors(vPlanar, ref).normalize();
            wPlanar = vectorPool.acquire().crossVectors(vPlanar, uPlanar).normalize();
        }

        const project = (p) => {
            const R = angleBetween(p, vPlanar);
            if (R < 0.0001) return { x: 0, y: 0 };
            const x = p.dot(uPlanar);
            const y = p.dot(wPlanar);
            const theta = Math.atan2(y, x);
            return { x: R * Math.cos(theta), y: R * Math.sin(theta) };
        };

        const count = closeLoop ? len : len - 1;
        for (let i = 0; i < count; i++) {
            const current = points[i];
            const next = points[(i + 1) % len];

            const p1 = current.pos || current;
            const p2 = next.pos || next;

            // Interpolator
            const segmentColorFn = (p, subT) => {
                const cV0 = current.v0 !== undefined ? current.v0 : 0;
                const nV0 = next.v0 !== undefined ? next.v0 : 1;

                _scratchFrag.v0 = cV0 * (1 - subT) + nV0 * subT;

                if (current.v1 !== undefined && next.v1 !== undefined) {
                    _scratchFrag.v1 = current.v1 * (1 - subT) + next.v1 * subT;
                }
                if (current.v2 !== undefined && next.v2 !== undefined) {
                    _scratchFrag.v2 = current.v2 * (1 - subT) + next.v2 * subT;
                }
                if (current.v3 !== undefined && next.v3 !== undefined) {
                    _scratchFrag.v3 = current.v3 * (1 - subT) + next.v3 * subT;
                }

                return fragmentShaderFn(p, _scratchFrag);
            };

            if (projectionCenter) {
                // Azimuthal projection
                const proj1 = project(p1);
                const proj2 = project(p2);

                const dx = proj2.x - proj1.x;
                const dy = proj2.y - proj1.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const numSteps = Math.max(2, Math.ceil(dist * Daydream.W / TWO_PI));

                let pTemp = vectorPool.acquire();

                const startRes = segmentColorFn(p1, 0);
                const startAlpha = startRes.alpha !== undefined ? startRes.alpha : 1.0;
                pipeline.plot(p1, startRes.isColor ? startRes : (startRes.color || startRes), age, startAlpha, startRes.tag);

                const loopLimit = numSteps; // We iterate 1..numSteps

                for (let j = 1; j <= loopLimit; j++) {
                    const t = j / numSteps;

                    if ((closeLoop || i < count - 1) && j === numSteps) continue;

                    const Px = proj1.x + dx * t;
                    const Py = proj1.y + dy * t;

                    const R = Math.sqrt(Px * Px + Py * Py);
                    const theta = Math.atan2(Py, Px);

                    pTemp.copy(vPlanar);
                    if (R > 0.0001) {
                        const sinR = Math.sin(R);
                        const cosR = Math.cos(R);
                        const cosT = Math.cos(theta);
                        const sinT = Math.sin(theta);

                        // dir = u*cosT + w*sinT
                        const dir = vectorPool.acquire().copy(uPlanar).multiplyScalar(cosT).addScaledVector(wPlanar, sinT).normalize();
                        pTemp.multiplyScalar(cosR).addScaledVector(dir, sinR).normalize();
                    }

                    const res = segmentColorFn(pTemp, t);
                    const color = res.isColor ? res : (res.color || res);
                    const alpha = res.alpha !== undefined ? res.alpha : 1.0;
                    pipeline.plot(pTemp, color, age, alpha, res.tag);
                }

            } else {
                // Geodesic interpolation
                let u = vectorPool.acquire().copy(p1);
                const v = p2; // Read-only
                let a = angleBetween(u, v);
                let w = vectorPool.acquire();

                // Handle tiny segments
                if (Math.abs(a) < 0.0001) {
                    const c = segmentColorFn(u, 0);
                    const color = c.isColor ? c : (c.color || c);
                    const alpha = c.alpha !== undefined ? c.alpha : 1.0;
                    pipeline.plot(u, color, age, alpha, c.tag);
                    continue;
                }

                // Normal calculation
                if (Math.abs(Math.PI - a) < 0.0001) {
                    if (Math.abs(u.dot(Daydream.X_AXIS)) > 0.9999) w.crossVectors(u, Daydream.Y_AXIS).normalize();
                    else w.crossVectors(u, Daydream.X_AXIS).normalize();
                } else {
                    w.crossVectors(u, v).normalize();
                }

                // Adaptive Geodesic Walk
                const baseStep = TWO_PI / Daydream.W;
                const uStart_y = u.y;
                const tangent_y = w.z * u.x - w.x * u.z;

                let simAngle = 0;
                const steps = [];

                // Generate adaptive steps
                while (simAngle < a) {
                    const cosT = Math.cos(simAngle);
                    const sinT = Math.sin(simAngle);
                    const currentY = uStart_y * cosT + tangent_y * sinT;

                    // Adaptive Step (based on Polar Distortion / Screen Y)
                    const scaleFactor = Math.max(0.05, Math.sqrt(Math.max(0, 1.0 - currentY * currentY)));
                    const step = Math.min(baseStep * scaleFactor, a - simAngle);

                    if (step < 0.00001) break;

                    steps.push(step);
                    simAngle += step;
                }

                // Normalize steps to exactly match angle 'a'
                const scale = (simAngle > 0) ? (a / simAngle) : 0;

                // Plot Start
                const startRes = segmentColorFn(u, 0);
                const startAlpha = startRes.alpha !== undefined ? startRes.alpha : 1.0;
                pipeline.plot(u, startRes.isColor ? startRes : (startRes.color || startRes), age, startAlpha, startRes.tag);

                // Walk
                const omitLast = closeLoop || (i < count - 1);
                const loopLimit = omitLast ? steps.length - 1 : steps.length;

                let currentAngle = 0;

                for (let j = 0; j < loopLimit; j++) {
                    const step = steps[j] * scale;
                    currentAngle += step;

                    let p = vectorPool.acquire().copy(p1);
                    let q = quaternionPool.acquire().setFromAxisAngle(w, currentAngle);
                    p.applyQuaternion(q).normalize();

                    const subT = (a > 0.0001) ? (currentAngle / a) : 1;
                    const res = segmentColorFn(p, subT);
                    const color = res.isColor ? res : (res.color || res);
                    const alpha = res.alpha !== undefined ? res.alpha : 1.0;

                    pipeline.plot(p, color, age, alpha, res.tag);
                }
            }
        }
    }

};

