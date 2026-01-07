/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream, XY } from "./driver.js";
import { quinticKernel } from "./filters.js";
import { blendAlpha } from "./color.js";
import { wrap } from "./util.js";
import { angleBetween, vectorToPixel, yToPhi } from "./geometry.js";

/**
 * Encapsulates the logic for rendering a single ring on the spherical display.
 * Stateless helper class.
 */
export class FSRing {
    /**
     * Draws the ring (or partial arc) onto the screen.
     * @param {THREE.Vector3} normal - Ring orientation.
     * @param {number} radius - Angular radius (0-2).
     * @param {Color4} color - Ring color.
     * @param {number} thickness - Angular thickness.
     * @param {number} [startAngle=0] - Start of the arc in radians (0 to 2PI).
     * @param {number} [endAngle=6.28318] - End of the arc in radians.
     * @param {boolean} [debugBB=false] - Debug flag.
     * @param {Array<THREE.Vector3>} [clipPlanes=null] - Optional normals defining clipping planes (Legacy).
     * @param {Object} [limits=null] - Optional vertical limits { minPhi, maxPhi }.
     */
    static draw(normal, radius, color, thickness, startAngle = 0, endAngle = 2 * Math.PI, debugBB = false, clipPlanes = null, limits = null) {
        // Pre-calculate properties
        const nx = normal.x;
        const ny = normal.y;
        const nz = normal.z;

        // --- 1. Construct Basis for Azimuth/Angle checks ---
        // We need a stable basis (u, w) on the ring plane to measure angles.
        // This logic matches the C++ sample_ring implementation.
        let ref = new THREE.Vector3(1, 0, 0); // X_AXIS
        if (Math.abs(normal.dot(ref)) > 0.9999) {
            ref.set(0, 1, 0); // Y_AXIS
        }

        // U = Cross(Normal, Ref) -> Perpendicular to Normal
        const u = new THREE.Vector3().crossVectors(normal, ref).normalize();
        // W = Cross(Normal, U) -> Completes the orthonormal basis on the ring plane
        const w = new THREE.Vector3().crossVectors(normal, u).normalize();

        const targetAngle = radius * (Math.PI / 2);
        const R = Math.sqrt(nx * nx + nz * nz);
        const alpha = Math.atan2(nx, nz);
        const centerPhi = Math.acos(ny);

        // Check if we need to perform sector checks (is it a partial ring?)
        // We check if the arc length is essentially 2PI
        const isFullCircle = Math.abs(endAngle - startAngle) >= 2 * Math.PI - 0.001;

        // Context object to pass through the stack
        const ctx = {
            normal, radius, color, thickness, debugBB, clipPlanes,
            nx, ny, nz, targetAngle, R, alpha, centerPhi,
            u, w, startAngle, endAngle,
            checkSector: !isFullCircle
        };

        // --- 2. CALCULATE VERTICAL BOUNDS (Global Ring) ---
        // The extreme latitudes of the ring occur along the meridian of the normal.
        const a1 = centerPhi - targetAngle;
        const a2 = centerPhi + targetAngle;
        const p1 = Math.acos(Math.cos(a1));
        const p2 = Math.acos(Math.cos(a2));

        const minP = Math.min(p1, p2);
        const maxP = Math.max(p1, p2);

        let phiMin = Math.max(0, minP - thickness);
        let phiMax = Math.min(Math.PI, maxP + thickness);

        // --- 3. APPLY OPTIONAL LIMITS (Intersection) ---
        // If the caller provided tighter bounds (e.g. for a line segment), use them.
        if (limits) {
            phiMin = Math.max(phiMin, limits.minPhi);
            phiMax = Math.min(phiMax, limits.maxPhi);
        }

        if (phiMin > phiMax) return;

        const yMin = Math.max(0, Math.floor((phiMin * (Daydream.H - 1)) / Math.PI));
        const yMax = Math.min(Daydream.H - 1, Math.ceil((phiMax * (Daydream.H - 1)) / Math.PI));

        for (let y = yMin; y <= yMax; y++) {
            FSRing.scanRow(y, ctx);
        }
    }

