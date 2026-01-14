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
        constructor(normal, scale, color, mode, layerIndex) {
            this.normal = normal;
            this.scale = scale;
            this.color = color;
            this.mode = mode;
            this.layerIndex = layerIndex;
            this.orientation = new Orientation();
            this.master = null; // If set, this ring syncs from master
        }
    }

    constructor() {
        this.rings = [];
        this.alpha = 0.5;
        this.shape = "Polygon";
        this.debugBB = false;
        this.numShapes = 10;
        this.timeline = new Timeline();
        this.radius = 1.0;
        this.sides = 5;
        this.twist = 0;

        this.setupGUI();
        this.rebuild();
    }

    rebuild() {
        this.rings = [];
        this.timeline = new Timeline(); // Reset timeline

        const seed1 = Math.floor(Math.random() * 65535);
        const seed2 = Math.floor(Math.random() * 65535);
        const totalShapes = this.numShapes;

        for (let i = 0; i < totalShapes; ++i) {
            const t = i / (totalShapes > 1 ? totalShapes - 1 : 1);
            const color = iceMelt.get(t).clone();
            this.spawnRing(Daydream.X_AXIS, i / (totalShapes - 1), color, seed1, "Plot", i);
            this.spawnRing(Daydream.X_AXIS.clone().negate(), i / (totalShapes - 1), color, seed1, "Plot", i);
        }
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
        this.gui.add(this, 'twist').min(-Math.PI / 2).max(Math.PI).step(0.001).name("Twist");

        this.gui.add(this, 'numShapes').min(1).max(50).step(1).name("Num Shapes").onChange(() => this.rebuild());

        this.gui.add(this, 'isPolygon').name("Polygon").listen();
        this.gui.add(this, 'isFlower').name("Flower").listen();
        this.gui.add(this, 'isStar').name("Star").listen();
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes');
    }

    spawnRing(normal, scale, color, seed, mode, layerIndex) {
        let ring = new TestShapes.Ring(normal, scale, color, mode, layerIndex);
        this.rings.push(ring);
        // Keep scan and plot shapes antipodal
        const simNormal = (normal.x < -0.5) ? normal.clone().negate() : normal;
        this.timeline.add(0, new RandomWalk(ring.orientation, simNormal, seed));
        this.timeline.add(0, new Rotation(ring.orientation, ring.normal, 2 * Math.PI, 160, easeMid, true, "Local"));
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

            const orientation = ring.orientation.get();
            const phase = ring.layerIndex * this.twist;

            const colorFn = (p, t, dist) => {
                return color4Pool.acquire().set(ring.color.color, ring.color.alpha * this.alpha);
            }

            const pipeline = (ring.mode === "Plot") ? plotPipeline : scanPipeline;
            const drawNormal = ring.normal;
            if (ring.mode === "Plot") {
                if (this.shape === "Flower") {
                    Plot.Flower.draw(pipeline, orientation, drawNormal, this.radius * ring.scale, this.sides, colorFn, phase);
                } else if (this.shape === "Star") {
                    Plot.Star.draw(pipeline, orientation, drawNormal, this.radius * ring.scale, this.sides, colorFn, phase);
                } else {
                    Plot.Polygon.draw(pipeline, orientation, drawNormal, this.radius * ring.scale, this.sides, colorFn, phase);
                }
            } else {
                if (this.shape === "Flower") {
                    Scan.Flower.draw(pipeline, orientation, drawNormal, this.radius * ring.scale, this.sides, colorFn, phase, { debugBB: this.debugBB });
                } else if (this.shape === "Star") {
                    Scan.Star.draw(pipeline, orientation, drawNormal, this.radius * ring.scale, this.sides, colorFn, phase, { debugBB: this.debugBB });
                } else {
                    Scan.Polygon.draw(pipeline, orientation, drawNormal, this.radius * ring.scale, this.sides, colorFn, phase, { debugBB: this.debugBB });
                }
            }
        }
    }
}
