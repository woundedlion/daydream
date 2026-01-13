/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, vectorPool
} from "../geometry.js";
import {
    VignettePalette, richSunset, mangoPeel, underSea, iceMelt,
    TransparentVignette
} from "../color.js";
import {
    Timeline, RandomWalk, OrientationTrail // Assuming you added it to animation.js
} from "../animation.js";
import { Scan } from "../draw.js";
import { createRenderPipeline } from "../filters.js";
import { tween, deepTween, dotPool } from "../draw.js";

export class RingSpin {
    static Ring = class {
        constructor(normal, palette) {
            this.normal = normal;
            this.palette = new TransparentVignette(palette);
            this.orientation = new Orientation();
            this.trail = new OrientationTrail(19);
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.5;
        this.trailLength = 19;
        this.thickness = 2 * Math.PI / Daydream.W;
        this.palettes = [iceMelt, underSea, mangoPeel, richSunset];
        this.numRings = 4;
        this.timeline = new Timeline();
        this.debugBB = false; // Added back

        for (let i = 0; i < this.numRings; ++i) {
            this.spawnRing(Daydream.X_AXIS, this.palettes[i]);
        }

        this.setupGUI();
        this.renderPlanes = [];
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01).name("Brightness");
        this.gui.add(this, 'thickness').min(0.01).max(0.5).step(0.01).name("Brush Size");
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes');
    }

    spawnRing(normal, palette) {
        let ring = new RingSpin.Ring(normal, palette);
        this.rings.push(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal));
    }

    drawFrame() {
        this.timeline.step();
        this.renderPlanes.length = 0;

        const pipeline = createRenderPipeline();
        for (const ring of this.rings) {
            ring.trail.record(ring.orientation);
            deepTween(ring.trail, (q, t) => {
                if (t > 1.0) return;
                const c = ring.palette.get(t);
                c.alpha = c.alpha * this.alpha;
                const dot = dotPool.acquire();
                dot.position.copy(ring.normal).applyQuaternion(q);
                dot.color = c.color;
                dot.alpha = c.alpha;
                dot.t = t;
                this.renderPlanes.push(dot);
            });
        }

        for (const dot of this.renderPlanes) {
            const colorFn = (p, tPos, dist) => {
                return dot;
            };

            Scan.Ring.draw(pipeline, dot.position, 1.0, this.thickness, colorFn, 0, 2 * Math.PI, { debugBB: this.debugBB, computeT: false });
        }
    }
}