    static scanRow(y, ctx) {
        const phi = yToPhi(y);
        const cosPhi = Math.cos(phi);
        const sinPhi = Math.sin(phi);

        // Case A: Singularity (Poles or Vertical Normal)
        if (ctx.R < 0.01) {
            FSRing.scanFullRow(y, ctx);
            return;
        }

        // Case B: General Intersection
        const ang_low = Math.max(0, ctx.targetAngle - ctx.thickness);
        const ang_high = Math.min(Math.PI, ctx.targetAngle + ctx.thickness);

        // Cosine decreases as angle increases
        const D_max = Math.cos(ang_low);
        const D_min = Math.cos(ang_high);

        const denom = ctx.R * sinPhi;
        // Check for singularity
        if (Math.abs(denom) < 0.000001) {
            // Optimization: If the ring is "flat" at this latitude, we only scan if we are inside the band.
            // Since we rely on yMin/yMax bounds calculated in draw(), if we are here, we are likely inside.
            FSRing.scanFullRow(y, ctx);
            return;
        }

        const C_min = (D_min - ctx.ny * cosPhi) / denom;
        const C_max = (D_max - ctx.ny * cosPhi) / denom;

        const minCos = Math.max(-1, C_min);
        const maxCos = Math.min(1, C_max);
        if (minCos > maxCos) return;

        const angleMin = Math.acos(maxCos);
        const angleMax = Math.acos(minCos);

        // Generate scan windows
        if (angleMin <= 0.0001) {
            FSRing.scanWindow(y, ctx.alpha - angleMax, ctx.alpha + angleMax, ctx);
        } else if (angleMax >= Math.PI - 0.0001) {
            FSRing.scanWindow(y, ctx.alpha + angleMin, ctx.alpha + 2 * Math.PI - angleMin, ctx);
        } else {
            FSRing.scanWindow(y, ctx.alpha - angleMax, ctx.alpha - angleMin, ctx);
            FSRing.scanWindow(y, ctx.alpha + angleMin, ctx.alpha + angleMax, ctx);
        }
    }

    static scanFullRow(y, ctx) {
        for (let x = 0; x < Daydream.W; x++) {
            FSRing.processPixel(XY(x, y), ctx);
        }
    }

    static scanWindow(y, t1, t2, ctx) {
        const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
        const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));

        for (let x = x1; x <= x2; x++) {
            const wx = wrap(x, Daydream.W);
            FSRing.processPixel(XY(wx, y), ctx);
        }
    }

    static processPixel(i, ctx) {
        if (ctx.debugBB) {
            const outColor = Daydream.pixels[i];
            outColor.r += 0.02; outColor.g += 0.02; outColor.b += 0.02;
        }

        const p = Daydream.pixelPositions[i];

        // 1. Clipping Planes (Legacy method for Lines)
        if (ctx.clipPlanes) {
            for (const cp of ctx.clipPlanes) {
                if (p.dot(cp) < 0) return;
            }
        }

        const polarAngle = angleBetween(p, ctx.normal);
        const dist = Math.abs(polarAngle - ctx.targetAngle);

        if (dist < ctx.thickness) {
            // 2. Sector Check (Start/End Angles)
            if (ctx.checkSector) {
                // Project P onto the basis vectors U and W to find the azimuth
                const dotU = p.dot(ctx.u);
                const dotW = p.dot(ctx.w);
                let azimuth = Math.atan2(dotW, dotU);

                // Wrap azimuth to [0, 2PI)
                if (azimuth < 0) azimuth += 2 * Math.PI;

                // Check containment
                let inside = false;
                if (ctx.startAngle <= ctx.endAngle) {
                    inside = (azimuth >= ctx.startAngle && azimuth <= ctx.endAngle);
                } else {
                    // Crossing the 0/360 boundary (e.g. 350 to 10 degrees)
                    inside = (azimuth >= ctx.startAngle || azimuth <= ctx.endAngle);
                }

                if (!inside) return;
            }

            // 3. Render
            const t = dist / ctx.thickness;
            const alpha = quinticKernel(1 - t) * ctx.color.alpha;
            const outColor = Daydream.pixels[i];
            blendAlpha(outColor, ctx.color.color, alpha, outColor);
        }
    }
}

// Stateless helper for rendering points (comets)
export class FSPoint {
    /**
     * Draws a point (comet) onto the screen.
     * @param {THREE.Vector3} pos - Position of the point.
     * @param {Color4} color - Point color.
     * @param {number} thickness - Angular size of the point.
     * @param {boolean} [debugBB=false] - Debug flag.
     */
    static draw(pos, color, thickness, debugBB = false) {
        // A point is just a ring with radius 0
        FSRing.draw(pos, 0, color, thickness, 0, 2 * Math.PI, debugBB);
    }
}

