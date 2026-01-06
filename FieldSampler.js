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
            if (R < 0.01 || rXZ < 0.01) {
                for (let x = 0; x < Daydream.W; x++) {
                    const i = XY(x, y);
                    this.processPlanePixel(i, plane, thickness);
                    if (this.debugBB) this.debugPixel(i);
                }
                continue;
            }

            // 3. HORIZONTAL OPTIMIZATION (Finding the Intersection)
            // We solve the plane equation Ax + By + Cz = 0 for the angle theta (Longitude).
            // This tells us exactly where the ring crosses this specific row of pixels.
            // val = cos(gamma), where gamma is the angle relative to the plane's orientation.
            const val = (-ny * y3d) / (R * rXZ);

            // We widen the search window based on thickness.
            // dVal approximates how much 'val' changes given the brush thickness.
            const dVal = (thickness * 1.5) / (R * rXZ);

            // 4. "NEAR MISS" CHECK
            // If |val| > 1, the plane doesn't intersect this latitude (math error).
            // However, due to thickness, pixels might still be close enough.
            // If it's too far away (> 0.9 or > 1.0 boundary), we might need to scan everything 
            // or nothing. The code cautiously scans the whole row to avoid artifacts 
            // at the "tips" of the ring where it turns around.
            if (Math.abs(val) > 0.9 || (Math.abs(val) + dVal >= 1.0)) {
                for (let x = 0; x < Daydream.W; x++) {
                    const i = XY(x, y);
                    this.processPlanePixel(i, plane, thickness);
                    if (this.debugBB) this.debugPixel(i);
                }
                continue;
            }

            // 5. WINDOW CALCULATION
            // sinGamma helps determine the steepness of the intersection.
            const sinGamma = Math.sqrt(1 - val * val);

            // If the intersection is very shallow (glancing blow), the "valid" region
            // is very wide, so we skip optimization and scan the whole row.
            if (sinGamma < 0.1) {
                for (let x = 0; x < Daydream.W; x++) {
                    const i = XY(x, y);
                    this.processPlanePixel(i, plane, thickness);
                    if (this.debugBB) this.debugPixel(i);
                }
                continue;
            }

            // 6. CALCULATE SCAN WINDOWS
            // The ring intersects the row at two points (front and back).
            // alpha: The rotational phase of the plane normal.
            // delta: The angular offset from 'alpha' to the intersection points.
            const thetaWidth = dVal / sinGamma; // Width of the window to scan
            const delta = Math.acos(val);
            const alpha = Math.atan2(nx, nz);

            // The two center points of intersection
            const thetas = [alpha - delta, alpha + delta];

            // Scan only the pixels within the calculated windows around the intersections
            for (const thetaCenter of thetas) {
                const t1 = thetaCenter - thetaWidth;
                const t2 = thetaCenter + thetaWidth;

                // Convert angles to pixel X coordinates
                const x1 = Math.floor((t1 * Daydream.W) / (2 * Math.PI));
                const x2 = Math.ceil((t2 * Daydream.W) / (2 * Math.PI));

                for (let x = x1; x <= x2; x++) {
                    // Handle wrapping (e.g., if window crosses the seam of the texture)
                    const wx = wrap(x, Daydream.W);
                    const i = rowOffset + wx;

                    // Finally, perform the exact distance check and draw
                    this.processPlanePixel(i, plane, thickness);

                    // Visualize the optimized bounding box if debugging is on
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
            const h = Math.sqrt(1 - plane.normal.y * plane.normal.y);
            const phiMin = Math.acos(Math.min(1, h)) - thickness;
            const phiMax = Math.acos(Math.max(-1, -h)) + thickness;

            const yMin = Math.max(0, Math.floor((phiMin * (Daydream.H - 1)) / Math.PI));
            const yMax = Math.min(Daydream.H - 1, Math.ceil((phiMax * (Daydream.H - 1)) / Math.PI));

            for (let y = yMin; y <= yMax; y++) {
                const phi = (y * Math.PI) / (Daydream.H - 1);
                const y3d = Math.cos(phi);
                const rXZ = Math.sin(phi);

                const nx = plane.normal.x;
                const ny = plane.normal.y;
                const nz = plane.normal.z;
                const R = Math.sqrt(nx * nx + nz * nz);

                if (R < 0.01 || rXZ < 0.01) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = XY(x, y);
                        this.processPlanePixel(i, plane, thickness);
                        if (this.debugBB) this.debugPixel(i);
                    }
                    continue;
                }

                const val = (-ny * y3d) / (R * rXZ);
                const dVal = (thickness * 1.5) / (R * rXZ);

                if (Math.abs(val) > 0.9 || (Math.abs(val) + dVal >= 1.0)) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = XY(x, y);
                        this.processPlanePixel(i, plane, thickness);
                        if (this.debugBB) this.debugPixel(i);
                    }
                    continue;
                }

                const sinGamma = Math.sqrt(1 - val * val);
                if (sinGamma < 0.1) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = XY(x, y);
                        this.processPlanePixel(i, plane, thickness);
                        if (this.debugBB) this.debugPixel(i);
                    }
                    continue;
                }

                const thetaWidth = dVal / sinGamma;
                const delta = Math.acos(val);
                const alpha = Math.atan2(nx, nz);
                const thetas = [alpha - delta, alpha + delta];

                for (const thetaCenter of thetas) {
                    const t1 = thetaCenter - thetaWidth;
                    const t2 = thetaCenter + thetaWidth;
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
