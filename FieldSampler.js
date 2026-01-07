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
     * Draws the ring onto the screen.
     * @param {THREE.Vector3} normal - Ring orientation.
     * @param {number} radius - Angular radius (0-2).
     * @param {Color4} color - Ring color.
     * @param {number} thickness - Angular thickness.
     * @param {boolean} [debugBB=false] - Debug flag.
     * @param {Array<THREE.Vector3>} [clipPlanes=null] - Optional normals defining clipping planes.
     */
    static draw(normal, radius, color, thickness, debugBB = false, clipPlanes = null) {
        // Pre-calculate properties
        const nx = normal.x;
        const ny = normal.y;
        const nz = normal.z;

        const targetAngle = radius * (Math.PI / 2);
        const R = Math.sqrt(nx * nx + nz * nz);
        const alpha = Math.atan2(nx, nz);
        const centerPhi = Math.acos(ny);

        // Context object to pass through the stack (avoids class state)
        const ctx = {
            normal, radius, color, thickness, debugBB, clipPlanes,
            nx, ny, nz, targetAngle, R, alpha, centerPhi
        };

        // 1. CALCULATE VERTICAL BOUNDS
        // The extreme latitudes of the ring occur along the meridian of the normal.
        // These are simply centerPhi - targetAngle and centerPhi + targetAngle.
        // We use acos(cos(x)) to correctly wrap these angles into [0, PI], handling pole crossings.
        const a1 = centerPhi - targetAngle;
        const a2 = centerPhi + targetAngle;
        const p1 = Math.acos(Math.cos(a1));
        const p2 = Math.acos(Math.cos(a2));

        const minP = Math.min(p1, p2);
        const maxP = Math.max(p1, p2);

        const phiMin = Math.max(0, minP - thickness);
        const phiMax = Math.min(Math.PI, maxP + thickness);

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
        // We want the dot product P.N to be within [cos(target+thick), cos(target-thick)].
        // P.N = cos(theta - alpha) * R * sinPhi + ny * cosPhi
        // So cos(theta - alpha) = (D - ny * cosPhi) / (R * sinPhi)
        // We calculate the min/max allowed D (dot product values).

        const ang_low = Math.max(0, ctx.targetAngle - ctx.thickness);
        const ang_high = Math.min(Math.PI, ctx.targetAngle + ctx.thickness);

        // Cosine decreases as angle increases
        const D_max = Math.cos(ang_low);
        const D_min = Math.cos(ang_high);

        const denom = ctx.R * sinPhi;
        // Check for singularity to avoid Infinity (though clamp usually handles it)
        if (Math.abs(denom) < 0.000001) {
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

        // Apply Clipping Planes
        if (ctx.clipPlanes) {
            for (const cp of ctx.clipPlanes) {
                if (p.dot(cp) < 0) return;
            }
        }

        const angle = angleBetween(p, ctx.normal);
        const dist = Math.abs(angle - ctx.targetAngle);
        if (dist < ctx.thickness) {
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
        FSRing.draw(pos, 0, color, thickness, debugBB);
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

        // 2. Define Clipping Planes
        // Plane 1: Passes through v1, normal = normal x v1
        const c1 = new THREE.Vector3().crossVectors(normal, v1);
        // Plane 2: Passes through v2, normal = v2 x normal
        const c2 = new THREE.Vector3().crossVectors(v2, normal);

        // Note: For points ON the great circle, v1 x v2 = normal * sin(theta).
        // c1 = (v1 x v2 / |v1xv2|) x v1.
        // Direction check:
        // v2 is on positive side of c1? (v2 . c1) > 0 ?
        // v2 . ( (v1 x v2) x v1 )
        // Using vector triple product: (A x B) x C = (A.C)B - (B.C)A
        // (N x v1) . v2 = N . (v1 x v2) = N . N > 0. Yes.

        FSRing.draw(normal, 1.0, color, thickness, debugBB, [c1, c2]);
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
            FSPoint.draw(pt.pos, pt.color, thickness, this.debugBB);
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

    drawRing(normal, radius, color4, thickness) {
        // Delegate to FSRing
        FSRing.draw(normal, radius, color4, thickness, this.debugBB);
    }

    drawPlanes(planes, thickness) {
        for (const plane of planes) {
            this.drawRing(plane.normal, 1.0, plane.color, thickness);
        }
    }
}
