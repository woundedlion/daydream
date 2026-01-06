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



export class FieldSampler {
    constructor() {
        this.debugBB = false;
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
        const nx = normal.x;
        const ny = normal.y;
        const nz = normal.z;
        const lineRadius = thickness / 2;
        const plane = { normal: normal, color: color4 };

        // Calculate latitude bounds
        const h = Math.sqrt(1 - ny * ny);
        const phiMin = Math.acos(Math.min(1, h)) - lineRadius;
        const phiMax = Math.acos(Math.max(-1, -h)) + lineRadius;
        const yMin = Math.max(0, Math.floor((phiMin * (Daydream.H - 1)) / Math.PI));
        const yMax = Math.min(Daydream.H - 1, Math.ceil((phiMax * (Daydream.H - 1)) / Math.PI));

        for (let y = yMin; y <= yMax; y++) {
            // Pre-calculate geometric properties for this specific row (latitude).
            // phi: Angle down from the North Pole (0 to PI).
            // y3d: The Y coordinate of this row in 3D space (cos(phi)).
            // rXZ: The radius of the sphere's cross-section at this height (sin(phi)).
            const phi = (y * Math.PI) / (Daydream.H - 1);
            const y3d = Math.cos(phi);
            const rXZ = Math.sin(phi);



            // Magnitude of the normal projected onto the XZ plane.
            const R = Math.sqrt(nx * nx + nz * nz);

            // 2. SINGULARITY CHECK (Horizontal Rings)
            // If the plane is nearly horizontal (normal points up/down, so R is small),
            // or if we are at the poles (rXZ is small), the analytical solution is unstable.
            // In these cases, the ring covers nearly the entire row, so we fallback 
            // to scanning the whole row (0 to W).
            if (R < 0.01) {
                for (let x = 0; x < Daydream.W; x++) {
                    const i = XY(x, y);
                    this.processPlanePixel(i, plane, thickness);
                    if (this.debugBB) this.debugPixel(i);
                }
                continue;
            }

            // 3. HORIZONTAL OPTIMIZATION (Exact Arc Calculation)
            // We solve for the range of theta where: |cos(theta - alpha) - C| < K
            const C = (-ny * y3d) / (R * rXZ);
            const K = (thickness * 1.1) / (R * rXZ);

            // Determine valid cosine range clamped to [-1, 1]
            const minCos = Math.max(-1, C - K);
            const maxCos = Math.min(1, C + K);

            // If interval is empty (e.g. ring is too far away), skip
            if (minCos > maxCos) continue;

            // Calculate angular extents relative to alpha
            // acos decreases from 0 to PI as input goes from 1 to -1
            const angleMin = Math.acos(maxCos);
            const angleMax = Math.acos(minCos);
            const alpha = Math.atan2(nx, nz);

            // Define scan windows
            const windows = [];
            if (angleMin <= 0.0001) {
                // Merged at the front (near alpha) because band covers the peak
                windows.push([alpha - angleMax, alpha + angleMax]);
            } else if (angleMax >= Math.PI - 0.0001) {
                // Merged at the back (opposite to alpha)
                windows.push([alpha + angleMin, alpha + 2 * Math.PI - angleMin]);
            } else {
                // Two separate windows on either side of alpha
                windows.push([alpha - angleMax, alpha - angleMin]);
                windows.push([alpha + angleMin, alpha + angleMax]);
            }

            // Scan pixels within windows
            for (const [t1, t2] of windows) {
                const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
                const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));

                for (let x = x1; x <= x2; x++) {
                    const wx = wrap(x, Daydream.W);
                    const i = XY(wx, y);
                    this.processPlanePixel(i, plane, thickness);
                    if (this.debugBB) this.debugPixel(i);
                }
            }
        }
    }

    /**
     * Draws a list of planes (rings) onto the sphere using field sampling.
     * @param {Array<{normal: THREE.Vector3, color: Color4}>} planes 
     * @param {number} thickness - Angular thickness of the ring.
     */
    drawPlanes(planes, thickness) {
        for (const plane of planes) {
            this.drawRing(plane.normal, 1.0, plane.color, thickness);
        }
    }

    processPlanePixel(i, plane, thickness) {
        const p = Daydream.pixelPositions[i];
        const dist = Math.abs(p.dot(plane.normal));
        if (dist < thickness) {
            const t = dist / thickness;
            const alpha = quinticKernel(1 - t) * plane.color.alpha;
            const outColor = Daydream.pixels[i];
            blendAlpha(outColor, plane.color.color, alpha, outColor);
        }
    }

    debugPixel(i) {
        const outColor = Daydream.pixels[i];
        outColor.r += 0.02;
        outColor.g += 0.02;
        outColor.b += 0.02;
    }
}
