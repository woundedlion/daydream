import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation
} from "../geometry.js";
import { wrap } from "../util.js";
import {
    VignettePalette, richSunset, mangoPeel, underSea, iceMelt,
    TransparentVignette, blendAlpha
} from "../color.js";
import {
    Timeline, Sprite, RandomWalk, MutableNumber
} from "../animation.js";
import { quinticKernel } from "../filters.js";

export class RingSpinFieldSample {
    static Ring = class {
        constructor(normal, palette) {
            this.normal = normal;
            this.palette = new TransparentVignette(palette);
            this.orientation = new Orientation();
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.5;
        this.trailLength = 20;
        this.thickness = 2 * Math.PI / Daydream.W;
        this.palettes = [iceMelt, underSea, mangoPeel, richSunset];
        this.numRings = 4;
        this.timeline = new Timeline();

        for (let i = 0; i < this.numRings; ++i) {
            this.spawnRing(Daydream.X_AXIS, this.palettes[i]);
        }

        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01).name("Brightness");
        this.gui.add(this, 'thickness').min(0.01).max(0.5).step(0.01).name("Thickness");
        this.gui.add(this, 'trailLength').min(1).max(200).step(1).name("Trail Length");

        this.debugBB = false;
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes');
    }

    spawnRing(normal, palette) {
        let ring = new RingSpinFieldSample.Ring(normal, palette);
        this.rings.unshift(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal));
    }

    drawFrame() {
        for (const ring of this.rings) {
            ring.orientation.collapse(this.trailLength);
        }

        this.timeline.step();

        // 1. Pre-calculate the "Planes" for this frame
        const planes = [];

        // Iterate rings from Last (Oldest Spawned) to First (Newest Spawned)
        // rings = [P3, P2, P1, P0].
        // Iterating reversed: P0, P1, P2, P3.
        // P0 (iceMelt) drawn first. P3 (richSunset) drawn last (On Top).
        // Matches RingSpin Timeline order.
        for (let r = this.rings.length - 1; r >= 0; r--) {
            const ring = this.rings[r];
            const len = ring.orientation.length();

            // Iterate History: Oldest (i=0) to Newest (i=len-1)
            // Draws Faint Trail first, Bright Head last (On Top).
            for (let i = 0; i < len; i++) {
                // age: 1.0 (oldest/index 0) -> 0.0 (newest/index len-1)
                const age = len > 1 ? (len - 1 - i) / (len - 1) : 0;

                // Retrieve orientation and rotate the normal
                const q = ring.orientation.get(i);
                const n = ring.normal.clone().applyQuaternion(q);

                // Get color from palette based on age (inverted to match brightness)
                const c = ring.palette.get(age);
                const color = c.color || c;
                // Linear fade out
                const alpha = (c.alpha !== undefined ? c.alpha : 1.0) * this.alpha * (1 - age);

                // Optimization: Don't push invisible planes
                if (alpha > 0.01) {
                    planes.push({ normal: n, color: color, alpha: alpha });
                }
            }
        }

        // 2. Field Sampling Loop
        // Iterate over planes first (Spatial Optimization)
        const radY = this.thickness * (Daydream.H - 1) / Math.PI;

        for (const plane of planes) {
            // Calculate vertical bounds of the great circle
            // The ring lies in a plane with normal 'n'.
            // The maximum Y excursion of the ring is sqrt(1 - ny^2)
            // because ny is the cosine of the angle between normal and Y-axis.
            const h = Math.sqrt(1 - plane.normal.y * plane.normal.y);

            // Map +/- h to phi
            // y_3d = cos(phi) -> phi = acos(y_3d)
            // phi_min corresponds to y_max (+h)
            // phi_max corresponds to y_min (-h)
            // We pad by thickness (angular)
            const phiMin = Math.acos(Math.min(1, h)) - this.thickness;
            const phiMax = Math.acos(Math.max(-1, -h)) + this.thickness;

            // Convert to pixel Y
            // y_pixel = phi * (H-1) / PI
            const yMin = Math.max(0, Math.floor((phiMin * (Daydream.H - 1)) / Math.PI));
            const yMax = Math.min(Daydream.H - 1, Math.ceil((phiMax * (Daydream.H - 1)) / Math.PI));

            // Iterate only relevant rows
            for (let y = yMin; y <= yMax; y++) {
                const rowOffset = Daydream.rowOffsets[y];

                const phi = (y * Math.PI) / (Daydream.H - 1);
                const y3d = Math.cos(phi);
                const rXZ = Math.sin(phi);

                const nx = plane.normal.x;
                const ny = plane.normal.y;
                const nz = plane.normal.z;
                const R = Math.sqrt(nx * nx + nz * nz);

                // Check for horizontal/equatorial ring (R ~ 0) or pole (rXZ ~ 0)
                if (R < 0.01 || rXZ < 0.01) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = rowOffset + x;
                        this.processPixel(i, plane);
                        if (this.debugBB) this.debugPixel(i);
                    }
                    continue;
                }

                const val = (-ny * y3d) / (R * rXZ);
                const dVal = (this.thickness * 1.5) / (R * rXZ); // Safety factor 1.5 included in dVal

                // Check for grazing or full overlap
                // If the visible range of cosines [val-dVal, val+dVal] covers the extremes +/- 1
                // or if it implies a very wide angle, just draw the full row.
                if (Math.abs(val) > 0.9 || (Math.abs(val) + dVal >= 1.0)) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = rowOffset + x;
                        this.processPixel(i, plane);
                        if (this.debugBB) this.debugPixel(i);
                    }
                    continue;
                }

                // Calculate angular width based on slope d(acos)/dx = 1/sqrt(1-x^2)
                const sinGamma = Math.sqrt(1 - val * val);
                // If sinGamma is tiny, slope is huge -> full row (handled by abs(val)>0.9 check above usually)
                if (sinGamma < 0.1) {
                    for (let x = 0; x < Daydream.W; x++) {
                        const i = rowOffset + x;
                        this.processPixel(i, plane);
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
                        this.processPixel(i, plane);
                        if (this.debugBB) this.debugPixel(i);
                    }
                }
            }
        }
    }

    processPixel(i, plane) {
        const p = Daydream.pixelPositions[i];
        const dist = Math.abs(p.dot(plane.normal));
        if (dist < this.thickness) {
            const t = dist / this.thickness;
            const alpha = quinticKernel(1 - t) * plane.alpha;
            const outColor = Daydream.pixels[i];
            blendAlpha(outColor, plane.color, alpha, outColor);
        }
    }

    debugPixel(i) {
        const outColor = Daydream.pixels[i];
        // Much lower intensity to avoid whiteout
        outColor.r += 0.02;
        outColor.g += 0.02;
        outColor.b += 0.02;
    }
}