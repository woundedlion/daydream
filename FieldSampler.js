import * as THREE from "three";
import { Daydream } from "./driver.js";
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
                const rowOffset = Daydream.rowOffsets[y];
                for (let x = xMin; x <= xMax; x++) {
                    const wx = wrap(x, Daydream.W);
                    const i = rowOffset + wx;

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
                const rowOffset = Daydream.rowOffsets[y];

                const phi = (y * Math.PI) / (Daydream.H - 1);
                const y3d = Math.cos(phi);
                const rXZ = Math.sin(phi);

                const nx = plane.normal.x;
                const ny = plane.normal.y;
                const nz = plane.normal.z;
                const R = Math.sqrt(nx * nx + nz * nz);

                if (R < 0.01 || rXZ < 0.01) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = rowOffset + x;
                        this.processPlanePixel(i, plane, thickness);
                        if (this.debugBB) this.debugPixel(i);
                    }
                    continue;
                }

                const val = (-ny * y3d) / (R * rXZ);
                const dVal = (thickness * 1.5) / (R * rXZ);

                if (Math.abs(val) > 0.9 || (Math.abs(val) + dVal >= 1.0)) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = rowOffset + x;
                        this.processPlanePixel(i, plane, thickness);
                        if (this.debugBB) this.debugPixel(i);
                    }
                    continue;
                }

                const sinGamma = Math.sqrt(1 - val * val);
                if (sinGamma < 0.1) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = rowOffset + x;
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
                        const i = rowOffset + wx;
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
