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
    TransparentVignette, blendAlpha, color4Pool
} from "../color.js";
import {
    Timeline, Sprite, RandomWalk, MutableNumber, Rotation, easeMid
} from "../animation.js";
import { Scan, Plot } from "../draw.js";
import { createRenderPipeline, FilterAntiAlias } from "../filters.js";

export class TestShapes {
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
        this.shape = "Polygon";
        this.mode = "Scan"; // Default to Scan
        this.debugBB = false;
        this.palettes = [iceMelt, underSea, mangoPeel, richSunset];
        this.numRings = 1;
        this.timeline = new Timeline();
        this.radius = 0.4;
        this.sides = 5;

        const seed = Math.floor(Math.random() * 65535);
        for (let i = 0; i < this.numRings; ++i) {
            this.spawnRing(Daydream.X_AXIS, this.palettes[i], 1, seed);
            this.spawnRing(Daydream.X_AXIS, this.palettes[i], -1, seed);
        }

        this.setupGUI();
        this.renderPlanes = [];
    }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01).name("Brightness");
        this.gui.add(this, 'radius').min(0).max(2).step(0.01).name("Radius");
        this.gui.add(this, 'sides').min(3).max(12).step(1).name("Sides");
        this.gui.add(this, 'shape', ["Polygon", "Flower"]).name("Shape");
        this.gui.add(this, 'mode', ["Scan", "Plot"]).name("Mode");
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes');
    }

    spawnRing(normal, palette, direction, seed) {
        let ring = new TestShapes.Ring(normal, palette);
        this.rings.push(ring);
        this.timeline.add(0, new RandomWalk(ring.orientation, ring.normal, seed));
        this.timeline.add(0, new Rotation(ring.orientation, normal, direction * 2 * Math.PI, 48, easeMid, true, "Local"));
    }

    drawFrame() {
        this.timeline.step();

        const pipeline = (this.mode === "Plot")
            ? createRenderPipeline(new FilterAntiAlias())
            : createRenderPipeline();

        for (const ring of this.rings) {
            const colorFn = (p, t, dist) => {
                return ring.palette.get(0.5);
            }

            if (this.mode === "Plot") {
                if (this.shape === "Flower") {
                    Plot.Flower.draw(pipeline, ring.orientation.get(), this.normal || ring.normal, this.radius, this.sides, colorFn);
                } else {
                    Plot.Polygon.draw(pipeline, ring.orientation.get(), this.normal || ring.normal, this.radius, this.sides, colorFn);
                }
            } else {
                // Scan Mode
                if (this.shape === "Flower") {
                    Scan.Flower.draw(pipeline, ring.orientation.get(), this.normal || ring.normal, this.radius, this.sides, colorFn, { debugBB: this.debugBB });
                } else {
                    Scan.Polygon.draw(pipeline, ring.orientation.get(), this.normal || ring.normal, this.radius, this.sides, colorFn, { debugBB: this.debugBB });
                }
            }
        }
    }
}
