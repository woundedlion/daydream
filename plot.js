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
const _createGeodesicStrategy = () => {
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
const _createPlanarStrategy = (basis) => {
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
    Shader: {
        lerp: (a, b, t) => {
            if (typeof a === 'number') return a * (1 - t) + b * t;
            const res = {};
            for (const k in a) res[k] = a[k] * (1 - t) + b[k] * t;
            return res;
        },
    },

    Point: class {
        static draw(pipeline, v, fragmentShaderFn, age = 0) {
            const res = fragmentShaderFn(v, 0);
            const color = res.isColor ? res : (res.color || res);
            const alpha = res.alpha !== undefined ? res.alpha : 1.0;
            const tag = res.tag;
            pipeline.plot(v, color, age, alpha, tag);
        }
    },

    Line: class {
        static sample(v1, v2, numSamples = 10) {
            let u = vectorPool.acquire().copy(v1);
            let v = vectorPool.acquire().copy(v2);
            let angle = angleBetween(u, v);
            let axis = vectorPool.acquire().crossVectors(u, v).normalize();

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

            p2.pos.copy(p2Vec);
            p2.v0 = end;

            if (vertexShaderFn) {
                p1.pos.copy(vertexShaderFn(p1.pos));
                p2.pos.copy(vertexShaderFn(p2.pos));
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

                if (vertexShaderFn) pMid.pos.copy(vertexShaderFn(pMid.pos));

                points.push(pMid);
            }

            points.push(p2);

            Plot.rasterize(pipeline, points, fragmentShaderFn, false, age);
        }
    },

    Polyhedron: class {
        static sample(vertices, edges) {
            let points = [];
            edges.map((adj, i) => {
                adj.map((j) => {
                    points.push(vectorPool.acquire().set(...vertices[i]).normalize());
                    points.push(vectorPool.acquire().set(...vertices[j]).normalize());
                })
            });
            return points;
        }

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
        static calcPoint(a, radius, u, v, w) {
            let d = Math.sqrt(Math.pow(1 - radius, 2));
            return vectorPool.acquire().set(
                d * v.x + radius * u.x * Math.cos(a) + radius * w.x * Math.sin(a),
                d * v.y + radius * u.y * Math.cos(a) + radius * w.y * Math.sin(a),
                d * v.z + radius * u.z * Math.cos(a) + radius * w.z * Math.sin(a)
            ).normalize();
        }

        static sample(basis, radius, numSamples, phase = 0) {
            const res = getAntipode(basis, radius);
            const { u, v, w } = res.basis;
            radius = res.radius;

            const thetaEq = radius * (Math.PI / 2);
            const r = Math.sin(thetaEq);
            const d = Math.cos(thetaEq);

            const step = TWO_PI / numSamples;
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
                points.push(p);
            }
            return points;
        }

        static draw(pipeline, basis, radius, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            const numSamples = Daydream.W / 4;
            let points = Plot.Ring.sample(basis, radius, numSamples, phase);

            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }

            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age);
        }
    },

    PlanarLine: class {
        static sample(v1, v2) {
            const p1 = fragmentPool.acquire();
            p1.pos.copy(v1); p1.v0 = 0;
            const p2 = fragmentPool.acquire();
            p2.pos.copy(v2); p2.v0 = 1;
            return [p1, p2];
        }

        static draw(pipeline, v1, v2, center, fragmentShaderFn, age = 0, vertexShaderFn = null) {
            const points = Plot.PlanarLine.sample(v1, v2);
            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }

            // Construct basis on the fly for PlanarLine
            const ref = Math.abs(center.dot(Daydream.X_AXIS)) > 0.9 ? Daydream.Y_AXIS : Daydream.X_AXIS;
            const u = vectorPool.acquire().crossVectors(center, ref).normalize();
            const w = vectorPool.acquire().crossVectors(center, u).normalize();

            Plot.rasterize(pipeline, points, (v, frag) => fragmentShaderFn(frag.v0), false, age, { u, v: center, w });
        }
    },

    Polygon: class {
        static sample(basis, radius, numSides, phase = 0) {
            const offset = Math.PI / numSides;
            return Plot.Ring.sample(basis, radius, numSides, phase + offset);
        }

        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null, usePlanar = false) {
            let points = Plot.Polygon.sample(basis, radius, numSides, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, usePlanar ? basis : null);
        }
    },

    Star: class {
        static sample(basis, radius, numSides, phase = 0) {
            const res = getAntipode(basis, radius);
            const { u, v, w } = res.basis;
            radius = res.radius;

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

        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            let points = Plot.Star.sample(basis, radius, numSides, phase);
            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, basis);
        }
    },

    Flower: class {
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

                p.v0 = i / (numSides * 2);
                points.push(p);
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

        static draw(pipeline, basis, radius, numSides, fragmentShaderFn, phase = 0, age = 0, vertexShaderFn = null) {
            const res = getAntipode(basis, radius);
            const workBasis = res.basis;

            let points = Plot.Flower.sample(basis, radius, numSides, phase);

            if (vertexShaderFn) {
                for (const p of points) {
                    const transformed = vertexShaderFn(p.pos);
                    p.pos.copy(transformed);
                }
            }
            Plot.rasterize(pipeline, points, fragmentShaderFn, true, age, workBasis);
        }
    },

    DistortedRing: class {
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

                p.v0 = i / numSamples;
                points.push(p);
            }

            return points;
        }

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
        static sample(n, eps) {
            const points = [];
            for (let i = 0; i < n; ++i) {
                points.push(fibSpiral(n, eps, i));
            }
            return points;
        }

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

        static sample(system) {
            const trails = [];
            Plot.ParticleSystem.forEachTrail(system, (points, particle) => {
                trails.push({ points: [...points], particle });
            });
            return trails;
        }

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

        // Select Strategy Factory
        const createInterpolator = planarBasis
            ? _createPlanarStrategy(planarBasis)
            : _createGeodesicStrategy();

        const count = closeLoop ? len : len - 1;
        const pTemp = vectorPool.acquire();
        const steps = []; // Reusable buffer? Better to alloc new to be safe/simple first.

        for (let i = 0; i < count; i++) {
            const curr = points[i];
            const next = points[(i + 1) % len];
            const p1 = curr.pos || curr;
            const p2 = next.pos || next;

            // 1. Initialize Strategy
            const { dist: totalDist, map } = createInterpolator(p1, p2);

            // Handle Degenerate Segment
            if (totalDist < 1e-5) {
                // If it's a point, draw it only if we aren't omitting the end
                // (Logic: degenerate line = single point. Treat as start point.)
                // But generally, we skip degenerate steps to avoid noise, 
                // UNLESS it's a single dot geometry? 
                // Following drawLine logic: 
                // if (omitLast) return []; else draw dot.

                const isLastSegment = (i === count - 1);
                const shouldOmit = closeLoop || !isLastSegment;

                if (!shouldOmit) {
                    lerpFragments(curr, next, 0, _scratchFrag);
                    const res = shaderFn(p1, _scratchFrag);
                    pipeline.plot(p1, res.color || res, age, res.alpha ?? 1.0, res.tag);
                }
                continue;
            }

            // 2. Simulation Phase
            // Walk the path to determine adaptive step counts
            steps.length = 0;
            let simDist = 0;
            const baseStep = TWO_PI / Daydream.W; // Base resolution

            // Start simulation at t=0
            map(0, pTemp);

            while (simDist < totalDist) {
                // Check density at current simulation point
                // (1.0 - y*y) is squared distance from Y-axis. 
                // Near poles (y=1), this is 0. Sqrt is 0. scaleFactor is small (0.05).
                const scaleFactor = Math.max(0.05, Math.sqrt(Math.max(0, 1.0 - pTemp.y * pTemp.y)));
                const step = baseStep * scaleFactor;

                steps.push(step);
                simDist += step;

                // Advance simulation point for next density check
                // We use (simDist / totalDist) as 't', clamping strictly for safety
                // Note: pTemp is updated for the NEXT iteration's density check
                if (simDist < totalDist) {
                    map(simDist / totalDist, pTemp);
                }
            }

            // 3. Scale Factor
            // Compress/Expand steps so they sum EXACTLY to totalDist
            const scale = (simDist > 0) ? (totalDist / simDist) : 0;

            // 4. Drawing Phase
            // Determine omitLast based on chain logic
            const isLastSegment = (i === count - 1);

            // If closed loop: ALL segments omit their last point (it's the start of next).
            // If open chain: All segments omit last, EXCEPT the very last segment.
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