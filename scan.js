/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream } from "./driver.js";
import { makeBasis, angleBetween, yToPhi } from "./geometry.js";
import { vectorPool, StaticPool } from "./memory.js";
import { quinticKernel } from "./filters.js";
import { wrap } from "./util.js";

import { BVH } from "./spatial.js";

const _scanScratch = { v0: 0, v1: 0, v2: 0, v3: 0 }; // Scratch object for zero-alloc

export const SDF = {
    Ring: class {
        /**
         * @param {Object} basis - {u, v, w}.
         * @param {number} radius - Radius.
         * @param {number} thickness - Thickness.
         * @param {number} phase - Phase.
         */
        constructor(basis, radius, thickness, phase = 0) {
            this.basis = basis;
            this.radius = radius;
            this.thickness = thickness;
            this.phase = phase;

            const { v, u, w } = basis;
            this.normal = v;
            this.u = u;
            this.w = w;

            this.nx = v.x;
            this.ny = v.y;
            this.nz = v.z;

            this.targetAngle = radius * (Math.PI / 2);
            this.centerPhi = Math.acos(this.ny);

            const angMin = Math.max(0, this.targetAngle - thickness);
            const angMax = Math.min(Math.PI, this.targetAngle + thickness);
            this.cosMax = Math.cos(angMin);
            this.cosMin = Math.cos(angMax);

            this.cosTarget = Math.cos(this.targetAngle);
            const safeApprox = (this.targetAngle > 0.05 && this.targetAngle < Math.PI - 0.05);
            this.invSinTarget = safeApprox ? (1.0 / Math.sin(this.targetAngle)) : 0;
        }

        /**
         * Calculates the vertical range of the ring on the screen.
         * @returns {{yMin: number, yMax: number}} The vertical bounds [yMin, yMax].
         */
        getVerticalBounds() {
            const a1 = this.centerPhi - this.targetAngle;
            const a2 = this.centerPhi + this.targetAngle;

            let phiMin = 0;
            let phiMax = Math.PI;

            if (a1 <= 0) {
                phiMin = 0;
            } else {
                const p1 = Math.acos(Math.cos(a1));
                const p2 = Math.acos(Math.cos(a2));
                phiMin = Math.min(p1, p2);
            }

            if (a2 >= Math.PI) {
                phiMax = Math.PI;
            } else {
                const p1 = Math.acos(Math.cos(a1));
                const p2 = Math.acos(Math.cos(a2));
                phiMax = Math.max(p1, p2);
            }

            let finalPhiMin = Math.max(0, phiMin - this.thickness);
            let finalPhiMax = Math.min(Math.PI, phiMax + this.thickness);

            if (this.basis.limits) {
                finalPhiMin = Math.max(finalPhiMin, this.basis.limits.minPhi);
                finalPhiMax = Math.min(finalPhiMax, this.basis.limits.maxPhi);
            }

            const yMin = Math.max(0, Math.floor((finalPhiMin * (Daydream.H - 1)) / Math.PI));
            const yMax = Math.min(Daydream.H - 1, Math.ceil((finalPhiMax * (Daydream.H - 1)) / Math.PI));

            return { yMin, yMax };
        }

        /**
         * @param {number} y 
         * @returns {{start: number, end: number}[]|null}
         */
        getHorizontalBounds(y) {
            const phi = yToPhi(y);
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);

            const R = Math.sqrt(this.nx * this.nx + this.nz * this.nz);
            if (R < 0.01) return null;

            const denom = R * sinPhi;
            if (Math.abs(denom) < 0.000001) return null;

            const alpha = Math.atan2(this.nx, this.nz);

            const D_max = this.cosMax;
            const D_min = this.cosMin;

            const C_min = (D_min - this.ny * cosPhi) / denom;
            const C_max = (D_max - this.ny * cosPhi) / denom;

            const minCos = Math.max(-1, C_min);
            const maxCos = Math.min(1, C_max);

            if (minCos > maxCos) return []; // Empty row

            const angleMin = Math.acos(maxCos);
            const angleMax = Math.acos(minCos);

            const pixelWidth = 2 * Math.PI / Daydream.W;
            const safeThreshold = pixelWidth;

            const intervals = [];

            const addWindow = (t1, t2) => {
                const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
                const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));
                if (x2 - x1 >= Daydream.W) return null; // Full row
                intervals.push({ start: x1, end: x2 });
                return intervals;
            };

            if (angleMin <= safeThreshold) {
                if (!addWindow(alpha - angleMax, alpha + angleMax)) return null;
            } else if (angleMax >= Math.PI - safeThreshold) {
                if (!addWindow(alpha + angleMin, alpha + 2 * Math.PI - angleMin)) return null;
            } else {
                addWindow(alpha - angleMax, alpha - angleMin);
                addWindow(alpha + angleMin, alpha + angleMax);
            }

            return intervals;
        }

        /**
         * Calculates the signed distance from a point to the ring surface.
         * @param {THREE.Vector3} p - The point to check.
         * @param {{dist: number, t: number, rawDist: number}} [out] - Result object.
         * @returns {{dist: number, t: number, rawDist: number}} The distance result.
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const dot = p.dot(this.normal);
            if (dot < this.cosMin || dot > this.cosMax) {
                out.dist = 100.0;
                return out;
            }

            let dist = 0;
            if (this.invSinTarget !== 0) {
                // Approx
                dist = Math.abs(dot - this.cosTarget) * this.invSinTarget;
            } else {
                const polarAngle = Math.acos(Math.max(-1, Math.min(1, dot)));
                dist = Math.abs(polarAngle - this.targetAngle);
            }

            // Calculate t (azimuth)
            const dotU = p.dot(this.u);
            const dotW = p.dot(this.w);
            let azimuth = Math.atan2(dotW, dotU);
            if (azimuth < 0) azimuth += 2 * Math.PI;
            azimuth += this.phase;
            const t = azimuth / (2 * Math.PI);

            out.dist = dist - this.thickness;
            out.t = t;
            out.rawDist = dist;

            return out;
        }
    },

    DistortedRing: class {
        /**
         * @param {Object} basis - {u, v, w}.
         * @param {number} radius - Radius.
         * @param {number} thickness - Thickness.
         * @param {Function} shiftFn - Shift.
         * @param {number} maxDistortion - Max shift.
         * @param {number} phase - Phase.
         */
        constructor(basis, radius, thickness, shiftFn, maxDistortion, phase = 0) {
            this.basis = basis;
            this.radius = radius; // Base angular radius
            this.thickness = thickness;
            this.shiftFn = shiftFn;
            this.maxDistortion = maxDistortion;
            this.phase = phase;

            const { v, u, w } = basis;
            this.normal = v;
            this.u = u;
            this.w = w;

            this.nx = v.x;
            this.ny = v.y;
            this.nz = v.z;

            this.targetAngle = radius * (Math.PI / 2);
            this.centerPhi = Math.acos(this.ny);
            // Max thickness
            this.maxThickness = thickness + maxDistortion;
        }

        /**
         * Calculates the vertical range.
         * @returns {{yMin: number, yMax: number}} Vertical bounds.
         */
        getVerticalBounds() {
            const a1 = this.centerPhi - this.targetAngle;
            const a2 = this.centerPhi + this.targetAngle;

            let phiMin = 0;
            let phiMax = Math.PI;

            if (a1 <= 0) phiMin = 0;
            else {
                const p1 = Math.acos(Math.cos(a1));
                const p2 = Math.acos(Math.cos(a2));
                phiMin = Math.min(p1, p2);
            }

            if (a2 >= Math.PI) phiMax = Math.PI;
            else {
                const p1 = Math.acos(Math.cos(a1));
                const p2 = Math.acos(Math.cos(a2));
                phiMax = Math.max(p1, p2);
            }

            let finalPhiMin = Math.max(0, phiMin - this.maxThickness);
            let finalPhiMax = Math.min(Math.PI, phiMax + this.maxThickness);

            const yMin = Math.max(0, Math.floor((finalPhiMin * (Daydream.H - 1)) / Math.PI));
            const yMax = Math.min(Daydream.H - 1, Math.ceil((finalPhiMax * (Daydream.H - 1)) / Math.PI));

            return { yMin, yMax };
        }

        /**
         * Calculates horizontal intervals for a scanline.
         * @param {number} y - Scanline y.
         * @returns {{start: number, end: number}[]|null} Intervals.
         */
        getHorizontalBounds(y) {
            const phi = yToPhi(y);
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);

            const ang_low = Math.max(0, this.targetAngle - this.maxThickness);
            const ang_high = Math.min(Math.PI, this.targetAngle + this.maxThickness);
            const D_max = Math.cos(ang_low);
            const D_min = Math.cos(ang_high);

            const R = Math.sqrt(this.nx * this.nx + this.nz * this.nz);
            if (R < 0.01) return null;

            const denom = R * sinPhi;
            if (Math.abs(denom) < 0.000001) return null;

            const C_min = (D_min - this.ny * cosPhi) / denom;
            const C_max = (D_max - this.ny * cosPhi) / denom;

            const minCos = Math.max(-1, C_min);
            const maxCos = Math.min(1, C_max);

            if (minCos > maxCos) return [];

            const angleMin = Math.acos(maxCos);
            const angleMax = Math.acos(minCos);

            const pixelWidth = 2 * Math.PI / Daydream.W;
            const safeThreshold = pixelWidth;
            const alpha = Math.atan2(this.nx, this.nz);

            const intervals = [];
            const addWindow = (t1, t2) => {
                const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
                const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));
                if (x2 - x1 >= Daydream.W) return null;
                intervals.push({ start: x1, end: x2 });
                return intervals;
            };

            if (angleMin <= safeThreshold) {
                if (!addWindow(alpha - angleMax, alpha + angleMax)) return null;
            } else if (angleMax >= Math.PI - safeThreshold) {
                if (!addWindow(alpha + angleMin, alpha + 2 * Math.PI - angleMin)) return null;
            } else {
                addWindow(alpha - angleMax, alpha - angleMin);
                addWindow(alpha + angleMin, alpha + angleMax);
            }
            return intervals;
        }

        /**
         * Signed distance to the distorted ring.
         * @param {THREE.Vector3} p - Point.
         * @param {{dist: number, t: number, rawDist: number}} [out] - Result.
         * @returns {{dist: number, t: number, rawDist: number}} Result.
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const polarAngle = angleBetween(p, this.normal);

            const dotU = p.dot(this.u);
            const dotW = p.dot(this.w);
            let azimuth = Math.atan2(dotW, dotU);
            if (azimuth < 0) azimuth += 2 * Math.PI;

            const t = azimuth + this.phase;
            const normT = t / (2 * Math.PI);

            const shift = this.shiftFn(normT);
            const localTarget = this.targetAngle + shift;

            const dist = Math.abs(polarAngle - localTarget);

            out.dist = dist - this.thickness;
            out.t = (azimuth / (2 * Math.PI));
            out.rawDist = dist;
            return out;
        }
    },

    Union: class {
        /**
         * @param {Object} a - Shape A.
         * @param {Object} b - Shape B.
         */
        constructor(a, b) {
            this.a = a;
            this.b = b;
            this.thickness = Math.max(a.thickness || 0, b.thickness || 0);
        }

        /**
         * Vertical bounds of the union.
         * @returns {{yMin: number, yMax: number}} Bounds.
         */
        getVerticalBounds() {
            const b1 = this.a.getVerticalBounds();
            const b2 = this.b.getVerticalBounds();
            return {
                yMin: Math.min(b1.yMin, b2.yMin),
                yMax: Math.max(b1.yMax, b2.yMax)
            };
        }

        /**
         * Distance to union (min of distances).
         * @param {THREE.Vector3} p - Point.
         * @param {{dist: number, t: number, rawDist: number}} [out] - Result.
         * @returns {{dist: number, t: number, rawDist: number}} Result.
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const d1 = this.a.distance(p, out);
            const resA = this.a.distance(p);
            const resB = this.b.distance(p);

            if (resA.dist < resB.dist) {
                out.dist = resA.dist;
                out.t = resA.t;
                out.rawDist = resA.rawDist;
            } else {
                out.dist = resB.dist;
                out.t = resB.t;
                out.rawDist = resB.rawDist;
            }
            return out;
        }
    },

    Subtract: class {
        /**
         * @param {Object} a - Shape A.
         * @param {Object} b - Shape B.
         */
        constructor(a, b) {
            this.a = a;
            this.b = b;
            this.thickness = a.thickness || 0;
        }

        /**
         * Vertical bounds of the subtraction (conservatively A's bounds).
         * @returns {{yMin: number, yMax: number}} Bounds.
         */
        getVerticalBounds() {
            return this.a.getVerticalBounds();
        }

        /**
         * Horizontal bounds (delegates to A).
         * @param {number} y - Scanline.
         * @returns {{start: number, end: number}[]|null} Intervals.
         */
        // Conservative
        getHorizontalBounds(y) {
            if (this.a.getHorizontalBounds) return this.a.getHorizontalBounds(y);
            return null;
        }

        /**
         * Distance to subtraction (max of A and -B).
         * @param {THREE.Vector3} p - Point.
         * @param {{dist: number, t: number, rawDist: number}} [out] - Result.
         * @returns {{dist: number, t: number, rawDist: number}} Result.
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const resA = this.a.distance(p);
            const resB = this.b.distance(p);

            const dist = Math.max(resA.dist, -resB.dist);

            if (resA.dist > -resB.dist) {
                out.dist = dist;
                out.t = resA.t;
                out.rawDist = resA.rawDist; // Preserve A's attributes?
            } else {
                // If B is the boundary, we are "inside" B (subtracted space).
                out.dist = dist;
                out.t = resB.t;
                out.rawDist = resB.dist;
            }
            return out;
        }
    },

    Intersection: class {
        /**
         * @param {Object} a - Shape A.
         * @param {Object} b - Shape B.
         */
        constructor(a, b) {
            this.a = a;
            this.b = b;
            this.thickness = Math.min(a.thickness || 0, b.thickness || 0);
        }

        /**
         * Vertical bounds of intersection.
         * @returns {{yMin: number, yMax: number}} Bounds.
         */
        getVerticalBounds() {
            const b1 = this.a.getVerticalBounds();
            const b2 = this.b.getVerticalBounds();
            return {
                yMin: Math.max(b1.yMin, b2.yMin),
                yMax: Math.min(b1.yMax, b2.yMax)
            };
        }

        /**
         * Horizontal bounds of intersection.
         * @param {number} y - Scanline.
         * @returns {{start: number, end: number}[]|null} Intervals.
         */
        // Intersect
        getHorizontalBounds(y) {
            let iA = this.a.getHorizontalBounds ? this.a.getHorizontalBounds(y) : null;
            let iB = this.b.getHorizontalBounds ? this.b.getHorizontalBounds(y) : null;

            // Full row
            if (iA === null) return iB;
            if (iB === null) return iA;

            // If either returns an empty list (no intersection), the result is empty.
            if (iA.length === 0 || iB.length === 0) return [];

            let result = [];
            let idxA = 0;
            let idxB = 0;

            // Assuming sorted intervals from children (standard for Scan)
            while (idxA < iA.length && idxB < iB.length) {
                let intA = iA[idxA];
                let intB = iB[idxB];

                // Find overlap
                let start = Math.max(intA.start, intB.start);
                let end = Math.min(intA.end, intB.end);

                if (start < end) {
                    result.push({ start, end });
                }

                // Advance the one that ends first
                if (intA.end < intB.end) {
                    idxA++;
                } else {
                    idxB++;
                }
            }
            return result;
        }

        /**
         * Distance to intersection (max of distances).
         * @param {THREE.Vector3} p - Point.
         * @param {{dist: number, t: number, rawDist: number}} [out] - Result.
         * @returns {{dist: number, t: number, rawDist: number}} Result.
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const resA = this.a.distance(p);
            const resB = this.b.distance(p);

            if (resA.dist > resB.dist) {
                out.dist = resA.dist;
                out.t = resA.t;
                out.rawDist = resA.rawDist;
            } else {
                out.dist = resB.dist;
                out.t = resB.t;
                out.rawDist = resB.rawDist;
            }
            return out;
        }
    },

    Polygon: class {
        /**
         * @param {Object} basis - {u, v, w}.
         * @param {number} radius - Radius.
         * @param {number} thickness - Thickness.
         * @param {number} sides - Sides.
         * @param {number} phase - Phase.
         */
        constructor(basis, radius, thickness, sides, phase = 0) {
            this.basis = basis;
            this.thickness = thickness;
            this.sides = sides;
            this.phase = phase;
            this.apothem = thickness * Math.cos(Math.PI / sides);
            this.isSolid = true; // Solid Shape

            this.nx = basis.v.x;
            this.ny = basis.v.y;
            this.nz = basis.v.z;
            this.R = Math.sqrt(this.nx * this.nx + this.nz * this.nz);
            this.alpha = Math.atan2(this.nx, this.nz);

            const centerPhi = Math.acos(Math.max(-1, Math.min(1, basis.v.y)));
            const margin = thickness + 0.1;
            this.yMin = Math.floor((Math.max(0, centerPhi - margin) / Math.PI) * (Daydream.H - 1));
            this.yMax = Math.ceil((Math.min(Math.PI, centerPhi + margin) / Math.PI) * (Daydream.H - 1));
        }

        /**
         * @returns {{yMin: number, yMax: number}} Vertical bounds.
         */
        getVerticalBounds() { return { yMin: this.yMin, yMax: this.yMax }; }

        /**
         * @param {number} y 
         * @returns {{start: number, end: number}[]|null}
         */
        getHorizontalBounds(y) {
            const phi = yToPhi(y);
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);

            if (this.R < 0.01) return null; // Full row (near pole)

            const pixelWidth = 2 * Math.PI / Daydream.W;
            const ang_high = this.thickness + pixelWidth; // Use slightly expanded bounds for AA
            const D_min = Math.cos(ang_high);

            const denom = this.R * sinPhi;
            if (Math.abs(denom) < 0.000001) return null;

            const C_min = (D_min - this.ny * cosPhi) / denom;
            if (C_min > 1.0) return []; // Outside cap
            if (C_min < -1.0) return null; // Full row

            const dAlpha = Math.acos(C_min);
            const t1 = this.alpha - dAlpha;
            const t2 = this.alpha + dAlpha;

            const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
            const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));

            if (x2 - x1 >= Daydream.W) return null;

            return [{ start: x1, end: x2 }];
        }

        /**
         * @param {THREE.Vector3} p 
         * @param {{dist: number, t: number, rawDist: number}} [out] 
         * @returns {{dist: number, t: number, rawDist: number}}
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const polarAngle = angleBetween(p, this.basis.v);
            const dotU = p.dot(this.basis.u);
            const dotW = p.dot(this.basis.w);
            let azimuth = Math.atan2(dotW, dotU);
            if (azimuth < 0) azimuth += 2 * Math.PI;

            azimuth += this.phase;

            const sectorAngle = 2 * Math.PI / this.sides;
            const localAzimuth = wrap(azimuth + sectorAngle / 2, sectorAngle) - sectorAngle / 2;

            out.dist = polarAngle * Math.cos(localAzimuth) - this.apothem;
            out.t = polarAngle / this.thickness; // Normalized distance for color lookup
            out.rawDist = polarAngle;
            return out;
        }
    },

    Star: class {
        /**
         * @param {Object} basis - {u, v, w}.
         * @param {number} radius - Radius.
         * @param {number} sides - Sides.
         * @param {number} phase - Phase.
         */
        constructor(basis, radius, sides, phase = 0) {
            this.basis = basis;
            this.sides = sides;
            this.phase = phase;
            this.isSolid = true;

            const outerRadius = radius * (Math.PI / 2);
            const innerRadius = outerRadius * 0.382;
            const angleStep = Math.PI / sides;

            const vT = outerRadius;
            const vVx = innerRadius * Math.cos(angleStep);
            const vVy = innerRadius * Math.sin(angleStep);

            const dx = vVx - vT;
            const dy = vVy;
            const len = Math.sqrt(dx * dx + dy * dy);
            this.nx = -dy / len;
            this.ny = dx / len;
            this.planeD = -(this.nx * vT);
            this.thickness = outerRadius;

            // Scan
            this.scanNy = basis.v.y;
            this.scanNx = basis.v.x;
            this.scanNz = basis.v.z;
            this.scanR = Math.sqrt(this.scanNx * this.scanNx + this.scanNz * this.scanNz);
            this.scanAlpha = Math.atan2(this.scanNx, this.scanNz);

            const centerPhi = Math.acos(Math.max(-1, Math.min(1, basis.v.y)));
            const margin = outerRadius + 0.1;
            this.yMin = Math.floor((Math.max(0, centerPhi - margin) / Math.PI) * (Daydream.H - 1));
            this.yMax = Math.ceil((Math.min(Math.PI, centerPhi + margin) / Math.PI) * (Daydream.H - 1));
        }

        /**
         * @returns {{yMin: number, yMax: number}} Vertical bounds.
         */
        getVerticalBounds() { return { yMin: this.yMin, yMax: this.yMax }; }

        /**
         * @param {number} y 
         * @returns {{start: number, end: number}[]|null}
         */
        getHorizontalBounds(y) {
            // Bounding circle
            const phi = yToPhi(y);
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);
            if (this.scanR < 0.01) return null;

            const pixelWidth = 2 * Math.PI / Daydream.W;
            const D_min = Math.cos(this.thickness + pixelWidth);
            const denom = this.scanR * sinPhi;
            if (Math.abs(denom) < 0.000001) return null;

            const C_min = (D_min - this.scanNy * cosPhi) / denom;
            if (C_min > 1.0) return [];
            if (C_min < -1.0) return null;

            const dAlpha = Math.acos(C_min);
            const t1 = this.scanAlpha - dAlpha;
            const t2 = this.scanAlpha + dAlpha;
            const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
            const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));
            if (x2 - x1 >= Daydream.W) return null;
            return [{ start: x1, end: x2 }];
        }

        /**
         * @param {THREE.Vector3} p 
         * @param {{dist: number, t: number, rawDist: number}} [out] 
         * @returns {{dist: number, t: number, rawDist: number}}
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const scanDist = angleBetween(p, this.basis.v);
            const dotU = p.dot(this.basis.u);
            const dotW = p.dot(this.basis.w);
            let azimuth = Math.atan2(dotW, dotU);
            if (azimuth < 0) azimuth += 2 * Math.PI;

            azimuth += this.phase;

            const sectorAngle = 2 * Math.PI / this.sides;
            let localAzimuth = wrap(azimuth + sectorAngle / 2, sectorAngle) - sectorAngle / 2;
            localAzimuth = Math.abs(localAzimuth);

            const px = scanDist * Math.cos(localAzimuth);
            const py = scanDist * Math.sin(localAzimuth);

            const distToEdge = px * this.nx + py * this.ny + this.planeD;

            out.dist = -distToEdge;
            out.t = scanDist / this.thickness;
            out.rawDist = scanDist;
            return out;
        }
    },

    Flower: class {
        /**
         * @param {Object} basis - {u, v, w}.
         * @param {number} radius - Radius.
         * @param {number} sides - Sides.
         * @param {number} phase - Phase.
         */
        constructor(basis, radius, sides, phase = 0) {
            this.basis = basis;
            this.sides = sides;
            this.phase = phase;
            this.isSolid = true;

            const desiredOuterRadius = radius * (Math.PI / 2);
            this.apothem = Math.PI - desiredOuterRadius;
            this.thickness = desiredOuterRadius;
            this.antipode = basis.v.clone().negate();

            this.scanNy = this.antipode.y;
            this.scanNx = this.antipode.x;
            this.scanNz = this.antipode.z;
            this.scanR = Math.sqrt(this.scanNx * this.scanNx + this.scanNz * this.scanNz);
            this.scanAlpha = Math.atan2(this.scanNx, this.scanNz);

            const centerPhi = Math.acos(Math.max(-1, Math.min(1, this.antipode.y)));
            const margin = this.thickness + 0.1;
            this.yMin = Math.floor((Math.max(0, centerPhi - margin) / Math.PI) * (Daydream.H - 1));
            this.yMax = Math.ceil((Math.min(Math.PI, centerPhi + margin) / Math.PI) * (Daydream.H - 1));
        }

        /**
         * @returns {{yMin: number, yMax: number}} Vertical bounds.
         */
        getVerticalBounds() { return { yMin: this.yMin, yMax: this.yMax }; }

        /**
         * @param {number} y 
         * @returns {{start: number, end: number}[]|null}
         */
        getHorizontalBounds(y) {
            const phi = yToPhi(y);
            const cosPhi = Math.cos(phi);
            const sinPhi = Math.sin(phi);
            if (this.scanR < 0.01) return null;

            const pixelWidth = 2 * Math.PI / Daydream.W;
            const D_min = Math.cos(this.thickness + pixelWidth);
            const denom = this.scanR * sinPhi;
            if (Math.abs(denom) < 0.000001) return null;

            const C_min = (D_min - this.scanNy * cosPhi) / denom;
            if (C_min > 1.0) return [];
            if (C_min < -1.0) return null;

            const dAlpha = Math.acos(C_min);
            const t1 = this.scanAlpha - dAlpha;
            const t2 = this.scanAlpha + dAlpha;
            const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
            const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));
            if (x2 - x1 >= Daydream.W) return null;
            return [{ start: x1, end: x2 }];
        }

        /**
         * @param {THREE.Vector3} p 
         * @param {{dist: number, t: number, rawDist: number}} [out] 
         * @returns {{dist: number, t: number, rawDist: number}}
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const scanDist = angleBetween(p, this.antipode);
            const polarAngle = Math.PI - scanDist;

            const dotU = p.dot(this.basis.u);
            const dotW = p.dot(this.basis.w);
            let azimuth = Math.atan2(dotW, dotU);
            if (azimuth < 0) azimuth += 2 * Math.PI;

            azimuth += this.phase;

            const sectorAngle = 2 * Math.PI / this.sides;
            const localAzimuth = wrap(azimuth + sectorAngle / 2, sectorAngle) - sectorAngle / 2;

            const distToEdge = polarAngle * Math.cos(localAzimuth) - this.apothem;

            out.dist = -distToEdge;
            out.t = scanDist / this.thickness;
            out.rawDist = scanDist;
            return out;
        }
    },

    Face: class {
        /**
         * @param {THREE.Vector3[]} vertices - Vertices.
         * @param {number} thickness - Thickness.
         * @param {number} [count] - Number of vertices to use from array.
         */
        constructor() {
            // Pre-allocate persistent members
            this.center = new THREE.Vector3();
            this.basisU = new THREE.Vector3();
            this.basisV = new THREE.Vector3(); // Normal (V)
            this.basisW = new THREE.Vector3();

            this.planes = []; // We will clear and reuse
            this.poly2D = []; // Reused objects {x,y}
            this.edgeVectors = []; // Reused objects {x,y}
            this.edgeLengthsSq = []; // Reused numbers
            this.intervals = null;
        }

        /**
         * Initializes the face with new data without allocation.
         * @param {THREE.Vector3[]} vertices - Array of all vertices.
         * @param {number[]} indices - Indices for this face.
         * @param {number} thickness - Thickness.
         */
        init(vertices, indices, thickness = 0) {
            this.vertices = vertices;
            this.indices = indices;
            this.count = indices ? indices.length : vertices.length;
            this.thickness = thickness;

            // Reset state
            this.planes.length = 0;
            this.yMin = Daydream.H;
            this.yMax = 0;
            this.intervals = null;

            // Centroid & Basis
            // Reuse this.center
            this.center.set(0, 0, 0);

            if (indices) {
                for (let i = 0; i < this.count; i++) this.center.add(vertices[indices[i]]);
            } else {
                for (let i = 0; i < this.count; i++) this.center.add(vertices[i]);
            }
            // center is average, but we just normalize direction for sphere surface projection
            this.center.normalize();

            // Copy center to basisV (Normal)
            this.basisV.copy(this.center);

            // Basis U W
            const identity = new THREE.Quaternion();
            const b = makeBasis(identity, this.center);
            this.basisU.copy(b.u);
            this.basisW.copy(b.w);

            // Project 2D
            while (this.poly2D.length < this.count) {
                this.poly2D.push({ x: 0, y: 0 });
            }

            for (let i = 0; i < this.count; i++) {
                const v = indices ? vertices[indices[i]] : vertices[i];
                const d = v.dot(this.basisV);
                // u = (v . basisU) / d, w = (v . basisW) / d
                // We reuse objects in this.poly2D
                const p2d = this.poly2D[i];
                p2d.x = v.dot(this.basisU) / d;
                p2d.y = v.dot(this.basisW) / d;
            }

            // Pre-compute Edge Vectors & Lengths
            while (this.edgeVectors.length < this.count) {
                this.edgeVectors.push({ x: 0, y: 0 });
                this.edgeLengthsSq.push(0);
            }

            // Compute edges for distance check (matching distance loop: i, j=i-1)
            for (let i = 0, j = this.count - 1; i < this.count; j = i, i++) {
                const Vi = this.poly2D[i];
                const Vj = this.poly2D[j];

                const edge = this.edgeVectors[i];
                edge.x = Vj.x - Vi.x;
                edge.y = Vj.y - Vi.y;

                this.edgeLengthsSq[i] = edge.x * edge.x + edge.y * edge.y;
            }

            // Inradius
            let minEdgeDist = Infinity;
            const len = this.count;
            if (len < 2) {
                minEdgeDist = 1.0;
            } else {
                for (let i = 0; i < len; i++) {
                    const p1 = this.poly2D[i];
                    const p2 = this.poly2D[(i + 1) % len];

                    // Distance from (0,0) to segment p1-p2
                    const dx = p2.x - p1.x;
                    const dy = p2.y - p1.y;
                    const l2 = dx * dx + dy * dy;
                    if (l2 < 1e-12) {
                        const d = Math.sqrt(p1.x * p1.x + p1.y * p1.y);
                        if (d < minEdgeDist) minEdgeDist = d;
                        continue;
                    }

                    // t = dot(p - p1, p2 - p1) / l2 .  Here p is (0,0) -> dot(-p1, p2-p1)
                    let t = - (p1.x * dx + p1.y * dy) / l2;
                    t = Math.max(0, Math.min(1, t));

                    const closestX = p1.x + t * dx;
                    const closestY = p1.y + t * dy;
                    const distSq = closestX * closestX + closestY * closestY;

                    if (distSq < minEdgeDist) minEdgeDist = distSq;
                }
                minEdgeDist = Math.sqrt(minEdgeDist);
            }
            this.size = (minEdgeDist > 0.0001) ? minEdgeDist : 1.0;

            // Compute Bounds
            let minPhi = 100;
            let maxPhi = -100;
            const thetas = [];

            for (let i = 0; i < this.count; i++) {
                const v1 = indices ? vertices[indices[i]] : vertices[i];
                const v2 = indices ? vertices[indices[(i + 1) % this.count]] : vertices[(i + 1) % this.count];

                // Plane Normal
                const normal = vectorPool.acquire().crossVectors(v1, v2);

                // Skip degenerate
                if (normal.lengthSq() < 1e-12) {
                    // Skip adding to planes, but continue vertex bounds checks.
                } else {
                    normal.normalize();
                    this.planes.push(normal);
                }

                // Vertices
                const phi1 = Math.acos(Math.max(-1, Math.min(1, v1.y)));
                if (phi1 < minPhi) minPhi = phi1;
                if (phi1 > maxPhi) maxPhi = phi1;

                // Arc Extrema
                const ny = normal.y;
                if (Math.abs(ny) < 0.99999) { // Avoid pole-aligned planes
                    const nx = normal.x;
                    const nz = normal.z;
                    // P_top = Projection of (0,1,0) onto plane N, normalized.
                    // Vector T = ( -nx*ny, 1 - ny*ny, -nz*ny )
                    const tx = -nx * ny;
                    const ty = 1.0 - ny * ny;
                    const tz = -nz * ny;
                    const tLenSq = tx * tx + ty * ty + tz * tz;
                    if (tLenSq > 1e-12) {
                        const invLen = 1.0 / Math.sqrt(tLenSq);
                        const ptx = tx * invLen;
                        const pty = ty * invLen;
                        const ptz = tz * invLen;

                        // Check P_top
                        const cx1 = (v1.y * ptz - v1.z * pty) * nx + (v1.z * ptx - v1.x * ptz) * ny + (v1.x * pty - v1.y * ptx) * nz;
                        const cx2 = (pty * v2.z - ptz * v2.y) * nx + (ptz * v2.x - ptx * v2.z) * ny + (ptx * v2.y - pty * v2.x) * nz;

                        // Update minPhi
                        if (cx1 > 0 && cx2 > 0) {
                            const phiTop = Math.acos(Math.max(-1, Math.min(1, pty)));
                            if (phiTop < minPhi) minPhi = phiTop;
                        }

                        // If P_bot (-P_top) is inside, update maxPhi (Southmost)
                        // Symmetry: (v1 x -P) . N = -cx1. So we check if -cx1 > 0 AND -cx2 > 0.
                        if (cx1 < 0 && cx2 < 0) {
                            const phiBot = Math.acos(Math.max(-1, Math.min(1, -pty)));
                            if (phiBot > maxPhi) maxPhi = phiBot;
                        }
                    }
                }

                // Collect Thetas
                let theta = Math.atan2(v1.x, v1.z);
                if (theta < 0) theta += 2 * Math.PI;
                thetas.push(theta);
            }

            // Pole Logic
            let npInside = true;
            let spInside = true;
            for (const plane of this.planes) {
                if (plane.y < 0) npInside = false;
                if (plane.y > 0) spInside = false;
            }
            if (npInside) minPhi = 0;
            if (spInside) maxPhi = Math.PI;

            // Conservative Bounds
            const margin = thickness + 0.05;
            this.yMin = Math.floor((Math.max(0, minPhi - margin) / Math.PI) * (Daydream.H - 1));
            this.yMax = Math.ceil((Math.min(Math.PI, maxPhi + margin) / Math.PI) * (Daydream.H - 1));

            // Horizontal bounds
            thetas.sort((a, b) => a - b);
            let maxGap = 0;
            let gapStart = 0;
            for (let i = 0; i < thetas.length; i++) {
                const next = (i + 1) < thetas.length ? thetas[i + 1] : (thetas[0] + 2 * Math.PI);
                if (next - thetas[i] > maxGap) { maxGap = next - thetas[i]; gapStart = thetas[i]; }
            }
            if (maxGap > Math.PI) {
                const startPx = Math.floor(((gapStart + maxGap) % (2 * Math.PI) / (2 * Math.PI)) * Daydream.W);
                const endPx = Math.ceil((gapStart / (2 * Math.PI)) * Daydream.W);
                if (startPx <= endPx) this.intervals = [{ start: startPx, end: Math.min(endPx, Daydream.W - 1) }];
                else this.intervals = [{ start: startPx, end: Daydream.W - 1 }, { start: 0, end: Math.min(endPx, Daydream.W - 1) }];
            } else {
                this.intervals = null; // Full width fallback
            }
        }

        getVerticalBounds() { return { yMin: this.yMin, yMax: this.yMax }; }
        getHorizontalBounds(y) { return this.intervals; }

        /**
         * Signed Distance to arbitrary polygon.
         * @param {THREE.Vector3} p - Point.
         * @param {{dist: number, t: number, rawDist: number}} [out] - Result.
         * @returns {{dist: number, t: number, rawDist: number}} Result.
         */
        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            // Hemisphere check
            const cosAngle = p.dot(this.center);
            if (cosAngle <= 0.01) {
                out.dist = 100; return out;
            }

            // Project P
            const invCos = 1.0 / cosAngle;
            const px = p.dot(this.basisU) * invCos;
            const py = p.dot(this.basisW) * invCos;

            // 2D SDF & Winding
            const v = this.poly2D;
            const N = this.count;

            let d = Infinity; // Start with clear max
            let winding = 0;

            for (let i = 0, j = N - 1; i < N; j = i, i++) {
                const Vi = v[i];
                const Vj = v[j];

                // Use pre-computed edge
                const edge = this.edgeVectors[i];
                const ex = edge.x;
                const ey = edge.y;

                const wx = px - Vi.x;
                const wy = py - Vi.y;

                // Edge distance
                const dotWE = wx * ex + wy * ey;
                const dotEE = this.edgeLengthsSq[i];

                let clampVal = 0;
                if (dotEE > 1e-12) {
                    clampVal = Math.max(0, Math.min(1, dotWE / dotEE));
                }

                const bx = wx - ex * clampVal;
                const by = wy - ey * clampVal;
                const distSq = bx * bx + by * by;

                if (distSq < d) d = distSq;

                // Winding
                const isUpward = (Vi.y <= py) && (Vj.y > py);
                const isDownward = (Vi.y > py) && (Vj.y <= py);

                if (isUpward || isDownward) {
                    const cross = ex * wy - ey * wx;
                    if (isUpward) {
                        if (cross > 0) winding++;
                    } else {
                        if (cross < 0) winding--;
                    }
                }
            }

            // Result is distance in Tangent Plane units.
            // Non-Zero Rule: Inside if winding != 0
            const s = (winding !== 0) ? -1.0 : 1.0;

            const planeDist = s * Math.sqrt(d);

            out.dist = planeDist - this.thickness;
            out.t = 0;
            out.rawDist = planeDist;

            // Barycentric Weights (N-gon fan)
            if (out.weights) {
                if (N === 3) {
                    const v0 = v[0];
                    const v1 = v[1];
                    const v2 = v[2];
                    const denom = (v1.y - v2.y) * (v0.x - v2.x) + (v2.x - v1.x) * (v0.y - v2.y);
                    if (Math.abs(denom) > 1e-12) {
                        const invDenom = 1.0 / denom;
                        out.weights.a = ((v1.y - v2.y) * (px - v2.x) + (v2.x - v1.x) * (py - v2.y)) * invDenom;
                        out.weights.b = ((v2.y - v0.y) * (px - v2.x) + (v0.x - v2.x) * (py - v2.y)) * invDenom;
                        out.weights.c = 1.0 - out.weights.a - out.weights.b;
                        out.weights.i0 = 0;
                        out.weights.i1 = 1;
                        out.weights.i2 = 2;
                    }
                } else {
                    // Triangle Fan (0, i, i+1)
                    // Find which triangle contains P
                    for (let i = 1; i < N - 1; i++) {
                        const v0 = v[0];
                        const v1 = v[i];
                        const v2 = v[i + 1];

                        const denom = (v1.y - v2.y) * (v0.x - v2.x) + (v2.x - v1.x) * (v0.y - v2.y);
                        if (Math.abs(denom) > 1e-12) {
                            const invDenom = 1.0 / denom;
                            const wA = ((v1.y - v2.y) * (px - v2.x) + (v2.x - v1.x) * (py - v2.y)) * invDenom;
                            const wB = ((v2.y - v0.y) * (px - v2.x) + (v0.x - v2.x) * (py - v2.y)) * invDenom;
                            const wC = 1.0 - wA - wB;

                            // Check if inside with small epsilon due to float/AA
                            if (wA >= -0.01 && wB >= -0.01 && wC >= -0.01) {
                                out.weights.a = wA;
                                out.weights.b = wB;
                                out.weights.c = wC;
                                out.weights.i0 = 0;
                                out.weights.i1 = i;
                                out.weights.i2 = i + 1;
                                break;
                            }
                        }
                    }
                    // Fallback: If outside all (due to AA boundary), use first triangle?
                    if (out.weights.i1 === undefined) {
                        out.weights.a = 1; out.weights.b = 0; out.weights.c = 0;
                        out.weights.i0 = 0; out.weights.i1 = 1; out.weights.i2 = 2;
                    }
                }
            }

            return out;
        }
    },

    Mesh: class {
        /**
         * @param {Object} mesh - {vertices, faces, bvh}.
         */
        constructor(mesh) {
            this.mesh = mesh;
            this.bvh = mesh.bvh;
            this.isSolid = true; // Use Solid AA

            // MRU Cache
            this.lastFaceIndex = -1;
            this.lastFaceShape = new SDF.Face();
        }

        getVerticalBounds() {
            // Conservative: Full screen as mesh rotates/wraps
            return { yMin: 0, yMax: Daydream.H - 1 };
        }

        getHorizontalBounds(y) {
            // Simplified: full width
            return null;
        }

        distance(p, out = { dist: 100, t: 0, rawDist: 100 }) {
            const hit = this.bvh.intersectRay(vectorPool.acquire().set(0, 0, 0), p);

            if (hit) {
                // Check Cache
                if (hit.faceIndex !== this.lastFaceIndex) {
                    this.lastFaceShape.init(this.mesh.vertices, this.mesh.faces[hit.faceIndex], 0);
                    this.lastFaceIndex = hit.faceIndex;
                }

                // Distance
                this.lastFaceShape.distance(p, out);
                out.faceIndex = hit.faceIndex;
            } else {
                out.dist = 10;
            }
            return out;
        }
    },
};

