/*
 * Required Notice: Copyright 2025 Gabriel Levy. All rights reserved.
 * Licensed under the Polyform Noncommercial License 1.0.0
 */

import * as THREE from "three";
import { gui } from "gui";
import { Daydream } from "../driver.js";
import {
    Timeline, Sprite, RandomWalk, Rotation, Mutation, Orientation
} from "../animation.js";
import { easeMid } from "../easing.js";
import { Scan } from "../scan.js";
import { Plot } from "../plot.js";
import { makeBasis } from "../geometry.js";
import { Palettes } from "../palettes.js";
import { TWO_PI } from "../3dmath.js";
import { color4Pool } from "../memory.js";

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

    get twist() { return this._twist; }
    set twist(v) { this._twist = v; }

    constructor() {
        this.rings = [];
        this.alpha = 0.5;
        this.shape = "PlanarPolygon";
        this.debugBB = false;
        this.numShapes = 25;
        this.timeline = new Timeline();
        this.radius = 1.0;
        this.sides = 5;
        // this.usePlanar = true; // Removed
        this._twist = 0;

        this.scanPipeline = createRenderPipeline();
        this.plotPipeline = createRenderPipeline(new FilterAntiAlias());

        this.setupGUI();
        this.rebuild();
    }

    rebuild() {
        this.rings = [];
        this.timeline = new Timeline(); // Reset timeline
        this.timeline.add(0, new Mutation(this, '_twist', (t) => (Math.PI / 4) * Math.sin(t * Math.PI), 480, easeMid, true));

        const seed1 = Math.floor(Math.random() * 65535);
        const seed2 = Math.floor(Math.random() * 65535);
        const totalShapes = this.numShapes;

        for (let i = totalShapes - 1; i >= 0; --i) {
            const t = i / (totalShapes > 1 ? totalShapes - 1 : 1);
            const color = Palettes.richSunset.get(t).clone();
            this.spawnRing(Daydream.X_AXIS, i / (totalShapes - 1), color, seed1, "Plot", i);
            this.spawnRing(Daydream.X_AXIS.clone().negate(), i / (totalShapes - 1), color, seed1, "Scan", i);
        }
    }

    // Radio Button Simulators
    get isSphericalPolygon() { return this.shape === "SphericalPolygon"; }
    set isSphericalPolygon(v) { if (v) this.shape = "SphericalPolygon"; }

    get isPlanarPolygon() { return this.shape === "PlanarPolygon"; }
    set isPlanarPolygon(v) { if (v) this.shape = "PlanarPolygon"; }


    get isFlower() { return this.shape === "Flower"; }
    set isFlower(v) { if (v) this.shape = "Flower"; }

    get isStar() { return this.shape === "Star"; }
    set isStar(v) { if (v) this.shape = "Star"; }

    setupGUI() {
        this.gui = new gui.GUI({ autoPlace: false });
        this.gui.add(this, 'alpha').min(0).max(1).step(0.01).name("Alpha");
        this.gui.add(this, 'radius').min(0).max(2).step(0.01).name("Radius");
        this.gui.add(this, 'sides').min(3).max(12).step(1).name("Sides");
        this.gui.add(this, 'twist').min(-Math.PI / 2).max(Math.PI).step(0.001).name("Twist").listen();

        this.gui.add(this, 'numShapes').min(1).max(50).step(1).name("Num Shapes").onChange(() => this.rebuild());

        this.gui.add(this, 'isPlanarPolygon').name("Planar Polygon").listen();
        this.gui.add(this, 'isSphericalPolygon').name("Spherical Polygon").listen();
        this.gui.add(this, 'isFlower').name("Flower").listen();
        this.gui.add(this, 'isStar').name("Star").listen();
        // this.gui.add(this, 'usePlanar').name("Planar Lines"); // Removed
        this.gui.add(this, 'debugBB').name('Show Bounding Boxes');
    }

    spawnRing(normal, scale, color, seed, mode, layerIndex) {
        let ring = new TestShapes.Ring(normal, scale, color, mode, layerIndex);
        this.rings.push(ring);
        const antipode = (normal.x < -0.5) ? normal.clone().negate() : normal;
        this.timeline.add(0, new RandomWalk(ring.orientation, antipode, { seed: seed }));
        this.timeline.add(0, new Rotation(ring.orientation, ring.normal, TWO_PI, 160, easeMid, true, "Local"));
        this.timeline.add(0, new Sprite((alpha) => this.drawShape(ring, alpha), -1));
    }

    drawShape(ring, spriteAlpha) {
        const pipeline = (ring.mode === "Plot")
            ? this.plotPipeline
            : this.scanPipeline;

        const fragmentShaderFn = (v, fragment) => {
            fragment.color.set(ring.color.color, ring.color.alpha * this.alpha * spriteAlpha);
        }

        const basis = makeBasis(ring.orientation.get(), ring.normal);
        const phase = ring.layerIndex * this.twist;
        if (ring.mode === "Plot") {
            if (this.shape === "Flower") {
                Plot.Flower.draw(pipeline, basis, this.radius * ring.scale, this.sides, fragmentShaderFn, phase);
            } else if (this.shape === "Star") {
                Plot.Star.draw(pipeline, basis, this.radius * ring.scale, this.sides, fragmentShaderFn, phase);
            } else if (this.shape === "PlanarPolygon") {
                Plot.PlanarPolygon.draw(pipeline, basis, this.radius * ring.scale, this.sides, fragmentShaderFn, phase);
            } else {
                Plot.SphericalPolygon.draw(pipeline, basis, this.radius * ring.scale, this.sides, fragmentShaderFn, phase);
            }
        } else {
            if (this.shape === "Flower") {
                Scan.Flower.draw(pipeline, basis, this.radius * ring.scale, this.sides, fragmentShaderFn, phase, this.debugBB);
            } else if (this.shape === "Star") {
                Scan.Star.draw(pipeline, basis, this.radius * ring.scale, this.sides, fragmentShaderFn, phase, this.debugBB);
            } else if (this.shape === "PlanarPolygon") {
                Scan.PlanarPolygon.draw(pipeline, basis, this.radius * ring.scale, this.sides, fragmentShaderFn, phase, this.debugBB);
            } else {
                Scan.SphericalPolygon.draw(pipeline, basis, this.radius * ring.scale, this.sides, fragmentShaderFn, phase, this.debugBB);
            }
        }
    }

    drawFrame() {
        this.timeline.step();
    }
}

