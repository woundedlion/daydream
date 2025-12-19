import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation
} from "../geometry.js";
import {
    VignettePalette, richSunset, mangoPeel, underSea, iceMelt,
    TransparentVignette, blendAlpha
} from "../color.js";
import {
    Timeline, Sprite, RandomWalk, MutableNumber
} from "../animation.js";
import { quinticKernel } from "../filters.js";

export class FieldSample {
    static Ring = class {
        constructor(normal, palette) {
            this.normal = normal;
            this.palette = new TransparentVignette(palette);
            this.orientation = new Orientation();
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.2;
        this.trailLength = new MutableNumber(Daydream.W / 5);
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
    }

    spawnRing(normal, palette) {
        let ring = new FieldSample.Ring(normal, palette);
        this.rings.unshift(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal));
    }

    drawFrame() {
        const maxHistory = this.trailLength.get();
        for (const ring of this.rings) {
            ring.orientation.collapse(maxHistory);
        }

        this.timeline.step();

        // 1. Pre-calculate the "Planes" for this frame
        // Flatten the history of all rings into a list of geometric planes to sample against.
        const planes = [];

        for (const ring of this.rings) {
            const len = ring.orientation.length();
            // Iterate history to create trails
            for (let i = 0; i < len; i++) {
                // age: 0.0 (newest) -> 1.0 (oldest)
                const age = len > 1 ? (len - 1 - i) / (len - 1) : 0;

                // Retrieve orientation and rotate the normal
                const q = ring.orientation.get(i);
                const n = ring.normal.clone().applyQuaternion(q);

                // Get color from palette based on age
                const c = ring.palette.get(age);
                const color = c.color || c;
                const alpha = (c.alpha !== undefined ? c.alpha : 1.0) * this.alpha;

                // Optimization: Don't push invisible planes
                if (alpha > 0.01) {
                    planes.push({ normal: n, color: color, alpha: alpha });
                }
            }
        }

        // 2. Field Sampling Loop
        // Iterate over every physical LED pixel
        const count = Daydream.W * Daydream.H;
        for (let i = 0; i < count; i++) {
            const p = Daydream.pixelPositions[i]; // The 3D position of the pixel
            const outColor = Daydream.pixels[i];  // The target color buffer

            // Iterate planes backwards (Painter's Algorithm: Back-to-Front)
            for (let j = planes.length - 1; j >= 0; j--) {
                const plane = planes[j];
                // Distance from point to plane (passing through origin) is dot product.
                // For a ring (great circle), we are interested in points ON the plane, so distance ~ 0.
                const dist = Math.abs(p.dot(plane.normal));

                if (dist < this.thickness) {
                    const t = dist / this.thickness;
                    const alpha = quinticKernel(1 - t) * plane.alpha;

                    blendAlpha(outColor, plane.color, alpha, outColor);
                }
            }
        }
    }
}