/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

// TODO: Add smoothing slider
// TODO: Add multiple smaller shapes rotating out of phase

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Orientation, vectorPool
} from "../geometry.js";
import {
    VignettePalette, richSunset, mangoPeel, underSea, iceMelt,
    TransparentVignette, blendAlpha, color4Pool,
    Color4
} from "../color.js";
import {
    Timeline, Sprite, RandomWalk, MutableNumber, Rotation, easeMid
} from "../animation.js";
import { Scan, Plot } from "../draw.js";
import { createRenderPipeline, FilterAntiAlias } from "../filters.js";

export class TestShapes {
    static Ring = class {
        constructor(normal, color, mode) {
            this.baseNormal = normal.clone(); // Immutable reference for rendering
            this.simNormal = normal.clone();  // Mutable state for RandomWalk
            this.color = color;
            this.mode = mode;
            this.orientation = new Orientation();
            this.master = null; // If set, this ring syncs from master
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.5;
        this.shape = "Polygon";
        this.debugBB = false;
        this.numRings = 1;
        this.timeline = new Timeline();
        this.radius = 0.6;
        this.sides = 5;

        const seed = Math.floor(Math.random() * 65535);
        const totalColors = this.numRings * 2;
        let colorCount = 0;

        for (let i = 0; i < this.numRings; ++i) {
            const c1 = iceMelt.get(colorCount / totalColors);
            colorCount++;
            const c2 = iceMelt.get(colorCount / totalColors);
            colorCount++;

            // Front Side (Scan) - MASTERS
            const r1 = this.spawnRing(Daydream.X_AXIS, c1, 1, seed, "Scan", null);
            const r2 = this.spawnRing(Daydream.X_AXIS, c2, -1, seed, "Scan", null);

            // Back Side (Plot) - SLAVES (Mirror Masters)
            this.spawnRing(Daydream.X_AXIS.clone().negate(), c1, 1, seed, "Plot", r1);
            this.spawnRing(Daydream.X_AXIS.clone().negate(), c2, -1, seed, "Plot", r2);
        }

        this.setupGUI();
    }

    // Radio Button Simulators
    get isPolygon() { return this.shape === "Polygon"; }
    set isPolygon(v) { if (v) this.shape = "Polygon"; }

    get isFlower() { return this.shape === "Flower"; }
    set isFlower(v) { if (v) this.shape = "Flower"; }

    get isStar() { return this.shape === "Star"; }
    set isStar(v) { if (v) this.shape = "Star"; }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01).name("Alpha");
        this.gui.add(this, 'radius').min(0).max(2).step(0.01).name("Radius");
        this.gui.add(this, 'sides').min(3).max(12).step(1).name("Sides");

        this.gui.add(this, 'isPolygon').name("Polygon").listen();
        this.gui.add(this, 'isFlower').name("Flower").listen();
        this.gui.add(this, 'isStar').name("Star").listen();
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes');
    }

    spawnRing(normal, color, direction, seed, mode, master) {
        let ring = new TestShapes.Ring(normal, color, mode);
        ring.master = master;
        this.rings.push(ring);

        if (!master) {
            // Only animate Masters
            this.timeline.add(0, new RandomWalk(ring.orientation, ring.simNormal, seed));
            this.timeline.add(0, new Rotation(ring.orientation, normal, direction * 2 * Math.PI, 160, easeMid, true, "Local"));
        }
        return ring;
    }

    drawFrame() {
        this.timeline.step();

        const scanPipeline = createRenderPipeline();
        const plotPipeline = createRenderPipeline(new FilterAntiAlias());

        for (const ring of this.rings) {
            if (ring.master) {
                ring.orientation = ring.master.orientation;
            }

            const colorFn = (p, t, dist) => {
                return new Color4(ring.color.color, ring.color.alpha * this.alpha);
            }

            const pipeline = (ring.mode === "Plot") ? plotPipeline : scanPipeline;
            const drawNormal = this.normal || ring.baseNormal;
            if (ring.mode === "Plot") {
                if (this.shape === "Flower") {
                    Plot.Flower.draw(pipeline, ring.orientation.get(), drawNormal, this.radius, this.sides, colorFn);
                } else if (this.shape === "Star") {
                    Plot.Star.draw(pipeline, ring.orientation.get(), drawNormal, this.radius, this.sides, colorFn);
                } else {
                    Plot.Polygon.draw(pipeline, ring.orientation.get(), drawNormal, this.radius, this.sides, colorFn);
                }
            } else {
                // Scan Mode
                if (this.shape === "Flower") {
                    Scan.Flower.draw(pipeline, ring.orientation.get(), drawNormal, this.radius, this.sides, colorFn, { debugBB: this.debugBB });
                } else if (this.shape === "Star") {
                    Scan.Star.draw(pipeline, ring.orientation.get(), drawNormal, this.radius, this.sides, colorFn, { debugBB: this.debugBB });
                } else {
                    Scan.Polygon.draw(pipeline, ring.orientation.get(), drawNormal, this.radius, this.sides, colorFn, { debugBB: this.debugBB });
                }
            }
        }
    }
}
