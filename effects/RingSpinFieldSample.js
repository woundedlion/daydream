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
import { createRenderPipeline, FilterDecay } from "../filters.js";
import { tween, dotPool } from "../draw.js";

export class RingSpinFieldSample {
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
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes'); // Restored
    }

    spawnRing(normal, palette) {
        let ring = new RingSpinFieldSample.Ring(normal, palette);
        this.rings.push(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal));
    }

    drawFrame() {
        this.timeline.step();
        this.renderPlanes.length = 0;

        // 1. Build Local Pipeline
        // Add FilterDecay to get free trails on your rings!
        const pipeline = createRenderPipeline(new FilterDecay(20));

        for (const ring of this.rings) {
            ring.trail.record(ring.orientation);
            tween(ring.trail, (snapshot, t) => {
                tween(snapshot, (q, subT) => {
                    if (t > 1.0) return;
                    const c = ring.palette.get(t);
                    c.alpha = c.alpha * this.alpha;

                    // Store for rendering
                    const dot = dotPool.acquire();
                    dot.position.copy(ring.normal).applyQuaternion(q);
                    dot.color = c.color;
                    dot.alpha = c.alpha;
                    dot.t = t; // Store t for material function if needed
                    this.renderPlanes.push(dot);
                });
            });
        }

        for (const dot of this.renderPlanes) {
            const materialFn = (p, tPos, dist) => {
                return { color: dot.color, alpha: dot.alpha };
            };

            Scan.Ring.draw(pipeline, Daydream.pixels, dot.position, 1.0, this.thickness, materialFn, 0, 2 * Math.PI, { debugBB: this.debugBB });
        }
    }
}