// Stateless helper for rendering great circle segments
export class FSLine {
    /**
     * Draws a line segment (geodesic) between two points.
     * @param {THREE.Vector3} v1 - Start position.
     * @param {THREE.Vector3} v2 - End position.
     * @param {Color4} color - Line color.
     * @param {number} thickness - Angular thickness.
     * @param {boolean} [debugBB=false] - Debug flag.
     */
    static draw(v1, v2, color, thickness, debugBB = false) {
        // 1. Calculate Normal of the Great Circle passing through v1 and v2
        const normal = new THREE.Vector3().crossVectors(v1, v2).normalize();

        // Handle coincident vectors (no line)
        if (normal.lengthSq() < 0.000001) return;

        // 2. Define Clipping Planes (Fastest way to check segment bounds in pixel shader)
        // Plane 1: Passes through v1, normal = normal x v1
        const c1 = new THREE.Vector3().crossVectors(normal, v1);
        // Plane 2: Passes through v2, normal = v2 x normal
        const c2 = new THREE.Vector3().crossVectors(v2, normal);

        // 3. OPTIMIZATION: Calculate Vertical Bounds of the Segment
        // We find the min/max Y of the segment to limit the scan area.

        let maxY = Math.max(v1.y, v2.y);
        let minY = Math.min(v1.y, v2.y);

        // Calculate the normal of the plane containing the Y-axis and the Ring Normal.
        // This plane cuts the ring at its highest and lowest points (Apex/Antipex).
        const apexPlaneNormal = new THREE.Vector3().crossVectors(normal, new THREE.Vector3(0, 1, 0));

        // If normal is parallel to Y (horizontal ring), cross product is 0. 
        // In that case, Y is constant, so min/max from endpoints is already correct.
        if (apexPlaneNormal.lengthSq() > 0.0001) {
            // Check if the segment crosses the Apex/Antipex plane
            const d1 = v1.dot(apexPlaneNormal);
            const d2 = v2.dot(apexPlaneNormal);

            if (d1 * d2 <= 0) {
                // Segment crosses the extremum line.
                // It contains either the Top (Max Y) or Bottom (Min Y) of the full circle.
                // Since we assume short segments (< 180 deg), it contains only one.
                const globalMaxY = Math.sqrt(1 - normal.y * normal.y);

                if (v1.y + v2.y > 0) {
                    // Northern Hemisphere -> Contains Top
                    maxY = globalMaxY;
                } else {
                    // Southern Hemisphere -> Contains Bottom
                    minY = -globalMaxY;
                }
            }
        }

        // Convert Y bounds to Phi bounds (with thickness padding)
        const minPhi = Math.acos(Math.min(1, Math.max(-1, maxY))) - thickness;
        const maxPhi = Math.acos(Math.min(1, Math.max(-1, minY))) + thickness;

        // We use full circle (0 to 2PI) for angles because we use Clipping Planes for the cut
        FSRing.draw(normal, 1.0, color, thickness, 0, 2 * Math.PI, debugBB, [c1, c2], { minPhi, maxPhi });
    }
}

export class FieldSampler {
    constructor() {
        this.debugBB = false;
    }

    debugPixel(i) {
        const outColor = Daydream.pixels[i];
        outColor.r += 0.02;
        outColor.g += 0.02;
        outColor.b += 0.02;
    }

    /**
     * Draws a list of points (comets) onto the sphere using field sampling.
     * @param {Array<{pos: THREE.Vector3, color: Color4}>} points 
     * @param {number} thickness - Angular thickness of the influence.
     */
    drawPoints(points, thickness) {
        for (const pt of points) {
            const pos = pt.position || pt.pos;
            let color = pt.color;
            if (pt.alpha !== undefined && color.isColor) {
                color = { color: pt.color, alpha: pt.alpha };
            }
            FSPoint.draw(pos, color, thickness, this.debugBB);
        }
    }

    /**
     * Draws a line segment between two vectors.
     * @param {THREE.Vector3} v1 
     * @param {THREE.Vector3} v2 
     * @param {Color4} color 
     * @param {number} thickness 
     */
    drawLine(v1, v2, color, thickness) {
        FSLine.draw(v1, v2, color, thickness, this.debugBB);
    }

    /**
     * Draws a ring using the new start/end angle support.
     */
    drawRing(normal, radius, color4, thickness, startAngle = 0, endAngle = 2 * Math.PI) {
        FSRing.draw(normal, radius, color4, thickness, startAngle, endAngle, this.debugBB);
    }
}