export const facePool = new StaticPool(SDF.Face, 10000);

export const Scan = {
    /**
         * Rasterizes a shape using scanline conversion.
         * @param {Object} pipeline - Pipeline.
         * @param {Object} shape - SDF shape.
         * @param {Function} shaderFn - Color function.
         * @param {boolean} [debugBB=false] - Debug.
         */
    rasterize: (pipeline, shape, shaderFn, debugBB = false) => {
        const { yMin, yMax } = shape.getVerticalBounds();

        // Reusable result object
        const sampleResult = {
            dist: 100,
            t: 0,
            rawDist: 100,
            faceIndex: -1,
            weights: { a: 0, b: 0, c: 0 }
        };

        const pixelWidth = 2 * Math.PI / Daydream.W;
        const threshold = shape.isSolid ? pixelWidth : 0;
        const W = Daydream.W;
        const pixelPositions = Daydream.pixelPositions;

        // INLINED LOOP LOGIC
        const runScanline = (xStart, xEnd, y) => {
            for (let x = xStart; x <= xEnd; x++) {
                // 1. Calculate Index
                // Inline wrap() for speed: (x % W + W) % W
                let wx = x % W;
                if (wx < 0) wx += W;

                const i = wx + y * W;
                const p = pixelPositions[i];

                if (debugBB) {
                    Daydream.pixels[i * 3] += 0.02;
                    Daydream.pixels[i * 3 + 1] += 0.02;
                    Daydream.pixels[i * 3 + 2] += 0.02;
                }

                // 2. Distance Check
                shape.distance(p, sampleResult);
                const d = sampleResult.dist;

                // 3. AA & Plot
                if (d < threshold) {
                    let aaAlpha = 1.0;

                    if (shape.isSolid) {
                        const t = 0.5 - d / (2 * pixelWidth);
                        const tc = t < 0 ? 0 : (t > 1 ? 1 : t);
                        aaAlpha = quinticKernel(tc);
                    } else {
                        if (shape.thickness > 0) {
                            aaAlpha = quinticKernel(-d / shape.thickness);
                        }
                    }

                    const c = shaderFn(p, sampleResult.t, sampleResult.dist, sampleResult.faceIndex, sampleResult);
                    const color = c.isColor ? c : (c.color || c);
                    const baseAlpha = (c.alpha !== undefined ? c.alpha : 1.0);

                    pipeline.plot2D(wx, y, color, 0, baseAlpha * aaAlpha);


                }
            }
        };

        for (let y = yMin; y <= yMax; y++) {
            let intervals = null;
            if (shape.getHorizontalBounds) {
                intervals = shape.getHorizontalBounds(y);
            }

            if (intervals) {
                for (let k = 0; k < intervals.length; k++) {
                    const iv = intervals[k];
                    runScanline(iv.start, iv.end, y);
                }
            } else {
                runScanline(0, W - 1, y);
            }
        }
    },

    DistortedRing: class {
        /**
         * Scans a distorted thick ring.
         * @param {Object} pipeline - Render pipeline.
         * @param {THREE.Quaternion} orientation - Ring orientation quaternion.
         * @param {THREE.Vector3} normal - Local ring axis.
         * @param {number} radius - Base angular radius.
         * @param {number} thickness - Angular thickness.
         * @param {Function} shiftFn - (t: 0..1) => shift in radians.
         * @param {number} maxDistortion - Max abs(shift) for bucket optimization.
         * @param {Function} materialFn - (pos, t, dist) => {color, alpha}.
         */
        static draw(pipeline, basis, radius, thickness, shiftFn, maxDistortion, shaderFn, phase = 0, debugBB = false) {
            const shape = new SDF.DistortedRing(basis, radius, thickness, shiftFn, maxDistortion, phase);
            Scan.rasterize(pipeline, shape, shaderFn, debugBB);
        }
    },


    Polygon: class {
        /**
         * @param {Object} pipeline - Pipeline.
         * @param {Object} basis - Basis.
         * @param {number} radius - Radius.
         * @param {number} sides - Sides.
         * @param {Function} shaderFn - Color function.
         * @param {number} [phase=0] - Phase.
         * @param {boolean} [debugBB=false] - Debug.
         */
        static draw(pipeline, basis, radius, sides, shaderFn, phase = 0, debugBB = false) {
            let { v, u, w } = basis;
            if (radius > 1.0) {
                v = vectorPool.acquire().copy(v).negate();
                u = vectorPool.acquire().copy(u).negate();
                radius = 2.0 - radius;
            }

            const thickness = radius * (Math.PI / 2);
            const shape = new SDF.Polygon({ v, u, w }, radius, thickness, sides, phase);
            const renderColorFn = (p, t, d) => shaderFn(p, 0, d);
            Scan.rasterize(pipeline, shape, renderColorFn, debugBB);
        }
    },

    Star: class {
        /**
         * @param {Object} pipeline - Pipeline.
         * @param {Object} basis - Basis.
         * @param {number} radius - Radius.
         * @param {number} sides - Sides.
         * @param {Function} shaderFn - Color function.
         * @param {number} [phase=0] - Phase.
         * @param {boolean} [debugBB=false] - Debug.
         */
        static draw(pipeline, basis, radius, sides, shaderFn, phase = 0, debugBB = false) {
            let { v, u, w } = basis;
            if (radius > 1.0) {
                v = vectorPool.acquire().copy(v).negate();
                u = vectorPool.acquire().copy(u).negate();
                radius = 2.0 - radius;
            }
            const shape = new SDF.Star({ v, u, w }, radius, sides, phase);
            const renderColorFn = (p, t, d) => shaderFn(p, 0, d);
            Scan.rasterize(pipeline, shape, renderColorFn, debugBB);
        }
    },

    Flower: class {
        /**
         * @param {Object} pipeline - Pipeline.
         * @param {Object} basis - Basis.
         * @param {number} radius - Radius.
         * @param {number} sides - Sides.
         * @param {Function} shaderFn - Color function.
         * @param {number} [phase=0] - Phase.
         * @param {boolean} [debugBB=false] - Debug.
         */
        static draw(pipeline, basis, radius, sides, shaderFn, phase = 0, debugBB = false) {
            let { v, u, w } = basis;
            if (radius > 1.0) {
                v = vectorPool.acquire().copy(v).negate();
                u = vectorPool.acquire().copy(u).negate();
                radius = 2.0 - radius;
            }
            const shape = new SDF.Flower({ v, u, w }, radius, sides, phase);
            const renderColorFn = (p, t, d) => shaderFn(p, 0, d);
            Scan.rasterize(pipeline, shape, renderColorFn, debugBB);
        }
    },

    Circle: class {
        /**
         * Scans a solid circle (disk) on the sphere.
         * @param {Object} pipeline - Render pipeline.
         * @param {THREE.Vector3} normal - Center of the circle.
         * @param {number} radius - Angular radius (0-2).
         * @param {Function} shaderFn - (pos, t, dist) => {color, alpha}.
         * @param {Object} options - Options.
         */
        static draw(pipeline, basis, radius, shaderFn, phase = 0, debugBB = false) {
            // A circle is a ring with radius 0 and thickness = radius
            const thickness = radius * (Math.PI / 2);
            Scan.Ring.draw(pipeline, basis, 0, thickness, shaderFn, phase, debugBB);
        }
    },

    Ring: class {
        /**
         * Scans a thick ring and feeds pixels into the pipeline.
         * @param {Object} pipeline - The render pipeline (must support plot2D).
         * @param {THREE.Quaternion} orientationQuaternion - Ring orientation.
         * @param {THREE.Vector3} normal - Ring orientation.
         * @param {number} radius - Angular radius (0-2).
         * @param {number} thickness - Angular thickness.
         * @param {Function} shaderFn - (pos, t, dist) => {color, alpha}.
         * @param {number} [phase=0] - Phase of the ring.
         * @param {boolean} [debugBB=false] - Whether to show bounding boxes.
         */
        static draw(pipeline, basis, radius, thickness, shaderFn, phase = 0, debugBB = false) {
            const shape = new SDF.Ring(basis, radius, thickness, phase);
            Scan.rasterize(pipeline, shape, shaderFn, debugBB);
        }
    },

    Line: class {
        /**
         * Scans a line between two points. (Simplified Scan).
         * @param {Object} pipeline - Render pipeline.
         * @param {Object} pixels - Pixel buffer (unused in signature but implied environment).
         * @param {THREE.Vector3} v1 - Start point.
         * @param {THREE.Vector3} v2 - End point.
         * @param {number} thickness - Line thickness.
         * @param {Function} shaderFn - Color function.
         * @param {Object} options - Options.
         */
        static draw(pipeline, pixels, v1, v2, thickness, shaderFn, options = {}) {
            const normal = vectorPool.acquire().crossVectors(v1, v2).normalize();
            if (normal.lengthSq() < 0.000001) return;

            const c1 = vectorPool.acquire().crossVectors(normal, v1);
            const c2 = vectorPool.acquire().crossVectors(v2, normal);

            let maxY = Math.max(v1.y, v2.y);
            let minY = Math.min(v1.y, v2.y);
            const apexPlaneNormal = vectorPool.acquire().crossVectors(normal, Daydream.UP);
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

            Scan.Ring.draw(pipeline, { v: normal, u: c1, w: c2 }, 1.0, thickness, shaderFn, 0, 2 * Math.PI, {
                ...options,
                clipPlanes: [c1, c2], // SDF.face handles clip planes logic? No, this Line draw logic seems custom or tied to Ring limit logic which moved to Ring getVerticalBounds
                limits: { minPhi, maxPhi } // Ring supports basis.limits
            });
        }
    },

    Mesh: class {
        /**
         * Scans a solid mesh face by face.
         * @param {Object} pipeline - Render pipeline.
         * @param {Object} mesh - {vertices: Vector3[], faces: number[][]}.
         * @param {Function} shaderFn - Color function.
         * @param {boolean} [debugBB=false] - Debug.
         */
        static draw(pipeline, mesh, shaderFn, debugBB = false) {
            facePool.reset();
            for (let i = 0; i < mesh.faces.length; i++) {
                const faceIndices = mesh.faces[i];

                // Acquire a reused Face object
                const shape = facePool.acquire();

                // Init with existing mesh vertices and indices
                shape.init(mesh.vertices, faceIndices, 0);

                let renderColorFn;

                const vertexData = [];
                for (let k = 0; k < faceIndices.length; k++) {
                    vertexData.push(shaderFn(mesh.vertices[faceIndices[k]], faceIndices[k], i));
                }

                renderColorFn = (p, t, dist, faceIdx, out) => {
                    const w = out.weights;

                    // Barycentric Mix
                    if (w) {
                        const d0 = vertexData[w.i0];
                        const d1 = vertexData[w.i1];
                        const d2 = vertexData[w.i2];

                        _scanScratch.v0 = d0.v0 * w.a + d1.v0 * w.b + d2.v0 * w.c;
                        _scanScratch.v1 = d0.v1 * w.a + d1.v1 * w.b + d2.v1 * w.c;
                        _scanScratch.v2 = d0.v2 * w.a + d1.v2 * w.b + d2.v2 * w.c;
                        _scanScratch.v3 = d0.v3 * w.a + d1.v3 * w.b + d2.v3 * w.c;

                        return shaderFn.color(_scanScratch, t, dist);
                    }
                    // Fallback
                    return shaderFn.color(vertexData[0], t, dist);
                };
                Scan.rasterize(pipeline, shape, renderColorFn, debugBB);
            }
        }
    },

    Point: class {
        /**
         * @param {Object} pipeline - Pipeline.
         * @param {THREE.Vector3} pos - Position.
         * @param {number} thickness - Thickness.
         * @param {Function} shaderFn - Color function.
         * @param {Object} options - Options.
         */
        static draw(pipeline, pos, thickness, shaderFn, options) {
            const identity = new THREE.Quaternion().identity();
            const basis = makeBasis(identity, pos);
            // A point is a Ring with radius 0 and some thickness
            Scan.Ring.draw(pipeline, basis, 0, thickness, shaderFn, 0, options && options.debugBB);
        }
    },

    Field: class {
        /**
         * @param {Object} pipeline - Pipeline.
         * @param {Function} shaderFn - Color function.
         */
        static draw(pipeline, shaderFn) {
            for (let i = 0; i < Daydream.pixelPositions.length; i++) {
                const x = i % Daydream.W;
                const y = (i / Daydream.W) | 0;

                const p = Daydream.pixelPositions[i];
                const mat = shaderFn(p);
                const color = mat.isColor ? mat : (mat.color || mat);
                const alpha = (mat.alpha !== undefined ? mat.alpha : 1.0);

                if (pipeline.plot) {
                    pipeline.plot(p, color, 0, alpha);
                } else if (pipeline.plot2D) {
                    pipeline.plot2D(x, y, color, 0, alpha);
                }
            }
        }
    }
};


