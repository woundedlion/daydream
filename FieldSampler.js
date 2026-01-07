/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { Daydream, XY } from "./driver.js";
import { quinticKernel } from "./filters.js";
import { blendAlpha } from "./color.js";
import { wrap } from "./util.js";
import { vectorToPixel } from "./geometry.js";

/**
 * Encapsulates the logic for rendering a single ring on the spherical display.
 */
export class FSRing {
    /**
     * @param {THREE.Vector3} normal - The normal vector defining the ring's orientation.
     * @param {number} radius - The angular radius (0=Pole, 1=Equator, 2=Opposite Pole).
     * @param {Color4} color - The color of the ring.
     */
    constructor(normal, radius, color) {
        this.normal = normal;
        this.radius = radius;
        this.color = color;

        // Pre-calculate orientation properties
        this.nx = normal.x;
        this.ny = normal.y;
        this.nz = normal.z;

        // Angle from the normal pole
        this.targetAngle = radius * (Math.PI / 2);
        // Distance of the plane from origin along normal (for intersection math)
        this.planeOffset = Math.cos(this.targetAngle);

        this.R = Math.sqrt(this.nx * this.nx + this.nz * this.nz);
        this.alpha = Math.atan2(this.nx, this.nz);
        this.centerPhi = Math.acos(this.ny);
    }

    /**
     * Draws the ring onto the screen.
     * @param {number} thickness - Angular thickness of the ring.
     * @param {boolean} [debugBB=false] - Whether to visualize bounding box.
     */
    draw(thickness, debugBB = false) {
        // 1. CALCULATE VERTICAL BOUNDS
        // The extreme latitudes of the ring occur along the meridian of the normal.
        // These are simply centerPhi - targetAngle and centerPhi + targetAngle.
        // We use acos(cos(x)) to correctly wrap these angles into [0, PI], handling pole crossings.
        const a1 = this.centerPhi - this.targetAngle;
        const a2 = this.centerPhi + this.targetAngle;
        const p1 = Math.acos(Math.cos(a1));
        const p2 = Math.acos(Math.cos(a2));

        const minP = Math.min(p1, p2);
        const maxP = Math.max(p1, p2);

        const phiMin = Math.max(0, minP - thickness);
        const phiMax = Math.min(Math.PI, maxP + thickness);

        const yMin = Math.max(0, Math.floor((phiMin * (Daydream.H - 1)) / Math.PI));
        const yMax = Math.min(Daydream.H - 1, Math.ceil((phiMax * (Daydream.H - 1)) / Math.PI));

        for (let y = yMin; y <= yMax; y++) {
            this.scanRow(y, thickness, debugBB);
        }
    }

    /**
     * Scans a single row of the texture.
     * @param {number} y - Row index.
     * @param {number} thickness - Ring thickness.
     * @param {boolean} debugBB - Debug flag.
     */
    scanRow(y, thickness, debugBB) {
        const phi = (y * Math.PI) / (Daydream.H - 1);
        const y3d = Math.cos(phi);
        const rXZ = Math.sin(phi);

        // Case A: Singularity (Poles or Vertical Normal)
        if (this.R < 0.01) {
            this.scanFullRow(y, thickness, debugBB);
            return;
        }

        // Case B: General Intersection
        // We want the dot product P.N to be within [cos(target+thick), cos(target-thick)].
        // P.N = cos(theta - alpha) * R * rXZ + ny * y3d
        // So cos(theta - alpha) = (D - ny * y3d) / (R * rXZ)
        // We calculate the min/max allowed D (dot product values).

        const ang_low = Math.max(0, this.targetAngle - thickness);
        const ang_high = Math.min(Math.PI, this.targetAngle + thickness);

        // Cosine decreases as angle increases
        const D_max = Math.cos(ang_low);
        const D_min = Math.cos(ang_high);

        const denom = this.R * rXZ;
        // Check for singularity to avoid Infinity (though clamp usually handles it)
        if (denom < 0.000001) {
            this.scanFullRow(y, thickness, debugBB);
            return;
        }

        const C_min = (D_min - this.ny * y3d) / denom;
        const C_max = (D_max - this.ny * y3d) / denom;

        const minCos = Math.max(-1, C_min);
        const maxCos = Math.min(1, C_max);

        // If no solution (too far), skip row
        if (minCos > maxCos) return;

        const angleMin = Math.acos(maxCos);
        const angleMax = Math.acos(minCos);

        // Generate scan windows
        if (angleMin <= 0.0001) {
            this.scanWindow(y, this.alpha - angleMax, this.alpha + angleMax, thickness, debugBB);
        } else if (angleMax >= Math.PI - 0.0001) {
            this.scanWindow(y, this.alpha + angleMin, this.alpha + 2 * Math.PI - angleMin, thickness, debugBB);
        } else {
            this.scanWindow(y, this.alpha - angleMax, this.alpha - angleMin, thickness, debugBB);
            this.scanWindow(y, this.alpha + angleMin, this.alpha + angleMax, thickness, debugBB);
        }
    }

    scanFullRow(y, thickness, debugBB) {
        for (let x = 0; x < Daydream.W; x++) {
            this.processPixel(XY(x, y), thickness, debugBB);
        }
    }

    scanWindow(y, t1, t2, thickness, debugBB) {
        const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
        const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));

        for (let x = x1; x <= x2; x++) {
            const wx = wrap(x, Daydream.W);
            this.processPixel(XY(wx, y), thickness, debugBB);
        }
    }

    processPixel(i, thickness, debugBB) {
        if (debugBB) {
            const outColor = Daydream.pixels[i];
            outColor.r += 0.02; outColor.g += 0.02; outColor.b += 0.02;
        }

        const p = Daydream.pixelPositions[i];
        const dot = p.dot(this.normal);
        // Robust acos
        const angle = Math.acos(Math.min(1, Math.max(-1, dot)));
        const dist = Math.abs(angle - this.targetAngle);

        if (dist < thickness) {
            const t = dist / thickness;
            const alpha = quinticKernel(1 - t) * this.color.alpha;
            const outColor = Daydream.pixels[i];
            blendAlpha(outColor, this.color.color, alpha, outColor);
        }
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
        const cosThreshold = Math.cos(thickness);
        const radY = thickness * (Daydream.H - 1) / Math.PI;

        for (const pt of points) {
            const center = vectorToPixel(pt.pos);
            const cy = center.y;
            const cx = center.x;

            const phi = cy * Math.PI / (Daydream.H - 1);
            const sinPhi = Math.sin(phi);
            let radX;
            if (Math.abs(sinPhi) < 0.05) {
                radX = Daydream.W;
            } else {
                radX = (thickness * Daydream.W) / (2 * Math.PI * sinPhi);
            }

            const yMin = Math.max(0, Math.ceil(cy - radY));
            const yMax = Math.min(Daydream.H - 1, Math.floor(cy + radY));
            const xMin = Math.ceil(cx - radX);
            const xMax = Math.floor(cx + radX);

            for (let y = yMin; y <= yMax; y++) {
                for (let x = xMin; x <= xMax; x++) {
                    const wx = wrap(x, Daydream.W);
                    const i = XY(wx, y);

                    if (this.debugBB) this.debugPixel(i);

                    const p = Daydream.pixelPositions[i];
                    const dot = p.dot(pt.pos);

                    if (dot > cosThreshold) {
                        const dist = Math.acos(Math.min(1, Math.max(-1, dot)));
                        const t = dist / thickness;
                        const alpha = quinticKernel(1 - t) * pt.color.alpha;
                        const outColor = Daydream.pixels[i];
                        blendAlpha(outColor, pt.color.color, alpha, outColor);
                    }
                }
            }
        }
    }

    drawRing(normal, radius, color4, thickness) {
        // Delegate to FSRing
        const ring = new FSRing(normal, radius, color4);
        ring.draw(thickness, this.debugBB);
    }

    drawPlanes(planes, thickness) {
        for (const plane of planes) {
            this.drawRing(plane.normal, 1.0, plane.color, thickness);
        }
    }
}
